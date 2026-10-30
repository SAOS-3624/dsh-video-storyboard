/**
 * speech.test.mjs — 台词后延。
 *
 * 用户的原话："有时候话还没说完就开始报台词了"。
 * 原因是 `at` 对齐字幕的 `from`，而 `from` 是这句话**开始说**的时刻。
 * 这一组守卫：按字数延、夹到区间内、拿不到字幕就不延、延迟后迟到仍然作废。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lagForAt, lineNear, makeLagFn, speechLag } from '../src/watch/speech.js';
import { dueLine, saveLines } from '../src/watch/watch.js';
import { forgetSegments, rememberSegments } from '../src/storyboard/locate.js';

test('speechLag: 按字数递增，夹在 0.4–2.0 秒', () => {
  assert.equal(speechLag(0), 0, '没有字数信息就不延');
  assert.equal(+speechLag(1).toFixed(2), 0.4);
  assert.equal(+speechLag(3).toFixed(2), 0.6);
  assert.equal(+speechLag(7).toFixed(2), 1.0);
  assert.equal(+speechLag(13).toFixed(2), 1.6);
  assert.equal(speechLag(21), 2.0);
  assert.equal(speechLag(80), 2.0, '再长也不该拖到 2 秒以上');
});

test('lineNear: 4 秒内算同一句，超过就认为 at 落在空档里', () => {
  const segs = [{ from: 100, to: 102, text: '七八个字' }];
  assert.equal(lineNear(segs, 100)?.text, '七八个字');
  assert.equal(lineNear(segs, 103.9)?.text, '七八个字');
  assert.equal(lineNear(segs, 105), null);
  assert.equal(lineNear([], 100), null);
  assert.equal(lineNear(null, 100), null);
});

test('lagForAt: 没有字幕就退化成不延迟', () => {
  assert.equal(lagForAt([], 100), 0);
  assert.equal(lagForAt(null, 100), 0);
  assert.equal(lagForAt([{ from: 100, to: 102, text: '' }], 100), 0, '空句子不延');
});

test('makeLagFn: 同一个 at 只算一次', () => {
  const segs = [{ from: 100, to: 104, text: '结果发现他住的地址离学校有两个小时路程' }];
  const lagOf = makeLagFn(segs);
  assert.equal(lagOf(100), 2, '21 字 → 2.0');
  assert.equal(lagOf(100.04), 2, '四舍五入到 0.1 秒粒度，仍命中缓存');
  assert.equal(lagOf(200), 0, '远处没有字幕');
});

test('dueLine: 句子刚开始不开口，延到"说了大约一半"才念', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lag-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    // 21 字 → +2.0 秒
    rememberSegments('lag.mp4', [{
      from: 150, to: 154, text: '结果发现他住的地址离学校有两个小时路程',
    }]);
    await saveLines('lag.mp4', [{ from: 120, at: 150, text: '说这句' }]);

    assert.equal(await dueLine('lag.mp4', 150, { size: 60 }), null, '原句才开口，这时插话就是抢话');
    assert.equal(await dueLine('lag.mp4', 151.5, { size: 60 }), null, '还差半秒');
    assert.equal(await dueLine('lag.mp4', 152, { size: 60 }), '说这句', '到点就该说了');
  } finally {
    forgetSegments();
    await rm(dir, { recursive: true, force: true });
  }
});

test('dueLine: 延迟之后仍然算迟到作废（不能因为加了延就复活旧词）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lag2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    rememberSegments('lag2.mp4', [{
      from: 150, to: 154, text: '结果发现他住的地址离学校有两个小时路程',
    }]);
    await saveLines('lag2.mp4', [{ from: 120, at: 150, text: '晚太多了' }]);
    // 开口时刻 152，lateSec 3 → 155 之后算迟到
    assert.equal(await dueLine('lag2.mp4', 154, { size: 60 }), '晚太多了');
    assert.equal(await dueLine('lag2.mp4', 160, { size: 60 }), null);
  } finally {
    forgetSegments();
    await rm(dir, { recursive: true, force: true });
  }
});
