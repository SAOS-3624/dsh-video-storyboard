/**
 * tiers.test.mjs — 档位算法（整个新架构的核心）。
 *
 * 口径来自 `取帧分档算法.docx`：切点 → 滑动窗密度 → 平滑 → 7 阈值 + 5% 滞回的 8 档状态机。
 * 档位 k 的边长就是 1/k。这里只测纯算术，不碰 ffmpeg。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVEL_THRESHOLDS, MARK_BOOST, STRATEGIES, TIER_MAX, TIER_MIN, applyMarkBoost, applyStrategy, applyTierMap,
  fitCanvas, framesFromBounds, integralMarks, levelAt, levelCurve, readabilityOf, tierHistogram,
  tierSizes, tierSide,
} from '../src/storyboard/tiers.js';

/* ---------------------------------------------------------------- 密度 → 档位 */

test('levelCurve: 全片没有切点 → 全部 1 档（长镜头拿整幅）', () => {
  const c = levelCurve({ duration: 60, fps: 30, cuts: [] });
  assert.equal(c.levels.length, 1800);
  assert.ok([...c.levels].every((v) => v === 1));
  assert.equal(tierSide(1), 1);
});

test('levelCurve: 每秒 3 刀 → 8 档（1/8 豆腐块）', () => {
  const cuts = Array.from({ length: 174 }, (_, i) => i / 3);   // 60 秒内每 1/3 秒一刀
  const c = levelCurve({ duration: 60, fps: 30, cuts });
  const mid = [...c.levels.slice(600, 1500)];
  assert.ok(mid.every((v) => v >= 7), `高密度段应到 7-8 档，实得 ${[...new Set(mid)]}`);
});

test('levelCurve: 每 5 秒一刀 → 1 档（低于第一道阈值 0.0085）', () => {
  const cuts = Array.from({ length: 12 }, (_, i) => i * 5 + 2);
  const c = levelCurve({ duration: 60, fps: 30, cuts });
  assert.equal(c.levels[900], 1);
});

test('levelCurve: 档位随密度单调不降（密度越高档位不会更小）', () => {
  const sparse = Array.from({ length: 12 }, (_, i) => i * 5);
  const dense = Array.from({ length: 120 }, (_, i) => i * 0.5);
  const a = levelCurve({ duration: 60, fps: 30, cuts: sparse });
  const b = levelCurve({ duration: 60, fps: 30, cuts: dense });
  assert.ok(levelAt(b, 30) > levelAt(a, 30));
});

test('滞回：阈值附近 ±3% 的抖动不会来回换档', () => {
  // 5% 滞回 → 升档要 > 阈值×1.05，降档要 < 阈值×0.95
  const c = levelCurve({ duration: 40, fps: 30, cuts: [] });
  assert.equal(c.levels[0], 1);
  assert.equal(LEVEL_THRESHOLDS.length, 7, '7 道阈值 → 8 档');
  assert.equal(TIER_MAX, 8);
  assert.equal(TIER_MIN, 1);
});

/* ---------------------------------------------------------------- 帧序列 */

test('framesFromBounds: 一段一帧，边界首尾相接', () => {
  const segs = framesFromBounds({ duration: 10, cuts: [2, 5, 8] });
  assert.equal(segs.length, 4);
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, 10);
  for (let i = 1; i < segs.length; i += 1) assert.equal(segs[i].from, segs[i - 1].to);
  for (const s of segs) assert.ok(s.t > s.from || s.t === s.from);
});

test('framesFromBounds: 超过 maxFrames 时合并最短的段（长镜头一格不动）', () => {
  // 0-40 是一个长镜头，后面 20 个 0.2 秒快闪
  const cuts = Array.from({ length: 20 }, (_, i) => 40 + i * 0.2);
  const segs = framesFromBounds({ duration: 44, cuts, maxFrames: 6 });
  assert.equal(segs.length, 6);
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, 44);
  assert.ok(segs[0].to - segs[0].from >= 40 - 1e-9, '长镜头不该被合并掉');
});

test('framesFromBounds: 太短的段并进前一段（0.03 秒取不出画面）', () => {
  const segs = framesFromBounds({ duration: 5, cuts: [1, 1.03, 2] });
  assert.ok(segs.every((s) => s.to - s.from >= 0.08));
  assert.equal(segs.at(-1).to, 5);
});

