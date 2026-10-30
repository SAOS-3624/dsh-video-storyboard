import test from 'node:test';
import assert from 'node:assert/strict';

import { findBursts, integralMarks, planCellRanges, planSheetsByFrames } from '../src/storyboard/density.js';

/** 造一段：两个长镜头夹一段快切爆发 */
function timeline() {
  return {
    duration: 30,
    cuts: [10, 10.3, 10.6, 10.9, 11.2, 11.5, 25],   // 10–11.5 之间 6 个碎镜头
  };
}

test('findBursts: 密集段被识别为一次爆发', () => {
  const { cuts, duration } = timeline();
  const bursts = findBursts(cuts, duration);
  assert.equal(bursts.length, 1);
  // 区间因平滑会比真实爆发更宽，但必须**覆盖**真实爆发
  assert.ok(bursts[0].from <= 10 && bursts[0].to >= 11.5, `区间 ${bursts[0].from}–${bursts[0].to} 没盖住 10–11.5`);
  assert.ok(bursts[0].density >= 1.5, `密度应明显高于 1，实得 ${bursts[0].density}`);
});

test('findBursts: 均匀剪辑的片子不产生假爆发', () => {
  // 每 3s 一刀：这是"节奏均匀"，不是快切
  const cuts = Array.from({ length: 9 }, (_, i) => (i + 1) * 3);
  assert.deepEqual(findBursts(cuts, 30), []);
});

test('findBursts: 没有切点就没有爆发', () => {
  assert.deepEqual(findBursts([], 20), []);
});

test('planCellRanges: 覆盖整段、首尾相接、不乱序', () => {
  const { duration, cuts } = timeline();
  const ranges = planCellRanges({ duration, cuts, cells: 8 });
  assert.equal(ranges.length, 8);
  assert.equal(ranges[0].from, 0);
  assert.ok(Math.abs(ranges.at(-1).to - duration) < 1e-6);
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i].from, ranges[i - 1].to);
    assert.ok(ranges[i].dur > 0);
  }
});

test('planCellRanges: 快切区拿到超过时长的格位占比', () => {
  // 真实场景：一条 20s 的 PV，其中 6s 是 0.3s 一刀的快剪
  const cuts = [8];
  for (let t = 8.3; t < 14; t += 0.3) cuts.push(+t.toFixed(2));
  cuts.push(14);
  const duration = 20;
  const ranges = planCellRanges({ duration, cuts, cells: 8, snap: 0 });

  const inBurst = ranges.filter((r) => r.density > 1);
  const burstTime = inBurst.reduce((s, r) => s + r.dur, 0);
  // 爆发区占时长 30%；不加权时该拿 8×0.3 ≈ 2.4 格
  assert.ok(burstTime / duration > 0.2, `爆发区时长占比 ${(burstTime / duration).toFixed(2)}`);
  assert.ok(inBurst.length >= 4, `爆发区应拿到 ≥4 格（不加权只有 ~2.4），实得 ${inBurst.length}`);
});

test('planCellRanges: 短爆发只占少数格（不喧宾夺主）', () => {
  const { duration, cuts } = timeline();          // 1.5s 爆发夹在 30s 里
  const ranges = planCellRanges({ duration, cuts, cells: 8 });
  const inBurst = ranges.filter((r) => r.density > 1.5);
  // 平滑会把 1.5s 的爆发摊成几秒，所以允许 1–3 格；关键是别过半
  assert.ok(inBurst.length >= 1 && inBurst.length <= 3, `实得 ${inBurst.length} 格`);
  assert.ok(inBurst.length < ranges.length / 2, '不能吃掉一半的格');
  // 整张图里最短的那一格必须落在快切区（这就是"密的地方格更短"）
  const shortest = ranges.reduce((a, b) => (b.dur < a.dur ? b : a));
  assert.ok(shortest.density > 1.5, `最短格 ${shortest.dur.toFixed(2)}s 密度 ${shortest.density}，不在快切区`);
});

test('planCellRanges: 分段时长在快切区更短，在长镜头区更长', () => {
  const cuts = [8];
  for (let t = 8.3; t < 14; t += 0.3) cuts.push(+t.toFixed(2));
  cuts.push(14);
  const ranges = planCellRanges({ duration: 20, cuts, cells: 8, snap: 0 });
  const burstDur = ranges.filter((r) => r.density > 1).map((r) => r.dur);
  const normalDur = ranges.filter((r) => r.density === 1).map((r) => r.dur);
  assert.ok(Math.min(...normalDur) > Math.max(...burstDur),
    `普通格应比快切格长：normal min=${Math.min(...normalDur).toFixed(2)} burst max=${Math.max(...burstDur).toFixed(2)}`);
});

