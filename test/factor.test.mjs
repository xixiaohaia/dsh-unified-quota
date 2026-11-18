/** 倍率解析测试（覆盖 7.6.2 的 free 识别 bug） */
import { test, eq, ok, summary } from "./runner.mjs";
import { priceFactorFromName, usableFactor } from "../lib/meter/credits.js";

console.log("\n# 倍率解析");

test("免费模型：中文", () => eq(priceFactorFromName("免费模型"), 0));
test("免费模型：-free 后缀", () => eq(priceFactorFromName("hy4flash-free"), 0));
test("免费模型：hy4free（词尾）", () => eq(priceFactorFromName("hy4free"), 0));
test("免费模型：Free 大写", () => eq(priceFactorFromName("Qwen-Flash-Free"), 0));
test("正常倍率：x0.11", () => eq(priceFactorFromName("deepseek-v4.1-flash · x0.11"), 0.11));
test("正常倍率：x0.18", () => eq(priceFactorFromName("deepseek-v4.1-flash · x0.18"), 0.18));
test("无倍率：返回 Infinity", () => ok(!Number.isFinite(priceFactorFromName("qfmodel"))));
test("回归：Spark X2.5 不能被误判为免费", () => ok(!Number.isFinite(priceFactorFromName("Spark X2.5"))));
test("usableFactor(0) = true（免费是合法值）", () => eq(usableFactor(0), true));
test("usableFactor(Infinity) = false", () => eq(usableFactor(Infinity), false));
test("usableFactor(0.11) = true", () => eq(usableFactor(0.11), true));

summary();
