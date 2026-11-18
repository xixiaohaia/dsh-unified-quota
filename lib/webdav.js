/**
 * WebDAV 备份/恢复（坚果云）。
 *
 * 设计原则：
 *   1. **单机双向**：上传只推本地→云端；恢复是云端→本地，但**恢复前必须确认**。
 *   2. **恢复带判断**：先对比本地/云端的时间戳与数据量，给出差异摘要，让用户决定。
 *   3. **恢复后同步内存**：ledger/config/caps 都有内存实例，只改文件会被覆盖。
 *   4. **凭证绝不上传**：只备份 4 个数据文件。
 *
 * 数据结构（云端）：
 *   /dsh-unified-quota/backup.json       ← 打包后的完整快照（含 meta）
 *   /dsh-unified-quota/meta.json         ← 轻量元信息（供快速对比，避免每次下载全量）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DAV_BASE = 'https://dav.jianguoyun.com/dav';
const REMOTE_DIR = '/dsh-unified-quota';
const BACKUP_FILE = '/backup.json';
const META_FILE = '/meta.json';
const TIMEOUT_MS = 20000;

/** 要备份的文件（相对 storages/unified-quota） */
const BACKUP_FILES = [
  { key: 'ledger', file: 'ledger.json', label: '账本', merge: 'append' },
  { key: 'balanceLog', file: 'balance-log.json', label: '余额日志', merge: 'append' },
  { key: 'config', file: 'config.json', label: '设置', merge: 'lww' },
  { key: 'caps', file: 'caps.json', label: '限流状态', merge: 'union' },
  { key: 'learnedCaps', file: 'learned-caps.json', label: '容量学习', merge: 'min' },
];

/**
 * 合并两份账本（两机不同时使用时安全）。
 * 去重键：sessions[].id（会话级，最精确）。
 * 策略：若两边 sessions 完全一致 ⇒ 同一批数据上传两次，取本地避免翻倍；
 *      否则按 key 累加 byProviderModel 并合并 sessions。
 */
function mergeLedger(local, remote) {
  const L = local && typeof local === 'object' ? local : { version: 1, days: {}, meta: {} };
  const R = remote && typeof remote === 'object' ? remote : { version: 1, days: {}, meta: {} };
  const out = { version: L.version || R.version || 1, days: {}, meta: Object.assign({}, L.meta || {}, R.meta || {}) };
  const days = new Set([...Object.keys(L.days || {}), ...Object.keys(R.days || {})]);
  const NUM = ['input','output','cacheRead','cacheWrite','reasoning','calls','cost','apiCost','costCny','apiCostCny','costEur','apiCostEur'];
  for (const day of days) {
    const ld = (L.days || {})[day] || {};
    const rd = (R.days || {})[day] || {};
    const lIds = (Array.isArray(ld.sessions) ? ld.sessions : []).map(s => s && s.id).filter(Boolean).sort().join(',');
    const rIds = (Array.isArray(rd.sessions) ? rd.sessions : []).map(s => s && s.id).filter(Boolean).sort().join(',');
    const identical = (lIds.length > 0 || rIds.length > 0) && lIds === rIds;
    if (identical) { out.days[day] = ld.sessions ? ld : rd; continue; }
    const sessions = new Map();
    for (const s of [...(Array.isArray(ld.sessions) ? ld.sessions : []), ...(Array.isArray(rd.sessions) ? rd.sessions : [])]) {
      if (s && s.id && !sessions.has(s.id)) sessions.set(s.id, s);
    }
    const bpm = new Map();
    for (const src of [ld, rd]) {
      for (const [k, v] of Object.entries(src.byProviderModel || {})) {
        if (!bpm.has(k)) bpm.set(k, Object.assign({}, v));
        else { const cur = bpm.get(k); for (const f of NUM) cur[f] = (Number(cur[f]) || 0) + (Number(v[f]) || 0); }
      }
    }
    const dayRow = Object.assign({}, ld, rd);
    dayRow.sessions = [...sessions.values()];
    dayRow.byProviderModel = Object.fromEntries(bpm);
    for (const f of NUM) dayRow[f] = (Number(ld[f]) || 0) + (Number(rd[f]) || 0);
    out.days[day] = dayRow;
  }
  return out;
}

