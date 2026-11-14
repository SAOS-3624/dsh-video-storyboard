/**
 * probe-cli.test.mjs —— `dsh-video-probe` 这个薄壳的守门测试。
 *
 * 为什么要有：probe 的价值全在"便宜且不崩"。它挂在脚本/Pipeline 的第一步，
 * 一旦在错误输入上吐一坨栈或者退出码还是 0，上游就会拿着空信息继续跑全片扫描。
 * 这里只钉三件事，**不碰 ffmpeg**（快、跨平台都能跑）：
 *   1. package.json 里确实注册了这个 bin，且文件在
 *   2. 没给输入 → 退出 1 + 有用法提示
 *   3. 文件不存在 → 退出 1 + 一句人话，不是裸栈
 * 真读文件的 happy path 由 test/binaries.test.mjs 那类环境测试覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'probe.mjs');

/** 跑一次 CLI，把 stdout/stderr/退出码一起拿回来（不抛）。 */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd: ROOT, timeout: 20000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('probe: package.json 里注册了 dsh-video-probe，且文件存在', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['dsh-video-probe'], './bin/probe.mjs');
  assert.ok(existsSync(path.join(ROOT, pkg.bin['dsh-video-probe'])));
});

test('probe: 不给输入 → 退出 1，并给出用法', async () => {
  const r = await cli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /用法:/);
});

test('probe: 文件不存在 → 退出 1，报错是人话不是裸栈', async () => {
  const r = await cli(['这个文件不存在.mp4']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /probe 失败/);
  assert.match(r.stderr, /ffmpeg/);          // 指路了，不是只说一句"失败了"
  assert.doesNotMatch(r.stderr, /^\s+at\s/m); // 没有 stack trace
});

test('probe: 不认识的开关要当场喊出来（0.6 起的约定）', async () => {
  const r = await cli(['不存在.mp4', '--frames', '9']);
  assert.match(r.stderr, /未识别的参数：--frames/);
});
