// request-doctor —— Host 端。
//
// 自动修复由本机引起的请求失败，并处理挡住已装插件的版本不匹配：
//
//  - 模型请求失败（agent/request-error）：传输、超时、空响应、上下文超限、缺适配器
//    这几类会被分类并修复，然后按有界指数退避重试。provider 自己声明了重试策略的
//    优先听它的，只有下游全都放弃重试时这里才接手。
//  - 工具调用（tools/execute）：只读的工具被瞬时传输故障打断时重放一次。
//  - 浏览器载体请求（connection/request）：响应头还没发出去就失败的，换成可重试的
//    503，让页面自己的恢复逻辑能重发，而不是直接断掉。
//  - 插件与 DSH 版本不匹配：不是让插件去接受一个它没被设计的环境，而是给它原本那个。
//    每个被挡住的 bundle 先审计，只有证明兼容的才拿到嵌套 node_modules，里面的垫片
//    声明的是当前版本，转发的是真实实现。没有任何版本检查被绕过；某个导出真的没了，
//    就如实报告，不伪造。
//
// 修复过程会写进已有的 llm/retry 和 llm/retry-started 会话事件，对话里的重试行
// 因此能显示出来，不用发明新的事件类型。
//
// 这个文件是装配处：只管生命周期和监听器，具体判断都在 lib/ 里。
import { parseRetryConfig } from './lib/classify.js';
import { collectPackageFacts, entryPathOf } from './lib/compat-repair.js';
import { unmetPeers } from './lib/compat.js';
import { prepareForInstall } from './lib/install-support.js';
import { installRemoteBundle, registerBundle } from './lib/install-bundle.js';
import { installWithExemption } from './lib/install-rescue.js';
import { createDiagnostics } from './lib/diagnostics.js';
import { createRetryLedger } from './lib/retry-ledger.js';
import { createRuntimeProbe } from './lib/runtime-probe.js';
import { createVersionRepair } from './lib/version-repair.js';
import { createRepairListeners } from './lib/repair-listeners.js';
import { createTimers } from './lib/timers.js';

export const name = 'request-doctor';

// 后台扫描的基础间隔
const BASE_SCAN_INTERVAL = 120000;

// 一切正常时退避到这个上限
const MAX_SCAN_INTERVAL = 1800000;

// 等 HMR 激活完再扫
const STARTUP_DELAY = 1500;
const EVENT_DELAY = 2500;

// 后台扫描最多退避几档
const MAX_BACKOFF_STEPS = 5;

// 遇到 HMR 嵌套错误时最多再试几次
const MAX_HMR_RETRIES = 6;

// 把插件装起来。
export function apply(ctx, rawConfig) {
  const config = parseRetryConfig(rawConfig);
  if (!config.autoRepair) {
    ctx.logger.info('request-doctor: autoRepair is disabled; no repairs will run');
    return;
  }

  const lifetime = new AbortController();
  const timers = new Set();
  const { later } = createTimers(ctx, timers);
  const warn = (message) => ctx.logger.warn(message);
  const policy = () => config;

  const diagnostics = createDiagnostics({
    statusFile: typeof rawConfig?.statusFile === 'string' ? rawConfig.statusFile : '',
    log: (level, message) => ctx.logger[level]?.(message),
    describe: () => ({ ...config, retryableToolPattern: String(config.retryableToolPattern) }),
    trackTimer: (timer) => timers.add(timer),
  });

  const probe = createRuntimeProbe({ ctx, collectFacts: collectPackageFacts });
  const ledger = createRetryLedger({ config: policy, warn });
  const versionRepair = createVersionRepair({
    config: policy,
    probe,
    diagnostics,
    warn,
    later,
    maxHmrRetries: MAX_HMR_RETRIES,
  });
  const { onRequestError, onToolExecute, onConnectionRequest } = createRepairListeners({
    config: policy,
    lifetime,
    diagnostics,
    ledger,
    versionRepair,
    services: probe,
    warn,
  });

  ctx.on('agent/request-error', onRequestError);
  ctx.on('tools/execute', onToolExecute);
  // 浏览器载体和 profile 管理器在兄弟上下文里，它们的事件只有全局总线看得见。
  ctx.on('connection/request', onConnectionRequest, { global: true });

  const commandDeps = { probe, config: policy, diagnostics, versionRepair, stats: diagnostics.stats, record: diagnostics.record };
  const scans = createScanScheduler({ ctx, diagnostics, versionRepair, later, commandDeps, probe });
  registerDoctorCommand(ctx, commandDeps);
  registerPanelRoutes(ctx, commandDeps);

  ctx.effect(
    () => () => {
      lifetime.abort(new Error('request-doctor disposed'));
      scans.stop();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      diagnostics.flush();
    },
    'request-doctor: cancel pending repairs',
  );
}

