/**
 * 从旧符号名猜它在新版本里叫什么。
 *
 * 老插件引用的名字消失时，绝大多数情况不是功能没了，而是被改名或者挪了位置。
 * 这里按几种常见的改名规律去猜，猜中就当成别名接上，猜不中再报缺。
 *
 * @param {string} symbol - 插件要的符号名。
 * @param {string[]} available - 当前运行时实际导出的名字。
 * @returns {string|undefined} 猜到的名字，猜不到就 undefined。
 */
export function guessRenamedSymbol(symbol, available) {
  if (!Array.isArray(available) || available.length === 0) return undefined;

  const lower = symbol.toLowerCase();
  const matches = (candidate) => candidate.toLowerCase() === lower;
  const direct = available.find(matches);
  if (direct !== undefined) return direct;

  // 去掉常见前缀再比：getXxx / useXxx / createXxx 这类包装。
  const stripped = symbol.replace(/^(get|use|create|make|build|resolve|load|read|parse)/, '');
  if (stripped !== '' && stripped !== symbol) {
    const byStripped = available.find((candidate) => candidate.toLowerCase() === stripped.toLowerCase());
    if (byStripped !== undefined) return byStripped;
  }

  // 反向：给新名字加上同样的前缀。
  const prefixed = /^(get|use|create|make|build|resolve|load|read|parse)/.exec(symbol)?.[1];
  if (prefixed !== undefined) {
    const withPrefix = available.find((candidate) => candidate === `${prefixed}${symbol.slice(prefixed.length)}`);
    if (withPrefix !== undefined) return withPrefix;
  }

  // 单复数差异，比如 homePaths / homePath。
  const singular = symbol.endsWith('s') ? symbol.slice(0, -1) : `${symbol}s`;
  const byPlural = available.find((candidate) => candidate.toLowerCase() === singular.toLowerCase());
  if (byPlural !== undefined) return byPlural;

  // 只差大小写或者下划线，比如 home_paths / homePaths。
  const normalized = (text) => text.replace(/[_-]/g, '').toLowerCase();
  const byShape = available.find((candidate) => normalized(candidate) === normalized(symbol));
  if (byShape !== undefined) return byShape;

  return undefined;
}
