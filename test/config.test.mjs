/** 配置规范化测试（覆盖 7.15.1 的 manualRate 被丢弃 bug） */
import { test, eq, ok, close, summary } from "./runner.mjs";
import { normalizeConfig, defaultConfig } from "../lib/meter/config.js";

console.log("\n# 配置规范化");

test("默认配置有 manualRate = 0", () => {
  const d = defaultConfig();
  eq(d.manualRate, 0);
});

test("回归 7.15.1：manualRate 必须被保留", () => {
  const c = normalizeConfig({ manualRate: 7.1 });
  eq(c.manualRate, 7.1);
});

test("manualRate = 0 表示自动", () => {
  eq(normalizeConfig({ manualRate: 0 }).manualRate, 0);
});

test("manualRate 负数 → 0", () => {
  eq(normalizeConfig({ manualRate: -5 }).manualRate, 0);
});

test("manualRate 超上限 → 截断到 1000", () => {
  eq(normalizeConfig({ manualRate: 99999 }).manualRate, 1000);
});

test("manualRate NaN → 0", () => {
  eq(normalizeConfig({ manualRate: "abc" }).manualRate, 0);
});

test("currency 白名单", () => {
  eq(normalizeConfig({ currency: "CNY" }).currency, "CNY");
  eq(normalizeConfig({ currency: "USD" }).currency, "USD");
  eq(normalizeConfig({ currency: "XYZ" }).currency, "CNY");
});

test("decimals 范围 0-8", () => {
  eq(normalizeConfig({ decimals: 2 }).decimals, 2);
  eq(normalizeConfig({ decimals: 99 }).decimals, 8);
  eq(normalizeConfig({ decimals: -1 }).decimals, 0);
});

test("exchangeRate 范围", () => {
  close(normalizeConfig({ exchangeRate: 7.1 }).exchangeRate, 7.1);
  ok(normalizeConfig({ exchangeRate: 0 }).exchangeRate >= 0.01);
});

test("customPrices 过滤无效条目", () => {
  const c = normalizeConfig({ customPrices: { m1: { cacheHit: 1, cacheMiss: 2, output: 3 }, m2: { cacheHit: 0, cacheMiss: 0, output: 0 } } });
  ok(c.customPrices.m1, "有效条目应保留");
  ok(!c.customPrices.m2, "全 0 条目应丢弃");
});

test("空输入不崩溃", () => {
  const c = normalizeConfig({});
  ok(c.currency);
});

test("null 输入不崩溃", () => {
  const c = normalizeConfig(null);
  ok(c.currency);
});

summary();
