// 几个修复监听器。
//
// 一个管模型请求失败，一个管工具调用失败，一个管浏览器载体请求失败。三者共用重试预算、
// 诊断记录和插件生命周期，这些都是从参数传进来而不是从闭包里摸出去的，所以每个函数
// 单独拎出来也能看懂。
import { computeDelay, isTransientNetworkError, isTransientToolFailure } from './classify.js';
import { cancellableSleep } from './sleep.js';
import { createModelRepair } from './model-repair.js';

export function createRepairListeners(input) {
  const { config, lifetime, diagnostics, ledger, versionRepair, services, warn } = input;
  const { record, stats } = diagnostics;
  const modelRepair = createModelRepair({ config, lifetime, diagnostics, ledger, versionRepair, services, warn });

  // 把请求自己的取消信号和插件生命周期绑在一起，插件卸载时正在等的重试能立刻醒。
  const fuse = (signal) => {
    if (signal === undefined) return lifetime.signal;
    try {
      return AbortSignal.any([signal, lifetime.signal]);
    } catch {
      return signal;
    }
  };

  // 工具调用被瞬时传输故障打断时，只读的那些可以重放一次。
  //
  // 必须卡着白名单来：带副作用的工具重放一遍，就是真的多跑了一条命令、多发了一条消息。
  async function onToolExecute(exec, next) {
    let attempt = 0;
    for (;;) {
      const outcome = await attemptDispatch(exec, next, attempt);
      if (outcome.retry === false) {
        if (outcome.error !== undefined) throw outcome.error;
        return outcome.result;
      }
      attempt += 1;
      const policy = config();
      if (attempt > policy.maxToolRetries) {
        if (outcome.error !== undefined) throw outcome.error;
        return outcome.result;
      }
      const delayMs = computeDelay(policy, attempt, undefined);
      const waited = await cancellableSleep(delayMs, fuse(exec.signal));
      if (!waited) {
        if (outcome.error !== undefined) throw outcome.error;
        return outcome.result;
      }
      stats.toolRepairs += 1;
      record('tool', `${exec.name} replayed after a transient ${outcome.reason} failure (attempt ${attempt})`);
    }
  }

  // 循环检测：同名同参的调用连着出现太多次，就不再重放。
  //
  // 宿主自己的循环检测若失效，重放会把循环放大。这里只约束「我们自己的重放」，
  // 不改变调用本身的语义——正常调用该怎么走还怎么走。
  const recent = new Map();
  function signatureOf(exec) {
    try {
      return `${exec.name}:${JSON.stringify(exec.arguments ?? {}).slice(0, 400)}`;
    } catch {
      return String(exec.name);
    }
  }
  function seenTooOften(exec) {
    const key = signatureOf(exec);
    const count = (recent.get(key) ?? 0) + 1;
    recent.set(key, count);
    if (recent.size > 64) recent.clear();
    return count > config().maxRepeatedToolCalls;
  }

  // 跑一次调用，顺便判断这次失败值不值得重放。
  async function attemptDispatch(exec, next, attempt) {
    const policy = config();
    if (attempt >= policy.maxToolRetries) {
      try {
        return { retry: false, result: await next() };
      } catch (error) {
        return { retry: false, error };
      }
    }
    if (exec.signal?.aborted || lifetime.signal.aborted || seenTooOften(exec)) {
      try {
        return { retry: false, result: await next() };
      } catch (error) {
        return { retry: false, error };
      }
    }
    try {
      const result = await next();
      if (!isTransientToolFailure(exec.name, result, policy.retryableToolPattern)) return { retry: false, result };
      return { retry: true, reason: 'dispatch', result };
    } catch (error) {
      if (!isTransientNetworkError(error)) return { retry: false, error };
      return { retry: true, reason: 'thrown transport', error };
    }
  }

  // 浏览器载体的传输失败，如果响应头还没发出去，就换成可重试的 503。
  //
  // 头一发出去响应形状就定了，这时候只能把原始错误抛回去，硬写半截回复反而更糟。
  async function onConnectionRequest(request, response, next) {
    try {
      return await next();
    } catch (error) {
      if (response.headersSent || response.writableEnded || !isTransientNetworkError(error)) throw error;
      stats.connectionRepairs += 1;
      record('connection', `replaced a failed ${String(request?.method ?? '')} ${String(request?.url ?? '')} with a retryable 503`);
      try {
        response.writeHead(503, { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' });
        response.end('request-doctor: transient client transport failure; retry the request');
      } catch {
        throw error;
      }
    }
  }

  return { onRequestError, onToolExecute, onConnectionRequest };

  // 模型请求的修复交给 model-repair 那个模块，这里只转发一下。
  // 放在后面是为了让工具和载体两个处理更靠前，读起来顺。
  function onRequestError(payload, next) {
    return modelRepair.handle(payload, next);
  }
}
