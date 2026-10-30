/**
 * ytdlp-discovery.test.mjs — 找 yt-dlp 的那段，必须"找不到时返回 null"，不能"静默崩掉"。
 *
 * 起因（2026-10-30）：`findPipScript()` 里用了 `readdir()`，但文件顶部只 import 了 `readFile`。
 * `readdir` 是 undefined → 抛 ReferenceError → 被 `catch { continue }` 吞掉 → 函数静默返回 null。
 * 症状：Windows 上 pip 装好的 yt-dlp 一律"找不到"，而 PATH / DSH_YTDLP_PATH 两条路都能用，
 * 所以一直没人往"少了 import"上想。用户报的是"我本地的 dsh 又找不到 yt 了"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findPipScript } from '../src/storyboard/ytdlp.js';

const EXE = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

test('findPipScript: 目录不存在时返回 null，不抛（这是它最常走的那条路）', async () => {
  const out = await findPipScript({ APPDATA: join(tmpdir(), 'definitely-not-here') });
  assert.equal(out, null);
});

test('findPipScript: 扫得到 %APPDATA%/Python/Python3xx/Scripts（win32）', {
  skip: process.platform !== 'win32' ? '只有 Windows 走 APPDATA 这条分支' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ytdlp-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'Python', 'Python313', 'Scripts');
  await mkdir(scripts, { recursive: true });
  const exe = join(scripts, EXE);
  await writeFile(exe, '');

  const out = await findPipScript({ APPDATA: root });
  assert.equal(out, exe, '应该扫到 pip 的 Scripts 目录；返回 null 就说明遍历那步又崩了');
});

test('findPipScript: 有 Python 目录但没有 yt-dlp 时返回 null', {
  skip: process.platform !== 'win32' ? '只有 Windows 走 APPDATA 这条分支' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ytdlp-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Python', 'Python313', 'Scripts'), { recursive: true });

  const out = await findPipScript({ APPDATA: root });
  assert.equal(out, null);
});