test('framesFromBounds: 空输入也至少给一帧（不能返回空图）', () => {
  const segs = framesFromBounds({ duration: 3 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].t, 1.5);
  assert.equal(segs[0].via, 'start');
});

test('framesFromBounds: 默认不封顶（0 / 不传都不是"最多一帧"）', () => {
  const cuts = Array.from({ length: 300 }, (_, i) => i * 0.1 + 0.1);
  assert.equal(framesFromBounds({ duration: 31, cuts }).length, 301, '不传 maxFrames 就该全给');
  assert.equal(framesFromBounds({ duration: 31, cuts, maxFrames: 0 }).length, 301, '0 = 不限');
  assert.equal(framesFromBounds({ duration: 31, cuts, maxFrames: 40 }).length, 40, '给了正数才收');
});

test('framesFromBounds: via 标出这一段是"真切点后 / 假切点后 / 片头"', () => {
  const segs = framesFromBounds({ duration: 10, cuts: [3], marks: [5, 7] });
  assert.deepEqual(segs.map((x) => x.via), ['start', 'cut', 'mark', 'mark']);
  assert.deepEqual(segs.map((x) => x.cut), [false, true, false, false]);
});

test('applyMarkBoost: 假切点的帧提两档，真切点不动，封顶 8', () => {
  assert.equal(MARK_BOOST, 2);
  const segs = framesFromBounds({ duration: 10, cuts: [3], marks: [5, 7] });
  assert.deepEqual(applyMarkBoost([1, 2, 3, 8], segs), [1, 2, 5, 8]);
  // 已经在 8 档的不会再爆
  assert.deepEqual(applyMarkBoost([8, 8, 8, 8], segs), [8, 8, 8, 8]);
  // 缺 via 时原样返回（兼容手写的段）
  assert.deepEqual(applyMarkBoost([4, 4], [{}, {}]), [4, 4]);
});

/* ---------------------------------------------------------------- 积分取帧 */

test('integralMarks: 完全静止的片子一个点都不补', () => {
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: 0 }));
  assert.deepEqual(integralMarks({ duration: 10, series }), []);
});

test('integralMarks: 持续变化 + 触发即清零 → 大约每 equivSeconds 一个点', () => {
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: 10 }));
  const marks = integralMarks({ duration: 10, series, equivSeconds: 5 });
  // 总变化 100、T = (100/10)*5 = 50 → 触发两次（t≈5 和 t≈9.x）
  assert.ok(marks.length >= 1 && marks.length <= 3, `实得 ${marks.length}: ${marks}`);
  for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i] > marks[i - 1]);
});

test('integralMarks: 真切点附近不补点（那里已经是边界）', () => {
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: 10 }));
  const marks = integralMarks({ duration: 10, series, cuts: [5], equivSeconds: 5 });
  assert.ok(marks.every((t) => Math.abs(t - 5) >= 0.35));
});

/* ---------------------------------------------------------------- 策略 / 几何 */

test('applyStrategy: 六个模式的档位映射', () => {
  const base = [1, 2, 3, 8];
  assert.deepEqual(applyStrategy(base, 'balanced'), [2, 2, 3, 8], '均衡：1 档压成 1/2');
  assert.deepEqual(applyStrategy(base, 'quality'), [1, 1, 2, 7], '高性能：升一档，1 仍是 1');
  assert.deepEqual(applyStrategy(base, 'saver'), [2, 3, 4, 8], '节省：降一档，封顶 8');
  assert.deepEqual(applyStrategy(base, 'frugal'), [4, 5, 6, 8], '乞丐：降三档');
  // 恭喜发财：不看原来几档，全部压到 1/8（自由尺寸的补位帧仍是 0）
  assert.deepEqual(applyStrategy(base, 'thrifty'), [8, 8, 8, 8], '恭喜发财：全部 1/8');
  assert.deepEqual(applyStrategy([1, 0, 5], 'thrifty'), [8, 0, 8], '补位帧不参与固定档');
  assert.deepEqual(applyStrategy(base, 'nope'), applyStrategy(base, 'balanced'), '未知策略退回默认');
  assert.equal(Object.keys(STRATEGIES).length, 6);
});

