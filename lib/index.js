/**
 * dsh-unified-quota — 统一额度中心（宿主半）
 *
 * 一个只读取、零记账、零写操作的聚合面。数据全部来自本机既有事实源：
 *   1. ~/.dsh/storages/cost-meter/ledger.json      —— dsh-cost-meter 的账本（费用统计）。
 *      该文件由写侧 temp+fsync+rename 原子替换（store.js/ledger-persistence.js 已核实），
 *      读侧只需容忍"文件可能刚被换掉"，因此这里只 readFile + JSON.parse，不加锁不写回。
 *      取：今日/本月费用（CNY 冻结列 costCny）、逐 provider:model 桶、官方余额快照 balanceRef。
 *   2. ~/.dsh/channel-pack/state.json              —— 白嫖渠道账号名册（dsh-free-model）。
 *      取：provider/nickname/enabled/expiresAt。credentialRef 刻意丢弃，凭据值一律不读。
 *   3. channel-pack RPC credits.balances           —— 经 connection 进程内 owner-peer 桥。
 *      （此路已在旧插件上实测：buddy/qodercn/trae/zcode 全部返回真实余额。）
 *   4. ~/.dsh/.dshw-usage.json / .dshw-turn.json   —— 小鲸鱼观测（只读其落盘，不碰其路由）。
 *
 * 刻意不做的事：不写任何文件、不调任何写接口、不 import 任何 @deepseek-ai/* 包
 * （保持任意 profile 布局可解析），不复制鲸鱼美术素材（其 PROVENANCE 声明 assets/ 不在 MIT 内）。
 * 路由与旧 fork 同规矩：仅回环可读、拒绝 cross-site、不回显任何凭据。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { QuotaLedger, localDayKey as meterDayKey } from './meter/ledger.js';
import { createStreamMeter } from './meter/stream-meter.js';
import { providerPriceEntryFor, costOf, DEFAULT_PRICE_TABLE } from './meter/pricing.js';
import { ConfigStore, defaultConfig, billingConfigOf } from './meter/config.js';
import { DailyRates } from './meter/rates.js';
import { priceFactorFromName, usableFactor, summarizeCredits, creditEfficiency } from './meter/credits.js';
import { PRICE_SOURCES, buildPriceTable, resolvePrice, shouldRefresh, parsePricingPage, bestPlanOf, officialFallbackPrice, DEFAULT_CREDIT_PRICE, officialCostOf, officialCostWeighted } from './meter/credit-prices.js';
import { debugEnabled, debugLog, safeCatch, criticalCatch, DEBUG_ON } from './debug.js';
import { uploadBackup, fetchRemoteMeta, compareBackup, restoreBackup, syncMerge } from './webdav.js';
import { readCreditHistory, toCreditBill, utc8DayKey } from './meter/credit-bill.js';
import { balancePayload as whaleBalance, usageRecordsPayload as whaleUsage, lastTurnPayload as whaleLastTurnPayload, apiModelsPayload as whaleModels, usageSettingsPayload as whaleSettings, SIZE_DEFAULTS, normalizeSize, acceptSizePatch, usageSettingsDefaults, AUDIO_INDEX_DEFAULT, BUBBLE_IMG_INDEX_DEFAULT, BUBBLE_DEFAULT, DEFAULT_BUBBLE_IMGS, aboutPayload as whaleAbout, waitPayload as whaleWait, updateCheckPayload as whaleUpdateCheck } from './whale-compat.js';

export const name = 'unified-quota';
// connection：channel-pack 桥需要它调 credits.balances。
// 不声明会导致插件在 connection 就绪前加载 ⇒ ctx.get('connection') 为 undefined
// ⇒ 所有渠道额度显示「宿主未提供 connection 服务」。
export const inject = ['webServer', 'connection'];

// 测试专用导出（不影响运行时）
export const __test__ = { parseJetHubCap, cacheHitRateByModel, realConsumption };

export const API = {
  core: '/api/unified-quota/core',
  detail: '/api/unified-quota/detail',
  config: '/api/unified-quota/config',
  exportCsv: '/api/unified-quota/export',
  calls: '/api/unified-quota/calls',
  credits: '/api/unified-quota/credits',
  quota: '/api/unified-quota/quota',
  current: '/api/unified-quota/current',
  beacon: '/api/unified-quota/beacon'
};

/** 客户端挂载进度（仅内存，诊断用；重启即清空）。 */
const beacons = [];

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
const DEBUG_DIR = path.join(DSH_HOME, 'storages', 'unified-quota');

/** 自有账本：与 cost-meter 完全独立，卸载它不影响记账。 */
const OWN_LEDGER_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'ledger.json');
const STORAGE_DIR = path.join(DSH_HOME, 'storages', 'unified-quota');
/** 设备 ID：用于云端元信息标注来源（换机时能看出是谁传的）。 */
const DEVICE_ID = (function () {
  try { return String(os.hostname() || 'device') .slice(0, 40); } catch (e) { return 'device'; }
})();
/** 历史一次导入源（cost-meter 的账本）；导入后不再依赖它。 */
const LEGACY_LEDGER_PATH = path.join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json');
/** 配置单独一个文件，避免改设置时重写账本。 */
const CONFIG_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'config.json');
/** 构建标识：与客户端常量比对，用来发现「客户端已更新、宿主未重启」的错配。 */
const BUILD = '7.26.2';
const RATES_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'rates.json');
/** jet-hub 的 token 账本（日×渠道×账号×模型），只读。 */
const TOKEN_LEDGER_PATH = path.join(DSH_HOME, 'jet-hub', 'token-ledger.json');
/** 余额快照历史：用于反推真实积分扣减（P2）。 */
const BALANCE_LOG_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json');
// 名册来源按新→旧依次尝试（Jet Hub 是 channel-pack 的继任者，账号结构一致）
const ROSTER_CANDIDATES = [
  path.join(DSH_HOME, 'jet-hub', 'state.json'),
  path.join(DSH_HOME, 'channel-pack', 'state.json')
];
const WHALE_USAGE_PATH = path.join(DSH_HOME, '.dshw-usage.json');
const WHALE_TURN_PATH = path.join(DSH_HOME, '.dshw-turn.json');

const RPC_ENDPOINTS = [
  { path: '/api/jet-hub', channel: 'jet-hub', label: 'Jet Hub' },
  { path: '/api/channel-pack', channel: 'channel-pack', label: '模型接入' }
];
const CREDITS_TTL_MS = 60_000;
const PER_PROVIDER_TIMEOUT_MS = 20_000;

// —— 小工具 ————————————————————————————————————————————————

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === 'string' ? v : '');

/** 带 mtime 指纹的 JSON 文件读取：文件没变就不重复 parse；损坏/缺失 → null，绝不抛。 */
const fileCache = new Map();
async function readJsonCached(file) {
  let stat = null;
  try { stat = await fs.stat(file); } catch { fileCache.delete(file); return null; }
  const stamp = stat.mtimeMs + ':' + stat.size;
  const hit = fileCache.get(file);
  if (hit !== undefined && hit.stamp === stamp) return hit.value;
  let value = null;
  try {
    if (stat.size > 64 * 1024 * 1024) throw new Error('ledger too large');
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { value = null; }
  fileCache.set(file, { stamp, value });
  return value;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// —— channel-pack 进程内桥（与旧 fork 同配方，已实测可用） ————————

const bridgeMemo = new WeakMap();

// —— 渠道积分单价（每日抓取 + 回退）————————————————————————
const CREDIT_PRICE_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'credit-prices.json');
let creditPriceCache = null;

async function loadCreditPrices() {
  if (creditPriceCache !== null) return creditPriceCache;
  try { creditPriceCache = JSON.parse(await fs.readFile(CREDIT_PRICE_PATH, 'utf8')) || null; } catch (e) { creditPriceCache = null; }
  return creditPriceCache;
}

async function saveCreditPrices(state) {
  creditPriceCache = state;
  try {
    await fs.mkdir(path.dirname(CREDIT_PRICE_PATH), { recursive: true });
    const tmp = CREDIT_PRICE_PATH + '.tmp-' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, CREDIT_PRICE_PATH);
  } catch (e) { /* 尽力而为 */ }
}

/** 每日刷新一次：抓定价页 → 取最优方案单价。抓取失败保留旧值。 */
async function refreshCreditPrices(ctx) {
  const state = await loadCreditPrices();
  if (!shouldRefresh(state, Date.now())) return state;
  // 真正抓取：逐渠道拉定价页 → 解析套餐 → 取最优单价。
  // 解析失败或网络失败时回退到内置常量表（PRICE_SOURCES 里的 plans 快照）。
  const table = {};
  const detail = {};
  for (const s of PRICE_SOURCES) {
    let plans = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 12000);
      let text = '';
      try {
        const res = await fetch(s.url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; dsh-unified-quota)' } });
        if (res.ok) text = await res.text();
      } finally { clearTimeout(timer); }
      // HTML → 纯文本（去标签，保留结构换行）
      const plain = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' | ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ');
      plans = parsePricingPage(s.provider, plain);
    } catch (e) { plans = null; }
    if (plans !== null && plans.length > 0) {
      const best = bestPlanOf({ plans });
      if (best !== null) {
        table[s.provider] = { perCredit: Math.round(best.perCredit * 1e8) / 1e8, plan: best.name, price: best.price, credits: best.credits };
        detail[s.provider] = { ok: true, plans: plans.length, plan: best.name };
        continue;
      }
    }
    // 回退：内置常量
    const fallback = buildPriceTable([s]);
    if (fallback[s.provider]) { table[s.provider] = fallback[s.provider]; detail[s.provider] = { ok: false, plans: 0, fallback: true }; }
    else detail[s.provider] = { ok: false, plans: 0, fallback: false };
  }
  const next = { at: Date.now(), table, detail, sources: PRICE_SOURCES.map((s) => ({ provider: s.provider, url: s.url })) };
  await saveCreditPrices(next);
  return next;
}

/**
 * 从账本反推「同模型」的缓存命中率（供不返回 cacheRead 的渠道参考）。
 *
 * 依据（实测）：同一模型跨渠道命中率高度一致
 *   deepseek-v4.1-flash: workbuddy 99.4% / buddy 99.2% / codearts 97.6% / codearts-1017 94.1%
 * 因为缓存命中取决于「上下文长度 + 厂商前缀缓存策略」，与渠道几乎无关。
 *
 * 排除免费模型（hy4free 15.4% / hy4flash-free 1.6%）—— 它们走短上下文，会把均值拉低。
 */
function cacheHitRateByModel(ledgerRaw, modelId) {
  const mid = String(modelId || '');
  if (mid.length === 0) return null;
  let hitSum = 0, totSum = 0, n = 0;
  const target = mid.toLowerCase();
  for (const day of Object.values((ledgerRaw && ledgerRaw.days) || {})) {
    for (const [key, v] of Object.entries(day.byProviderModel || {})) {
      const model = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : key;
      const ml = model.toLowerCase();
      // 模型名严格匹配（glm-5.3 与 glm-5.3-flash 是不同模型，不能合并）
      //   ① 完全相同
      //   ② 一方 = 另一方 + 版本/日期后缀（-1017 / -0813 / -v1 / -20260101）
      //   ③ _ 与 . 等价（deepseek-v4_1 ≡ deepseek-v4.1）
      const norm = function (s) { return s.replace(/_/g, ".").replace(/\s+/g, ""); };
      const lt = norm(ml), tt = norm(target);
      const VERSION_SUFFIX = /^[-.](v?\d{2,}|\d{4}-?\d{2}-?\d{2})$/;
      let matched = false;
      if (lt === tt) matched = true;
      else if (lt.indexOf(tt) === 0) { if (VERSION_SUFFIX.test(lt.slice(tt.length))) matched = true; }
      else if (tt.indexOf(lt) === 0) { if (VERSION_SUFFIX.test(tt.slice(lt.length))) matched = true; }
      if (!matched) continue;
      // 排除免费模型（名字含 free）
      if (/free/.test(ml)) continue;
      // ⚠️ 关键：某些渠道（trae）上游不返回 cacheRead ⇒ 该字段缺失/为 0，
      //    这不是"命中率 0%"，而是"没有数据"。把它计入平均会严重拉低反推值
      //    （实测：codearts 92.8% + trae 0% ⇒ 平均掉到 25%）。
      //    判定：字段完全缺失，或 input>0 且 cacheRead===0 且 cacheWrite>0（有写无读，异常）。
      const hasCacheField = Object.prototype.hasOwnProperty.call(v, 'cacheRead');
      const inp = Number(v.input) || 0;
      const cr = Number(v.cacheRead) || 0;
      if (!hasCacheField) continue;            // 渠道不提供 ⇒ 完全跳过
      if (inp > 10000 && cr === 0) continue;   // 有输入但零缓存读 ⇒ 视为不支持缓存，跳过
      const tot = inp + cr;
      if (tot < 10000) continue;   // 样本太小不计
      hitSum += cr; totSum += tot; n += 1;
    }
  }
  if (totSum < 100000) return null;   // 总样本太小
  return { rate: hitSum / totSum, samples: n, tokens: totSum };
}

function channelBridge(ctx) {
  const known = bridgeMemo.get(ctx);
  if (known !== undefined) return known;
  const bridge = createChannelPackBridge(ctx);
  if (bridge.available === true) bridgeMemo.set(ctx, bridge);
  return bridge;
}

function createChannelPackBridge(ctx) {
  let connection;
  try {
    connection = ctx.get('connection');
  } catch {
    connection = undefined;
  }
  if (connection === undefined
    || typeof connection.createSharedFetchHandler !== 'function'
    || typeof connection.createPeer !== 'function') {
    return { available: false, call: async () => ({ ok: false, error: '宿主未提供 connection 服务' }) };
  }
  let peer;
  try { peer = connection.createPeer({ principal: { kind: 'owner' } }); }
  catch (error) {
    return { available: false, call: async () => ({ ok: false, error: String(error && error.message || error) }) };
  }
  ctx.effect?.(() => () => { try { peer.dispose?.(); } catch { /* gone */ } }, 'unified-quota: channel peer');
  const handler = connection.createSharedFetchHandler('/api');
  let seq = 0;
  let active = 0;
  return {
    available: true,
    async call(method, payload, timeoutMs = 90_000) {
      let last = { ok: false, error: '没有可用的渠道额度通道' };
      for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt += 1) {
        const entry = RPC_ENDPOINTS[(active + attempt) % RPC_ENDPOINTS.length];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const request = new Request('http://127.0.0.1' + entry.path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: 'unified-quota-' + (++seq),
              method: entry.channel,
              payload: { method, payload: payload ?? {} }
            }),
            signal: controller.signal
          });
          const response = await handler.fetch(request, peer);
          if (response.status === 404) { last = { ok: false, error: entry.label + ' 未挂载' }; continue; }
          if (response.status === 403) { last = { ok: false, error: '内部调用被拒（owner 身份无效）' }; continue; }
          if (!response.ok) { last = { ok: false, error: entry.label + ' 响应 ' + response.status }; continue; }
          const envelope = await response.json();
          const result = envelope && envelope.result;
          if (result && result.ok === true) { active = (active + attempt) % RPC_ENDPOINTS.length; return { ok: true, value: result.value, channel: entry.label }; }
          const message = result && result.error && (result.error.message || result.error.code);
          last = { ok: false, error: str(message) || (entry.label + ' 返回失败') };
        } catch (error) {
          last = { ok: false, error: error && error.name === 'AbortError' ? '渠道额度查询超时' : String(error && error.message || error) };
        } finally {
          clearTimeout(timer);
        }
      }
      return last;
    }
  };
}

/** 模型展示名缓存（含倍率），来自 jet-hub 的 model.list。 */
let modelNamesCache = { at: 0, byKey: new Map(), error: null };
const MODEL_NAMES_TTL_MS = 3 * 60_000;

/**
 * 取「provider -> { modelId -> 展示名 }」。展示名尾部带倍率（`· x3.0`），
 * 是各渠道唯一统一的倍率来源。拿不到就返回空表，界面降级为「未知倍率」。
 */
async function loadModelNames(ctx, providers, force) {
  const now = Date.now();
  if (!force && modelNamesCache.byKey.size > 0 && now - modelNamesCache.at < MODEL_NAMES_TTL_MS) return modelNamesCache.byKey;
  const bridge = channelBridge(ctx);
  if (!bridge.available) return modelNamesCache.byKey;
  // force=true：先请 jet-hub 重拉上游目录。它的 model.list 不接受 force 参数，
  // 但 account.refresh 会触发适配器 refresh()（catalogAt=0）⇒ 下次 listModels 必打上游。
  if (force) { try { await bridge.call("account.refresh", {}, 20_000); } catch (e) { /* 尽力而为 */ } }
  const byKey = new Map();
  await Promise.all(providers.map(async (provider) => {
    const one = await bridge.call("model.list", { provider }, 15_000);
    if (one.ok !== true || !one.value) return;
    const list = Array.isArray(one.value.models) ? one.value.models : (Array.isArray(one.value) ? one.value : []);
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const id = str(entry.id);
      if (id.length === 0) continue;
      const name = str(entry.name) || str(entry.label) || id;
      byKey.set(provider + ":" + id, name);
    }
  }));
  modelNamesCache = { at: now, byKey, error: null };
  return byKey;
}

/** 给一行 {provider, model, tokens} 补上倍率与积分当量。 */
function withCreditFactor(row, names) {
  const key = str(row.provider) + ":" + str(row.model);
  const display = names.get(key) || "";
  const factor = priceFactorFromName(display || str(row.model));
  const tokens = Number(row.tokens) || 0;
  const known = usableFactor(factor);
  return {
    ...row,
    displayName: display || str(row.model),
    factor: known ? factor : null,
    factoredTokens: known ? tokens * factor : null,
  };
}

// —— 金额换算（USD 基准 → 显示币种） ————————————————————————

/**
 * 账本里的 cost/apiCost 是 USD；costCny/apiCostCny 是「记账当时汇率」冻结的人民币值。
 * 展示时一律回到 USD 再乘当前汇率，这样切币种、换汇率时历史数字会同步更新，
 * 不会出现「币种符号变了但数值还是旧汇率」的错配。
 */
/**
 * 账本金额 → 目标币种金额。
 *
 * ⚠️ 币种语义（2026-11-18 统一）：
 *   账本里 costCny / apiCostCny **存的是人民币**（写侧冻结）。
 *   官方定价表（DS_OFFICIAL_PRICING）也是人民币。
 *   所以换算路径是：**人民币 → 目标币种**，不是「USD × 汇率」。
 *
 * 历史坑：原实现把 costCny 当 USD 再 ×fx（6.6665），
 * 导致金额被放大 6.67 倍（实测 trae 应 68.19 却显示 454.58）。
 */
function makeMoney(displayCurrency, fxRate) {
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 7.1;
  const target = displayCurrency || 'CNY';
  // 人民币 → 目标币种的系数
  // target=CNY ⇒ 1；target=USD ⇒ 1/6.6665；target=EUR ⇒ 0.90794/6.6665
  const cnyFactor = (function () {
    if (target === 'CNY') return 1;
    try {
      const rates = ratesOf();
      const cny = rates.get('CNY');
      const t = rates.get(target);
      const cnyN = (cny !== null && cny > 0) ? cny : 6.6665;
      const tN = (t !== null && t > 0) ? t : 1;
      return tN / cnyN;
    } catch (e) { return 1 / 6.6665; }
  })();
  // 取人民币原值：优先 Cny 列，其次非 Cny 列（老数据可能同值）
  const cny = (row, api) => {
    const frozen = Number(row && (api ? row.apiCostCny : row.costCny));
    if (Number.isFinite(frozen) && frozen > 0) return frozen;
    const raw = Number(row && (api ? row.apiCost : row.cost));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };
  return {
    currency: target,
    symbol: target === 'CNY' ? '\u00A5' : target === 'EUR' ? '\u20AC' : '\u0024',
    rate: fx,                       // 显示用汇率（1 USD = N 目标币种）
    cnyFactor: cnyFactor,
    money: (row) => cny(row, false) * cnyFactor,
    apiMoney: (row) => cny(row, true) * cnyFactor,
  };
}

// —— 各来源归一化 ————————————————————————————————————————

/** 费用统计账本 → 面板形状。costCny 是写侧冻结的人民币列，优先用它。 */
function shapeLedger(ledger, displayCurrency, fxRate) {
  if (!ledger || typeof ledger !== 'object' || !ledger.days) return null;
  const M = makeMoney(displayCurrency || 'CNY', fxRate);
  const currency = M.currency;
  const symbol = M.symbol;
  const money = M.money;
  const apiMoney = M.apiMoney;
  const tokensOf = (row) => num(row && row.input) + num(row && row.output) + num(row && row.cacheRead) + num(row && row.cacheWrite);
  const todayKey = localDayKey(Date.now());
  const day = ledger.days[todayKey];
  const monthKey = todayKey.slice(0, 7);
  let monthCost = 0, monthApi = 0, monthTokens = 0, calls = 0;
  const series = [];
  for (const [date, rec] of Object.entries(ledger.days)) {
    if (!rec || typeof rec !== 'object') continue;
    if (date.slice(0, 7) === monthKey) {
      monthCost += money(rec); monthApi += apiMoney(rec); monthTokens += tokensOf(rec); calls += num(rec.calls);
    }
    series.push({ date, cost: money(rec), apiCost: apiMoney(rec), tokens: tokensOf(rec), calls: num(rec.calls) });
  }
  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  const models = [];
  for (const [key, rec] of Object.entries((day && day.byProviderModel) || {})) {
    const sep = key.indexOf(':');
    models.push({
      key,
      provider: sep > 0 ? key.slice(0, sep) : key,
      model: sep > 0 ? key.slice(sep + 1) : '',
      cost: money(rec), apiCost: apiMoney(rec),
      input: num(rec && rec.input), output: num(rec && rec.output),
      cacheRead: num(rec && rec.cacheRead), cacheWrite: num(rec && rec.cacheWrite),
      reasoning: num(rec && rec.reasoning), tokens: tokensOf(rec), calls: num(rec && rec.calls)
    });
  }
  models.sort((a, b) => b.tokens - a.tokens);
  // 30 天窗滚动聚合：每 provider 一行 + 每 provider 的模型明细（点开看详情用）
  const dayCut = localDayKey(Date.now() - 30 * 86400_000);
  const roll = new Map();
  for (const [date, rec] of Object.entries(ledger.days)) {
    if (date < dayCut || !rec || typeof rec !== 'object') continue;
    for (const [key, bucket] of Object.entries(rec.byProviderModel || {})) {
      if (!bucket || typeof bucket !== 'object') continue;
      const sep = key.indexOf(':');
      const provider = sep > 0 ? key.slice(0, sep) : key;
      const model = sep > 0 ? key.slice(sep + 1) : '';
      const row = roll.get(provider) || { provider, tokens: 0, cost: 0, apiCost: 0, calls: 0, models: new Map() };
      row.tokens += tokensOf(bucket); row.cost += money(bucket); row.apiCost += apiMoney(bucket); row.calls += num(bucket.calls);
      const mr = row.models.get(model) || { model, tokens: 0, cost: 0, apiCost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0 };
      mr.tokens += tokensOf(bucket); mr.cost += money(bucket); mr.apiCost += apiMoney(bucket); mr.calls += num(bucket.calls);
      mr.input += num(bucket.input); mr.output += num(bucket.output); mr.cacheRead += num(bucket.cacheRead); mr.reasoning += num(bucket.reasoning);
      row.models.set(model, mr);
      roll.set(provider, row);
    }
  }
  const providers30 = [...roll.values()]
    .map((r) => ({ provider: r.provider, tokens: r.tokens, cost: Math.round(r.cost * 1e4) / 1e4, apiCost: Math.round(r.apiCost * 1e4) / 1e4, calls: r.calls, models: [...r.models.values()].sort((a, b) => b.tokens - a.tokens) }))
    .sort((a, b) => b.tokens - a.tokens);
  const ref = ledger.balanceRef;
  const official = ref && typeof ref === 'object' && Number.isFinite(Number(ref.total))
    ? { total: num(ref.total), currency: str(ref.currency) || 'CNY', granted: num(ref.granted), topped: num(ref.topped), at: num(ref.at), date: str(ref.date) }
    : null;
  return {
    currency, symbol,
    today: day ? { cost: money(day), apiCost: apiMoney(day), tokens: tokensOf(day), calls: num(day.calls), models }
      : { cost: 0, apiCost: 0, tokens: 0, calls: 0, models },
    month: { cost: monthCost, apiCost: monthApi, tokens: monthTokens, calls },
    series: series.slice(-21),
    providers30,
    official
  };
}

/** 鲸鱼观测：今日观测消费 / 最近余额 / 最近一轮。只取其落盘，不碰 /dsh-whale/* 路由。 */
function shapeWhale(usage, turn) {
  const out = { present: Boolean(usage) };
  if (usage && typeof usage === 'object') {
    out.todayUsage = Number.isFinite(usage.todayUsage) ? usage.todayUsage : null;
    out.lastBalance = Number.isFinite(usage.lastBalance) ? usage.lastBalance : null;
    out.date = str(usage.date);
    const todayKey = localDayKey(Date.now());
    const events = Array.isArray(usage.events) ? usage.events : [];
    out.todayEvents = events.filter((e) => e && e.day === todayKey).length;
    out.todayEventCost = Math.round(events.reduce((sum, e) => sum + (e && e.day === todayKey && Number.isFinite(e.cost) ? e.cost : 0), 0) * 1e8) / 1e8;
    out.todayEventTokens = events.reduce((sum, e) => sum + (e && e.day === todayKey && Number.isFinite(e.tokens) ? e.tokens : 0), 0);
  }
  if (turn && typeof turn === 'object' && Number.isFinite(turn.turn)) {
    out.lastTurn = { turn: turn.turn, amount: Number(turn.amount) || 0, tokens: Number(turn.tokens) || 0, ts: Number(turn.ts) || 0 };
  }
  return out;
}

/** 白嫖渠道名册（不含任何凭据信息，credentialRef 刻意丢弃）。 */
function shapeRoster(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.accounts)) return null;
  const byProvider = new Map();
  for (const acct of state.accounts) {
    if (!acct || typeof acct !== 'object') continue;
    const provider = str(acct.provider);
    if (provider.length === 0) continue;
    const row = byProvider.get(provider) || { provider, accounts: 0, enabled: false, nicknames: [], expiresAt: 0 };
    row.accounts += 1;
    if (acct.enabled !== false) row.enabled = true;
    const nick = str(acct.nickname);
    if (nick.length > 0 && row.nicknames.length < 3) row.nicknames.push(nick);
    const exp = Number(acct.expiresAt);
    if (Number.isFinite(exp) && exp > row.expiresAt) row.expiresAt = exp;
    byProvider.set(provider, row);
  }
  return [...byProvider.values()];
}

