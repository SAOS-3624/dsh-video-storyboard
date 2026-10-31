/**
 * layout.test.mjs — 排布决策的不变量。
 *
 * 这一层是从 runStoryboard 里抽出来的纯算术（见 layout.js 顶部）。抽它最直接的好处就在这里：
 * **不用 ffmpeg、不用真视频，就能断言"排布必须成立的性质"**。
 *
 * 这些断言故意不锁具体数字（几格几张会随判据调整而变），只锁那些"怎么改都不能破"的东西：
 *   - 补满 / 裁暗场 / 并尾 / 重切之后，时间轴仍然首尾相接、完整覆盖
 *   - groups 摊平后与 cellRanges 一模一样（切张只能分组，不能改格点）
 *   - 报出来的帧数 = 每格 k² 的和 = 每张测量结果的和（清单里这个数要能对账）
 *   - 显式 sheets 就是精确张数（调用方说了算）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planLayout } from '../src/storyboard/layout.js';

/** 一段 100 秒、7 个切点的素材（够密，但不是快剪爆发） */
function base(over = {}) {
  const relCuts = [10, 20, 30, 45, 60, 75, 90];
  return {
    winStart: 0,
    winDur: 100,
    relCuts,
    p90: 5,
    darkRuns: [],
    stats: [{ t: 0.5, score: 3 }],
    adaptive: true,
    minGap: 1.2,
    cellsIn: 0,
    sheetsIn: 0,
    maxPerSheet: 9,
    suggestion: { cells: 9, sheets: 1, reason: 'test' },
    aspect: 16 / 9,
    budget: 640_000,
    need: 'scene',
    audioStrip: false,
    musicDriven: false,
    cuts: relCuts.map((t) => ({ t, score: 40 })),
    sampleMarks: [],
    printCtx: { prints: null, fps: 24, printOffset: 0 },
    ...over,
  };
}

test('planLayout: 格点首尾相接、完整覆盖窗口', () => {
  const L = planLayout(base());
  assert.ok(L.cellRanges.length > 0);
  assert.equal(L.cellRanges[0].from, 0);
  assert.equal(L.cellRanges.at(-1).to, 100);
  for (let i = 1; i < L.cellRanges.length; i += 1) {
    assert.equal(L.cellRanges[i].from, L.cellRanges[i - 1].to,
      `第 ${i} 格起点与上一格终点不接（${L.cellRanges[i - 1].to} → ${L.cellRanges[i].from}）`);
  }
});

test('planLayout: 切张只分组，不改格点', () => {
  const L = planLayout(base());
  const flat = L.groups.flat();
  assert.equal(flat.length, L.cellRanges.length);
  assert.deepEqual(
    flat.map((r) => [r.from, r.to]),
    L.cellRanges.map((r) => [r.from, r.to]),
  );
});

test('planLayout: 报出来的帧数能对账', () => {
  const L = planLayout(base());
  const byK = L.measurements.reduce((n, m) => n + m.cells.reduce((s, c) => s + c.k * c.k, 0), 0);
  const byMeasure = L.measurements.reduce((n, m) => n + m.frameCount, 0);
  assert.equal(L.frames, byMeasure);
  assert.equal(L.frames, byK);
});

test('planLayout: 每张格数不超过单张上限', () => {
  const L = planLayout(base({ maxPerSheet: 9 }));
  for (const g of L.groups) {
    assert.ok(g.length <= L.perSheetCap, `一张塞了 ${g.length} 格，上限 ${L.perSheetCap}`);
  }
});

test('planLayout: 显式 sheets 是精确张数（不自动补满/重切）', () => {
  const L = planLayout(base({ cellsIn: 6, sheetsIn: 2 }));
  assert.equal(L.sheets, 2);
  assert.equal(L.groups.length, 2);
  assert.equal(L.groups[0].length, 6);
});

test('planLayout: cells:1 的语义是一帧，不摊开', () => {
  const L = planLayout(base({ cellsIn: 1, sheetsIn: 1 }));
  assert.equal(L.noTiling, true);
  assert.equal(L.cellRanges.length, 1);
  assert.equal(L.frames, 1);
});

test('planLayout: 黑场（≥2s）单独成一格，且标 dark', () => {
  const L = planLayout(base({ darkRuns: [{ from: 0, to: 5 }] }));
  const dark = L.cellRanges.filter((r) => r.dark);
  assert.equal(dark.length, 1);
  assert.equal(dark[0].from, 0);
  assert.equal(dark[0].to, 5);
  // 黑场额外占格，但内容格数不被它吃掉：覆盖仍然是完整的
  assert.equal(L.cellRanges[0].from, 0);
  assert.equal(L.cellRanges.at(-1).to, 100);
});
