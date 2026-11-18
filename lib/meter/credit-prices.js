/**
 * credit-prices.js —— 渠道积分单价的每日自动抓取与回退。
 *
 * 背景：各渠道套餐只给「积分数量」，不给「价格」；渠道 API 也不返回价格。
 * 所以需要从各渠道**公开定价页**抓取，取「最优惠方案」的每积分单价。
 *
 * 抓取失败时的回退策略（逐级降级）：
 *   ① 上次成功抓到的值（缓存）
 *   ② 用户手填的 creditPrices
 *   ③ DeepSeek 官方定价折算（按 1 积分 ≈ 官方 token 价值的反推）
 */

const DAY_MS = 86400000;

/** 各渠道定价源。parser 指明如何从页面文本解析。 */
export const PRICE_SOURCES = [
  {
    provider: 'buddy',
    url: 'https://www.codebuddy.cn/docs/workbuddy/Pricing',
    // 月付 / 连续包月(7折) / 连续包年(5.6折)，取年付折算月
    plans: [
      { name: '标准版月付', price: 99, credits: 4000 },
      { name: '标准版包月', price: 70, credits: 4000 },
      { name: '标准版包年', price: 672 / 12, credits: 4000 },
      { name: '高级版月付', price: 199, credits: 9000 },
      { name: '高级版包月', price: 140, credits: 9000 },
      { name: '高级版包年', price: 1344 / 12, credits: 9000 },
      { name: '旗舰版月付', price: 999, credits: 50000 },
      { name: '旗舰版包月', price: 700, credits: 50000 },
      { name: '旗舰版包年', price: 6720 / 12, credits: 50000 },
    ],
  },
  {
    provider: 'trae',
    url: 'https://www.trae.cn/pricing',
    plans: [
      { name: 'Lite首月', price: 39, credits: 2000 },
      { name: 'Lite原价', price: 49, credits: 2000 },
      { name: 'Pro首月', price: 69, credits: 4000 },
      { name: 'Pro原价', price: 99, credits: 4000 },
      { name: 'Pro+首月', price: 219, credits: 12000 },
      { name: 'Pro+原价', price: 239, credits: 12000 },
      { name: 'Ultra首月', price: 629, credits: 40000 },
      { name: 'Ultra原价', price: 699, credits: 40000 },
    ],
  },
  {
    provider: 'qodercn',
    url: 'https://qoder.com.cn/pricing',
    plans: [
      { name: '专业版双11', price: 19.9, credits: 2000 },
      { name: '专业版原价', price: 59, credits: 2000 },
      { name: '高级版', price: 169, credits: 6000 },
      { name: '旗舰版', price: 559, credits: 20000 },
    ],
  },
  {
    provider: 'minimax',
    url: 'https://platform.minimaxi.com/docs/guides/pricing-token-plan',
    // 积分包按 1,000 积分 = ¥7 换算；¥30→4489、¥150→22460、¥500→74900
    plans: [
      { name: '积分包¥30', price: 30, credits: 4489 },
      { name: '积分包¥150', price: 150, credits: 22460 },
      { name: '积分包¥500', price: 500, credits: 74900 },
    ],
  },
];

/** 取某渠道最优惠方案的单价与方案名。 */
export function bestPlanOf(source) {
  const plans = Array.isArray(source && source.plans) ? source.plans : [];
  let best = null;
  for (const p of plans) {
    if (!p || !(p.price > 0) || !(p.credits > 0)) continue;
    const per = p.price / p.credits;
    if (best === null || per < best.perCredit) best = { name: p.name, perCredit: per, price: p.price, credits: p.credits };
  }
  return best;
}

/** 计算全部渠道的最优单价表。 */
export function buildPriceTable(sources) {
  const list = Array.isArray(sources) ? sources : PRICE_SOURCES;
  const out = {};
  for (const s of list) {
    const best = bestPlanOf(s);
    if (best !== null) out[s.provider] = { perCredit: Math.round(best.perCredit * 1e8) / 1e8, plan: best.name, price: best.price, credits: best.credits };
  }
  return out;
}