test('planCellRanges: 没有切点时退化为等分', () => {
  const ranges = planCellRanges({ duration: 10, cuts: [], cells: 4 });
  assert.equal(ranges.length, 4);
  for (const r of ranges) assert.ok(Math.abs(r.dur - 2.5) < 1e-6);
});

test('planCellRanges: 切点吸附——边界落在真实剪辑点上', () => {
  const ranges = planCellRanges({ duration: 20, cuts: [5, 10, 15], cells: 4, snap: 2.0 });
  const bounds = ranges.slice(1).map((r) => r.from);
  for (const b of bounds) {
    const nearest = [5, 10, 15].reduce((a, c) => (Math.abs(c - b) < Math.abs(a - b) ? c : a));
    assert.ok(Math.abs(nearest - b) < 1e-6, `边界 ${b} 没吸附到剪辑点`);
  }
});

test('planCellRanges: 极端格数也不会产生零长或倒序', () => {
  const ranges = planCellRanges({ duration: 3, cuts: [0.5, 1, 1.5, 2, 2.5], cells: 16, minLen: 0.1 });
  assert.ok(ranges.length <= 16);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i].from > ranges[i - 1].from, '必须严格递增');
    assert.ok(ranges[i].to > ranges[i].from, '不能零长');
  }
});

test('planCellRanges: 非法参数抛错', () => {
  assert.throws(() => planCellRanges({ duration: 0, cells: 4 }), RangeError);
  assert.throws(() => planCellRanges({ duration: 10, cells: 0 }), RangeError);
});

test('findBursts: 爆点带上镜头数（模型不用自己反推几个镜头）', () => {
  const cuts = [];
  for (let i = 0; i < 120; i++) cuts.push({ t: 40 + i * 0.25 });   // 40–70s 密集
  for (let i = 0; i < 20; i++) cuts.push({ t: 5 + i * 3 });        // 稀疏
  const bursts = findBursts(cuts, 90);
  assert.ok(bursts.length >= 1, '应识别出至少一个爆发段');
  const top = bursts.sort((a, b) => b.shots - a.shots)[0];
  assert.ok(top.shots > 50, `密集段应报出很多镜头，实得 ${top.shots}`);
  assert.ok(top.from >= 35 && top.to <= 75, `区间应在密集段附近，实得 ${top.from}-${top.to}`);
});

test('findBursts: 传 {t} 或纯数字结果一致', () => {
  const nums = [1, 3, 5, 7, 9, 40, 40.2, 40.4, 40.6, 40.8, 41, 41.2, 41.4];
  const objs = nums.map((t) => ({ t }));
  assert.deepEqual(findBursts(objs, 60), findBursts(nums, 60));
});

/* ---------------------------------------------------------------- 积分采样点 */

/** 每 step 秒一帧，scoreAt(t) 给分 */
const seriesOf = (duration, scoreAt, step = 0.1) => {
  const out = [];
  for (let t = 0; t < duration - 1e-9; t += step) out.push({ t: +t.toFixed(3), score: scoreAt(t) });
  return out;
};

test('integralMarks: 全片静止时一个点都不加（那格还是一条整帧）', () => {
  assert.deepEqual(integralMarks({ duration: 60, series: seriesOf(60, () => 0) }), []);
});

test('integralMarks: 均匀变化 → 每 equivSeconds 秒一个点', () => {
  const marks = integralMarks({ duration: 60, series: seriesOf(60, () => 5), equivSeconds: 6, minGap: 0.1 });
  assert.equal(marks.length, 10, `60/6 应该是 10 个点，实得 ${marks.length}`);
  for (let i = 1; i < marks.length; i++) {
    assert.ok(Math.abs(marks[i] - marks[i - 1] - 6) < 0.35, `间隔不均：${marks[i - 1]} → ${marks[i]}`);
  }
});

