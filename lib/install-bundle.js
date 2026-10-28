// 装一个远程的插件，不管它的版本检查过不过。
//
// 管理器的安装路径是 pnpm 加一次版本检查：检查不过就抛 incompatible-version，
// 顺手把 profile 回滚。远程包的字节在检查之前就落地了，所以没法像本地目录那样
// 提前改好 manifest——只能在管理器放弃之后，自己把这件事做完。
//
// 这里做的事就是 pnpm add 该做的：取包、取依赖、放进 node_modules、登记为 bundle。
// 差别只有一处：装之前先按当前运行时把声明对齐，装完再把兼容环境建好。
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignManifest, installCompatEnvironment, readJson } from './compat-env.js';
import { fetchPackage, listVersions } from './package-fetch.js';
import { satisfies } from './semver.js';
import { safeCompare } from './version-search.js';
import { cachePackage, resolveClosure } from './version-repair.js';

// 一次性最多装这么多个依赖。正常插件几个，多了说明依赖树异常。
const MAX_DEPENDENCIES = 24;

// 把 "name"、"name@1.2.3"、"@scope/name@^1.0.0" 拆成包名和范围。
export function parseInstallSpec(spec) {
  if (typeof spec !== 'string') return undefined;
  const text = spec.trim();
  if (text === '' || text.startsWith('-')) return undefined;
  // 本地路径、git 地址、tarball 走别的路，这里只认注册表写法。
  if (/^(?:file:|link:|git|https?:)/.test(text) || /[\\/]/.test(text.replace(/^@[^/]+\/[^/]+/, ''))) return undefined;

  const scoped = text.startsWith('@');
  const at = text.indexOf('@', scoped ? 1 : 0);
  if (at < 0) return { name: text, range: undefined };
  return { name: text.slice(0, at), range: text.slice(at + 1) };
}

// 选一个版本：满足范围的最新版本；范围没写就取最新。
export function chooseVersion(versions, range) {
  const usable = versions.filter((version) => typeof version === 'string' && version !== '');
  if (usable.length === 0) return undefined;
  const ordered = [...usable].sort(safeCompare).reverse();
  if (range === undefined) return ordered[0];
  return ordered.find((version) => satisfies(version, range) === true) ?? ordered[0];
}

// 把一个远程插件装进 profile。
//
// 不做部分成功：中途任何一步失败都把这个包整个删掉，like pnpm 回滚一样，
// 不给 profile 留下一半装好的东西。
export async function installRemoteBundle(input) {
  const parsed = parseInstallSpec(input.spec);
  if (parsed === undefined) return { installed: false, reason: '不是注册表里的包名，无法远程安装' };

  const { name, range } = parsed;
  if (typeof input.profileDir !== 'string' || input.profileDir === '') {
    return { installed: false, reason: '拿不到 profile 目录' };
  }

  const versions = await listVersions(name);
  const version = chooseVersion(versions, range);
  if (version === undefined) return { installed: false, reason: `注册表里找不到 ${name}` };

  const target = join(input.profileDir, 'node_modules', ...name.split('/'));
  try {
    rmSync(target, { recursive: true, force: true });
    const fetched = await fetchPackage(name, version, target);
    if (!fetched.ok) return { installed: false, reason: fetched.error ?? '下载失败' };

    // 不是 bundle 的包登记进去会让加载器出错，跟管理器自己的 not-bundle 判断一致。
    const fetchedManifest = readJson(join(target, 'package.json'));
    if (fetchedManifest?.dsh?.bundle === undefined) {
      rmSync(target, { recursive: true, force: true });
      return { installed: false, reason: `${name}@${version} 不是 bundle 插件：清单里没有 dsh.bundle` };
    }

    const dependencies = await installDependencies(target, input);
    const requirements = declaredRangesOf(target);
    // 声明对齐到当前运行时。管理器读的就是这份 manifest，对齐了它的检查才过得去。
    const served = {};
    for (const declared of Object.keys(requirements)) served[declared] = input.runtimeVersion;
    alignManifest({ pluginDir: target, versions: served, runtimeVersion: input.runtimeVersion });

    // 插件到底 import 了什么，得读它的源码才知道。没有这个只能建空环境，
    // 装上了也起不来——缺的垫片一个都没建。
    const imports = input.imports ?? discoverImports(target, input);
    const environment = installCompatEnvironment({
      pluginDir: target,
      profileDir: input.profileDir,
      requirements,
      imports,
      runtimeVersion: input.runtimeVersion,
      resolveDir: input.resolveDir,
    });
    return {
      installed: true,
      name,
      version,
      path: target,
      environment: environment.status,
      // 环境没建成时把原因带出去，用户才知道卡在哪一环。
      environmentReason: environment.error,
      missing: environment.missing ?? [],
      dependencies,
    };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    return { installed: false, reason: String(error) };
  }
}

