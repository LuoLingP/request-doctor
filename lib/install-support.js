// 让本来装不上的插件能装上。
//
// pluginManager.installBundle 先跑 pnpm，然后拿新包自己的 manifest 做版本检查，
// 对不上就抛 incompatible-version。抛的时候只回滚 package.json 和 pnpm-lock.yaml，
// 包其实已经躺在 node_modules 里了，但永远不会被选中——看起来就是安装失败，什么都没装上。
//
// 正确做法不是等检查失败后再去绕过它，那时候 profile 已经回滚了。而是在管理器读 manifest
// 之前，就让检查按它自己的规则通过：把兼容环境准备好，这样它读到的声明确实满足当前运行时。
//
// 环境建在插件目录里，并留一个标记记录做过什么，装失败时可以原样撤回。
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignManifest, installCompatEnvironment, readJson, removeCompatEnvironment, restoreManifest } from './compat-env.js';

// 准备好的环境在这儿等安装落地。
export const STAGING_DIR = '.request-doctor-staging';

// 判断一个安装参数指向的是本地目录还是远程包。
//
// 参数可能是包名、file: 或 link: 路径、git 地址或者 tarball。只有本地目录能在安装前
// 先看一眼，也只有这种情况才能提前准备环境——远程包的字节还没落到盘上。
export function classifySpec(spec, profileDir) {
  if (typeof spec !== 'string') return { kind: 'remote' };
  const text = spec.trim();
  const local = /^(?:file:|link:)?(?:\.{0,2}\/|[A-Za-z]:[\\/]|\/)/.test(text);
  if (!local) return { kind: 'remote' };
  const path = text.replace(/^(?:file:|link:)/, '');
  const absolute = /^[A-Za-z]:[\\/]|^\//.test(path) ? path : join(profileDir, path);
  return existsSync(join(absolute, 'package.json')) ? { kind: 'local', dir: absolute } : { kind: 'remote' };
}

// 在本地插件装上来之前，先给它把兼容环境备好。
//
// 就地改目标目录（安装时会从这里链接），留一个标记记下改了什么，装失败了能撤回。
export function prepareForInstall(input) {
  const checked = inspectCandidate(input);
  if (checked.reason !== undefined) return checked;

  const { dir, requirements, imports } = checked;
  resetPreviousAttempt(dir);

  const result = installCompatEnvironment({
    pluginDir: dir,
    profileDir: input.profileDir,
    requirements,
    imports,
    runtimeVersion: input.runtimeVersion,
    resolveDir: input.resolveDir,
  });

  // 缺符号的包要先取真实旧版本，那是异步的，这一步只对齐声明把安装放行，
  // 环境交给后续扫描去建——扫描里能等网络。
  if (result.status === 'needs-old-version') {
    const deferred = deferEnvironment({ dir, requirements, runtimeVersion: input.runtimeVersion });
    if (deferred.prepared === true) {
      const names = result.needed.map((item) => `@`).join(', ');
      return { ...deferred, reason: `已放行安装；环境需要真实旧版本 ，由后续扫描取回后建立` };
    }
    return deferred;
  }
  if (result.status === 'refused' && onlyMissingRuntimePackages(result.missing)) {
    return deferEnvironment({ dir, requirements, runtimeVersion: input.runtimeVersion });
  }
  if (result.status === 'refused') {
    // 环境建不全，但安装本身不该被拦下来。
    //
    // 被拒绝通常是因为某个符号在当前运行时里改名或者没了。那是运行期的问题：
    // 插件装上之后能正常加载，真的用到那个符号时才会报错，而且报得清楚。
    // 卡在安装这一步，用户连插件都看不到，反而更难判断。
    // 所以这里只对齐声明放行，缺什么一并带回去告诉用户。
    const deferred = deferEnvironment({ dir, requirements, runtimeVersion: input.runtimeVersion });
    if (deferred.prepared === true) {
      return {
        ...deferred,
        missing: result.missing,
        reason: `${result.error}；已放行安装，这些符号要等插件真正用到时才会报错`,
      };
    }
    return deferred;
  }
  if (result.status !== 'installed') {
    return { prepared: false, dir, reason: result.error ?? `environment could not be built (${result.status})` };
  }
  return finalizePreparation({ dir, packages: result.packages, runtimeVersion: input.runtimeVersion });
}

