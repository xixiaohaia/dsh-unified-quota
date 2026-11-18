/**
 * 每日汇率（欧洲央行 ECB 参考价，经 Frankfurter 公开镜像）。
 *
 * 为什么用这个源：无账号、无 Key、每日一次、数据来自央行而非商业聚合站；
 * 额度中心只需要「美元 → 显示币种」一个数，不需要分钟级波动。
 *
 * 失败策略（重要）：拉不到就**沿用上次成功的汇率**并标记 stale，
 * 绝不把汇率置 0 —— 那会让所有历史金额瞬间变成 0，比慢一天危险得多。
 */

export const EXCHANGE_RATE_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates?base=USD&quotes=CNY,EUR';

const num = (v) => (Number.isFinite(v) && v > 0 && v < 1e6 ? v : null);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 解析 Frankfurter 响应；不合法直接抛，由调用方保留旧值。 */
export function parseRates(rows, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 32) throw new Error('invalid rate payload');
  const rates = { USD: 1 };
  const dates = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (row.base !== 'USD') continue;
    const quote = String(row.quote || '');
    if (quote !== 'CNY' && quote !== 'EUR') continue;
    const date = String(row.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid rate date');
    const at = Date.parse(date + 'T00:00:00Z');
    if (!Number.isFinite(at)) throw new Error('invalid rate date');
    if (at > now + 86400_000) throw new Error('rate date in the future');
    if (at < now - 14 * 86400_000) throw new Error('rate date too old');
    const rate = num(row.rate);
    if (rate === null) throw new Error('invalid rate value');
    rates[quote] = rate;
    dates.add(date);
  }
  if (rates.CNY === undefined || rates.EUR === undefined) throw new Error('incomplete rates');
  return { rates, date: [...dates][0] };
}

/**
 * 每日刷新器：同一天只成功拉一次；失败后 1 小时内不重试（避免每轮面板刷新都打网络）。
 */
export class DailyRates {
  constructor(state, { request = fetch, now = Date.now } = {}) {
    this.state = state;            // { rates, date, checkedAt, stale, error }
    this.request = request;
    this.now = now;
    this.pending = null;
    this.lastAttempt = 0;
  }

  /** 今天已经拿到过吗？ */
  freshToday() {
    const s = this.state;
    if (!s || typeof s.date !== 'string' || s.date.length !== 10) return false;
    const today = dayKey(this.now());
    if (s.date === today) return true;
    // 央行周末/节假日不发新价：只要「今天已经成功检查过」且报价在 4 天内，就算当期有效
    const checkedToday = Number.isFinite(s.checkedAt) && dayKey(s.checkedAt) === today;
    const at = Date.parse(s.date + 'T00:00:00Z');
    return checkedToday && Number.isFinite(at) && this.now() - at <= 4 * 86400_000;
  }

  get(currency) {
    const s = this.state;
    const rate = s && s.rates ? num(s.rates[currency]) : null;
    return rate === null ? null : rate;
  }

  /**
   * 尝试刷新。返回 { changed, state }。永不抛：失败只更新 error/stale。
   * @param {boolean} force 忽略当日已成功与重试间隔
   */
  async refresh(force = false) {
    const now = this.now();
    if (!force) {
      if (this.freshToday()) return { changed: false, state: this.state };
      if (this.lastAttempt > 0 && now - this.lastAttempt < 3600_000) return { changed: false, state: this.state };
    }
    if (this.pending !== null) return this.pending;
    this.lastAttempt = now;
    this.pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      timer.unref?.();
      try {
        const res = await this.request(EXCHANGE_RATE_URL, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
        if (!res.ok) throw new Error('rate service ' + res.status);
        const text = await res.text();
        if (text.length > 65536) throw new Error('rate payload too large');
        const parsed = parseRates(JSON.parse(text), now);
        this.state = { rates: parsed.rates, date: parsed.date, checkedAt: now, stale: false, error: null };
        return { changed: true, state: this.state };
      } catch (error) {
        // 保留旧汇率，只标记 stale
        this.state = {
          ...(this.state || { rates: { USD: 1, CNY: 7.1, EUR: 0.92 }, date: '', checkedAt: 0 }),
          stale: true,
          error: String(error && error.message || error),
        };
        return { changed: false, state: this.state };
      } finally {
        clearTimeout(timer);
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
