// 脱离 HMR 事务的定时器。
//
// 插件激活时整个流程跑在 hmr.runExclusive 里面，而 AsyncLocalStorage 会把这个上下文
// 带进激活期间创建的所有定时器。结果就是定时器回调里调用 pluginManager 时，它还认为
// 自己在事务内，直接报 "HMR transactions cannot be nested"。所以创建定时器之前先退出
// 这个上下文，回调里就能正常拿锁了。
export function createTimers(ctx, timers) {
  const detach = (start) => {
    const storage = ctx.get('hmr')?.executing;
    if (storage !== undefined && typeof storage.exit === 'function') {
      try {
        return storage.exit(start);
      } catch {
        // 拿不到就直接调，总比什么都不做强
      }
    }
    return start();
  };

  // 延迟执行，返回取消函数。定时器都 unref，免得拖住进程退出。
  const later = (fn, delayMs) => {
    let timer;
    detach(() => {
      timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delayMs);
      timer.unref?.();
    });
    if (timer !== undefined) timers.add(timer);
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };
  };
  return { later };
}
