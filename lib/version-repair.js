// 插件与 DSH 的版本修复。
//
// 找出所有声明了当前运行时不满足的依赖的插件，逐个审计，把能证明兼容的那些交给兼容环境。
// 审计是前置条件：插件要用的符号已经不存在了，就绝不硬上。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unmetPeers } from './compat.js';
import { auditInstalledPlugin, entryPathOf, installedEntryPath, packageDir } from './compat-repair.js';
import { alignManifest, installCompatEnvironment } from './compat-env.js';
import { describeContention } from './arbitrate.js';
import { clearStagedPreparation, prepareForInstall, readStagedPreparation } from './install-support.js';
import { verifyEnvironment } from './env-verify.js';
import { fetchPackage, listVersions } from './package-fetch.js';
import { orderCandidates } from './version-search.js';
import { pruneCache, touchAndReturn } from './cache-store.js';

export { pruneCache };
import { collectMismatched } from './plugin-discovery.js';

// 激活过程中重排会报这个错
const NESTED_HMR = /transactions cannot be nested/i;

// 造一个版本修复器。
export function createVersionRepair(input) {
  const { ctx, probe, diagnostics, config } = input;
  const { record, stats } = diagnostics;
  const state = { busy: false };

  // 拿插件管理器服务，没有就返回 undefined。
  const managerOf = () => probe.get('pluginManager');

  const deps = { ctx, probe, diagnostics, config, record, stats, warn: input.warn, later: input.later, maxHmrRetries: input.maxHmrRetries, state, scanError: diagnostics.scanError };

  return {
    run: (reason, manager, attempt) => run(reason, manager ?? managerOf(), attempt ?? 0, deps),
    isBusy: () => state.busy,
  };
}

// 把每个不匹配的插件都审一遍。
//
// 单个插件读不出来或者 manifest 坏了，不能把整轮扫描带停，所以每个都单独兜住。
async function auditAll(bundles, facts, plugins, probe) {
  const taken = probe.activeProviders() ?? [];
  const audited = [];
  for (const issue of await collectMismatched(bundles, facts, plugins, probe)) {
    // One plugin's unreadable package or malformed manifest must not abort the
    // scan for every other plugin, so each audit is contained.
    audited.push(await auditOne(issue, facts, probe, taken));
  }
  return audited;
}

// 审一个候选。抛出来的异常折算成 review，不往上冒。
async function auditOne(issue, facts, probe, taken) {
  const base = {
    name: issue.name,
    version: issue.version,
    runtimeVersion: issue.runtimeVersion ?? facts.runtimeVersion,
    requirements: issue.requirements ?? {},
    deferred: issue.deferred === true,
    needsEnvironment: issue.needsEnvironment === true,
  };
  try {
    const manifestPath = facts.profileDir === undefined
      ? undefined
      : join(packageDir(facts.profileDir, issue.name) ?? '', 'package.json');
    const result = await auditInstalledPlugin({
      profileDir: facts.profileDir,
      name: issue.name,
      runtimeVersion: base.runtimeVersion,
      requirements: base.requirements,
      manifest: manifestPath === undefined ? undefined : probe.readManifestCached(manifestPath),
      runtimeEntryOf: probe.runtimeEntryOf(facts),
      takenProviders: taken,
      assumeCompatible: base.deferred === true || base.needsEnvironment === true,
    });
    return {
      ...base,
      verdict: result.verdict,
      reasons: result.reasons,
      missing: result.missing,
      imports: result.imports,
      importMap: result.importMap,
      providers: result.providers,
      conflicts: result.conflicts ?? [],
    };
  } catch (error) {
    return {
      ...base,
      verdict: 'review',
      reasons: [`audit failed: ${String(error)}`],
      missing: [],
      imports: [],
      importMap: new Map(),
      providers: [],
      conflicts: [],
    };
  }
}
// 已启用插件的花名册，附上每个实际在服务的路由。
//
// 源码分析会多算，所以要跟运行时注册表求交集：某个地区没启用，不代表它在抢路由。
function providerRoster(facts, plugins, deps) {
    const { probe, warn } = deps;
    const roster = [];
    const live = probe.activeProviders();
    for (const entry of plugins ?? []) {
      if (entry?.enabled !== true) continue;
      const entryPath = facts.profileDir === undefined ? undefined : installedEntryPath(facts.profileDir, entry.moduleName);
      if (entryPath === undefined) continue;
      try {
        const declared = probe.factsOf(dirname(entryPath), entryPath, facts.runtimeVersion).providers;
        roster.push({
          name: entry.moduleName,
          version: entry.version ?? '0.0.0',
          active: entry.fiberPhase === 'active',
          providers: live === undefined ? declared : declared.filter((id) => live.includes(id)),
        });
      } catch (error) {
        // A plugin that cannot be read contributes no claim, but the reason is
        // worth one line: a broken install otherwise looks like a clean scan.
        warn(`request-doctor: could not analyse ${entry.moduleName}: ${String(error)}`);
      }
    }
    return roster;
  };

