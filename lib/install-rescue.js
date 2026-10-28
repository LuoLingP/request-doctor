// 让「版本不匹配」的插件装得上。
//
// 管理器把兼容性检查放在安装流程里，对不上的包直接拒掉，profile 原样回滚。用户看到的
// 就是那句「不兼容，可能崩溃或丢数据」，然后什么都没装上。
//
// 它自己留了一个正当出口：版本豁免。先按它的规则授权，让它把包装完（依赖、构建脚本仍由
// pnpm 处理），装完再把声明对齐、把兼容环境建好。跑的是当前实现，声明说的也是当前版本，
// 风险是真的被消掉了，不是被绕过。
//
// 为什么不在 installBundle 上套一层？试过了，不行：远程方法在装饰期就被抓成一个按对象
// 取值的访问器快照，插件侧无论改实例还是改原型，都进不了调用链。授权是它公开支持的那
// 条路，也是失败信息里点名指出的那条。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignManifest, installCompatEnvironment } from './compat-env.js';
import { installRemoteBundle, parseInstallSpec, registerBundle } from './install-bundle.js';

// 从安装失败里取出「哪个包的哪个版本」。
export function refusedPackageOf(error) {
  const first = error?.incompatible?.[0];
  if (first?.name !== undefined && first?.version !== undefined) {
    return { name: first.name, version: first.version, runtimeVersion: first.runtimeVersion };
  }
  // 有些路径只给一句 message，那就退回从 spec 里认。
  const fromSpec = parseInstallSpec(error?.spec);
  if (fromSpec === undefined) return undefined;
  return { name: fromSpec.name, version: fromSpec.range, runtimeVersion: undefined };
}

// 装一个注册表里的包：先授权，再让管理器装，最后补上兼容形态。
export async function installWithExemption(input) {
  const parsed = parseInstallSpec(input.spec);
  if (parsed === undefined) return { installed: false, reason: '不是注册表里的包名' };

  const facts = input.probe.runtimeFacts();
  const profileDir = facts.profileDir ?? '';
  const runtimeVersion = input.runtimeVersion ?? facts.runtimeVersion ?? '';
  if (profileDir === '' || runtimeVersion === '') {
    return { installed: false, reason: '拿不到 profile 目录或运行时版本' };
  }

  // 已经装着的包不用再装一遍。用户多半是想「让它能用」——就地修好就行。
  if (isPresent(profileDir, parsed.name)) {
    input.record('install-present', `${parsed.name} 已经在 profile 里，就地修复`);
    return finish(input, parsed.name, profileDir, runtimeVersion);
  }

  // 版本可能没写。这种时候先让管理器去解析，它会告诉我们实际是哪个版本。
  const first = await attemptInstall(input, input.spec);
  if (first.ok) return finish(input, parsed.name, profileDir, runtimeVersion);

  // 管理器说「已经装了」也走就地修复：用户要的是能用，不是再装一次。
  if (first.error?.code === 'already-installed') {
    return finish(input, parsed.name, profileDir, runtimeVersion);
  }

  const refused = refusedPackageOf(first.error) ?? { name: parsed.name, version: parsed.range };
  if (refused.version === undefined) {
    return { installed: false, reason: first.error?.message ?? '安装失败，且拿不到具体版本' };
  }
  const granted = await grantExemption(input, refused, runtimeVersion);
  if (granted === false) return { installed: false, reason: '版本豁免授权失败' };

  const second = await attemptInstall(input, input.spec);
  if (second.ok) return finish(input, refused.name, profileDir, runtimeVersion);
  return installByHand(input, facts, profileDir, runtimeVersion);
}

// 按管理器自己的规则授权。这是它给的出口，不是我们绕过去。
async function grantExemption(input, refused, runtimeVersion) {
  const packageVersion = `${refused.name}@${refused.version}`;
  try {
    await input.pluginManager?.setVersionExemption?.(packageVersion, runtimeVersion, true, true);
    input.record('install-exemption', `已为 ${packageVersion} 授权运行在 ${runtimeVersion}`);
    return true;
  } catch (failure) {
    input.record('install-exemption-failed', `${packageVersion} 授权失败：${String(failure)}`);
    return false;
  }
}

// 管理器那条路彻底走不通时自己装。
async function installByHand(input, facts, profileDir, runtimeVersion) {
  const byHand = await installRemoteBundle({
    spec: input.spec,
    profileDir,
    runtimeVersion,
    resolveDir: input.probe.runtimeDirOf(facts),
    factsOf: input.factsOf,
    entryOf: input.entryOf,
  });
  if (!byHand.installed) return { installed: false, reason: byHand.reason ?? '安装失败' };
  registerBundle(profileDir, byHand.name);
  return finish(input, byHand.name, profileDir, runtimeVersion);
}

// 这个包是不是已经躺在 profile 里了。
function isPresent(profileDir, name) {
  try {
    return readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8') !== '';
  } catch {
    return false;
  }
}

// 装一次，把失败收成结果而不是抛出去。
async function attemptInstall(input, spec) {
  try {
    const result = await input.pluginManager.installBundle(spec);
    return { ok: result?.application !== 'failed', result, error: result?.error };
  } catch (error) {
    return { ok: false, error };
  }
}

// 装完之后的收尾：声明对齐、环境建好、启用。
async function finish(input, name, profileDir, runtimeVersion) {
  const facts = input.probe.runtimeFacts();
  const dir = join(profileDir, 'node_modules', ...name.split('/'));

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return { installed: false, reason: `${name} 装完之后读不到清单` };
  }

  // 运行时自己发布的声明全部对齐到当前版本。管理器读的就是这份 manifest。
  const served = {};
  for (const key of Object.keys(manifest.peerDependencies ?? {})) {
    if (/^@deepseek-ai\/dsh(?:[-/]|$)/.test(key)) served[key] = runtimeVersion;
  }
  const aligned = alignManifest({ pluginDir: dir, versions: served, runtimeVersion });
  if (aligned.status === 'failed') {
    input.record('install-align-failed', `${name} 对齐失败：${aligned.error}`);
  }

  const environment = installCompatEnvironment({
    pluginDir: dir,
    profileDir,
    requirements: manifest.peerDependencies ?? {},
    imports: new Map(),
    runtimeVersion,
    resolveDir: input.probe.runtimeDirOf(facts),
  });

  try {
    await input.pluginManager?.setBundleEnabled?.(name, true);
  } catch {
    // 重载失败不影响已经装好的东西
  }

  input.record('install', `${name} 已装好，环境 ${environment.status}`);
  return {
    installed: true,
    name,
    version: manifest.version,
    path: dir,
    environment: environment.status,
  };
}
