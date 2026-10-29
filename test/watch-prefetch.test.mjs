/**
 * watch-prefetch.test.mjs — 预取下一段。
 *
 * 用户的抱怨是"回复晚了十秒"，而那十秒里大部分是"到点才去建这一段"。
 * 提前一段建好，到点时那次调用就是命中缓存。
 * 真机 e2e 实测：第一段 10.6s，之后 0.0s（ready）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';

const settle = () => new Promise((r) => setTimeout(r, 30));

/** 等到后台预取真的停下来（builds 连续两次采样不变），避免全量跑时抢 CPU 导致抖动 */
const settleBuilds = async (get) => {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    if (get() === last) return;
    last = get();
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('显式 prefetch: true 时，抛完当前段会顺手建下一段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const built = [];
    const cache = new Map();
    const deps = {
      cache,
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async ({ from }) => {
        built.push(from);
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
    };

    const now = Date.now();
    // 第 0 段：应该建 0；随后后台预取 120
    const r1 = await runWatchPass({ input: 'a.mp4', cursor: 10, segment: 120, prefetch: true }, {
      ...deps, probe: async () => ({ ok: true, sessions: [
        { app: 'x', status: 4, pos: 10, dur: 1087, title: 'a', updated: now },
      ] }),
    });
    assert.equal(r1.ok, true);
    assert.equal(built[0], 0, '第 0 段必须先建（本次结果靠它）');
    await settle();
    assert.ok(built.includes(120), `后台应预取下一段，实际建了 ${built.join(',')}`);
    assert.ok(cache.has('a.mp4|120'), '预取的段要进缓存，否则到点还得再建一次');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('默认就把 lookahead 窗口备好，不只是当前段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const built = [];
    const deps = {
      cache: new Map(),
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async ({ from }) => { built.push(from); return { sheets: [{ png: Buffer.from('x'), cells: [] }] }; },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
    };
    await runWatchPass({ input: 'b.mp4', cursor: 10, segment: 120 }, deps);
    await settle();
    assert.equal(built[0], 0, '当前段必须先建');
    assert.ok(built.length >= 3, `默认应把 5 分钟余量里的段都备好，实际只建了 ${built.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prefetch: false 才真的只建当前段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch2b-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const built = [];
    const deps = {
      cache: new Map(),
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async ({ from }) => { built.push(from); return { sheets: [{ png: Buffer.from('x'), cells: [] }] }; },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
    };
    await runWatchPass({ input: 'b2.mp4', cursor: 10, segment: 120, prefetch: false }, deps);
    await settle();
    assert.deepEqual(built, [0], '显式关掉就只建当前段');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wait 之前先把余量建完（进入阻塞的前提）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch2c-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const built = [];
    const deps = {
      cache: new Map(),
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async ({ from }) => { built.push(from); return { sheets: [{ png: Buffer.from('x'), cells: [] }] }; },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
      browserPort: 1,
      autoLaunch: false,
      readBrowser: async () => ({ pos: 10, dur: 900, paused: false, url: 'file:///b3.mp4' }),
    };
    const r = await runWatchPass({ input: 'b3.mp4', wait: true, maxWaitSec: 5, segment: 120 }, deps);
    assert.equal(r.speaking, false, '没到点不该交付');
    assert.ok(built.length >= 3, `阻塞前应已备好窗口，实际 ${built.join(',')}`);
    assert.match(r.text, /\[buffer\]/, '要告诉模型余量覆盖到哪');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二段到点时是缓存命中（这一条守住"到点秒回"）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let builds = 0;
    const froms = [];
    const cache = new Map();
    const deps = {
      cache,
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async ({ from }) => {
        builds += 1;
        froms.push(Number(from));
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
    };
    const p = (cursor) => ({
      ...deps,
      probe: async () => ({ ok: true, sessions: [
        { app: 'x', status: 4, pos: cursor, dur: 1087, title: 'c', updated: Date.now() },
      ] }),
    });

    await runWatchPass({ input: 'c.mp4', cursor: 10, segment: 120, prefetch: true }, p(10));
    await settleBuilds(() => builds);     // 等后台预取真的停下来
    const before = builds;
    const r2 = await runWatchPass({ input: 'c.mp4', cursor: 125, segment: 120 }, p(125));
    // 只看 120 这一段的次数：后台预取可能在返回途中又建了别的段（那是好事，不算重复）
    assert.equal(froms.filter((f) => f === 120).length, 1, '第二段不该再建一次');
    assert.ok(builds >= before);
    assert.match(r2.text, /ready/, '应该标成 ready（命中缓存）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