/** 是否该刷新（每天一次）。 */
export function shouldRefresh(state, nowMs) {
  if (!state || typeof state.at !== 'number') return true;
  return nowMs - state.at >= DAY_MS;
}

/** 合并：抓取值优先，其次手填，最后官方回退。 */
export function resolvePrice(provider, fetched, manual, officialFallback) {
  const f = fetched && fetched[provider];
  if (f && Number.isFinite(f.perCredit) && f.perCredit > 0) return { perCredit: f.perCredit, source: 'fetched', plan: f.plan };
  const m = manual && manual[provider];
  if (Number.isFinite(m) && m > 0) return { perCredit: m, source: 'manual' };
  if (Number.isFinite(officialFallback) && officialFallback > 0) return { perCredit: officialFallback, source: 'official' };
  return null;
}
/**
 * 从定价页文本中解析套餐（尽力而为）。
 *
 * 各渠道页面结构不同，这里用「锚点 + 就近数字」的启发式：
 *   · Buddy：表格行「标准版 | 免费 | 99 元/月 | 199 元/月 | 999 元/月」+ 包年行
 *   · TRAE：「¥39 /月」+ 「2,000 积分/月」成对出现
 *   · Qoder：「¥59」+ 「2,000 Credits」成对出现
 *
 * 解析失败返回 null（调用方回退到内置常量表）。
 */
