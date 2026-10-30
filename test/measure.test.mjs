/**
 * measure.test.mjs — "一张图会产生多少帧"必须只有一个答案。
 *
 * 起因（Kimi 的 review，2026-10-30）：切张时用硬编码 250×140 估算 k，渲染时用真实
 * layoutCanvas 尺寸再算一次。子帧下限提到 200×112 之后两者必然打架：
 *   250×140 → k=1；505×312 → k=2（4 帧）
 * 于是 `planSheetsByFrames()` 名义按帧数切张，实际按错的帧数在切。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { measureGroup } from '../src/storyboard/measure.js';
import { layoutCanvas } from '../src/storyboard/sheet.js';
import { bestLayout } from '../src/storyboard/plan.js';

const rangesOf = (n, len = 10) => Array.from({ length: n }, (_, i) => ({
  from: i * len, to: (i + 1) * len, density: 1,
}));

test('measureGroup: frameCount 恒等于 Σ k²', () => {
  for (const n of [1, 4, 9, 12, 16]) {
    const m = measureGroup(rangesOf(n), { aspect: 16 / 9 });
    const sum = m.cells.reduce((s, c) => s + c.k * c.k, 0);
    assert.equal(m.frameCount, sum, `n=${n} 帧数对不上`);
    assert.equal(m.cells.length, n);
  }
});

test('measureGroup: 用的是真实布局尺寸，不是 250×140', () => {
  // 4 格 → 2×2 → 505×312；摊 2×2 得 252×156，够 200×112 → k 可以是 2
  const four = measureGroup(rangesOf(4), {
    aspect: 16 / 9,
    cuts: Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, score: 50 })),
  });
  assert.equal(four.cols, 2);
  assert.equal(four.rows, 2);
  const real = layoutCanvas(2, 2, 16 / 9, 640_000);
  assert.equal(four.cellW, real.cellW);
  assert.equal(four.cellH, real.cellH);
  assert.ok(four.frameCount >= 4, `应当摊开，实得 ${four.frameCount}`);

  // 16 格 → 4×4 → 247×137，摊 2×2 只有 123×68 < 200×112 → 一律不摊
  const sixteen = measureGroup(rangesOf(16), {
    aspect: 16 / 9,
    cuts: Array.from({ length: 200 }, (_, i) => ({ t: i * 0.1, score: 50 })),
  });
  assert.equal(sixteen.cols, 4);
  assert.equal(sixteen.frameCount, 16, '4×4 不该摊开');
});

test('measureGroup: subBudget 不够时降档，且 frameCount 跟着降', () => {
  const cuts = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, score: 50 }));
  const loose = measureGroup(rangesOf(4), { aspect: 16 / 9, cuts, subBudget: 48 });
  const tight = measureGroup(rangesOf(4), { aspect: 16 / 9, cuts, subBudget: 1 });
  assert.ok(loose.frameCount > tight.frameCount);
  assert.equal(tight.frameCount, tight.cells.reduce((s, c) => s + c.k * c.k, 0));
});

test('measureGroup: 音乐驱动把"单镜头但在动"的门槛从 1.5 降到 0.7', () => {
  const ranges = [{ from: 0, to: 12, density: 1 }];
  const stats = Array.from({ length: 12 }, (_, i) => ({ t: i, score: 1.0 }));
  const plain = measureGroup(ranges, { aspect: 16 / 9, stats, musicDriven: false });
  const music = measureGroup(ranges, { aspect: 16 / 9, stats, musicDriven: true });
  assert.equal(plain.cells[0].k, 1);
  assert.equal(music.cells[0].k, 2);
});

test('measureGroup: 音频条带按 10% 扣预算（与 composeSheet 同口径）', () => {
  const m = measureGroup(rangesOf(9), { aspect: 16 / 9, audioStrip: true });
  const noStrip = layoutCanvas(m.cols, m.rows, 16 / 9, 640_000);
  assert.equal(m.cellBudget, Math.round(640_000 * 0.9));
  assert.ok(m.cellW < noStrip.cellW, '扣了预算格子应当更小');
});

test('measureGroup: 布局与 bestLayout 一致（不自己另算一套）', () => {
  for (const n of [3, 5, 9, 13, 25]) {
    const m = measureGroup(rangesOf(n), { aspect: 16 / 9 });
    const b = bestLayout(n, 16 / 9);
    assert.equal(m.cols, b.cols);
    assert.equal(m.rows, b.rows);
  }
});

test('子帧下限按内容分流：音乐驱动 110×56，其余 200×112', async () => {
  const { subFloorFor } = await import('../src/storyboard/measure.js');
  assert.deepEqual(subFloorFor(true), { minSubW: 110, minSubH: 56 });
  assert.deepEqual(subFloorFor(false), { minSubW: 200, minSubH: 112 });

  // 3×3（350×194）：音乐驱动下能摊 3×3 得 116×64。
  // 160×90 时这一档摊不动 —— 正式 PV 第 1 格（24 秒、7 个切点）因此只拿到 4 帧，
  // 用户的原话是"1 和 2 之间漏了特别多"。
  const r9 = rangesOf(9, 10);
  const cuts9 = Array.from({ length: 90 }, (_, i) => ({ t: i, score: 50 }));
  const plain9 = measureGroup(r9, { aspect: 16 / 9, cuts: cuts9, musicDriven: false });
  const music9 = measureGroup(r9, { aspect: 16 / 9, cuts: cuts9, musicDriven: true });
  assert.equal(plain9.frameCount, 9, '普通素材 3×3 不该摊');
  assert.ok(music9.cells.filter((c) => c.k === 3).length >= 6, '3×3 在音乐驱动下应能摊 3×3');

  // 4×4（261×145）：160×90 过不了的一档（摊 2×2 得 130×72 < 160×90），110×56 必须放过去
  const r16 = rangesOf(16, 8);
  const cuts16 = Array.from({ length: 128 }, (_, i) => ({ t: i, score: 50 }));
  const plain16 = measureGroup(r16, { aspect: 16 / 9, cuts: cuts16, musicDriven: false });
  const music16 = measureGroup(r16, { aspect: 16 / 9, cuts: cuts16, musicDriven: true });
  assert.equal(plain16.frameCount, 16, '普通素材 4×4 不该摊');
  assert.ok(music16.cells.every((c) => c.k === 2), '4×4 在音乐驱动下每格都应摊 2×2');
});

test('allocateIntegerBudget: 总和精确、每份不低于下限', async () => {
  const { allocateIntegerBudget } = await import('../src/storyboard/plan.js');
  for (const [total, w] of [[24, [10, 5, 3]], [48, [7, 7, 7, 7]], [13, [1, 1, 1]], [5, [9, 1]]]) {
    const out = allocateIntegerBudget(total, w, { min: 1 });
    assert.equal(out.reduce((a, b) => a + b, 0), total, `total=${total} 加总不对`);
    assert.ok(out.every((x) => x >= 1), '不该有 0');
  }
  // 配额不够保底时也不能超发
  const tight = allocateIntegerBudget(2, [5, 5, 5], { min: 1 });
  assert.equal(tight.reduce((a, b) => a + b, 0), 2);
});
