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

test('chooseSubGrid: 密度门槛 0.4 挡住"短而稀"的段，但长格子不受这条管', () => {
  // 3 镜 / 11 秒 = 0.27 刀/秒，且不到 12 秒 → 不摊（整段一张代表帧）。
  assert.equal(chooseSubGrid({ shots: 3, cellW: 460, cellH: 260, dur: 11, cutScore: 50 }), 1);
  // 同样 3 镜摊到 15 秒：镜头一样稀，但**格子长**，1 帧代表不了 15 秒 → 摊 2×2。
  // 2026-10-30 补这条：24 秒 8 个镜头的格子算出来 0.33 刀/秒，曾被误判成"稀"而只给 1 帧。
  assert.equal(chooseSubGrid({ shots: 3, cellW: 460, cellH: 260, dur: 15, cutScore: 50 }), 2);
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

test('chooseSubGrid: k 随镜头数增长，上限 4（默认是"热闹"的前提）', () => {
  // 800×452 才撑得住 4×4（每格 200×113），尺寸门槛是按"摊完还能看清"卡的
  const at = (shots, motion = 12) => chooseSubGrid({
    shots, cellW: 800, cellH: 452, dur: shots * 0.15, cutScore: 50, meanMotion: motion,
  });
  assert.equal(at(3), 2);
  assert.equal(at(6), 3);
  assert.equal(at(20), 4);
  // 同样 6 个镜头，但画面几乎不动（meanMotion < 8）→ 停在 2×2，把格子留给"大图"
  assert.equal(at(6, 1.2), 2);
  // 镜头数一样、运动一样时仍然受"位置不该多过镜头"约束
  assert.equal(at(5, 12), 2);
});

// ---------------- 子帧间隔闸：长格子不摊 ----------------
//
// 起因（2026-10-31）：112 分钟片子自动算成 5 张 × 16 格 = 80 格，每格 84 秒，
// 全部摊 2×2 → 320 张 170×94。模型的反馈是"根本看不清楚"。
// 84 秒摊 4 帧 = 每 21 秒抽一张，那 4 张不是"一个过程的 4 个阶段"，是 4 个不相干的镜头。

test('chooseSubGrid: 每格 84 秒不摊（摊 4 帧等于每 21 秒抽签）', () => {
  const k = chooseSubGrid({
    shots: 8, cellW: 341, cellH: 189, dur: 84, cutScore: 50, meanMotion: 4,
    minSubW: 110, minSubH: 56,   // 同 measure.js：动得起来的格子放宽到 110×56
  });
  assert.equal(k, 1, '84 秒的格子应该整帧，摊开只会变成 4 张 170×94');
});

test('chooseSubGrid: 间隔闸是独立的，尺寸再大也拦得住', () => {
  // 1710×963 摊 4×4 每张 427×240，像素绰绰有余 —— 但 84 秒 / 16 = 5.25 秒…
  // 所以这里 k 该由间隔决定而不是尺寸：先看 4×4 通不通过 gap。
  const wide = chooseSubGrid({
    shots: 20, cellW: 1710, cellH: 963, dur: 84, cutScore: 50, meanMotion: 12,
    minSubW: 110, minSubH: 56,
  });
  // 84/16 = 5.25 ≤ 15 → 4×4 成立，间隔闸不该误伤
  assert.equal(wide, 4);
  // 同样的尺寸、240 秒一格 → 240/16 = 15，边界；320 秒 → 20 > 15，必须降
  const long = chooseSubGrid({
    shots: 20, cellW: 1710, cellH: 963, dur: 320, cutScore: 50, meanMotion: 12,
    minSubW: 110, minSubH: 56,
  });
  assert.equal(long, 1, '320 秒一格摊任何 k 都超过 15 秒/张，应该退回整帧');
});

test('chooseSubGrid: 间隔闸的边界是 15 秒（50s→摊，84s→不摊）', () => {
  const at = (dur) => chooseSubGrid({
    shots: 6, cellW: 460, cellH: 260, dur, cutScore: 50, meanMotion: 4,
    minSubW: 110, minSubH: 56,
  });
  assert.equal(at(50), 2, '50/4 = 12.5 ≤ 15，保持摊开');
  assert.equal(at(60), 2, '60/4 = 15，正好在边界上，仍摊');
  assert.equal(at(61), 1, '61/4 = 15.25 > 15，退回整帧');
});

test('chooseSubGrid: 单镜头摇镜特赦出口也要过间隔闸（两个出口都要管）', () => {
  // shots=1 + meanMotion 达标 → 走"摇镜特赦"分支提前 return，旧的闸只加在末尾会漏掉这里
  const short = chooseSubGrid({
    shots: 1, cellW: 460, cellH: 260, dur: 6, cutScore: Infinity, meanMotion: 2.0,
  });
  assert.equal(short, 2, '6 秒的摇镜照摊');
  const long = chooseSubGrid({
    shots: 1, cellW: 460, cellH: 260, dur: 80, cutScore: Infinity, meanMotion: 2.0,
  });
  assert.equal(long, 1, '80 秒的摇镜摊 2 帧 = 每 40 秒一张，没有意义');
});

test('chooseSubGrid: 短视频完全不受间隔闸影响（回归）', () => {
  // 90 秒概念 PV：4 格 1 张，cell 686×383，每格 23 秒、10 个镜头 → 3×3
  assert.equal(chooseSubGrid({
    shots: 10, cellW: 686, cellH: 383, dur: 23, cutScore: 60, meanMotion: 15,
  }), 3);
  // 5 分钟 PV：12 格，cell 394×220，每格 25 秒、8 个镜头 → 3×3（放宽到 110×56 才摊得动）
  assert.equal(chooseSubGrid({
    shots: 8, cellW: 394, cellH: 220, dur: 25, cutScore: 60, meanMotion: 11,
    minSubW: 110, minSubH: 56,
  }), 3);
});

// ---------------- 指纹差（frameDiv）：直接量"这 4 张像不像" ----------------
//
// 起因（2026-10-31）：`meanMotion` 测的是相邻帧差（段内运动），而摊开问的是
// 隔很远的 k² 帧彼此像不像（段间差异）。实测两者负相关（−0.19），
// 于是"热闹就不摊、安静就摊"这条规则把长镜头压住了，放过了连续动作。
// 扫描时本来就有每帧 16×9 指纹（原只给 tagCuts 识别闪光），直接拿它量。

test('chooseSubGrid: frameDiv 低就不摊（哪怕镜头多、画面"热闹"）', () => {
  // 660×372 才撑得住 3×3（每张 220×124 ≥ 200×112）
  const base = { shots: 9, cellW: 660, cellH: 372, dur: 5, cutScore: 50, meanMotion: 15 };
  // 没有指纹：按老规则（motion 15 ≥ 8）→ 3×3
  assert.equal(chooseSubGrid(base), 3);
  // 4 张几乎一样（差 10 < 25）→ 一张整帧就够，摊开只是 4 份复制
  assert.equal(chooseSubGrid({ ...base, frameDiv: 10 }), 1);
  // 有差异但不到"能分 9 张"的程度（50 < 70）→ 最多 2×2
  assert.equal(chooseSubGrid({ ...base, frameDiv: 50 }), 2);
  // 又快又确实不同 → 放行 3×3
  assert.equal(chooseSubGrid({ ...base, frameDiv: 80 }), 3);
});

test('chooseSubGrid: 指纹高不会把安静的格子推到 3×3（像素不够分 9 张）', () => {
  // 反向升级实测过一次：16 格从 2×2 升到 3×3，子帧 170×94 → 113×63，画面更糊。
  // 指纹只说明"这 4 张不同"，不说明"像素够分给 9 张"，所以 3×3 仍要求 meanMotion。
  const base = { shots: 9, cellW: 660, cellH: 372, dur: 10, cutScore: 50, meanMotion: 1 };
  assert.equal(chooseSubGrid(base), 2);
  assert.equal(chooseSubGrid({ ...base, frameDiv: 90 }), 2, '指纹只是佐证，不单独升级');
});

test('chooseSubGrid: frameDiv 优先于 cutScore 的假刀判断', () => {
  // cutScore=12 本来会 return 1（线稿/UI 的软切）；但如果指纹证明画面真的不同，就该摊
  assert.equal(chooseSubGrid({
    shots: 8, cellW: 460, cellH: 260, dur: 4, cutScore: 12, meanMotion: 2,
  }), 1, '无指纹时被 cutScore 挡掉');
  assert.equal(chooseSubGrid({
    shots: 8, cellW: 460, cellH: 260, dur: 4, cutScore: 12, meanMotion: 2, frameDiv: 90,
  }), 2, '有指纹时以指纹为准（4 > 30 的假刀门槛不适用）');
});
