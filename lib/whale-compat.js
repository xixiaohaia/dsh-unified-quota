/**
 * whale-compat.js — 把 dsh-unified-quota 的数据映射成小鲸鱼挂件的响应格式。
 *
 * 纯函数模块：不读文件、不依赖 ctx，输入数据对象，输出可 JSON.stringify 的 payload。
 * 这样可在 Node 里独立测试，宿主路由只负责喂数据与序列化。
 *
 * 契约来源：dsh-whale-widget v0.4.2 的 usageRecordsPayload()/publicBalance()/last-turn 路由。
 */

const DAY_MS = 86400000;
function dayKey(ms) { const d = new Date(Number(ms) + 8 * 3600000); return d.toISOString().slice(0, 10); }
function finite(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function tokensOf(bucket) { if (!bucket) return 0; return finite(bucket.input) + finite(bucket.output) + finite(bucket.cacheRead) + finite(bucket.cacheWrite) + finite(bucket.reasoning); }

/**
 * balance.json → { ok, totalBalance, currency, isPeak, todayUsage, ... }
 * @param {{days:object, balanceLog:object, nowMs:number}} input
 */
export function balancePayload(input) {
  const days = (input && input.days) || {};
  const log = (input && input.balanceLog) || {};
  const nowMs = (input && input.nowMs) || Date.now();
  const today = dayKey(nowMs);
  const day = days[today] || null;
  // 今日消费：优先实付(apiCostCny)，其次 apiCost，再 cost
  const todayUsage = day ? finite(day.apiCostCny || day.apiCost || day.cost) : 0;
  // 最近余额：balance-log 里最新的快照（按 at 排序）
  let lastBalance = null;
  let lastAt = 0;
  for (const entries of Object.values(log.entries || {})) {
    for (const e of (Array.isArray(entries) ? entries : [])) {
      if (!e || !Number.isFinite(e.at)) continue;
      if (e.at > lastAt) { lastAt = e.at; lastBalance = finite(e.total); }
    }
  }
  const hour = new Date(nowMs + 8 * 3600000).getUTCHours();
  const isPeak = hour >= 9 && hour < 12 || hour >= 14 && hour < 18;
  return {
    ok: true, code: "OK", totalBalance: lastBalance, currency: "CNY",
    updatedAt: new Date(nowMs).toISOString(),
    isPeak: isPeak, todayUsage: Math.round(todayUsage * 1e8) / 1e8,
    todayUsageCurrency: "CNY", usageSource: "unified-quota-ledger", usageMode: "ledger",
    usageLabel: "dsh-unified-quota",
  };
}

/**
 * last-turn.json → { ok, seq, turn, amount, tokens, ts }
 * @param {{lastSession:object, seq:number}} input
 */
export function lastTurnPayload(input) {
  const s = (input && input.lastSession) || null;
  const seq = finite((input && input.seq) || 0);
  // 没有 lastSession 时也必须返回真实 seq，否则挂件的 seq > lastCostSeq 永不成立
  if (!s) return { ok: true, seq: seq, turn: null, amount: null, tokens: null, ts: null };
  return {
    ok: true, seq: seq,
    turn: finite(s.turn) || null,
    // 分项（token 构成 + 缓存命中率 + 是否按积分口径计价）
    breakdown: (s.breakdown && typeof s.breakdown === 'object') ? s.breakdown : null,
    creditBasis: s.creditBasis === true,
    free: s.free === true,
    amount: Number.isFinite(s.apiCostCny) ? s.apiCostCny : Number.isFinite(s.apiCost) ? s.apiCost : null,
    tokens: Number.isFinite(s.tokens) ? s.tokens : (finite(s.input) + finite(s.output) + finite(s.cacheRead) + finite(s.cacheWrite) + finite(s.reasoning)),
    ts: finite(s.at),
  };
}

/**
 * usage-records.json → { ok, today:{date,total,models,...}, days7, all:{days,events}, settings }
 * @param {{days:object, nowMs:number, settings:object}} input
 */
export function usageRecordsPayload(input) {
  const days = (input && input.days) || {};
  const nowMs = (input && input.nowMs) || Date.now();
  const today = dayKey(nowMs);
  function modelsFor(day) {
    const d = days[day];
    if (!d) return [];
    return Object.entries(d.byProviderModel || {}).map(function (kv) {
      return { model: kv[0], cost: finite(kv[1].cost), source: "ledger", currency: "CNY", tokens: tokensOf(kv[1]) };
    }).sort(function (a, b) { return b.cost - a.cost; });
  }
  function forDay(date) {
    const d = days[date] || {};
    const models = modelsFor(date);
    const amount = finite(d.apiCostCny || d.apiCost || d.cost);
    return { date: date, day: date, amount: amount, total: amount, models: models,
      modelTotal: models.reduce(function (s, m) { return s + m.cost; }, 0), modelCurrency: "CNY",
      tokens: Object.values(d.byProviderModel || {}).reduce(function (s, b) { return s + tokensOf(b); }, 0),
      calls: finite(d.calls), source: "unified-quota-ledger" };
  }
  const todayData = forDay(today);
  const recent = Object.keys(days).filter(function (k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); }).sort().reverse();
  const days7 = recent.slice(0, 7).map(forDay);
  const total7 = days7.reduce(function (s, d) { return s + d.amount; }, 0);
  // events：从各天的 byProviderModel 展开，供挂件的逐次提示用（按天聚合，非逐次调用）
  const events = [];
  for (const date of recent.slice(0, 90)) {
    const d = days[date] || {};
    for (const kv of Object.entries(d.byProviderModel || {})) {
      events.push({ ts: Date.parse(date + "T12:00:00+08:00"), day: date, model: kv[0],
        cost: finite(kv[1].cost), tokens: tokensOf(kv[1]) });
    }
  }
  events.sort(function (a, b) { return b.ts - a.ts; });
  return { ok: true, version: "5.8", today: todayData, days7: days7,
    total7: Math.round(total7 * 1e8) / 1e8, total7Currency: "CNY", total7ByCurrency: { CNY: total7 },
    all: { days: recent.map(forDay), events: events.slice(0, 500) },
    settings: (input && input.settings) || {} };
}

