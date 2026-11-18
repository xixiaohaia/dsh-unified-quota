/**
 * dsh-unified-quota —— 记账引擎（llm/stream 观察者）
 *
 * 从 dsh-cost-meter 的计费路径移植而来（MIT，© 2026 dsh-cost-meter contributors，
 * 见 ../THIRD_PARTY_NOTICES.md）。只取「记录用量 + 定价」这一条最小闭包，
 * 不含它的配额查询、界面、历史重算、峰谷提醒等能力。
 *
 * 设计约束：
 *   1. 只用自己的存储文件，不读写 cost-meter 的任何路径（它可被完全卸载）；
 *   2. 不 import 任何 @deepseek-ai/* 包，任意 profile 布局都能解析；
 *   3. 记账失败只 warn，绝不打断对话流（isolation：宿主 llm/stream 瀑布里抛错会毁掉请求）。
 *
 * 移植的核心不变量（原实现的注释结论，逐条保留）：
 *   - provider 经 wrapperUpstreamProvider 归并，避免包装路由把同一次调用记成 2~3 份；
 *   - 同 (会话, 上游 provider, model, 五桶逐位指纹) 在 10s 窗口内只入账一次；
 *   - 峰谷档位按「请求发起时刻」判定，不按完成时刻。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  costOf, providerPriceEntryFor, isPeakHour, isWrapperProviderId, wrapperUpstreamProvider,
  DEFAULT_PRICE_TABLE, DEFAULT_PEAK_WINDOWS, DEFAULT_PEAK_HOLIDAYS, DEFAULT_PEAK_EFFECTIVE_AT,
} from './pricing.js';
import { usageFingerprint, USAGE_DEDUP_WINDOW_MS } from './usage-dedup.js';

/** 嵌套标记：包装路由在上层计费流的消费上下文里再发 llm/stream 时，内层直接透传。 */
const streamDepth = new AsyncLocalStorage();

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** 从 usage chunk 取五桶。字段名与宿主 token-meter 一致。 */
export function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const buckets = {
    input: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    reasoning: num(usage.reasoningTokens),
  };
  // 全零视为没有用量（有些路由在流尾发一个空 usage 块）。
  if (buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning <= 0) return null;
  return buckets;
}

export const totalTokens = (b) => num(b?.input) + num(b?.output) + num(b?.cacheRead) + num(b?.cacheWrite);

/**
 * 计费包装：包住宿主的 llm/stream 监听器链。
 * @param {object} deps
 * @param {(row: object) => void} deps.record 收到一次用量记录时回调。
 * @param {object} deps.config 计费配置（价格表 / 峰谷 / 汇率）。
 * @param {() => number} [deps.now]
 */
export function createStreamMeter({ record, onRecord, onError, config, now = Date.now }) {
  // (sessionId) → { plain: Map<fp, [{at,seen}]>, remapped: ... } —— 与上游同构
  const sessions = new Map();
  const windowMs = USAGE_DEDUP_WINDOW_MS;
  const retentionMs = Math.max(windowMs, 5 * 60_000);

  const sweep = (book, clock) => {
    for (const [fp, rows] of book) {
      const recent = rows.filter((r) => clock - r.seen <= retentionMs);
      if (recent.length) book.set(fp, recent); else book.delete(fp);
    }
  };

  const admit = (sessionId, model, provider, buckets, atMs) => {
    const prov = typeof provider === 'string' ? provider : '';
    const wrapped = isWrapperProviderId(prov);
    const effective = wrapped ? (wrapperUpstreamProvider(prov) ?? prov) : prov;
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
    const t = Number.isFinite(atMs) && atMs > 0 ? atMs : now();
    const clock = now();
    const fp = usageFingerprint(model, buckets, effective);
    let entry = sessions.get(key);
    if (entry === undefined) { entry = { plain: new Map(), remapped: new Map() }; sessions.set(key, entry); }
    sweep(entry.plain, clock); sweep(entry.remapped, clock);
    const book = wrapped ? entry.remapped : entry.plain;
    const matches = (source) => source.get(fp)?.some((r) => Math.abs(t - r.at) <= windowMs) === true;
    // 包装样本与两类都互斥；普通样本只与「改挂样本」互斥（两次合法的同量普通调用互不去重）
    if (wrapped ? (matches(entry.plain) || matches(entry.remapped)) : matches(entry.remapped)) return null;
    book.set(fp, [...(book.get(fp) ?? []), { at: t, seen: clock }].slice(-128));
    sessions.delete(key); sessions.set(key, entry);
    while (sessions.size > 4096) sessions.delete(sessions.keys().next().value);
    return effective;
  };

  return (options, next) => {
    // 建立流时上游就可能直接抛（例如「可用账号均在限流中」）。
    // 这里捕获并上报，供上层记录「已触顶 + 解禁时间」——比事后扫日志可靠。
    let downstream;
    try {
      downstream = next();
    } catch (error) {
      if (typeof onError === 'function') {
        try { onError(error, { provider: options?.provider, model: options?.model }); } catch (e) { /* 忽略 */ }
      }
      throw error;
    }
    if (streamDepth.getStore() !== undefined) return downstream;
    const startedAtMs = now();
    return (async function* meteredStream() {
      let usage = null;
      let completed = false;
      try {
        const iterator = downstream[Symbol.asyncIterator]();
        for (;;) {
          const result = await streamDepth.run(1, () => iterator.next());
          if (result.done) break;
          const chunk = result.value;
          if (chunk && chunk.type === 'usage' && chunk.usage != null) usage = chunk.usage;
          yield chunk;
        }
        completed = true;
      } catch (error) {
        // 流中途失败（限流/额度）同样上报，然后原样抛给调用方
        if (typeof onError === 'function') {
          try { onError(error, { provider: options?.provider, model: options?.model }); } catch (e) { /* 忽略 */ }
        }
        throw error;
      } finally {
        if (completed && usage !== null) {
          try {
            const buckets = bucketsOf(usage);
            if (buckets !== null) {
              const effective = admit(options?.sessionId, options?.model, options?.provider, buckets, startedAtMs);
              if (effective !== null) {
                if (typeof onRecord === "function") { try { onRecord({ provider: effective, model: options?.model, sessionId: options?.sessionId, atMs: startedAtMs }); } catch (e) { /* 忽略 */ } }
                record({ buckets, model: options?.model, provider: effective, sessionId: options?.sessionId, atMs: startedAtMs });
              }
            }
          } catch (error) {
            console.warn('[unified-quota] meter failed: ' + String(error && error.message || error));
          }
        }
      }
    })();
  };
}

export { streamDepth };
