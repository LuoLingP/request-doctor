// 验证兼容环境真的能把插件要的东西交出来。
//
// 建完环境就假定成功是不够的：垫片写错一个导出名、目标文件读不出来，插件在加载那一刻
// 就会崩，而修复流程还以为自己干得不错。这里把「插件要的每个符号，环境是否真能提供」
// 逐条核对一遍，让问题在修复阶段暴露，而不是甩给用户。
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareNameOf, parseExportedNames } from './compat.js';

// 一个插件图里最多缓存这么多个包的结果。运行时包不小，每次扫描都重新解析太费。
const MAX_CACHE = 256;

// 缓存键带文件签名，改动自然失效。键算错不会导致误判——只是多解析一次。
const cache = new Map();

// 文件签名，读不到用固定占位（表示"读不到"本身也是一种稳定状态）。
function signatureOf(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'unreadable';
  }
}

// 从垫片里取出 `export * from "..."` / `export { ... } from "..."` 指向的 URL。
//
// 这里保留 URL 而不是立刻转成路径：转路径在有些平台上会失败（比如没有盘符的 Windows
// 路径），那不代表垫片有问题，只说明这次核对不了。把"转换失败"和"没有目标"分开，
// 才不会把能正常跑的环境误判成坏的。
function targetUrlsOf(source) {
  const urls = [];
  const pattern = /\bfrom\s+"(file:[^"]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) urls.push(match[1]);
  return urls;
}

// 读一个文件，读不到就返回 undefined。
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}



// 一个包的环境能否满足它需要的符号。
//
// 三种结果：provided（能提供）、missing（能读到目标但确实没有）、unverifiable（目标读不到，
// 无从判断）。最后一种不算失败——运行时包常常装在归档里，普通读文件读不到是正常的。
export function verifyPackage(pluginDir, name, symbols) {
  const shimPath = join(pluginDir, 'node_modules', ...name.split('/'), 'index.js');
  const shimSource = readText(shimPath);
  if (shimSource === undefined) return { status: 'missing', detail: '没有垫片' };

  // 垫片本身和它的目标都参与签名。这样运行时升级、垫片被改写都会自然失效，
  // 而重复扫描同一个环境时不必再解析那个几百 KB 的运行时包。
  const targets = targetUrlsOf(shimSource);
  const targetPaths = targets.map((url) => {
    try {
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  });
  const key = [shimPath, signatureOf(shimPath), ...targetPaths.map((path) => (path === undefined ? 'bad-url' : signatureOf(path)))].join('|');

  const cached = cache.get(shimPath);
  if (cached !== undefined && cached.key === key) return judge(cached.info, symbols);

  const info = describeEnvironment(shimPath, shimSource, targetPaths);
  if (cache.size >= MAX_CACHE && !cache.has(shimPath)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(shimPath, { key, info });
  return judge(info, symbols);
}

// 把一个环境能提供的符号收齐。
//
// 有些包是 CommonJS 的（schemastery 就是），读不出 ESM 的导出清单。这时候退回按词边界
// 搜源码——建环境那一侧本来就是这么做的，两边必须一致，否则一边说齐了、另一边说缺了，
// 插件就会在「修好了」和「没修好」之间来回跳。
function describeEnvironment(shimPath, shimSource, targetPaths) {
  const shimNames = parseExportedNames(shimPath, (source) => readFileSync(source, 'utf8')) ?? [];
  const targetNames = [];
  const needles = [];
  let readableTargets = 0;
  for (const path of targetPaths) {
    if (path === undefined) continue;
    const source = readText(path);
    if (source === undefined) continue;
    readableTargets += 1;
    const names = parseExportedNames(path, (file) => readFileSync(file, 'utf8'));
    // 空清单同样不可信：CommonJS 包读出来就是空的。
    if (names === undefined || names.length === 0) needles.push(source);
    else targetNames.push(...names);
  }
  return { shimNames, targetNames, needles, readableTargets, hasTargets: targetPaths.length > 0 };
}

// 一个符号在环境里到底有没有。名字对不上时退回搜源码。
function provides(info, symbol) {
  if (info.shimNames.includes(symbol) || info.targetNames.includes(symbol)) return true;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('\\b' + escaped + '\\b');
  return info.needles.some((source) => pattern.test(source));
}

// 拿插件要的符号去对照环境能提供的，给出结论。
function judge(info, symbols) {
  const lacking = symbols.filter((symbol) => {
    // default 必须由垫片自己写出来：`export *` 从不转发默认导出，
    // 目标有 default 不等于插件拿得到。
    if (symbol === 'default') return !info.shimNames.includes('default');
    return !provides(info, symbol);
  });

  if (lacking.length === 0) return { status: 'provided' };
  // 垫片指着的东西一个都读不到，这个环境是坏的：插件加载时自己也要读那些文件，
  // 读不到就会崩。所以这里不能当「无法核对」放过去，要如实算作问题。
  if (info.readableTargets === 0 && info.hasTargets) {
    return { status: 'missing', detail: '垫片指向的文件一个都读不到，环境不可用' };
  }
  return { status: 'missing', detail: `缺 ${lacking.join(', ')}` };
}

// 核对整个环境。
//
// @param {object} input
// @param {string} input.pluginDir - 插件目录。
// @param {Map<string,string[]>} input.imports - 插件导入的包与符号。
// @returns {{ok: boolean, problems: object[], unverified: object[]}}
export function verifyEnvironment(input) {
  const problems = [];
  const unverified = [];
  // 同一个包可能既从包根、也从子路径被导入。垫片只有一个，所以要按裸包名归组，
  // 把两处的符号合起来核对，否则子路径那条会被当成一个没有垫片的包。
  const groups = new Map();
  for (const [specifier, symbols] of input.imports ?? new Map()) {
    if (!specifier.startsWith('@deepseek-ai/')) continue;
    const name = bareNameOf(specifier);
    if (groups.has(name) === false) groups.set(name, new Set());
    const set = groups.get(name);
    for (const symbol of symbols ?? []) set.add(symbol);
  }

  for (const [name, symbols] of groups) {
    if (symbols.size === 0) continue;
    const result = verifyPackage(input.pluginDir, name, [...symbols]);
    if (result.status === 'missing') problems.push({ name, detail: result.detail });
    else if (result.status === 'unverifiable') unverified.push({ name, detail: result.detail });
  }
  return { ok: problems.length === 0, problems, unverified };
}