/** api-models.json → { ok, models:[{id,name}] }（倍率名挂件自己解析） */
export function apiModelsPayload(models) {
  const list = Array.isArray(models) ? models : [];
  return { ok: true, models: list.map(function (m) {
    return { id: String(m.id || m.model || ""), name: String(m.name || m.id || m.model || "") };
  }) };
}

/** usage-settings.json（读取）→ 原样返回，写入由宿主负责 */
export function usageSettingsPayload(settings) { return Object.assign({ ok: true }, settings || {}); }
// ===== 配置类默认值（与 dsh-whale-widget v0.4.2 对齐，用户数据文件共用同一路径）=====

/** size.json 默认值（外观/音效设置） */
export const SIZE_DEFAULTS = {
  scale: 0.7, sound: true, vol: 0.9, soundSet: "duck", usageMode: "ledger", peakMode: "default",
  bubbleOn: true, pressOn: true, turnCostOn: true, turnCostCloseMs: 5000,
  scrollGapOn: true, scrollGapPx: 14, menuBtnHide: false, codexStatsOn: true,
};

/** 合并用户配置与默认值，确保 15 个字段齐全 */
export function normalizeSize(raw) {
  const out = Object.assign({}, SIZE_DEFAULTS);
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(SIZE_DEFAULTS)) if (raw[k] !== undefined) out[k] = raw[k];
    if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  }
  return out;
}

/** 校验并规范化 size 写入请求；返回 null 表示非法 */
export function acceptSizePatch(raw, nowIso) {
  if (!raw || typeof raw !== "object") return null;
  const cur = normalizeSize(null);
  const out = Object.assign({}, cur);
  if (typeof raw.scale === "number" && raw.scale >= 0.3 && raw.scale <= 2) out.scale = raw.scale;
  for (const k of ["sound","bubbleOn","pressOn","turnCostOn","scrollGapOn","menuBtnHide","codexStatsOn"]) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  if (typeof raw.vol === "number" && raw.vol >= 0 && raw.vol <= 1) out.vol = raw.vol;
  if (typeof raw.soundSet === "string" && raw.soundSet.length > 0) out.soundSet = raw.soundSet;
  if (raw.usageMode === "ledger" || raw.usageMode === "cost") out.usageMode = raw.usageMode;
  if (raw.peakMode === "default" || raw.peakMode === "liangwen" || raw.peakMode === "qiangqiang") out.peakMode = raw.peakMode;
  if (typeof raw.turnCostCloseMs === "number" && raw.turnCostCloseMs >= 0 && raw.turnCostCloseMs <= 600000) out.turnCostCloseMs = raw.turnCostCloseMs;
  if (typeof raw.scrollGapPx === "number" && raw.scrollGapPx >= 0 && raw.scrollGapPx <= 200) out.scrollGapPx = raw.scrollGapPx;
  out.updatedAt = nowIso || new Date().toISOString();
  return out;
}

/** 用量设置默认值（任务结束音/预警/预算等） */
export function usageSettingsDefaults() {
  return { taskEnd: { on: true, sel: "frag:cost_a" }, subagent: { mute: true }, wait: { charClose: false }, events: {}, budget: { on: false, amount: 0 } };
}

/** 空音效索引 / 空气泡图索引 */
export const AUDIO_INDEX_DEFAULT = { version: 1, groups: [], fragments: [] };
export const BUBBLE_IMG_INDEX_DEFAULT = { version: 1, images: [] };
export const BUBBLE_DEFAULT = { items: [], lib: [] };
/** 内置气泡图（随包 assets） */
export const DEFAULT_BUBBLE_IMGS = [
  { id: "bimg_petpet", name: "petpet", file: "bubble-petpet.gif", format: "gif", url: "/dsh-whale/bubble-img.png?id=bimg_petpet" },
  { id: "bimg_money1", name: "money1", file: "bubble-money1.gif", format: "gif", url: "/dsh-whale/bubble-img.png?id=bimg_money1" },
];

/** about.json 载荷（自检信息，只给路径遮蔽后的统计） */
export function aboutPayload(input) {
  const i = input || {};
  return {
    ok: true, name: "dsh-unified-quota (whale-compat)", version: i.version || "5.8",
    widget: "/dsh-whale/widget.js",
    dataMode: "unified-quota-ledger",
    files: i.files || [],
    ledger: i.ledger || null,
    note: "数据由 dsh-unified-quota 提供；外观/音效配置沿用原有路径",
  };
}

/** wait.json：等待交互状态（本插件不挂起任何交互，恒返回空） */
export function waitPayload() { return { ok: true, pending: null, at: Date.now() }; }

/** update-check.json：不联网检查，恒返回最新 */
export function updateCheckPayload(version) { return { ok: true, current: version || "5.8", latest: version || "5.8", hasUpdate: false, checkedAt: Date.now() }; }
