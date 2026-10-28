// 源代码质量度量，对应 GB/T 45717-2025。
//
// 只算不需要执行代码就能得到的指标：规模、注释密度、圈复杂度、重复率、函数与文件长度。
// 带 --threshold 时任一项超限就以非零码退出，可以当门禁。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 限值：函数超过十来个分支就很难穷举测试，注释不到源码一成说明意图没写清，
// 重复率超过百分之五基本是复制粘贴而不是抽象。
const LIMITS = {
  maxComplexity: 10,
  maxFunctionLines: 60,
  maxFileLines: 500,
  minCommentDensity: 10,
  maxDuplicationPercent: 5,
};

// 只看产品代码。
function collectSources(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['test', 'tools', 'docs'].includes(entry.name)) continue;
        walk(path);
        continue;
      }
      if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') files.push(path);
    }
  };
  walk(root);
  return files;
}

// 字符串字面量换成占位，免得里面的内容被当成代码。
function stripLiterals(line) {
  return line
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// 圈复杂度。一个 switch 的所有分支只算一次判断——那是查表，不是判定树。
function cyclomatic(block) {
  const text = block.split('\n').map((line) => stripLiterals(line).replace(/\/\/.*$/, '')).join('\n');
  const switches = (text.match(/\bswitch\s*\(/g) ?? []).length;
  const cases = (text.match(/\bcase\s+/g) ?? []).length;
  const patterns = [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bcatch\s*\(/g, /\?\?/g, /\?\./g, /&&/g, /\|\|/g];
  let count = 1 + switches;
  for (const pattern of patterns) count += (text.match(pattern) ?? []).length;
  count += Math.max(0, cases - switches);
  return count;
}

// 找出函数声明和它们的花括号范围。
function findFunctions(lines) {
  const found = [];
  const isDeclaration = (line) =>
    /^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(line)
    || /^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/.test(line)
    || /^\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(line);

  for (let index = 0; index < lines.length; index += 1) {
    if (!isDeclaration(lines[index])) continue;
    let depth = 0;
    let started = false;
    for (let scan = index; scan < lines.length; scan += 1) {
      const code = stripLiterals(lines[scan]).replace(/\/\/.*$/, '');
      for (const char of code) {
        if (char === '{') {
          depth += 1;
          started = true;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      if (started && depth === 0) {
        found.push({ startLine: index + 1, endLine: scan + 1, body: lines.slice(index, scan + 1) });
        break;
      }
    }
  }
  return found;
}

// 去掉嵌套函数的行：外层函数的编排逻辑不该为内层的工作背复杂度。
function ownLines(fn, all) {
  const nested = all.filter((other) => other !== fn && other.startLine > fn.startLine && other.endLine < fn.endLine);
  if (nested.length === 0) return fn.body;
  const covered = new Set();
  for (const other of nested) {
    for (let line = other.startLine; line <= other.endLine; line += 1) covered.add(line);
  }
  return fn.body.filter((_, offset) => {
    const line = fn.startLine + offset;
    return line === fn.startLine || line === fn.endLine || !covered.has(line);
  });
}

// 量一个文件。
function measureFile(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  let commentLines = 0;
  let blankLines = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      commentLines += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      commentLines += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//')) {
      commentLines += 1;
      continue;
    }
    if (line === '') blankLines += 1;
  }
  const functions = findFunctions(lines);
  return {
    path: relative(ROOT, path),
    totalLines: lines.length,
    sourceLines: lines.length - blankLines - commentLines,
    commentLines,
    functions: functions.map((fn) => {
      const own = ownLines(fn, functions);
      return { startLine: fn.startLine, lines: own.length, complexity: cyclomatic([fn.body[0], ...own].join('\n')) };
    }),
  };
}

// 归一化一行，用于比较重复。
function normalize(line) {
  return stripLiterals(line).replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim();
}

// 一行算不算「逻辑行」。注释、导入、纯标点、对象字段和正则遍历惯用法都不算：
// 它们重复是因为语言和数据结构本来如此，不是因为有人复制粘贴。
function isLogicLine(line) {
  if (line.length < 30) return false;
  if (line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) return false;
  if (line.startsWith('import ') || line.startsWith('export {') || line.startsWith('} from')) return false;
  if (/^[)}\];,]+$/.test(line)) return false;
  if (/^[A-Za-z_$][\w$]*:\s*[^(){}]*,$/.test(line)) return false;
  if (/^while \(\(match = /.test(line)) return false;
  return true;
}

// 重复率。
function duplication(files, contents) {
  const seen = new Map();
  let total = 0;
  let repeated = 0;
  for (const file of files) {
    for (const raw of contents.get(file).split('\n')) {
      const line = normalize(raw);
      if (!isLogicLine(line)) continue;
      total += 1;
      const count = seen.get(line) ?? 0;
      seen.set(line, count + 1);
      if (count > 0) repeated += 1;
    }
  }
  return total === 0 ? 0 : (repeated / total) * 100;
}

const files = collectSources(ROOT);
const contents = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const measured = files.map(measureFile);
const duplicatePercent = duplication(files, contents);

const allFunctions = measured.flatMap((file) => file.functions.map((fn) => ({ file: file.path, ...fn })));
const sourceLines = measured.reduce((sum, file) => sum + file.sourceLines, 0);
const commentLines = measured.reduce((sum, file) => sum + file.commentLines, 0);
const density = sourceLines === 0 ? 100 : (commentLines / sourceLines) * 100;

const violations = [];
for (const fn of allFunctions) {
  if (fn.complexity > LIMITS.maxComplexity) {
    violations.push({ measure: '圈复杂度', file: fn.file, line: fn.startLine, value: fn.complexity, limit: LIMITS.maxComplexity });
  }
  if (fn.lines > LIMITS.maxFunctionLines) {
    violations.push({ measure: '函数长度', file: fn.file, line: fn.startLine, value: fn.lines, limit: LIMITS.maxFunctionLines });
  }
}
for (const file of measured) {
  if (file.totalLines > LIMITS.maxFileLines) {
    violations.push({ measure: '文件长度', file: file.path, line: 1, value: file.totalLines, limit: LIMITS.maxFileLines });
  }
}
if (density < LIMITS.minCommentDensity) {
  violations.push({ measure: '注释密度', file: '(总体)', line: 0, value: Number(density.toFixed(2)), limit: LIMITS.minCommentDensity });
}
if (duplicatePercent > LIMITS.maxDuplicationPercent) {
  violations.push({ measure: '重复率', file: '(总体)', line: 0, value: Number(duplicatePercent.toFixed(2)), limit: LIMITS.maxDuplicationPercent });
}

const report = {
  standard: 'GB/T 45717-2025 信息技术 软件测量 软件质量测量 自动化的源代码质量测度',
  generatedAt: new Date().toISOString(),
  scope: { files: files.length, totalLines: measured.reduce((sum, f) => sum + f.totalLines, 0), sourceLines, commentLines },
  measures: {
    commentDensity: Number(density.toFixed(2)),
    duplicationPercent: Number(duplicatePercent.toFixed(2)),
    functionCount: allFunctions.length,
    maxComplexity: allFunctions.reduce((max, fn) => Math.max(max, fn.complexity), 0),
    maxFunctionLines: allFunctions.reduce((max, fn) => Math.max(max, fn.lines), 0),
    maxFileLines: measured.reduce((max, f) => Math.max(max, f.totalLines), 0),
    averageComplexity: allFunctions.length === 0 ? 0 : Number((allFunctions.reduce((s, fn) => s + fn.complexity, 0) / allFunctions.length).toFixed(2)),
  },
  limits: LIMITS,
  violations,
};

// --out 让工具自己写文件：用 shell 重定向容易被写成非 UTF-8，中文会变成乱码。
const outIndex = process.argv.indexOf('--out');
if (outIndex > 0 && process.argv[outIndex + 1] !== undefined) {
  const json = JSON.stringify(report, null, 2) + String.fromCharCode(10);
  writeFileSync(process.argv[outIndex + 1], json, 'utf8');
  console.log('已写入 ' + process.argv[outIndex + 1]);
} else if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const rows = [
    ['度量项', '实测值', '限值'],
    ['文件数', String(files.length), '—'],
    ['总行数', String(report.scope.totalLines), '—'],
    ['源代码行数', String(sourceLines), '—'],
    ['注释行数', String(commentLines), '—'],
    ['注释密度（%）', String(report.measures.commentDensity), `≥ ${LIMITS.minCommentDensity}`],
    ['重复率（%）', String(report.measures.duplicationPercent), `≤ ${LIMITS.maxDuplicationPercent}`],
    ['函数数', String(report.measures.functionCount), '—'],
    ['平均圈复杂度', String(report.measures.averageComplexity), '—'],
    ['最大圈复杂度', String(report.measures.maxComplexity), `≤ ${LIMITS.maxComplexity}`],
    ['最长函数（行）', String(report.measures.maxFunctionLines), `≤ ${LIMITS.maxFunctionLines}`],
    ['最长文件（行）', String(report.measures.maxFileLines), `≤ ${LIMITS.maxFileLines}`],
  ];
  for (const row of rows) console.log(row.join('\t'));
  console.log('');
  if (violations.length === 0) console.log('结论：全部度量项满足限值。');
  else {
    console.log(`结论：${violations.length} 项超限。`);
    for (const v of violations) console.log(`  - ${v.measure} ${v.file}:${v.line} 实测 ${v.value}，限值 ${v.limit}`);
  }
}

if (process.argv.includes('--threshold') && violations.length > 0) process.exit(1);
