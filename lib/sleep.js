// 可中断的等待。
//
// 退避期间如果请求被取消或插件被卸载，必须立刻醒过来，所以这里返回布尔值而不是抛错——
// 由调用方决定是交还下游结果还是把原始异常抛出去。
export function cancellableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