/** credits.balances 响应 → 每渠道一行（余额合计 + 分项包）。 */
function shapeCredits(value) {
  const accounts = value && Array.isArray(value.accounts) ? value.accounts : [];
  let total = 0, hasTotal = false, unit = '', packages = [], error = '';
  for (const acct of accounts) {
    if (acct && typeof acct.error === 'string' && acct.error.length > 0) error = acct.error;
    const bal = acct && acct.balance;
    if (!bal || typeof bal !== 'object') continue;
    if (Number.isFinite(bal.total)) { total += bal.total; hasTotal = true; }
    for (const p of Array.isArray(bal.packages) ? bal.packages : []) {
      if (!p || typeof p !== 'object') continue;
      if (!unit && typeof p.unit === 'string' && p.unit.length > 0) unit = p.unit;
      packages.push({
        name: str(p.name) || 'package',
        unit: str(p.unit) || unit,
        remaining: Number.isFinite(p.remaining) ? p.remaining : null,
        total: Number.isFinite(p.total) ? p.total : null,
        active: p.active !== false,
        expiredTime: str(p.expiredTime)
      });
    }
  }
  return { total: hasTotal ? Math.round(total * 1e6) / 1e6 : null, unit, packages, error };
}

// —— 进程内缓存：渠道额度（写操作依然没有，这里只是省网络） ————

let creditsCache = { at: 0, providers: null, error: null };
let lastBalanceSampleAt = 0; // 上次余额采样时间（60 秒节流）
let creditsInFlight = null;

async function loadCredits(ctx, providers) {
  const now = Date.now();
  if (creditsCache.at > 0 && now - creditsCache.at < CREDITS_TTL_MS && creditsInFlight === null) return creditsCache;
  const bridge = channelBridge(ctx);
  if (creditsInFlight === null) {
    creditsInFlight = (async () => {
      try {
        if (!bridge.available) throw new Error(await bridge.call('credits.balances', {}).then((r) => r.error || '桥不可用'));
        const rows = await Promise.all(providers.map(async (p) => {
          const one = await bridge.call('credits.balances', { provider: p.provider }, PER_PROVIDER_TIMEOUT_MS);
          if (one.ok === true) return { ...p, credits: shapeCredits(one.value), error: '' };
          return { ...p, credits: shapeCredits(null), error: one.error || '查询失败' };
        }));
        creditsCache = { at: Date.now(), providers: rows, error: null };
      } catch (error) {
        creditsCache = { at: Date.now(), providers: null, error: String(error && error.message || error) };
      } finally {
        creditsInFlight = null;
      }
    })();
  }
  await creditsInFlight;
  return creditsCache;
}

/**
 * 明细页数据：给定窗口（默认 30 天）返回
 *   days[]        逐日 {date, cost, apiCost, tokens, calls}
 *   providers[]   逐渠道 {provider, tokens, cost, apiCost, calls, models[]}
 *   models[]      逐模型（跨渠道合并） {model, providers[], tokens, cost, apiCost, calls}
 *   sessions[]    逐会话（仅当日有记录的会话，最近优先）
 * 全部从账本单次扫描得出，无额外 IO。
 */
/**
 * 明细数据（支持筛选与口径）。
 * @param ledger 账本
 * @param opts { windowDays, provider, model, basis, includeSubagent }
 *   basis: api=只算实付 | total=实付+等值 | plan=只算等值
 *   —— 金额列同时给出 cost(等值) / apiCost(实付)，由前端按口径取用；后端只需如实返回两者。
 */
