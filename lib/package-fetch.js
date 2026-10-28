// 从 npm 取一个指定版本的包，解到本地。
//
// 兼容模式要真的把旧实现放回去，而不是假装。插件当初是对着某个版本写的，
// 那个版本的代码还在仓库里，取下来装上就行——这才是「给它一个能跑的旧环境」。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 20000;

// 元数据留一会儿。一次扫描里同一个包会被问好几遍（取地址、列版本），
// 每次都打注册表既慢又没礼貌。
const META_TTL_MS = 10 * 60 * 1000;
const metaCache = new Map();

// 取包的元数据，带缓存。
async function metadataOf(name) {
  const cached = metaCache.get(name);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < META_TTL_MS) return cached.value;

  const response = await fetch(`${REGISTRY}/${encodedName(name)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return undefined;
  const value = await response.json();
  metaCache.set(name, { at: now, value });
  return value;
}

// scoped 包的路径要编码成 %2F，否则注册表会当成两个路径段。
const encodedName = (name) => name.replace('/', '%2F');

// 取元数据，拿到指定版本的 tarball 地址。
async function tarballUrlOf(name, version) {
  const meta = await metadataOf(name);
  const url = meta?.versions?.[version]?.dist?.tarball;
  return typeof url === 'string' ? url : undefined;
}

// 列出注册表里所有已发布的版本。
//
// 缺符号时要挨个试，所以得先知道有哪些版本可选。取不到就返回空数组，
// 调用方据此退回「只试钉住的那个版本」。
export async function listVersions(name) {
  try {
    const meta = await metadataOf(name);
    return Object.keys(meta?.versions ?? {});
  } catch {
    return [];
  }
}

// 读 tar 头里的字符串字段，遇 NUL 截断。
function readString(block, offset, length) {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  return block.subarray(offset, end).toString('utf8');
}

// 读八进制数字字段，空值按 0 处理。
function readOctal(block, offset, length) {
  const text = readString(block, offset, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

// 解 PAX 扩展头。`path=` 那一行给出下一个条目的真实路径，长文件名靠它。
function paxPathOf(buffer) {
  const text = buffer.toString('utf8');
  for (const line of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match !== null) return match[1];
  }
  return undefined;
}

// 解 tar。npm 的包是 gzip 压缩的 tar，里面统一带一层 `package/` 前缀。
//
// 两种长文件名写法都要认：GNU 用一个独立的 `L` 条目把名字放在数据区，PAX 用 `x` 条目里的
// `path=`。不认的话，路径超过一百字节的文件会被截断或丢掉——装出来的包看着完整，
// 加载时却报「找不到某个文件」，而且很难看出问题出在解包这一步。
function extractTar(buffer, destDir) {
  let offset = 0;
  let pendingName;
  // npm 的包里所有条目都在同一层根目录下，但那个目录叫什么并不固定：
  // 常见是 `package/`，也有用 `<repo>-<commit>/` 的。按实际首段剥掉，别写死。
  let rootPrefix;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const type = readString(header, 156, 1) || '0';
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);

    pendingName = nameFromHeaderRecord(type, data, pendingName);
    if (isMetaRecord(type) === false) {
      const declared = pendingName ?? (prefix === '' ? name : `${prefix}/${name}`);
      pendingName = undefined;
      rootPrefix = rootPrefix ?? rootPrefixOf(type, declared);
      writeMember(destDir, stripRoot(declared, rootPrefix), type, data);
    }

    // 数据区按 512 向上取整。
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

// 名字单独占一条记录的两种写法：GNU 的 L 和 PAX 的 x。全局头 g 跟名字无关。
const META_RECORDS = new Set(['L', 'x', 'g']);

function isMetaRecord(type) {
  return META_RECORDS.has(type);
}

// 元数据记录里带着下一个条目的真实路径，记下来交给下一条用。
function nameFromHeaderRecord(type, data, previous) {
  if (type === 'L') return data.toString('utf8').replace(/\0+$/, '');
  if (type === 'x') return paxPathOf(data) ?? previous;
  return previous;
}

// 包的根目录只在第一个目录条目上取一次，之后一直用它。
function rootPrefixOf(type, declared) {
  if (type !== '5' || !declared.includes('/')) return undefined;
  return declared.replace(/\/+$/, '');
}

// 落一个文件。目录、空路径、越界路径都不写。
function writeMember(destDir, relative, type, data) {
  if (relative === '' || type !== '0') return;
  const target = join(destDir, ...relative.split('/'));
  // 防目录穿越：解出来的路径必须还在目标目录里。
  // 比较前统一分隔符——join 在 Windows 上给的是反斜杠。
  if (!resolve(target).startsWith(resolve(destDir) + sep)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

// 剥掉包的根目录，留下包内的相对路径。
//
// 根目录还没认出来时按第一段剥——tar 里第一个文件条目总在根目录下。
function stripRoot(declared, rootPrefix) {
  if (rootPrefix !== undefined) {
    if (!declared.startsWith(`${rootPrefix}/`)) return '';
    return declared.slice(rootPrefix.length + 1);
  }
  const cut = declared.indexOf('/');
  return cut < 0 ? declared : declared.slice(cut + 1);
}

// 解一段已经拿到手的 tar 数据。抽出来单测用，也方便别处复用。
export function readPackageFromTar(buffer, destDir) {
  extractTar(buffer, destDir);
}

// 把 name@version 完整取下来解到 destDir。
//
// @param {string} name - 包名。
// @param {string} version - 精确版本号。
// @param {string} destDir - 解压目标目录。
// @returns {Promise<{ok: boolean, error?: string}>}
export async function fetchPackage(name, version, destDir) {
  try {
    const url = await tarballUrlOf(name, version);
    if (url === undefined) return { ok: false, error: `${name}@${version} 在注册表里找不到` };

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, error: `下载 ${name}@${version} 失败：HTTP ${response.status}` };

    const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
    mkdirSync(destDir, { recursive: true });
    extractTar(tar, destDir);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
