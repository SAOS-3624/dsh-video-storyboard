import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseSubGrid, subTileTimes } from '../src/storyboard/frames.js';

// ---------------- 采样点：按镜头取，而不是等距 ----------------

test('subTileTimes: 没有切点信息时退回等距采样', () => {
  const t = subTileTimes(0, 4, 4, []);
  assert.deepEqual(t.map((x) => +x.toFixed(2)), [0.5, 1.5, 2.5, 3.5]);
});

test('subTileTimes: 有切点时每个子帧落在某个镜头内部（不是切点本身）', () => {
  // 格 0–4s，切点在 1.0 / 2.5 → 三段：0–1, 1–2.5, 2.5–4
  const shots = [1.0, 2.5];
  const t = subTileTimes(0, 4, 4, shots);
  const bounds = [0, 1.0, 2.5, 4];
  for (const x of t) {
    // 必须落在某一段内部（含端点边界的浮点容差）
    const inSeg = bounds.slice(0, -1).some((lo, i) => x >= lo - 1e-9 && x <= bounds[i + 1] + 1e-9);
    assert.ok(inSeg, `${x} 不在任何镜头段内`);
    // 且不该正好压在切点上（否则取到的是转场那一帧）
    for (const s of shots) assert.ok(Math.abs(x - s) > 1e-6, `${x} 正好落在切点 ${s}`);
  }
});

test('subTileTimes: 首尾都被覆盖（i=0 在第一段，i=n-1 在最后一段）', () => {
  const t = subTileTimes(0, 4, 9, [1.0, 2.5]);
  assert.ok(t[0] < 1.0, `第一个子帧应在第一段内，实得 ${t[0]}`);
  assert.ok(t[t.length - 1] > 2.5, `最后一个子帧应在最后一段内，实得 ${t[t.length - 1]}`);
});

test('subTileTimes: 段数少于子帧数时重复采样，但不越界', () => {
  // 只有 1 个切点 → 2 段，但要取 9 个子帧
  const t = subTileTimes(0, 3, 9, [1.5]);
  assert.equal(t.length, 9);
  for (const x of t) assert.ok(x >= 0 && x <= 3, `${x} 越界`);
  // 只有两个可能值（两段的中点），重复是预期行为
  const uniq = [...new Set(t.map((x) => +x.toFixed(3)))];
  assert.ok(uniq.length <= 2, `应只有两个取值，实得 ${uniq.length}`);
});

test('subTileTimes: 切点乱序传入也能正确处理', () => {
  const a = subTileTimes(0, 4, 4, [2.5, 1.0]);
  const b = subTileTimes(0, 4, 4, [1.0, 2.5]);
  assert.deepEqual(a, b);
});

test('subTileTimes: 格外的切点被忽略（不把采样点拉到格外面去）', () => {
  const t = subTileTimes(10, 14, 4, [2, 12, 30]);
  for (const x of t) assert.ok(x >= 10 && x <= 14, `${x} 跑到格外了`);
});

// ---------------- 该不该摊 ----------------

test('chooseSubGrid: 1 秒 3 镜要摊（旧版被 minShots=4 挡掉）', () => {
  // 3 刀/秒，比"10 秒 4 镜（0.4 刀/秒）"密 7 倍，却没有被摊开 —— 这是本次修正的点
  const k = chooseSubGrid({ shots: 3, cellW: 350, cellH: 194, dur: 1.0, cutScore: 50 });
  assert.ok(k >= 2, `应当摊开，实得 k=${k}`);
});

test('chooseSubGrid: 正常叙事节奏（10 秒 4 镜）不摊', () => {
  const k = chooseSubGrid({ shots: 4, cellW: 350, cellH: 194, dur: 10, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 只有 1 镜不摊（没东西可摊）', () => {
  const k = chooseSubGrid({ shots: 1, cellW: 350, cellH: 194, dur: 1.0, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 刀本身不够狠（软切/线稿动画）不摊', () => {
  const k = chooseSubGrid({ shots: 8, cellW: 350, cellH: 194, dur: 2.0, cutScore: 12 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 子帧小于下限时降档，降到不能降就给整格', () => {
  // 格子只有 180 宽，k=2 之后每格 90 < minSubW(100) → 只能 1
  const k = chooseSubGrid({ shots: 9, cellW: 180, cellH: 100, dur: 2.0, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: k 随镜头数增长，上限 4', () => {
  const at = (shots) => chooseSubGrid({ shots, cellW: 400, cellH: 260, dur: shots * 0.15, cutScore: 50 });
  assert.equal(at(3), 2);
  assert.equal(at(6), 3);
  assert.equal(at(20), 4);
});
