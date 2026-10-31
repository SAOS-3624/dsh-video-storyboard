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

import { frameDiversityOf, measureGroup, subBudgetFor } from '../src/storyboard/measure.js';
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

/* ------------------------------------------------ 子帧预算与降档（F，2026-10-31）
 *
 * 这一组是"安全阀"的测试。真实素材上预算从来不会绑（`subBudgetFor` 给的是几何上限），
 * 所以默认路径根本走不到 `shrinkToBudget` —— 不单独测它就等于没测过。
 */

/** 4 格 × 5s：前两格各 9 个镜头且"热闹"（want=3），后两格各 3 个镜头且安静（want=2） */
function mixedSheet() {
  const ranges = Array.from({ length: 4 }, (_, i) => ({ from: i * 5, to: (i + 1) * 5 }));
  const cuts = [];
  for (let i = 0; i < 8; i += 1) {
    cuts.push({ t: 0.5 + i * 0.5, score: 40 });
    cuts.push({ t: 5.5 + i * 0.5, score: 40 });
  }
  for (const t of [10.5, 12, 15.5, 17]) cuts.push({ t, score: 40 });
  const stats = [];
  for (let t = 0; t < 10; t += 0.5) stats.push({ t, score: 12 });      // 前两格热闹 → 允许 3×3
  for (let t = 10; t < 20; t += 0.5) stats.push({ t, score: 0.5 });    // 后两格安静 → 最多 2×2
  return { ranges, cuts, stats };
}

const ksOf = (m) => m.cells.map((c) => c.k);

test('subBudgetFor: 只跟格数有关，不再从"有几刀"反推 k', () => {
  assert.equal(subBudgetFor({ cells: 12 }), 12 * 15, '12 格 × (4²−1)');
  assert.equal(subBudgetFor({ cells: 12, cuts: 9999 }), 12 * 15, 'cuts 已经不是入参语义');
  assert.equal(subBudgetFor({ cells: 16 }), 240, '夹到上限');
  assert.equal(subBudgetFor({ cells: 1 }), 48, '夹到下限');
  assert.equal(subBudgetFor({ cells: 20, maxK: 2 }), 20 * 3, 'maxK 参与几何上限');
  assert.equal(subBudgetFor({ cells: 12, maxK: 2 }), 48, '12×3=36 被下限 48 托住（多给无害）');
});

test('shrinkToBudget: 额度够保底时，一格都不许掉到 1', () => {
  const { ranges, cuts, stats } = mixedSheet();
  const m = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 12 });
  assert.deepEqual(ksOf(m), [2, 2, 2, 2], '12 = 4 格 × (2²−1)，刚好保底');
  assert.equal(m.frameCount, 16);
});

test('shrinkToBudget: 多余的额度按"愿望值"从大到小升级，不是按刀/秒', () => {
  const { ranges, cuts, stats } = mixedSheet();
  // 12 保底 + 5 → 只够把一个 want=3 的格子升到 3
  const one = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 17 });
  assert.deepEqual(ksOf(one), [3, 2, 2, 2], '第一个格子（镜头最多）应当先升级');
  // 再加 5 → 两个 want=3 的都升满
  const two = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 22 });
  assert.deepEqual(ksOf(two), [3, 3, 2, 2]);
  // 给更多也没用：愿望值是上限，不会被"喂胖"
  const rich = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 999 });
  assert.deepEqual(ksOf(rich), [3, 3, 2, 2]);
});

test('shrinkToBudget: 连保底都不够才会掉到 1（这条是"没米下锅"，不是常态）', () => {
  const { ranges, cuts, stats } = mixedSheet();
  const zero = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 0 });
  assert.deepEqual(ksOf(zero), [1, 1, 1, 1]);
  assert.equal(zero.frameCount, 4);
  // 只够一格的保底：愿望最大的先拿，其余退回 1
  const one = measureGroup(ranges, { aspect: 16 / 9, budget: 640_000, cuts, stats, subBudget: 4 });
  assert.deepEqual(ksOf(one), [2, 1, 1, 1]);
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