// 动笔写任何东西之前，先把目标目录验一遍。
// 返回两种结果：拒绝的理由，或者建环境需要的那几样东西。
function inspectCandidate(input) {
  const classified = classifySpec(input.spec, input.profileDir);
  if (classified.kind !== 'local' || classified.dir === undefined) {
    return {
      prepared: false,
      reason: 'only a local directory can be inspected before it is installed; a registry package is downloaded by the manager itself',
    };
  }
  const dir = classified.dir;
  const manifest = readJson(join(dir, 'package.json'));
  if (manifest === undefined) return { prepared: false, dir, reason: 'package.json is unreadable' };

  const requirements = input.unmetPeers?.(manifest, input.runtimeVersion) ?? {};
  if (Object.keys(requirements).length === 0) {
    return { prepared: false, dir, reason: 'the package already declares requirements this runtime satisfies' };
  }
  const entry = input.entryOf?.(dir, manifest);
  if (entry === undefined) return { prepared: false, dir, reason: 'the package declares no resolvable entry module' };

  const facts = input.factsOf?.(dir, entry);
  if (facts === undefined || facts.imports.size === 0) {
    return { prepared: false, dir, reason: 'the package imports no DSH package, so no environment can be built for it' };
  }
  return { dir, requirements, imports: facts.imports };
}

// 把上一次尝试留下的东西清干净。
// 旧垫片留着会被当成这次建的，后面判断就全错了。
function resetPreviousAttempt(dir) {
  if (existsSync(join(dir, STAGING_DIR))) rmSync(join(dir, STAGING_DIR), { recursive: true, force: true });
  removeCompatEnvironment(dir);
}

// 判断被拒绝的原因是不是清一色「profile 里看不见运行时的包」。
// 运行时装在归档里时就是这个情况。安装检查只看 manifest，所以光对齐声明就够了。
function onlyMissingRuntimePackages(missing) {
  return missing.every((entry) => /not installed in the profile/.test(entry));
}

// 只对齐声明，环境留给下一轮扫描去建。
function deferEnvironment(input) {
  const aligned = alignManifest({
    pluginDir: input.dir,
    versions: Object.fromEntries(Object.keys(input.requirements).map((pkg) => [pkg, input.runtimeVersion])),
    runtimeVersion: input.runtimeVersion,
  });
  if (aligned.status === 'failed') {
    restoreManifest(input.dir);
    return { prepared: false, dir: input.dir, reason: aligned.error ?? 'the manifest could not be aligned' };
  }
  writeFileSync(
    join(input.dir, STAGING_DIR),
    `${JSON.stringify({ runtimeVersion: input.runtimeVersion, packages: [], deferred: true, requirements: input.requirements }, null, 2)}\n`,
    'utf8',
  );
  return {
    prepared: true,
    dir: input.dir,
    packages: [],
    deferred: true,
    requirements: input.requirements,
    reason: 'declaration aligned so the install can proceed; the environment is built by the next scan',
  };
}

// 环境建好后，把声明对齐到它实际服务的版本，并记下这次准备。
// 管理器读的是包自己的 manifest，不写这一笔，环境明明在那儿，安装照样被拒。
function finalizePreparation(input) {
  const aligned = alignManifest({
    pluginDir: input.dir,
    versions: Object.fromEntries(input.packages.map((pkg) => [pkg, input.runtimeVersion])),
    runtimeVersion: input.runtimeVersion,
  });
  if (aligned.status === 'failed') {
    abandonPreparation(input.dir);
    return { prepared: false, dir: input.dir, reason: aligned.error ?? 'the manifest could not be aligned' };
  }
  writeFileSync(
    join(input.dir, STAGING_DIR),
    `${JSON.stringify({ runtimeVersion: input.runtimeVersion, packages: input.packages }, null, 2)}\n`,
    'utf8',
  );
  return { prepared: true, dir: input.dir, packages: input.packages };
}
// 读一下还没处理完的准备标记。
export function readStagedPreparation(dir) {
  return readJson(join(dir, STAGING_DIR));
}

// 环境已经有了，回去把准备标记清掉。
export function clearStagedPreparation(dir) {
  try {
    rmSync(join(dir, STAGING_DIR), { force: true });
  } catch {
    /* retried on the next scan */
  }
}

// 安装没成的话，把准备过的痕迹原样撤掉。
export function abandonPreparation(dir) {
  const staging = join(dir, STAGING_DIR);
  if (!existsSync(staging)) return false;
  removeCompatEnvironment(dir);
  // 这次安装对齐过 manifest，现在把原来的还回去，失败的尝试不该在候选目录里留下痕迹。
  restoreManifest(dir);
  try {
    rmSync(staging, { force: true });
  } catch {
    /* reported through the return value */
  }
  return true;
}

// 管理器装完之后，确认准备还在不在。
// 它会换掉目录（file: 安装是拷贝不是链接），那样环境就没了，得从装好的那份重建。
export function preparationSurvived(dir) {
  return existsSync(join(dir, STAGING_DIR));
}