// 接上事件触发和周期性的版本扫描。
function createScanScheduler(input) {
  const { ctx, diagnostics, versionRepair, later } = input;
  let idleScans = 0;
  let pendingScan;
  let handle;

  // 扫描计数，事件扫描和后台轮询共用。
  const resetIdle = () => {
    idleScans = 0;
  };

  // 排一次扫描。
//
// 连续几个配置重载或插件变更会各排一次扫描，每次都要把整个 profile 重读一遍。
// 排一个就够了：它跑的时候看到的就是当时的真实状态。
  const schedule = (reason, delayMs = STARTUP_DELAY) => {
    diagnostics.diagnostics.scheduled = (diagnostics.diagnostics.scheduled ?? 0) + 1;
    diagnostics.scheduleWrite();
    if (pendingScan !== undefined) return;
    pendingScan = later(() => {
      pendingScan = undefined;
      diagnostics.diagnostics.fired = (diagnostics.diagnostics.fired ?? 0) + 1;
      diagnostics.scheduleWrite();
      versionRepair.run(reason).catch((error) => {
        diagnostics.diagnostics.scanError = String(error);
        diagnostics.scheduleWrite();
      });
    }, delayMs);
  };

  // 观察到变化后，把后台退避复位。
  const onEvent = (counter, reason) => {
    diagnostics.diagnostics[counter] = (diagnostics.diagnostics[counter] ?? 0) + 1;
    resetIdle();
    diagnostics.scheduleWrite();
    schedule(reason, EVENT_DELAY);
  };

  ctx.on('app-boot/config-reload', () => onEvent('configReload', 'config-reload'), { global: true });
  ctx.on('plugin-manager/changed', () => onEvent('pluginManagerChanged', 'plugin-manager-change'), { global: true });

  // 兜底用的后台扫描，专门对付那些没有任何事件会通知的不匹配——
// 手动改过 node_modules，或者从备份恢复了一个目录。
//
// 一直没发现问题就逐步拉长间隔，正常 profile 几乎不花什么钱；一旦有变化立刻回到基础周期。
  ctx.inject(['pluginManager'], (pluginCtx) => {
    // 安装命令要用它重载刚装好的 bundle，所以放进共享的 deps 里。
    if (input.commandDeps !== undefined) input.commandDeps.pluginManager = pluginCtx.pluginManager;

    // 图形界面里的普通安装也要能兜住：版本检查失败时替它把包装好。

    pluginCtx.effect(() => {
      diagnostics.scheduleWrite();
      let cancelled = false;
      const cancelFirst = later(() => {
        versionRepair.run('startup', pluginCtx.pluginManager).catch(() => {});
      }, STARTUP_DELAY);

      const tick = () => {
        if (cancelled) return;
        versionRepair.run('poll', pluginCtx.pluginManager)
          .then((fixed) => {
            idleScans = fixed.length > 0 ? 0 : Math.min(idleScans + 1, MAX_BACKOFF_STEPS);
          })
          .catch(() => {})
          .finally(() => {
            if (cancelled) return;
            handle = setTimeout(tick, Math.min(BASE_SCAN_INTERVAL * 2 ** idleScans, MAX_SCAN_INTERVAL));
            handle.unref?.();
          });
      };
      handle = setTimeout(tick, BASE_SCAN_INTERVAL);
      handle.unref?.();

      return () => {
        cancelled = true;
        cancelFirst();
        if (handle !== undefined) clearTimeout(handle);
      };
    }, 'request-doctor: background version scan');
  });

  return {
    stop: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

// 注册 /doctor 命令。
function registerDoctorCommand(ctx, deps) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'doctor',
          description: 'Show request-doctor repair activity, repair version mismatches now, or prepare a plugin for installation',
          input: { hint: 'install <path-or-package> | allow <package@version>' },
          handler: async (invocation) => runDoctorCommand(invocation, deps),
        }),
      'request-doctor: /doctor command',
    );
  });
}

