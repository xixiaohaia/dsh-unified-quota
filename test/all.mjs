#!/usr/bin/env node
/**
 * 全量测试入口：node test/all.mjs
 * 任一子测试失败则以非 0 退出。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ["factor.test.mjs", "cap.test.mjs", "config.test.mjs", "cachehit.test.mjs"];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) failed += 1;
}
console.log("");
if (failed > 0) { console.log("✗ " + failed + " 个测试文件失败"); process.exit(1); }
else console.log("✓ 全部测试文件通过");
