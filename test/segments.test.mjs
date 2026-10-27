import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fitSegments, resolveEffectiveMinGap, segDur, segmentsFromCuts, totalDur,
} from '../src/segments.js';

/* ---------------------------------------------------------------- 切点 → 区间 */

test('segmentsFromCuts: 首尾自动补 0 与 duration', () => {
  const segs = segmentsFromCuts(10, [2.5, 4.5]);
  assert.deepEqual(segs, [[0, 2.5], [2.5, 4.5], [4.5, 10]]);
});

test('segmentsFromCuts: 靠近边界的切点被丢掉（闪光误检）', () => {
  const segs = segmentsFromCuts(10, [0.1, 5, 9.95], 0.4);
  assert.deepEqual(segs, [[0, 5], [5, 10]]);
});

test('segmentsFromCuts: 结果始终首尾相接、总时长不变', () => {
  const segs = segmentsFromCuts(27.76, [2.52, 4.52, 7.04, 11.56, 12.76, 14.76, 22.76, 25.76]);
  assert.equal(segs[0][0], 0);
  assert.equal(segs.at(-1)[1], 27.76);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i][0], segs[i - 1][1], `第 ${i} 段没有接上`);
  }
  assert.ok(Math.abs(totalDur(segs) - 27.76) < 1e-6);
});

test('segmentsFromCuts: 无切点时只有一段', () => {
  assert.deepEqual(segmentsFromCuts(8, []), [[0, 8]]);
});

test('segmentsFromCuts: duration 非正抛错', () => {
  assert.throws(() => segmentsFromCuts(0, [1]), RangeError);
});

/* ---------------------------------------------------------------- 调到目标格数 */

test('fitSegments: 段数过多时反复合并最短的一对（微段先被吸收）', () => {
  const segs = [[0, 1], [1, 1.2], [1.2, 5], [5, 9], [9, 15]];
  const out = fitSegments(segs, 3);
  assert.equal(out.length, 3);
  assert.ok(Math.abs(totalDur(out) - 15) < 1e-6, '总时长必须守恒');
  // 0.2s 微段优先被吸收：前两轮都在合并最短的一对，最终并入 [0,5]
  assert.deepEqual(out, [[0, 5], [5, 9], [9, 15]]);
  assert.ok(out.every((s) => segDur(s) >= 1.2), '不应把 6s 的尾段拆碎');
});

test('fitSegments: 段数过少时拆最长段', () => {
  const out = fitSegments([[0, 8]], 4);
  assert.equal(out.length, 4);
  assert.ok(Math.abs(totalDur(out) - 8) < 1e-6);
  for (const s of out) assert.ok(Math.abs(segDur(s) - 2) < 1e-6, '单段应被均分');
});

test('fitSegments: 9 段调到 9 段是恒等变换', () => {
  const segs = Array.from({ length: 9 }, (_, i) => [i, i + 1]);
  assert.deepEqual(fitSegments(segs, 9), segs);
});

test('fitSegments: 结果永远首尾相接（不劈出空隙）', () => {
  for (const k of [1, 2, 3, 5, 7, 9, 12, 16]) {
    const out = fitSegments([[0, 2.5], [2.5, 4.5], [4.5, 7], [7, 27.76]], k);
    for (let i = 1; i < out.length; i++) assert.equal(out[i][0], out[i - 1][1]);
    assert.ok(Math.abs(totalDur(out) - 27.76) < 1e-6);
  }
});

test('fitSegments: 不修改入参', () => {
  const segs = [[0, 1], [1, 2]];
  fitSegments(segs, 1);
  assert.deepEqual(segs, [[0, 1], [1, 2]]);
});

test('fitSegments: 快剪里的碎镜头被并掉（等价于给取帧加最小间隔）', () => {
  // 0.3s / 0.4s 的碎段夹在正常段之间
  const segs = [[0, 0.3], [0.3, 3], [3, 3.4], [3.4, 9], [9, 9.4], [9.4, 15]];
  const out = fitSegments(segs, 6, { minGap: 1.2 });
  assert.equal(out.length, 6, '碎段并掉后再拆回 6 段');
  for (const s of out) assert.ok(segDur(s) >= 1.2, `仍有 ${segDur(s).toFixed(2)}s 的碎段`);
  assert.ok(Math.abs(totalDur(out) - 15) < 1e-6, '总时长必须守恒');
  for (let i = 1; i < out.length; i++) assert.equal(out[i][0], out[i - 1][1], '必须首尾相接');
});

test('fitSegments: 采样点间隔不小于 minGap', () => {
  const segs = [[0, 2], [2, 2.2], [2.2, 2.5], [2.5, 6], [6, 6.3], [6.3, 12]];
  const out = fitSegments(segs, 3, { minGap: 1.5 });
  const mids = out.map(([a, b]) => (a + b) / 2);
  for (let i = 1; i < mids.length; i++) {
    assert.ok(mids[i] - mids[i - 1] >= 1.5, `采样点间隔 ${(mids[i] - mids[i - 1]).toFixed(2)}s < 1.5s`);
  }
});

test('fitSegments: 拆分时也不会产出短于 minGap 的段', () => {
  const out = fitSegments([[0, 4]], 8, { minGap: 1.0 });
  assert.ok(out.length <= 4, `4s 段在 minGap=1 下最多拆成 4 段，实得 ${out.length}`);
  for (const s of out) assert.ok(segDur(s) >= 1.0);
});

test('fitSegments: 不传 minGap 时行为与旧版一致', () => {
  assert.deepEqual(fitSegments([[0, 0.3], [0.3, 1]], 2), [[0, 0.3], [0.3, 1]]);
});

test('fitSegments: k 非法抛错', () => {
  assert.throws(() => fitSegments([[0, 1]], 0), RangeError);
  assert.throws(() => fitSegments([[0, 1]], 2.5), RangeError);
});

test('fitSegments: 段太短时停止拆分，不死循环', () => {
  const out = fitSegments([[0, 0.3]], 10);
  assert.ok(out.length <= 2, `不应把 0.3s 拆成 10 份，实得 ${out.length}`);
});

test('resolveEffectiveMinGap: 短镜头素材会把请求的 2.0 钳到粒度附近', () => {
  // 中位段长 0.6 → grain = 0.54；请求 2.0 → 有效 0.54
  const segs = [[0, 0.6], [0.6, 1.2], [1.2, 1.8], [1.8, 3.0]];
  const gap = resolveEffectiveMinGap(segs, 2.0);
  assert.ok(gap < 1.0, `effective=${gap} 不应仍是 2.0`);
  assert.ok(Math.abs(gap - 0.54) < 0.02, `期望≈0.54，实得 ${gap}`);
});

test('resolveEffectiveMinGap: 无 minGap 返回 0', () => {
  assert.equal(resolveEffectiveMinGap([[0, 5]], 0), 0);
});