// 一行清单里被拒的那个包；没有就返回 undefined。
function refusedRowOf(row) {
  const first = row?.error?.incompatible?.[0];
  if (first === undefined) return undefined;
  return { name: first.name, version: first.version, runtimeVersion: first.runtimeVersion };
}

// 从管理器给的清单里挑出被拒装的包：只有带 incompatible 的行才算。
function refusedRowsOf(result) {
  return (result?.value ?? []).map(refusedRowOf).filter((row) => row !== undefined);
}

// 汇总当前需要处理的插件：本插件扫描的审计结果，加上管理器的拒装记录，按名去重。
async function collectPanelRows(deps, manager) {
  const rows = [];
  for (const item of deps.diagnostics?.versionScan?.audited ?? []) {
    if (item.verdict === 'compatible') continue;
    rows.push({ name: item.name, version: item.version, runtimeVersion: deps.probe.runtimeFacts().runtimeVersion });
  }
  if (manager !== undefined) {
    try {
      rows.push(...refusedRowsOf(await manager.listBundles()));
    } catch {
      // 管理器读不动就只报审计结果，页面仍然有内容。
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.name}@${row.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 界面用的 HTTP 路由。
//
// 客户端半拿不到 typert 的 remote 门面（动态模块的上下文里没有那个服务），
// 但它和页面同源，可以直接 fetch。插件管理器自己的界面同样走 webServer 路由，
// 这条路不依赖任何远程服务，是这里最稳的一条。
function registerPanelRoutes(ctx, deps) {
  ctx.inject(['webServer'], (webCtx) => {
    const json = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // 列出当前被拒装的插件：读管理器的清单，把带 incompatible 的行挑出来。
    const listRoute = {
      kind: 'exact',
      path: '/doctor/incompatible',
      handler: async (_req, res) => {
        const manager = deps.pluginManager ?? ctx.get('pluginManager');
        return json(res, 200, { ok: true, rows: await collectPanelRows(deps, manager) });
      },
    };

    // 装一个包：请求体里的 spec 交给和 /doctor install 完全相同的实现。
    const installRoute = {
      kind: 'exact',
      path: '/doctor/install',
      handler: (req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
          let spec = '';
          try {
            spec = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').spec ?? '').trim();
          } catch {
            return json(res, 400, { ok: false, text: '请求体不是合法的 JSON' });
          }
          if (spec === '') return json(res, 400, { ok: false, text: 'spec 不能为空' });
          const manager = deps.pluginManager ?? ctx.get('pluginManager');
          if (manager === undefined) return json(res, 200, { ok: false, text: '拿不到插件管理器' });
          try {
            const result = await installFromRegistry(spec, { ...deps, pluginManager: manager });
            return json(res, 200, { ok: result.kind === 'success', text: result.text });
          } catch (error) {
            return json(res, 200, { ok: false, text: String(error) });
          }
        });
      },
    };

    ctx.effect(() => webCtx.webServer.register(listRoute), 'request-doctor: 界面清单路由');
    // 让界面能主动触发一轮审计：装完东西之后不用等下一次定时扫描。
    const rescanRoute = {
      kind: 'exact',
      path: '/doctor/rescan',
      handler: async (_req, res) => {
        try {
          await deps.versionRepair.run('manual');
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, reason: String(error) });
        }
      },
    };

    ctx.effect(() => webCtx.webServer.register(installRoute), 'request-doctor: 界面安装路由');
    ctx.effect(() => webCtx.webServer.register(rescanRoute), 'request-doctor: 界面重扫路由');
  });
}

