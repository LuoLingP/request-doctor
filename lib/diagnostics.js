// 诊断记录。
//
// 管三件事：各项修复计数、最近若干条事件、可选的快照文件。单独拎出来是因为组合根要
// 关心的是"怎么修"，不该顺带管状态怎么记。
import { writeFileSync } from 'node:fs';

// 最近事件留多少条给 /doctor 看
const MAX_LOG = 30;

// 突发重试时按这个间隔合并写盘
const WRITE_COALESCE_MS = 250;

export function createDiagnostics(input) {
  const stats = {
    startedAt: Date.now(),
    modelRepairs: 0,
    modelSkips: 0,
    toolRepairs: 0,
    connectionRepairs: 0,
    versionRepairs: 0,
    last: [],
  };
  const diagnostics = { versionScan: null };
  let pending;

  const snapshot = () => ({
    pid: process.pid,
    ...stats,
    diagnostics,
    ...(input.describe === undefined ? {} : { config: input.describe() }),
  });

  // 立刻写。诊断不是正确性数据，写失败就算了——磁盘满了也不该把请求修复带崩。
  const writeNow = () => {
    if (input.statusFile === '') return;
    try {
      writeFileSync(input.statusFile, `${JSON.stringify(snapshot(), null, 2)}\n`, 'utf8');
    } catch {
      // 只有诊断，丢了就丢了
    }
  };

  // 合并写。record 每次修复都会调，而修复是会扎堆的——网络抖一下一秒能来好几次，
  // 每次都同步写盘等于在 agent 最忙的时候卡住事件循环。
  const scheduleWrite = () => {
    if (input.statusFile === '' || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      writeNow();
    }, WRITE_COALESCE_MS);
    pending.unref?.();
    input.trackTimer?.(pending);
  };

  const record = (kind, detail) => {
    stats.last.push({ at: new Date().toISOString(), kind, detail: String(detail).slice(0, 240) });
    if (stats.last.length > MAX_LOG) stats.last.shift();
    input.log('info', `request-doctor: ${kind}: ${detail}`);
    scheduleWrite();
  };

  // 把扫描错误挂到当前这轮结果上，别让调用方去翻嵌套对象。
  const scanError = (detail) => {
    diagnostics.versionScan = { ...(diagnostics.versionScan ?? {}), ok: false, error: detail };
  };

  // 收尾时把攒着的写掉
  const flush = () => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
    writeNow();
  };

  return { record, scheduleWrite, writeNow, flush, scanError, stats, diagnostics, snapshot };
}
