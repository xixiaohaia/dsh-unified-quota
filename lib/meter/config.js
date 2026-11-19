/**
 * dsh-unified-quota —— 配置（持久化 + 校验）。
 *
 * 与账本分开存：配置小、改得频繁，单独文件避免每次改设置都重写账本。
 * 校验一律「白名单 + 类型收敛」：不认识的值丢弃而不是整份拒绝
 * （设置页逐项保存，一项非法不该把其它项一起回滚）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PRICE_TABLE } from './pricing.js';

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const text = (v, fallback, max = 200) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

export function defaultConfig() {
  return {
    version: 1,
    // 展示
    currency: 'CNY',              // CNY | USD | EUR
    exchangeRate: 7.1,
    // 手动指定汇率（>0 时优先于自动抓取；0 或 null 表示用自动抓取）
    manualRate: 0,
    // 坚果云 WebDAV 同步（凭证只存本地，绝不上传）
    webdav: { user: '', pass: '', autoSync: false, autoSyncMin: 5 },            // USD → currency（币种为 USD 时无意义）
    decimals: 4,                  // 金额小数位（小于 1 元时自动加位）
    locale: 'auto',               // auto | zh | en
    // 计价
    peakEnabled: true,            // 峰谷计价
    priceMatch: 'auto',           // auto | exact
    priceOverrides: {},           // { 'provider:model': '目标' | '__local__' | '__custom__' }
    // 每渠道「1 积分 = 多少人民币」——渠道 API 不返回套餐价格，只能用户手填。
    // 用于把 token 消耗折算成真实花费，横向对比哪家套餐更划算。
    creditPrices: {},             // { 'buddy': 0.01 }
    // 上游不返回缓存命中数据时（如 trae），用这个假定命中率估算费用。
    // 按 { 'provider': 0.84 } 配置；未配置的渠道按 0（保守，按未命中算）。
    assumedCacheHit: {},          // { 'trae': 0.84 }
    customPrices: {},             // { 'provider:model': { cacheHit, cacheMiss, output } } 单位 USD / 1M token
    // 口径
    statisticsBasis: 'api',       // api（实付）| total（实付+等值）| plan（仅等值）
    includeSubagentCost: true,    // 明细页是否合并子代理
    // 显示
    showOfficialBalance: true,
    showChannels: true,
    showWhale: true,
    sidebarCompact: false,
    // 明细页
    detailWindow: 30,             // 7 | 30 | 90
    detailTab: 'provider',        // 顶部页签：table | credits | quota | health
    detailSubTab: 'provider',     // 明细页细分：provider | model | day | session        // provider | model | day | session | call
    showTrend: true,
    showComposition: true,
    // 软上限（每渠道自定义）：默认全空 = 不做任何上限判断。
    //
    // 为什么不预置"社区参考值"：各渠道的真实日额度**都不公开**（Cline 只在 429 报错里
    // 用英文句子说"try again in 19h"，CodeBuddy/TRAE/Qoder 根本没有查询端点）。
    // 实测本机 codearts 单日就消耗 3785 万 token —— 若预置一个猜的 1000 万，
    // 界面会每天报 100% 红警，比不设更糟。故默认关闭，由用户在设置页按自己的
    // 实际套餐填（留空即该渠道不判断）。
    softLimits: {},
  };
}

/** 逐字段收敛；未知键丢弃，非法值回退默认。 */
export function normalizeConfig(raw, base) {
  const d = base ?? defaultConfig();
  const src = obj(raw) ?? {};
  const out = { ...d };
  out.currency = pick(src.currency, ['CNY', 'USD', 'EUR'], d.currency);
  out.exchangeRate = clamp(src.exchangeRate, 0.01, 1000, d.exchangeRate);
  // WebDAV 凭证：只保留字符串，长度限制
  const wd = obj(src.webdav) || {};
  // trim：用户从别处复制凭证时极易带首尾空格，Basic 认证会因此失败
  out.webdav = {
    user: typeof wd.user === 'string' ? wd.user.trim().slice(0, 200) : '',
    pass: typeof wd.pass === 'string' ? wd.pass.trim().slice(0, 200) : '',
    autoSync: wd.autoSync === true,
    // 自动同步间隔（分钟）：1/5/15/30/60 之外的值收敛到合法档位
    autoSyncMin: (function () {
      const n = Math.round(Number(wd.autoSyncMin));
      return [1, 5, 15, 30, 60].includes(n) ? n : 5;
    })(),
  };
  // 手动汇率：0 = 用自动抓取；>0 = 覆盖
  const mr = Number(src.manualRate);
  out.manualRate = Number.isFinite(mr) && mr > 0 ? Math.min(1000, Math.max(0, mr)) : 0;
  out.decimals = Math.round(clamp(src.decimals, 0, 8, d.decimals));
  out.locale = pick(src.locale, ['auto', 'zh', 'en'], d.locale);
  out.peakEnabled = bool(src.peakEnabled, d.peakEnabled);
  out.priceMatch = pick(src.priceMatch, ['auto', 'exact'], d.priceMatch);
  const ov = obj(src.priceOverrides);
  out.priceOverrides = {};
  if (ov !== null) {
    for (const [k, v] of Object.entries(ov)) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 200) continue;
      if (v === '__local__' || v === '__custom__') out.priceOverrides[k] = v;
      else if (typeof v === 'string' && v.length > 0 && v.length <= 200) out.priceOverrides[k] = v;
    }
  }
  const cp = obj(src.customPrices);
  out.customPrices = {};
  if (cp !== null) {
    for (const [k, v] of Object.entries(cp)) {
      const row = obj(v);
      if (row === null || typeof k !== 'string' || k.length > 200) continue;
      const entry = {
        cacheHit: clamp(row.cacheHit, 0, 1e6, 0),
        cacheMiss: clamp(row.cacheMiss, 0, 1e6, 0),
        output: clamp(row.output, 0, 1e6, 0),
      };
      if (entry.cacheHit + entry.cacheMiss + entry.output > 0) out.customPrices[k] = entry;
    }
  }
  out.statisticsBasis = pick(src.statisticsBasis, ['api', 'total', 'plan'], d.statisticsBasis);
  out.includeSubagentCost = bool(src.includeSubagentCost, d.includeSubagentCost);
  out.showOfficialBalance = bool(src.showOfficialBalance, d.showOfficialBalance);
  out.showChannels = bool(src.showChannels, d.showChannels);
  out.showWhale = bool(src.showWhale, d.showWhale);
  out.sidebarCompact = bool(src.sidebarCompact, d.sidebarCompact);
  out.detailWindow = Math.round(clamp(src.detailWindow, 1, 365, d.detailWindow));
  // 白名单必须与实际页签一致（原来是 provider/model/day/session/call，全是旧值 ⇒ 用户切页签永远存不下来）
  // 顶部页签（多平台明细/积分账单/额度窗口/渠道健康）
  out.detailTab = pick(src.detailTab, ['table', 'credits', 'quota', 'health'], d.detailTab);
  // 明细页细分页签（按渠道/按模型/按日/按会话）—— 独立字段，避免与 detailTab 争用
  out.detailSubTab = pick(src.detailSubTab, ['provider', 'model', 'day', 'session', 'call'], d.detailSubTab);
  // 已存的 config.json 可能是旧版本（没有 softLimits 字段）⇒ 必须回退到默认值，
  // 否则「社区参考额度」永远不生效（曾经出现过：codearts 有 1000 万上限却显示「无」）。
  // 软上限支持两层：渠道级默认 + 模型级覆盖。
  //   softLimits[provider] = { tokens, requests, models: { modelId: { tokens, requests } } }
  // 模型级是必须的：同一渠道不同模型的日额度各自独立（比如 buddy 的
  // deepseek-v4.1-flash 撞额度了，同渠道其它模型照样能用）。
  const sl = obj(src.softLimits) ?? obj(d.softLimits);
  out.softLimits = {};
  if (sl !== null) {
    for (const [k, v] of Object.entries(sl)) {
      const row = obj(v);
      if (row === null || typeof k !== 'string' || k.length > 64) continue;
      const requests = clamp(row.requests, 0, 1e9, 0);
      const tokens = clamp(row.tokens, 0, 1e12, 0);
      const models = {};
      const mObj = obj(row.models);
      if (mObj !== null) {
        for (const [mid, mv] of Object.entries(mObj)) {
          const mr = obj(mv);
          if (mr === null || typeof mid !== 'string' || mid.length === 0 || mid.length > 160) continue;
          const mt = clamp(mr.tokens, 0, 1e12, 0);
          const mq = clamp(mr.requests, 0, 1e9, 0);
          if (mt > 0 || mq > 0) models[mid] = { tokens: Math.round(mt), requests: Math.round(mq) };
        }
      }
      if (requests > 0 || tokens > 0 || Object.keys(models).length > 0) {
        out.softLimits[k] = { requests: Math.round(requests), tokens: Math.round(tokens), models };
      }
    }
  }
  out.showTrend = bool(src.showTrend, d.showTrend);
  out.showComposition = bool(src.showComposition, d.showComposition);
  return out;
}

