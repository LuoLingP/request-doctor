// 纯函数：判断一次失败到底是不是本机这边能挽回的，以及重试该怎么排。
//
// 这层不依赖任何运行时服务，所以可以直接 node --test 跑。真正把判断变成动作的
// 是 index.js 和 lib 里那几个修复模块。
//
// 分类的粒度按「修复动作」来分，不是按报错原文分。同一句话在两种上下文里可能要
// 不同处理，所以每一类都带上策略：重试、先压缩、先修历史、先换凭据、或者干脆放弃。

// 这些字样说明失败出在本机传输栈，而不是对方服务。错误对象本身的 code 经常不说明问题，
// 真正有用的是 message 和 cause 链，所以要顺着链把文本拼起来再匹配。
const NETWORK_PATTERNS = [
  /fetch failed/i,
  /failed to fetch/i,
  /network ?error/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /EPIPE/i,
  /socket hang ?up/i,
  /other side closed/i,
  /UND_ERR_/i,
  /premature close/i,
  /stream (?:closed|reset)/i,
  /connection (?:reset|lost|closed|refused|aborted)/i,
  /proxy/i,
  /timed? ?out/i,
  /terminated/i,
  /aborted/i,
];

// 流式连接被截断：SSE 长连接超时、读到一半断开、事件流提前结束。
const STREAM_PATTERNS = [
  /SSE/i,
  /event ?stream/i,
  /stream(?:ing)? (?:interrupted|truncated|aborted|ended early)/i,
  /incomplete (?:chunk|response|stream)/i,
  /unexpected end of (?:stream|json|data)/i,
  /keep-?alive ?timeout/i,
];

// 证书与 TLS：重试不会让证书变可信，这类必须放弃，否则只会把失败刷屏。
const TLS_PATTERNS = [
  /tls(?: handshake)? (?:failed|error)/i,
  /certificate/i,
  /SELF_SIGNED_CERT/i,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  /CERT_HAS_EXPIRED/i,
  /ERR_TLS_/i,
  /hostname\/IP does not match certificate/i,
];

// 凭据与鉴权：OAuth 会话过期、本地缓存的 token 失效、客户端没自动刷新、
// Header 拼错、多 Key 轮换时挑到了失效的那把、provider 侧缓存了旧凭据。
const AUTH_PATTERNS = [
  /oauth/i,
  /token (?:expired|invalid|revoked|missing)/i,
  /refresh token/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid api ?key/i,
  /api ?key (?:expired|invalid|missing)/i,
  /authentication (?:failed|required)/i,
  /authorization/i,
  /missing credential/i,
  /credential/i,
  /401|403/,
];

// 请求形状与协议：Wire API 版本对不上、角色字段不被接受、客户端自己追加了对方
// 不认识的参数、tool_call 的结构跟对方要的不一致。这类重试同样的请求没用，
// 得先让本机把请求重新拼一遍——我们做不到改请求体，所以只做一次有限重试并留痕。
const PROTOCOL_PATTERNS = [
  /wire ?api/i,
  /protocol (?:mismatch|version|error)/i,
  /unsupported (?:parameter|field|role|content type)/i,
  /invalid (?:role|message|content|tool_call|tool call|function call)/i,
  /role .*(?:not allowed|unsupported|invalid)/i,
  /tool_calls? (?:format|schema|invalid|malformed)/i,
  /malformed (?:request|body|json)/i,
  /unexpected (?:parameter|argument|field)/i,
  /400 bad request/i,
  /schema validation/i,
];

// 本地缓存类：会话历史损坏、规则文件解析失败、模型能力缓存过期、上下文裁剪策略算错。
const HISTORY_PATTERNS = [
  /history (?:corrupt|invalid|broken|unreadable)/i,
  /invalid (?:message|session) (?:history|record|log)/i,
  /corrupt(?:ed)? (?:session|history|cache|record)/i,
  /rule (?:file|set).*(?:parse|invalid|syntax)/i,
  /failed to parse (?:rules|config|settings)/i,
  /config(?:uration)? (?:parse|syntax) error/i,
  /JSON (?:parse|syntax) error/i,
];

// 压缩自死循环：「压缩完还是超限」，连续两轮都在压缩却量没降下来。
const COMPACTION_LOOP_PATTERNS = [
  /compress(?:ion)? (?:loop|did not reduce|no progress|ineffective)/i,
  /still (?:too long|exceeds|over (?:the )?limit) after (?:compress|compact|prune)/i,
];

// MCP 子服务：独立鉴权失败、子服务没起来、握手失败。
const MCP_PATTERNS = [
  /\bMCP\b/,
  /mcp (?:server|client|handshake|session)/i,
  /subprocess .*(?:mcp|server).*(?:failed|exit)/i,
];

// 模型选择与能力判断：模型 ID 写死成旧名字、能力表判断错、缓存里的模型列表过期。
const MODEL_PATTERNS = [
  /model (?:not found|not supported|unsupported|unknown)/i,
  /unknown model/i,
  /invalid model/i,
  /no such model/i,
  /model (?:list|catalog|cache).*(?:stale|expired|invalid)/i,
  /capabilit(?:y|ies) (?:mismatch|unsupported|unknown)/i,
];