/** 合并 balance-log：按 at+total 去重。 */
function mergeBalanceLog(local, remote) {
  const L = local && local.entries ? local : { entries: {} };
  const R = remote && remote.entries ? remote : { entries: {} };
  const out = { entries: {} };
  const providers = new Set([...Object.keys(L.entries), ...Object.keys(R.entries)]);
  for (const p of providers) {
    const seen = new Set();
    const arr = [];
    for (const s of [...(Array.isArray(L.entries[p]) ? L.entries[p] : []), ...(Array.isArray(R.entries[p]) ? R.entries[p] : [])]) {
      if (!s) continue;
      const key = Number(s.at) + '|' + Number(s.total);
      if (seen.has(key)) continue;
      seen.add(key); arr.push(s);
    }
    arr.sort((a, b) => Number(a.at) - Number(b.at));
    out.entries[p] = arr.slice(-4000);
  }
  return out;
}

function authHeader(user, pass) {
  // trim：凭证首尾空格会让 Basic 认证失败（实测踩过）
  return 'Basic ' + Buffer.from(String(user || '').trim() + ':' + String(pass || '').trim(), 'utf8').toString('base64');
}

async function dav(method, url, auth, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
  try {
    const init = {
      method: method,
      headers: { Authorization: auth, 'User-Agent': 'dsh-unified-quota/1.0', 'Cache-Control': 'no-cache' },
      signal: ctrl.signal,
    };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    const res = await fetch(url, init);
    return { status: res.status, ok: res.ok, text: await res.text().catch(function () { return ''; }) };
  } finally { clearTimeout(timer); }
}

/** 确保远端目录存在（MKCOL，已存在返回 405 也算成功）。 */
async function ensureDir(user, pass) {
  const r = await dav('MKCOL', DAV_BASE + REMOTE_DIR + '/', authHeader(user, pass));
  if (r.status === 201 || r.status === 405 || r.status === 301 || r.ok) return true;
  if (r.status === 401) throw new Error('认证失败（检查邮箱与应用密码）');
  throw new Error('建目录失败: HTTP ' + r.status + ' ' + r.text.slice(0, 100));
}

/** 读取一个本地文件；不存在返回 null。 */
async function readLocal(dir, name) {
  try { return await fs.readFile(path.join(dir, name), 'utf8'); } catch (e) { return null; }
}

/** 构造快照（只含存在的文件）。 */
async function buildSnapshot(dir, deviceId) {
  const files = {};
  const meta = { at: Date.now(), device: deviceId, files: {} };
  for (const spec of BACKUP_FILES) {
    const text = await readLocal(dir, spec.file);
    if (text === null) continue;
    files[spec.key] = text;
    meta.files[spec.key] = { file: spec.file, label: spec.label, merge: spec.merge, bytes: Buffer.byteLength(text, 'utf8') };
  }
  return { meta, payload: { meta: meta, files: files } };
}

/** 上传备份 + meta。 */
export async function uploadBackup(cfg, dir, deviceId) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号/应用密码');
  await ensureDir(cfg.user, cfg.pass);
  const snap = await buildSnapshot(dir, deviceId);
  if (Object.keys(snap.payload.files).length === 0) throw new Error('本地没有可备份的数据文件');
  const body = JSON.stringify(snap.payload);
  const r1 = await dav('PUT', DAV_BASE + REMOTE_DIR + BACKUP_FILE, authHeader(cfg.user, cfg.pass), body);
  if (!r1.ok && r1.status !== 201 && r1.status !== 204) throw new Error('上传备份失败: HTTP ' + r1.status);
  const r2 = await dav('PUT', DAV_BASE + REMOTE_DIR + META_FILE, authHeader(cfg.user, cfg.pass), JSON.stringify(snap.meta));
  if (!r2.ok && r2.status !== 201 && r2.status !== 204) throw new Error('上传元信息失败: HTTP ' + r2.status);
  return { ok: true, at: snap.meta.at, bytes: Buffer.byteLength(body, 'utf8'), files: Object.keys(snap.payload.files) };
}

/** 只拉 meta（轻量，用于对比）。 */
export async function fetchRemoteMeta(cfg) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号/应用密码');
  // 注意：坚果云 WebDAV 对 GET 的查询参数返回 400，不能加 ?t= 防缓存
  const r = await dav('GET', DAV_BASE + REMOTE_DIR + META_FILE, authHeader(cfg.user, cfg.pass));
  if (r.status === 404) return { ok: true, exists: false, meta: null };
  if (!r.ok) throw new Error('读取元信息失败: HTTP ' + r.status);
  let meta = null;
  try { meta = JSON.parse(r.text); } catch (e) { throw new Error('云端元信息格式异常'); }
  return { ok: true, exists: true, meta: meta };
}

