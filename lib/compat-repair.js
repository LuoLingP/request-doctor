// 找到装好的插件，拿它跟当前运行时对一遍。
//
// 这是版本修复里「能不能真跑」那一半：manifest 里的 peer 范围只是句声明，
// 所以放行之前要拿插件实际导入的东西，去对运行时实际导出的东西。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  auditPluginCompatibility,
  collectDshImports,
  collectIdLiterals,
  collectProviderIds,
  parseExportedNames,
  registersVariantRoute,
} from './compat.js';

// 一个插件的模块图最多读这么多个文件
const MAX_GRAPH_FILES = 40;

// 读文件，读不到就返回 undefined
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// 从 profile 目录推算某个包的安装位置
export function packageDir(profileDir, name) {
  if (profileDir === undefined) return undefined;
  try {
    const require = createRequire(join(profileDir, 'package.json'));
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

// 算出某个已装包的入口文件路径。
export function installedEntryPath(profileDir, name) {
  const dir = packageDir(profileDir, name);
  if (dir === undefined) return undefined;
  const manifestText = readText(join(dir, 'package.json'));
  if (manifestText === undefined) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return undefined;
  }
  return entryPathOf(dir, manifest);
}

// 算出一个包的入口文件在哪。
export function entryPathOf(dir, manifest) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      for (const key of ['default', 'import', 'node', 'require']) {
        const nested = pick(value[key]);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  const exported = manifest?.exports;
  const fromExports = pick(exported?.['.'] ?? (typeof exported === 'string' ? exported : undefined));
  const relative = fromExports ?? (typeof manifest?.main === 'string' ? manifest.main : 'index.js');
  return relative === undefined ? undefined : resolve(dir, relative);
}

// 把一个插件的 DSH 导入和 LLM provider 路由一起收上来。
export function collectPackageFacts(dir, entryPath) {
  const scan = { imports: new Map(), providers: new Set(), literals: new Set(), variantRoute: false };
  walkModuleGraph(entryPath, scan);
  // A variant route's id lives in a sibling chunk; any declared id could be it.
  if (scan.variantRoute) for (const id of scan.literals) scan.providers.add(id);
  return { imports: scan.imports, providers: [...scan.providers] };
}

// 读一个模块和它相对路径上的依赖，把结果累计起来。
//
// 只跟相对导入：打包进来的 chunk 自己的 DSH 导入属于这个插件的契约，
// 但它的第三方依赖不算。
function walkModuleGraph(entryPath, scan) {
  const queue = [entryPath];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (seen.size > MAX_GRAPH_FILES) break;
    const source = readText(current);
    if (source === undefined) continue;
    absorbModule(source, current, scan, queue);
  }
}

// 把一个模块里的声明并进累加器，再把它导入的模块排进队列。
function absorbModule(source, current, scan, queue) {
  for (const [packageName, symbols] of collectDshImports(source)) {
    scan.imports.set(packageName, [...new Set([...(scan.imports.get(packageName) ?? []), ...symbols])]);
  }
  for (const id of collectProviderIds(source)) scan.providers.add(id);
  for (const id of collectIdLiterals(source)) scan.literals.add(id);
  if (registersVariantRoute(source)) scan.variantRoute = true;
  for (const target of relativeImportsOf(source, current)) queue.push(target);
}

// 把模块里的相对导入解析成真实存在的文件路径。
function relativeImportsOf(source, current) {
  const found = [];
  const pattern = /\bfrom\s*["'](\.[^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const target = resolve(dirname(current), match[1]);
    for (const candidate of [target, `${target}.js`, join(target, 'index.js')]) {
      if (readText(candidate) !== undefined) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

// 拿一个已装的 bundle 跟当前运行时对一遍。
// 插件查不了的时候，按这个形状返回。
function review(reason) {
  return { verdict: 'review', reasons: [reason], missing: [], imports: [], providers: [] };
}

export async function auditInstalledPlugin(input) {
  const dir = packageDir(input.profileDir, input.name);
  if (dir === undefined) {
    return review(`${input.name} is not installed under ${input.profileDir}`);
  }
  // 调用方判断「要审计」的时候八成已经解析过这个 manifest 了，直接拿来用，别读第二遍。
  let manifest = input.manifest;
  if (manifest === undefined) {
    const manifestText = readText(join(dir, 'package.json'));
    if (manifestText === undefined) {
      return review(`${input.name} has no readable package.json`);
    }
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      return review(`${input.name}/package.json is not valid JSON: ${String(error)}`);
    }
  }
  const entry = entryPathOf(dir, manifest);
  if (entry === undefined) {
    return review(`${input.name} declares no resolvable entry module`);
  }
  const facts = collectPackageFacts(dir, entry);
  const { imports, providers } = facts;
  // 一个 DSH 包都不导入的插件，就没有符号可验。这时候声明满足就够了——
  // 它跟运行时之间只有 manifest 这一层契约，没有别的可能出错的地方。
  // 一个 DSH 包都不导入的插件，就没有符号可验。它跟运行时之间只有 manifest 这一层契约，
  // 声明对不上也只是这一层的事——把声明对齐过去就能跑，不需要人来点头。
  // 皮肤、纯客户端界面这类插件全是这种。
  if (imports.size === 0) {
    const unmet = Object.keys(input.requirements ?? {});
    return {
      verdict: 'compatible',
      reasons: [unmet.length === 0
        ? `${input.name} imports no @deepseek-ai package, so its manifest declaration is the whole contract, and it holds`
        : `${input.name} imports no @deepseek-ai package; only its manifest declaration needs realigning`],
      missing: [],
      imports: [],
      providers,
    };
  }
  const exportsCache = new Map();
  const exportsOf = async (packageName) => {
    if (exportsCache.has(packageName)) return exportsCache.get(packageName);
    const runtimeEntry = input.runtimeEntryOf?.(packageName);
    const names = runtimeEntry === undefined ? undefined : parseExportedNames(runtimeEntry, readText);
    exportsCache.set(packageName, names);
    return names;
  };
  const audit = input.assumeCompatible === true
    ? { verdict: 'compatible', reasons: ['already aligned for this runtime by a prepared install'], missing: [], conflicts: [] }
    : await auditPluginCompatibility({
    runtimeVersion: input.runtimeVersion,
    requirements: input.requirements,
    imports,
    exportsOf,
    providerIds: providers,
    takenProviders: input.takenProviders ?? [],
  });
  // `importMap` is what the environment builder needs: which symbols to verify
  // 在重定位插件导入之前，先拿每个真实包核一遍。
  return { ...audit, imports: [...imports.keys()], importMap: imports, providers };
}
