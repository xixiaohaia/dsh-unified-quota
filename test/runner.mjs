/**
 * 极简测试运行器（零依赖）。
 *
 * 用法：node test/run.mjs
 * 输出：TAP 风格，退出码 0 = 全通过。
 */

let passed = 0, failed = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok   " + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log("  FAIL " + name);
    console.log("       " + String((e && e.message) || e));
  }
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ": " : "") + "期望 " + b + "，实际 " + a);
}

export function ok(v, msg) {
  if (!v) throw new Error(msg || "期望为真");
}

export function close(actual, expected, tol, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > (tol || 1e-9)) {
    throw new Error((msg ? msg + ": " : "") + "期望 " + expected + "±" + tol + "，实际 " + actual);
  }
}

export function summary() {
  console.log("");
  console.log("========================================");
  console.log("通过 " + passed + " / " + (passed + failed));
  if (failed > 0) {
    console.log("失败 " + failed + " 项：");
    for (const f of failures) console.log("  - " + f.name + ": " + String((f.error && f.error.message) || f.error));
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓");
  }
  console.log("========================================");
}
