import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseSubGrid, splitByWeight, subTileTimes } from '../src/storyboard/frames.js';

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

test('subTileTimes: 子帧数多于段数时也不重复（段内再取几个时刻）', () => {
  // 1 个切点 → 2 段，但要取 9 个子帧。旧版会重复取两个中点（9 张里 7 张是废画面）
  const t = subTileTimes(0, 3, 9, [1.5]);
  assert.equal(t.length, 9);
  for (const x of t) assert.ok(x >= 0 && x <= 3, `${x} 越界`);
  const uniq = [...new Set(t.map((x) => +x.toFixed(3)))];
  assert.equal(uniq.length, 9, `9 个子帧应该 9 个不同时刻，实得 ${uniq.length} 个`);
});

test('subTileTimes: 每段至少分配到一帧，且顺序不乱', () => {
  // 5 段 9 帧 → 2,2,2,2,1（前 4 段各 2 帧，最后一段 1 帧）
  const t = subTileTimes(0, 10, 9, [2, 4, 6, 8]);
  assert.equal(t.length, 9);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], `必须严格递增，第 ${i} 个不满足`);
  // 每个镜头段（0-2/2-4/4-6/6-8/8-10）都要有帧
  const bounds = [0, 2, 4, 6, 8, 10];
  for (let s = 0; s < 5; s++) {
    const inside = t.filter((x) => x >= bounds[s] && x <= bounds[s + 1]);
    assert.ok(inside.length > 0, `第 ${s + 1} 段没有分配到帧`);
  }
});

test('subTileTimes: 段数多于子帧数时才跳过（正常情况下 chooseSubGrid 不会让这种组合出现）', () => {
  const t = subTileTimes(0, 10, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(t.length, 2, '只有 2 帧就只输出 2 个时刻，不能溢出');
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
  // 格子取 460×260：摊 2×2 后 230×130 ≥ 200×112 的下限。
  const k = chooseSubGrid({ shots: 3, cellW: 460, cellH: 260, dur: 1.0, cutScore: 50 });
  assert.ok(k >= 2, `应当摊开，实得 k=${k}`);
});

test('chooseSubGrid: 10 秒 4 镜会摊成 2×2（门槛从 0.7 降到 0.4 后的行为变化）', () => {
  // 旧版 0.7 门槛下这里不摊。降门槛的原因：概念 PV 上 0.7 只摊 4/9 格，
  // 41 个镜头里 10 个根本没出现在图上；0.4 摊 6/9 格能做到 41/41 全覆盖。
  // 代价是 2.5 秒/镜的正常节奏也会摊成 4 格 —— 但这只是"格内多几张小图"，
  // 整张图仍然是 9 格，不会像"格数变多"那样把节奏切碎。
  const k = chooseSubGrid({ shots: 4, cellW: 460, cellH: 260, dur: 10, cutScore: 50 });
  assert.equal(k, 2);
});

test('chooseSubGrid: 密度门槛 0.4 仍会挡住慢段（已知取舍）', () => {
  // 4 镜 / 12 秒 = 0.33 刀/秒 < 0.4 → 不摊，整段只给 1 张。
  // 这是当前的行为：慢段的代表帧靠"避开黑场"保证不取到黑屏，而不是靠多摊几张。
  const k = chooseSubGrid({ shots: 4, cellW: 460, cellH: 260, dur: 12, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 只有 1 镜不摊（没东西可摊）', () => {
  const k = chooseSubGrid({ shots: 1, cellW: 460, cellH: 260, dur: 1.0, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 刀本身不够狠（软切/线稿动画）不摊', () => {
  const k = chooseSubGrid({ shots: 8, cellW: 460, cellH: 260, dur: 2.0, cutScore: 12 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 子帧小于下限时降档，降到不能降就给整格', () => {
  // 格子只有 180 宽，k=2 之后每格 90 < minSubW(200) → 只能 1
  const k = chooseSubGrid({ shots: 9, cellW: 180, cellH: 100, dur: 2.0, cutScore: 50 });
  assert.equal(k, 1);
});

test('chooseSubGrid: 排版尺寸到不了 200×112 就一律不摊（2026-10-30 实测）', () => {
  // 对比测试实测：4×4 的 247×137 摊 2×2 得 123×68、3×3 的 331×184 摊 2×2 得 165×92，
  // 两者在文字密集素材上都认不出字（盲评可读 1~2 分）。所以摊开的门槛按"能认出内容"定，
  // 不再按"能分辨不同镜头"（100×56）定。
  const dense = { shots: 30, dur: 4, cutScore: 50 };
  assert.equal(chooseSubGrid({ ...dense, cellW: 247, cellH: 137 }), 1, '4×4 格不该摊');
  assert.equal(chooseSubGrid({ ...dense, cellW: 331, cellH: 184 }), 1, '3×3 格不该摊');
  assert.equal(chooseSubGrid({ ...dense, cellW: 460, cellH: 260 }), 2, '2×2 格可以摊 2×2');
});

test('chooseSubGrid: k 随镜头数增长，上限 4', () => {
  // 800×452 才撑得住 4×4（每格 200×113），尺寸门槛是按"摊完还能看清"卡的
  const at = (shots) => chooseSubGrid({ shots, cellW: 800, cellH: 452, dur: shots * 0.15, cutScore: 50 });
  assert.equal(at(3), 2);
  assert.equal(at(6), 3);
  assert.equal(at(20), 4);
});
