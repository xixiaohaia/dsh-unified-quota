/**
 * 积分账单：把 jet-hub 的 token 账本按「渠道 × 模型」还原成积分消耗，
 * 并算出「每 1 积分换到多少 token」。
 *
 * 数据源是 jet-hub 落盘的 token-ledger.json：
 *   days['YYYY-MM-DD']['<kind>|<provider>|<account>|<model>'] = {
 *     requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *     reasoningTokens, errors, ttftSumMs, ttftCount, tpsSum, tpsCount, tpsHistogram }
 *
 * 关键口径（与 jet-hub 保持一致，勿改）：
 *   - 日键是 **UTC+8**，各渠道的每日额度都按此结算；
 *   - 该账本只增不改，读侧无锁；
 *   - 文件可能瞬时不存在或半写，读取失败返回空而绝不抛。
 *
 * 积分 = token × 倍率。倍率来自渠道下发的模型展示名（见 ./credits.js），
 * 因此「积分账单」是本插件与 jet-hub 的交叉验证，不重复记一份账。
 */

import fs from 'node:fs/promises';

/** UTC+8 日键；与 jet-hub 的 utc8DayKey 同口径（算术平移，不用本机时区方法）。 */
export function utc8DayKey(ts) {
  const shifted = new Date(ts + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** 总量 = 计入计费的 token（未缓存输入 + 输出 + 缓存读 + 缓存写）。 */
export const tokensOfBucket = (b) => num(b && b.inputTokens) + num(b && b.outputTokens)
  + num(b && b.cacheReadTokens) + num(b && b.cacheWriteTokens);

/**
 * 读账本并按窗口聚合。
 * @param file token-ledger.json 路径
 * @param opts { sinceDays, fromDay, toDay }
 * @returns { days: [{day, channels:[{channel, provider, accounts, totals, models}]}], totals, missing }
 */
export async function readCreditHistory(file, opts = {}) {
  const empty = { days: [], totals: { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, errors: 0 }, missing: true, today: utc8DayKey(Date.now()) };
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') return empty;

  const todayKey = utc8DayKey(Date.now());
  const sinceDays = Number(opts.sinceDays) > 0 ? Math.floor(Number(opts.sinceDays)) : undefined;
  const cutoffKey = sinceDays === undefined ? undefined : utc8DayKey(Date.now() - (sinceDays - 1) * 86400_000);
  const fromDay = typeof opts.fromDay === 'string' ? opts.fromDay : undefined;
  const toDay = typeof opts.toDay === 'string' ? opts.toDay : undefined;

  const days = [];
  const totals = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, errors: 0 };

  for (const day of Object.keys(raw.days).sort()) {
    if (day > todayKey) continue;                       // 未来键（手工编辑）不展示
    if (cutoffKey !== undefined && day < cutoffKey) continue;
    if (fromDay !== undefined && day < fromDay) continue;
    if (toDay !== undefined && day > toDay) continue;
    const buckets = raw.days[day];
    if (!buckets || typeof buckets !== 'object') continue;

    // 渠道 → 账号 → 模型 三级归并
    const byChannel = new Map();
    for (const key of Object.keys(buckets)) {
      const b = buckets[key];
      if (!b || typeof b !== 'object') continue;
      const seg = String(key).split('|');
      // <kind>|<provider>|<account>|<model>
      const provider = seg.length >= 4 ? seg[1] : (seg[0] || 'unknown');
      const account = seg.length >= 4 ? seg[2] : '';
      const model = seg.length >= 4 ? seg.slice(3).join('|') : (seg[1] || '');
      let ch = byChannel.get(provider);
      if (ch === undefined) { ch = { provider, requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, errors: 0, accounts: new Set(), models: new Map() }; byChannel.set(provider, ch); }
      const tk = tokensOfBucket(b);
      ch.requests += num(b.requests); ch.tokens += tk;
      ch.input += num(b.inputTokens); ch.output += num(b.outputTokens);
      ch.cacheRead += num(b.cacheReadTokens); ch.cacheWrite += num(b.cacheWriteTokens);
      ch.reasoning += num(b.reasoningTokens); ch.errors += num(b.errors);
      if (account.length > 0) ch.accounts.add(account);
      const mm = ch.models.get(model) || { model, requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0 };
      mm.requests += num(b.requests); mm.tokens += tk;
      mm.input += num(b.inputTokens); mm.output += num(b.outputTokens);
      mm.cacheRead += num(b.cacheReadTokens); mm.reasoning += num(b.reasoningTokens);
      ch.models.set(model, mm);
    }
    const channels = [...byChannel.values()].map((c) => ({
      provider: c.provider, requests: c.requests, tokens: c.tokens,
      input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite,
      reasoning: c.reasoning, errors: c.errors, accountCount: c.accounts.size,
      models: [...c.models.values()].sort((x, y) => y.tokens - x.tokens),
    })).sort((x, y) => y.tokens - x.tokens);

    const dayTotals = channels.reduce((acc, c) => {
      acc.requests += c.requests; acc.tokens += c.tokens; acc.input += c.input; acc.output += c.output;
      acc.cacheRead += c.cacheRead; acc.cacheWrite += c.cacheWrite; acc.reasoning += c.reasoning; acc.errors += c.errors;
      return acc;
    }, { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, errors: 0 });

    days.push({ day, channels, totals: dayTotals });
    for (const k of Object.keys(totals)) totals[k] += dayTotals[k];
  }

  days.sort((a, b) => (a.day < b.day ? 1 : -1)); // 新在前
  return { days, totals, missing: false, today: todayKey };
}

/**
 * 把 token 账本 + 倍率表合并成「积分账单」。
 * @param history readCreditHistory 的结果
 * @param factorOf (provider, model) => number|null  返回倍率；null = 未知
 */
export function toCreditBill(history, factorOf) {
  const out = { days: [], totals: { tokens: 0, factored: 0, known: 0, unknown: 0, unknownTokens: 0 }, byChannel: [], byModel: [] };
  if (!history || history.missing === true) return out;
  const chAgg = new Map();
  const modelAgg = new Map();

  for (const day of history.days) {
    const dayRow = { day: day.day, tokens: 0, factored: 0, unknownTokens: 0, channels: [] };
    for (const ch of day.channels) {
      const models = ch.models.map((m) => {
        const factor = factorOf(ch.provider, m.model);
        const known = Number.isFinite(factor);
        return Object.assign({}, m, { factor: known ? factor : null, factored: known ? m.tokens * factor : null });
      });
      const knownModels = models.filter((m) => m.factor !== null);
      const factored = knownModels.reduce((s, m) => s + m.factored, 0);
      const unknownTokens = models.filter((m) => m.factor === null).reduce((s, m) => s + m.tokens, 0);
      dayRow.tokens += ch.tokens; dayRow.factored += factored; dayRow.unknownTokens += unknownTokens;
      dayRow.channels.push({ provider: ch.provider, tokens: ch.tokens, factored, unknownTokens, models });

      const c = chAgg.get(ch.provider) || { provider: ch.provider, tokens: 0, factored: 0, unknownTokens: 0, requests: 0, models: new Map() };
      c.tokens += ch.tokens; c.factored += factored; c.unknownTokens += unknownTokens; c.requests += ch.requests;
      for (const m of models) {
        const key = ch.provider + '|' + m.model;
        const cur = c.models.get(m.model) || { model: m.model, tokens: 0, factored: 0, factor: m.factor, requests: 0 };
        cur.tokens += m.tokens; cur.factored += m.factored || 0; cur.requests += m.requests;
        if (cur.factor === null && m.factor !== null) cur.factor = m.factor;
        c.models.set(m.model, cur);
        const gk = key;
        const g = modelAgg.get(gk) || { provider: ch.provider, model: m.model, tokens: 0, factored: 0, factor: m.factor, requests: 0 };
        g.tokens += m.tokens; g.factored += m.factored || 0; g.requests += m.requests;
        if (g.factor === null && m.factor !== null) g.factor = m.factor;
        modelAgg.set(gk, g);
      }
      chAgg.set(ch.provider, c);
    }
    out.days.push(dayRow);
    out.totals.tokens += dayRow.tokens;
    out.totals.factored += dayRow.factored;
    out.totals.unknownTokens += dayRow.unknownTokens;
  }

  out.byChannel = [...chAgg.values()].map((c) => {
    const modelList = [...c.models.values()].sort((x, y) => y.tokens - x.tokens);
    // 渠道级「倍率」：同渠道下各模型倍率可能不同，不能直接取某一个。
    // 有计费的模型才参与；给加权有效倍率（= 积分 / token）并标记是否混合。
    const known = modelList.filter((m) => m.factor !== null && m.factor !== undefined);
    const factors = new Set(known.map((m) => m.factor));
    const weighted = c.tokens > 0 && c.factored > 0 ? c.factored / c.tokens : null;
    return {
      provider: c.provider, tokens: c.tokens, factored: c.factored, unknownTokens: c.unknownTokens, requests: c.requests,
      models: modelList,
      perCredit: c.factored > 0 ? c.tokens / c.factored : null,
      // 单一倍率时就报那个值；混合时报加权值并标 mixed
      factor: factors.size === 1 ? known[0].factor : (factors.size === 0 ? null : weighted),
      mixedFactor: factors.size > 1,
      factorCount: factors.size,
    };
  }).sort((x, y) => y.tokens - x.tokens);

  out.byModel = [...modelAgg.values()]
    .map((m) => Object.assign({}, m, { perCredit: m.factored > 0 ? m.tokens / m.factored : null }))
    .sort((x, y) => y.tokens - x.tokens);

  out.totals.known = out.byModel.filter((m) => m.factor !== null).length;
  out.totals.unknown = out.byModel.filter((m) => m.factor === null).length;
  out.totals.perCredit = out.totals.factored > 0 ? out.totals.tokens / out.totals.factored : null;
  return out;
}