test('子帧下限跟着 need 走（不再按整片是不是音乐驱动一刀切）', async () => {
  const { subFloorForNeed } = await import('../src/storyboard/measure.js');
  // 语义：整帧给你 need 这一档，摊开允许降一档（至少还能分辨"是不是不同镜头"）
  assert.deepEqual(subFloorForNeed('scene'), { minSubW: 160, minSubH: 90 });
  assert.deepEqual(subFloorForNeed('text'), { minSubW: 320, minSubH: 180 });
  // shot 已经是最低档，不再往下
  assert.deepEqual(subFloorForNeed('shot'), { minSubW: 160, minSubH: 90 });
  // 未知档位退回 scene
  assert.deepEqual(subFloorForNeed('nonsense'), { minSubW: 160, minSubH: 90 });

  const r9 = rangesOf(9, 10);
  const cuts9 = Array.from({ length: 90 }, (_, i) => ({ t: i, score: 50 }));
  // 3×3 布局的 350×194：160×90 门槛下 2×2（175×97）成立，3×3（116×64）被挡
  const plain9 = measureGroup(r9, { aspect: 16 / 9, cuts: cuts9, musicDriven: false });
  assert.ok(plain9.cells.every((c) => c.k === 2), 'scene 档下每格最多 2×2');
  // need=text 时子帧要 320×180，350×194 连 2×2 都放不下 → 整帧
  const text9 = measureGroup(r9, { aspect: 16 / 9, cuts: cuts9, need: 'text' });
  assert.equal(text9.frameCount, 9, 'need=text 时该退成整帧');
  // 音乐驱动用例外档 110×56，能到 3×3
  const music9 = measureGroup(r9, {
    aspect: 16 / 9, cuts: cuts9, musicDriven: true, subBudget: 96,
  });
  assert.ok(music9.cells.every((c) => c.k >= 2), '音乐驱动每格都该摊开');
  // 4×4（261×145）：160×90 过不了那一档（摊 2×2 得 130×72 < 160×90），110×56 必须放过去
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

// ---------------- 指纹差（frameDiv）：直接量"摊开的 4 张像不像" ----------------
//
// 扫描时每帧都算 16×9 灰度指纹（scan.prints），原来只给 tagCuts 识别闪光。
// 用它复刻 subTileTimes 的取帧时刻、再两两比差，就是"这一格摊成 2×2 会看到什么"。

test('frameDiversityOf: 按 subTileTimes 的时刻取指纹、两两平均差', () => {
  const fp = (v) => new Uint8Array(144).fill(v);
  // fps=2，格 0–4s，无切点 → 取 0.5/1.5/2.5/3.5 → 指纹下标 1/3/5/7
  const prints = [fp(0), fp(0), fp(0), fp(0), fp(0), fp(100), fp(0), fp(100)];
  const d = frameDiversityOf({ from: 0, to: 4 }, [], prints, 2, 0, 2);
  // 4 张 = [0,0,100,100] → 6 对里 4 对差 100 → 400/6 ≈ 66.7
  assert.equal(d, 66.7);
});

test('frameDiversityOf: offset 把绝对时间换成指纹下标（窗口起点）', () => {
  const fp = (v) => new Uint8Array(144).fill(v);
  // 指纹从窗口 100s 开始；格 100–104s 与上例同构
  const prints = [fp(0), fp(0), fp(0), fp(0), fp(0), fp(100), fp(0), fp(100)];
  assert.equal(frameDiversityOf({ from: 100, to: 104 }, [], prints, 2, 100, 2), 66.7);
});

test('frameDiversityOf: 四张一模一样时返回 0（这一格不该摊）', () => {
  const fp = (v) => new Uint8Array(144).fill(v);
  const prints = Array.from({ length: 8 }, () => fp(50));
  assert.equal(frameDiversityOf({ from: 0, to: 4 }, [], prints, 2, 0, 2), 0);
});

test('frameDiversityOf: 拿不到指纹时返回 null（判据要能退回 meanMotion）', () => {
  assert.equal(frameDiversityOf({ from: 0, to: 4 }, [], null, 30, 0, 2), null);
  assert.equal(frameDiversityOf({ from: 0, to: 4 }, [], [], 30, 0, 2), null);
  // fps 未知也算拿不到
  assert.equal(frameDiversityOf({ from: 0, to: 4 }, [], [new Uint8Array(144)], 0, 0, 2), null);
});

test('frameDiversityOf: 下标越界时返回 null，不瞎猜', () => {
  const fp = (v) => new Uint8Array(144).fill(v);
  const prints = [fp(0), fp(0)];   // 只有 2 帧，但需要到下标 7
  assert.equal(frameDiversityOf({ from: 0, to: 4 }, [], prints, 2, 0, 2), null);
});

test('measureGroup: 有指纹时 frameDiv 进 cells、并影响 k', () => {
  const fp = (v) => new Uint8Array(144).fill(v);
  const ranges = rangesOf(4, 10);      // 4 格 × 10s，2×2 布局
  const cuts = [2, 4, 6, 8, 12, 14, 16, 18, 22, 24, 26, 28, 32, 34, 36, 38]
    .map((t) => ({ t, score: 50 }));
  // 一半帧是 0、一半是 200 → 任何时刻组合都有明显差异
  const prints = Array.from({ length: 160 }, (_, i) => fp(i % 2 ? 200 : 0));
  const withFp = measureGroup(ranges, { aspect: 16 / 9, cuts, prints, fps: 4, printOffset: 0 });
  assert.ok(withFp.cells.every((c) => typeof c.frameDiv === 'number'),
    '每格都应带 frameDiv');
  const noFp = measureGroup(ranges, { aspect: 16 / 9, cuts });
  assert.ok(noFp.cells.every((c) => c.frameDiv === undefined),
    '没有指纹时不该凭空造这个字段');
});