/** 对比本地与云端，给出差异摘要（恢复前的判断依据）。 */
export async function compareBackup(cfg, dir, deviceId) {
  const remote = await fetchRemoteMeta(cfg);
  const local = await buildSnapshot(dir, deviceId);
  const localMeta = local.meta;
  const rows = [];
  const allKeys = new Set([...Object.keys(localMeta.files || {}), ...Object.keys((remote.meta && remote.meta.files) || {})]);
  for (const k of allKeys) {
    const l = (localMeta.files || {})[k];
    const r = (remote.meta && remote.meta.files || {})[k];
    rows.push({
      key: k,
      label: (l && l.label) || (r && r.label) || k,
      localBytes: l ? l.bytes : 0,
      remoteBytes: r ? r.bytes : 0,
      onlyLocal: !!l && !r,
      onlyRemote: !!r && !l,
      // 允许小幅抖动：append 型文件（账本/余额日志）会随时间增长，属于正常
      differs: !!(l && r) && Math.abs(l.bytes - r.bytes) > 128,
    });
  }
  return {
    ok: true,
    remoteExists: remote.exists,
    localAt: localMeta.at,
    remoteAt: remote.meta ? remote.meta.at : null,
    remoteDevice: remote.meta ? remote.meta.device : null,
    rows: rows,
    /** 云端比本地新？（按时间戳） */
    remoteNewer: remote.meta ? Number(remote.meta.at) > Number(localMeta.at) : false,
  };
}

/** 下载快照（恢复用）。 */
export async function downloadBackup(cfg) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号/应用密码');
  const r = await dav('GET', DAV_BASE + REMOTE_DIR + BACKUP_FILE, authHeader(cfg.user, cfg.pass));
  if (r.status === 404) throw new Error('云端没有备份文件');
  if (!r.ok) throw new Error('下载失败: HTTP ' + r.status);
  let payload = null;
  try { payload = JSON.parse(r.text); } catch (e) { throw new Error('云端备份格式异常'); }
  if (!payload || !payload.files) throw new Error('云端备份缺少 files 字段');
  return payload;
}

/**
 * 执行恢复：把云端文件写回本地。
 * @param {boolean} backupLocal 是否先把当前本地文件另存为 .bak-<ts>
 */
export { mergeLedger, mergeBalanceLog };

/**
 * 智能同步（双机交替使用）：
 *   1. 下载云端备份
 *   2. 合并 ledger / balance-log（会话去重 + 数值累加）
 *   3. config/caps/learned caps：取 updatedAt 较新者
 *   4. 写回本地
 *   5. 上传合并结果（这样另一台下次上传/下载都能拿到合并数据）
 *
 * @returns { merged, written, remoteAt }
 */
/**
 * 上传更新分发包到坚果云（供 update.ps1 下载）。
 * 与备份不同：这是完整的 .tgz 安装包，两台电脑的 update.bat 从这里下载。
 */
export async function uploadUpdatePackage(cfg, tgzPath, version) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号');
  const auth = authHeader(cfg.user, cfg.pass);
  const body = await import('node:fs/promises').then(f => f.readFile(tgzPath));
  await ensureDir(cfg.user, cfg.pass);
  const r = await dav('PUT', DAV_BASE + REMOTE_DIR + '/update-' + version + '.tgz', auth, body);
  if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error('上传更新包失败: HTTP ' + r.status);
  // 同时写一个 latest.json 指向最新版本（update.ps1 读它）
  const meta = { version: version, file: 'update-' + version + '.tgz', at: Date.now(), bytes: body.length };
  const r2 = await dav('PUT', DAV_BASE + REMOTE_DIR + '/update-latest.json', auth, JSON.stringify(meta));
  if (!r2.ok && r2.status !== 201 && r2.status !== 204) throw new Error('上传版本信息失败: HTTP ' + r2.status);
  return { ok: true, version: version, bytes: body.length };
}

