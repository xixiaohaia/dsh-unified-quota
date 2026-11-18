/**
 * 统一诊断模块。
 *
 * 背景：排查「¥0.00 弹窗」时踩了大坑 —— 12 轮都在改公式，但代码因为一个
 * `options` ReferenceError 根本没执行过，异常被 `catch (e) {}` 静默吞掉。
 * 加了探针后发现「诊断文件根本没生成」，1 轮就定位了。
 *
 * 约定：
 *   · 平时**默认关闭**，零开销（只在 UQ_DEBUG 时写盘）
 *   · 用「文件是否存在」直接回答「这行代码有没有跑过」
 *   · catch 里的异常也记下来，避免 ReferenceError 这类致命错误被掩盖
 *
 * 开关：
 *   UQ_DEBUG=1        启用全部探针
 *   UQ_DEBUG=cost     只启用 cost 通道
 *   UQ_DEBUG=cost,error  多通道
 */
import fsSync from 'node:fs';
import path from 'node:path';

const RAW = String(process.env.UQ_DEBUG || '').trim();
const ENABLED = RAW.length > 0 && RAW !== '0';
const CHANNELS = new Set(RAW.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
const ALL = CHANNELS.has('1') || CHANNELS.has('all') || CHANNELS.has('*');

export const DEBUG_ON = ENABLED;

/** 某通道是否启用。channel 省略时看全局。 */
export function debugEnabled(channel) {
  if (!ENABLED) return false;
  if (ALL) return true;
  if (!channel) return false;
  return CHANNELS.has(String(channel).toLowerCase());
}

/**
 * 追加一行 JSON 到 <debugDir>/<channel>.jsonl。
 * 失败绝不抛错（诊断不该影响主流程）。
 */
export function debugLog(debugDir, channel, payload) {
  if (!debugEnabled(channel)) return;
  try {
    const dir = path.join(debugDir, 'debug');
    fsSync.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, payload || {})) + '\n';
    fsSync.appendFileSync(path.join(dir, channel + '.jsonl'), line, 'utf8');
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

/**
 * 安全 catch：把异常记下来再吞掉。
 *
 * 替代裸的 `catch (e) {}` —— 后者会掩盖 ReferenceError / TypeError 这类
 * 「代码压根没跑」的致命问题，让你误以为「逻辑算错了」。
 */
/**
 * 关键路径 catch：**始终**记录（不依赖 UQ_DEBUG）。
 *
 * 用于数据持久化、价格计算、限流检测、账本读写 —— 这些路径出错会导致
 * 金额算错或数据丢失，属于「必须知道」的失败，不能因为没开调试就静默。
 *
 * 限流记录频率：同一 tag 60 秒内只写一次，避免刷爆磁盘。
 */
const criticalSeen = new Map();
export function criticalCatch(debugDir, tag, error) {
  try {
    const key = String(tag || '?');
    const now = Date.now();
    const last = criticalSeen.get(key) || 0;
    if (now - last < 60000) return;   // 同 tag 一分钟一次
    criticalSeen.set(key, now);
    const dir = path.join(debugDir, 'debug');
    fsSync.mkdirSync(dir, { recursive: true });
    const msg = error && error.message ? String(error.message) : String(error);
    const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 6).join(' | ') : '';
    fsSync.appendFileSync(
      path.join(dir, 'critical.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), tag: key, message: msg.slice(0, 300), stack: stack.slice(0, 700) }) + '\n',
      'utf8',
    );
  } catch (e) { /* 记录失败不影响主流程 */ }
}

export function safeCatch(debugDir, tag, error) {
  if (!ENABLED) return;
  try {
    const dir = path.join(debugDir, 'debug');
    fsSync.mkdirSync(dir, { recursive: true });
    const msg = error && error.message ? String(error.message) : String(error);
    const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 4).join(' | ') : '';
    fsSync.appendFileSync(
      path.join(dir, 'error.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), tag: tag, message: msg.slice(0, 300), stack: stack.slice(0, 500) }) + '\n',
      'utf8',
    );
  } catch (e) { /* 连记录都失败就放弃 */ }
}
