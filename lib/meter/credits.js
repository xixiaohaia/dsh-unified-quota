/**
 * 积分倍率与等效量。
 *
 * 很多白嫖渠道按「积分」计费，而每个模型消耗的积分倍率不同（展示名尾部 `· x3.0`
 * 表示这个模型每次消耗 3 倍积分）。要看懂「到底用了多少积分」，必须把 token
 * 折算成「积分当量」：tokens × 倍率。
 *
 * 倍率解析规则移植自 dsh-providers-hub 的 priceFactorFromName（MIT），那里记录了
 * 真实踩过的坑，逐条保留：
 *   1. 倍率前必须有分隔符（中点或乘号）——否则 Spark X2.5 / GPT-X5 / Grok x4 这类
 *      名字里本来带 x+数字 的模型会被误判成倍率，导致「挑最便宜」反而挑到最贵的。
 *   2. 促销形态是 `· x0.17→x0.50`，取箭头右侧（实际计费倍率）。
 *   3. 名字含「免费」按 0；解析不出按 Infinity（排在有标注的之后）。
 */

// 分隔符：中点(U+00B7) 或 乘号(U+00D7)
const SEP = "[\u00B7\u00D7]";
const FACTOR_RE = new RegExp(SEP + "\\s*[\u00D7x]?\\s*(\\d+(?:\\.\\d+)?)(?:\\s*[\u2192>]\\s*[\u00D7x]?\\s*(\\d+(?:\\.\\d+)?))?\\s*$", "i");

/** 从目录展示名解析倍率。 */
/**
 * 解析峰谷倍率。
 * 渠道常用 "x0.12→x0.06" 表示「峰时 x0.12 → 谷时 x0.06」。
 * 返回 { peak, idle }：无峰谷时两者相同（或 idle=null 表示不区分）。
 */
export function parsePeakValleyFactor(name) {
  const text = typeof name === 'string' ? name : '';
  if (text.indexOf('免费') >= 0 || /free\b|\btrial\b|限免/i.test(text)) {
    return { peak: 0, idle: 0, free: true };
  }
  // 形如 x0.12→x0.06 或 x0.12->x0.06 或 0.12→0.06
  const pv = /x?([\d.]+)\s*(?:→|->|~|至)\s*x?([\d.]+)/i.exec(text);
  if (pv !== null) {
    const a = Number(pv[1]);
    const b = Number(pv[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { peak: a, idle: b, free: false, hasPeakValley: true };
    }
  }
  const single = priceFactorFromName(text);
  return { peak: single, idle: single, free: single === 0, hasPeakValley: false };
}

/** 按时段取倍率。isPeak=true 取峰时价。 */
export function factorAtTime(name, isPeak) {
  const pv = parsePeakValleyFactor(name);
  if (pv.free) return 0;
  if (!pv.hasPeakValley) return pv.peak;
  return isPeak ? pv.peak : pv.idle;
}

export function priceFactorFromName(name) {
  const text = typeof name === "string" ? name : "";
  // 免费模型识别（多种命名约定）：
  //   「免费」「free」「-free」「_free」「Free」「trial」「限免」
  // 实测：hy4flash-free / deepseek-v4.1-flash-free 这类模型名里带 free，
  // 但原解析器只认中文「免费」⇒ 返回 Infinity（未知）⇒ 被当成 ×1 计费，凭空多算钱。
  if (text.indexOf("免费") >= 0) return 0;
  // 覆盖：free 作为词尾（hy4free）、-free、_free、Free、trial、限免
  if (/free\b|\btrial\b|限免/i.test(text)) return 0;
  const m = FACTOR_RE.exec(text.trim());
  if (m === null) return Number.POSITIVE_INFINITY;
  const raw = m[2] !== undefined ? m[2] : m[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/** 倍率是否可用于计算（有限值才算）。 */
export const usableFactor = (f) => Number.isFinite(f) && f >= 0;

/** 计算「积分当量」。 */
export function creditEquivalent(tokens, factor, baselineFactor = 1) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return null;
  if (!usableFactor(factor)) return null;
  const base = usableFactor(baselineFactor) && baselineFactor > 0 ? baselineFactor : 1;
  return { factored: t * factor, baseline: (t * factor) / base, factor };
}

/** 一组 { name|model, tokens } 的积分当量汇总；未知倍率单独计数不混入合计。 */
export function summarizeCredits(rows) {
  const out = { factored: 0, tokens: 0, known: 0, unknown: 0, unknownTokens: 0, factors: {} };
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || {};
    const tokens = Number(row.tokens) || 0;
    if (tokens <= 0) continue;
    const factor = row.factor !== undefined ? row.factor : priceFactorFromName(row.name || row.model);
    out.tokens += tokens;
    if (!usableFactor(factor)) { out.unknown += 1; out.unknownTokens += tokens; continue; }
    out.known += 1;
    out.factored += tokens * factor;
    const key = String(factor);
    out.factors[key] = (out.factors[key] || 0) + tokens;
  }
  return out;
}

/** 「1 积分 ≈ 多少 token」与「1 token ≈ 多少积分」；缺数据返回 null 而不是瞎猜。 */
export function creditEfficiency(input) {
  const bal = Number(input && input.balance);
  const used = Number(input && input.usedEquivalent);
  const tok = Number(input && input.tokens);
  const out = { perCredit: null, perToken: null, totalCredits: null };
  if (!Number.isFinite(bal) || !Number.isFinite(used) || used <= 0) return out;
  out.totalCredits = bal + used;
  if (Number.isFinite(tok) && tok > 0) {
    out.perCredit = tok / used;
    out.perToken = used / tok;
  }
  return out;
}
