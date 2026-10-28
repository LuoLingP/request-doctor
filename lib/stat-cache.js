// manifest 和模块图的缓存。
//
// 一次扫描要摸遍所有插件，后台轮询还会定期重来；但 manifest 和源码图只在安装、升级、
// 换运行时的时候才会变。所以两边都用文件签名做键，文件一动自然失效，不需要挂文件监听。
// 两个缓存都有上限，卸载掉的插件不会一直占着内存。
import { readFileSync, statSync } from 'node:fs';

const MAX_MANIFESTS = 512;
const MAX_FACTS = 256;

// 塞进去，满了就丢最早的那个。
function put(cache, limit, key, value) {
  if (cache.size >= limit && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

// mtime + size 就够判断变没变，不读文件内容。
function signature(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

export function createManifestReader() {
  const cache = new Map();
  return (path) => {
    const key = signature(path);
    // asar 里的文件 stat 拿不到签名，但内容能读，所以不能因此直接放弃。
    // 这类路径内容不会变，用固定键缓存即可。
    const fallbackKey = path.includes('app.asar') ? 'asar' : undefined;
    const effectiveKey = key ?? fallbackKey;
    if (effectiveKey === undefined) {
      cache.delete(path);
      return undefined;
    }
    const cached = cache.get(path);
    if (cached !== undefined && cached.key === effectiveKey) return cached.manifest;
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      put(cache, MAX_MANIFESTS, path, { key: effectiveKey, manifest });
      return manifest;
    } catch {
      cache.delete(path);
      return undefined;
    }
  };
}

// 运行时版本也算进键里：同一个插件在换 DSH 版本后必须重新解析。
export function createFactsReader(collect) {
  const cache = new Map();
  return (dir, entry, runtimeVersion) => {
    const stamp = signature(entry);
    const key = stamp === undefined ? `${dir}:${runtimeVersion}` : `${dir}:${runtimeVersion}:${stamp}`;
    const cached = cache.get(dir);
    if (cached !== undefined && cached.key === key) return cached.value;
    const value = collect(dir, entry);
    put(cache, MAX_FACTS, dir, { key, value });
    return value;
  };
}