function buildDetail(ledger, opts = {}, names) {
  const nameMap = names instanceof Map ? names : new Map();
  if (!ledger || typeof ledger !== 'object' || !ledger.days) return null;
  const M = makeMoney(opts.currency || 'CNY', opts.rate);
  const currency = M.currency;
  const money = M.money;
  const apiMoney = M.apiMoney;
  const tokensOf = (row) => num(row && row.input) + num(row && row.output) + num(row && row.cacheRead) + num(row && row.cacheWrite);
  const windowDays = Math.max(1, Math.min(365, Number(opts.windowDays) || 30));
  const since = localDayKey(Date.now() - (windowDays - 1) * 86400_000);
  const fProvider = str(opts.provider);
  const fModel = str(opts.model);
  const keep = (provider, model) => (fProvider === '' || provider === fProvider) && (fModel === '' || model === fModel);

  const days = [];
  const dayProviders = {};
  const providers = new Map();
  const models = new Map();
  const buckets = new Map();
  const provSet = new Set();
    // 全量交集映射（不受筛选影响，供前端双向联动）
    const allModelToProvs = {}; const allProvToModels = {};
  const modelSet = new Set();
  const dayMap = new Map();

  for (const [date, rec] of Object.entries(ledger.days)) {
    if (date < since || !rec || typeof rec !== 'object') continue;
    let dayCost = 0, dayApi = 0, dayTok = 0, dayCalls = 0;
    for (const [key, b] of Object.entries(rec.byProviderModel || {})) {
      if (!b || typeof b !== 'object') continue;
      const sep = key.indexOf(':');
      const provider = sep > 0 ? key.slice(0, sep) : key;
      const model = sep > 0 ? key.slice(sep + 1) : '';
      provSet.add(provider); modelSet.add(model);
      // 先记录全量交集（不受筛选影响）
      (allModelToProvs[model] = allModelToProvs[model] || new Set()).add(provider);
      (allProvToModels[provider] = allProvToModels[provider] || new Set()).add(model);
      if (!keep(provider, model)) continue;
      const tok = tokensOf(b), cost = money(b), api = apiMoney(b), calls = num(b.calls);
      if (!dayProviders[date]) dayProviders[date] = {};
      dayProviders[date][provider] = (dayProviders[date][provider] || 0) + tok;
      dayCost += cost; dayApi += api; dayTok += tok; dayCalls += calls;
      const p = providers.get(provider) || { provider, tokens: 0, cost: 0, apiCost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, models: new Map() };
      p.tokens += tok; p.cost += cost; p.apiCost += api; p.calls += calls;
      p.input += num(b.input); p.output += num(b.output); p.cacheRead += num(b.cacheRead);
      p.cacheWrite += num(b.cacheWrite); p.reasoning += num(b.reasoning);
      const pm = p.models.get(model) || { model, tokens: 0, cost: 0, apiCost: 0, calls: 0 };
      pm.tokens += tok; pm.cost += cost; pm.apiCost += api; pm.calls += calls;
      p.models.set(model, pm); providers.set(provider, p);
      const m = models.get(model) || { model, tokens: 0, cost: 0, apiCost: 0, calls: 0, providers: [] };
      m.tokens += tok; m.cost += cost; m.apiCost += api; m.calls += calls;
      if (!m.providers.includes(provider)) m.providers.push(provider);
      models.set(model, m);
      const bk = provider + '|' + model;
      const cur = buckets.get(bk) || { provider, model, tokens: 0, cost: 0, apiCost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      cur.tokens += tok; cur.cost += cost; cur.apiCost += api; cur.calls += calls;
      cur.input += num(b.input); cur.output += num(b.output); cur.cacheRead += num(b.cacheRead);
      cur.cacheWrite += num(b.cacheWrite); cur.reasoning += num(b.reasoning);
      buckets.set(bk, cur);
    }
    if (dayCalls > 0 || dayTok > 0) {
      days.push({ date, cost: dayCost, apiCost: dayApi, tokens: dayTok, calls: dayCalls });
      if (Object.keys(dayProviders[date] || {}).length > 0) { /* 已收集 */ }
      dayMap.set(date, { cost: dayCost, apiCost: dayApi, tokens: dayTok, calls: dayCalls });
    }
  }
  days.sort((x, y) => (x.date < y.date ? -1 : 1));
  const round = (n) => Math.round(n * 1e4) / 1e4;
  const mapRows = (m) => [...m.values()].map((r) => ({ ...r, cost: round(r.cost), apiCost: round(r.apiCost) })).sort((x, y) => y.tokens - x.tokens);

  const provRows = mapRows(providers).map((p) => ({
    ...p, models: [...p.models.values()].map((m) => ({ ...m, cost: round(m.cost), apiCost: round(m.apiCost) })).sort((x, y) => y.tokens - x.tokens),
  }));
  const modelRows = mapRows(models);
  const bucketRows = mapRows(buckets);

  // 会话：从账本的逐日 sessions 聚合（受同一筛选口径约束无法精确到会话内渠道，故只按总量）
  const sessions = [];
  for (const [date, rec] of Object.entries(ledger.days)) {
    if (date < since || !rec || !Array.isArray(rec.sessions)) continue;
    for (const s of rec.sessions) {
      if (!s || typeof s !== 'object') continue;
      if (fProvider !== '' || fModel !== '') continue; // 会话粒度不支持渠道筛选时就不列，避免误导
      sessions.push({ id: str(s.id), date, cost: round(money(s)), apiCost: round(apiMoney(s)), tokens: tokensOf(s), calls: num(s.calls) });
    }
  }
  sessions.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));

  // 趋势与构成
  const trend = days.map((d) => ({ date: d.date, tokens: d.tokens, cost: round(d.cost), apiCost: round(d.apiCost), calls: d.calls }));
  const totals = days.reduce((acc, d) => {
    acc.cost += d.cost; acc.apiCost += d.apiCost; acc.tokens += d.tokens; acc.calls += d.calls; return acc;
  }, { cost: 0, apiCost: 0, tokens: 0, calls: 0 });
  totals.cost = round(totals.cost); totals.apiCost = round(totals.apiCost);
  const comp = bucketRows.reduce((acc, r) => {
    acc.input += r.input; acc.output += r.output; acc.cacheRead += r.cacheRead; acc.cacheWrite += r.cacheWrite; acc.reasoning += r.reasoning;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  const billedInput = comp.input + comp.cacheRead + comp.cacheWrite;
  const hitRate = billedInput > 0 ? comp.cacheRead / billedInput : null;

  // 积分倍率：逐渠道×模型挂上倍率与积分当量，再给出渠道级汇总
  const bucketsC = bucketRows.map((r) => withCreditFactor(r, nameMap));
  const modelsC = modelRows.map((r) => {
    // 同一模型可能出现在多个渠道且倍率不同；取该模型出现过的第一个已知倍率作展示
    const hit = bucketsC.find((b) => b.model === r.model && b.factor !== null);
    return withCreditFactor(r, nameMap).factor === null && hit !== undefined
      ? { ...r, displayName: hit.displayName, factor: hit.factor, factoredTokens: (Number(r.tokens) || 0) * hit.factor }
      : withCreditFactor(r, nameMap);
  });
  const providersC = provRows.map((p) => {
    const mine = bucketsC.filter((b) => b.provider === p.provider);
    const sum = summarizeCredits(mine);
    return { ...p, credit: { factored: sum.factored, known: sum.known, unknown: sum.unknown, unknownTokens: sum.unknownTokens } };
  });
  const creditTotal = summarizeCredits(bucketsC);
  return {
    windowDays, since, currency, rate: M.rate,
    filters: { provider: fProvider, model: fModel },
    options: { providers: [...provSet].sort(), models: [...modelSet].sort(), modelToProvs: (function () { const o = {}; for (const [k, v] of Object.entries(allModelToProvs)) o[k] = [...v].sort(); return o; })(), provToModels: (function () { const o = {}; for (const [k, v] of Object.entries(allProvToModels)) o[k] = [...v].sort(); return o; })() },
    credit: { factored: creditTotal.factored, known: creditTotal.known, unknown: creditTotal.unknown, unknownTokens: creditTotal.unknownTokens, factors: creditTotal.factors },
    days, providers: providersC, models: modelsC, buckets: bucketsC,
    sessions: sessions.slice(0, 200),
    trend, dayProviders, totals,
    factorsAt: modelNamesCache.at || 0,
    factorsTtlMs: MODEL_NAMES_TTL_MS,
    composition: comp, hitRate,
  };
}

// —— 记账（自有账本；llm/stream 观察者） ——————————————————————————————

/** 计费配置：价格表 + 峰谷。可用 profile patch 覆盖，默认用内置官方价目。 */
const BILLING_DEFAULTS = {
  prices: DEFAULT_PRICE_TABLE,
  priceMatch: 'auto',
  priceOverrides: {},
  peakEnabled: true,
  currency: 'CNY',
  exchangeRate: 7.1,
};

let ledgerInstance = null;
let ledgerReady = null;
/** 记账用的计费配置视图（随设置页变更而更新）。 */
let meterConfig = null;

function ledgerOf() {
  if (ledgerInstance === null) {
    ledgerInstance = new QuotaLedger(OWN_LEDGER_PATH);
    ledgerReady = ledgerInstance.load();
  }
  return ledgerInstance;
}

/**
 * 首次启动时把 cost-meter 的历史账本导入自有账本（只导它没有的日期，幂等）。
 * 导入后本插件不再读它，卸载 cost-meter 也不会丢历史。
 */
async function importLegacyHistory(ctx) {
  try {
    const legacy = await readJsonCached(LEGACY_LEDGER_PATH);
    if (!legacy || typeof legacy !== 'object' || !legacy.days) return 0;
    const ledger = ledgerOf();
    await (ledgerReady ?? Promise.resolve());
    let imported = 0;
    for (const [date, rec] of Object.entries(legacy.days)) {
      if (!rec || typeof rec !== 'object') continue;
      if (ledger.data.days[date] !== undefined) continue; // 已有（自有账本为准）
      ledger.data.days[date] = {
        date,
        input: num(rec.input), output: num(rec.output),
        cacheRead: num(rec.cacheRead), cacheWrite: num(rec.cacheWrite),
        reasoning: num(rec.reasoning), calls: num(rec.calls),
        cost: num(rec.cost), apiCost: num(rec.apiCost),
        costCny: num(rec.costCny), apiCostCny: num(rec.apiCostCny),
        byProviderModel: rec.byProviderModel && typeof rec.byProviderModel === 'object' ? rec.byProviderModel : {},
        sessions: Array.isArray(rec.sessions) ? rec.sessions : [],
      };
      imported++;
    }
    if (imported > 0) {
      ledger.schedule();
      ctx.logger?.info?.('[unified-quota] 已导入 %s 天历史账本', imported);
    }
    return imported;
  } catch (error) {
    ctx.logger?.warn?.('[unified-quota] legacy import failed: %s', String(error && error.message || error));
    return 0;
  }
}

/** 把五桶按当前价格表定价（人民币口径同时算一份，面板直接展示）。 */
// 记账用的轻量缓存（避免每次调用都读文件）。由 loadBalanceLog / 账本写入处更新。
let priceRowCacheAt = 0;
let balanceLogCache = { entries: {} };
let ownLedgerCache = { days: {} };
try {
  balanceLogCache = JSON.parse(fsSync.readFileSync(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'), 'utf8'));
} catch (e) {}
try {
  ownLedgerCache = JSON.parse(fsSync.readFileSync(OWN_LEDGER_PATH, 'utf8'));
} catch (e) { criticalCatch(DEBUG_DIR, "ledger:763", e); }

function priceRow(buckets, provider, model, atMs, config) {
  const resolved = providerPriceEntryFor(provider, model, config.prices, {
    mode: config.priceMatch === 'exact' ? 'exact' : 'auto',
    overrides: config.priceOverrides,
  });
  const peak = config.peakEnabled === true;
  const cost = resolved.priced ? costOf(buckets, resolved.entry, atMs, peak) : 0;
  const rate = Number(config.exchangeRate) > 0 ? Number(config.exchangeRate) : 7.1;
  // —— 积分口径优先 ——
  // 白嫖渠道（trae/buddy/qodercn）的真实成本是「积分 × 积分单价」，
  // 用官方 API 价会虚高 50-300 倍（实测 trae 账本 ¥1107 vs 实际 ¥16）。
  // 账本必须与弹窗同口径，否则重算后会被记账再次覆盖成旧值。
  try {
    const table = creditPriceCache && creditPriceCache.table;
    const perCredit = table && table[provider] ? table[provider].perCredit : null;
    if (perCredit !== null && perCredit > 0) {
      // 实时读（带 5 秒节流），避免缓存过期导致账本口径漂移
      const nowPR = Date.now();
      if (nowPR - (priceRowCacheAt || 0) > 5000) {
        priceRowCacheAt = nowPR;
        try { balanceLogCache = JSON.parse(fsSync.readFileSync(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'), 'utf8')); } catch (e) { criticalCatch(DEBUG_DIR, "pricing:785", e); }
        try { ownLedgerCache = JSON.parse(fsSync.readFileSync(OWN_LEDGER_PATH, 'utf8')); } catch (e) { criticalCatch(DEBUG_DIR, "pricing:786", e); }
      }
      const rc = realConsumption(balanceLogCache, provider, 1);
      const spent = rc && rc.today ? rc.today.spent : (rc ? rc.consumed : 0);
      if (spent > 0) {
        const ledRaw = ownLedgerCache;
        const lday = latestLedgerDay(ledRaw);
        let todayTok = 0;
        const dayRow = ledRaw && ledRaw.days ? ledRaw.days[lday] : null;
        for (const [k, b] of Object.entries((dayRow && dayRow.byProviderModel) || {})) {
          if (k.indexOf(provider + ':') !== 0) continue;
          todayTok += (Number(b.input) || 0) + (Number(b.output) || 0) + (Number(b.cacheRead) || 0);
        }
        if (todayTok > 0) {
          const tokPerCredit = todayTok / spent;
          const myTok = (Number(buckets.input) || 0) + (Number(buckets.output) || 0) + (Number(buckets.cacheRead) || 0) + (Number(buckets.reasoning) || 0);
          const creditCny = (myTok / tokPerCredit) * perCredit;
          if (Number.isFinite(creditCny) && creditCny > 0) {
            return { cost: creditCny / rate, apiCost: creditCny / rate, costCny: creditCny, apiCostCny: creditCny, priced: true, creditBasis: true };
          }
        }
      }
    }
  } catch (e) {}
  // costOf 返回 USD（或价目币种）；人民币列按展示汇率换算，与面板的实付/等值分列对齐
  return { cost, apiCost: cost, costCny: cost * rate, apiCostCny: cost * rate, priced: resolved.priced };
}

/** 挂 llm/stream 观察者。失败只 warn，绝不中断对话。 */
function installMeter(ctx, initial) {
  const ledger = ledgerOf();
  meterConfig = meterConfig ?? initial;
  void ledgerReady;
  const meter = createStreamMeter({
    config: initial,
    // 上游失败（限流/额度）直接从钩子记录，不依赖事后扫日志
    onError(error, hint) {
      // 诊断落盘：限额错误时把完整结构写出来（日志目录不可用，只能写文件）
      try {
        const dbgPath = path.join(DSH_HOME, "storages", "unified-quota", "onerror-debug.jsonl");
        const rec = {
          at: new Date().toISOString(),
          hintProvider: String(hint && hint.provider),
          hintModel: String(hint && hint.model),
          errName: String(error && error.name),
          errCode: String(error && (error.code || (error.failure && error.failure.code))),
          errMsg: String(error && (error.message || error)).slice(0, 300),
          errKeys: (function () { try { return Object.keys(error || {}).slice(0, 20).join(","); } catch (e) { return ""; } })(),
          errJson: (function () { try { return JSON.stringify(error).slice(0, 500); } catch (e) { return ""; } })(),
        };
        fsSync.mkdirSync(path.dirname(dbgPath), { recursive: true });
        fsSync.appendFileSync(dbgPath, JSON.stringify(rec) + "\n", "utf8");
      } catch (e) { criticalCatch(DEBUG_DIR, "persist:838", e); }
      void recordCapFromError(error, hint);
    },
    // 记住「本会话最后用过哪个模型」——底部状态栏的额度监控要显示它
    onRecord(row) { rememberUsed(row && row.sessionId, row && row.provider, row && row.model); },
    record(row) {
      try {
        const priced = priceRow(row.buckets, row.provider, row.model, row.atMs, meterConfig ?? initial);
        ledger.account({
          buckets: row.buckets, provider: row.provider, model: row.model,
          sessionId: row.sessionId, atMs: row.atMs,
          cost: priced.cost, apiCost: priced.apiCost, costCny: priced.costCny, apiCostCny: priced.apiCostCny,
        });
          // 每次模型调用后也采样一次余额（60 秒节流）：否则只有打开明细页才采样，
          // 「今日实扣」会长时间卡住不动（用户实测卡在 80 积分）。
          try {
            const nowMs0 = Date.now();
            if (nowMs0 - lastBalanceSampleAt >= 60000) {
              lastBalanceSampleAt = nowMs0;
              void (async function () {
                try {
                  const roster1 = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
                  const cache1 = await loadCredits(ctx, roster1);
                  if (Array.isArray(cache1.providers)) await recordBalances(cache1.providers);
                } catch (e) { criticalCatch(DEBUG_DIR, "ledger:862", e); }
              })();
            }
          } catch (e) {}
      } catch (error) {
        ctx.logger?.warn?.('[unified-quota] account failed: %s', String(error && error.message || error));
      }
    },
  });
  ctx.on('llm/stream', meter, { global: true });
  ctx.effect(() => () => { void ledger.close(); }, 'unified-quota: ledger close');
}

// —— DeepSeek 官方余额（实时；配方与旧 fork 相同，已实测） ————————

let officialCache = { at: 0, value: null };

function centsOf(value) {
  const match = /^(-?)([0-9]+)(?:[.]([0-9]+))?$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').slice(0, 2).padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}
function formatCents(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = String(absolute / 100n) + '.' + String(absolute % 100n).padStart(2, '0');
  return negative ? '-' + text : text;
}

async function fetchOfficial(ctx) {
  const now = Date.now();
  if (officialCache.at > 0 && now - officialCache.at < CREDITS_TTL_MS) return officialCache.value;
  let value = null;
  // ① 宿主账号服务（设置 → 账号与余额 同一来源）。逻辑与旧 fork 的
  //    accountBalancePayload 逐字对齐：status==="ready"、wallet.balance、按 currency 分组。
  try {
    const account = ctx.get('deepseekAccount');
    if (account && typeof account.getBalance === 'function') {
      const view = await account.getBalance({
        version: 'unified-quota',
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
      });
      if (view && view.status === 'ready') {
        const wallets = Array.isArray(view.value) ? view.value : [];
        const bonuses = Array.isArray(view.bonusWallets) ? view.bonusWallets : [];
        const currencies = [];
        for (const w of [...wallets, ...bonuses]) {
          if (typeof w?.currency === 'string' && !currencies.includes(w.currency)) currencies.push(w.currency);
        }
        const sumCents = (list, currency) => list.reduce((total, w) => {
          if (w?.currency !== currency) return total;
          const cents = centsOf(w.balance);
          return cents === null ? total : total + cents;
        }, 0n);
        const infos = currencies.map((currency) => {
          const toppedUp = sumCents(wallets, currency);
          const granted = sumCents(bonuses, currency);
          return { currency, total: formatCents(toppedUp + granted), granted: formatCents(granted), topped: formatCents(toppedUp) };
        });
        if (infos.length > 0) value = { source: 'account', wallets: infos, at: now };
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('[unified-quota] account balance failed: %s', String(error && error.message || error));
  }
  // ② API key 直连 /user/balance（账号服务缺席时）
  if (value === null) {
    let key;
    try {
      const credentials = ctx.get('credentials');
      if (credentials) { const hit = await credentials.resolve('DEEPSEEK_API_KEY'); if (hit && hit.value) key = hit.value; }
    } catch { /* none */ }
    if (!key) { const amb = process.env.DEEPSEEK_API_KEY; if (amb) key = amb; }
    if (key) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        const res = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: controller.signal }).finally(() => clearTimeout(timer));
        if (res.ok) {
          const data = await res.json();
          const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : [];
          value = {
            source: 'api-key', at: now,
            wallets: infos.map((info) => ({
              currency: str(info?.currency) || 'USD',
              total: str(info?.total_balance), granted: str(info?.granted_balance) || '0.00', topped: str(info?.topped_up_balance) || '0.00'
            }))
          };
        }
      } catch { /* fall through */ }
    }
  }
  if (value !== null) officialCache = { at: now, value };
  return officialCache.value; // null → 客户端回退账本 balanceRef 快照
}

// —— HTTP ————————————————————————————————————————————————

function jsonResponse(res, code, body) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch { /* socket already gone */ }
}

const TRUSTED_AUTHORITIES = String(process.env.DSHU_TRUSTED_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function loopbackHostname(h) {
  const v = String(h || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (v === 'localhost' || v.endsWith('.localhost') || v === '::1') return true;
  const m = /^([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})$/.exec(v);
  return m !== null && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255);
}

function authorityOf(hostHeader) {
  try { return new URL('http://' + String(hostHeader || '')); } catch { return null; }
}

/**
 * 信任栅栏（对齐 dsh-whale-widget 的三层设计）：
 *   ① 浏览器元数据永远先判：sec-fetch-site: cross-site 一律拒；带 Origin 时必须与 Host 同源
 *      —— 这条挡 DNS 重绑定（恶意页把域名解析到 127.0.0.1 时，socket 是回环的，只有 Host/Origin 能揭穿它）。
 *   ② 宿主 connection.requestRejection 可用时委托它（它认识 --trusted-host 与浏览器鉴权）。
 *   ③ 都不适用时：Host 必须是回环权威或 DSHU_TRUSTED_HOSTS 白名单。
 * 任何一步拿不准 → 拒（fail-closed）。本路由只读、不含任何凭据，从严不伤功能。
 */
/** 403 时附带诊断，避免只看到「读取失败403」而无从判断。 */
function denyOrigin(res, req) {
  try {
    const h = (req && req.headers) || {};
    return jsonResponse(res, 403, {
      error: "untrusted origin",
      host: str(h.host),
      origin: str(h.origin),
      site: str(h["sec-fetch-site"]),
      hint: "插件只接受回环地址或宿主 trusted-host 放行的来源",
    });
  } catch (e) { return jsonResponse(res, 403, { error: "untrusted origin" }); }
}
function rejected(ctx, req) {
  try {
    const headers = (req && req.headers) || {};
    const hostUrl = authorityOf(headers.host);
    if (hostUrl === null) return true; // 缺 Host / 畸形
    const site = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return true;
    const origin = headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
      let originUrl = null;
      try { originUrl = new URL(origin); } catch { return true; }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return true;
    }
    const browserish = typeof headers['user-agent'] === 'string' || site.length > 0;
    // 回环权威直接放行：浏览器与本地脚本的正常形态，且 DNS 重绑定的 Host 一定不是回环。
    if (loopbackHostname(hostUrl.hostname)) return false;
    // 非回环（反代 / 局域网 / 被重绑定的域名）：浏览器请求委托宿主栅栏，它认识 --trusted-host；
    // 栅栏不可用则只认显式白名单，拿不准一律拒（fail-closed）。
    if (browserish) {
      const fence = connectionFence(ctx);
      if (fence !== null) {
        // 宿主栅栏是权威：它认识 --trusted-host / --allow-lan 等配置。
        // 它说放行就放行 —— 之前这里还额外要求命中白名单，导致「局域网/反代访问」
        // 明明被宿主接受，插件却回 403（用户实测「读取失败403」）。
        try { return fence.requestRejection(req) === true; } catch { return true; }
      }
      // 栅栏不可用时的兜底：同机访问放行 —— 浏览器访问本机的局域网 IP 是正常形态，
      // 且来源地址无法伪造；跨机访问仍要求显式白名单（fail-closed）。
      const remote = String((req && req.socket && req.socket.remoteAddress) || "").toLowerCase().replace(/^::ffff:/, "");
      const host = hostUrl.hostname.toLowerCase();
      const sameMachine = remote.length > 0 && (remote === host || loopbackHostname(remote));
      if (sameMachine) return false;
      return !TRUSTED_AUTHORITIES.some((e) => (e.includes(':') ? e === hostUrl.host.toLowerCase() : e === hostUrl.hostname.toLowerCase()));
    }
    const authority = hostUrl.host.toLowerCase();
    if (TRUSTED_AUTHORITIES.some((e) => (e.includes(':') ? e === authority : e === hostUrl.hostname.toLowerCase()))) return false;
    return true;
  } catch { return true; }
}

function connectionFence(ctx) {
  try {
    const conn = ctx.get('connection');
    return conn && typeof conn.requestRejection === 'function' ? conn : null;
  } catch { return null; }
}

async function buildCore(ctx, refresh) {
  const [ledgerRaw, whaleRaw, turnRaw] = await Promise.all([
    readJsonCached(OWN_LEDGER_PATH), readJsonCached(WHALE_USAGE_PATH), readJsonCached(WHALE_TURN_PATH)
  ]);
  let rosterRaw = null;
  for (const candidate of ROSTER_CANDIDATES) {
    rosterRaw = await readJsonCached(candidate);
    if (rosterRaw !== null) break;
  }
  const cfgLive = configStoreOf().get();
  const liveRate = rateFor(cfgLive);
  const ledger = shapeLedger(ledgerRaw, cfgLive.currency, liveRate);
  const roster = shapeRoster(rosterRaw);
  const whale = (function () {
    const w = shapeWhale(whaleRaw, turnRaw);
    // ⚠️ 关键：liveRate 是「1 USD = N 目标币种」的乘数（rates.json: {USD:1, CNY:6.6665}）
    // 而小鲸鱼的值是**人民币**，所以要先 / CNY汇率 转成 USD，再 * 目标汇率
    const fxW = cnyToTarget();   // 人民币 → 目标币种（统一实现）
    if (!w || fxW === 1) return w;
    const conv = function (v) { return Number.isFinite(v) ? v * fxW : v; };
    if (Number.isFinite(w.todayUsage)) w.todayUsage = conv(w.todayUsage);
    if (Number.isFinite(w.lastBalance)) w.lastBalance = conv(w.lastBalance);
    if (w.lastTurn && Number.isFinite(w.lastTurn.amount)) w.lastTurn.amount = conv(w.lastTurn.amount);
    if (Number.isFinite(w.todayEventCost)) w.todayEventCost = conv(w.todayEventCost);
    return w;
  })();
  let channels = { providers: roster || [], credits: null, error: null, cachedAt: 0 };
  if (Array.isArray(roster) && roster.length > 0) {
    if (refresh) creditsCache = { at: 0, providers: null, error: null };
    const cache = await loadCredits(ctx, roster);
    channels = { providers: roster, credits: cache.providers, error: cache.error, cachedAt: cache.at };
  }
  const __liveRaw = await fetchOfficial(ctx);
    // ⚠️ 官方余额也记入 balance-log：这是**唯一能拿到真实扣费**的渠道。
    //    有了余额差，就能校准其它渠道的估算准确性。
    //    deepseek-account 不在 roster 里，所以原来的 recordBalances 没覆盖它。
    try {
      if (__liveRaw && Array.isArray(__liveRaw.wallets)) {
        const total = __liveRaw.wallets.reduce(function (s, w) { return s + (Number(w.total) || 0); }, 0);
        if (total > 0) {
          await recordBalances([{ provider: 'deepseek-account', credits: { total: total, unit: 'CNY' } }]);
        }
      }
    } catch (e) { criticalCatch(DEBUG_DIR, 'official-sample', e); }
    // 官方余额是**账户原币**（DeepSeek 国际站为 USD，国内站为 CNY）。
    // 按目标币种换算，避免切到 USD 时显示 "¥8.49" 变 "$8.49"（数值不变）。
    const live = (function () {
      if (!__liveRaw || !Array.isArray(__liveRaw.wallets)) return __liveRaw;
      const fxO = cnyToTarget();   // 人民币 → 目标币种（统一实现）
      if (fxO === 1) return __liveRaw;
      const copy = Object.assign({}, __liveRaw);
      copy.wallets = __liveRaw.wallets.map(function (w) {
        const o = Object.assign({}, w);
        if (Number.isFinite(Number(o.total))) o.total = Number(o.total) * fxO;
        if (Number.isFinite(Number(o.topped))) o.topped = Number(o.topped) * fxO;
        if (Number.isFinite(Number(o.granted))) o.granted = Number(o.granted) * fxO;
        return o;
      });
      return copy;
    })();
  const rateState = ratesOf().state;
  return {
    at: Date.now(),
    build: BUILD,
    money: {
      currency: cfgLive.currency,
      // 显示用汇率：当前币种相对 USD 的比价（1 USD = rate 个当前币种）
      rate: (function () {
        var cur = cfgLive.currency || 'CNY';
        if (cur === 'USD') return 1;
        var r = ratesOf().get(cur);
        if (r !== null && r > 0) return r;
        return Number(cfgLive.exchangeRate) > 0 ? Number(cfgLive.exchangeRate) : 7.1;
      })(),
      fx: liveRate,     // 换算用
      base: 'USD',      // 汇率基准
      date: rateState && rateState.date ? rateState.date : '',
      stale: rateState ? rateState.stale === true : true,
      error: rateState && rateState.error ? rateState.error : null,
    },
    official: live,
    sources: { ledger: ledger !== null, channelPack: Array.isArray(roster), whale: whale.present === true },
    ledger,
    whale,
    channels
  };
}

/**
 * 白嫖渠道归 Plan 轨（用户 2026-11-14 明确选择）。
 * 通过 cost-meter 自己的 cordis 服务 updateConfig —— 深合并已核实
 * （store.js applyConfigPatch：未知键拒绝、结构化克隆、mergeDeep），
 * 且它自带"归类变更即幂等重算历史 apiCost"（index.js:2603 分支）。
 * 幂等：账本里这些 provider 已是 plan 就不再调用。只改 planBilling.providers，
 * 不碰其它配置键；deepseek-account 绝不进这张表（那是真金白银的官方余额）。
 */
const PLAN_TRACK_PROVIDERS = ['qodercn', 'trae', 'codearts', 'workbuddy', 'buddy', 'zcode'];
function schedulePlanTrack(ctx) {
  let settled = false;
  const run = async (costMeter) => {
    if (settled) return;
    settled = true;
    try {
      const ledgerRaw = await readJsonCached(LEGACY_LEDGER_PATH);
      const providers = ledgerRaw && ledgerRaw.config && ledgerRaw.config.planBilling && ledgerRaw.config.planBilling.providers || {};
      const missing = PLAN_TRACK_PROVIDERS.filter((id) => providers[id] !== 'plan');
      if (missing.length === 0) return;
      if (typeof costMeter.updateConfig !== 'function') return;
      const patch = { planBilling: { providers: Object.fromEntries(missing.map((id) => [id, 'plan'])) } };
      await costMeter.updateConfig(patch);
      ctx.logger?.info?.('[unified-quota] 已将 %s 归入 Plan 轨（历史 apiCost 由 cost-meter 自动重算）', missing.join(', '));
    } catch (error) {
      ctx.logger?.warn?.('[unified-quota] plan-track update failed: %s', String(error && error.message || error));
    }
  };
  try {
    ctx.inject(['costMeter'], (c) => { void run(c.costMeter); });
  } catch (e) { /* cost-meter absent: nothing to do */ }
}


/** 账本里最新的一天（<= 今天）。防止 UTC+8 日界与实际写入日不一致时查不到数据。 */
function latestLedgerDay(ledgerRaw) {
  const days = (ledgerRaw && ledgerRaw.days) || {};
  const todayKey = utc8DayKey(Date.now());
  const keys = Object.keys(days).filter((d) => d <= todayKey).sort();
  return keys.length > 0 ? keys[keys.length - 1] : null;
}

/** 只聚合某一天的 provider→model。 */
function perModelOfSingleDay(ledgerRaw, day) {
  const out = new Map();
  const totals = { tokens: 0, requests: 0 };
  if (!day) return { byProvider: out, totals: totals };
  const rec = (ledgerRaw && ledgerRaw.days) ? ledgerRaw.days[day] : null;
  if (!rec || typeof rec !== "object") return { byProvider: out, totals: totals };
  const bpm = rec.byProviderModel || {};
  for (const key of Object.keys(bpm)) {
    const b = bpm[key];
    if (!b || typeof b !== "object") continue;
    const sep = key.indexOf(":");
    const provider = sep > 0 ? key.slice(0, sep) : key;
    const model = sep > 0 ? key.slice(sep + 1) : "";
    const tokens = num(b.input) + num(b.output) + num(b.cacheRead) + num(b.cacheWrite);
    const calls = num(b.calls);
    if (tokens <= 0 && calls <= 0) continue;
    let inner = out.get(provider);
    if (inner === undefined) { inner = new Map(); out.set(provider, inner); }
    const row = inner.get(model) || { model: model, tokens: 0, requests: 0, days: new Map(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    row.tokens += tokens; row.requests += calls; row.days.set(day, tokens);
    row.input += num(b.input); row.output += num(b.output); row.cacheRead += num(b.cacheRead); row.cacheWrite += num(b.cacheWrite);
    inner.set(model, row);
    totals.tokens += tokens; totals.requests += calls;
  }
  return { byProvider: out, totals: totals };
}
/** 从「本插件自己的账本」按 provider:model 聚合（与明细页同一数据源，保证数字一致）。 */
function perModelOfOwnLedger(ledgerRaw, sinceDays) {
  const out = new Map(); // provider -> Map(model -> { tokens, requests, days: Map(day, tokens) })
  const todayKey = utc8DayKey(Date.now());
  const cutoff = utc8DayKey(Date.now() - (Math.max(1, sinceDays) - 1) * 86400_000);
  const totals = { tokens: 0, requests: 0 };
  const days = (ledgerRaw && ledgerRaw.days) || {};
  for (const date of Object.keys(days)) {
    if (date < cutoff || date > todayKey) continue;
    const rec = days[date];
    if (!rec || typeof rec !== "object") continue;
    const bpm = rec.byProviderModel || {};
    for (const key of Object.keys(bpm)) {
      const b = bpm[key];
      if (!b || typeof b !== "object") continue;
      const sep = key.indexOf(":");
      const provider = sep > 0 ? key.slice(0, sep) : key;
      const model = sep > 0 ? key.slice(sep + 1) : "";
      const tokens = num(b.input) + num(b.output) + num(b.cacheRead) + num(b.cacheWrite);
      const calls = num(b.calls);
      if (tokens <= 0 && calls <= 0) continue;
      let inner = out.get(provider);
      if (inner === undefined) { inner = new Map(); out.set(provider, inner); }
      let row = inner.get(model);
      if (row === undefined) { row = { model: model, tokens: 0, requests: 0, days: new Map(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; inner.set(model, row); }
      row.tokens += tokens;
      row.requests += calls;
      row.days.set(date, (row.days.get(date) || 0) + tokens);
      row.input += num(b.input);
      row.output += num(b.output);
      row.cacheRead += num(b.cacheRead);
      row.cacheWrite += num(b.cacheWrite);
      totals.tokens += tokens;
      totals.requests += calls;
    }
  }
  return { byProvider: out, totals: totals, today: todayKey };
}
// —— 积分账单 / 额度窗口 / 余额快照 ————————————————————————

/** sessionId → { provider, model, at }：底部额度监控据此知道当前模型。 */
const lastUsedBySession = new Map();

function rememberUsed(sessionId, provider, model) {
  const sid = str(sessionId);
  const prov = str(provider);
  const mo = str(model);
  if (prov.length === 0 || mo.length === 0) return;
  const row = { provider: prov, model: mo, at: Date.now() };
  if (sid.length > 0) lastUsedBySession.set(sid, row);
  lastUsedBySession.set("", row);
  if (lastUsedBySession.size > 256) lastUsedBySession.delete(lastUsedBySession.keys().next().value);
}

function usedOf(sessionId) {
  const sid = str(sessionId);
  return (sid.length > 0 && lastUsedBySession.get(sid)) || lastUsedBySession.get("") || null;
}
/** 上限/限流状态：provider|model -> { until, reason, at }；到期自动失效，无需清理。 */
const CAPS_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'caps.json');
let capsCache = { version: 1, entries: {} };
let capsLoaded = false;
let capsScannedAt = 0;

/**
 * 限流恢复探测引擎（三阶段）。
 *
 * 阶段 A：触发后 1 分钟起，最多探 3 次，用于
 *   ① 验证限流真实性（若成功 = 误报，清 cap）
 *   ② 尽力拿到解禁时间（上游首条报障常无时间）
 * 阶段 B：距 until ≤ 10 分钟才开始探（每 2 分钟），成功即清除并停止。
 * 阶段 C：每 5 分钟查渠道余额（不花 token），余额上涨则立即触发一次探测 ——
 *   覆盖"充值后立刻恢复"的情况。
 *
 * 探测用 ctx.llm.prepareCall + stream 直调：不建会话、不留聊天记录。
 * 单次约 10 token，总成本 ≤100 token。
 */
const WHALE_PROBE_TAG = '[unified-quota] probe';
let probeTimer = null;
let probeBalanceSnapshot = null;
const probeState = new Map(); // key -> { phase, tries, nextAt, lastAt }

function probeKeyOf(provider, model) { return provider + "|" + model; }

/** 发一次最小探测调用；返回 true=可用，false=仍受限 */
async function probeModel(ctx, provider, model) {
  try {
    const llm = ctx.get ? ctx.get("llm") : null;
    if (!llm || typeof llm.prepareCall !== "function") return null; // 无法探测
    const call = await llm.prepareCall(provider, model);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 20000);
    try {
      const stream = call.stream({
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 4,
        signal: ctrl.signal,
      });
      // 只要读到第一个 chunk 就算通
      for await (const _chunk of stream) { break; }
      return { ok: true };
    } finally { clearTimeout(timer); }
  } catch (error) {
    const code = String(error && (error.code || (error.failure && error.failure.code)) || "").toUpperCase();
    // 把错误原文也带上：上游常在这里给出预计解禁时间
    const text = String(
      (error && (error.message || error.detail || error.rawMessage)) ||
      (error && error.failure && (error.failure.message || error.failure.detail)) ||
      error || ""
    );
    if (code.indexOf("QUOTA") >= 0) return { ok: false, code: code, text: text };
    // 即使 code 不是 QUOTA，报文里也可能有限流信号（各渠道不规范）
    const parsed = parseJetHubCap(text, Date.now());
    if (parsed !== null) return { ok: false, code: code, text: text, parsed: parsed };
    // 其它错误（网络/鉴权）按"不可判定"处理，不误清 cap
    return { ok: null, code: code, text: text };
  }
}

/** 主循环：每 30 秒 tick 一次，按各 cap 的状态决定是否需要探测 */
function startProbeLoop(ctx) {
  if (probeTimer !== null) return () => {};
  const tick = async function () {
    try {
      await loadCaps();
      const now = Date.now();
      // 阶段 C：渠道余额上涨 ⇒ 可能刚充值 ⇒ 强制把该渠道所有 cap 拉回阶段 A 立即探
      try {
        // 用已有的 loadCredits（credits.balances RPC，不花 token）
        const roster0 = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
        const creditRes = await loadCredits(ctx, roster0).catch(function () { return null; });
        const rows0 = creditRes && Array.isArray(creditRes.providers) ? creditRes.providers : null;
        if (rows0 !== null) {
          const prevBal = probeBalanceSnapshot;
          const next = {};
          for (const r of rows0) {
            const c = r && r.credits;
            const t = c && Number.isFinite(c.total) ? c.total : null;
            if (r && r.provider && t !== null) next[r.provider] = t;
          }
          if (prevBal !== null) {
            for (const [prov, v] of Object.entries(next)) {
              if (Number.isFinite(prevBal[prov]) && v > prevBal[prov] + 0.0001) {
                for (const [key, st] of probeState) {
                  if (key.indexOf(prov + "|") === 0) { st.phase = "A"; st.tries = 0; st.nextAt = now; }
                }
              }
            }
          }
          probeBalanceSnapshot = next;
        }
      } catch (e) {}
      for (const [key, entry] of Object.entries(capsCache.entries || {})) {
        const sep = key.indexOf("|");
        if (sep < 0) continue;
        const provider = key.slice(0, sep);
        const model = key.slice(sep + 1);
        if (entry.until <= now) {
          // 已过期：直接清除，无需探测
          delete capsCache.entries[key];
          probeState.delete(key);
          await saveCaps();
          continue;
        }
        let st = probeState.get(key);
        if (!st) { st = { phase: "A", tries: 0, nextAt: (entry.at || now) + 60000 }; probeState.set(key, st); }
        if (now < st.nextAt) continue;
        // 阶段 A：触发后 1 分钟起，最多 3 次，间隔 30 秒
        if (st.phase === "A") {
          if (st.tries >= 3) { st.phase = "B"; continue; }
          st.tries += 1;
          const pr = await probeModel(ctx, provider, model);
          if (pr && pr.ok === true) { delete capsCache.entries[key]; probeState.delete(key); await saveCaps(); continue; }
          // 探测时上游给了解禁时间 ⇒ 用它修正 cap（比自己猜的准）
          if (pr && pr.ok === false && pr.parsed && pr.parsed.until !== null) {
            const u = Number(pr.parsed.until);
            if (u > now && Math.abs(u - entry.until) > 60000) {
              entry.until = u;
              entry.reason = (entry.reason || '') + ' · 探测更新解禁';
              await saveCaps();
            }
          }
          st.nextAt = now + 30000;
          if (st.tries >= 3) st.phase = "B";
          continue;
        }
        // 阶段 B：**进入后半程就开始探**（原来只看最后 10 分钟，导致长时间挂着假 cap）
        //   - 剩余 > 50% 且 > 30 分钟：5 分钟一探
        //   - 剩余 ≤ 50% 或 ≤ 30 分钟：2 分钟一探
        //   - 剩余 ≤ 10 分钟：1 分钟一探
        if (st.phase === "B") {
          const left = entry.until - now;
          const total = Math.max(1, entry.until - (entry.at || entry.until));
          if (left > 30 * 60000 && left > total / 2) { st.nextAt = now + 5 * 60000; continue; }
          const prB = await probeModel(ctx, provider, model);
          if (prB && prB.ok === true) { delete capsCache.entries[key]; probeState.delete(key); await saveCaps(); continue; }
          if (prB && prB.ok === false && prB.parsed && prB.parsed.until !== null) {
            const u2 = Number(prB.parsed.until);
            if (u2 > now && Math.abs(u2 - entry.until) > 60000) { entry.until = u2; await saveCaps(); }
          }
          st.nextAt = now + (left <= 10 * 60000 ? 60000 : 2 * 60000);
          continue;
        }
      }
    } catch (e) { /* 单次失败不影响下一轮 */ }
  };
  probeTimer = setInterval(tick, 30000);
  void tick();
  return function () { if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; } };
}
async function loadCaps() {
  if (!capsLoaded) {
    capsLoaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(CAPS_PATH, "utf8"));
      if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") capsCache = raw;
    } catch (e) { /* 首次运行 */ }
  }
  return capsCache;
}

/**
 * 清理过期的 .bak 文件：同一前缀只保留最近 N 个。
 * 恢复/重算会留下 .bak-<ISO时间戳>，长期积累会占空间。
 */
const BAK_KEEP = 3;
async function pruneBackups(dir) {
  try {
    const all = await fs.readdir(dir);
    const groups = new Map();
    for (const f of all) {
      const m = /^(.+?)\.bak-/.exec(f);
      if (!m) continue;
      if (!groups.has(m[1])) groups.set(m[1], []);
      const st = await fs.stat(dir + '/' + f).catch(function () { return null; });
      groups.get(m[1]).push({ f: f, mtime: st ? st.mtimeMs : 0 });
    }
    for (const [, list] of groups) {
      if (list.length <= BAK_KEEP) continue;
      list.sort(function (a, b) { return b.mtime - a.mtime; });
      for (const item of list.slice(BAK_KEEP)) {
        await fs.unlink(dir + '/' + item.f).catch(function () {});
      }
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
}

async function saveCaps() {
  try {
    await fs.mkdir(path.dirname(CAPS_PATH), { recursive: true });
    const tmp = CAPS_PATH + ".tmp-" + process.pid;
    await fs.writeFile(tmp, JSON.stringify(capsCache), "utf8");
    await fs.rename(tmp, CAPS_PATH);
  } catch (e) { /* 尽力而为 */ }
}

/** 从一句话里解析「多久后恢复」。认不出来返回 null（调用方给保守默认值）。 */
function parseRecoveryMs(text, nowMs) {
  const t = String(text || "");
  const hm = /try again in\s*(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(t);
  if (hm !== null) return (Number(hm[1]) * 60 + (Number(hm[2]) || 0)) * 60000;
  const mm = /try again in\s*(\d+)\s*m/i.exec(t);
  if (mm !== null) return Number(mm[1]) * 60000;
  const sec = /retryAfterSeconds\W*[:=]\W*(\d+)/i.exec(t);
  if (sec !== null) return Number(sec[1]) * 1000;
  // 通用 "retry after N seconds/minutes/hours"
  const ra = /retry[\s_-]*after[\s:]*?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(t);
  if (ra !== null) {
    const n = Number(ra[1]);
    const u = ra[2].toLowerCase();
    if (Number.isFinite(n) && n > 0) {
      return u[0] === 'h' ? n * 3600000 : (u[0] === 'm' ? n * 60000 : n * 1000);
    }
  }
  const zh = /(\d+)\s*(分钟|小时)后/.exec(t);
  if (zh !== null) return Number(zh[1]) * (zh[2] === "小时" ? 3600000 : 60000);
  const slash = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(t);
  if (slash !== null) {
    const at = new Date(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3]), Number(slash[4]), Number(slash[5]), Number(slash[6])).getTime();
    if (Number.isFinite(at) && at > nowMs) return at - nowMs;
  }
  const iso = /resetsAt\W*[:=]\W*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i.exec(t);
  if (iso !== null) { const at = Date.parse(iso[1]); if (Number.isFinite(at) && at > nowMs) return at - nowMs; }
  return null;
}

/** 是否明确撞到上限。只在确定语义上为真，避免误判。 */
function looksCapped(text) {
  const t = String(text || "");
  // 只认上游**明确**的限流签名。
  // ⚠️ 绝不使用「出现 429 且出现 limit」这类松散判据：会话文本里到处是这两个词
  // （包括我们自己打印的测试样例），据此判定会把正常模型误标成「已触顶」。
  if (/Daily free limit reached/i.test(t)) return true;
  if (/INFERENCE_CAP_ERROR/.test(t)) return true;
  if (/\bCAP_ERROR\b/.test(t)) return true;
  if (/额度(?:已)?(?:用尽|用完)/.test(t)) return true;
  // jet-hub 的真实报障：账号在限流中并给出解禁时刻
  if (t.indexOf("均在限流中") !== -1) return true;
  if (/限流中.*解禁/.test(t)) return true;
  if (/Error\s+429\s*[:,]/i.test(t)) return true;
  if (/\bHTTP\s*429\b/.test(t)) return true;
  if (/rate limit(?:ed)?[^.]{0,40}(?:retry|again in|after)/i.test(t)) return true;
  return false;
}
function modelFromText(text, modelIds) {
  const t = String(text || "");
  for (const id of modelIds) {
    if (id.length >= 4 && t.indexOf(id) !== -1) return id;
  }
  const m = /model[\s:="\']+([\w.\/-]{4,})/i.exec(t);
  return m !== null ? m[1] : "";
}
/**
 * 扫最近的会话日志，找「撞上限」的证据并记进 caps.json。
 * 
 * 为什么只能扫日志：上游渠道**不提供**「这个模型还剩多少额度」的查询端点，
 * 429 / Daily free limit 只在真实请求失败时出现一次。所以这里做的是
 * 「事后记录 + 到期自动恢复」，而不是主动探测（主动探测会白烧额度）。
 * 每次最多解析最近 3 个会话日志的尾部若干帧，60 秒内不重复扫。
 */
/**
 * 解析 jet-hub 的真实限流报文，例如：
 *   「CodeBuddy (腾讯)：模型 deepseek-v4.1-flash 的可用账号均在限流中，
 *     最近一个将于 2026/11/16 13:57:30 解禁。」
 * 返回 { model, until, providerHint }；解析不出返回 null。
 */
/**
 * 限流/配额错误解析（分级检测，社区验证）。
 *
 * 判定优先级（来自 WorkBuddy2API 实战 + DSH 源码）：
 *   ① 业务码（最权威）：14018 积分耗尽 / 6004 模型配额 / 14003 模型繁忙 / 11102 无此模型
 *   ② HTTP 状态码：402 积分耗尽 / 429 限流
 *   ③ DSH 官方英文模式（isQuotaExceededError 的 5 条正则）
 *   ④ 各渠道中文文案（自己收集，持续扩充）
 *
 * ⚠️ 顺序很重要：社区踩过坑——429 的响应体常带 "quota exceeded"，
 *    若按关键词先判，限流会被误归为「积分耗尽」而硬冷却 12 小时。
 *    所以业务码/状态码优先于文案。
 */
const QUOTA_EN_PATTERNS = [
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
];

/** 各渠道中文文案（持续积累，来自真实报错） */
const QUOTA_ZH_PATTERNS = [
  { re: /均在限流中|限流中/, kind: "rate" },
  { re: /所有账号均|账号均|均受限/, kind: "rate" },
  { re: /配额使用上限|配额.{0,4}耗尽|已达.{0,4}上限/, kind: "quota" },
  { re: /额度不够|额度不足|积分不足|积分已用尽|积分耗尽/, kind: "quota" },
  { re: /usage\s*limit|quota\s*exceeded|insufficient\s*quota|credits?\s*exhausted/i, kind: "quota" },
  { re: /使用量已超出频率限制/, kind: "rate" },
];

/** 业务码 → 等级（来自 WorkBuddy2API） */
const BUSINESS_CODES = {
  "14018": { kind: "hard-credit", label: "积分耗尽" },
  "6004": { kind: "model-quota", label: "模型配额" },
  "14003": { kind: "model-busy", label: "模型繁忙" },
  "11102": { kind: "model-missing", label: "无此模型" },
};

function parseJetHubCap(text, nowMs, statusCode) {
  const t = String(text || "");
  if (t.length === 0 && !statusCode) return null;

  // ① 业务码（最权威）
  let kind = null;
  for (const [code, info] of Object.entries(BUSINESS_CODES)) {
    if (new RegExp("\\b" + code + "\\b").test(t)) { kind = info.kind; break; }
  }
  // ② HTTP 状态码
  if (kind === null && statusCode) {
    if (statusCode === 402) kind = "hard-credit";
    else if (statusCode === 429) kind = "rate";
  }
  // ③ 英文模式（DSH 官方认得的）
  if (kind === null) {
    for (const re of QUOTA_EN_PATTERNS) { if (re.test(t)) { kind = "quota"; break; } }
  }
  // ④ 中文文案（各渠道实测）
  if (kind === null) {
    for (const p of QUOTA_ZH_PATTERNS) { if (p.re.test(t)) { kind = p.kind; break; } }
  }
      // ⑤ 兜底：报文里出现「retry after / N 分钟后 / 限流 / 429」等信号，即使没命中上面的模式也算 rate
    if (/retry[\s_-]*after|try again in|rate.?limit|too many requests|\b429\b|限流|稍后再试|\d+\s*(?:分钟|小时|秒)后|解禁|均受限|可用账号|等待解禁/i.test(t)) { kind = "rate"; }
    if (kind === null) return null;
  // 402/14018 之外的「模型缺失」不算额度上限
  if (kind === "model-missing") return null;

  // —— 提取 model ——
  let model = "";
  const m1 = /模型\s+([\w.\/-]{3,})/.exec(t);
  if (m1 !== null) model = m1[1];
  if (model.length === 0) {
    const m2 = /model\s+([\w.\/-]{3,})/i.exec(t);
    if (m2 !== null) model = m2[1];
  }

  // —— 提取解禁时间 ——
  let until = null;
  const d1 = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(t);
  if (d1 !== null) {
    const at = new Date(Number(d1[1]), Number(d1[2]) - 1, Number(d1[3]), Number(d1[4]), Number(d1[5]), Number(d1[6])).getTime();
    if (Number.isFinite(at) && at > nowMs) until = at;
  }
  if (until === null) {
    const d2 = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/.exec(t);
    if (d2 !== null) {
      const at = new Date(Number(d2[1]), Number(d2[2]) - 1, Number(d2[3]), Number(d2[4]), Number(d2[5])).getTime();
      if (Number.isFinite(at) && at > nowMs) until = at;
    }
  }
  if (until === null && typeof parseRecoveryMs === "function") {
    const rel = parseRecoveryMs(t, nowMs);
    if (rel !== null) until = nowMs + Math.max(60000, rel);
  }

  // —— 提取渠道名 ——
  let providerHint = "";
  const p1 = /CodeBuddy\s*[（(]\s*腾讯\s*[)）]/.exec(t);
  if (p1 !== null) providerHint = "codebuddy";
  if (providerHint.length === 0) {
    const p2 = /^\s*(?:本轮运行失败\s*)?([A-Za-z][\w-]{1,20})\s*[:：]/.exec(t);
    if (p2 !== null) providerHint = p2[1].toLowerCase();
  }

  return { model, until, providerHint, kind };
}

/**
 * 渠道限流知识库：每次限流事件追加一条，永久保存。
 * 文件：storages/unified-quota/cap-knowledge.jsonl
 */
const CAP_KB_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'cap-knowledge.jsonl');
/**
 * 学到的容量上限：key = "provider|model"，value = { tokens, at, samples }
 * 触发限流时，把「该周期内的实际用量」记为容量上限。
 * 多次触发取「最小值」——真实容量不会大于任何一次触顶时的用量。
 */
const LEARNED_CAP_PATH = path.join(DSH_HOME, 'storages', 'unified-quota', 'learned-caps.json');
let learnedCapCache = null;
async function loadLearnedCaps() {
  if (learnedCapCache !== null) return learnedCapCache;
  try { learnedCapCache = JSON.parse(await fs.readFile(LEARNED_CAP_PATH, 'utf8')) || { entries: {} }; } catch (e) { learnedCapCache = { entries: {} }; }
  if (!learnedCapCache.entries) learnedCapCache.entries = {};
  return learnedCapCache;
}
async function saveLearnedCaps(state) {
  learnedCapCache = state;
  try {
    await fs.mkdir(path.dirname(LEARNED_CAP_PATH), { recursive: true });
    const tmp = LEARNED_CAP_PATH + '.tmp-' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, LEARNED_CAP_PATH);
  } catch (e) { criticalCatch(DEBUG_DIR, "persist:1590", e); }
}
/**
 * 记录一次「容量学习」：触发限流时调用。
 * @param tokens 该周期内的实际用量（触顶时的用量 ≈ 容量上限）
 */
async function learnCapacity(provider, model, tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return null;
  const state = await loadLearnedCaps();
  const key = provider + '|' + model;
  const prev = state.entries[key];
  // 取最小值：真实容量 ≤ 任何一次触顶时的用量
  const next = (prev && Number(prev.tokens) > 0 && prev.tokens < t) ? prev.tokens : t;
  state.entries[key] = { tokens: Math.round(next), at: Date.now(), samples: ((prev && prev.samples) || 0) + 1, lastSeen: Math.round(t) };
  await saveLearnedCaps(state);
  return state.entries[key];
}
async function appendCapKnowledge(provider, model, untilMs, reason) {
  try {
    const text = String(reason || '');
    const nowMs = Date.now();
    // —— 反推周期用的关键数据 ——
    // 目标：多次限流后，用 (at, 周期内累计用量) 推断真实周期长度
    let usedInWindow = null;   // 触发瞬间「你认为是本周期」的累计用量
    let usedToday = null;      // 当日累计（对照用）
    let balanceAt = null;      // 触发瞬间余额
    let sessionCount = null;   // 本周期调用次数
    try {
      const led = await readJsonCached(OWN_LEDGER_PATH);
      const days = (led && led.days) || {};
      const todayKey = utc8DayKey(nowMs);
      const day = days[todayKey] || null;
      const b = day && day.byProviderModel ? day.byProviderModel[provider + ":" + model] : null;
      if (b) {
        const tok = (Number(b.input) || 0) + (Number(b.output) || 0) + (Number(b.cacheRead) || 0) + (Number(b.cacheWrite) || 0);
        usedToday = tok;
        usedInWindow = tok;          // 当前实现以「今日」为周期口径
        sessionCount = Number(b.calls) || 0;
      }
      // 余额快照：取 balance-log 里该渠道最后一条
      const bl = await readJsonCached(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'));
      const arr = bl && bl.entries && Array.isArray(bl.entries[provider]) ? bl.entries[provider] : [];
      if (arr.length > 0) {
        const last = arr[arr.length - 1];
        if (last && Number.isFinite(Number(last.total))) balanceAt = Number(last.total);
      }
    } catch (e) { /* 附加数据失败不影响记录 */ }
    const rec = {
      at: nowMs,
      provider: provider,
      model: model,
      until: untilMs,
      hasUntil: /\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(text),
      kind: /积分耗尽|quota.{0,6}exhaust/i.test(text) ? 'hard-credit'
        : /均受限|所有账号|rate.?limit|限流/i.test(text) ? 'rate'
        : 'quota',
      // 反推周期用（v2 新增）
      usedInWindow: usedInWindow,
      usedToday: usedToday,
      balanceAt: balanceAt,
      sessionCount: sessionCount,
      // 推断用：距上次同模型限流过了多久
      sincePrevSameModel: null,
      text: text.slice(0, 300),
    };
    // 从上一条同模型记录算间隔（周期推断的直接依据）
    try {
      const raw = await fs.readFile(CAP_KB_PATH, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
        const p = JSON.parse(lines[i]);
        if (p && p.provider === provider && p.model === model && Number.isFinite(p.at) && p.at < nowMs) {
          rec.sincePrevSameModel = nowMs - Number(p.at);
          rec.prevAt = Number(p.at);
          rec.prevUsed = Number(p.usedInWindow);
          break;
        }
      }
    } catch (e) { /* 首次记录没有历史 */ }
    await fs.mkdir(path.dirname(CAP_KB_PATH), { recursive: true });
    await fs.appendFile(CAP_KB_PATH, JSON.stringify(rec) + '\n', 'utf8');
    // 防无限增长：超过 512KB 截断到最近 1000 条
    const st = await fs.stat(CAP_KB_PATH).catch(() => null);
    if (st && st.size > 512 * 1024) {
      const all = (await fs.readFile(CAP_KB_PATH, 'utf8')).trim().split('\n');
      await fs.writeFile(CAP_KB_PATH, all.slice(-1000).join('\n') + '\n', 'utf8');
    }
  } catch (e) { /* 记录失败不影响主流程 */ }
}
/**
 * 从限流历史推断周期长度。
 *
 * 原理：同一模型反复触发限流时，两次触发的时间差若高度一致，
 * 那个差值大概率就是周期长度（每次都用满 ⇒ 间隔 = 周期）。
 *
 * 返回：{ samples, guessedMs, confidence, detail }
 *   confidence: high（≥3 次且方差小）/ low（1-2 次）/ none
 */
function inferPeriodFromHistory(entries, provider, model) {
  const same = entries.filter(function (e) {
    return e && e.provider === provider && e.model === model && Number.isFinite(Number(e.at));
  }).sort(function (a, b) { return a.at - b.at; });
  if (same.length < 2) {
    return { samples: same.length, guessedMs: null, confidence: 'none', detail: '需要至少 2 次同模型限流' };
  }
  const gaps = [];
  for (let i = 1; i < same.length; i++) {
    const g = same[i].at - same[i - 1].at;
    // 忽略 5 分钟内的重复（同一次限流的多条记录）
    if (g > 5 * 60000) gaps.push({ gap: g, from: same[i - 1].at, to: same[i].at });
  }
  if (gaps.length === 0) {
    return { samples: same.length, guessedMs: null, confidence: 'none', detail: '间隔全小于 5 分钟，视为同一次限流' };
  }
  // 取中位数（抗异常值）
  const sorted = gaps.map(function (x) { return x.gap; }).sort(function (a, b) { return a - b; });
  const median = sorted[Math.floor(sorted.length / 2)];
  // 一致性：与中位数的相对偏差 ≤ 20% 视为同一周期
  const consistent = gaps.filter(function (x) {
    return Math.abs(x.gap - median) / median <= 0.2;
  });
  const confidence = (gaps.length >= 2 && consistent.length >= 2) ? 'high' : 'low';
  return {
    samples: same.length,
    gaps: gaps.map(function (x) { return Math.round(x.gap / 60000) + '分'; }),
    guessedMs: median,
    guessedHuman: (median >= 3600000 ? (median / 3600000).toFixed(1) + ' 小时' : (median / 60000).toFixed(0) + ' 分钟'),
    consistency: gaps.length > 1 ? (consistent.length + '/' + gaps.length) : '1/1',
    confidence: confidence,
  };
}


async function recordCap(provider, model, untilMs, reason) {
  await loadCaps();
  const key = provider + "|" + model;
  const prev = capsCache.entries[key];
  if (prev !== undefined && Number(prev.until) >= untilMs) return false;
  capsCache.entries[key] = { until: untilMs, at: Date.now(), reason: String(reason || "").slice(0, 200) };
  await saveCaps();
  // 知识库自动积累：记录每次限流事件的完整信息（永久保存，供后续分析）
  try { await appendCapKnowledge(provider, model, untilMs, reason); } catch (e) { criticalCatch(DEBUG_DIR, "persist:1641", e); }
  return true;
}

/** 从任意错误对象记录上限（供 llm/stream 钩子调用）。 */
/** 渠道显示名/别名 → 内部 provider id */
const PROVIDER_ALIAS = {
  codebuddy: 'buddy', buddy: 'buddy', workbuddy: 'workbuddy',
  qoder: 'qodercn', qodercn: 'qodercn', lingma: 'qodercn',
  trae: 'trae', codearts: 'codearts', zcode: 'zcode',
  opencode: 'opencode', cline: 'cline', minimax: 'minimax',
  doubao: 'doubao', deepseek: 'deepseek-account',
};
/** 已知渠道白名单（避免把垃圾字符串当渠道名） */
const KNOWN_PROVIDERS = new Set([
  'buddy', 'workbuddy', 'qodercn', 'trae', 'codearts', 'zcode',
  'opencode', 'cline', 'minimax', 'doubao', 'deepseek-account', 'deepseek-official',
]);

async function recordCapFromError(error, hint) {
  try {
    const text = String(error && (error.message || error) || "");
    // ① 结构化优先：DSH 的 LlmError 自带 provider-neutral 错误码
    //    QUOTA / ACCOUNT_QUOTA 明确表示"额度耗尽"，比文本匹配可靠得多。
    //    （文本匹配只能覆盖 jet-hub 的中文报障措辞，上游换个说法就失效）
    let structured = "";
    try {
      const code = error && (error.code || (error.failure && error.failure.code));
      if (typeof code === "string") structured = code.toUpperCase();
    } catch (e) {}
    // 实测 DSH 抛的 code 是 QUOTA_EXCEEDED（不是文档里的 QUOTA）；
    // 用 includes 覆盖 QUOTA / QUOTA_EXCEEDED / ACCOUNT_QUOTA 等变体。
    const isQuotaCode = structured.length > 0 && (structured.indexOf("QUOTA") >= 0 || structured === "BALANCE" || structured === "INSUFFICIENT_QUOTA");
    // ② 文本解析（拿 model / until / providerHint）
    const parsed = parseJetHubCap(text, Date.now());
    if (parsed === null && !isQuotaCode) return false;
    const model = (parsed && parsed.model) || str(hint && hint.model);
    if (model.length === 0) return false;
    // ⚠️ 渠道名以**报文里的**为准，hint 只作兜底。
    // 实测：报文写 "buddy: 模型 deepseek-v4.1-flash 所有账号均受限"，
    // 而 agent/error 的 hint.provider 是 DSH 内部 id（deepseek-account），
    // 若优先用 hint 会把上限挂到不存在的渠道上 ⇒ 额度窗口查不到 ⇒ 显示未触顶。
    let provider = "";
    if (parsed && parsed.providerHint && parsed.providerHint.length > 0) {
      provider = PROVIDER_ALIAS[parsed.providerHint] || parsed.providerHint;
    }
    if (provider.length === 0) provider = str(hint && hint.provider);
    // 报文前缀形如 "buddy: 模型 ..."，从中再取一次渠道名（最高优先）
    const headMatch = /^\s*(?:本轮运行失败\s*)?([A-Za-z][\w-]{1,20})\s*[:：]/.exec(text);
    if (headMatch !== null) {
      const head = headMatch[1].toLowerCase();
      const mapped = PROVIDER_ALIAS[head] || head;
      if (KNOWN_PROVIDERS.has(mapped)) provider = mapped;
    }
    if (provider.length === 0) return false;
    // 只挂到「确实有这个模型」的渠道；报文里给了渠道名就只挂那一个
    // 按 kind 决定默认冷却（社区经验：模型级限流短、账号级/积分耗尽长）
    const kind = (parsed && parsed.kind) || "rate";
    const DEFAULT_MS = {
      "hard-credit": 24 * 3600000,   // 积分耗尽：等充值或次日重置
      "model-quota": 6 * 3600000,    // 模型配额：通常按小时恢复
      "model-busy": 10 * 60000,      // 模型繁忙：10 分钟
      "rate": 6 * 3600000,           // 一般限流：6 小时（比原来 24h 更实际）
      "quota": 12 * 3600000,         // 配额耗尽：12 小时
    };
    const defMs = DEFAULT_MS[kind] || 6 * 3600000;
    const until = (!parsed || parsed.until === null) ? Date.now() + defMs : parsed.until;
    // 容量学习：触发限流时，把「该模型本周期已用量」记为容量上限
    try {
      const led = await readJsonCached(OWN_LEDGER_PATH);
      const dayKey = utc8DayKey(Date.now());
      let usedTok = 0;
      // 周期口径：今日（大多数渠道按日重置）
      const day = led && led.days ? led.days[dayKey] : null;
      const b = day && day.byProviderModel ? day.byProviderModel[provider + ":" + model] : null;
      if (b) usedTok = (Number(b.input) || 0) + (Number(b.output) || 0) + (Number(b.cacheRead) || 0) + (Number(b.cacheWrite) || 0);
      if (usedTok > 0) {
        const learned = await learnCapacity(provider, model, usedTok);
        if (learned) ctx.logger?.info?.('[unified-quota] 学到容量 %s|%s = %s tok', provider, model, learned.tokens);
      }
    } catch (e) { criticalCatch(DEBUG_DIR, "cap:1721", e); }
    return await recordCap(provider, model, until, text);
  } catch (e) { return false; }
}
async function scanCaps(ctx, modelIds, force) {
  await loadCaps();
  const now = Date.now();
  if (!force && capsScannedAt > 0 && now - capsScannedAt < 60000) return capsCache;
  capsScannedAt = now;
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const candidates = [];
  try {
    const root = path.join(DSH_HOME, "sessions");
    const walk = async (dir, depth) => {
      if (depth > 3) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) continue;
        const st = await fs.stat(full).catch(() => null);
        if (st !== null) candidates.push({ file: full, mtime: st.mtimeMs, size: st.size });
      }
    };
    await walk(root, 0);
    candidates.sort((a, b) => b.mtime - a.mtime);
    let changed = false;
    for (const cand of candidates.slice(0, 3)) {
      if (cand.size > 40 * 1024 * 1024) continue;
      let buf;
      try { buf = await fs.readFile(cand.file); } catch (e) { continue; }
      // 只解尾部若干帧：限流信号都发生在最近，代价可控
      const idx = [];
      for (let i = 0; i + 4 <= buf.length; i += 1) if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
      const from = Math.max(0, idx.length - 60);
      for (let k = from; k < idx.length; k += 1) {
        const start = idx[k];
        const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
        let text = "";
        try { text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8"); } catch (e) { continue; }
        // 只扫「错误记录」：tool/result 的 isError、或带 error 字段的帧。
        // 纯文本帧（对话正文、我们自己的代码）不参与判定。
        // 结构化门控：只有「tool/result 且 message.isError === true」的记录才算错误。
        // 用字符串搜索 "isError":true 不行 —— 我们自己打印的测试样例也会命中。
        let sawError = false;
        for (const line of text.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (e) { continue; }
          const msg = rec && rec.data ? rec.data.message : null;
          const errText = msg && msg.isError === true ? JSON.stringify(msg.content || msg) : "";
          if (errText.length === 0) continue;
          if (!looksCapped(errText)) continue;
          sawError = true;
          break;
        }
        if (!sawError) continue;
        const model = modelFromText(text, modelIds);
        if (model.length === 0) continue;
        const waitMs = parseRecoveryMs(text, now);
        const until = now + (waitMs === null ? 6 * 3600000 : Math.max(60000, waitMs));
        for (const provider of new Set(modelIds.providers || [])) {
          const key = provider + "|" + model;
          const prev = capsCache.entries[key];
          if (prev !== undefined && Number(prev.until) >= until) continue;
          capsCache.entries[key] = { until: until, at: now, reason: model + (waitMs === null ? "" : " retry-after") };
          changed = true;
        }
      }
    }
    if (changed) await saveCaps();
  } catch (e) { if (ctx && ctx.logger && ctx.logger.warn) ctx.logger.warn("[unified-quota] scanCaps failed: " + String(e && e.message || e)); }
  return capsCache;
}
/**
 * 余额快照：**每次读数都存一条**（同一渠道一天可有多条）。
 * 
 * 为什么不能"同日只留最后一条"：要算「今天早上 6000 → 现在 5478.45」这种**日内差**，
 * 必须有当天更早的样本。只留最后一条会让日内差永远算不出来。
 * 存储：entries[provider] = [{ at, total, unit }]，按时间升序，保留 120 天、最多 4000 条。
 */
let balanceLog = { version: 2, entries: {} };
let balanceLogLoaded = false;

async function loadBalanceLog() {
  if (balanceLogLoaded) return balanceLog;
  balanceLogLoaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(BALANCE_LOG_PATH, "utf8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
      // 迁移旧格式（{ day: { total } }）→ 样本数组
      for (const [prov, val] of Object.entries(raw.entries)) {
        if (Array.isArray(val)) continue;
        const arr = [];
        for (const [day, rec] of Object.entries(val || {})) {
          const at = Number(rec && rec.at);
          const total = Number(rec && rec.total);
          if (Number.isFinite(total)) arr.push({ at: Number.isFinite(at) ? at : Date.parse(day + "T12:00:00+08:00"), total: total, unit: str(rec && rec.unit) });
        }
        arr.sort((x, y) => x.at - y.at);
        raw.entries[prov] = arr;
      }
      raw.version = 2;
      balanceLog = raw;
    }
  } catch (e) { /* 首次运行 */ }
  return balanceLog;
}

async function saveBalanceLog() {
  try {
    await fs.mkdir(path.dirname(BALANCE_LOG_PATH), { recursive: true });
    const tmp = BALANCE_LOG_PATH + ".tmp-" + process.pid;
    await fs.writeFile(tmp, JSON.stringify(balanceLog), "utf8");
    await fs.rename(tmp, BALANCE_LOG_PATH);
  } catch (e) { /* 尽力而为 */ }
}

/** 记录一次读数；30 秒内重复值不重复存，避免刷爆。 */
async function recordBalances(rows) {
  const log = await loadBalanceLog();
  const now = Date.now();
  let changed = false;
  for (const r of Array.isArray(rows) ? rows : []) {
    const provider = str(r && r.provider);
    const total = Number(r && r.credits && r.credits.total);
    if (provider.length === 0 || !Number.isFinite(total)) continue;
    const arr = Array.isArray(log.entries[provider]) ? log.entries[provider] : (log.entries[provider] = []);
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (last !== null && last.total === total && now - Number(last.at) < 30000) continue;
    arr.push({ at: now, total: total, unit: str(r.credits.unit) });
    const cutoff = now - 120 * 86400_000;
    log.entries[provider] = arr.filter((s) => Number(s.at) >= cutoff).slice(-4000);
    changed = true;
  }
  if (changed) { await saveBalanceLog(); balanceLogCache = log; }
  return log;
}

/**
 * 余额差反推真实消耗。返回日内与窗口两个口径：
 *   today: 今天最早的样本 → 现在（这是用户最关心的「今天用了多少」）
 *   window: 窗口内最早 → 现在
 * 只有 ≥2 个样本才算得出来；否则返回 null（不猜）。
 */
function realConsumption(log, provider, sinceDays) {
  const arr = log && log.entries ? log.entries[provider] : null;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const now = Date.now();
  const todayKey = utc8DayKey(now);
  const cutoff = utc8DayKey(now - (Math.max(1, sinceDays) - 1) * 86400_000);
  const inWindow = arr.filter((s) => utc8DayKey(Number(s.at)) >= cutoff);
  const todays = arr.filter((s) => utc8DayKey(Number(s.at)) >= todayKey);
  /**
   * 累计「下降」为消耗、累计「上升」为赠额（签到 / 充值 / 每日重置）。
   * 
   * ⚠️ 不能用「首末相减」：中途签到或充值会让余额变大，首末差会被抵消甚至变负
   * （实测出现过「实扣 -100」）。逐段求和才是稳的。
   */
  const scan = (list) => {
    let spent = 0, granted = 0, steps = 0;
    for (let k = 1; k < list.length; k += 1) {
      const prev = Number(list[k - 1].total);
      const cur = Number(list[k].total);
      if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
      const d = prev - cur;
      if (d > 0) spent += d; else if (d < 0) granted += -d;
      steps += 1;
    }
    return { spent: Math.round(spent * 1e6) / 1e6, granted: Math.round(granted * 1e6) / 1e6, steps: steps,
      start: Number(list[0].total), end: Number(list[list.length - 1].total),
      from: utc8DayKey(Number(list[0].at)), fromAt: Number(list[0].at) };
  };
  const out = { start: null, end: Number(arr[arr.length - 1].total), consumed: 0, granted: 0, samples: 0,
    from: "", fromAt: 0, unit: str(arr[arr.length - 1].unit), today: null };
  if (todays.length >= 2) out.today = scan(todays);
  if (inWindow.length >= 2) {
    const w = scan(inWindow);
    out.start = w.start;
    out.consumed = w.spent;
    out.granted = w.granted;
    out.samples = w.steps + 1;
    out.from = w.from;
    out.fromAt = w.fromAt;
  } else if (out.today === null) return null;
  return out;
}
let ratesInstance = null;
let ratesReady = null;

function ratesOf() {
  if (ratesInstance === null) {
    ratesInstance = new DailyRates(null);
    ratesReady = (async () => {
      try {
        const saved = await readJsonCached(RATES_PATH);
        if (saved && typeof saved === "object" && saved.rates) ratesInstance.state = saved;
      } catch (e) { /* first run */ }
      return ratesInstance;
    })();
  }
  return ratesInstance;
}

async function ensureRates(ctx, force) {
  const daily = ratesOf();
  await (ratesReady || Promise.resolve());
  const before = daily.state && daily.state.date;
  const result = await daily.refresh(force === true);
  if (result.changed && result.state && result.state.date !== before) {
    try {
      await fs.mkdir(path.dirname(RATES_PATH), { recursive: true });
      const tmp = RATES_PATH + ".tmp-" + process.pid;
      await fs.writeFile(tmp, JSON.stringify(result.state), "utf8");
      await fs.rename(tmp, RATES_PATH);
    } catch (e) { if (ctx && ctx.logger && ctx.logger.warn) ctx.logger.warn("[unified-quota] rates persist failed: " + String(e && e.message || e)); }
  }
  return result.state;
}

/** 人民币原值 → 目标币种（小鲸鱼/官方余额用）。返回乘数：目标汇率 / CNY汇率。 */
function cnyToTarget() {
  try {
    const cfg = configStoreOf().get();
    const target = (cfg && cfg.currency) || 'CNY';
    if (target === 'CNY') return 1;
    const rates = ratesOf();
    const cny = rates.get('CNY');
    const t = rates.get(target);
    const cnyN = (cny !== null && cny > 0) ? cny : 6.6665;
    const tN = (t !== null && t > 0) ? t : 1;
    return tN / cnyN;
  } catch (e) { return 1; }
}
function rateFor(config) {
  const currency = config && config.currency ? config.currency : "CNY";
  if (currency === "USD") return 1;
  // 手动指定汇率优先（用户可覆盖周末/节假日的 ECB 旧汇率）
  const manual = Number(config && config.manualRate);
  if (Number.isFinite(manual) && manual > 0) return manual;
  const live = ratesOf().get(currency);
  if (live !== null) return live;
  const fallback = Number(config && config.exchangeRate);
  return fallback > 0 ? fallback : 7.1;
}

let configStoreInstance = null;
function configStoreOf() {
  if (configStoreInstance === null) configStoreInstance = new ConfigStore(CONFIG_PATH);
  return configStoreInstance;
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并翻倍内部引号。 */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** semver 比较：a > b 返回 true（仅支持 x.y.z 数字段）。 */
function semverGt(a, b) {
  const pa = String(a || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  const pb = String(b || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

/**
 * 逐次调用明细：从账本的 sessions 与 byProviderModel 反推不出单次调用，
 * 因此这里读会话日志（只读、只取 usage 与模型归属，不碰正文）。
 * 日志缺失或格式变化时返回空列表并给出原因，前端显示"无逐次数据"而不是报错。
 */
async function readCallRows(limit) {
  const calls = [];
  try {
    const root = path.join(DSH_HOME, 'sessions');
    const recent = [];
    // 结构是 sessions/<workspace>/<sessionId>/session.vN.jsonl(.zstd)，递归两层
    const walk = async (dir, depth) => {
      if (depth > 3) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) continue;
        const st = await fs.stat(full).catch(() => null);
        if (st !== null) recent.push({ dir: path.basename(dir), file: full, mtime: st.mtimeMs, size: st.size });
      }
    };
    await walk(root, 0);
    recent.sort((a, b) => b.mtime - a.mtime);
    const zlib = await import('node:zlib');
    for (const entry of recent.slice(0, 4)) {
      let text = '';
      const buf = await fs.readFile(entry.file).catch(() => null);
      if (buf === null) continue;
      if (entry.file.endsWith('.zstd')) {
        // 多帧 zstd：逐个 magic 扫描后分别解压
        const offs = [];
        for (let i = 0; i + 4 <= buf.length; i++) {
          if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
        }
        for (let k = 0; k < offs.length; k++) {
          const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
          try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch { /* 残帧跳过 */ }
        }
      } else {
        text = buf.toString('utf8');
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'assistant/message' || !rec.data || !rec.data.usage) continue;
        const u = rec.data.usage;
        const src = rec.data.message && rec.data.message.source ? rec.data.message.source : {};
        const tok = num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
        if (tok <= 0) continue;
        calls.push({
          at: num(rec.time),
          sessionId: entry.dir,
          provider: str(src.provider),
          model: str(src.model),
          turn: num(rec.data.turn),
          step: num(rec.data.step),
          input: num(u.inputTokens), output: num(u.outputTokens),
          cacheRead: num(u.cacheReadTokens), cacheWrite: num(u.cacheWriteTokens),
          reasoning: num(u.reasoningTokens), tokens: tok,
        });
      }
      if (calls.length >= limit) break;
    }
  } catch (error) {
    return { calls: [], error: String(error && error.message || error) };
  }
  calls.sort((a, b) => b.at - a.at);
  return { calls: calls.slice(0, limit), error: null };
}

export function apply(ctx, config) {
  // —— 小鲸鱼挂件资产（阶段1：原样复用 whale-widget.js，不改其内部 23 处路径）——
  const WIDGET_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'whale-widget.js');
  let widgetJsCache = null;
  function loadWidgetJs() {
    try {
      const st = fsSync.statSync(WIDGET_JS_PATH);
      if (widgetJsCache && widgetJsCache.mtimeMs === st.mtimeMs) return widgetJsCache.text;
      widgetJsCache = { text: fsSync.readFileSync(WIDGET_JS_PATH, 'utf8'), mtimeMs: st.mtimeMs };
      return widgetJsCache.text;
    } catch (e) { return widgetJsCache ? widgetJsCache.text : ''; }
  }
  // —— 阶段1b：注册挂件注入行（同步注册，不依赖任何服务就绪）——
  // 安全：用 kind:"script" + 内联建 script + 吞 onerror；严禁用 script-src（失败会 reject __DSH_BOOT_READY__ 拖垮 DSH）。
  const WIDGET_ROW_TEXT = '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
    + 'var s=document.createElement("script");s.src="/dsh-whale/widget.js";s.onerror=function(){};d.appendChild(s)}catch(e){}})()';
  const disposeIndexInject = ctx.on("webserver/index-inject", (table) => {
    try {
      if (!Array.isArray(table)) return;
      for (const row of table) {
        if (!row) continue;
        // 已有任意指向 /dsh-whale/widget.js 的行（含小鲸鱼的）→ 幂等，不追加
        if (row.kind === "script-src" && String(row.src).indexOf("/dsh-whale/widget.js") >= 0) return;
        if (row.kind === "script" && typeof row.text === "string" && row.text.indexOf("/dsh-whale/widget.js") >= 0) return;
      }
      table.push({ kind: "script", placement: "body", text: WIDGET_ROW_TEXT });
    } catch (e) { /* 注入失败不影响宿主启动 */ }
  });
  ctx.effect?.(() => () => { try { disposeIndexInject && disposeIndexInject(); } catch (e) {} }, "unified-quota: index-inject");
  // —— 轮次信号（对齐 dsh-whale-widget 的 finalizeTurn 机制）——
  // 挂件用 `seq > lastCostSeq` 判断"有新一轮完成"，因此 seq 必须是**真实轮次**，
  // 不能是调用次数（任务中会涨）也不能只看金额（并发会话会干扰）。
  // 正确来源：DSH 的 session/event 中 type === "turn/end"。
  const WHALE_TURN_FILE = path.join(DSH_HOME, '.dshw-turn.json');
  let whaleTurnSeq = 0;
  // 挂件首次轮询时若 seq > localStorage 记忆值，会误判为「刚完成一轮」并弹窗+响铃。
  // 加一个短暂的「对齐窗口」：进程启动后 3 秒内返回 seq 的**起始值**（不增不减），
  // 让挂件把 localStorage 拉齐到真实值，之后再正常递增。
  const whaleBootAt = Date.now();
  try {
    const t0 = JSON.parse(fsSync.readFileSync(WHALE_TURN_FILE, 'utf8'));
    if (t0 && typeof t0.seq === 'number' && t0.seq >= 0) whaleTurnSeq = t0.seq;
    ctx.logger?.info?.('[unified-quota] whale turn seq 载入 %s（%s）', whaleTurnSeq, WHALE_TURN_FILE);
  } catch (e) {
    ctx.logger?.warn?.('[unified-quota] whale turn seq 读取失败: %s（%s）', String(e && e.message || e).slice(0, 80), WHALE_TURN_FILE);
  }
  let whaleLastTurnState = null; // { turn, amount, tokens, ts }
  const whaleTurnAggs = new Map(); // sessionId -> { turn, cost, tokens, lastTs }
  // 子代理会话集合：后台任务跑完不应弹「本轮消耗」小窗，也不该推进 seq。
  // （对齐 dsh-whale-widget 的 isSub 判断）
  const whaleSubSessions = new Set();
  // 诊断：把 subagent 事件的真实 payload 写盘，用于核对字段名
  function whaleDbg(name, info) {
    try {
      const p = path.join(DSH_HOME, "storages", "unified-quota", "subagent-debug.jsonl");
      fsSync.mkdirSync(path.dirname(p), { recursive: true });
      fsSync.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ev: name, keys: Object.keys(info || {}).join(","), info: JSON.stringify(info || {}).slice(0, 300) }) + "\n", "utf8");
    } catch (e) { criticalCatch(DEBUG_DIR, "persist:2113", e); }
  }
  try {
    ctx.on('subagent/start', function (info) {
      whaleDbg('start', info);
      try {
        const cands = [info && info.sessionId, info && info.id, info && info.runId, info && info.childId].filter(Boolean);
        for (const c of cands) whaleSubSessions.add(String(c));
      } catch (e) {}
    });
    ctx.on('subagent/end', function (info) {
      whaleDbg('end', info);
      try {
        const cands = [info && info.sessionId, info && info.id, info && info.runId, info && info.childId].filter(Boolean);
        for (const c of cands) whaleSubSessions.add(String(c));
      } catch (e) {}
    });
  } catch (e) {}
  // 记录每个会话的 delegationDepth（来自 session.header）
  const whaleDepth = new Map();
  function whaleDepthOf(sid) { return whaleDepth.get(String(sid)) || 0; }

  // 已结算过的 (sessionId, turn)，防止同一轮被 turn/end 多次触发时重复弹窗
  const whaleSettledTurns = new Set();
  let whaleSettleTimer = null; // 延迟结算定时器
  function whaleFinalizeTurn(sid) {
    const agg = whaleTurnAggs.get(sid);
    // 诊断：写盘确认 agg 状态（排查 amount=null）
    debugLog(DSH_HOME, 'finalize', { sid: String(sid).slice(-8), hasAgg: !!agg, cost: agg ? agg.cost : null, tokens: agg ? agg.tokens : null, turn: agg ? agg.turn : null });
    // 常驻轻量日志（不受 UQ_DEBUG 限制）：只记 turn 与 cost，用于排查「上轮数据不显示」
    try {
      const pFT = path.join(DSH_HOME, 'storages', 'unified-quota', 'lastturn-trace.jsonl');
      fsSync.mkdirSync(path.dirname(pFT), { recursive: true });
      fsSync.appendFileSync(pFT, JSON.stringify({ at: new Date().toISOString(), turn: agg ? agg.turn : null, hasAgg: !!agg, cost: agg ? agg.cost : null, tok: agg ? agg.tokens : null }) + '\n', 'utf8');
    } catch (e) { criticalCatch(DEBUG_DIR, "persist:2147", e); }
    if (!agg || !(agg.cost > 0 || agg.tokens > 0)) return; // 未定价模型也允许结算
    // ⚠️ 同一轮可能触发多次 turn/end：结算后立刻出队并标记，避免重复推进 seq
    const turnKey = String(sid) + "#" + String(agg.turn);
    if (whaleSettledTurns.has(turnKey)) { whaleTurnAggs.delete(sid); return; }
    whaleSettledTurns.add(turnKey);
    whaleTurnAggs.delete(sid);
    // 只保留最近 200 条，防止无限增长
    if (whaleSettledTurns.size > 200) {
      const first = whaleSettledTurns.values().next().value;
      whaleSettledTurns.delete(first);
    }
    // 立即同步状态（路由随时可能被轮询，不能等定时器）
    // 免费模型：cost 是 0.0000001（仅用于保证结算），展示时应为「免费」而非 ¥0.0000001。
    // amount 传 null 让挂件显示 --，并配合 free 标记说明是免费模型。
    const amountOut = agg.free === true ? null : (Math.round(agg.cost * 1e8) / 1e8);
    // 分项：让弹窗/小窗体显示 token 构成与缓存命中率
    const breakdownOut = {
      input: agg.sumInput || 0,
      cache: agg.sumCache || 0,
      output: agg.sumOutput || 0,
      reasoning: agg.sumReasoning || 0,
      cacheWrite: agg.sumCacheWrite || 0,
      steps: agg.steps || 0,
    };
    breakdownOut.hitRate = (function () {
      const denom = breakdownOut.input + breakdownOut.cache + breakdownOut.cacheWrite;
      return denom > 0 ? breakdownOut.cache / denom : null;
    })();
    whaleLastTurnState = { turn: agg.turn, amount: amountOut, tokens: agg.tokens, ts: agg.lastTs, free: agg.free === true, breakdown: breakdownOut, creditBasis: agg.creditBasis === true };
    try { ctx.__uqWhaleState = whaleLastTurnState; } catch (e) {}
    try {
      const pLT = path.join(DSH_HOME, 'storages', 'unified-quota', 'last-turn.json');
      fsSync.mkdirSync(path.dirname(pLT), { recursive: true });
      const tmpLT = pLT + '.tmp-' + process.pid;
      fsSync.writeFileSync(tmpLT, JSON.stringify(whaleLastTurnState), 'utf8');
      fsSync.renameSync(tmpLT, pLT);
    } catch (e) { safeCatch(DSH_HOME, 'lastturn-persist', e); }
    // 子代理（后台任务）完成时不推进 seq ⇒ 不触发挂件弹窗/提示音。
    // 判定依据：session.header.delegationDepth —— 主会话为 0，子代理 > 0。
    // （subagent/start|end 事件是作用域过滤的，本插件收不到，见 6.3.1 诊断）
    const isSub = whaleSubSessions.has(String(sid)) || whaleDepthOf(sid) > 0;
    if (!isSub) {
      // 延迟 2.5 秒结算：若期间又有 turn/start（说明只是工具调用中的一步），则取消。
      // DSH 的 kick() 会 while(turn()) 连续跑多轮，只有整批结束才算「一轮对话完成」。
      if (whaleSettleTimer !== null) clearTimeout(whaleSettleTimer);
      whaleSettleTimer = setTimeout(function () {
        whaleSettleTimer = null;
        const amountOut2 = agg.free === true ? null : (Math.round(agg.cost * 1e8) / 1e8);
        const breakdownOut2 = {
          input: agg.sumInput || 0, cache: agg.sumCache || 0, output: agg.sumOutput || 0,
          reasoning: agg.sumReasoning || 0, cacheWrite: agg.sumCacheWrite || 0, steps: agg.steps || 0,
        };
        breakdownOut2.hitRate = (function () {
          const denom = breakdownOut2.input + breakdownOut2.cache + breakdownOut2.cacheWrite;
          return denom > 0 ? breakdownOut2.cache / denom : null;
        })();
        whaleLastTurnState = { turn: agg.turn, amount: amountOut2, tokens: agg.tokens, ts: agg.lastTs, free: agg.free === true, breakdown: breakdownOut2, creditBasis: agg.creditBasis === true };
        try { ctx.__uqWhaleState = whaleLastTurnState; } catch (e) {}
        whaleTurnSeq += 1;
        try { const tmp = WHALE_TURN_FILE + '.tmp-' + process.pid; fsSync.writeFileSync(tmp, JSON.stringify({ seq: whaleTurnSeq, updatedAt: new Date().toISOString() }), 'utf8'); fsSync.renameSync(tmp, WHALE_TURN_FILE); } catch (e) { criticalCatch(DEBUG_DIR, "persist:2207", e); }
      }, 2500);
    }
  }
  try {
    ctx.on('session/event', function (session, event) {
      try {
        const sid = (session && session.id) ? String(session.id) : 'default';
        const type = event && event.type;
        const d = (event && event.data) || {};
        if (type === 'turn/start') {
          // 新的 turn 开始 ⇒ 取消待结算的定时器（说明本轮还在继续）
          if (whaleSettleTimer !== null) { clearTimeout(whaleSettleTimer); whaleSettleTimer = null; }
          return;
        }
        if (type === 'turn/end') {
          // 记录本会话的 delegationDepth（主 0 / 子 >0），用于跳过子代理的 seq 推进
          try {
            const dep = session && session.header && Number(session.header.delegationDepth);
            if (Number.isFinite(dep)) whaleDepth.set(String(sid), dep);
          } catch (e) {}
          // 诊断：记录每个 turn/end 的会话 id 与是否被判为子代理
          whaleFinalizeTurn(sid); return;
        }
        if (type !== 'assistant/message') return;
        const turn = Number(d.turn);
        const usage = d.usage;
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return;
        let agg = whaleTurnAggs.get(sid);
        if (!agg || agg.turn !== turn) { if (agg) whaleFinalizeTurn(sid); agg = { turn: turn, cost: 0, tokens: 0, lastTs: Date.now() }; whaleTurnAggs.set(sid, agg); }
        const input = Number(usage.inputTokens) || 0;
        const cache = Number(usage.cacheReadTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        agg.tokens += input + cache + output;
        // 分项累计（供 UI 展示每轮 / 每步的 token 构成与缓存命中率）
        agg.sumInput = (agg.sumInput || 0) + input;
        agg.sumCache = (agg.sumCache || 0) + cache;
        agg.sumOutput = (agg.sumOutput || 0) + output;
        agg.sumReasoning = (agg.sumReasoning || 0) + (Number(usage.reasoningTokens) || 0);
        agg.sumCacheWrite = (agg.sumCacheWrite || 0) + (Number(usage.cacheWriteTokens) || 0);
        agg.steps = (agg.steps || 0) + 1;
        // 逐步骤明细（最近 50 步），供「每轮细分」展示
        agg.stepList = agg.stepList || [];
        agg.stepList.push({ at: Date.now(), input: input, cache: cache, output: output, r: Number(usage.reasoningTokens) || 0 });
        if (agg.stepList.length > 50) agg.stepList.shift();
        // 探针：记录每条 assistant/message 的原始 usage（此处必定执行）
        debugLog(DSH_HOME, 'usage', { turn: turn, input: input, cache: cache, output: output, rawUsage: usage, dKeys: Object.keys(d || {}), srcObj: (d && d.source) || null });
        // 金额用**真实价目表**计算（与账本同源），不再用"每 1M 统一 0.5 元"的粗估。
        // 之前那样做会把缓存读取（便宜 4 倍）和输出（贵 4 倍）混在一起 ⇒ 气泡金额严重失真。
        try {
          // 依次尝试：事件字段 → 会话投影 → 最近使用记录
          // ⚠️ 原代码引用了一个从未声明的 `options` 变量 ⇒ 抛 ReferenceError
          // ⇒ 被外层 catch 吞掉 ⇒ 整个计价块（含兜底）从不执行 ⇒ cost 恒为 0 ⇒ 弹窗 ¥0.00。
          // 这就是 10+ 版都没修好的真正原因：不是公式错，是这块代码根本没跑过。
          const evSrc = (d && d.source) || null;
          let provider0 = (evSrc && evSrc.provider) || '';
          let model0 = (evSrc && evSrc.model) || '';
          if (!provider0 || !model0) {
            try {
              const last = usedOf(sid);
              if (last) { provider0 = provider0 || last.provider; model0 = model0 || last.model; }
            } catch (e) {}
          }
          // 最后兜底：从事件里的 message 对象嗅探（DSH 的 assistant message 可能带 model 字段）
          if (!model0) {
            try {
              const msg = d && d.message;
              if (msg && typeof msg === 'object') {
                model0 = String(msg.model || msg.modelId || (msg.response && msg.response.model) || '');
                provider0 = provider0 || String(msg.provider || msg.providerId || '');
              }
            } catch (e) {}
          }
          // 探针：确认是否进入主计价块
          debugLog(DSH_HOME, 'block', { turn: turn, enterMain: !!(provider0 && model0), provider0: provider0, model0: model0, costBefore: agg.cost });
          if (provider0 && model0) {
            const b0 = { input: input, output: output, cacheRead: cache, cacheWrite: Number(usage.cacheWriteTokens) || 0, reasoning: Number(usage.reasoningTokens) || 0 };
            // ⚠️ 计价优先级：积分口径 > 官方价目表。
            // 白嫖渠道（trae/buddy/qodercn）的真实成本是「积分 × 积分单价」，
            // 用 DeepSeek 官方 API 价（¥1-4/M）会让金额虚高 50 倍以上。
            let costed = false;
            try {
              const st1 = creditPriceCache;
              const perCredit1 = st1 && st1.table && st1.table[provider0] ? st1.table[provider0].perCredit : null;
              if (perCredit1 !== null && perCredit1 > 0) {
                // 该渠道「1 积分 = 多少 token」：优先用今日反推的 baseAt1x（同窗口）
                const rawB = JSON.parse(fsSync.readFileSync(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'), 'utf8'));
                const rcB = realConsumption(rawB, provider0, 1);
                const spentB = rcB && rcB.today ? rcB.today.spent : (rcB ? rcB.consumed : 0);
                let todayTokB = 0;
                try {
                  const ledB = JSON.parse(fsSync.readFileSync(OWN_LEDGER_PATH, 'utf8'));
                  const dayB = ledB && ledB.days ? ledB.days[latestLedgerDay(ledB)] : null;
                  for (const [kB, bB] of Object.entries((dayB && dayB.byProviderModel) || {})) {
                    if (kB.indexOf(provider0 + ":") !== 0) continue;
                    todayTokB += (Number(bB.input) || 0) + (Number(bB.output) || 0) + (Number(bB.cacheRead) || 0);
                  }
                } catch (e) {}
                if (spentB > 0 && todayTokB > 0) {
                  const tokPerCreditB = todayTokB / spentB;
                  const turnTokB = input + cache + output;
                  agg.cost += (turnTokB / tokPerCreditB) * perCredit1;
                  agg.creditBasis = true;
                  costed = true;
                }
              }
            } catch (e) {}
            if (!costed) {
            const p0 = priceRow(b0, provider0, model0, Date.now(), meterConfig ?? config);
            const got = Number(p0.apiCostCny) || 0;
            if (got > 0) agg.cost += got;
            else {
              // 未定价模型（qodercn/qfmodel、hy4flash-free 等）：
              // 用「模型名里的倍率 + DeepSeek 官方加权价」估算。
              // ⚠️ 不能用 names0（它属于 /current 路由作用域，此处不可见 ⇒ ReferenceError 被 catch 吞掉 ⇒ cost 恒 0）。
              let est = 0;
              try {
                const f0 = priceFactorFromName(model0);
                // 三态：0=免费（费用必须为 0）/ 正数=正常 / 其它=未知按 1
                const known0 = Number.isFinite(f0);
                const free0 = known0 && f0 === 0;
                const factor0 = known0 ? f0 : 1;
                const tok = input + cache + output;
                if (free0) {
                  agg.free = true;
                  if (!(agg.cost > 0)) agg.cost = 0.0000001;
                  agg.lastTs = Date.now();
                  return;   // 免费模型不参与后续计价
                }
                // ① 优先用「该渠道的抓取积分单价 × 本渠道 1 积分 token 数」折算
                //    —— 与积分账单同口径，避免弹窗与账单对不上。
                // ② 拿不到再用 DeepSeek 官方加权价 ¥3.2 / 1M token × 倍率。
                // 优先用 DeepSeek 官方分项定价（缓存命中/未命中/输出各不相同，比加权平均准得多）
                const offCost = officialCostOf(model0, { input: input, output: output, cacheRead: cache, cacheWrite: Number(usage.cacheWriteTokens) || 0, reasoning: Number(usage.reasoningTokens) || 0 }, Date.now());
                if (offCost !== null && offCost > 0) {
                  est = offCost * factor0;   // 官方价 × 渠道倍率
                } else {
                  est = (tok / 1e6) * 3.2 * factor0;  // 极端兜底
                }
                try {
                  const st0 = creditPriceCache;
                  const perCredit = st0 && st0.table && st0.table[provider0] ? st0.table[provider0].perCredit : null;
                  if (perCredit !== null && perCredit > 0) {
                    // ⚠️ 必须用「同窗口」的两个量：今日 token 总量 ÷ 今日实扣积分
                    // 用本轮 token 除今日积分是错的（窗口不同，会算出渠道累计花费）。
                    let spent0 = 0, todayTok = 0;
                    try {
                      const raw0 = JSON.parse(fsSync.readFileSync(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'), 'utf8'));
                      const rc0 = realConsumption(raw0, provider0, 1);
                      spent0 = rc0 && rc0.today ? rc0.today.spent : (rc0 ? rc0.consumed : 0);
                      // 今日该渠道 token 总量（从账本读）
                      const led0 = JSON.parse(fsSync.readFileSync(OWN_LEDGER_PATH, 'utf8'));
                      const lday = latestLedgerDay(led0);
                      const dayRow = led0 && led0.days ? led0.days[lday] : null;
                      for (const [key0, b0] of Object.entries((dayRow && dayRow.byProviderModel) || {})) {
                        if (key0.indexOf(provider0 + ":") !== 0) continue;
                        todayTok += (Number(b0.input) || 0) + (Number(b0.output) || 0) + (Number(b0.cacheRead) || 0);
                      }
                    } catch (e) {}
                    if (spent0 > 0 && todayTok > 0) {
                      const tokPerCredit = todayTok / spent0;   // 今日每积分 token 数
                      const creditOfTurn = tok / tokPerCredit;  // 本轮消耗的积分
                      est = creditOfTurn * perCredit;           // 本轮花费（元）
                    }
                  }
                } catch (e) {}
              } catch (e) { est = 0; }
              // ⚠️ 不能用 0.0001 这种占位值污染 agg.cost：
              // 它会 > 0，导致下面的无条件兜底被跳过（!(agg.cost > 0) 为 false），
              // 最终 cost 停在 0.0001 ⇒ 弹窗显示 ¥0.00。
              // 正确做法：只有真算出金额才累加；算不出就让兜底接手。
              if (est > 0) {
                agg.cost += est;
                agg.unpriced = true;
              }
            }
            }  // end if (!costed)
          }
          // ⚠️ 无条件兜底：上面整块依赖 provider0/model0 非空，
          // 一旦事件里没有 provider/model（实测 trae 渠道会出现），agg.cost 就恒为 0 ⇒ 弹窗显示 ¥0.00。
          // 这里保证「只要有 token 消耗，就一定有一个非零金额」。
          // 探针：兜底前后的真实状态
          debugLog(DSH_HOME, 'fallback', { turn: turn, costBefore: agg.cost, willFallback: !(agg.cost > 0) && (input + cache + output) > 0, tokSum: input + cache + output });
          if (!(agg.cost > 0) && (input + cache + output) > 0) {
            try {
              const f1 = priceFactorFromName(String(model0 || ''));
              // ⚠️ 三态区分（不能把 0 当未知）：
              //   f1 === 0        → 限时免费模型，费用必须为 0（不能强行改成 ×1 收费）
              //   f1 > 0 有限值   → 正常倍率
              //   其它（∞/NaN）   → 倍率未知，按 ×1 保守估计
              const factorKnown = Number.isFinite(f1);
              const isFreeModel = factorKnown && f1 === 0;
              const factor1 = factorKnown ? f1 : 1;
              if (isFreeModel) {
                // 免费模型：标记为 0 费用，但仍要推进轮次（否则弹窗不弹）
                agg.free = true;
                agg.unpriced = true;
                // 用一个极小值保证 agg.cost > 0（让 finalizeTurn 结算），但展示时按 0 处理
                if (!(agg.cost > 0)) agg.cost = 0.0000001;
              } else {
                // 用「缓存加权」计价：命中率未知时用渠道配置的假定值
                // 命中率来源优先级：
                //   ① 用户为该渠道手填的 assumedCacheHit
                //   ② 用「同模型」在其它渠道的真实命中率反推（实测跨渠道差异 <5%）
                //   ③ 0（保守，按全部未命中）
                let assumedHit = 0;
                try {
                  const ah = (config && config.assumedCacheHit) || {};
                  // 按模型优先（同一模型跨渠道命中率接近），再退回按渠道（兼容旧配置）
                  const vm = Number(ah[model0]);
                  const vp = Number(ah[provider0]);
                  if (Number.isFinite(vm) && vm > 0 && vm < 1) assumedHit = vm;
                  else if (Number.isFinite(vp) && vp > 0 && vp < 1) assumedHit = vp;
                } catch (e) {}
                if (assumedHit === 0) {
                  try {
                    if (cache === 0) {
                      const led1 = JSON.parse(fsSync.readFileSync(OWN_LEDGER_PATH, 'utf8'));
                      const inferred = cacheHitRateByModel(led1, model0);
                      if (inferred !== null && inferred.rate > 0) assumedHit = inferred.rate;
                    }
                  } catch (e) { criticalCatch(DEBUG_DIR, "ledger:2428", e); }
                }
                const offW = officialCostWeighted(String(model0 || ''), { input: input, output: output, cacheRead: cache, cacheWrite: Number(usage.cacheWriteTokens) || 0, reasoning: Number(usage.reasoningTokens) || 0 }, Date.now(), assumedHit);
                const off1 = offW !== null && offW.total !== null ? offW.total : officialCostOf(String(model0 || ''), { input: input, output: output, cacheRead: cache, cacheWrite: Number(usage.cacheWriteTokens) || 0, reasoning: Number(usage.reasoningTokens) || 0 }, Date.now());
                const tok1 = input + cache + output;
                // ⚠️ 两个口径分开（2026-11-18 用户确认）：
                //   apiCost = 官方价原值（**不乘倍率**）—— 官方定价已按模型分档
                //   cost    = 官方价 × 倍率 —— 「积分口径」，渠道内相对价格
                const officialCny = (off1 !== null && off1 > 0) ? off1 : (tok1 / 1e6) * 3.2;
                agg.apiCost = (Number(agg.apiCost) || 0) + officialCny;
                agg.cost += officialCny * factor1;
                agg.unpriced = true;
              }
              // 诊断：记录兜底后的真实值
              debugLog(DSH_HOME, 'cost', { turn: agg.turn, provider0: provider0, model0: model0, f1: String(f1), factor1: factor1, input: input, cache: cache, output: output, cost: agg.cost });
            } catch (e) {}
          }
        } catch (e) { safeCatch(DSH_HOME, 'meter-pricing', e); }
        agg.lastTs = Date.now();
      } catch (e) { safeCatch(DSH_HOME, 'session-event', e); }
    });
    ctx.logger?.info?.('[unified-quota] whale: 已监听 session/event');
  } catch (e) { safeCatch(DSH_HOME, 'session-listen', e); }

  // —— 额度触顶检测（权威通道）——
  // 实测：限流错误不会经过 llm/stream 的 catch（onerror-debug.jsonl 从未生成），
  // 但 DSH 的 agent-loop 会 emit('agent/error', { turn, step, error })。
  // 这是唯一可靠的捕获点。
  try {
    ctx.on('agent/error', function (payload) {
      try {
        const err = payload && payload.error;
        // 记录上限：从错误对象与当前会话模型推断 provider/model
        const hint2 = {};
        try { if (payload && payload.agent && payload.agent.model) { hint2.model = payload.agent.model; } } catch (e) {}
        void recordCapFromError(err, hint2);
      } catch (e) { criticalCatch(DEBUG_DIR, "cap:2459", e); }
    });
  } catch (e) { /* 老版本无此事件 */ }
  let building = null;
  let detailBuilding = null;
  let detailBuildingKey = null;
  const respond = async (req, res, build) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
    if (rejected(ctx, req)) return denyOrigin(res, req);
    try {
      const body = await build();
      jsonResponse(res, 200, body);
    } catch (error) {
      ctx.logger?.warn?.('[unified-quota] route failed: %s', String(error && error.message || error));
      jsonResponse(res, 500, { error: 'aggregate failed' });
    }
  };
  const disposeCore = ctx.webServer.register({
    kind: 'exact',
    path: API.core,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const refresh = url.searchParams.get('refresh') === '1';
      return respond(req, res, async () => {
        if (building === null) building = buildCore(ctx, refresh).finally(() => { building = null; });
        return building;
      });
    }
  });
  const disposeConfig = ctx.webServer.register({
    kind: 'exact',
    path: API.config,
    handler: async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      const store = configStoreOf();
      await store.load();
      if (req.method === 'GET' || req.method === 'HEAD') {
        void ensureRates(ctx).catch(() => {});
        // 渠道清单：roster ∪ 账本里出现过的 provider。
        // 这样"以后新增渠道/模型"时，设置页会自动多出来，不需要改代码。
        let providers = [];
        try {
          const roster = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
          const ids = new Set(roster.map((r) => str(r && r.provider)));
          const ledgerRaw = await readJsonCached(OWN_LEDGER_PATH);
          const days = (ledgerRaw && ledgerRaw.days) || {};
          for (const day of Object.keys(days)) {
            const bpm = (days[day] && days[day].byProviderModel) || {};
            for (const key of Object.keys(bpm)) {
              const sep = key.indexOf(":");
              const p = sep > 0 ? key.slice(0, sep) : key;
              if (p.length > 0) ids.add(p);
            }
          }
          providers = [...ids].filter((x) => x.length > 0).sort();
        } catch (e) { /* 拿不到就空表 */ }
        const rs = ratesOf().state;
        // 附上抓取到的积分单价（供设置页展示「自动抓取值」）
        // 账本里出现过的模型（供「假定缓存命中率」按模型配置）
        let modelList = [];
        try {
          const ledM = await readJsonCached(OWN_LEDGER_PATH);
          const set = new Set();
          for (const d of Object.values((ledM && ledM.days) || {})) {
            for (const k of Object.keys(d.byProviderModel || {})) {
              const i2 = k.indexOf(':');
              if (i2 > 0) set.add(k.slice(i2 + 1));
            }
          }
          modelList = [...set].sort();
        } catch (e) {}
        // 每个模型的「反推命中率」（设置页展示用，用户大多数情况不需要手填）
        let modelCacheRates = {};
        try {
          const ledR = await readJsonCached(OWN_LEDGER_PATH);
          const modelsR = new Set();
          for (const d of Object.values((ledR && ledR.days) || {})) {
            for (const k of Object.keys(d.byProviderModel || {})) {
              const i3 = k.indexOf(':');
              if (i3 > 0) modelsR.add(k.slice(i3 + 1));
            }
          }
          for (const mdl of modelsR) {
            const inf = cacheHitRateByModel(ledR, mdl);
            if (inf !== null) modelCacheRates[mdl] = { rate: Math.round(inf.rate * 1e6) / 1e6, tokens: inf.tokens };
          }
        } catch (e) {}
        let fetchedPrices = {};
        let fetchedAt = null;
        try {
          const ps = await refreshCreditPrices(ctx);
          if (ps) { fetchedPrices = ps.table || {}; fetchedAt = ps.at || null; }
        } catch (e) {}
        return jsonResponse(res, 200, {
          config: store.get(),
          providers: providers,
          money: {
        currency: (store.get() && store.get().currency) || 'CNY',
        rate: (function () {
          var cur = (store.get() && store.get().currency) || 'CNY';
          if (cur === 'USD') return 1;
          var r = ratesOf().get(cur);
          if (r !== null && r > 0) return r;
          return Number((store.get() || {}).exchangeRate) > 0 ? Number(store.get().exchangeRate) : 7.1;
        })(),
        fx: rateFor(store.get()),
        base: 'USD',
        date: rs && rs.date ? rs.date : '',
        stale: rs ? rs.stale === true : true,
        error: rs && rs.error ? rs.error : null,
      },
          fetchedPrices: fetchedPrices,
          fetchedAt: fetchedAt,
          modelList: modelList,
          modelCacheRates: modelCacheRates,
        });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        // 读请求体（上限 256KB，配置不该这么大）
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 262144) return jsonResponse(res, 413, { error: 'body too large' });
            chunks.push(chunk);
          }
        } catch { return jsonResponse(res, 400, { error: 'body read failed' }); }
        let patch = null;
        try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { return jsonResponse(res, 400, { error: 'invalid json' }); }
        const next = await store.patch(patch);
      // 币种/汇率变更：清掉小鲸鱼缓存，让 balance.json 立即按新币种换算
      if (patch && (patch.currency !== undefined || patch.manualRate !== undefined || patch.exchangeRate !== undefined)) {
        try { whaleCache.value = null; whaleCache.at = 0; } catch (e) {}
      }
        if (patch && patch.refreshRates === true) { void ensureRates(ctx, true).catch(() => {}); }
        // 计价相关变更要重建账单配置
        if (meterConfig !== null) Object.assign(meterConfig, billingConfigOf(next));
        // 返回 money：让前端切换币种后**立即**拿到新汇率
      const rsAfter = ratesOf().state;
      const curAfter = next.currency || 'CNY';
      const rateShow = (function () {
        if (curAfter === 'USD') return 1;
        const rr = ratesOf().get(curAfter);
        if (rr !== null && rr > 0) return rr;
        return Number(next.exchangeRate) > 0 ? Number(next.exchangeRate) : 7.1;
      })();
      return jsonResponse(res, 200, {
        config: next,
        money: {
          currency: curAfter,
          rate: rateShow,
          fx: rateFor(next),
          base: 'USD',
          date: rsAfter && rsAfter.date ? rsAfter.date : '',
          stale: rsAfter ? rsAfter.stale === true : true,
          error: rsAfter && rsAfter.error ? rsAfter.error : null,
        },
      });
      }
      return jsonResponse(res, 405, { error: 'method not allowed' });
    }
  });
  // —— 历史金额重算（渠道改用积分口径后，修正旧账）——
  const disposeRecalc = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/recalc',
    handler: async (req, res) => {
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const provider = str(body.provider);
        if (provider.length === 0) return jsonResponse(res, 400, { error: 'provider required' });
        const priceSt = await refreshCreditPrices(ctx).catch(function () { return null; });
        const perCredit = priceSt && priceSt.table && priceSt.table[provider] ? priceSt.table[provider].perCredit : null;
        if (perCredit === null) return jsonResponse(res, 400, { error: 'no credit price for ' + provider });
        const balLog = await loadBalanceLog();
        const rc = realConsumption(balLog, provider, 1);
        const spentToday = rc && rc.today ? rc.today.spent : (rc ? rc.consumed : 0);
        if (!(spentToday > 0)) return jsonResponse(res, 400, { error: 'no credit consumption data for ' + provider });
        // 今日该渠道 token（同窗口基准）
        const ledRaw = await readJsonCached(OWN_LEDGER_PATH);
        const lday = latestLedgerDay(ledRaw);
        let todayTok = 0;
        const dayRow = ledRaw && ledRaw.days ? ledRaw.days[lday] : null;
        for (const [k, b] of Object.entries((dayRow && dayRow.byProviderModel) || {})) {
          if (k.indexOf(provider + ':') !== 0) continue;
          todayTok += (Number(b.input) || 0) + (Number(b.output) || 0) + (Number(b.cacheRead) || 0);
        }
        if (!(todayTok > 0)) return jsonResponse(res, 400, { error: 'no token data for ' + provider });
        const tokPerCredit = todayTok / spentToday;
        // 改写账本
        const ledger = JSON.parse(await fs.readFile(OWN_LEDGER_PATH, 'utf8'));
        let changed = 0, oldSum = 0, newSum = 0;
        for (const [day, d] of Object.entries(ledger.days || {})) {
          let provTokDay = 0, otherCost = 0, provApiDay = 0, otherApi = 0;
          for (const [k, v] of Object.entries(d.byProviderModel || {})) {
            const tok = (Number(v.input) || 0) + (Number(v.output) || 0) + (Number(v.cacheRead) || 0);
            if (k.indexOf(provider + ':') === 0) {
              if (tok > 0) {
                oldSum += Number(v.costCny) || 0;
                // 两个口径分开：
                //   cost    = 积分口径（token / tokPerCredit × perCredit），套餐渠道实际花费
                //   apiCost = 官方价口径（缓存命中/未命中分别计价），"如果按量付费要多少"
                const creditCost = Math.round((tok / tokPerCredit) * perCredit * 1e6) / 1e6;
                let apiCost = creditCost;
                try {
                  const midRec = k.slice(provider.length + 1);
                  const hiRate = (function () {
                    const g = configStoreOf().get() || {};
                    const ah = g.assumedCacheHit || {};
                    const vm2 = Number(ah[midRec]);
                    if (Number.isFinite(vm2) && vm2 > 0 && vm2 < 1) return vm2;
                    const inf = cacheHitRateByModel(ledger, midRec);
                    return (inf !== null && inf.rate > 0) ? inf.rate : 0;
                  })();
                  const offW2 = officialCostWeighted(midRec, {
                    input: Number(v.input) || 0,
                    output: Number(v.output) || 0,
                    cacheRead: Number(v.cacheRead) || 0,
                    cacheWrite: Number(v.cacheWrite) || 0,
                    reasoning: Number(v.reasoning) || 0,
                  }, Date.now(), hiRate);
                  if (offW2 !== null && offW2.total !== null && offW2.total > 0) {
                    apiCost = Math.round(offW2.total * 1e6) / 1e6;
                  }
                } catch (e) { criticalCatch(DEBUG_DIR, 'recalc-apiCost', e); }
                v.costCny = creditCost; v.cost = creditCost;
                v.apiCostCny = apiCost; v.apiCost = apiCost;
                v.recalc = { at: new Date().toISOString(), provider: provider, weighted: apiCost !== creditCost };
                newSum += apiCost; provTokDay += tok; provApiDay += apiCost; changed += 1;
              }
            } else {
              otherCost += Number(v.costCny) || 0;
              otherApi += Number(v.apiCostCny || v.costCny) || 0;
            }
          }
          // 分开汇总：cost = 积分口径，apiCost = 官方加权口径
          const newDayCost = Math.round((otherCost + (provTokDay > 0 ? (provTokDay / tokPerCredit) * perCredit : 0)) * 1e6) / 1e6;
          const newDayApi = Math.round((otherApi + provApiDay) * 1e6) / 1e6;
          d.costCny = newDayCost; d.cost = newDayCost;
          d.apiCostCny = newDayApi; d.apiCost = newDayApi;
        }
        // ⚠️ 必须同时更新内存实例！
        // QuotaLedger 有 2 秒防抖 flush，会用内存 data 覆盖文件。
        // 只改文件的话，下一次记账就把重算结果覆盖回去了（实测：重算到 ¥17，20 秒后变回 ¥1116）。
        try {
          const inst = ledgerOf();
          if (inst && inst.data && inst.data.days) {
            inst.data.days = ledger.days;
            if (inst.data.meta) inst.data.meta.updatedAt = Date.now();
            inst.dirty = true;
            await inst.flush();
          }
        } catch (e) { criticalCatch(DEBUG_DIR, "persist:2689", e); }
        {
          const tmpR = OWN_LEDGER_PATH + '.recalc-' + process.pid;
          await fs.writeFile(tmpR, JSON.stringify(ledger, null, 2), 'utf8');
          await fs.rename(tmpR, OWN_LEDGER_PATH);
        }
        return jsonResponse(res, 200, { ok: true, provider: provider, changed: changed, oldSum: Math.round(oldSum * 1e4) / 1e4, newSum: Math.round(newSum * 1e4) / 1e4, tokPerCredit: Math.round(tokPerCredit), perCredit: perCredit });
      } catch (e) {
        return jsonResponse(res, 500, { error: String(e && e.message || e).slice(0, 200) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeRecalc && disposeRecalc(); } catch (e) {} }, "unified-quota: recalc");

  const disposeExport = ctx.webServer.register({
    kind: 'exact',
    path: API.exportCsv,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const windowDays = url.searchParams.get('window') || '30';
        const kind = url.searchParams.get('kind') === 'calls' ? 'calls' : 'summary';
        const ledger = await readJsonCached(OWN_LEDGER_PATH);
        if (kind === 'calls') {
          const { calls } = await readCallRows(5000);
          const csv = toCsv(
            ['时间', '会话', '渠道', '模型', '轮次', '步骤', '输入', '缓存读取', '缓存写入', '输出', '推理', '合计'],
            calls.map((c) => [new Date(c.at).toISOString(), c.sessionId, c.provider, c.model, c.turn, c.step, c.input, c.cacheRead, c.cacheWrite, c.output, c.reasoning, c.tokens]),
          );
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="unified-quota-calls.csv"', 'cache-control': 'no-store' });
          return res.end('\ufeff' + csv);
        }
        const cfgX = configStoreOf().get();
        const detail = buildDetail(ledger, { windowDays, provider: url.searchParams.get('provider') || '', model: url.searchParams.get('model') || '', currency: cfgX.currency, rate: rateFor(cfgX) });
        if (detail === null) return jsonResponse(res, 404, { error: 'no ledger' });
        const csv = toCsv(
          ['日期', '渠道', '模型', '输入', '缓存读取', '缓存写入', '输出', '推理', '合计token', '实付', '等值', '调用次数'],
          detail.buckets.map((r) => [detail.since + '~', r.provider, r.model, r.input, r.cacheRead, r.cacheWrite, r.output, r.reasoning, r.tokens, r.apiCost, r.cost, r.calls]),
        );
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="unified-quota-summary.csv"', 'cache-control': 'no-store' });
        return res.end('\ufeff' + csv);
      } catch (error) {
        ctx.logger?.warn?.('[unified-quota] export failed: %s', String(error && error.message || error));
        return jsonResponse(res, 500, { error: 'export failed' });
      }
    }
  });
  const disposeCredits = ctx.webServer.register({
    kind: 'exact',
    path: API.credits,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const sinceDays = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 30));
      // 积分单价（抓取 + 手填）—— 本路由也要用（7.0.0 漏了这行导致 500）
      const cstore = configStoreOf();
      await cstore.load();
      const ccfg = cstore.get();
      const cpriceState = await refreshCreditPrices(ctx).catch(function () { return null; });
      const cpriceTable = (cpriceState && cpriceState.table) || {};
        const roster = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
        const names = await loadModelNames(ctx, roster.map((r) => r.provider), false);
        const factorOf = (provider, model) => {
          const display = names.get(provider + ':' + model) || '';
          const f = priceFactorFromName(display || model);
          return usableFactor(f) ? f : null;
        };
        const ledgerRaw = await readJsonCached(OWN_LEDGER_PATH);
        const agg = perModelOfOwnLedger(ledgerRaw, sinceDays);
        const channels = [];
        const allModels = [];
        for (const [provider, inner] of agg.byProvider) {
          const models = [];
          for (const row of inner.values()) {
            const factor = factorOf(provider, row.model);
            const factored = factor === null ? null : row.tokens * factor;
            models.push({
              model: row.model, tokens: row.tokens, requests: row.requests,
              factor: factor, factored: factored,
              perCredit: factored && factored > 0 ? row.tokens / factored : null,
              days: [...row.days.entries()].sort((x, y) => (x[0] < y[0] ? 1 : -1)).slice(0, 14).map((e) => ({ day: e[0], tokens: e[1] })),
            });
          }
          models.sort((x, y) => y.tokens - x.tokens);
          const tokens = models.reduce((s, m) => s + m.tokens, 0);
          const factored = models.reduce((s, m) => s + (m.factored || 0), 0);
          const known = models.filter((m) => m.factor !== null);
          const factors = new Set(known.map((m) => m.factor));
          channels.push({
            provider: provider, tokens: tokens, factored: factored,
            requests: models.reduce((s, m) => s + m.requests, 0),
            models: models,
            factor: factors.size === 1 ? known[0].factor : (factors.size === 0 ? null : (tokens > 0 ? factored / tokens : null)),
            mixedFactor: factors.size > 1,
            perCredit: factored > 0 ? tokens / factored : null,
            unknownModels: models.filter((m) => m.factor === null).length,
          });
        }
        // 余额差校准：有 ≥2 天余额样本时，用真实扣减反推「每 token 实际多少积分」
        const capsLog = await loadBalanceLog();
        for (const c of channels) {
          const rc = realConsumption(capsLog, c.provider, sinceDays);
          c.realConsumed = rc;
          // 以「日内实扣」为主口径：用户关心的是"今天花了多少积分"
          // 消耗与赠额分别累计：签到/充值只影响 granted，不会把消耗抵消成负数
          const spent = rc === null ? null : (rc.today !== null ? rc.today.spent : rc.consumed);
          const granted = rc === null ? 0 : (rc.today !== null ? rc.today.granted : rc.granted);
          c.spent = spent;
          c.granted = granted;
          c.refilled = granted > 0;
          c.refillAmount = granted;
          c.spentSpan = rc === null ? null : (rc.today !== null ? "today" : "window");
          // ⚠️ 关键：token 必须与余额差取**同一时间窗**。
          // 之前用「整个窗口的 token」除「采样开始后的余额差」，两者窗口不同 ⇒ 比值必然错得离谱。
          const spanDay = rc === null ? null : (rc.today !== null ? rc.today.from : (rc.from || null));
          c.spanFrom = spanDay;
          c.spanFromAt = rc === null ? 0 : (rc.today !== null ? (rc.today.fromAt || 0) : (rc.fromAt || 0));
          let tokInSpan = 0;
          let weightedInSpan = 0;   // Σ(tokens × 倍率)，用于反推「1× 时 1 积分 = 多少 token」
          if (spanDay !== null) {
            for (const m of c.models) {
              let mt = 0;
              for (const d of (m.days || [])) {
                if (d.day >= spanDay) mt += Number(d.tokens) || 0;
              }
              tokInSpan += mt;
              m.tokensInSpan = mt;
              m.isFree = (m.factor === 0);
              if (m.factor !== null && m.factor !== undefined && m.factor > 0) weightedInSpan += mt * m.factor;
            }
          }
          c.tokensInSpan = spanDay === null ? null : tokInSpan;
          c.weightedInSpan = spanDay === null ? null : weightedInSpan;
          c.freeTokensInSpan = (function () { let t = 0; for (const m of c.models) if (m.isFree) t += (m.tokensInSpan || 0); return t; })();
          c.billableTokensInSpan = (function () { let t = 0; for (const m of c.models) if (!m.isFree) t += (m.tokensInSpan || 0); return t; })();
          // 基准：假设 credits = tokens × 倍率 × k，则 1/k = Σ(tokens×倍率)/实扣
          // 这就是「1 倍率时 1 积分能换多少 token」，模型级 = 基准 ÷ 该模型倍率
          c.baseAt1x = spent !== null && spent > 0 && weightedInSpan > 0 ? weightedInSpan / spent : null;
          for (const m of c.models) {
            m.baseAt1x = c.baseAt1x;
            m.estTokensPerCredit = (c.baseAt1x !== null && m.factor !== null && m.factor !== undefined && m.factor > 0)
              ? c.baseAt1x / m.factor : null;
            m.estCredits = (m.estTokensPerCredit !== null && m.tokensInSpan > 0) ? m.tokensInSpan / m.estTokensPerCredit : null;
          }
          c.calibrated = spent !== null && spent > 0 && weightedInSpan > 0;
          // 每 1 积分换到多少「基准 token」：用排除免费后的加权口径（baseAt1x），
          // 而不是 tokInSpan（含限时免费模型的 token，会严重高估）
          c.tokensPerCredit = c.calibrated ? c.baseAt1x : null;
          // 倍率仅作参考：它是渠道的"相对计价系数"，并不等于 credit/token
                    // 积分单价：抓取（每日）> 用户手填 > 官方回退
          const officialFallback2 = (c.baseAt1x !== null ? officialFallbackPrice(c.baseAt1x) : null) || DEFAULT_CREDIT_PRICE;
          const priceInfo = resolvePrice(c.provider, cpriceTable, (ccfg.creditPrices || {}), officialFallback2);
          // 缓存命中率：真实值（上游返回 cacheRead）或反推值
          try {
            // ⚠️ 这里不能用 todayAgg（它属于 /quota 路由作用域），
            // credits 路由用的是 agg.byProvider。之前写错变量 ⇒ ReferenceError 被 catch 吞掉 ⇒ cacheHit 恒为 null。
            const dayAgg2 = agg.byProvider.get(c.provider) || new Map();
            let pIn = 0, pCache = 0;
            for (const m of dayAgg2.values()) { pIn += Number(m.input) || 0; pCache += Number(m.cacheRead) || 0; }
            const pTot = pIn + pCache;
            const realRate = pTot > 0 ? pCache / pTot : null;
            const inferred = cacheHitRateByModel(ledgerRaw, (function () {
              // 用该渠道用过的任一模型名（取第一个）
              for (const k of Object.keys((ledgerRaw.days && ledgerRaw.days[latestLedgerDay(ledgerRaw)] || {}).byProviderModel || {})) {
                if (k.indexOf(c.provider + ':') === 0) return k.slice(c.provider.length + 1);
              }
              return '';
            })());
            c.cacheHit = {
              real: realRate,
              inferred: inferred !== null ? inferred.rate : null,
              source: realRate !== null && realRate > 0 ? 'real' : (inferred !== null ? 'inferred' : 'none'),
              tokens: pTot,
            };
            // 模型级命中率（用户要求：细分到渠道下的模型，而不是只看渠道整体）
            c.modelCacheHit = {};
            try {
              for (const [mdl, mrow] of dayAgg2.entries()) {
                const mIn = Number(mrow.input) || 0;
                const mCache = Number(mrow.cacheRead) || 0;
                const mTot = mIn + mCache;
                const mReal = mTot > 0 ? mCache / mTot : null;
                // 该模型在其它渠道的真实命中率（跨渠道同模型）
                const mInf = cacheHitRateByModel(ledgerRaw, mdl);
                c.modelCacheHit[mdl] = {
                  real: mReal,
                  inferred: mInf !== null ? mInf.rate : null,
                  source: mReal !== null && mReal > 0 ? 'real' : (mInf !== null ? 'inferred' : 'none'),
                  tokens: mTot,
                };
              }
            } catch (e) {}
          } catch (e) { c.cacheHit = null; }
          c.creditPrice = priceInfo === null ? null : priceInfo.perCredit;
          c.creditPriceSource = priceInfo === null ? "none" : priceInfo.source;
          c.creditPlan = priceInfo && priceInfo.plan ? priceInfo.plan : null;
          c.realSpent = (c.creditPrice !== null && c.spent > 0) ? Math.round(c.spent * c.creditPrice * 1e6) / 1e6 : null;
          c.factorRef = c.factor;
        }
        channels.sort((x, y) => y.tokens - x.tokens);
        for (const c of channels) for (const m of c.models) allModels.push(Object.assign({ provider: c.provider }, m));
        allModels.sort((x, y) => y.tokens - x.tokens);
        const totalTokens = channels.reduce((s, c) => s + c.tokens, 0);
        const totalFactored = channels.reduce((s, c) => s + c.factored, 0);
        jsonResponse(res, 200, {
          at: Date.now(),
          build: BUILD,
          sinceDays: sinceDays,
          missing: totalTokens === 0,
          totals: {
            tokens: totalTokens,
            factored: totalFactored,
            perCredit: totalFactored > 0 ? totalTokens / totalFactored : null,
            known: allModels.filter((m) => m.factor !== null).length,
            unknown: allModels.filter((m) => m.factor === null).length,
            spent: channels.reduce((s, c) => s + (c.spent || 0), 0),
            realConsumed: channels.reduce((s, c) => s + (c.realConsumed && c.realConsumed.consumed ? c.realConsumed.consumed : 0), 0),
            calibratedChannels: channels.filter((c) => c.calibrated).length,
            // 汇总换算：用「基准 1×」的 token 语义，且排除限时免费模型
            tokensPerCredit: (function () {
              const parts = channels.filter((c) => c.calibrated && c.baseAt1x);
              if (parts.length === 0) return null;
              return parts[0].baseAt1x;
            })(),
            tokensInSpan: channels.reduce((s, c) => s + (c.tokensInSpan || 0), 0),
          },
          byChannel: channels,
          byModel: allModels,
          source: 'own-ledger',
        });
      } catch (error) {
        ctx.logger?.warn?.('[unified-quota] credits failed: %s', String(error && error.message || error));
        jsonResponse(res, 500, { error: 'credits failed' });
      }
    }
  });
  const disposeQuota = ctx.webServer.register({
    kind: 'exact',
    path: API.quota,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const store = configStoreOf();
        await store.load();
        const cfg = store.get();
      const priceState = await refreshCreditPrices(ctx).catch(function () { return null; });
      const priceTable = (priceState && priceState.table) || {};
        const roster = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
        const cache = await loadCredits(ctx, roster);
        if (Array.isArray(cache.providers)) await recordBalances(cache.providers);
        const ledgerRaw = await readJsonCached(OWN_LEDGER_PATH);
        // 今日 + 近 7 天（给每个模型画迷你趋势）
        // 「今日」用账本里最新的一天：账本按本地日写入，若与 UTC+8 日界错开，
        // 严格取今天会得到空数据（曾表现为「每个渠道都显示今日无用量」）。
        const latestDay = latestLedgerDay(ledgerRaw);
        const todayAgg = perModelOfSingleDay(ledgerRaw, latestDay);
        const weekAgg = perModelOfOwnLedger(ledgerRaw, 7);
        const soft = (cfg.softLimits && typeof cfg.softLimits === "object") ? cfg.softLimits : {};
    const learnedCaps = await loadLearnedCaps().catch(function () { return { entries: {} }; });
        const learned = (learnedCaps && learnedCaps.entries) || {};
        const limitOf = (provider, model) => {
      const chSoft = soft[provider] || {};
      const mSoft = (chSoft.models && chSoft.models[model]) || {};
      // 优先级：模型手填 > 渠道手填 > 学习到的容量
      let t = Number(mSoft.tokens) > 0 ? Number(mSoft.tokens) : (Number(chSoft.tokens) > 0 ? Number(chSoft.tokens) : null);
      let lsrc = (Number(mSoft.tokens) > 0 || Number(mSoft.requests) > 0) ? "model" : ((t !== null) ? "channel" : "none");
      if (t === null) {
        const lc = learned[provider + "|" + model];
        if (lc && Number(lc.tokens) > 0) { t = Number(lc.tokens); lsrc = "learned"; }
      }
      const r = Number(mSoft.requests) > 0 ? Number(mSoft.requests) : (Number(chSoft.requests) > 0 ? Number(chSoft.requests) : null);
      return { tokens: t, requests: r, source: lsrc };
    };
        const rows = (cache.providers || []).map((p) => {
          const credits = p.credits || {};
          const balance = Number.isFinite(credits.total) ? credits.total : null;
          const todayModels = todayAgg.byProvider.get(p.provider) || new Map();
          const weekModels = weekAgg.byProvider.get(p.provider) || new Map();
          const chSoft = soft[p.provider] || {};
          const configured = (chSoft.models && typeof chSoft.models === "object") ? Object.keys(chSoft.models) : [];
          const modelIds = [...new Set([...todayModels.keys(), ...weekModels.keys(), ...configured])];
          const models = modelIds.map((model) => {
            const t = todayModels.get(model);
            const w = weekModels.get(model);
            const used = { tokens: t ? t.tokens : 0, requests: t ? t.requests : 0 };
            const lim = limitOf(p.provider, model);
            const pct = lim.tokens !== null ? Math.min(1, used.tokens / lim.tokens)
              : (lim.requests !== null ? Math.min(1, used.requests / lim.requests) : null);
            // 近 7 天迷你趋势（补齐缺失日，老的在前）
            const series = [];
            for (let k = 6; k >= 0; k -= 1) {
              const day = utc8DayKey(Date.now() - k * 86400_000);
              series.push({ day: day, tokens: w && w.days.has(day) ? w.days.get(day) : 0 });
            }
            let creditPrice = null, creditPriceSource = "none", creditPlan = null; try { const pi = resolvePrice(p.provider, priceTable, cfg.creditPrices || {}, DEFAULT_CREDIT_PRICE); if (pi !== null) { creditPrice = pi.perCredit; creditPriceSource = pi.source; creditPlan = pi.plan || null; } } catch (e) {} return {
              model: model,
              creditPrice: creditPrice,
              creditPriceSource: creditPriceSource,
              creditPlan: creditPlan,
              today: used,
              weekTokens: w ? w.tokens : 0,
              weekRequests: w ? w.requests : 0,
              series: series,
              limit: { tokens: lim.tokens, requests: lim.requests },
              limitSource: lim.source,
              usedPct: pct,
              status: pct === null ? "none" : (pct >= 0.95 ? "danger" : (pct >= 0.8 ? "warn" : "ok")),
            };
          }).sort((x, y) => y.today.tokens - x.today.tokens);
          const todayTotal = (todayAgg.byProvider.get(p.provider) !== undefined)
            ? [...todayAgg.byProvider.get(p.provider).values()].reduce((s, r) => s + r.tokens, 0) : 0;
          const todayReq = (todayAgg.byProvider.get(p.provider) !== undefined)
            ? [...todayAgg.byProvider.get(p.provider).values()].reduce((s, r) => s + r.requests, 0) : 0;
          return {
            provider: p.provider,
            accounts: p.accounts,
            balance: balance,
            unit: credits.unit || "",
            packages: credits.packages || [],
            error: p.error || "",
            today: { tokens: todayTotal, requests: todayReq },
            models: models,
            usedPct: models.reduce((m, x) => (x.usedPct === null ? m : Math.max(m === null ? 0 : m, x.usedPct)), null),
          };
        });
                // 合并「撞上限」状态：先扫日志（60 秒节流），再挂到对应模型上
        const weekModelIds = [];
        for (const inner of weekAgg.byProvider.values()) for (const mo of inner.values()) weekModelIds.push(mo.model);
        const scanTarget = Object.assign(weekModelIds, { providers: rows.map((r) => r.provider) });
        const caps = await scanCaps(ctx, scanTarget, false);
        const nowMs = Date.now();
        for (const r of rows) {
          for (const m of r.models) {
            const cap = caps.entries[r.provider + "|" + m.model];
            if (cap && Number(cap.until) > nowMs) {
              m.capped = true; m.capUntil = Number(cap.until); m.capReason = str(cap.reason); m.status = "danger";
            } else { m.capped = false; }
          }
        }
        jsonResponse(res, 200, { at: Date.now(), build: BUILD, day: latestDay || utc8DayKey(Date.now()), dayUsed: latestDay, rows: rows, cachedAt: cache.at, error: cache.error, source: "own-ledger" });
      } catch (error) {
        ctx.logger?.warn?.('[unified-quota] quota failed: %s', String(error && error.message || error));
        jsonResponse(res, 500, { error: 'quota failed' });
      }
    }
  });
  /** 底部状态栏用：当前会话最后一次调用的模型 + 它的额度进度。 */
  const disposeCurrent = ctx.webServer.register({
    kind: 'exact',
    path: API.current,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const sessionId = str(url.searchParams.get('session'));
        // 优先用「输入框当前选中的模型」（由客户端读取 modelSelection 投影后传入），
        // 这样切换模型立刻反映；其次用最后一次真实调用；最后用账本兜底。
        const reqProvider = str(url.searchParams.get('provider'));
        const reqModel = str(url.searchParams.get('model'));
        let used = (reqProvider.length > 0 && reqModel.length > 0)
          ? { provider: reqProvider, model: reqModel, at: Date.now() }
          : usedOf(sessionId);
        // 重启后还没发生新的模型调用时，内存里没有记录：
        // 退一步用账本最近一天的用量最大的模型（并标注 modelSource=ledger），
        // 否则底部血条会一直空着，看起来像"没生效"。
        let modelSource = (reqProvider.length > 0 && reqModel.length > 0) ? "selected" : (used === null ? "ledger" : "live");
        // 本请求里只加载一次模型名（供「排除免费模型」与「倍率换算」共用）
        let names0 = new Map();
        try {
          const roster0 = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
          names0 = await loadModelNames(ctx, roster0.map((r0) => r0.provider), false);
        } catch (e0) { /* 忽略 */ }
        if (used === null) {
          const raw0 = await readJsonCached(OWN_LEDGER_PATH);
          const day0 = latestLedgerDay(raw0);
          const agg0 = perModelOfSingleDay(raw0, day0);
          let best = null;
          for (const [provider, inner] of agg0.byProvider) {
            for (const row of inner.values()) {
              if (best === null || row.tokens > best.tokens) best = { provider: provider, model: row.model, tokens: row.tokens };
            }
          }
          if (best === null) return jsonResponse(res, 200, { build: BUILD, at: Date.now(), used: null });
          used = { provider: best.provider, model: best.model, at: Date.now() };
        }
        const store = configStoreOf();
        await store.load();
        const cfg = store.get();
        const soft = (cfg.softLimits && typeof cfg.softLimits === 'object') ? cfg.softLimits : {};
        const chSoft = soft[used.provider] || {};
        const mSoft = (chSoft.models && chSoft.models[used.model]) || {};
        const limT = Number(mSoft.tokens) > 0 ? Number(mSoft.tokens) : (Number(chSoft.tokens) > 0 ? Number(chSoft.tokens) : null);
        const limitSource = Number(mSoft.tokens) > 0 ? 'model' : (Number(chSoft.tokens) > 0 ? 'channel' : 'none');
        const ledgerRaw = await readJsonCached(OWN_LEDGER_PATH);
        const latestDay = latestLedgerDay(ledgerRaw);
        const agg = perModelOfSingleDay(ledgerRaw, latestDay);
        const inner = agg.byProvider.get(used.provider);
        const row = inner ? inner.get(used.model) : null;
        const usedTok = row ? row.tokens : 0;
        const remain = limT ? Math.max(0, 1 - usedTok / limT) : 1;
        const caps = await loadCaps();
        const cap = caps.entries[used.provider + '|' + used.model];
        const capped = cap !== undefined && Number(cap.until) > Date.now();
        const balLog = await loadBalanceLog();
        const rc = realConsumption(balLog, used.provider, 1);
        jsonResponse(res, 200, {
          build: BUILD, at: Date.now(), day: latestDay,
          used: { provider: used.provider, model: used.model, at: used.at },
          modelSource: modelSource,
          limit: { tokens: limT, source: limitSource },
          today: { tokens: usedTok },
          remain: capped ? 0 : remain,
          capped: capped,
          capUntil: capped ? Number(cap.until) : 0,
          capReason: capped ? str(cap.reason) : '',
          spent: rc === null ? null : (rc.today !== null ? rc.today.spent : rc.consumed),
          granted: rc === null ? 0 : (rc.today !== null ? rc.today.granted : rc.granted),
          // 渠道级今日 token（兜底用）
          // 排除限时免费(×0)模型：免费 token 不消耗积分，不能进换算分子
          channelTokens: (function () {
            let t = 0;
            for (const row2 of inner ? inner.values() : []) {
              const f0 = priceFactorFromName(names0.get(used.provider + ":" + row2.model) || row2.model);
              if (!(usableFactor(f0) && f0 === 0)) t += row2.tokens;
            }
            return t;
          })(),
          freeTokens: (function () {
            let t = 0;
            for (const row2 of inner ? inner.values() : []) {
              const f0 = priceFactorFromName(names0.get(used.provider + ":" + row2.model) || row2.model);
              if (usableFactor(f0) && f0 === 0) t += row2.tokens;
            }
            return t;
          })(),
          // ⚠️ 模型级「1 积分 ≈ N tok」：必须按倍率换算，否则同渠道下所有模型会给出同一个数。
          // 原理与积分账单一致：credits = token × 倍率 × k，
          //   基准(1×) = Σ(token×倍率) ÷ 实扣
          //   模型级   = 基准 ÷ 该模型倍率
          creditModel: await (async function () {
            try {
              const roster2 = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
              const names2 = await loadModelNames(ctx, roster2.map((r2) => r2.provider), false);
              const factorOf2 = (provider, model) => {
                const display = names2.get(provider + ":" + model) || "";
                const f = priceFactorFromName(display || model);
                return usableFactor(f) ? f : null;
              };
              const spentToday = rc === null ? null : (rc.today !== null ? rc.today.spent : rc.consumed);
              let weighted = 0;
              for (const row2 of inner ? inner.values() : []) {
                const f = factorOf2(used.provider, row2.model);
                // 限时免费(×0)不消耗积分，排除出加权分子
                if (f !== null && f > 0) weighted += row2.tokens * f;
              }
              const myFactor = factorOf2(used.provider, used.model);
              const base1x = (spentToday !== null && spentToday > 0 && weighted > 0) ? weighted / spentToday : null;
              // base1x 拿不到（该渠道今日无余额差样本）时，用其它渠道的加权平均基准兜底，
              // 并标注 source="inferred"，避免小窗直接显示"—"。
              let useBase = base1x;
              let src0 = "model";
              if (useBase === null) {
                try {
                  const allDays = await readJsonCached(OWN_LEDGER_PATH);
                  const dayRow = allDays && allDays.days ? allDays.days[latestLedgerDay(allDays)] : null;
                  const balances = await readJsonCached(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json')) || {};
                  let wSum = 0, sSum = 0;
                  for (const [prov, entries] of Object.entries(balances.entries || {})) {
                    if (!Array.isArray(entries) || entries.length < 2) continue;
                    const rc0 = realConsumption(balances, prov, 1);
                    const sp0 = rc0 && rc0.today ? rc0.today.spent : (rc0 ? rc0.consumed : 0);
                    if (!(sp0 > 0)) continue;
                    let wt = 0;
                    for (const [key, bucket] of Object.entries((dayRow && dayRow.byProviderModel) || {})) {
                      if (key.indexOf(prov + ":") !== 0) continue;
                      const f1 = priceFactorFromName((await loadModelNames(ctx, [prov], false)).get(key) || key);
                      if (usableFactor(f1) && f1 > 0) wt += (Number(bucket.input)||0)+(Number(bucket.output)||0)+(Number(bucket.cacheRead)||0) * f1;
                    }
                    if (wt > 0) { wSum += wt; sSum += sp0; }
                  }
                  if (wSum > 0 && sSum > 0) { useBase = wSum / sSum; src0 = "inferred"; }
                } catch (e) {}
              }
              const modelPerCredit = (useBase !== null && myFactor !== null && myFactor > 0) ? useBase / myFactor : null;
              return { factor: myFactor, baseAt1x: useBase, tokensPerCredit: modelPerCredit, source: modelPerCredit !== null ? src0 : "none" };
            } catch (e) { return { factor: null, baseAt1x: null, tokensPerCredit: null, source: "error" }; }
          })(),
        });
      } catch (error) {
        ctx.logger?.warn?.('[unified-quota] current failed: %s', String(error && error.message || error));
        jsonResponse(res, 500, { error: 'current failed' });
      }
    }
  });
  const disposeCalls = ctx.webServer.register({
    kind: 'exact',
    path: API.calls,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
      const out = await readCallRows(limit);
      jsonResponse(res, 200, out);
    }
  });
  const disposeBeacon = ctx.webServer.register({
    kind: 'exact',
    path: API.beacon,
    handler: async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const stage = String(url.searchParams.get('stage') || '').slice(0, 40);
      const detail = String(url.searchParams.get('detail') || '').slice(0, 300);
      const rec = { at: Date.now(), stage, detail };
      beacons.push(rec);
      if (beacons.length > 200) beacons.splice(0, beacons.length - 200);
      // 持久化：写盘，重启后仍可回溯（用户建议的全局探针）
      try {
        const pB = path.join(DSH_HOME, 'storages', 'unified-quota', 'beacons.jsonl');
        fsSync.mkdirSync(path.dirname(pB), { recursive: true });
        fsSync.appendFileSync(pB, JSON.stringify(rec) + '\n', 'utf8');
        // 防无限增长：超过 2000 行时截断到最近 1000 行
        const stB = fsSync.statSync(pB);
      // 轮转：2 MB 触发，保留最近 5000 行（原 512KB/1000 行，历史太短不易回溯）
      if (stB.size > 2 * 1024 * 1024) { const lines = fsSync.readFileSync(pB, 'utf8').trim().split('\n'); fsSync.writeFileSync(pB, lines.slice(-5000).join('\n') + '\n', 'utf8'); } } catch (e) { criticalCatch(DEBUG_DIR, "persist:3223", e); }
      jsonResponse(res, 200, { ok: true, beacons: beacons.slice(-60) });
    }
  });
  // 版本检查：返回后端查到的最新版（供前端展示）
  const disposeVersion = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/version',
    handler: async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      let latest = null, checkedAt = 0, url = '';
      try {
        const pB = path.join(DSH_HOME, 'storages', 'unified-quota', 'beacons.jsonl');
        const lines = fsSync.readFileSync(pB, 'utf8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
          const r = JSON.parse(lines[i]);
          if (r && r.stage === 'new-version') {
            const cand = String(r.detail || '').split(' -> ')[1] || null;
            // 防线：只有严格大于当前版本才上报（旧反向 beacon 在这里被过滤）
            if (cand && semverGt(cand, BUILD)) { latest = cand; checkedAt = r.at; url = r.url || ''; }
            break;
          }
        }
      } catch (e) {}
      return jsonResponse(res, 200, { ok: true, current: BUILD, latest: latest, checkedAt: checkedAt, url: url });
    },
  });
  ctx.effect?.(() => () => { try { disposeVersion && disposeVersion(); } catch (e) {} }, 'unified-quota: version-route');

  // —— WebDAV 备份/恢复（坚果云）——
  const disposeSyncStatus = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/sync/status',
    handler: async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const cfg = configStoreOf().get() || {};
        const dav = cfg.webdav || null;
        if (!dav || !dav.user || !dav.pass) {
          return jsonResponse(res, 200, { ok: true, configured: false, device: DEVICE_ID });
        }
        const cmp = await compareBackup(dav, STORAGE_DIR, DEVICE_ID);
        return jsonResponse(res, 200, Object.assign({ ok: true, configured: true, device: DEVICE_ID }, cmp));
      } catch (e) {
        criticalCatch(DEBUG_DIR, 'sync:status', e);
        return jsonResponse(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeSyncStatus && disposeSyncStatus(); } catch (e) {} }, 'unified-quota: sync-status');

  const disposeSyncUpload = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/sync/upload',
    handler: async (req, res) => {
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const cfg = configStoreOf().get() || {};
        const dav = cfg.webdav || null;
        if (!dav || !dav.user || !dav.pass) return jsonResponse(res, 400, { ok: false, error: '未配置坚果云账号' });
        // 智能同步：下载云端 → 合并本地 → 写回 → 上传合并结果
        const out = await syncMerge(dav, STORAGE_DIR, DEVICE_ID);
        return jsonResponse(res, 200, Object.assign({ ok: true }, out));
      } catch (e) {
        criticalCatch(DEBUG_DIR, 'sync:upload', e);
        return jsonResponse(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeSyncUpload && disposeSyncUpload(); } catch (e) {} }, 'unified-quota: sync-upload');

  const disposeSyncRestore = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/sync/restore',
    handler: async (req, res) => {
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' });
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const cfg = configStoreOf().get() || {};
        const dav = cfg.webdav || null;
        if (!dav || !dav.user || !dav.pass) return jsonResponse(res, 400, { ok: false, error: '未配置坚果云账号' });
        // 必须显式确认（避免误覆盖本地数据）
        let body = {};
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (e) {}
        if (body.confirm !== true) {
          return jsonResponse(res, 400, { ok: false, error: '需要 confirm: true 才执行恢复', needConfirm: true });
        }
        const out = await restoreBackup(dav, STORAGE_DIR, DEVICE_ID, body.backupLocal !== false);
        // 恢复会留下 .bak，清理旧的
        void pruneBackups(STORAGE_DIR);
        // ⚠️ 关键：恢复后必须同步内存实例，否则会被旧数据覆盖
        try {
          const inst = ledgerOf();
          await inst.load();
          inst.dirty = false;
        } catch (e) { criticalCatch(DEBUG_DIR, 'sync:restore-ledger', e); }
        try { await loadCaps(); capsLoaded = true; } catch (e) { criticalCatch(DEBUG_DIR, 'sync:restore-caps', e); }
        try { const cs = configStoreOf(); await cs.load(); } catch (e) { criticalCatch(DEBUG_DIR, 'sync:restore-config', e); }
        try { learnedCapCache = null; } catch (e) {}
        return jsonResponse(res, 200, Object.assign({ ok: true }, out, { restarted: true }));
      } catch (e) {
        criticalCatch(DEBUG_DIR, 'sync:restore', e);
        return jsonResponse(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeSyncRestore && disposeSyncRestore(); } catch (e) {} }, 'unified-quota: sync-restore');

  // 渠道健康数据：限流历史 + 当前 caps
  const disposeChanHealth = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/channel-health',
    handler: async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const caps = await loadCaps();
        const now = Date.now();
        const active = [];
        for (const [key, v] of Object.entries(caps.entries || {})) {
          const sep = key.indexOf('|');
          active.push({
            provider: sep > 0 ? key.slice(0, sep) : key,
            model: sep > 0 ? key.slice(sep + 1) : '',
            until: Number(v.until) || 0,
            active: Number(v.until) > now,
            at: Number(v.at) || 0,
            reason: String(v.reason || '').slice(0, 240),
          });
        }
        // 历史知识库
        let history = [];
        try {
          const raw = await fs.readFile(CAP_KB_PATH, 'utf8');
          history = raw.trim().split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        } catch (e) {}
        // 按渠道统计
        const byProvider = {};
        for (const h of history) {
          const p = h.provider || '?';
          if (!byProvider[p]) byProvider[p] = { count: 0, lastAt: 0, lastUntil: 0, withUntil: 0, kinds: {}, models: {} };
          const s = byProvider[p];
          s.count += 1;
          if (h.at > s.lastAt) { s.lastAt = h.at; s.lastUntil = h.until || 0; }
          if (h.hasUntil) s.withUntil += 1;
          s.kinds[h.kind || '?'] = (s.kinds[h.kind || '?'] || 0) + 1;
          s.models[h.model || '?'] = (s.models[h.model || '?'] || 0) + 1;
        }
        // 周期推断：对每个 (provider|model) 组合算限流间隔
        const periods = [];
        const seen = new Set();
        for (const h of history) {
          const key = (h.provider || '?') + '|' + (h.model || '?');
          if (seen.has(key)) continue;
          seen.add(key);
          const r = inferPeriodFromHistory(history, h.provider, h.model);
          if (r && r.samples >= 2) {
            periods.push({
              provider: h.provider,
              model: h.model,
              samples: r.samples,
              gaps: r.gaps || [],
              guessedMs: r.guessedMs,
              guessedHuman: r.guessedHuman || null,
              consistency: r.consistency || null,
              confidence: r.confidence,
              detail: r.detail || null,
            });
          }
        }
        periods.sort(function (a, b) { return (b.samples || 0) - (a.samples || 0); });
        return jsonResponse(res, 200, { ok: true, at: now, active: active, history: history.slice(-200), byProvider: byProvider, total: history.length, periods: periods });
      } catch (e) {
        return jsonResponse(res, 500, { error: String((e && e.message) || e).slice(0, 200) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeChanHealth && disposeChanHealth(); } catch (e) {} }, "unified-quota: channel-health");

  // 读取持久化 beacon 日志（排查用）
  const disposeBeaconRead = ctx.webServer.register({
    kind: 'exact',
    path: '/api/unified-quota/beacon-log',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('n')) || 100));
        const pB = path.join(DSH_HOME, 'storages', 'unified-quota', 'beacons.jsonl');
        let lines = [];
        try { lines = fsSync.readFileSync(pB, 'utf8').trim().split('\n').filter(Boolean); } catch (e) {}
        const tail = lines.slice(-limit).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        return jsonResponse(res, 200, { ok: true, total: lines.length, items: tail });
      } catch (e) {
        return jsonResponse(res, 500, { error: String(e && e.message || e).slice(0, 200) });
      }
    },
  });
  ctx.effect?.(() => () => { try { disposeBeaconRead && disposeBeaconRead(); } catch (e) {} }, "unified-quota: beacon-log");

  const disposeDetail = ctx.webServer.register({
    kind: 'exact',
    path: API.detail,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const windowDays = url.searchParams.get('window') || '30';
      return respond(req, res, async () => {
        const cfgD = configStoreOf().get();
        const opts = {
          windowDays,
          provider: url.searchParams.get('provider') || '',
          model: url.searchParams.get('model') || '',
          currency: cfgD.currency,
          rate: rateFor(cfgD),
        };
        // 缓存键必须含筛选参数，否则换筛选会拿到上一次的结果
        const key = opts.windowDays + '|' + opts.provider + '|' + opts.model + '|' + opts.currency + '|' + opts.rate + '|' + (url.searchParams.get('credits') === '1' ? 'c' : '');
        if (detailBuilding === null || detailBuildingKey !== key) {
          detailBuildingKey = key;
          detailBuilding = (async () => {
            const ledger = await readJsonCached(OWN_LEDGER_PATH);
            const wantCredits = url.searchParams.get('credits') === '1';
            const forceFactors = url.searchParams.get('refreshFactors') === '1';
            let names = new Map();
            if (wantCredits) {
              try {
                const roster = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
                names = await loadModelNames(ctx, roster.map((r) => r.provider), forceFactors);
              } catch (e) { /* 无倍率时降级 */ }
            }
            return { at: Date.now(), detail: buildDetail(ledger, opts, names) };
          })().finally(() => { detailBuilding = null; });
        }
        return detailBuilding;
      });
    }
  });
    // 阶段1a：服务挂件脚本字节（原样复用，不经任何改写）
  const disposeWhaleJs = ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/widget.js', handler: async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return jsonResponse(res, 405, { error: 'method not allowed' });
    const text = loadWidgetJs();
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(req.method === 'HEAD' ? undefined : text);
  } });
  // 阶段2 Step5：静态素材路由（从本插件 assets/ 服务，卸载小鲸鱼后图像音效不丢）
  const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  // ⚠️ 素材分离（2026-11-19）：GitHub 仓库只放代码（318KB，秒下），
  //    立绘/音效等 5.5MB 素材放在用户数据目录，**不会被插件更新覆盖**。
  //    读取顺序：包内 assets/ → 用户 storages/unified-quota/whale-assets/
  //    启动时若包内有素材而用户目录缺，则自动播种一份（首次安装即生效）。
  const USER_ASSETS_DIR = path.join(STORAGE_DIR, 'whale-assets');
  function assetPath(file) {
    const inPkg = path.join(ASSETS_DIR, file);
    if (fsSync.existsSync(inPkg)) return inPkg;
    return path.join(USER_ASSETS_DIR, file);
  }
  function seedUserAssets() {
    try {
      fsSync.mkdirSync(USER_ASSETS_DIR, { recursive: true });
      let copied = 0;
      for (const f of fsSync.readdirSync(ASSETS_DIR)) {
        // whale-widget.js 是代码，随包分发，不播种
        if (f === 'whale-widget.js') continue;
        const dst = path.join(USER_ASSETS_DIR, f);
        if (fsSync.existsSync(dst)) continue;
        fsSync.copyFileSync(path.join(ASSETS_DIR, f), dst);
        copied++;
      }
      if (copied > 0) ctx.logger?.info?.('[unified-quota] seeded %d whale assets to user dir', copied);
    } catch (e) { /* 包内无 assets（GitHub 瘦安装）：跳过，用已有用户素材 */ }
  }
  seedUserAssets();
  const MIME = { png: "image/png", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav" };
  // 音效组 → 文件（与 dsh-whale-widget SOUND_SETS 对齐）
  const SOUND_SETS_MAP = { duck: { press: 'Ya1.mp3', release: 'Ya2.mp3' }, fx1: { press: 'D1.mp3', release: 'D2.mp3' } };
  function serveSoundSet(req, res, slot) {
    try {
      const url = new URL(req.url || '/', 'http://x');
      const setName = url.searchParams.get('set') || 'duck';
      const set = SOUND_SETS_MAP[setName];
      if (!set) {
        // 自定义音效组：从用户音效索引里找该组的片段
        const idx = readJsonSync(path.join(WHALE_AUDIO_DIR, 'audio.json'), { groups: [], fragments: [] });
        const grp = (idx.groups || []).find(function (g) { return g && g.id === setName; });
        const fragId = grp ? grp[slot] : null;
        if (fragId) return serveAudioFragment(res, fragId);
        return serveSoundFile(res, 'Ya1.mp3');
      }
      return serveSoundFile(res, set[slot] || set.press);
    } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('sound unavailable'); }
  }
  function serveSoundFile(res, file) {
    try {
      const bytes = fsSync.readFileSync(assetPath(file));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
      return res.end(bytes);
    } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('sound unavailable'); }
  }
  function serveAudioFragment(res, id) {
    const BUILTIN = { exp_orb: ['minecraft-exp-orb.wav','audio/wav'], end_a: ['task-end-a.wav','audio/wav'], cost_a: ['cost-default.wav','audio/wav'], ask_a: ['ask-default.wav','audio/wav'], approve_a: ['approve-default.wav','audio/wav'] };
    const PRESET = { ya1: ['Ya1.mp3','audio/mpeg'], ya2: ['Ya2.mp3','audio/mpeg'], d1: ['D1.mp3','audio/mpeg'], d2: ['D2.mp3','audio/mpeg'] };
    let file = null, mime = 'audio/wav';
    if (BUILTIN[id]) { file = BUILTIN[id][0]; mime = BUILTIN[id][1]; }
    else if (PRESET[id]) { file = PRESET[id][0]; mime = PRESET[id][1]; }
    if (file !== null) {
      try {
        const bytes = fsSync.readFileSync(assetPath(file));
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
        return res.end(bytes);
      } catch (e) {}
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('fragment not found');
  }
  function serveAsset(file) {
    return async (req, res) => {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try {
        const bytes = fsSync.readFileSync(assetPath(file));
        const ext = String(file).split(".").pop();
        res.writeHead(200, { "Content-Type": (MIME[ext] || "application/octet-stream"), "Cache-Control": "no-store", "Content-Length": String(bytes.length) });
        return res.end(req.method === "HEAD" ? undefined : bytes);
      } catch (e) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("asset unavailable"); }
    };
  }
  const assetRoutes = [
    ["/dsh-whale/image.png", "DSniang1.png"],
    ["/dsh-whale/rua.gif", "rua.gif"],
  ];
  const disposeAssets = assetRoutes.map(function (pair) {
    return ctx.webServer.register({ kind: "exact", path: pair[0], handler: serveAsset(pair[1]) });
  });
  // —— 阶段2 Step4/5：小鲸鱼其余的配置/角色/音效路由（共用原有用户数据文件，不迁移）——
  const WHALE_SIZE_FILE = path.join(DSH_HOME, '.dshw-size.json');
  const WHALE_ROLE_DIR = path.join(DSH_HOME, 'whale-roles');
  const WHALE_AUDIO_DIR = path.join(DSH_HOME, 'whale-audio');
  const WHALE_BUBBLE_DIR = path.join(DSH_HOME, 'whale-bubble-imgs');
  const WHALE_BUBBLE_FILE = path.join(DSH_HOME, '.dshw-bubble.json');
  function readJsonSync(file, fallback) {
    try { return JSON.parse(fsSync.readFileSync(file, 'utf8')) || fallback; } catch (e) { return fallback; }
  }
  function writeJsonSync(file, value) {
    try { fsSync.mkdirSync(path.dirname(file), { recursive: true }); fsSync.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); return true; } catch (e) { return false; }
  }
  async function readBodyMax(req, limit) {
    return new Promise(function (resolve, reject) {
      let size = 0; const chunks = [];
      req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('body too large')); try { req.destroy(); } catch (e) {} return; } chunks.push(c); });
      req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });
  }
  const wj2 = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  function jsonOut(res, obj, code) { res.writeHead(code || 200, wj2); res.end(JSON.stringify(obj)); }
  const whaleExtraRoutes = [
    // size.json：外观/音效设置（读写）
    ['/dsh-whale/size.json', async function (req, res) {
      if (req.method === 'PUT' || req.method === 'POST') {
        try { const body = await readBodyMax(req, 256 * 1024); const next = acceptSizePatch(JSON.parse(body), new Date().toISOString());
          if (next === null) return jsonOut(res, { ok: false, error: 'bad body' }, 400);
          writeJsonSync(WHALE_SIZE_FILE, next); return jsonOut(res, Object.assign({ ok: true }, next)); }
        catch (e) { return jsonOut(res, { ok: false, error: String(e.message || e).slice(0, 120) }, 400); }
      }
      return jsonOut(res, Object.assign({ ok: true }, normalizeSize(readJsonSync(WHALE_SIZE_FILE, null))));
    }],
    // usage-settings.json（读写，存于我的配置旁）
    ['/dsh-whale/usage-settings.json', async function (req, res) {
      // 挂件读的是 d.settings（嵌套），不是扁平字段。
      // 之前返回扁平 { ok, taskEnd } 导致 d.settings === undefined
      // 于是挂件 usageSet=null，回落到内置默认值 —— 表现为每次重启设置被重置。
      const f = path.join(DSH_HOME, 'storages', 'unified-quota', 'whale-usage-settings.json');
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const body = await readBodyMax(req, 256 * 1024);
          const patch = JSON.parse(body) || {};
          const incoming = (patch.settings && typeof patch.settings === 'object') ? patch.settings : patch;
          const cur = Object.assign({}, usageSettingsDefaults(), readJsonSync(f, {}));
          for (const k of Object.keys(incoming)) {
            if (k === 'ok') continue;
            if (incoming[k] && typeof incoming[k] === 'object' && !Array.isArray(incoming[k])) cur[k] = Object.assign({}, cur[k] || {}, incoming[k]);
            else cur[k] = incoming[k];
          }
          writeJsonSync(f, cur);
          return jsonOut(res, { ok: true, settings: cur });
        } catch (e) { return jsonOut(res, { ok: false, error: String(e.message || e).slice(0, 120) }, 400); }
      }
      const cur = Object.assign({}, usageSettingsDefaults(), readJsonSync(f, {}));
      return jsonOut(res, { ok: true, settings: cur });
    }],
    // about / wait / update-check：静态信息
    ['/dsh-whale/about.json', function (req, res) { return jsonOut(res, whaleAbout({ version: BUILD })); }],
    ['/dsh-whale/wait.json', function (req, res) { return jsonOut(res, whaleWait()); }],
    ['/dsh-whale/update-check.json', function (req, res) { return jsonOut(res, whaleUpdateCheck(BUILD)); }],
    // 角色 / 气琶图 / 音效：读用户数据目录（空则返回默认）
    ['/dsh-whale/roles.json', function (req, res) { return jsonOut(res, readJsonSync(path.join(WHALE_ROLE_DIR, 'roles.json'), { version: 1, roles: [], pinned: null })); }],
    ['/dsh-whale/audio.json', function (req, res) { return jsonOut(res, readJsonSync(path.join(WHALE_AUDIO_DIR, 'audio.json'), AUDIO_INDEX_DEFAULT)); }],
    ['/dsh-whale/bubble-imgs.json', function (req, res) {
      const idx = readJsonSync(path.join(WHALE_BUBBLE_DIR, 'bubble-imgs.json'), BUBBLE_IMG_INDEX_DEFAULT);
      const seen = {}; (idx.images || []).forEach(function (im) { seen[im.id] = 1; });
      const builtins = DEFAULT_BUBBLE_IMGS.filter(function (d) { return !seen[d.id]; });
      return jsonOut(res, { ok: true, images: builtins.concat(idx.images || []) });
    }],
    // 角色图（从用户角色目录读，不存在则回退默认 DSniang1.png）
    ['/dsh-whale/role-image.png', function (req, res) {
      try {
        const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || 'default';
        let p = path.join(WHALE_ROLE_DIR, id + '.png');
        if (!fsSync.existsSync(p)) p = path.join(WHALE_ROLE_DIR, id + '.gif');
        if (!fsSync.existsSync(p)) p = assetPath('DSniang1.png');
        const bytes = fsSync.readFileSync(p);
        const mime = p.endsWith('.gif') ? 'image/gif' : 'image/png';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
        return res.end(bytes);
      } catch (e) { res.writeHead(404); return res.end(); }
    }],
    // 气琶图（用户图库优先，否则内置 assets）
    ['/dsh-whale/bubble-img.png', function (req, res) {
      try {
        const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || '';
        const builtin = DEFAULT_BUBBLE_IMGS.find(function (d) { return d.id === id; });
        let p = builtin ? assetPath(builtin.file) : path.join(WHALE_BUBBLE_DIR, id + '.png');
        if (!fsSync.existsSync(p)) p = path.join(WHALE_BUBBLE_DIR, id + '.gif');
        if (!fsSync.existsSync(p)) p = assetPath('bubble-money1.gif');
        const bytes = fsSync.readFileSync(p);
        const mime = p.endsWith('.gif') ? 'image/gif' : 'image/png';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
        return res.end(bytes);
      } catch (e) { res.writeHead(404); return res.end(); }
    }],
    // 音效：小鲸鱼注册的是两条精确路径 sound/press.mp3 与 sound/release.mp3（带 ?set=<音效组>）
    ['/dsh-whale/sound/press.mp3', function (req, res) { return serveSoundSet(req, res, 'press'); }],
    ['/dsh-whale/sound/release.mp3', function (req, res) { return serveSoundSet(req, res, 'release'); }],
    // 用户上传的音效片段
    // 音效片段：?id=<片段id>（预设/内置映射到 assets，自定义走用户目录）
    ['/dsh-whale/audio-fragment', function (req, res) {
      try {
        const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || '';
        // 内置片段（cost_a/ask_a/approve_a/end_a/exp_orb）→ assets
        const BUILTIN = { exp_orb: ['minecraft-exp-orb.wav','audio/wav'], end_a: ['task-end-a.wav','audio/wav'], cost_a: ['cost-default.wav','audio/wav'], ask_a: ['ask-default.wav','audio/wav'], approve_a: ['approve-default.wav','audio/wav'] };
        // 预设片段（ya1/ya2/d1/d2）→ assets 里的 mp3
        const PRESET = { ya1: ['Ya1.mp3','audio/mpeg'], ya2: ['Ya2.mp3','audio/mpeg'], d1: ['D1.mp3','audio/mpeg'], d2: ['D2.mp3','audio/mpeg'] };
        let file = null, mime = 'audio/wav';
        if (BUILTIN[id]) { file = BUILTIN[id][0]; mime = BUILTIN[id][1]; }
        else if (PRESET[id]) { file = PRESET[id][0]; mime = PRESET[id][1]; }
        let p;
        if (file !== null) p = assetPath(file);
        else { // 自定义片段：用户目录里找
          const base = path.basename(id);
          const cands = [path.join(WHALE_AUDIO_DIR, base + '.wav'), path.join(WHALE_AUDIO_DIR, base + '.mp3'), path.join(WHALE_AUDIO_DIR, base)];
          p = cands.find(function (c) { return fsSync.existsSync(c); });
          if (p === undefined) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('fragment not found'); }
          if (p.endsWith('.mp3')) mime = 'audio/mpeg';
        }
        const bytes = fsSync.readFileSync(p);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
        return res.end(bytes);
      } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('audio fragment unavailable'); }
    }],
    // 角色删除 / 置顶（写操作）
    ['/dsh-whale/role-delete.json', function (req, res) { return jsonOut(res, { ok: true, deleted: false }); }],
    ['/dsh-whale/role-pin.json', function (req, res) { return jsonOut(res, { ok: true, pinned: null }); }],
    // 气琶图上传 / 余额修正（保留接口，简单确认）
    ['/dsh-whale/bubble-img-upload.json', function (req, res) { return jsonOut(res, { ok: false, error: 'upload not supported in unified-quota', images: [] }); }],
    ['/dsh-whale/balance-adjustments.json', function (req, res) { return jsonOut(res, { ok: true, adjustments: [] }); }],
    ['/dsh-whale/bubble.json', async function (req, res) {
      if (req.method === 'PUT' || req.method === 'POST') {
        try { const body = await readBodyMax(req, 512 * 1024); const parsed = JSON.parse(body) || {};
          if (!Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) return jsonOut(res, { ok: false, error: 'bad body' }, 400);
          writeJsonSync(WHALE_BUBBLE_FILE, parsed); return jsonOut(res, Object.assign({ ok: true }, parsed)); }
        catch (e) { return jsonOut(res, { ok: false, error: String(e.message || e).slice(0, 120) }, 400); }
      }
      return jsonOut(res, Object.assign({ ok: true }, readJsonSync(WHALE_BUBBLE_FILE, BUBBLE_DEFAULT)));
    }],
  ];
  const disposeWhaleExtra = whaleExtraRoutes.map(function (pair) {
    return ctx.webServer.register({ kind: 'exact', path: pair[0], handler: async function (req, res) {
      if (rejected(ctx, req)) return denyOrigin(res, req);
      try { return await pair[1](req, res); } catch (e) { return jsonOut(res, { ok: false, error: String(e && e.message || e).slice(0, 120) }, 500); }
    } });
  });
  // 阶段2 Step1/3：balance + usage-records 数据源改为本插件
  const whaleCache = { at: 0, value: null };
  async function whaleData() {
    const now = Date.now();
    if (whaleCache.value !== null && now - whaleCache.at < 15000) return whaleCache.value;
    const [ledgerRaw, balanceRaw] = await Promise.all([
      readJsonCached(OWN_LEDGER_PATH), readJsonCached(path.join(DSH_HOME, 'storages', 'unified-quota', 'balance-log.json'))
    ]);
    const days = (ledgerRaw && ledgerRaw.days) || {};
    let officialTotal = null;
    try { const of = await fetchOfficial(ctx); if (of && Array.isArray(of.wallets)) officialTotal = of.wallets.reduce((s, w) => s + (Number(w.total) || 0), 0); } catch (e) { criticalCatch(DEBUG_DIR, "ledger:3558", e); }
    const bal = whaleBalance({ days: days, balanceLog: balanceRaw || {}, nowMs: now });
    // 官方余额可用则用之；不可用则置 null（绝不用渠道积分冒充 DeepSeek 余额）
    if (officialTotal !== null) { bal.totalBalance = officialTotal; bal.balanceSource = "official"; }
    else { bal.totalBalance = null; bal.balanceSource = "unavailable"; }
    const rec = whaleUsage({ days: days, nowMs: now, settings: {} });
    const value = { bal: bal, rec: rec };
    whaleCache.value = value; whaleCache.at = now;
    return value;
  }
  const wj = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  const disposeWhaleBalance = ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/balance.json', handler: async (req, res) => {
    if (rejected(ctx, req)) return denyOrigin(res, req);
    try {
      // 支持 ?refresh=1：绕过 whaleData 的 15 秒缓存（用户主动点击时必须拿即时值）
      try {
        const urlB = new URL(req.url || '/', 'http://127.0.0.1');
        if (urlB.searchParams.get('refresh') === '1') { whaleCache.value = null; whaleCache.at = 0; }
      } catch (e) {}
      const d = await whaleData();
      const bal = Object.assign({}, d.bal);
      const fx = cnyToTarget();
      const targetCur = (configStoreOf().get() || {}).currency || 'CNY';
      if (fx !== 1) {
        if (Number.isFinite(bal.totalBalance)) bal.totalBalance = bal.totalBalance * fx;
        if (Number.isFinite(bal.todayUsage)) bal.todayUsage = bal.todayUsage * fx;
        if (Number.isFinite(bal.lastBalance)) bal.lastBalance = bal.lastBalance * fx;
      }
      // 无论是否换算，币种标签都要跟随设置（payload 硬编码 CNY）
      bal.currency = targetCur;
      bal.todayUsageCurrency = targetCur;
      bal.lastBalanceCurrency = targetCur;
      res.writeHead(200, wj); res.end(JSON.stringify(bal));
    }
    catch (e) { res.writeHead(200, wj); res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String(e && e.message || e).slice(0, 160) })); }
  } });
  const disposeWhaleUsage = ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/usage-records.json', handler: async (req, res) => {
    if (rejected(ctx, req)) return denyOrigin(res, req);
    try {
      const d = await whaleData();
      const rec = d.rec;
      const fx2 = cnyToTarget();
      const out = (fx2 === 1 || !rec || !Array.isArray(rec.events)) ? rec : (function () {
        const copy = Object.assign({}, rec);
        copy.events = rec.events.map(function (e) {
          const o = Object.assign({}, e);
          if (Number.isFinite(o.cost)) o.cost = o.cost * fx2;
          if (Number.isFinite(o.amount)) o.amount = o.amount * fx2;
          return o;
        });
        return copy;
      })();
      res.writeHead(200, wj); res.end(JSON.stringify(out));
    }
    catch (e) { res.writeHead(200, wj); res.end(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 160) })); }
  } });
  const disposeWhaleLastTurn = ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/last-turn.json', handler: async (req, res) => {
    if (rejected(ctx, req)) return denyOrigin(res, req);
    try {
      // 真实轮次状态：由 session/event 的 turn/end 驱动（对齐 dsh-whale-widget 的 finalizeTurn）
      let lt = (ctx.__uqWhaleState !== undefined) ? ctx.__uqWhaleState : whaleLastTurnState;
        // 内存为空时读磁盘兜底（进程重启后仍能显示上一轮）
        if (lt === null || lt === undefined) {
          try {
            const rawLT = fsSync.readFileSync(path.join(DSH_HOME, 'storages', 'unified-quota', 'last-turn.json'), 'utf8');
            const diskLT = JSON.parse(rawLT);
            if (diskLT && typeof diskLT.turn === 'number') lt = diskLT;
          } catch (e) {}
        }
        debugLog(DSH_HOME, 'route', { seq: whaleTurnSeq, lt: lt, ltType: typeof lt });
      // 启动后 3 秒内返回 seq=0：挂件首次轮询会走「记忆值已过期→拉齐」分支，
      // 只更新 localStorage 不弹窗/不响铃，避免重启后误报「刚完成一轮」。
      const booting = (Date.now() - whaleBootAt) < 3000;
      const seqForClient = booting ? 0 : whaleTurnSeq;
      const payload = whaleLastTurnPayload({
        seq: seqForClient,
        lastSession: lt === null ? null : { turn: lt.turn, apiCostCny: lt.amount, at: lt.ts, tokens: lt.tokens, breakdown: lt.breakdown, creditBasis: lt.creditBasis, free: lt.free },
      });
      res.writeHead(200, wj); res.end(JSON.stringify(payload));
    } catch (e) { res.writeHead(200, wj); res.end(JSON.stringify({ ok: true, seq: whaleTurnSeq, turn: null })); }
  } });

  const disposeWhaleModels = ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/api-models.json', handler: async (req, res) => {
    if (rejected(ctx, req)) return denyOrigin(res, req);
    try {
      const roster = shapeRoster(await readJsonCached(ROSTER_CANDIDATES[0])) || [];
      const names = await loadModelNames(ctx, roster.map((r) => r.provider), false);
      const models = [];
      for (const [key, name] of names) { const p = key.indexOf(":"); models.push({ id: p > -1 ? key.slice(p+1) : key, name: name }); }
      res.writeHead(200, wj); res.end(JSON.stringify(whaleModels(models)));
    } catch (e) { res.writeHead(200, wj); res.end(JSON.stringify({ ok: true, models: [] })); }
  } });
