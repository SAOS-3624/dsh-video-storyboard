/**
 * batches.test.mjs — 变速批次（开头短、逐段加长、最后稳定）。
 *
 * 为什么值得单独测：批次边界是"它说的是哪一段"和"它建的是哪一段"的唯一共识。
 * 这张表错了，用户会看到"说 04:00 开始、讲的却是 03:00 的内容"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RAMP, describePlan, makePlan } from '../src/batches.js';

test('默认阶梯：1 → 2 → 3 → 4 分钟，之后稳定 5 分钟', () => {
  const p = makePlan({});
  assert.deepEqual(DEFAULT_RAMP, [60, 120, 180, 240]);
  assert.equal(p.sizeAt(0), 60);
  assert.equal(p.sizeAt(1), 120);
  assert.equal(p.sizeAt(2), 180);
  assert.equal(p.sizeAt(3), 240);
  assert.equal(p.sizeAt(4), 300, '第 5 段起稳定 5 分钟');
  assert.equal(p.sizeAt(99), 300);
});

test('边界是累加的：60, 180, 360, 600, 900…', () => {
  const p = makePlan({});
  assert.equal(p.segmentAt(0).from, 0);
  assert.equal(p.segmentAt(30).to, 60);
  assert.equal(p.segmentAt(30).index, 0);
  assert.equal(p.segmentAt(60).index, 1, '第 60 秒进入第 2 段');
  assert.equal(p.segmentAt(60).to, 180);
  assert.equal(p.segmentAt(700).index, 4);
  assert.equal(p.segmentAt(700).from, 600);
});

test('ramp 为空就全程等长（库默认行为不变）', () => {
  const p = makePlan({ segment: 120, ramp: null });
  assert.equal(p.sizeAt(0), 120);
  assert.equal(p.sizeAt(3), 120);
  assert.equal(p.segmentAt(125).from, 120);
  assert.equal(p.segmentAt(125).to, 240);
});

test('from(index, count) 给的是连续段，且 sayAt = 段末 - 15', () => {
  const p = makePlan({});
  const segs = p.from(0, 3);
  assert.deepEqual(segs.map((s) => [s.from, s.to, s.size]), [[0, 60, 60], [60, 180, 120], [180, 360, 180]]);
  assert.equal(segs[0].sayAt, 45);
  assert.equal(segs[2].sayAt, 345);
});

test('describePlan 能人读', () => {
  assert.equal(describePlan(makePlan({})), '1m → 2m → 3m → 4m → 5m（之后固定）');
  assert.equal(describePlan(makePlan({ segment: 120, ramp: null })), '2m');
});

test('起步阶段标记：前 4 段算"加长中"', () => {
  const p = makePlan({});
  assert.equal(p.isRamping(0), true);
  assert.equal(p.isRamping(3), true);
  assert.equal(p.isRamping(4), false);
});