// 本进程里已经确认「所有版本都凑不齐」的组合，就别再搜第二遍了。
//
// 不记这一笔的话，每次扫描都会把注册表和下载重走一遍——明明上一次已经证明没有。
// 进程重启会清空，所以新发布的版本自然会被重新看到。
const exhaustedSearches = new Set();

// 把缺符号的那些包的真实旧版本取回来。
//
// 兼容模式的关键就在这里：插件当初是对着某个版本写的，那个版本的代码还在仓库里，
// 取下来装上就行。这样跑的是它认识的那份实现，不是转发到今天的替身。
async function fetchNeededVersions(item, facts, deps) {
  const map = new Map();
  const probeResult = installCompatEnvironment({
    pluginDir: facts.profileDir ?? '',
    profileDir: facts.profileDir,
    ...commonEnvironmentFields(item),
    runtimeVersion: item.runtimeVersion,
    resolveDir: deps.probe.runtimeDirOf(facts),
    // 只问一句，别真写：这一调用如果落盘，会把 profile 里的真实包盖成垫片。
    dryRun: true,
  });
  if (probeResult.status !== 'needs-old-version') return map;


  for (const need of probeResult.needed) {
    const found = await findVersionWithSymbols(item, facts, need, deps);
    if (found !== undefined) map.set(need.name, found);
  }
  return map;
}

// 找一个能凑齐符号的版本。
//
// 钉住的那个版本未必有插件要的东西——它声明的范围可能覆盖好几个版本，而符号只在其中
// 某一个里。既然旧代码都还在仓库里，就按顺序试，第一个凑齐的就是答案。
async function findVersionWithSymbols(item, facts, need, deps) {
  const key = `${need.name}|${(need.symbols ?? []).join(',')}`;
  if (exhaustedSearches.has(key)) return undefined;

  const versions = await listVersions(need.name);
  const candidates = orderCandidates(versions, item.requirements?.[need.name], need.version);
  if (candidates.length === 0) candidates.push(need.version);

  for (const version of candidates) {
    const dir = await cachePackage(need.name, version, facts.profileDir, deps);
    if (dir === undefined) continue;
    // 只问这个版本能不能凑齐，别真装。
    const trial = installCompatEnvironment({
      pluginDir: '',
      profileDir: facts.profileDir,
      ...environmentInput(item, facts, deps),
      oldVersionDirs: new Map([[need.name, { dir, version }]]),
      dryRun: true,
    });
    if (trial.status === 'installable') {
      return { dir, version, closure: await resolveClosure(need.name, version, facts.profileDir, deps) };
    }
    deps.record('version-skipped', `${need.name}@${version} 凑不齐，试下一个`);
  }
  exhaustedSearches.add(key);
  return undefined;
}

// 把每个包各自的闭包合起来。同一个包出现在多个闭包里时，以先来的为准——
// 它们通常来自同一批发布，版本一致；真不一致的情况下，冲突本身就该由插件作者解决。
function mergeClosures(oldVersionDirs) {
  const merged = new Map();
  for (const entry of oldVersionDirs?.values() ?? []) {
    for (const [name, value] of entry.closure ?? new Map()) {
      if (!merged.has(name)) merged.set(name, value);
    }
  }
  return merged;
}
// 每处都一样的两个字段：插件声明的范围和它实际导入的符号。
function commonEnvironmentFields(item) {
  return {
    requirements: item.requirements ?? {},
    imports: item.importMap ?? new Map(),
  };
}

