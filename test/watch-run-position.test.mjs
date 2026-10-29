/**
 * watch-run-position.test.mjs — 工具层怎么对待"读到的位置"。
 *
 * 真机事故：SMTC 的 Position 冻结 155 秒，插件把它当实时值，于是连续 20 分钟 `not yet`。
 * 这里锁三条分支：新鲜就用、旧了就标"推算"、太旧就**承认读不到并要求 cursor**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';

const makeDeps = (sessions, { dir } = {}) => ({
  cache: new Map(),
  saveImage: async () => Buffer.from('x'),
  // 分镜这里不用真跑：这三条分支都在建段之前就返回了
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'manifest',
  probe: async () => ({ ok: true, sessions }),
});

const mm = (s) => Math.round(s * 1000);

test('新鲜刷新（≤10s）：直接用，标 fresh', async () => {
  const env = { DSH_VIDEO_CACHE_DIR: await mkdtemp(join(tmpdir(), 'wr1-')) };
  process.env.DSH_VIDEO_CACHE_DIR = env.DSH_VIDEO_CACHE_DIR;
  try {
    const now = Date.now();
    const deps = makeDeps([{
      app: 'MSEdge', status: 4, pos: 233, dur: 1087, title: 'x', updated: now - 2000,
    }]);
    const r = await runWatchPass({ input: 'a.mp4' }, deps);
    assert.equal(r.confidence, 'fresh');
    assert.equal(r.status, 'playing');
    assert.ok(Math.abs(r.cursor - 233) < 0.5, `应等于 233，实得 ${r.cursor}`);
  } finally {
    await rm(env.DSH_VIDEO_CACHE_DIR, { recursive: true, force: true });
  }
});

test('刷新 20 秒前：按墙钟推算，并在文案里说明是推算的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const now = Date.now();
    const deps = makeDeps([{
      app: 'MSEdge', status: 4, pos: 233, dur: 1087, title: 'x', updated: now - 20_000,
    }]);
    const r = await runWatchPass({ input: 'a.mp4' }, deps);
    assert.equal(r.confidence, 'extrapolated');
    assert.ok(r.cursor > 240, `应推过 240，实得 ${r.cursor}`);
    assert.match(r.text, /measured \d+s ago/, '要告诉调用方这是多久以前的值');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('刷新太久（>45s）：拒绝猜，要求 cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const now = Date.now();
    const deps = makeDeps([{
      app: 'MSEdge', status: 4, pos: 1.1, dur: 1087, title: 'x', updated: now - 155_000,
    }]);
    const r = await runWatchPass({ input: 'a.mp4' }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.confidence, 'unknown');
    assert.match(r.text, /unreadable|last updated 155s ago/);
    assert.match(r.text, /cursor/, '要给出路：让调用方传 cursor');
    assert.equal(r.images.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('显式 cursor 优先，不读 SMTC（SMTC 冻结时的唯一出路）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wr4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    let probed = 0;
    const deps = {
      ...makeDeps([]),
      probe: async () => { probed += 1; return { ok: true, sessions: [] }; },
    };
    const r = await runWatchPass({ input: 'a.mp4', cursor: '12:30' }, deps);
    assert.equal(r.confidence, 'given');
    assert.equal(r.cursor, 750);
    assert.ok(r.ok, '给了 cursor 就该继续出段，而不是抱怨读不到');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