test('integralMarks: 变化集中的地方点更密（这就是它存在的理由）', () => {
  // 0–10 静止，10–20 剧烈，20–60 静止
  const marks = integralMarks({
    duration: 60,
    series: seriesOf(60, (t) => (t >= 10 && t < 20 ? 20 : 0.2)),
    equivSeconds: 6,
    minGap: 0.1,
  });
  const inBurst = marks.filter((t) => t >= 10 && t < 20).length;
  assert.ok(inBurst >= marks.length * 0.6, `爆发段应拿走大部分点，实得 ${inBurst}/${marks.length}`);
});

test('integralMarks: 真切点附近不补点（真切点已经是边界）', () => {
  const marks = integralMarks({
    duration: 60, series: seriesOf(60, () => 5), cuts: [12], equivSeconds: 6, minGap: 0.1,
  });
  for (const t of marks) assert.ok(Math.abs(t - 12) >= 0.35, `${t} 压在真切点上`);
  assert.ok(marks.length >= 9, '只该少一个点，不该整段消失');
});

test('integralMarks: 两个点之间至少 minGap 秒（爆发里不挤成一堆）', () => {
  const marks = integralMarks({
    duration: 20, series: seriesOf(20, () => 50), equivSeconds: 1, minGap: 2,
  });
  for (let i = 1; i < marks.length; i++) {
    assert.ok(marks[i] - marks[i - 1] >= 2 - 1e-9, `${marks[i - 1]} → ${marks[i]} 太近`);
  }
});

test('integralMarks: equivSeconds 变小 → 点变多（音频驱动调的正是这个）', () => {
  const s = seriesOf(120, () => 5);
  const a = integralMarks({ duration: 120, series: s, equivSeconds: 6, minGap: 0.1 });
  const b = integralMarks({ duration: 120, series: s, equivSeconds: 4, minGap: 0.1 });
  assert.ok(b.length > a.length, `阈值调小应该更密：${a.length} → ${b.length}`);
});

test('integralMarks: 只统计窗口内的帧（from 不为 0 时不串到别的窗口）', () => {
  const s = seriesOf(120, () => 5);
  const marks = integralMarks({
    duration: 30, series: s, start: 60, equivSeconds: 6, minGap: 0.1,
  });
  assert.equal(marks.length, 5);
  for (const t of marks) assert.ok(t >= 60 && t < 90, `${t} 跑到窗口外了`);
});

test('integralMarks: duration 必须为正', () => {
  assert.throws(() => integralMarks({ duration: 0, series: [] }), RangeError);
});

/* ---------------------------------------------------------------- 按帧数切 sheet */

const cellsOf = (n, k) => Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1, k }));

test('planSheetsByFrames: 均摊，不是"装满再切"', () => {
  // 旧写法 18 格 → 16 + 2，第二张按 bestLayout 排成 1×2（715×843 的竖长条），
  // 两个格子各占 707×396 —— 两张图只看了两个画面。均摊之后是 9+9。
  const g = planSheetsByFrames(cellsOf(18, 2), { frameBudget: 64, maxCellsPerSheet: 16 });
  assert.deepEqual(g.map((x) => x.length), [9, 9]);
});

test('planSheetsByFrames: 一格都不丢，顺序不变', () => {
  const cells = cellsOf(26, 3);
  const g = planSheetsByFrames(cells, { frameBudget: 64, maxCellsPerSheet: 16 });
  assert.deepEqual(g.flat().map((c) => c.from), cells.map((c) => c.from));
});

test('planSheetsByFrames: 每张不超过格数上限', () => {
  for (const g of planSheetsByFrames(cellsOf(40, 4), { frameBudget: 999, maxCellsPerSheet: 16 })) {
    assert.ok(g.length <= 16, `一张塞了 ${g.length} 格`);
  }
});

test('planSheetsByFrames: 每张的帧数接近（张数按帧预算定）', () => {
  const g = planSheetsByFrames(cellsOf(26, 3), { frameBudget: 64, maxCellsPerSheet: 16 });
  const f = g.map((s) => s.reduce((n, c) => n + c.k ** 2, 0));
  assert.ok(Math.max(...f) - Math.min(...f) <= 18, `帧数失衡：${f}`);
  assert.equal(f.reduce((a, b) => a + b, 0), 26 * 9);
});

test('planSheetsByFrames: 格数很少时只有一张；空数组不报错', () => {
  assert.equal(planSheetsByFrames(cellsOf(3, 4)).length, 1);
  assert.deepEqual(planSheetsByFrames([]), []);
});