// 建兼容环境要的那几个参数，每处都一样，拼一次就够。
function environmentInput(item, facts, deps) {
  return {
    profileDir: facts.profileDir,
    ...commonEnvironmentFields(item),
    runtimeVersion: item.runtimeVersion,
    resolveDir: deps.probe.runtimeDirOf(facts),
  };
}

// 一次闭包最多装这么多个包。旧版本的依赖通常几个，多了说明依赖树异常，该停下来。
const MAX_CLOSURE = 16;

// 从一个版本范围里取出具体版本号。取不到就跳过——猜一个版本去装还不如不装。
function exactVersionOf(range) {
  if (typeof range !== 'string') return undefined;
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)?.[0];
}

// 把旧版本自己的运行时依赖也取回来。
//
// 这一步不能省：DSH 的包彼此依赖，而且钉的是具体版本。只装它自己一个，加载时
// 它 import 的兄弟包要么根本找不到，要么拿到新版本——两种都不是插件当初的环境。
export async function resolveClosure(root, version, profileDir, deps) {
  const closure = new Map();
  const seen = new Set();
  const queue = [{ name: root, version }];

  while (queue.length > 0 && closure.size < MAX_CLOSURE) {
    const next = queue.shift();
    if (next.name === undefined || seen.has(next.name)) continue;
    seen.add(next.name);

    const dir = await cachePackage(next.name, next.version, profileDir, deps);
    if (dir === undefined) continue;
    closure.set(next.name, { dir, version: next.version });
    for (const dependency of runtimeDependenciesOf(dir)) {
      if (seen.has(dependency.name)) continue;
      queue.push(dependency);
    }
  }
  return closure;
}


// 读出一个包自己依赖的运行时包，版本按声明钉死。
//
// 只关心 @deepseek-ai 这一谱系：第三方库的版本线跟运行时不是一回事，交给正常的
// 模块解析去处理。取不到具体版本的一律跳过——猜一个版本去装，还不如不装。
function runtimeDependenciesOf(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const found = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const version = exactVersionOf(range);
    if (version !== undefined) found.push({ name, version });
  }
  return found;
}

// 取一个包到本地缓存目录，已经缓存过就直接用。
export async function cachePackage(name, version, profileDir, deps) {
  if (typeof profileDir !== 'string' || profileDir === '') return undefined;
  const dir = join(profileDir, '.request-doctor-cache', ...`${name}@${version}`.split('/'));
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (manifest.version === version) return touchAndReturn(dir);
  } catch {
    // 没缓存，去取
  }
  const result = await fetchPackage(name, version, dir);
  if (!result.ok) {
    deps.record('fetch-failed', `${name}@${version} 取不回来：${result.error ?? ''}`);
    return undefined;
  }
  deps.record('fetch', `${name}@${version} 已取回并缓存`);
  return touchAndReturn(dir);
}


  // 给插件配上它当初的那个环境。