// 本机环境：端口被占、本地中转服务崩了、沙箱权限不足、子进程崩溃、
// 文件读不出来、句柄或磁盘耗尽。这些不是模型请求的问题，重试请求本身没用。
const LOCAL_PATTERNS = [
  /EADDRINUSE/i,
  /EACCES/i,
  /EPERM/i,
  /ENOENT/i,
  /EMFILE/i,
  /ENFILE/i,
  /ENOSPC/i,
  /ENOMEM/i,
  /EAGAIN/i,
  /spawn (?:.* )?(?:ENOENT|EACCES|failed)/i,
  /child process (?:exited|died|crashed|killed)/i,
  /sandbox/i,
  /permission denied/i,
  /resource temporarily unavailable/i,
  /out of memory/i,
];

// 这几种本机故障不会随重试消失：权限不足、路径不存在、磁盘写满。
const LOCAL_BLOCKING_PATTERNS = [
  /EACCES/i,
  /EPERM/i,
  /ENOENT/i,
  /ENOSPC/i,
  /permission denied/i,
  /sandbox .*(?:denied|blocked)/i,
];
// 只读工具才允许重放。带副作用的（跑命令、写文件、发消息）重放一次就是执行两遍。
const DEFAULT_RETRYABLE_TOOL_PATTERN =
  '^(read|read_image|glob|grep|web_fetch|web_search|cordis_inspect_.*|browser_(list_tabs|snapshot|get_text|wait|scroll)|db_(query|preview|describe_table|list_tables))$';

// 把一个错误和它的 cause 链摊平成一段短文本，供正则匹配。限制深度和长度是为了
// 防止循环引用或者过长的 cause 链把内存拖垮。
function errorText(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined || depth > 6 || seen.has(value)) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  seen.add(value);
  const own = [];
  for (const key of ['message', 'code', 'name', 'reason', 'errno', 'syscall']) {
    const part = value[key];
    if (part !== undefined && part !== null && typeof part !== 'object') own.push(String(part));
  }
  if (value.info && typeof value.info === 'object') own.push(String(value.info.code ?? ''));
  const cause = value.cause !== undefined ? errorText(value.cause, depth + 1, seen) : '';
  return `${own.join(' ')} ${cause}`.trim().slice(0, 4000);
}

// 一组正则里有没有命中的。
function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

// 抛出来的东西或者失败记录里，是否指向本机传输问题。
export function isTransientNetworkError(value) {
  const text = errorText(value);
  if (text === '') return false;
  return matchesAny(NETWORK_PATTERNS, text);
}

// 规则表。从上往下匹配，第一条命中就返回。
//
// 顺序就是优先级，错了会互相盖掉：
// - 证书问题排最前，重试它没有意义，必须先放弃；
// - 对方侧的拒绝（配额、政策、鉴权被拒）排在传输判断前，否则一句「含 timeout 的配额错误」
//   会被当成网络抖动去重试；
// - 压缩死循环排在普通超限前，否则会被当成一次新的超长而反复压缩。
const CLASSIFICATION_RULES = [
  {
    kind: 'tls',
    strategy: 'skip',
    clientCaused: false,
    match: (context) => matchesAny(TLS_PATTERNS, context.text),
  },
  {
    kind: 'policy',
    strategy: 'skip',
    clientCaused: false,
    match: (context) => /content policy|safety|moderation|blocked by policy/i.test(context.text),
  },
  {
    kind: 'quota',
    strategy: 'skip',
    clientCaused: false,
    match: ({ code }) => code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || code === 'RATE_LIMIT' || code === 'SERVER',
  },
  {
    kind: 'compaction-loop',
    strategy: 'history-repair',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(COMPACTION_LOOP_PATTERNS, context.text),
  },
  {
    kind: 'history',
    strategy: 'history-repair',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(HISTORY_PATTERNS, context.text),
  },
  {
    kind: 'overflow',
    strategy: 'compact',
    clientCaused: true,
    retryable: true,
    match: ({ code, status, text }) =>
      code === 'CONTEXT_WINDOW_EXCEEDED' || status === 413 || /context (?:window|length)|request too large|prompt too long/i.test(text),
  },
  { kind: 'image', strategy: 'skip', match: ({ code }) => code === 'IMAGE_OFFLOAD_REQUIRED' },
  {
    kind: 'adapter',
    strategy: 'version-repair',
    clientCaused: true,
    match: ({ code, status }) => code === 'NO_ADAPTER' || status === 404,
  },
  {
    kind: 'auth',
    strategy: 'auth',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(AUTH_PATTERNS, context.text) || context.status === 401 || context.status === 403,
  },
  {
    kind: 'mcp',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(MCP_PATTERNS, context.text),
  },
  {
    kind: 'protocol',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(PROTOCOL_PATTERNS, context.text) || context.status === 400,
  },
  {
    kind: 'model',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(MODEL_PATTERNS, context.text),
  },
  {
    // 权限、路径、磁盘满这类重试一万次也不会变：本机缺的是权限或空间，不是时机。
    kind: 'local-blocked',
    strategy: 'skip',
    clientCaused: true,
    match: (context) => matchesAny(LOCAL_BLOCKING_PATTERNS, context.text),
  },
  {
    kind: 'local-env',
    strategy: 'local',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(LOCAL_PATTERNS, context.text),
  },
  {
    kind: 'stream',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: (context) => matchesAny(STREAM_PATTERNS, context.text),
  },
  {
    kind: 'provider-error',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: ({ code, text }) => code === 'PI_AI_ERROR' || /PI_AI_ERROR/i.test(text),
  },
  { kind: 'empty', strategy: 'retry', clientCaused: true, retryable: true, match: ({ code }) => code === 'EMPTY_RESPONSE' },
  { kind: 'timeout', strategy: 'retry', clientCaused: true, retryable: true, match: ({ code, status }) => code === 'TIMEOUT' || status === 408 },
  {
    kind: 'transport',
    strategy: 'retry',
    clientCaused: true,
    retryable: true,
    match: (context) => context.transient === true,
  },
];