/** 从坚果云下载最新更新包。返回 { version, buffer } 或 null（无更新）。 */
export async function fetchUpdatePackage(cfg, localVersion) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号');
  const auth = authHeader(cfg.user, cfg.pass);
  const r = await dav('GET', DAV_BASE + REMOTE_DIR + '/update-latest.json', auth);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('读取版本信息失败: HTTP ' + r.status);
  const meta = JSON.parse(r.text);
  if (!meta.version || meta.version === localVersion) return null;   // 已是最新
  const r2 = await dav('GET', DAV_BASE + REMOTE_DIR + '/' + meta.file, auth);
  if (!r2.ok) throw new Error('下载更新包失败: HTTP ' + r2.status);
  return { version: meta.version, buffer: Buffer.from(r2.text, 'binary'), file: meta.file };
}

export async function syncMerge(cfg, dir, deviceId) {
  if (!cfg || !cfg.user || !cfg.pass) throw new Error('未配置坚果云账号/应用密码');
  // 1) 下载云端
  let payload = null;
  try { payload = await downloadBackup(cfg); } catch (e) { /* 首次可能没有云端备份 */ }
  if (!payload || !payload.files) {
    // 云端没有备份 ⇒ 就当普通上传
    const up = await uploadBackup(cfg, dir, deviceId);
    return { firstUpload: true, written: up.files, merged: { ledger: false, balanceLog: false } };
  }
  const fsMod = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const path = pathMod.default;
  const f = await import('node:fs/promises');
  const fsx = f.default;
  const readJSON = async (name, def) => {
    try { return JSON.parse(await fsx.readFile(path.join(dir, name), 'utf8')); } catch (e) { return def; }
  };
  const writeJSON = async (name, obj) => {
    const target = path.join(dir, name);
    const bak = target + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { await fsx.copyFile(target, bak); } catch (e) {}
    await fsx.writeFile(target, JSON.stringify(obj, null, 2), 'utf8');
  };
  const parseRemote = (key, def) => {
    const t = payload.files[key];
    if (typeof t !== 'string') return def;
    try { return JSON.parse(t); } catch (e) { return def; }
  };
  // 2) 合并
  const localLedger = await readJSON('ledger.json', { version: 1, days: {}, meta: {} });
  const remoteLedger = parseRemote('ledger', { version: 1, days: {}, meta: {} });
  const mergedLedger = mergeLedger(localLedger, remoteLedger);
  const localBL = await readJSON('balance-log.json', { entries: {} });
  const remoteBL = parseRemote('balanceLog', { entries: {} });
  const mergedBL = mergeBalanceLog(localBL, remoteBL);
  // 3) config/caps/learned：取较新
  const newer = (lkey, rkey, name, def) => {
    const l = readJSON(name, def);
    const r = parseRemote(rkey, def);
    const lt = Number((l && (l.updatedAt || l.at)) || 0);
    const rt = Number((r && (r.updatedAt || r.at)) || 0);
    return rt > lt ? r : l;
  };
  const cfgNewer = await newer('config', 'config', 'config.json', {});
  const capsNewer = await newer('caps', 'caps', 'caps.json', { version: 1, entries: {} });
  // 4) 写回本地
  await writeJSON('ledger.json', mergedLedger);
  await writeJSON('balance-log.json', mergedBL);
  await writeJSON('config.json', cfgNewer);
  await writeJSON('caps.json', capsNewer);
  // 5) 上传合并结果
  const up = await uploadBackup(cfg, dir, deviceId);
  return {
    firstUpload: false,
    written: up.files,
    merged: { ledger: true, balanceLog: true },
    localDays: Object.keys(mergedLedger.days || {}).length,
    remoteDays: Object.keys(remoteLedger.days || {}).length,
    sessions: Object.values(mergedLedger.days || {}).reduce((n, d) => n + ((d && d.sessions && d.sessions.length) || 0), 0),
  };
}

export async function restoreBackup(cfg, dir, deviceId, backupLocal) {
  const payload = await downloadBackup(cfg);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const written = [];
  const backedUp = [];
  for (const spec of BACKUP_FILES) {
    const text = payload.files[spec.key];
    if (typeof text !== 'string') continue;
    const target = path.join(dir, spec.file);
    if (backupLocal) {
      const old = await readLocal(dir, spec.file);
      if (old !== null) {
        const bak = target + '.bak-' + ts;
        await fs.writeFile(bak, old, 'utf8').catch(function () {});
        backedUp.push(path.basename(bak));
      }
    }
    await fs.writeFile(target, text, 'utf8');
    written.push(spec.file);
  }
  return { ok: true, written: written, backedUp: backedUp, at: payload.meta ? payload.meta.at : null, device: payload.meta ? payload.meta.device : null };
}
