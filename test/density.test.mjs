import test from 'node:test';
import assert from 'node:assert/strict';

import { findBursts, planCellRanges } from '../src/storyboard/density.js';

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
