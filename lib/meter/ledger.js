/**
 * dsh-unified-quota —— 自己的账本存储。
 *
 * 与 cost-meter 的账本**完全独立**（不同路径、不同文件），卸载它不受影响。
 * 写入策略比它更保守：单进程内存聚合 + 防抖落盘 + temp+rename 原子替换，
 * 不做 worker 线程/跨进程锁仲裁（本插件是唯一写入者，不需要那套复杂度）。
 *
 * 对外形状（与面板读取保持一致，便于把历史直接迁进来）：
 *   days['YYYY-MM-DD'] = { date, input, output, cacheRead, cacheWrite, reasoning,
 *                          calls, cost, apiCost, costCny, apiCostCny,
 *                          byProviderModel: { 'provider:model': {...同字段} },
 *                          sessions: [ { id, at, ...同字段 } ] }
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls', 'cost', 'apiCost', 'costCny', 'apiCostCny'];

export function localDayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function zeroRow() {
  const row = {};
  for (const f of FIELDS) row[f] = 0;
  return row;
}

function addInto(target, src) {
  for (const f of FIELDS) target[f] = num(target[f]) + num(src[f]);
  return target;
}

export function emptyDay(date) {
  return { date, ...zeroRow(), byProviderModel: {}, sessions: [] };
}

export class QuotaLedger {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, days: {}, meta: { createdAt: Date.now(), updatedAt: 0, writer: 'dsh-unified-quota' } };
    this.timer = null;
    this.writing = null;
    this.dirty = false;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        this.data = { version: 1, days: parsed.days, meta: { ...this.data.meta, ...(parsed.meta || {}) } };
      }
    } catch { /* 首次运行或文件损坏：从空账本开始，绝不覆盖已有可解析内容 */ }
    return this;
  }

  /** 记一笔。同步完成内存聚合，落盘走防抖。 */
  account({ buckets, cost, apiCost, costCny, apiCostCny, provider, model, sessionId, atMs }) {
    const at = Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now();
    const date = localDayKey(at);
    const day = this.data.days[date] || (this.data.days[date] = emptyDay(date));
    const delta = {
      input: num(buckets?.input), output: num(buckets?.output),
      cacheRead: num(buckets?.cacheRead), cacheWrite: num(buckets?.cacheWrite),
      reasoning: num(buckets?.reasoning), calls: 1,
      cost: num(cost), apiCost: num(apiCost),
      costCny: num(costCny), apiCostCny: num(apiCostCny),
    };
    addInto(day, delta);
    const key = String(provider || '') + ':' + String(model || '');
    const bucket = day.byProviderModel[key] || (day.byProviderModel[key] = zeroRow());
    addInto(bucket, delta);
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      let row = day.sessions.find((s) => s && s.id === sessionId);
      if (row === undefined) {
        row = { id: sessionId, at, ...zeroRow() };
        day.sessions.push(row);
      }
      addInto(row, delta);
      if (day.sessions.length > 200) day.sessions.splice(0, day.sessions.length - 200);
    }
    this.prune();
    this.schedule();
    return delta;
  }

  prune() {
    const days = Object.keys(this.data.days).sort();
    const keep = 400;
    if (days.length > keep) for (const d of days.slice(0, days.length - keep)) delete this.data.days[d];
  }

  schedule() {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 2000);
    this.timer.unref?.();
  }

  async flush() {
    if (this.writing !== null) { await this.writing; }
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify(this.data);
    this.writing = (async () => {
      try {
        const dir = path.dirname(this.file);
        await fs.mkdir(dir, { recursive: true });
        const tmp = this.file + '.tmp-' + process.pid;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, this.file); // 原子替换：读侧永远看到完整 JSON
        this.data.meta.updatedAt = Date.now();
      } catch (error) {
        this.dirty = true;
        console.warn('[unified-quota] ledger flush failed: ' + String(error && error.message || error));
      } finally {
        this.writing = null;
      }
    })();
    await this.writing;
  }

  async close() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}
