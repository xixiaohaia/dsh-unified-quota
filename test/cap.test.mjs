/** 限流检测测试（覆盖 7.3.0 的四级判定） */
import { test, eq, ok, summary } from "./runner.mjs";
import { __test__ } from "../lib/index.js";

const { parseJetHubCap } = __test__;
const NOW = Date.parse("2026-11-17T12:00:00+08:00");

console.log("\n# 限流检测（四级判定）");

// ① 业务码优先
test("业务码 14018 → hard-credit", () => {
  const r = parseJetHubCap("error code 14018", NOW);
  eq(r && r.kind, "hard-credit");
});
test("业务码 6004 → model-quota", () => {
  const r = parseJetHubCap("错误 6004 用量超限", NOW);
  eq(r && r.kind, "model-quota");
});

// ② HTTP 状态码
test("402 → hard-credit", () => {
  const r = parseJetHubCap("payment required", NOW, 402);
  eq(r && r.kind, "hard-credit");
});
test("429 → rate", () => {
  const r = parseJetHubCap("too many requests", NOW, 429);
  eq(r && r.kind, "rate");
});

// ③ DSH 英文模式
test("insufficient quota → quota", () => {
  const r = parseJetHubCap("insufficient quota", NOW);
  eq(r && r.kind, "quota");
});
test("out of credits → quota", () => {
  const r = parseJetHubCap("out of credits", NOW);
  eq(r && r.kind, "quota");
});

// ④ 中文文案
test("所有账号均受限 → rate", () => {
  const r = parseJetHubCap("buddy: 模型 hy4flash-free 所有账号均受限，请稍后再试", NOW);
  eq(r && r.kind, "rate");
  eq(r.model, "hy4flash-free");
});
test("配额使用上限 → quota", () => {
  const r = parseJetHubCap("您已达到配额使用上限，请升级订阅计划", NOW);
  eq(r && r.kind, "quota");
});
test("额度不够 → quota", () => {
  const r = parseJetHubCap("额度不够，需要重新订阅", NOW);
  eq(r && r.kind, "quota");
});

// 解禁时间提取
test("提取 YYYY/M/D H:m:s", () => {
  const r = parseJetHubCap("CodeBuddy (腾讯)：模型 deepseek-v4.1-flash 的可用账号均在限流中，最近一个将于 2026/11/17 15:43:21 解禁", NOW);
  ok(r && r.until > NOW, "应解析出未来时间");
});
test("提取 ISO 时间", () => {
  const r = parseJetHubCap("模型 glm-5.3 限流中，将于 2026-11-18 04:00 重置", NOW);
  ok(r && r.until > NOW, "应解析出未来时间，实际 " + JSON.stringify(r));
});

// 正常文本不应误判
test("正常文本 → null", () => {
  eq(parseJetHubCap("模型 deepseek-v4.1-flash 运行正常，今日已用 10000 token", NOW), null);
});
test("空字符串 → null", () => {
  eq(parseJetHubCap("", NOW), null);
});

summary();