//
// 插件目录里的嵌套 node_modules 会遮住 profile 里的新包，每个垫片又转发现行实现，
// 于是插件看到的是自己期望的版本，跑的是当前代码。manifest 也得跟着对齐，
// 因为 DSH 在任何导入发生之前就要读它。
async function adapt(item, dir, facts, deps) {
    const { probe, diagnostics, record, stats, warn, scanError } = deps;
    const packageVersion = `${item.name}@${item.version}`;
    // 缺符号时先把插件期望的真实旧版本取回来，再建环境。
    const oldVersionDirs = await fetchNeededVersions(item, facts, deps);
    const result = installCompatEnvironment({
      pluginDir: dir,
      profileDir: facts.profileDir,
      ...commonEnvironmentFields(item),
      runtimeVersion: item.runtimeVersion,
      resolveDir: probe.runtimeDirOf(facts),
      oldVersionDirs,
      closure: mergeClosures(oldVersionDirs),
    });


    if (result.status === 'refused') {
      deps.scanError(`${packageVersion}: ${result.error}`);
      record('compat-refused', `${packageVersion} cannot run here: ${result.error}`);
      return false;
    }
    if (result.status === 'failed') {
      deps.scanError(`${packageVersion}: ${result.error ?? 'unknown failure'}`);
      warn(`request-doctor: compatibility environment failed for ${packageVersion}: ${result.error ?? ''}`);
      return false;
    }

    // 建好了不等于能用。逐条核对插件要的每个符号环境是否真能给出来，
    // 有问题在这里就暴露，而不是等插件加载那一刻崩给用户看。
    const verdict = verifyEnvironment({ pluginDir: dir, imports: item.importMap ?? new Map() });
    if (!verdict.ok) {
      const detail = verdict.problems.map((problem) => `${problem.name} ${problem.detail}`).join('; ');
      deps.scanError(`${packageVersion}: 环境核对未通过：${detail}`);
      record('compat-unverified', `${packageVersion} 的环境核对未通过：${detail}`);
      return false;
    }
    // 运行时包装在归档里时核对不了，不算失败，但值得记一笔。
    for (const note of verdict.unverified) {
      record('compat-unchecked', `${packageVersion}: ${note.name} ${note.detail}`);
    }

    // 环境没变化也要对齐声明。
    //
    // 有些插件一个运行时包都不 import——皮肤、纯客户端界面就是这种。它们没有垫片要建，
    // 环境自然是「没变化」，但 manifest 里照样声明了运行时版本。跳过对齐的话，
    // 这类插件永远过不了管理器的检查，也永远显示不出来。
    // 有垫片的包按运行时版本声明；只声明、没导入的 DSH 包也要一起对齐——
    // 管理器的检查看的就是这份 manifest，漏一个它就不放行。
    const served = Object.fromEntries([
      ...(result.packages ?? []).map((pkg) => [pkg, item.runtimeVersion]),
      ...Object.keys(item.requirements ?? {}).map((pkg) => [pkg, item.runtimeVersion]),
    ]);
    const aligned = alignManifest({ pluginDir: dir, versions: served, runtimeVersion: item.runtimeVersion });
    if (aligned.status === 'failed') {
      deps.scanError(`${packageVersion}: ${aligned.error}`);
      warn(`request-doctor: could not align ${packageVersion}: ${aligned.error}`);
      return false;
    }
    if (result.status === 'unchanged' && aligned.status !== 'aligned') return true;
    // 装的时候提前备好的环境，到这里已经落定，临时标记没用了。
    if (item.deferred === true) clearStagedPreparation(dir);
    stats.versionRepairs += 1;
    record('compat', `${packageVersion} given a ${item.runtimeVersion} compatibility environment for ${(result.packages ?? []).join(', ') || 'no shims'}; declared versions aligned`);
    return true;
  };

// 审一遍所有插件，把结论写进诊断，并返回分了组的清单。
//
// 冲突只报告不动手：两个插件抢同一个 provider 时，谁该让位是人的判断，
// 插件贸然停用一个，用户看到的就是「莫名其妙少了功能」。
async function collectAudit(reason, attempt, bundles, facts, plugins, deps) {
  const { diagnostics, probe, record } = deps;
  const audited = await auditAll(bundles, facts, plugins, probe);
  const roster = audited.length === 0 ? [] : providerRoster(facts, plugins, deps);

  for (const entry of audited) {
    entry.contention = describeContention({
      name: entry.name,
      providers: entry.providers ?? [],
      conflicts: entry.conflicts ?? [],
      roster,
    });
    if (entry.contention.contested.length > 0) {
      record('route-report', `${entry.name}@${entry.version} shares ${entry.contention.contested.join(', ')}`);
    }
  }


  const approved = audited.filter((entry) => entry.verdict === 'compatible');
  const rejected = audited.filter((entry) => entry.verdict !== 'compatible');
  diagnostics.diagnostics.versionScan = {
    reason,
    at: new Date().toISOString(),
    ok: true,
    attempt,
    bundles: bundles.length,
    audited,
    approved: approved.map((entry) => `${entry.name}@${entry.version}`),
    rejected: rejected.map((entry) => ({ name: entry.name, verdict: entry.verdict, reasons: entry.reasons })),
  };
  for (const entry of rejected) {
    record('version-review', `${entry.name}@${entry.version} not approved (${entry.verdict}): ${entry.reasons.slice(-1)[0] ?? ''}`);
  }
  return { approved, rejected };
}


