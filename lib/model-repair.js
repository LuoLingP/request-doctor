// 模型请求的修复。
//
// 收到一次失败的模型请求后：判断属于哪一类，按这一类的策略先做本地修复，再决定要不要
// 花掉一份重试预算。provider 自己声明了重试策略的，优先听它的——只有下游所有监听器都
// 放弃重试了，这里才接手，免得出现两条重试链。
//
// 三类防护都在这层：
// - 预算：按 turn:step:provider:kind 分组，同一处失败有统一上限；
// - 并发：同一处同时只允许一个重试在飞，避免重试风暴把本机拖死；
// - 无进展：压缩/修历史连续两轮都没让问题前进，就不再无限重试。
import { classifyModelFailure, computeDelay } from './classify.js';
import { cancellableSleep } from './sleep.js';

// 每个策略分到的预算倍数。鉴权类的重试更贵（要换凭据），给的次数更少。
const STRATEGY_BUDGET = { auth: 'auth', 'history-repair': 'history', compact: 'normal' };

export function createModelRepair(input) {
  const { config, lifetime, diagnostics, ledger, versionRepair, services, warn } = input;
  const { record, stats } = diagnostics;

  // 同一处同时在飞的重试：key 相同就只放一个进去。
  const inFlight = new Set();
  // 压缩/修历史有没有让问题前进：连着两轮没进展就停手。
  const progress = new Map();

  // 把请求自己的取消信号和插件生命周期绑在一起，插件卸载时正在等的重试能立刻醒。
  const fuse = (signal) => {
    if (signal === undefined) return lifetime.signal;
    try {
      return AbortSignal.any([signal, lifetime.signal]);
    } catch {
      return signal;
    }
  };

  // 上下文超长时，重试之前先试着瘦身。
  //
  // 压缩和裁剪工具结果分别由两个可选服务提供，profile 里一个都没有也照样重试，
  // 所以两个都是能成就成。
  async function compactForOverflow(payload) {
    const compaction = services.get('compaction');
    if (compaction !== undefined) {
      try {
        await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal);
      } catch (error) {
        warn(`request-doctor: overflow compaction failed: ${String(error)}`);
      }
    }
    pruneToolResults(payload);
  }

  // 裁掉过期的工具结果。裁剪器没有就跳过。
  function pruneToolResults(payload) {
    const pruner = services.get('toolResultPruner');
    if (pruner === undefined) return;
    try {
      pruner.pruneSession(payload.agent.session);
    } catch {
      // 裁剪不了就算了
    }
  }

  // 本地历史或规则文件坏了：清掉工具结果、让会话重新落盘，能救回来一部分。
  async function repairHistory(payload) {
    pruneToolResults(payload);
    const store = services.get('sessionStore');
    if (store === undefined) return;
    try {
      await store.flush?.(payload.agent.session);
    } catch (error) {
      warn(`request-doctor: history flush failed: ${String(error)}`);
    }
  }
  // 请本机某个服务刷新一次。候选名字挨个试，第一个能刷的就够了；
  // 一个都没有也不算错——下游自己的重试同样可能触发刷新。
  async function ask(names, kind, payload) {
    for (const name of names) {
      const provider = services.get(name)
      if (provider === undefined) continue
      try {
        await provider.refresh?.(payload.provider, payload.signal)
        record(kind, `asked ${name} to refresh ${kind} for ${payload.provider}`)
        return
      } catch (error) {
        warn(`request-doctor: ${name} refresh failed: ${String(error)}`)
      }
    }
  }

  // 凭据类失败：让本机的凭据层有机会刷新一次。
  const refreshCredentials = (payload) => ask(['credentials', 'auth', 'accounts'], 'auth', payload)

  // 模型选择类失败（模型 ID 写死、能力表判断错、模型列表缓存过期）：
  // 让本机的模型目录服务重新拉一次，缓存过期是最常见的成因。
  const refreshModelCatalog = (payload) => ask(['modelCatalog', 'models', 'providerRegistry'], 'model', payload)

  // 按策略先做本地修复；返回 false 表示这一类的修复没成，重试也没意义。
  async function prepare(decision, payload) {
    if (decision.strategy === 'version-repair') {
      const fixed = await versionRepair.run(`model-${decision.kind}`);
      return fixed.length > 0;
    }
    if (decision.strategy === 'compact') {
      await compactForOverflow(payload);
      return true;
    }
    if (decision.strategy === 'history-repair') {
      await repairHistory(payload);
      return true;
    }
    if (decision.strategy === 'auth') {
      await refreshCredentials(payload);
      return true;
    }
    // retry 和 local 都是直接重来，local 的那点延迟由退避自动拉开。
    return decision.strategy === 'retry' || decision.strategy === 'local';
  }

  // 这一类的次数上限。鉴权类更贵，单独一个更小的额度。
  function budgetFor(decision) {
    const policy = config();
    if (STRATEGY_BUDGET[decision.strategy] === 'auth') return policy.maxAuthRetries;
    if (STRATEGY_BUDGET[decision.strategy] === 'history') return Math.max(1, Math.floor(policy.maxRetries / 3));
    return policy.maxRetries;
  }

  // 花掉一份重试预算，安排下一次尝试。
  async function scheduleRetry(key, payload, decision, downstream) {
    const entry = ledger.chainFor(payload.agent, key);
    entry.count += 1;
    const limit = budgetFor(decision);
    if (entry.count > limit) {
      stats.modelSkips += 1;
      if (entry.count === limit + 1) record('give-up', `${decision.kind} from ${payload.provider} after ${limit} repairs`);
      return downstream;
    }
    const delayMs = computeDelay(config(), entry.count, payload.failure);
    ledger.recordScheduled(payload.agent, payload, decision.kind, entry, delayMs);
    if (!(await cancellableSleep(delayMs, fuse(payload.signal)))) return downstream;
    ledger.recordStarted(payload.agent, payload, entry);
    stats.modelRepairs += 1;
    record('model', `${decision.kind} from ${payload.provider} attempt ${entry.count} in ${delayMs}ms`);
    return { kind: 'retry' };
  }

  // 处理一次失败的模型请求。
  //
  // 先让下游跑完：只要有人愿意重试，就不再插一脚。
  async function handle(payload, next) {
    const downstream = await next();
    if (downstream?.kind === 'retry') return downstream;
    if (payload.signal?.aborted || lifetime.signal.aborted) return downstream;

    const decision = classifyModelFailure(payload.failure);
    if (!decision.clientCaused || decision.strategy === 'skip') return downstream;

    const key = `${payload.turn}:${payload.step}:${payload.provider}:${decision.kind}`;
    // 同一处只放一个重试进去。并发的那几个直接让下游收场，避免重试互相叠加。
    if (inFlight.has(key)) return downstream;
    inFlight.add(key);
    try {
      return await attempt(key, payload, decision, downstream);
    } finally {
      inFlight.delete(key);
    }
  }

  // 依次过三关：本地修复成不成、还有没有进展、预算还剩不剩。
  async function attempt(key, payload, decision, downstream) {
    if (!(await prepare(decision, payload))) {
      stats.modelSkips += 1;
      return downstream;
    }
    if (recordProgress(key) === false) {
      record('give-up', `${decision.kind} made no progress after two attempts`);
      return downstream;
    }
    return scheduleRetry(key, payload, decision, downstream);
  }

  // 记一次「这一处又失败了」。同一处连着两轮都失败，说明修复没起作用。
  function recordProgress(key) {
    const count = (progress.get(key) ?? 0) + 1;
    if (count > 2) return false;
    progress.set(key, count);
    return true;
  }

  return { handle };
}