export class ConfigStore {
  constructor(file) {
    this.file = file;
    this.data = defaultConfig();
    this.loaded = false;
    this.mtime = 0;
    this.timer = null;
    this.writing = null;
    this.dirty = false;
  }

  async load() {
    // 有未落盘的本地改动时以内存为准，避免被外部文件覆盖
    if (this.dirty) return this.data;
    let stamp = 0;
    try { const st = await fs.stat(this.file); stamp = st.mtimeMs; } catch (e) { /* 文件还不存在 */ }
    // 已加载过：只在文件 mtime 变化时重读 —— 手工编辑 config.json 或外部写入都能立即生效
    if (this.loaded && stamp === this.mtime) return this.data;
    this.loaded = true;
    this.mtime = stamp;
    if (stamp === 0) return this.data;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.data = normalizeConfig(parsed);
    } catch (e) { /* 保留当前值 */ }
    return this.data;
  }

  get() { return this.data; }

  /** 合并补丁并落盘。返回归一化后的新配置。 */
  async patch(patch) {
    const merged = { ...this.data, ...(obj(patch) ?? {}) };
    this.data = normalizeConfig(merged);
    this.schedule();
    return this.data;
  }

  /** 直接替换（设置页整表保存）。 */
  async replace(next) {
    this.data = normalizeConfig(next);
    this.schedule();
    return this.data;
  }

  schedule() {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 400);
    this.timer.unref?.();
  }

  async flush() {
    if (this.writing !== null) await this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify(this.data, null, 2);
    this.writing = (async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp-' + process.pid;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, this.file);
      } catch (error) {
        this.dirty = true;
        console.warn('[unified-quota] config flush failed: ' + String(error && error.message || error));
      } finally { this.writing = null; }
    })();
    await this.writing;
  }

  async close() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}

/** 计费侧需要的配置视图（价格表 + 覆盖 + 峰谷）。 */
export function billingConfigOf(config) {
  const overrides = { ...config.priceOverrides };
  // 自定义单价以 '__custom__' 标记，价格表要带上相应条目
  const custom = {};
  for (const [key, v] of Object.entries(config.customPrices)) {
    overrides[key] = '__custom__';
    custom[key] = v;
  }
  const prices = JSON.parse(JSON.stringify(DEFAULT_PRICE_TABLE));
  if (Object.keys(custom).length > 0) prices.custom = custom;
  return {
    prices,
    priceMatch: config.priceMatch,
    priceOverrides: overrides,
    peakEnabled: config.peakEnabled,
    currency: config.currency,
    exchangeRate: config.exchangeRate,
  };
}
