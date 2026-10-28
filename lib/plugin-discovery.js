// 找出所有需要处理的插件。
//
// 一个插件需要处理，有四种可能：声明不满足、Loader 拒绝过、装好了但起不来、为安装准备的
// 环境还没建成。代码会从这几个来源分别收一遍，按包名去重后交给审计。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unmetPeers } from './compat.js';
import { entryPathOf, packageDir } from './compat-repair.js';
import { verifyEnvironment } from './env-verify.js';
import { readStagedPreparation } from './install-support.js';

  // 找出所有声明不满足的已装插件，要的是全集，不是一个例子。
//
// 四个来源都看，因为不匹配可能藏在任何一处：
//  - Loader 拒绝的 bundle 自带它算出的未满足集合；
//  - 已启用的插件也可能不匹配，DSH 未必会说；
//  - 已禁用但装着的也算，用户哪天启用时应该已经适配好；
//  - 为安装准备好的插件如果环境还欠着，manifest 已经对齐，只有标记能看出来。
export async function collectMismatched(bundles, facts, plugins, probe) {
  const all = [
    ...deferredCandidates(plugins, facts, probe),
    ...refusedCandidates(bundles, facts),
    ...installedCandidates(plugins, facts, probe),
    // 加载失败的插件不会出现在 listPlugins() 里，所以还得自己去目录里翻一遍。
    ...scannedCandidates(plugins, facts, probe),
  ];
  const seen = new Set();
  return all.filter((item) => admit(item, seen));
}

// 直接扫 profile 的 node_modules，把 listPlugins() 看不到的插件也找出来。
//
// 插件一旦加载失败就不在 Loader 树里，listPlugins() 自然不会返回它——可它恰恰是最需要
// 处理的那种。这里按目录兜底：凡是有 dsh.bundle 声明、且清单里没出现过的，都算候选。
function scannedCandidates(plugins, facts, probe) {
  if (facts.profileDir === undefined) return [];
  const known = new Set((plugins ?? []).map((entry) => entry?.moduleName).filter((name) => typeof name === 'string'));
  return installedPluginNames(facts.profileDir)
    .map((name) => scanOne(name, facts, probe, known))
    .filter((item) => item !== undefined);
}

// 扫到一个插件目录后，判断它要不要进候选。
function scanOne(name, facts, probe, known) {
  const dir = packageDir(facts.profileDir, name);
  if (dir === undefined) return;
  const manifest = probe.readManifestCached(join(dir, 'package.json'));
  if (manifest?.dsh?.bundle === undefined) return undefined;

  const requirements = unmetPeers(manifest, facts.runtimeVersion);
  // 声明就不满足的，肯定要处理，不必再去看源码。
  if (Object.keys(requirements).length > 0) return candidate(name, manifest, requirements, facts);

  // 声明已经满足，就看环境齐不齐：它实际导入的每个 DSH 包都要有垫片，
  // 否则加载时照样找不到东西，表现就是装上了却起不来。
  const imports = pluginImports(dir, manifest, probe, facts);
  // 光有垫片不算数，内容也得对：缺一个导出插件照样起不来。
  // 环境核对通过才算齐，否则重新适配一遍。
  if (environmentCovers(dir, imports) && verifyEnvironment({ pluginDir: dir, imports }).ok) return undefined;
  // 环境不齐就得补，跟它在不在 listPlugins 里无关——
  // 恰恰是已启用却加载失败的插件最需要处理。
  return candidate(name, manifest, declaredPeers(manifest), facts);
}

// 读出插件实际导入了哪些 DSH 包。
function pluginImports(dir, manifest, probe, facts) {
  const entry = entryPathOf(dir, manifest);
  if (entry === undefined) return new Map();
  try {
    return probe.factsOf(dir, entry, facts.runtimeVersion).imports;
  } catch {
    return new Map();
  }
}

// 组装一条候选。
function candidate(name, manifest, requirements, facts) {
  return {
    name,
    version: manifest.version ?? '0.0.0',
    requirements,
    runtimeVersion: facts.runtimeVersion,
    needsEnvironment: true,
  };
}

