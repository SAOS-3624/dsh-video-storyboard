/**
 * watch-blocking.test.mjs — 两种"等条件"的阻塞（模型侧的节奏靠它掌握）。
 *
 * waitUntil     : 等到播放进度到某个秒数（在下一段之前核对时间）
 * waitForRefill : 等到台词库存低于 refillBelow 段（该去看下一段了）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch/watch-run.js';
import { saveLines } from '../src/watch/watch.js';

const depsWith = (posAt) => ({
  cache: new Map(),
  browserPort: 1,
  autoLaunch: false,
  readBrowser: async () => ({ pos: posAt(), dur: 900, paused: false, ended: false, url: 'file:///a.mp4' }),
  probe: async () => ({ ok: true, sessions: [] }),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'm',
});

test('waitUntil：到点了就返回 reached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blk-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let pos = 100;
    const ticking = setInterval(() => { pos += 8; }, 200);
    const r = await runWatchPass({ input: 'w.mp4', waitUntil: 140, maxWaitSec: 20 }, depsWith(() => pos));
    clearInterval(ticking);
    assert.equal(r.reason, 'reached');
    assert.ok(r.at >= 140, `应到位，实得 ${r.at}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('waitForRefill：库存不足立刻返回，并指出缺哪段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blk2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass(
      { input: 'r.mp4', waitForRefill: true, refillBelow: 2, segment: 60, maxWaitSec: 10 },
      depsWith(() => 70),
    );
    assert.equal(r.reason, 'refill-needed', '没词时应该马上说缺');
    // pos=70 → 当前段 01:00–02:00，往后两段是 02:00–03:00 与 03:00–04:00
    assert.match(r.text, /02:00–03:00/);
    assert.match(r.text, /03:00–04:00/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('waitForRefill：库存够就一直等，等到封顶才返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blk3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const input = 'ok.mp4';
    // 60/120/180 三段都写满 → 库存够
    await saveLines(input, [
      { from: 60, text: 'a' }, { from: 120, text: 'b' }, { from: 180, text: 'c' },
    ]);
    const t0 = Date.now();
    const r = await runWatchPass(
      { input, waitForRefill: true, refillBelow: 2, segment: 60, maxWaitSec: 6 },
      depsWith(() => 70),
    );
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.reason, 'wait-timeout');
    assert.ok(sec >= 5, `应该真的等了一会儿，实得 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
