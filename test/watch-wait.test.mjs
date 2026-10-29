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

test('没交付的那次调用不许把这一段记成"已交付"（否则会迟到一段）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait-dedup-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 第一次：位置 100、段 0–120、lead 15 → 要到 105 才该说；封顶 3 秒、播放头不动 → not yet
    const r1 = await runWatchPass(
      { input: 'a.mp4', wait: true, maxWaitSec: 3, segment: 120, lead: 15 },
      deps(() => 100),
    );
    assert.equal(r1.speaking, false, '没到点就不该交付');

    // 第二次：从 100 起等着，播放头走到 105 之后就该交付。
    // 修之前，第一次的 not-yet 已经把 lastDelivered 写成 0，等待循环里的去重判断
    // 会把这一次的交付挡掉，一直挂到封顶才回 not yet。
    let pos = 100;
    const tick = setInterval(() => { pos += 0.8; }, 500);
    let r2;
    try {
      r2 = await runWatchPass(
        { input: 'a.mp4', wait: true, maxWaitSec: 15, segment: 120, lead: 15 },
        deps(() => pos),
      );
    } finally {
      clearInterval(tick);
    }
    assert.equal(r2.speaking, true, '等到交付点就该交，不能被上一次的 not-yet 记账挡掉');
    assert.ok(r2.images.length === 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('已交付的段再 wait：立刻回来说"给过了"，不挂到封顶', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait-again-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 先在 106 把第 0 段交出去
    const first = await runWatchPass({ input: 'a.mp4', cursor: 106, segment: 120, lead: 15 }, deps(() => 106));
    assert.equal(first.speaking, true);

    // 再从头等到交付点：不该重复交付，也不该把会话挂满 30 秒
    let pos = 100;
    const tick = setInterval(() => { pos += 0.8; }, 500);
    const t0 = Date.now();
    let r;
    try {
      r = await runWatchPass(
        { input: 'a.mp4', wait: true, maxWaitSec: 30, segment: 120, lead: 15 },
        deps(() => pos),
      );
    } finally {
      clearInterval(tick);
    }
    const sec = (Date.now() - t0) / 1000;
    assert.equal(r.speaking, false);
    assert.match(r.text, /already delivered/);
    assert.ok(sec < 20, `不该挂到封顶，实得 ${sec}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同一段交付过之后，再调用不重复交付', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wait-once-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const args = { input: 'a.mp4', cursor: 106, segment: 120, lead: 15 };
    const r1 = await runWatchPass({ ...args }, deps(() => 106));
    assert.equal(r1.speaking, true);
    const r2 = await runWatchPass({ ...args }, deps(() => 106));
    assert.equal(r2.speaking, false, '同一段不该说两遍');
    assert.match(r2.text, /already spoke/);
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