// 重载刚适配好的插件。
//
// Loader 是在组合期检查 bundle 的，所以改过 manifest 之后必须重新组合才生效。
// 只碰这次真正适配过的插件，别人的状态一概不动。
async function reloadAdapted(manager, fixed, deps) {
  let retry = false;
  for (const packageVersion of fixed) {
    const name = packageVersion.slice(0, packageVersion.lastIndexOf('@'));
    if (name === '') continue;
    try {
      const applied = await manager.setBundleEnabled(name, true);
      if (applied?.application === 'failed') {
        const detail = JSON.stringify(applied.error ?? applied);
        deps.scanError(`${name}: ${detail}`);
        if (NESTED_HMR.test(detail)) retry = true;
      }
    } catch (error) {
      const detail = String(error);
      deps.scanError(`${name}: ${detail}`);
      if (NESTED_HMR.test(detail)) retry = true;
    }
  }
  return retry;
}


  // 跑一轮修复。
async function run(reason, manager, attempt, deps) {
    if (deps === undefined) throw new Error('NO_DEPS:' + new Error().stack);
    const { diagnostics, config, record, later, scanError } = deps;
    const { probe, stats, warn } = deps;
    if (manager === undefined || manager === null) {
      diagnostics.diagnostics.versionScan = { reason, at: new Date().toISOString(), ok: false, error: 'pluginManager service is unavailable' };
      diagnostics.scheduleWrite();
      return [];
    }
    if (!config().autoVersionRepair || deps.state.busy) return [];
    deps.state.busy = true;
    try {
      const bundles = await manager.listBundles();
      const facts = probe.runtimeFacts();
      // One roster lookup serves both the mismatch scan and the route analysis.
      let plugins;
      try {
        plugins = await manager.listPlugins?.();
      } catch {
        plugins = undefined;
      }
      const { approved, rejected } = await collectAudit(reason, attempt, bundles, facts, plugins, deps);

      const fixed = [];
      // Every compatible plugin is adapted, not just the first few: a profile can
      // carry a dozen mismatched plugins. The cap is a per-scan safety valve, and
      // `0` means no limit.
      const budget = config().maxVersionRepairs === 0 ? approved.length : config().maxVersionRepairs;
      for (const item of approved.slice(0, budget)) {
        const dir = facts.profileDir === undefined ? undefined : packageDir(facts.profileDir, item.name);
        if (dir === undefined) {
          deps.scanError(`${item.name}@${item.version}: installed directory not found`);
          continue;
        }
        if (await adapt(item, dir, facts, deps)) fixed.push(item.name + "@" + item.version);
      }

      const retry = await reloadAdapted(manager, fixed, deps);

      // 扫完顺手清一下缓存。版本搜索会把试过的版本都下载下来，不清理只会越长越大。
      const pruned = pruneCache(facts.profileDir);
      if (pruned > 0) record('cache-pruned', `清掉 ${pruned} 个冷缓存`);


      diagnostics.scheduleWrite();
      if (retry && attempt < 6) {
        const waitMs = Math.min(2000 * 2 ** attempt, 60000);
        later(() => {
          run(`${reason}-retry`, manager, attempt + 1).catch(() => {});
        }, waitMs);
      }
      return fixed;
    } catch (error) {
      diagnostics.diagnostics.versionScan = { reason, at: new Date().toISOString(), ok: false, error: String(error) };
      diagnostics.scheduleWrite();
      warn(`request-doctor: version scan failed: ${String(error)}`);
      return [];
    } finally {
      deps.state.busy = false;
    }
  };