export function parsePricingPage(provider, text) {
  const t = String(text || "");
  if (t.length < 100) return null;
  try {
    if (provider === "buddy") {
      // 表格：月付 / 连续包月 / 连续包年 三行，列顺序 = 标准/高级/旗舰
      const m1 = /月付\s*\|\s*免费\s*\|\s*([\d,]+)\s*元\/月\s*\|\s*([\d,]+)\s*元\/月\s*\|\s*([\d,]+)\s*元\/月/.exec(t);
      const m2 = /连续包年[^|]*\|\s*—\s*\|\s*([\d,]+)\s*元\/年\s*\|\s*([\d,]+)\s*元\/年\s*\|\s*([\d,]+)\s*元\/年/.exec(t);
      const m3 = /每月实得积分[^|]*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)/.exec(t);
      if (!m1 || !m3) return null;
      const num = (s) => Number(String(s).replace(/,/g, ""));
      const monthly = [num(m1[1]), num(m1[2]), num(m1[3])];
      const yearly = m2 ? [num(m2[1]), num(m2[2]), num(m2[3])] : [null, null, null];
      // m3 有 4 列（含体验版），标准/高级/旗舰 是后三列
      const credits = [num(m3[2]), num(m3[3]), num(m3[4])];
      const names = ["标准版", "高级版", "旗舰版"];
      const plans = [];
      for (let i = 0; i < 3; i += 1) {
        if (monthly[i] > 0 && credits[i] > 0) plans.push({ name: names[i] + "月付", price: monthly[i], credits: credits[i] });
        if (yearly[i] > 0 && credits[i] > 0) plans.push({ name: names[i] + "包年", price: Math.round(yearly[i] / 12 * 100) / 100, credits: credits[i] });
      }
      return plans.length > 0 ? plans : null;
    }
    if (provider === "trae") {
      // 真实 HTML 转文本格式：
      //   「会员 Lite」→「低至¥39」→「/月¥49」→「2,000 积分/月」
      // 按「会员 X」切段，段内取 ¥ 数字（首个=促销价，/月后=原价）
      const plans = [];
      const segs = t.split(/会员\s*/);
      for (let k = 1; k < segs.length; k += 1) {
        const seg = segs[k];
        const nm = /^(Lite|Pro\+|Pro|Ultra|Free)\b/.exec(seg);
        if (nm === null) continue;
        const cm = /([\d,]+)\s*积分\/月/.exec(seg);
        if (cm === null) continue;
        const credits = Number(cm[1].replace(/,/g, ""));
        if (!(credits > 0)) continue;
        const prices = [...seg.matchAll(/[¥￥]\s*([\d,]+(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, "")));
        const label = "会员 " + nm[1];
        if (prices.length > 0 && prices[0] > 0) plans.push({ name: label + "首月", price: prices[0], credits });
        if (prices.length > 1 && prices[1] > 0 && prices[1] !== prices[0]) plans.push({ name: label + "原价", price: prices[1], credits });
      }
      return plans.length > 0 ? plans : null;
    }
    if (provider === "minimax") {
      // 「| **¥30**  | **4,489 积分** |」三行积分包 + 「1,000 积分 = ¥7」说明
      const plans = [];
            const re = /[¥￥]\s*(\d+)\s*\*{0,2}\s*\|\s*\*{0,2}([\d,]+)\s*积分/g;
      let mm;
      while ((mm = re.exec(t)) !== null) {
        const price = Number(mm[1]);
        const credits = Number(mm[2].replace(/,/g, ""));
        if (price > 0 && credits > 0) plans.push({ name: "积分包¥" + price, price, credits });
      }
      return plans.length > 0 ? plans : null;
    }
    if (provider === "qodercn") {
      // 「### ¥59」…「基础 2,000 Credits」
      const plans = [];
      const blocks = t.split(/####/);
      for (const b of blocks) {
        const pm = /[¥￥]\s*([\d,]+(?:\.\d+)?)\s*(?:\/月)?/.exec(b);
        const cm = /([\d,]+)\s*Credits/.exec(b);
        const nm = /^\s*([\u4e00-\u9fa5A-Za-z0-9+\s]{2,20})/.exec(b);
        if (pm && cm && nm) {
          const price = Number(pm[1].replace(/,/g, ""));
          const credits = Number(cm[1].replace(/,/g, ""));
          if (price > 0 && credits > 0) plans.push({ name: nm[1].trim(), price, credits });
        }
      }
      return plans.length > 0 ? plans : null;
    }
  } catch (e) { return null; }
  return null;
}
/**
 * 无抓取价格时的统一回退单价（按 DeepSeek 官方价折算）。
 *
 * 思路（用户方案）：
 *   已知「token 量 : 积分消耗」的比例（baseAt1x，1 积分 ≈ N token），
 *   再用 DeepSeek 官方 token 单价，反推「1 积分 ≈ 多少元」。
 *
 * 官方参考价（CNY / 1M token，2026 年常见档）：
 *   输入 ¥2、输出 ¥8、缓存读 ¥0.5
 * 取加权平均（按典型 8:2 输入输出比）：
 *   0.8×2 + 0.2×8 = ¥3.2 / 1M token
 *
 * 所以：1 积分价格 = baseAt1x(1积分对应token数) / 1e6 × 3.2
 */
export const DS_OFFICIAL_CNY_PER_MTOK = 3.2;

export function officialFallbackPrice(baseAt1x) {
  const n = Number(baseAt1x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 1e6) * DS_OFFICIAL_CNY_PER_MTOK;
}

/**
 * 全局默认积分单价：所有「抓不到价格」且「无 baseAt1x 可反推」的渠道统一使用。
 *
 * 取值依据：已抓取渠道的中位数（MiniMax ¥0.00668 / Qoder ¥0.00995 /
 *          CodeBuddy ¥0.0112 / TRAE ¥0.015725）→ 中位数约 ¥0.0106。
 * 用户也可在设置页手填覆盖。
 */
export const DEFAULT_CREDIT_PRICE = 0.0106;

/**
 * DeepSeek 官方定价（CNY / 1M token），来源：
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 抓取时间：2026-11-17
 *
 * 空闲/高峰：工作日 9:00-12:00、14:00-18:00 为高峰，其余为空闲。
 * 空闲价 = 高峰价的一半。
 */
export const DS_OFFICIAL_PRICING = {
  "deepseek-flash": {
    cacheHit:  { idle: 0.02, peak: 0.04 },
    cacheMiss: { idle: 1.0,  peak: 2.0 },
    output:    { idle: 4.0,  peak: 8.0 },
  },
  "deepseek-v4-pro": {
    cacheHit:  { idle: 0.15, peak: 0.30 },
    cacheMiss: { idle: 4.5,  peak: 9.0 },
    output:    { idle: 13.5, peak: 27.0 },
  },
};

/** 判断是否高峰时段（北京时间）。 */
export function isPeakHour(nowMs) {
  const d = new Date(Number(nowMs) + 8 * 3600000);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false; // 周末全天空闲
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 用官方定价精确计算一次调用的费用（元）。
 * 这是「没有渠道积分单价」时的最佳回退——不再用加权平均粗估。
 */
export function officialCostOf(modelId, buckets, nowMs) {
  const b = buckets || {};
  const mid = String(modelId || "");
  // 匹配官方模型：deepseek-v4-pro 是「Pro」，其余 flash 类都按 flash 价
  const key = /v4-pro|v4\.?pro|pro-0813/i.test(mid) ? "deepseek-v4-pro" : "deepseek-flash";
  const p = DS_OFFICIAL_PRICING[key];
  if (!p) return null;
  const peak = isPeakHour(nowMs) ? "peak" : "idle";
  const M = 1e6;
  const cacheHit = (Number(b.cacheRead) || 0) / M * p.cacheHit[peak];
  const cacheMiss = ((Number(b.input) || 0) + (Number(b.cacheWrite) || 0)) / M * p.cacheMiss[peak];
  const output = ((Number(b.output) || 0) + (Number(b.reasoning) || 0)) / M * p.output[peak];
  const total = cacheHit + cacheMiss + output;
  return Number.isFinite(total) ? Math.round(total * 1e8) / 1e8 : null;
}

/**
 * 缓存加权计价：按「缓存命中 / 未命中 / 输出」分别计价。
 *
 * 官方价目（CNY / 1M token，DeepSeek flash）：
 *   缓存命中   ¥0.02（空闲）/ ¥0.04（高峰）
 *   缓存未命中 ¥1.0  / ¥2.0
 *   输出       ¥4.0  / ¥8.0
 *
 * 比例：命中 : 未命中 : 输出 = 1 : 50 : 200
 *
 * 当上游不返回 cacheRead 时（如 trae），可用 assumedHitRate 估算：
 *   把 input 按 assumedHitRate 拆成「命中」和「未命中」两部分。
 */
export function officialCostWeighted(modelId, buckets, nowMs, assumedHitRate) {
  const b = buckets || {};
  const mid = String(modelId || "");
  const key = /v4-pro|v4\.?pro|pro-0813/i.test(mid) ? "deepseek-v4-pro" : "deepseek-flash";
  const p = DS_OFFICIAL_PRICING[key];
  if (!p) return null;
  const peak = isPeakHour(nowMs) ? "peak" : "idle";
  const M = 1e6;
  const rawInput = Number(b.input) || 0;
  const explicitCache = Number(b.cacheRead) || 0;
  const cacheWrite = Number(b.cacheWrite) || 0;
  const output = (Number(b.output) || 0) + (Number(b.reasoning) || 0);
  // 上游没给 cacheRead 但有 input 时，用假定的命中率拆分
  let hitTok = explicitCache;
  let missTok = rawInput + cacheWrite;
  if (explicitCache === 0 && rawInput > 0 && Number.isFinite(assumedHitRate) && assumedHitRate > 0 && assumedHitRate < 1) {
    hitTok = rawInput * assumedHitRate;
    missTok = rawInput * (1 - assumedHitRate) + cacheWrite;
  }
  const total = hitTok / M * p.cacheHit[peak] + missTok / M * p.cacheMiss[peak] + output / M * p.output[peak];
  return {
    total: Number.isFinite(total) ? Math.round(total * 1e8) / 1e8 : null,
    hitTok: Math.round(hitTok),
    missTok: Math.round(missTok),
    output: Math.round(output),
    assumed: explicitCache === 0 && Number.isFinite(assumedHitRate) && assumedHitRate > 0,
    peak: peak,
  };
}
