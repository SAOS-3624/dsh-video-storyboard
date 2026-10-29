/**
 * watch-wait.test.mjs — 阻塞等待模式（wait: true）。
 *
 * 用户的思路：与其"结束这轮、等定时器叫醒"，不如让这次调用一直挂着，
 * 像等 npm 上传结果那样 —— 到点了工具自己返回，对话根本没断。
 * 这条路径**不依赖 sessionController.prompt**，所以是唤醒机制不通时的兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';

const deps = (posAt) => ({
  cache: new Map(),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'm',
  probe: async () => ({ ok: true, sessions: [] }),
  browserPort: 1,                       // 只有给了端口才会读浏览器（假端口，不会真起浏览器）
  autoLaunch: false,                    // 测试里绝不能真去 spawn 一个 Edge
  readBrowser: async () => ({ pos: posAt(), dur: 600, paused: false, url: 'file:///a.mp4' }),
});

test('wait: true 会一直等到交付点再返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let pos = 100;                      // 段 0–120、lead 15 → 105 就该说
    const ticking = setInterval(() => { pos += 1; }, 200);   // 模拟播放推进
    const t0 = Date.now();
    const r = await runWatchPass({ input: 'a.mp4', wait: true, maxWaitSec: 20, segment: 120, lead: 15 }, deps(() => pos));
    clearInterval(ticking);
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.ok, true);
    assert.equal(r.speaking, true, '到点后应该交付');
    assert.ok(r.images.length === 1, '应带回一张图');
    assert.ok(sec < 20, `应在封顶之内返回，实得 ${sec}s`);
    assert.match(r.text, /waited \d+s/, '要说明自己等了多久');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('暂停时不要干等（让用户能说话）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const d = { ...deps(() => 100), readBrowser: async () => ({ pos: 100, dur: 600, paused: true, url: 'file:///a.mp4' }) };
    const t0 = Date.now();
    const r = await runWatchPass({ input: 'a.mp4', wait: true, maxWaitSec: 30, segment: 120, lead: 15 }, d);
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.speaking, false, '暂停时不该交付');
    assert.ok(sec < 10, `不该等满封顶，实得 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wait 默认关闭：不传就立刻返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const t0 = Date.now();
    const r = await runWatchPass({ input: 'a.mp4', cursor: 100, segment: 120, lead: 15 }, deps(() => 100));
    assert.equal(r.speaking, false);
    assert.ok((Date.now() - t0) / 1000 < 5);
    assert.doesNotMatch(r.text, /waited/, '没等待就不该有 waited');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('waitForVideo: 一直没视频就超时返回，并说清等了多少秒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waitv-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const d = {
      ...deps(() => 0),
      probe: async () => ({ ok: true, sessions: [] }),
      readBrowser: async () => null,
    };
    const t0 = Date.now();
    const r = await runWatchPass({ waitForVideo: true, maxWaitSec: 5 }, d);
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-video-timeout');
    assert.ok(r.waitedSec >= 4, `应至少等了 4 秒，实得 ${r.waitedSec}`);
    assert.match(r.text, /waited \d+s/);
    assert.ok(sec >= 4 && sec < 15, `实际耗时 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有 waitForVideo 时立刻返回，不挂住', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waitv2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const d = { ...deps(() => 0), probe: async () => ({ ok: true, sessions: [] }), readBrowser: async () => null };
    const t0 = Date.now();
    const r = await runWatchPass({}, d);
    assert.equal(r.reason, 'no-video');
    assert.ok((Date.now() - t0) / 1000 < 3);
    assert.match(r.text, /waitForVideo/, '要告诉模型可以改成等着');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