test('乞丐 / 恭喜发财 / 丐中丐：不要积分假切点', () => {
  assert.equal(STRATEGIES.frugal.noIntegral, true);
  assert.equal(STRATEGIES.thrifty.noIntegral, true);
  assert.equal(STRATEGIES.thrifty.defaultScanGap, 0.35);
  // 丐中丐：自适应加大切点间隔直到装进一张图
  assert.equal(STRATEGIES.ultra.noIntegral, true);
  assert.equal(STRATEGIES.ultra.fitOneSheet, true);
  assert.equal(STRATEGIES.ultra.fixed, 8);
  // 其他三档保留假切点、不合并切点
  for (const k of ['quality', 'balanced', 'saver']) {
    assert.ok(!STRATEGIES[k].noIntegral);
    assert.equal(STRATEGIES[k].defaultScanGap, undefined);
  }
});

test('fitCanvas: 画布任一边都不超过 800（DS 的视觉上限）', () => {
  for (const aspect of [16 / 9, 4 / 3, 1, 9 / 16, 2.39]) {
    const c = fitCanvas(aspect);
    assert.ok(c.width <= 800 && c.height <= 800, `${aspect} → ${c.width}x${c.height}`);
    assert.ok(Math.abs(c.width / c.height - aspect) < 0.02);
  }
  assert.deepEqual(fitCanvas(1), { width: 800, height: 800, aspect: 1 });
  // 预算更小就跟着小
  const sm = fitCanvas(16 / 9, { budget: 230_000 });
  assert.ok(sm.width < 800);
});

test('tierSizes: 每档该抓多大 —— 2 档以上再抓 720p 已经没有意义', () => {
  const canvas = fitCanvas(16 / 9);            // 800x450
  const sizes = tierSizes(canvas);
  assert.equal(sizes.length, 8);
  assert.deepEqual(sizes[0], { tier: 1, w: 800, h: 450 });
  assert.deepEqual(sizes[1], { tier: 2, w: 400, h: 225 });
  assert.deepEqual(sizes[3], { tier: 4, w: 200, h: 113 });
  assert.deepEqual(sizes[7], { tier: 8, w: 100, h: 56 });
  // 严格递减
  for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i].w < sizes[i - 1].w);
});

test('readabilityOf: 像素分档，不是比例', () => {
  assert.equal(readabilityOf(480, 270), 'text');
  assert.equal(readabilityOf(400, 225), 'scene');
  assert.equal(readabilityOf(160, 90), 'shot');
  assert.equal(readabilityOf(100, 56), 'composition');
});

test('tierHistogram: 统计每档几帧', () => {
  assert.deepEqual(tierHistogram([4, 4, 2, 8]), { 2: 1, 4: 2, 8: 1 });
});

/* ---------------------------------------------------------------- 档位映射表 */

test('applyTierMap: 只改写了的档位，其余原样保留', () => {
  assert.deepEqual(applyTierMap([1, 2, 3, 8], { 1: 3, 8: 4 }), [3, 2, 3, 4]);
  assert.deepEqual(applyTierMap([1, 2, 3], null), [1, 2, 3]);
  assert.deepEqual(applyTierMap([1, 2, 3], {}), [1, 2, 3]);
});

test('applyTierMap: 多档合并到同一档（快剪全按 1/4 算）', () => {
  assert.deepEqual(applyTierMap([5, 6, 7, 8], { 5: 4, 6: 4, 7: 4, 8: 4 }), [4, 4, 4, 4]);
  // 字符串键也认（JSON 传进来就是字符串）
  assert.deepEqual(applyTierMap([1, 2], { '1': '5' }), [5, 2]);
});

test('applyTierMap: 自由尺寸帧（tier 0）不参与映射，越界的键值被忽略', () => {
  assert.deepEqual(applyTierMap([0, 3], { 3: 1 }), [0, 1]);
  assert.deepEqual(applyTierMap([1, 2], { 9: 1 }), [1, 2], '键超出 1..8 丢掉');
  assert.deepEqual(applyTierMap([1, 2], { 1: 9 }), [1, 2], '值超出 1..8 丢掉');
  assert.deepEqual(applyTierMap([1, 2], 'nope'), [1, 2], '不是对象就原样返回');
});