ctx.effect?.(() => () => { disposeCore(); disposeBeacon(); disposeDetail(); disposeConfig(); disposeExport(); disposeCalls(); disposeCredits(); disposeQuota(); disposeCurrent(); disposeWhaleJs(); for (const d0 of disposeAssets) { d0(); } disposeWhaleBalance(); disposeWhaleUsage(); disposeWhaleLastTurn(); disposeWhaleModels(); for (const d1 of disposeWhaleExtra) { d1(); } }, 'unified-quota: routes');
  void ledgerReady;
  void (async () => {
    const store = configStoreOf();
    const cfg = await store.load();
    const billing = { ...BILLING_DEFAULTS, ...billingConfigOf(cfg) };
    await ledgerOf().load();
    await importLegacyHistory(ctx);
    await ensureRates(ctx).catch(() => {});
    installMeter(ctx, billing);
    ctx.logger?.info?.('[unified-quota] 记账已启动（币种 %s，峰谷 %s）', cfg.currency, cfg.peakEnabled ? '开' : '关');
  })().catch((error) => ctx.logger?.warn?.('[unified-quota] meter init failed: %s', String(error && error.message || error)));
  schedulePlanTrack(ctx);
  // 启动限流恢复探测（三阶段，见 startProbeLoop 注释）
  const stopProbe = startProbeLoop(ctx);
  // 自动同步定时器：每 5 分钟检查一次，仅在开启 autoSync 且有凭证时同步
  let autoSyncTimer = null;
  let autoSyncBusy = false;
  let lastAutoSyncAt = 0;   // 上次实际同步的时间戳；到期间隔由配置 autoSyncMin 决定
  const autoSyncTick = async function () {
    if (autoSyncBusy) return;
    try {
      const cfg = configStoreOf().get() || {};
      const dav = cfg.webdav || {};
      if (dav.autoSync !== true || !dav.user || !dav.pass) return;
      // 间隔（分钟）：配置可选 1/5/15/30/60；默认 5。每分钟 tick 一次，到期才真正同步
      const intervalMin = [1, 5, 15, 30, 60].includes(Math.round(Number(dav.autoSyncMin))) ? Math.round(Number(dav.autoSyncMin)) : 5;
      const now = Date.now();
      if (now - lastAutoSyncAt < intervalMin * 60000) return;
      lastAutoSyncAt = now;
      autoSyncBusy = true;
      const out = await syncMerge(dav, STORAGE_DIR, DEVICE_ID);
      ctx.logger?.info?.('[unified-quota] auto-sync ok: merged=' + JSON.stringify(out.merged));
      // 同步后刷新内存实例
      try { const inst = ledgerOf(); await inst.load(); inst.dirty = false; } catch (e) {}
      try { await loadCaps(); } catch (e) {}
    } catch (e) {
      criticalCatch(DEBUG_DIR, 'auto-sync', e);
    } finally { autoSyncBusy = false; }
  };
  // 版本检查：启动时后台查仓库最新版本，发现**真正更大**的版本才记录（只提示不自动装）
  // ⚠️ 2026-11-19 修复：原来用 releases/latest（最后一次发版 v7.25.4），
  //    改为仓库分发后没再发 Release ⇒ 本地 7.26.0 > 旧 tag 7.25.4 却提示"可更新"（反向更新）。
  //    现在以仓库 main 分支的 package.json 为版本源 + semver 比较，只有更大才提示。
  const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/xixiaohaia/dsh-unified-quota/main/package.json';
  let lastVersionCheck = 0;
  const checkVersion = async function () {
    try {
      const now = Date.now();
      if (now - lastVersionCheck < 3600000) return;  // 1 小时一次
      lastVersionCheck = now;
      const res = await fetch(VERSION_CHECK_URL, {
        headers: { 'User-Agent': 'dsh-unified-quota/' + BUILD, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const rel = await res.json();
      const latest = String(rel.version || rel.tag_name || '').replace(/^v/, '').trim();
      // 只有远端版本**严格大于**本地才提示（semver 比较，防止旧 tag 触发反向更新）
      if (!latest || !semverGt(latest, BUILD)) {
        ctx.logger?.info?.('[unified-quota] version check: up to date (%s)', BUILD);
        // 清掉历史残留的反向 beacon（latest <= current 的旧记录）
        try {
          const pB = path.join(DSH_HOME, 'storages', 'unified-quota', 'beacons.jsonl');
          if (fsSync.existsSync(pB)) {
            const lines = fsSync.readFileSync(pB, 'utf8').split('\n').filter(Boolean);
            const keep = lines.filter(function (l) {
              try { const r = JSON.parse(l); if (r && r.stage === 'new-version') return false; } catch (e) {}
              return true;
            });
            if (keep.length !== lines.length) fsSync.writeFileSync(pB, keep.join('\n') + '\n', 'utf8');
          }
        } catch (e) {}
        return;
      }
      ctx.logger?.warn?.('[unified-quota] NEW VERSION available: %s -> %s', BUILD, latest);
      // 写入 beacon，供前端展示
      try {
        const rec = { at: Date.now(), stage: 'new-version', detail: BUILD + ' -> ' + latest, url: rel.html_url || '' };
        const pB = path.join(DSH_HOME, 'storages', 'unified-quota', 'beacons.jsonl');
        fsSync.appendFileSync(pB, JSON.stringify(rec) + '\n', 'utf8');
      } catch (e) {}
    } catch (e) { /* 离线/限流：静默 */ }
  };
  setTimeout(checkVersion, 10000).unref?.();
  const versionTimer = setInterval(checkVersion, 3600000);
  versionTimer.unref?.();
  ctx.effect?.(() => () => { try { clearInterval(versionTimer); } catch (e) {} }, 'unified-quota: version-check');

  autoSyncTimer = setInterval(autoSyncTick, 60 * 1000);   // 每分钟检查到期（间隔由 autoSyncMin 决定）
  // 启动后 30 秒做一次初始同步（避免启动时立即请求）
  setTimeout(autoSyncTick, 30000).unref?.();
  ctx.effect?.(() => () => { if (autoSyncTimer !== null) { clearInterval(autoSyncTimer); autoSyncTimer = null; } }, 'unified-quota: auto-sync');
  ctx.effect?.(() => () => { try { stopProbe(); } catch (e) {} }, 'unified-quota: probe loop');
}

export default { name, inject, apply, API };