// 处理一次 /doctor 调用。
async function runDoctorCommand(invocation, deps) {
  const raw = String(invocation?.rawInput ?? '').trim();
  const [sub, ...rest] = raw.split(/\s+/).filter((part) => part !== '');

  // install 先把本地插件准备好，让管理器自己的版本检查按它的规则通过，
  // 而不是装完之后又被回滚掉。
  if (sub === 'install') return prepareInstallCommand(rest.join(' '), deps);
  // allow 只授权、不安装：给那些想继续在图形界面里点安装的人用。
  if (sub === 'allow') return allowVersionCommand(rest.join(' '), deps);
  return summarizeRepairs(deps);
}

// 把一个本地插件目录准备好，让它能被装上。
async function prepareInstallCommand(spec, deps) {
  if (spec === '') return { kind: 'error', text: 'usage: /doctor install <目录路径或包名> — 两者都行' };

  // 注册表里的包：管理器自己装不上，那就我们自己装。
  const profileDir = deps.probe.runtimeFacts().profileDir ?? '';
  if (classifySpec(spec, profileDir).kind === 'remote') return installFromRegistry(spec, deps);

  const facts = deps.probe.runtimeFacts();
  const resolveDir = deps.probe.runtimeDirOf(facts);
  const prepared = prepareForInstall({
    spec,
    profileDir: facts.profileDir ?? '',
    runtimeVersion: facts.runtimeVersion ?? '',
    resolveDir,
    factsOf: (dir, entry) => deps.probe.factsOf(dir, entry, facts.runtimeVersion),
    entryOf: entryPathOf,
    unmetPeers,
  });
  if (!prepared.prepared) {
    return { kind: 'error', text: `not prepared: ${prepared.reason ?? 'unknown reason'}` };
  }
  const built = prepared.packages.join(', ') || 'environment deferred to the next scan';
  deps.record('install-prepare', `${spec} prepared with ${built}`);

  // 顺带报告每个依赖能不能解析到。装不上的时候，第一件要知道的就是这个。
  const lines = [];
  for (const name of Object.keys(prepared.requirements ?? {})) {
    const dir = resolveDir(name);
    lines.push(`${name}: ${dir === undefined ? '解析不到' : dir}`);
  }
  const detail = lines.length === 0 ? '' : `\n\n依赖解析情况：\n${lines.join('\n')}`;
  return {
    kind: 'success',
    text: `prepared ${spec} for this runtime (${built}).\nNow install it normally; the manager's compatibility check will pass.${detail}`,
  };
}

