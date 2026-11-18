/** 模型名匹配与命中率反推测试（覆盖 7.11.9 的严格匹配） */
import { test, eq, ok, close, summary } from "./runner.mjs";
import { __test__ } from "../lib/index.js";

const { cacheHitRateByModel } = __test__;

/** 构造一个最小账本 */
function ledger(rows) {
  return { days: { "2026-11-17": { byProviderModel: rows } } };
}

console.log("\n# 模型名匹配");

test("完全相同 → 合并", () => {
  const l = ledger({ "trae:glm-5.3": { input: 100000, cacheRead: 900000 } });
  const r = cacheHitRateByModel(l, "glm-5.3");
  ok(r !== null, "应匹配");
  close(r.rate, 0.9, 0.01);
});

test("回归 7.11.9：glm-5.3 与 glm-5.3-flash 是不同模型", () => {
  const l = ledger({
    "trae:glm-5.3-flash": { input: 500000, cacheRead: 500000 },
  });
  eq(cacheHitRateByModel(l, "glm-5.3"), null, "不应匹配 -flash 变体");
});

test("版本后缀 -1017 → 应合并", () => {
  const l = ledger({ "codearts:deepseek-v4.1-flash-1017": { input: 100000, cacheRead: 900000 } });
  const r = cacheHitRateByModel(l, "deepseek-v4.1-flash");
  ok(r !== null, "应匹配版本后缀");
});

test("_ 与 . 等价", () => {
  const l = ledger({ "x:deepseek-v4_1-flash": { input: 100000, cacheRead: 900000 } });
  const r = cacheHitRateByModel(l, "deepseek-v4.1-flash");
  ok(r !== null, "应匹配");
});

test("qmodel 与 qfmodel 不匹配", () => {
  const l = ledger({ "qodercn:qfmodel": { input: 100000, cacheRead: 900000 } });
  eq(cacheHitRateByModel(l, "qmodel"), null);
});

console.log("\n# 命中率计算");

test("排除 free 模型", () => {
  const l = ledger({ "buddy:hy4flash-free": { input: 100000, cacheRead: 900000 } });
  eq(cacheHitRateByModel(l, "hy4flash-free"), null, "free 模型应排除");
});

test("样本太小不计入（<10000）", () => {
  const l = ledger({ "x:toolarge": { input: 100, cacheRead: 900 } });
  eq(cacheHitRateByModel(l, "toolarge"), null);
});

test("跨渠道合并同模型", () => {
  const l = ledger({
    "trae:glm-5.3": { input: 100000, cacheRead: 900000 },
    "buddy:glm-5.3": { input: 400000, cacheRead: 100000 },
  });
  const r = cacheHitRateByModel(l, "glm-5.3");
  ok(r !== null);
  close(r.rate, (900000 + 100000) / (1000000 + 500000), 0.01);
});

test("空账本 → null", () => {
  eq(cacheHitRateByModel({ days: {} }, "glm-5.3"), null);
});

test("空模型名 → null", () => {
  eq(cacheHitRateByModel(ledger({}), ""), null);
});

summary();
