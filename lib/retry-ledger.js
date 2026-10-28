// 重试账本。
//
// 记住每个 agent 每条链已经重试过几次，并且把修复写进既有的 llm/retry 事件里，
// 这样对话里能直接看到重试记录。单拎出来是为了让预算规则能被单独读懂和测试。
import { randomUUID } from 'node:crypto';

// 每个 agent 最多留这么多条链。老 turn 不可能再重试了，留着没用。
const MAX_CHAINS_PER_AGENT = 128;

export function createRetryLedger(input) {
  const chains = new WeakMap();

  // 取一条链的预算记录，没有就建。键是 turn:step:provider:kind，
  // 换句话说同一处失败共用一份预算，换一处就重新开始算。
  const chainFor = (agent, key) => {
    let map = chains.get(agent);
    if (map === undefined) chains.set(agent, (map = new Map()));
    let entry = map.get(key);
    if (entry === undefined) {
      if (map.size >= MAX_CHAINS_PER_AGENT) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, (entry = { count: 0, retryId: randomUUID() }));
    }
    return entry;
  };

  // 排上重试时写 llm/retry。只用既有事件类型，新类型会被读取端当成未知事件拒掉。
  const recordScheduled = (agent, payload, kind, entry, delayMs) => {
    const config = input.config();
    if (!config.recordRetryEvents) return;
    try {
      agent.session.append('llm/retry', {
        retryId: entry.retryId,
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        mode: 'normal',
        policyKey: `request-doctor:${kind}`,
        retry: entry.count,
        maxRetries: config.maxRetries,
        delayMs,
        failure: payload.failure,
      });
    } catch (error) {
      input.warn(`request-doctor: could not record the repair event: ${String(error)}`);
    }
  };

  // 真正开始重试时补一条 llm/retry-started，把这条记录闭环。
  const recordStarted = (agent, payload, entry) => {
    if (!input.config().recordRetryEvents) return;
    try {
      agent.session.append('llm/retry-started', {
        retryId: entry.retryId,
        turn: payload.turn,
        step: payload.step,
        retry: entry.count,
      });
    } catch {
      // 只是展示用，写不进去不影响修复
    }
  };

  return { chainFor, recordScheduled, recordStarted };
}
