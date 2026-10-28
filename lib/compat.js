// 判断一个声明的 DSH 依赖与当前运行时对不上的插件，到底能不能真的跑起来。
//
// 版本不匹配只是"可能不能用"的说法，不是"一定不能用"的证据。这里查两件真正决定
// 兼容性的事：
//
//  1. 声明的要求离当前版本有多远。差一个预发布号和一个大版本完全不是一回事。
//  2. API 表面。插件从 DSH 包里导入的每个符号，在现行运行时里是否还导出。
//     对得上就说明能跑，缺一个就说明跑不了——这跟 manifest 怎么写没关系。
//
// 结论决定后续动作：compatible 才会被自动适配，其余一律只报告。
import { classifyDistance, satisfies } from './semver.js';

// 收集一个模块从 @deepseek-ai/* 具名导入的符号。
//
// 只认具名导入：这是插件和运行时之间的编译期契约。默认导入没有符号名可验，
// 只按"依赖了这个包"记账。
export function collectDshImports(source) {
  const found = new Map();
  const pattern = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*["'](@deepseek-ai\/[^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, defaultBinding, braces, packageName] = match;
    const symbols = found.get(packageName) ?? [];
    if (braces !== undefined && braces.trim() !== '') {
      for (const part of braces.split(',')) {
        const piece = part.trim();
        if (piece === '') continue;
        // import { original as local } 这种写法，运行时必须导出 original
        const imported = /^([A-Za-z_$][\w$]*|"[^"]+"|\$)\s+as\s+[A-Za-z_$][\w$]*$/.exec(piece);
        if (imported !== null) {
          symbols.push(imported[1].replace(/^"|"$/g, ''));
          continue;
        }
        const plain = /^([A-Za-z_$][\w$]*|\$)$/.exec(piece);
        if (plain !== null) symbols.push(plain[1]);
      }
    }
    if (defaultBinding !== undefined) symbols.push('default');
    found.set(packageName, [...new Set(symbols)]);
  }
  return found;
}

