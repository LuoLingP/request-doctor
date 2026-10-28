// 兼容环境的下载缓存。
//
// 版本搜索会把试过的版本都下载下来。这些包不小，不清理的话这个目录只会越长越大，
// 所以按最近使用时间留够用的量，多余的删掉——下次真需要还能重新取。
import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// 记下「刚刚用过」。缓存淘汰按这个时间判断谁是热的。
export function touchAndReturn(dir) {
  try {
    const now = new Date();
    utimesSync(dir, now, now);
  } catch {
    // 摸不到时间也不影响使用
  }
  return dir;
}

// 缓存最多留这么多个包。一次闭包最多十六个，留两批足够。
const MAX_CACHED_PACKAGES = 32;

// 目录的修改时间，取不到就当最旧。
function mtimeOf(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// 淘汰冷缓存。
//
// 版本搜索会把试过的版本都下载下来，不清理这个目录只会越长越大。
// 按最近使用时间留够用的量，多余的删掉——下次真需要还能重新取。
export function pruneCache(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return 0;
  const base = join(profileDir, '.request-doctor-cache');
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return 0;
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(base, entry.name);
    if (!entry.name.startsWith('@')) {
      items.push({ path, at: mtimeOf(path) });
      continue;
    }
    // scoped 包多一层，真正的缓存项在它下面。
    let inner;
    try {
      inner = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of inner) {
      if (child.isDirectory()) items.push({ path: join(path, child.name), at: mtimeOf(join(path, child.name)) });
    }
  }

  if (items.length <= MAX_CACHED_PACKAGES) return 0;
  items.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const item of items.slice(0, items.length - MAX_CACHED_PACKAGES)) {
    try {
      rmSync(item.path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 删不掉就留着，下一轮再说
    }
  }
  return removed;
}


