// 版本号解析、比较，以及判断某个版本是否满足 manifest 里写的范围。
//
// 自己实现而不是引依赖：本插件要在没装任何额外包的 profile 里也能跑，而 DSH manifest
// 用到的语法其实不多，正好可以全测到。
/** 解析 major.minor.patch[-prerelease][+build]。 */
export function parseSemver(text) {
  if (typeof text !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
    raw: text.trim(),
  };
}

// 按 SemVer 规范第 11 条比预发布标识：数字段按数值比，字母段按字典序比，
// 数字段永远小于字母段，短的排在长的前面。
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版比它的任何预发布都大
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** 比较两个已解析的版本，返回 -1 / 0 / 1。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

// 把范围拆成若干组比较项。用 || 分隔的每一组都要单独满足。
function comparatorTerms(range) {
  return String(range)
    .split('||')
    .map((alternative) => alternative.trim().split(/\s+/).filter((term) => term !== ''));
}

// 判断单个比较项，比如 ">=1.2.3" 或 "^0.2.1"。
function termSatisfied(version, term) {
  const operator = /^(>=|<=|>|<|=|\^|~)?/.exec(term)?.[1] ?? '';
  const body = term.slice(operator.length);
  if (body === '' || body === '*' || body === 'x' || body === 'X') return true;
  const parsed = parseSemver(body.replace(/\.(?:x|X|\*)$/, '.0'));
  if (parsed === undefined) return undefined; // 解析不了，交给调用方决定
  const order = compareVersions(version, parsed);
  return compareByOperator(operator, order, version, parsed);
}

// 从 termSatisfied 里拆出来的，专门处理各个比较符。
// 一开始全塞在一起的时候，^ 和 ~ 的边界规则读起来像一堆嵌套 if。
function compareByOperator(operator, order, version, parsed) {
  const simple = {
    '': order === 0,
    '=': order === 0,
    '>': order > 0,
    '>=': order >= 0,
    '<': order < 0,
    '<=': order <= 0,
  };
  if (Object.hasOwn(simple, operator)) return simple[operator];
  if (operator === '^') return satisfiesCaret(version, parsed, order);
  if (operator === '~') return satisfiesTilde(version, parsed, order);
  return undefined;
}

// ^1.2.3 的意思是最左边那个非零位锁住：1.x 都行，0.2.x 只到 0.2，0.0.x 就只能 0.0.x。
function satisfiesCaret(version, parsed, order) {
  if (order < 0) return false;
  if (parsed.major > 0) return version.major === parsed.major;
  if (parsed.minor > 0) return version.major === 0 && version.minor === parsed.minor;
  return version.major === 0 && version.minor === 0 && version.patch === parsed.patch;
}

// ~1.2.3 是主次版本钉死，补丁位往上都行。
function satisfiesTilde(version, parsed, order) {
  return order >= 0 && version.major === parsed.major && version.minor === parsed.minor;
}

// 判断版本满不满足范围。返回 true/false；范围本身解析不了就返回 undefined
// （workspace: 协议、git tag、写坏的字符串都会走这条路），由调用方自己拿主意。
// 预发布版本能不能落进这个范围。
//
// 这是 semver 里最容易被忽略的一条：预发布版本只对它自己那一组 major.minor.patch 的
// 比较符有效。所以 0.2.1-rc.3 不满足 ">=0.2.0-rc.2 <0.3.0-0"——那组的预发布是
// 0.2.0 和 0.3.0，跟它不同组。不按这条判，会把运行时明确拒绝的版本当成满足，
// 于是插件永远显示成「已经没问题」，实际根本加载不了。
function prereleaseAllowed(parsed, terms) {
  if (parsed.prerelease.length === 0) return true;
  return terms.some((term) => {
    const body = term.replace(/^(?:>=|<=|>|<|=|\^|~)/, '');
    // 通配符没有具体版本可比，对预发布一视同仁。
    if (body === '' || body === '*' || body === 'x' || body === 'X') return true;
    const candidate = parseSemver(body.replace(/\.(?:x|X|\*)$/, '.0'));
    if (candidate === undefined || candidate.prerelease.length === 0) return false;
    return candidate.major === parsed.major
      && candidate.minor === parsed.minor
      && candidate.patch === parsed.patch;
  });
}

export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseSemver(version) : version;
  if (parsed === undefined) return undefined;
  if (typeof range !== 'string' || range.trim() === '') return undefined;
  const groups = comparatorTerms(range);
  let answered = false;
  for (const terms of groups) {
    let all = true;
    for (const term of terms) {
      const result = termSatisfied(parsed, term);
      if (result === undefined) continue;
      answered = true;
      if (!result) {
        all = false;
        break;
      }
    }
    if (all && answered) return prereleaseAllowed(parsed, terms);
  }
  return answered ? false : undefined;
}

// 估算声明的版本要求跟当前运行时差多远。用来区分"差不多能用"和"差了一个大版本"，
// 前者值得自动适配，后者得让人看一眼。
export function classifyDistance(declaredRange, runtimeVersion) {
  const satisfied = satisfies(runtimeVersion, declaredRange);
  if (satisfied === true) return 'satisfied';
  if (satisfied === undefined) return 'unknown';
  const runtime = parseSemver(runtimeVersion);
  const floor = typeof declaredRange === 'string'
    ? parseSemver(String(declaredRange).replace(/^[\^~>=<\s]+/, '').split(/\s+/)[0])
    : undefined;
  if (runtime === undefined || floor === undefined) return 'unknown';
  if (runtime.major !== floor.major) return 'major-delta';
  if (runtime.minor !== floor.minor) return 'minor-delta';
  if (runtime.patch !== floor.patch) return 'patch-delta';
  return 'prerelease-delta';
}
