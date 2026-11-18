#!/usr/bin/env node
/**
 * React Hooks 规则检查。
 *
 * 检查两类违规：
 *   1. 含 Hook 的【命名函数】被直接调用（应为 h(Name, props)）
 *   2. 含 Hook 的【匿名 IIFE】(function(){...})() （7.25.1 事故）
 *
 * 用法：node scripts/check-hooks.mjs [file]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] || path.join(ROOT, "lib", "client.js");
const src = fs.readFileSync(file, "utf8");
const risky = [];

// —— 检查 1：命名函数含 Hook 且被直接调用 ——
const funcs = [...src.matchAll(/^function (\w+)\s*\(/gm)];
for (let i = 0; i < funcs.length; i++) {
  const name = funcs[i][1];
  const start = funcs[i].index;
  const end = i + 1 < funcs.length ? funcs[i + 1].index : src.length;
  const body = src.slice(start, end);
  if (!/react\.use(State|Effect|Callback|Ref|Memo)/.test(body)) continue;
  const defLine = src.slice(0, start).split("\n").length;   // 定义所在行
  const calls = [...src.matchAll(new RegExp("(?<![\\w.$])" + name + "\\s*\\(", "g"))]
    .filter((m) => {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const callLine = src.slice(0, m.index).split("\n").length;
      if (callLine === defLine) return false;            // 定义行本身
      const lineText = (src.split("\n")[callLine - 1] || "").trim();
      return !(lineText.startsWith("*") || lineText.startsWith("/*") || lineText.startsWith("//"));  // 排除注释行
    })
    .filter((m) => !/\bh\s*\(\s*$/.test(src.slice(Math.max(0, m.index - 10), m.index)));
  if (calls.length > 0) risky.push({ name, lines: calls.map((m) => src.slice(0, m.index).split("\n").length) });
}

// —— 检查 2：匿名 IIFE 含 Hook ——
// 找所有 "(function" 起点，括号配对取函数体，确认尾部是 "})()"（IIFE 特征）
let pos = 0;
while (true) {
  const at = src.indexOf("(function", pos);
  if (at === -1) break;
  pos = at + 1;
  // 括号配对找函数体结束
  let d = 0, k = src.indexOf("{", at), bodyEnd = -1, started = false;
  for (; k < src.length; k++) {
    if (src[k] === "{") { d++; started = true; }
    else if (src[k] === "}") { d--; if (started && d === 0) { bodyEnd = k; break; } }
  }
  if (bodyEnd === -1) continue;
  // 尾部必须是 "})()" —— 区别于 .catch(function(){...}) 这类回调
  const tail = src.slice(bodyEnd + 1, bodyEnd + 6).replace(/\s/g, "");
  if (tail !== "})()") continue;
  const body = src.slice(at, bodyEnd);
  if (/react\.use(State|Effect|Callback|Ref|Memo)/.test(body)) {
    risky.push({ name: "(anonymous IIFE with Hook)", lines: [src.slice(0, at).split("\n").length] });
  }
}

if (risky.length === 0) {
  console.log("OK Hooks check passed (no Hook-containing function called directly, no Hook IIFE)");
  process.exit(0);
}
console.error("FOUND " + risky.length + " violation(s):");
for (const r of risky) {
  console.error("  " + r.name + " at line(s) " + r.lines.join(","));
  console.error("    -> contains useState/useEffect/...; must be h(Name, props) or extracted to named component");
}
process.exit(1);