// 去掉子路径，留下裸包名。`@scope/pkg/sub` 取 `@scope/pkg`，`pkg/sub` 取 `pkg`。
//
// 插件经常从子路径导入（`pkg/lib/extra.js`）。子路径不是独立的包，凡是要按包处理的
// 地方都得先过这一道，否则会去一个不存在的位置找 package.json。
export function bareNameOf(specifier) {
  const parts = String(specifier).split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// 这个缺失的符号能不能靠装旧版本解决。
//
// 依据只有一条：插件声明了对这个包的依赖范围，而范围指向的版本不是当前运行时。
// 那种情况旧版本还在仓库里，取下来就有的救。声明就是当前版本、或者压根没声明，
// 说明插件本来就不该指望旧东西，如实判为不兼容。
function canUseOlderVersion(entry, input) {
  const packageName = entry.split(':')[0];
  const declared = input.requirements?.[packageName];
  if (typeof declared !== 'string') return false;
  const pinned = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(declared)?.[0];
  if (pinned === undefined) return false;
  return pinned !== input.runtimeVersion;
}
// 收集一个模块注册的 LLM provider 路由。
//
// 注册了别人已经在提供的 provider 时插件根本起不来（registerAdapter 抛
// DUPLICATE_ADAPTER），而这跟 manifest 里的 peer 范围毫无关系，所以审计必须单独查。
//
// 认得几种常见写法：registerAdapter(['a'], ...)、registerAdapter([PROVIDER], ...)
// （PROVIDER 是本地字符串常量），以及适配器描述对象的 providerId 字段。
export function collectProviderIds(source) {
  const ids = new Set();
  // 先把本地字符串常量收起来，这样 [PROVIDER] 才解得出来
  const constants = new Map();
  const constPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"'\n]{1,80})["']/g;
  let match;
  while ((match = constPattern.exec(source)) !== null) constants.set(match[1], match[2]);

  const resolveTerm = (raw) => {
    const term = raw.trim();
    if (term === '') return undefined;
    const literal = /^["']([^"'\n]{1,80})["']$/.exec(term);
    if (literal !== null) return literal[1];
    const identifier = /^([A-Za-z_$][\w$]*)$/.exec(term);
    if (identifier !== null) return constants.get(identifier[1]);
    return undefined;
  };

  const callPattern = /registerAdapter\s*\(\s*\[([^\]]*)\]/g;
  while ((match = callPattern.exec(source)) !== null) {
    for (const part of match[1].split(',')) {
      const id = resolveTerm(part);
      if (id !== undefined) ids.add(id);
    }
  }
  const providerField = /\bproviderId\s*:\s*([^,\n}]+)/g;
  while ((match = providerField.exec(source)) !== null) {
    const id = resolveTerm(match[1]);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

// 插件是否通过 [variant.id] 这种变体对象注册路由。
//
// 打包的插件经常这么写，而 variant 来自另一个 chunk 里的共享表，所以这条语句本身
// 看不到具体 id。那就把这个插件模块图里所有 id 字面量都算进来——宁可多报，
// 因为其中任何一个都可能是真正注册的那条路由。
export function registersVariantRoute(source) {
  return /registerAdapter\s*\(\s*\[\s*[A-Za-z_$][\w$]*\.id\s*\]/.test(source);
}

// 找出一个模块里的变体 id 字面量，用来还原 [variant.id] 那种路由。
//
// 靠"形状"认：一个 id 旁边同时有 displayName 和 region。同一份文件里往往还打包了
// 模型清单，那些条目没有 region，靠这一条就能排掉——否则结果会混进几十个模型 id，
// 把不相关的插件也判成冲突。
export function collectIdLiterals(source) {
  const ids = new Set();
  const pattern = /\bid\s*:\s*["']([^"'\n]{1,80})["'][\s\S]{0,600}?\bregion\s*:\s*["'][^"'\n]*["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) ids.add(match[1]);
  return [...ids];
}

// 找出 manifest 里声明了、但当前运行时不满足的那些 DSH 要求。
//
// 跟 DSH 自己的规则保持一致：有 engines.dsh 就只看它，否则每个 @deepseek-ai/dsh*
// peer 都算数。之所以自己算一遍，是因为 Loader 只报告它拒绝掉的包，已经加载着的
// 就算不匹配也不会出现在拒绝列表里。
export function unmetPeers(manifest, runtimeVersion) {
  const unmet = {};
  const engines = manifest?.engines;
  if (engines !== null && typeof engines === 'object' && typeof engines.dsh === 'string') {
    if (satisfies(runtimeVersion, engines.dsh) !== true) unmet['engines.dsh'] = engines.dsh;
    return unmet;
  }
  const peers = manifest?.peerDependencies;
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return unmet;
  for (const [name, range] of Object.entries(peers)) {
    // 只比运行时自己发布的那几个。schemastery 的 ^3.18.5、cordis 的 ^4.0.2
    // 是它们自己的版本线，拿去跟 DSH 版本比毫无意义。
    if (!/^@deepseek-ai\/dsh(?:[-/]|$)/.test(name) || typeof range !== 'string') continue;
    const workspace = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range);
    if (satisfies(runtimeVersion, workspace ? runtimeVersion : range) !== true) unmet[name] = range;
  }
  return unmet;
}


// 不执行被测包，只把它的导出名读出来。
//
// DSH 自带的包都是单文件 ESM 构建，最后一句就是 export { a, b as c, ... }。
// 解析这份清单就足够回答"运行时还导不导出插件要的东西"，而完全不需要把包跑起来。
export function parseExportedNames(entryPath, readText) {
  let source;
  try {
    source = readText(entryPath);
  } catch {
    return undefined;
  }
  const names = new Set();
  for (const name of namedExports(source)) names.add(name);
  for (const name of inlineExports(source)) names.add(name);
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  return names.size === 0 ? undefined : [...names];
}

// 从 export { a, b as c } 这种语句里读导出名。
function namedExports(source) {
  const found = [];
  const pattern = /\bexport\s*\{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    for (const part of match[1].split(',')) {
      const name = exportedNameOf(part.trim());
      if (name !== undefined) found.push(name);
    }
  }
  return found;
}

// 把清单里的一项换算成导入方实际拿到的名字。
function exportedNameOf(piece) {
  if (piece === '') return undefined;
  // original as exported 时，别人用的是 exported 这个名字
  const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece);
  if (alias !== null) return alias[1];
  const direct = /^([A-Za-z_$][\w$]*)$/.exec(piece);
  return direct === null ? undefined : direct[1];
}

// 从 export function / class / const / let / var 这种行内声明里读导出名。
function inlineExports(source) {
  const pattern = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const found = [];
  let match;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

// 逐条记下声明跟当前运行时差多远，取最坏的那一档。
//
// 单独拎出来是因为它只是一段记账：读声明、比距离、把结果攒进 reasons。
// 留在主流程里会把结论判断淹掉。
function describeDistances(input, reasons) {
  const distances = {};
  let worst = 'satisfied';
  const order = ['satisfied', 'prerelease-delta', 'patch-delta', 'minor-delta', 'major-delta', 'unknown'];
  for (const [requirement, declaredRange] of Object.entries(input.requirements ?? {})) {
    const distance = classifyDistance(declaredRange, input.runtimeVersion);
    distances[requirement] = distance;
    if (order.indexOf(distance) > order.indexOf(worst)) worst = distance;
    reasons.push(`${requirement} declares ${declaredRange}; running ${input.runtimeVersion} (${distance})`);
  }
  return { distances, worst };
}

// 判断某个插件在版本对不上的情况下能否真的在当前运行时跑起来。
//
// 结论是要担责任的，不是盖章：compatible 要求版本距离够近**并且**插件导入的每个
// DSH 符号都还在。任何没被证实的都返回 review，调用方不许拿它去自动适配。
export async function auditPluginCompatibility(input) {
  const reasons = [];
  const missing = [];
  const { distances, worst } = describeDistances(input, reasons);

  // 别的已启用插件已经在提供的路由，不管版本范围多接近，激活时都会失败。
  // 这是激活层面的问题，不是版本兼容问题，所以单独记一笔，不影响版本结论。
  // 真正让插件跑起来的是兼容环境和路由仲裁这两件事。
      const taken = new Set(input.takenProviders ?? []);
  const conflicts = (input.providerIds ?? []).filter((id) => taken.has(id));
  if (conflicts.length > 0) {
    reasons.push(`it registers the LLM provider ${conflicts.join(', ')}, which another enabled plugin already serves (DUPLICATE_ADAPTER)`);
  }

  if (worst === 'major-delta') {
    // 跨大版本仍然要试。声明会被对齐到当前运行时，插件实际用的是这里的实现，
    // 用到哪个符号、还在不在，下面的 API 表面检查会一并回答。
    reasons.push('a major-version gap; the declaration will be realigned and the API surface checked');
  }
  // 版本距离比不出来时，只有两种情况才拦下来。
  // 一是运行时版本本身就没拿到——那说明环境有问题，什么判断都不作数。
  // 二是导入的符号对不上——那是真跑不了。
  // 只是写法怪（workspace: 协议、tag 之类）导致比不了，不该一概拒绝。
  if (worst === 'unknown') {
    if (input.runtimeVersion === undefined || input.runtimeVersion === '') {
      return {
        verdict: 'review',
        reasons: [...reasons, 'the running DSH version is unknown, so nothing can be verified'],
        distances,
        missing,
        conflicts,
      };
    }
    reasons.push('the declared range cannot be compared with the running version; relying on the import surface instead');
  }

  // 光看距离不足以放行，API 表面也必须对得上。
  // 只有 DSH 的包构成运行时契约。第三方依赖（schemastery、react 之类）
  // 是插件自己的事，不去查。
  const imports = input.imports instanceof Map ? input.imports : new Map(Object.entries(input.imports ?? {}));
  const checked = [];
  const unverified = [];
  if (typeof input.exportsOf === 'function') {
    for (const [packageName, symbols] of imports) {
      if (!/^@deepseek-ai\/[a-z]/.test(packageName)) continue;
      let names;
      try {
        names = await input.exportsOf(packageName);
      } catch (error) {
        reasons.push(`${packageName} could not be read: ${String(error)}`);
        return { verdict: 'review', reasons, distances, missing, conflicts };
      }
      if (names === undefined) {
        // 这里解析不到这个包，所以它的表面无从证实。
        unverified.push(packageName);
        continue;
      }
      checked.push(packageName);
      for (const symbol of symbols ?? []) {
        if (!names.includes(symbol)) missing.push(`${packageName}:${symbol}`);
      }
    }
  }

  if (missing.length > 0) {
    // 当前实现没有这些符号，但插件当初对着写的那个版本里可能有——
    // 那个版本的代码还在仓库里，取下来装上就行。所以只有「连旧版本都无从获取」才算真不兼容：
    // 插件没声明对应的依赖范围，或者声明就是当前版本。
    const recoverable = missing.every((entry) => canUseOlderVersion(entry, input));
    if (recoverable) {
      return {
        verdict: 'compatible',
        reasons: [...reasons, `the running runtime lacks ${missing.join(', ')}; the plugin own older version will be installed instead`],
        distances,
        missing: [],
        conflicts,
      };
    }
    return {
      verdict: 'incompatible',
      reasons: [...reasons, `the running runtime no longer exports ${missing.join(', ')}`],
      distances,
      missing,
      conflicts,
    };
  }
  if (unverified.length > 0) {
    return {
      verdict: 'review',
      reasons: [...reasons, `could not read the running ${unverified.join(', ')} to verify the plugin's imports`],
      distances,
      missing,
      conflicts,
    };
  }
  if (checked.length > 0) reasons.push(`API surface verified against ${[...new Set(checked)].join(', ')}`);
  else if (imports.size > 0) reasons.push('the plugin imports no DSH package that could be verified');

  // 声明距离只是提示。能不能跑由上面查过的导入表面决定——对齐声明是适配的一部分，
  // 不是需要人来点头的事。
  if (worst === 'unknown' && (input.runtimeVersion === undefined || input.runtimeVersion === '')) {
    return { verdict: 'review', reasons, distances, missing, conflicts };
  }
  return { verdict: 'compatible', reasons, distances, missing, conflicts };
}

// 顺手重导出，老代码里从 compat.js 拿这些函数的写法还能用。
export { classifyDistance, compareVersions, parseSemver, satisfies } from './semver.js';