// 读出新装插件的导入表。
//
// 调用方传了探测函数就用它；没传就退回「按声明的 DSH 依赖建垫片」——
// 声明过的包一定是它要用的，给它们建齐，至少不会因为少一层垫片而 import 失败。
function discoverImports(target, input) {
  if (typeof input.factsOf === 'function' && typeof input.entryOf === 'function') {
    try {
      const manifest = readJson(join(target, 'package.json'));
      const entry = input.entryOf(target, manifest ?? {});
      if (entry !== undefined) {
        const facts = input.factsOf(target, entry);
        if (facts?.imports instanceof Map) return facts.imports;
      }
    } catch {
      // 探测失败就退回声明
    }
  }
  const map = new Map();
  for (const declared of Object.keys(declaredRangesOf(target))) map.set(declared, []);
  return map;
}

// 读出插件自己声明的 DSH 依赖范围。对齐声明时要用它当依据。
function declaredRangesOf(dir) {
  const manifest = readJson(join(dir, 'package.json'));
  if (manifest === undefined) return {};
  const found = {};
  for (const source of [manifest.peerDependencies, manifest.dependencies]) {
    for (const [name, range] of Object.entries(source ?? {})) {
      if (name.startsWith('@deepseek-ai/') && found[name] === undefined) found[name] = range;
    }
  }
  return found;
}

// 把包自己的运行时依赖也放进 profile。
//
// 不装的话，它 import 的兄弟包要么找不到，要么落到别的版本上。
//
// 可选依赖一并处理：它们通常带平台判断，缺了不一定报错，但装上的体验才是完整的。
// 装不上就算了——可选的本义就是可以没有。
async function installDependencies(target, input) {
  const manifest = readJson(join(target, 'package.json'));
  if (manifest === undefined) return [];

  const installed = [];
  const queue = [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
  ];
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  const seen = new Set();
  while (queue.length > 0 && installed.length < MAX_DEPENDENCIES) {
    const [name, range] = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const destination = join(input.profileDir, 'node_modules', ...name.split('/'));
    if (existsSync(join(destination, 'package.json'))) continue;

    const versions = await listVersions(name);
    const version = chooseVersion(versions, /^[\d.]/.test(range) ? range : undefined);
    if (version === undefined) {
      // 可选依赖取不到是正常的：它可能只对别的平台发布。
      if (optional.has(name) === false) installed.push(`${name}（取不到版本）`);
      continue;
    }
    if ((await fetchPackage(name, version, destination)).ok) installed.push(`${name}@${version}`);
  }
  return installed;
}

// 把包登记进 profile 的 bundle 列表。
//
// 只登记这一处：DSH 的 bundle 列表和 dependencies 是两回事，现有 profile 里就有
// 一半 bundle 不在 dependencies 里。写 dependencies 反而会让下次 pnpm 操作去核对它。
export function registerBundle(profileDir, name) {
  const path = join(profileDir, 'package.json');
  const manifest = readJson(path);
  if (manifest === undefined) return { registered: false, reason: '读不到 profile 清单' };

  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { registered: false, reason: 'profile 清单里没有 bundle 列表' };
  if (bundles.includes(name)) return { registered: true, changed: false };

  bundles.push(name);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { registered: true, changed: true };
}

// 供外部复用：闭包取包。
export { cachePackage, resolveClosure };