// 提前授权一个「当前运行时本来不让装」的插件版本。
//
// 图形界面里的安装走的是管理器自己的流程，插件侧拦不住。那条路要过版本检查，
// 而检查只认显式授权。所以给用户一个在点安装之前把这件事做掉的入口：
// 先 /doctor allow，再在界面上装，装完扫描会自动把声明对齐、环境建好。
async function allowVersionCommand(spec, deps) {
  const trimmed = String(spec ?? '').trim();
  if (trimmed === '') return { kind: 'error', text: '用法：/doctor allow <包名@版本>' };
  if (trimmed.includes('@', 1) === false) {
    return { kind: 'error', text: '要写清楚版本，例如 /doctor allow dsh-ssh-ops@0.4.0' };
  }

  // 授权必须有明确的运行时版本和管理器实例，缺一个都做不了。
  const runtimeVersion = deps.probe.runtimeFacts().runtimeVersion ?? '';
  const ready = runtimeVersion !== '' && deps.pluginManager !== undefined;
  if (ready === false) return { kind: 'error', text: '拿不到当前 DSH 版本或管理器不可用，无法授权' };

  try {
    await deps.pluginManager.setVersionExemption(trimmed, runtimeVersion, true, true);
  } catch (error) {
    return { kind: 'error', text: `授权失败：${String(error)}` };
  }
  const note = `已放行 ${trimmed} 在 ${runtimeVersion} 上运行`;
  deps.record('version-allowed', note);

  return {
    kind: 'success',
    text: [
      `已授权 ${trimmed} 运行在 ${runtimeVersion}`,
      '现在可以在插件面板里正常安装它了。',
      '装完之后，声明对齐和兼容环境会自动补上。',
    ].join('\n'),
  };
}

// 自己装一个注册表里的包。
//
// 管理器的安装路径是 pnpm 加一次版本检查。远程包在检查之前就已经落地了，
// 没法像本地目录那样提前把 manifest 改好，所以它对不兼容的包永远装不上。
// 这里把 pnpm add 该做的事自己做一遍：取包、取依赖、对齐声明、建环境、登记、重载。
async function installFromRegistry(spec, deps) {
  const facts = deps.probe.runtimeFacts();
  if ((facts.profileDir ?? '') === '') return { kind: 'error', text: '拿不到 profile 目录，无法安装' };

  // 先授权版本豁免再装：管理器的检查按它自己的规则通过，装完我们再补上兼容形态。
  const result = await installWithExemption({
    spec,
    probe: deps.probe,
    pluginManager: deps.pluginManager,
    runtimeVersion: facts.runtimeVersion ?? '',
    factsOf: (dir, entry) => deps.probe.factsOf(dir, entry, facts.runtimeVersion),
    entryOf: entryPathOf,
    record: (kind, message) => deps.record(kind, message),
  });
  if (!result.installed) return { kind: 'error', text: `装不上 ${spec}：${result.reason ?? '未知原因'}` };

  const summary = [
    `已安装 ${result.name}@${result.version}`,
    `位置：${result.path}`,
    `兼容环境：${result.environment}`,
  ];
  return { kind: 'success', text: summary.join('\n') };
}

// 现在修一遍，顺带把之前修过什么报出来。
async function summarizeRepairs(deps) {
  if (deps.config.autoVersionRepair) await deps.versionRepair.run('manual');
  const { stats } = deps;
  const lines = [
    `request-doctor: ${stats.modelRepairs} model, ${stats.toolRepairs} tool, ${stats.connectionRepairs} carrier, ${stats.versionRepairs} version repair(s)`,
    `budget: ${deps.config.maxRetries} model retries per step, ${deps.config.maxToolRetries} tool replays`,

    'usage: /doctor install <path> — prepare a local plugin so it can be installed',
  ];
  for (const entry of stats.last.slice(-8)) lines.push(`- ${entry.at} ${entry.kind}: ${entry.detail}`);

  // 把这一轮审计的结论也带上。插件没被适配时，原因就在这里面。
  const scan = deps.diagnostics.diagnostics.versionScan;
  if (scan?.audited !== undefined && scan.audited.length > 0) {
    lines.push('', '最近一轮版本审计：');
    for (const item of scan.audited) {
      lines.push(`- ${item.name}@${item.version}: ${item.verdict}`);
      for (const reason of (item.reasons ?? []).slice(-2)) lines.push(`    ${reason}`);
      if ((item.missing ?? []).length > 0) lines.push(`    缺符号：${item.missing.join(', ')}`);
    }
  } else if (scan?.error !== undefined) {
    lines.push('', `最近一轮扫描出错：${scan.error}`);
  }
  return { kind: 'success', text: lines.join('\n') };
}
