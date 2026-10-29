/**
 * watch-nextline.test.mjs — 逐句模式：一次调用一句，阻塞到点。
 *
 * 用户的要求：不要一口气打印六句（那是脚本），要"到时间说一句、阻塞、再说一句"，
 * 这样每条都出现在会话里，看得出它真的在说话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWatchPass } from '../src/watch-run.js';
import { saveLines } from '../src/watch.js';

const stubDeps = (pos) => ({
  cache: new Map(),
  browserPort: 1,
  autoLaunch: false,
  readBrowser: async () => ({ pos, dur: 900, paused: false, ended: false, url: 'file:///a.mp4' }),
  probe: async () => ({ ok: true, sessions: [] }),
  saveImage: async ({ data }) => data,
  runStoryboard: async () => ({ sheets: [{ png: Buffer.from('x'), cells: [] }] }),
  formatManifest: () => 'm',
});

test('每调用一次只返回一句，而且不复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nl-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const input = 'nl.mp4';
    await saveLines(input, [10, 20, 30].map((t) => ({ from: 60, text: `第 ${t} 秒那句` })));

    const got = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await runWatchPass({ input, nextLine: true, everySec: 3, segment: 60 }, stubDeps(90));
      got.push(r.text);
    }
    assert.equal(got.length, 3);
    assert.match(got[0], /第 10 秒那句/);
    assert.match(got[1], /第 20 秒那句/);
    assert.match(got[2], /第 30 秒那句/);
    assert.notEqual(got[0], got[1], '不能重复说同一句');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二次调用会阻塞到间隔到点（不是立刻返回）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nl2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const input = 'nl2.mp4';
    await saveLines(input, [{ from: 60, text: 'a' }, { from: 60, text: 'b' }]);
    const r1 = await runWatchPass({ input, nextLine: true, everySec: 3, segment: 60 }, stubDeps(90));
    assert.equal(r1.speaking, true);
    const t0 = Date.now();
    const r2 = await runWatchPass({ input, nextLine: true, everySec: 3, segment: 60 }, stubDeps(90));
    const sec = (Date.now() - t0) / 1000;
    assert.ok(sec >= 2.5, `第二次应等满约 3 秒，实得 ${sec}s`);
    assert.equal(r2.text.includes('b'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有台词了就说清楚，并提示下一步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nl3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const r = await runWatchPass({ input: 'none.mp4', nextLine: true, everySec: 3, segment: 60 }, stubDeps(90));
    assert.equal(r.speaking, false);
    assert.equal(r.reason, 'no-line');
    assert.match(r.text, /没有预设台词/);
    assert.match(r.text, /lines:/, '要告诉模型怎么补');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