// 检查插件实际导入的那些 DSH 包，是不是都在自己的 node_modules 里有垫片。
//
// 判据必须用它真正 import 的包，而不是 peerDependencies 里声明的全部。
// 声明往往列出十几个包，实际代码只用到两三个；按声明来判，环境永远显得"不完整"，
// 于是每轮都重试，把真正该做的事淹没在重复劳动里。
function environmentCovers(pluginDir, imports) {
  if (imports === undefined || imports.size === 0) return true;
  const nested = join(pluginDir, 'node_modules');
  for (const name of imports.keys()) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    if (!existsSync(join(nested, ...name.split('/'), 'package.json'))) return false;
  }
  return true;
}
// 列出 profile 的 node_modules 里所有包名，包括 @scope/name 两层结构。
export function installedPluginNames(profileDir) {
  const root = join(profileDir, 'node_modules');
  const names = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    // 符号链接也要算：link: 安装的插件在 node_modules 里就是个链接。
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (child.isDirectory() || child.isSymbolicLink()) names.push(entry.name + "/" + child.name);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

// 一个候选该不该进审计。首次遇到以先到的为准，没有未满足要求的不必审计。
function admit(item, seen) {
  if (typeof item.name !== 'string' || item.name === '') return false;
  if (Object.keys(item.requirements).length === 0) return false;
  if (seen.has(item.name)) return false;
  seen.add(item.name);
  return true;
}
// 把一个插件条目解析成目录和 manifest。
export function resolveEntry(entry, facts, probe) {
  if (typeof entry?.moduleName !== 'string') return undefined;
  if (facts.profileDir === undefined) return undefined;
  const dir = packageDir(facts.profileDir, entry.moduleName);
  if (dir === undefined) return undefined;
  const manifest = probe.readManifestCached(join(dir, 'package.json'));
  return manifest === undefined ? undefined : { name: entry.moduleName, dir, manifest };
}

// 为安装做好准备、但环境还欠着的插件。它们的 manifest 已经对齐，只有准备标记能说明还差什么。
// 准备标记还代表有待办吗。已经建好包的就是完事了，只有延后的才要补建。
function needsEnvironment(pending) {
  if (pending === undefined) return false;
  return (pending.packages ?? []).length === 0;
}
function deferredCandidates(plugins, facts, probe) {
  return (plugins ?? [])
    .map((entry) => resolveEntry(entry, facts, probe))
    .filter((resolved) => resolved !== undefined)
    .map((resolved) => ({ resolved, pending: readStagedPreparation(resolved.dir) }))
    .filter(({ pending }) => needsEnvironment(pending))
    .map(({ resolved, pending }) => ({
      name: resolved.name,
      version: resolved.manifest.version ?? '0.0.0',
      requirements: pending.requirements ?? {},
      runtimeVersion: facts.runtimeVersion,
      deferred: true,
    }));
}

// 准备标记还代表有待办吗。已经建好包的就是完事了，只有延后的才要 Host 补建。
function refusedCandidates(bundles, facts) {
  const found = [];
  for (const bundle of bundles ?? []) {
    const issues = bundle?.error?.incompatible;
    if (!Array.isArray(issues)) continue;
    for (const issue of issues) {
      if (typeof issue?.version !== 'string') continue;
      found.push({
        name: issue.name,
        version: issue.version,
        requirements: issue.requirements ?? {},
        runtimeVersion: issue.runtimeVersion ?? facts.runtimeVersion,
      });
    }
  }
  return found;
}

// manifest 自己声明了未满足 peer 范围的已装插件。
//
// 既覆盖 DSH 没拒绝过的已启用插件，也覆盖已禁用的，这样后者被启用时已经是适配好的。
function installedCandidates(plugins, facts, probe) {
  return (plugins ?? [])
    .map((entry) => installOne(entry, facts, probe))
    .filter((item) => item !== undefined);
}

// 清单里已有的插件，判断它要不要进候选。
function installOne(entry, facts, probe) {
  const resolved = resolveEntry(entry, facts, probe);
  if (resolved === undefined) return undefined;

  const requirements = unmetPeers(resolved.manifest, facts.runtimeVersion);
  const unmet = Object.keys(requirements).length > 0;
  // manifest 已经满足、但插件根本没激活起来，也要管。
  // 这种情况通常是声明之前对齐过、环境却没建成，光看 manifest 看不出来。
  const failedToActivate = entry?.enabled === true && entry?.fiberPhase !== 'active';
  const needsEnvironment = !unmet && failedToActivate;
  if (!unmet && !needsEnvironment) return undefined;

  return {
    name: resolved.name,
    version: resolved.manifest.version ?? '0.0.0',
    // 声明没问题但起不来时，按它自己声明的 peer 范围去建环境。
    requirements: needsEnvironment ? declaredPeers(resolved.manifest) : requirements,
    runtimeVersion: facts.runtimeVersion,
    needsEnvironment,
  };
}

// 把 manifest 里所有 DSH peer 都列出来，不管当前满不满足。
export function declaredPeers(manifest) {
  const peers = manifest?.peerDependencies;
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return {};
  const declared = {};
  for (const [name, range] of Object.entries(peers)) {
    if (!/^@deepseek-ai\/dsh(?:[-/]|$)/.test(name) || typeof range !== 'string') continue;
    declared[name] = range;
  }
  return declared;
}
