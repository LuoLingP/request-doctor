// 运行时探测。
//
// 负责问清楚：当前跑的是哪个 DSH 版本、profile 在哪儿、DSH 自己的包装在哪儿、
// 以及现在真正注册了哪些 provider 路由。这些都是"查一下"的事，不涉及"怎么修"，
// 所以跟用它们的修复流程分开放。
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { entryPathOf, packageDir } from './compat-repair.js';
import { createFactsReader, createManifestReader } from './stat-cache.js';

// DSH 自己的包可能装在安装目录里，也可能打在 asar 里。
// 前者能直接用文件系统找到，后者 existsSync 看不见，只能靠路径拼。
function packageDirInInstallation(packageName) {
  for (const root of installationRoots()) {
    const candidate = join(root, 'node_modules', ...packageName.split('/'));
    // asar 里的目录 existsSync 返回 false，但路径本身可用，直接交出去。
    if (root.includes('app.asar')) return candidate;
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

// 找出 DSH 装在哪里。按可靠性从高到低试几个来源。
function installationRoots() {
  const roots = [];

  // 最可靠的一条：从正在运行的模块 URL 反推。插件自己就加载自 DSH 安装目录。
  try {
    const self = import.meta.url;
    const marker = self.indexOf('/dsh/');
    if (marker > 0) roots.push(decodeURIComponent(new URL(self).pathname).slice(0, marker).replace(/^\//, '') + '/dsh');
  } catch {
    /* 拿不到就算了 */
  }

  // Electron 会给出 resources 目录。
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    roots.push(join(process.resourcesPath, 'app.asar', 'dsh'));
    roots.push(join(process.resourcesPath, 'app.asar.unpacked', 'dsh'));
    roots.push(join(process.resourcesPath, 'dsh'));
  }

  // 从可执行文件位置推，覆盖非 Electron 的安装方式。
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    const exeDir = dirname(process.execPath);
    roots.push(join(exeDir, 'resources', 'app.asar', 'dsh'));
    roots.push(join(exeDir, 'resources', 'dsh'));
    roots.push(join(exeDir, 'dsh'));
  }

  return [...new Set(roots.filter((root) => root !== ''))];
}

export function createRuntimeProbe(input) {
  const readManifestCached = createManifestReader();
  const factsOf = createFactsReader(input.collectFacts);

  // 可选服务，没有就算了，不该因此中断。
  const safeGet = (name) => {
    try {
      return input.ctx.get(name);
    } catch {
      return undefined;
    }
  };

  // DSH 的包走的是 profile 的运行时拦截，不是普通 Node 解析，
  // 所以得问管这块映射的服务，而不是自己去 require。
  const runtimeVersionOf = (packages, baseUrl) => {
    try {
      const manifestPath = packages?.packageOf('@deepseek-ai/dsh-app-boot', baseUrl)?.manifestPath;
      return manifestPath === undefined ? undefined : readManifestCached(manifestPath)?.version;
    } catch {
      return undefined;
    }
  };

  // 先问服务，问不到再看环境变量——有些 profile 是在没有这些服务的情况下跑起来的。
  const profileDirOf = () => {
    const fromServices = safeGet('profileContext')?.dir ?? safeGet('pluginManager')?.profile?.dir;
    if (fromServices !== undefined) return fromServices;
    const home = process.env.DSH_HOME;
    const profile = process.env.DSH_PROFILE;
    return home === undefined || profile === undefined ? undefined : join(home, 'profiles', profile);
  };

  const runtimeFacts = () => {
    const packages = safeGet('pluginPackages');
    const baseUrl = input.ctx.baseUrl;
    return {
      runtimeVersion: runtimeVersionOf(packages, baseUrl),
      profileDir: profileDirOf(),
      packages,
      baseUrl,
    };
  };

  // DSH 自带的包在安装目录里（甚至是 asar 里），不在 profile 的 node_modules。
  // 先问 pluginPackages，它最清楚；问不到就用别的包探出安装根，最后才去翻安装目录。
  const runtimeDirOf = (facts) => (packageName) => {
    try {
      const resolved = facts.packages?.packageOf(packageName, facts.baseUrl);
      if (resolved?.dir !== undefined) return resolved.dir;
    } catch {
      // 落到后面几条路
    }
    // 同一个安装里的包都在同一个 node_modules 下，拿找得到的那个反推即可。
    const anchor = probeAnchor(facts);
    if (anchor !== undefined) {
      const candidate = join(anchor, ...packageName.split('/'));
      if (candidate.includes('app.asar') || existsSync(join(candidate, 'package.json'))) return candidate;
    }
    if (facts.profileDir !== undefined) {
      const inProfile = packageDir(facts.profileDir, packageName);
      if (inProfile !== undefined) return inProfile;
    }
    return packageDirInInstallation(packageName);
  };

  // 用运行时里一定找得到的包，反推它所在的 node_modules 目录。
  // app-boot 每个 profile 都必然加载，拿它当锚点最稳。
  const probeAnchor = (facts) => {
    for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-llm', '@deepseek-ai/cordis']) {
      try {
        const resolved = facts.packages?.packageOf(name, facts.baseUrl);
        if (resolved?.dir === undefined) continue;
        const parts = resolved.dir.replace(/\\/g, '/').split('/');
        const scope = parts.lastIndexOf('@deepseek-ai');
        if (scope > 0) return parts.slice(0, scope).join('/');
      } catch {
        // 换下一个
      }
    }
    return undefined;
  };

  const runtimeEntryOf = (facts) => (packageName) => {
    const dir = runtimeDirOf(facts)(packageName);
    if (dir === undefined) return;
    const manifest = readManifestCached(join(dir, 'package.json'));
    if (manifest !== undefined) return entryPathOf(dir, manifest);
    // manifest 读不到（asar 里的情况）就按惯例猜入口：先 lib/index.js，再 index.js。
    for (const guess of ['lib/index.js', 'index.js', 'lib/index.mjs']) {
      const candidate = join(dir, guess);
      if (candidate.includes('app.asar') || existsSync(candidate)) return candidate;
    }
    return undefined;
  };

  // 以运行时注册表为准。插件常常声明好几条路由，实际按地区或配置只注册一部分，
  // 光看源码会把根本不存在冲突也算出来。
  const activeProviders = () => {
    const llm = safeGet('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') return undefined;
    try {
      return llm.listProviders().map((entry) => entry?.id).filter((id) => typeof id === 'string');
    } catch {
      return undefined;
    }
  };

  return {
    readManifestCached,
    runtimeFacts,
    runtimeDirOf,
    runtimeEntryOf,
    activeProviders,
    factsOf,
    get: safeGet,
  };
}
