// 决定去试哪些版本。
//
// 只钉一个版本是不够的：插件声明的范围可能覆盖好几个版本，而它要的那个符号未必在
// 范围里最新的那个。既然旧代码都还在仓库里，就按顺序挨个试，第一个能凑齐符号的就是答案。
import { compareVersions, satisfies } from './semver.js';

// 一次最多试这么多个版本。够用，也不至于把注册表打爆。
const MAX_CANDIDATES = 8;

// 从旧到新排好序，再去掉重复。
//
// 注册表里偶尔有无法解析的版本号。排序不能因此整个垮掉——那会让搜索直接失效，
// 所以解析不了的一律当作「最旧」，排在后面。
// 比较两个版本号，解析不了就当作相等——排序不能因为一个坏版本号整个垮掉。
export function safeCompare(a, b) {
  try {
    return compareVersions(a, b) ?? 0;
  } catch {
    return 0;
  }
}

// 从旧到新排好序，再去掉重复。
function sorted(versions) {
  return [...new Set(versions)].filter((version) => typeof version === 'string' && version !== '').sort(safeCompare).reverse();
}

// 排出候选顺序。
//
// 优先级：声明范围里最新的 → 其余版本最新的。范围是第一顺位，因为那是插件自己说过的
// 「我认这些」；范围里都没有才退而求其次，毕竟能跑起来比守着声明重要。
export function orderCandidates(versions, requirement, preferred) {
  const all = sorted(versions);
  const inRange = typeof requirement === 'string' ? all.filter((version) => satisfies(version, requirement) === true) : [];
  const ordered = [];
  const push = (version) => {
    if (typeof version === 'string' && version !== '' && !ordered.includes(version)) ordered.push(version);
  };

  push(preferred);
  for (const version of inRange) push(version);
  for (const version of all) push(version);
  return ordered.slice(0, MAX_CANDIDATES);
}
