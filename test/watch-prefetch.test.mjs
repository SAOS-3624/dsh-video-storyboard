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

test('跑完一段会顺手把下一段建好（不阻塞返回）', async () => {
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
    const r1 = await runWatchPass({ input: 'a.mp4', cursor: 10, segment: 120 }, {
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

test('prefetch: false 时不多建（省 CPU 的开关）', async () => {
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
    await runWatchPass({ input: 'b.mp4', cursor: 10, segment: 120, prefetch: false }, deps);
    await settle();
    assert.deepEqual(built, [0], '关掉预取就只建当前段');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二段到点时是缓存命中（这一条守住"到点秒回"）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prefetch3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let builds = 0;
    const cache = new Map();
    const deps = {
      cache,
      saveImage: async () => Buffer.from('x'),
      runStoryboard: async () => { builds += 1; return { sheets: [{ png: Buffer.from('x'), cells: [] }] }; },
      formatManifest: () => 'm',
      probe: async () => ({ ok: true, sessions: [] }),
    };
    const p = (cursor) => ({
      ...deps,
      probe: async () => ({ ok: true, sessions: [
        { app: 'x', status: 4, pos: cursor, dur: 1087, title: 'c', updated: Date.now() },
      ] }),
    });

    await runWatchPass({ input: 'c.mp4', cursor: 10, segment: 120 }, p(10));
    await settle();                      // 预取完成
    const before = builds;
    const r2 = await runWatchPass({ input: 'c.mp4', cursor: 125, segment: 120 }, p(125));
    assert.equal(builds, before, '第二段不该再建一次');
    assert.match(r2.text, /ready/, '应该标成 ready（命中缓存）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
