#!/usr/bin/env node
/**
 * 版本号同步脚本。
 *
 * 用法：
 *   node scripts/bump.mjs            # 读取 package.json 的 version，同步到其它 3 处
 *   node scripts/bump.mjs 7.8.0      # 先把 package.json 设为 7.8.0，再同步
 *   node scripts/bump.mjs --check    # 只检查是否一致（CI 用），不一致则退出码 1
 *
 * 需要同步的 4 处：
 *   1. lib/index.js        const BUILD = 'x.y.z'
 *   2. lib/client.js       const CLIENT_VERSION = "x.y.z"
 *   3. lib/client.js       const CSS_REV = "uq-x.y.z"
 *   4. package.json        "version": "x.y.z"
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'package.json');
const HOST = join(ROOT, 'lib', 'index.js');
const CLIENT = join(ROOT, 'lib', 'client.js');

const RE_PKG = /("version"\s*:\s*")([^"]+)(")/;
const RE_BUILD = /(const BUILD = ')([^']+)(')/;
const RE_CLIENT = /(const CLIENT_VERSION = ")([^"]+)(")/;
const RE_CSS = /(const CSS_REV = "uq-)([^"]+)(")/;

async function readVersionOf(file, re, label) {
  const text = await readFile(file, 'utf8');
  const m = re.exec(text);
  if (m === null) throw new Error('在 ' + label + ' 里找不到版本号模式');
  return m[2];
}

async function patch(file, re, next, label) {
  const text = await readFile(file, 'utf8');
  if (!re.test(text)) throw new Error('在 ' + label + ' 里找不到版本号模式');
  const out = text.replace(re, (_m, a, _old, c) => a + next + c);
  if (out !== text) await writeFile(file, out, 'utf8');
  return out !== text;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const explicit = args.find((a) => /^\d+\.\d+\.\d+/.test(a));

  if (checkOnly) {
    const versions = {
      'package.json': await readVersionOf(PKG, RE_PKG, 'package.json'),
      'lib/index.js BUILD': await readVersionOf(HOST, RE_BUILD, 'lib/index.js'),
      'lib/client.js CLIENT_VERSION': await readVersionOf(CLIENT, RE_CLIENT, 'lib/client.js'),
      'lib/client.js CSS_REV': await readVersionOf(CLIENT, RE_CSS, 'lib/client.js'),
    };
    const uniq = [...new Set(Object.values(versions))];
    for (const [k, v] of Object.entries(versions)) console.log('  ' + k.padEnd(32) + v);
    if (uniq.length === 1) { console.log('\n✓ 版本一致：' + uniq[0]); return; }
    console.error('\n✗ 版本不一致：' + uniq.join(' / '));
    process.exitCode = 1;
    return;
  }

  let next = explicit;
  if (next === undefined) next = await readVersionOf(PKG, RE_PKG, 'package.json');
  if (!/^\d+\.\d+\.\d+/.test(next)) { console.error('✗ 版本号格式应为 x.y.z，得到：' + next); process.exitCode = 1; return; }

  const results = [
    ['package.json', await patch(PKG, RE_PKG, next, 'package.json')],
    ['lib/index.js BUILD', await patch(HOST, RE_BUILD, next, 'lib/index.js')],
    ['lib/client.js CLIENT_VERSION', await patch(CLIENT, RE_CLIENT, next, 'lib/client.js')],
    ['lib/client.js CSS_REV', await patch(CLIENT, RE_CSS, next, 'lib/client.js')],
  ];
  for (const [label, changed] of results) console.log('  ' + (changed ? '✎' : '=') + ' ' + label);
  console.log('\n✓ 版本已同步为 ' + next);
}

main().catch((error) => { console.error('✗ ' + (error && error.message || error)); process.exitCode = 1; });