// 判断一次模型请求失败属于哪一类。
//
// clientCaused 表示问题出在本机（传输、本地拼坏请求、路由或凭据过期），而不是对方服务；
// strategy 表示重试之前先做什么：compact 先压缩上下文，history-repair 先修本地历史或规则，
// auth 先换凭据，version-repair 先修插件版本，retry 直接退避重来，local 交给本机环境处理，
// skip 什么都不做。
export function classifyModelFailure(failure) {
  const code = String(failure?.code ?? '').toUpperCase();
  const context = {
    code,
    status: Number(failure?.status ?? 0),
    text: errorText(failure),
    transient: isTransientNetworkError(failure),
  };
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match(context)) {
      return {
        clientCaused: rule.clientCaused ?? false,
        kind: rule.kind,
        strategy: rule.strategy,
        retryable: rule.retryable ?? false,
      };
    }
  }
  return { clientCaused: false, kind: 'other', strategy: 'skip', retryable: false };
}

// 判断一次工具调用失败是否值得重放。只有只读工具在名单里才考虑，
// 而且失败原因得确实是传输或本地环境问题——本地环境问题重放往往就好了。
export function isTransientToolFailure(name, result, allowlist) {
  if (result?.isError !== true) return false;
  if (!allowlist.test(String(name ?? ''))) return false;
  if (isTransientNetworkError(result.error)) return true;
  const text = errorText(result.error);
  if (matchesAny(LOCAL_PATTERNS, text)) return true;
  const content = Array.isArray(result.content) ? JSON.stringify(result.content).slice(0, 2000) : '';
  return matchesAny(NETWORK_PATTERNS, content) || matchesAny(LOCAL_PATTERNS, content);
}

// 把插件配置整理成一套完整、带默认值和上下界的策略。
// 用户配错不该导致插件不工作，所以数值一律夹到合理区间。
export function parseRetryConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const number = (key, fallback, min, max) => {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
  };
  const bool = (key, fallback) => (typeof source[key] === 'boolean' ? source[key] : fallback);
  let toolPattern;
  try {
    toolPattern = new RegExp(typeof source.retryableToolPattern === 'string' ? source.retryableToolPattern : DEFAULT_RETRYABLE_TOOL_PATTERN);
  } catch {
    // 用户写的正则不合法，退回默认白名单
    toolPattern = new RegExp(DEFAULT_RETRYABLE_TOOL_PATTERN);
  }
  return {
    autoRepair: bool('autoRepair', true),
    autoVersionRepair: bool('autoVersionRepair', true),
    recordRetryEvents: bool('recordRetryEvents', true),
    maxRetries: Math.round(number('maxRetries', 12, 0, 100)),
    maxToolRetries: Math.round(number('maxToolRetries', 2, 0, 10)),
    maxVersionRepairs: Math.round(number('maxVersionRepairs', 64, 0, 500)),
    maxAuthRetries: Math.round(number('maxAuthRetries', 2, 0, 10)),
    maxRepeatedToolCalls: Math.round(number('maxRepeatedToolCalls', 3, 0, 50)),
    initialDelayMs: number('initialDelayMs', 400, 1, 2147483647),
    maxDelayMs: number('maxDelayMs', 20000, 1, 2147483647),
    jitterRatio: number('jitterRatio', 0.25, 0, 1),
    retryableToolPattern: toolPattern,
  };
}

// 指数退避加抖动。对方要是给了 retry-after 就用它的，但仍然夹在上下限内。
// 抖动是为了避免多个重试在同一时刻一起怼上去。
export function computeDelay(config, attempt, failure) {
  const hint = Number(failure?.providerRetryAfterMs);
  if (Number.isFinite(hint) && hint > 0) return Math.min(Math.max(hint, 100), config.maxDelayMs);
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  const ceil = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * Math.random();
  return Math.max(1, Math.min(Math.round(ceil * jitter), config.maxDelayMs));
}
