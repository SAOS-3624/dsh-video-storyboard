/**
 * timer.test.mjs — 该不该叫醒会话。
 *
 * 这个判定错一次的代价很具体：早叫 = 抢在用户看完之前剧透；晚叫 = 这段永远不说；
 * 重复叫 = 同一段说两遍。所以下面每条都是"错法"的守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dueDecision, startTicker } from '../src/timer.js';

const segs = [
  { from: 0, to: 120 }, { from: 120, to: 240 },
];

test('没到点不叫', () => {
  const d = dueDecision({ cursor: 60, measuredAt: 1000, now: 1000, segments: segs, lead: 15 });
  assert.equal(d.wake, false);
  assert.equal(d.why, 'not-due');
});

test('进交付区就叫，并给出是哪一段', () => {
  const d = dueDecision({ cursor: 105, measuredAt: 1000, now: 1000, segments: segs, lead: 15 });
  assert.equal(d.wake, true);
  assert.equal(d.segment, 0);
  assert.equal(d.sayAt, 105);
});

test('位置是测量值：时间在走，要外推', () => {
  // 10 秒前测到 95 秒，现在应该算 105 → 到点
  const d = dueDecision({ cursor: 95, measuredAt: 0, now: 10_000, segments: segs, lead: 15 });
  assert.equal(d.wake, true);
  assert.ok(d.pos >= 105);
});

test('外推有上限：测量太旧就不能瞎推', () => {
  const d = dueDecision({ cursor: 0, measuredAt: 0, now: 600_000, segments: segs, lead: 15 });
  assert.equal(d.wake, false, '10 分钟前的测量值不能外推成"看到 600 秒"');
});

test('说过的段不重复叫', () => {
  const d = dueDecision({ cursor: 110, measuredAt: 1000, now: 1000, segments: segs, spoken: [0], lead: 15 });
  assert.equal(d.wake, false);
});

test('早就过去的段不补说（跳转/长时间没唤醒）', () => {
  const d = dueDecision({ cursor: 400, measuredAt: 1000, now: 1000, segments: segs, lead: 15 });
  assert.equal(d.wake, false, '用户已经看到 400 秒，不该回头补第 0 段');
});

test('暂停太久就闭嘴', () => {
  const d = dueDecision({
    cursor: 110, measuredAt: 1000, now: 1000, segments: segs, pausedMs: 200_000, pauseGraceMs: 180_000,
  });
  assert.equal(d.wake, false);
  assert.equal(d.why, 'paused-too-long');
});

test('pause 中的外推要停（暂停时位置不动）', () => {
  const d = dueDecision({ cursor: 100, measuredAt: 0, now: 60_000, segments: segs, pausedMs: 0, lead: 15 });
  assert.equal(d.wake, false, '暂停但不外推：100 秒还没到 105');
});

test('startTicker: 会跑、能停、不叠车', async () => {
  let n = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const t = startTicker({
    everyMs: 5,
    tick: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  t.dispose();
  const after = n;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(after >= 1, '应该跑过');
  assert.equal(n, after, 'dispose 之后不该再跑');
  assert.equal(maxConcurrent, 1, '上一轮没跑完时不能叠上去');
});
