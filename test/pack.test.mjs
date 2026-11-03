/**
 * pack.test.mjs — 可变网格排布。
 *
 * 两条铁律（交接文档 §7 那两次面积虚报的教训）：
 *   1. bins/fill/area 一律由**重建后的几何**反算，不用 DP 内部记账；
 *   2. 每次改完都要跑「重叠 0 + 宽高比偏差 <= 0.2」。
 * 所以下面每个几何断言都直接量 rects，不看 solve 自己报的数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNIT, bounds, bestPlan, DEFAULT_GROW, DEFAULT_STRETCH, rowOptions, solve, toRects,
} from '../src/storyboard/pack.js';

const overlaps = (rects) => {
  let n = 0;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a.px < b.px + b.pw && b.px < a.px + a.pw && a.py < b.py + b.ph && b.py < a.py + a.ph) n += 1;
    }
  }
  return n;
};

test('solve: 一格就占满整张图', () => {
  const p = solve([1]);
  assert.equal(p.bins, 1);
  assert.equal(p.cells.length, 1);
  assert.equal(p.fill, 1);
  assert.deepEqual([p.cells[0].x, p.cells[0].y, p.cells[0].w, p.cells[0].h], [0, 0, 1, 1]);
});

test('solve: 同档位四个 1 档 → 一张图里 2×2（不拆成四张满格）', () => {
  const p = solve([1, 1, 1, 1]);
  assert.equal(p.bins, 1, '少开一张图就是省 384 token');
  assert.equal(p.cells.length, 4);
  assert.ok(Math.abs(p.fill - 1) < 1e-6);
});

test('solve: 帧时序一格不动（seq 递增，档位跟着走）', () => {
  const tiers = [4, 4, 4, 3, 5, 6, 4, 4];
  const p = solve(tiers);
  assert.deepEqual(p.cells.map((c) => c.seq), tiers.map((_, i) => i));
  assert.deepEqual(p.cells.map((c) => c.t), tiers);
});

test('solve: 一帧都不丢', () => {
  for (const tiers of [[2], [2, 2, 2], [8, 8, 8, 8, 8], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    assert.equal(solve(tiers).cells.length, tiers.length);
  }
});

test('bounds: 1 档只许缩到 1/2，2 档只许缩小，3 档起可跨相邻一档', () => {
  assert.deepEqual(bounds(1), [UNIT / 2, UNIT]);
  assert.deepEqual(bounds(2), [UNIT / 3, UNIT / 2]);
  assert.deepEqual(bounds(3), [UNIT / 4, UNIT / 2]);
  assert.deepEqual(bounds(8), [UNIT / 9, UNIT / 7]);
});

test('toRects: 不重叠、宽高比偏差不超过容差、编号全局递增', () => {
  const p = solve([4, 4, 4, 3, 5, 6, 4, 4, 2, 2, 7, 8]);
  const rects = toRects(p.cells, { width: 800, height: 450 });
  assert.equal(overlaps(rects), 0, '相邻格不能重叠');
  const target = 800 / 450;
  // 阈值跟着 DEFAULT_STRETCH 走：它定义的就是"一个格子最多走形多少"。
  // 多留 0.05：像素取整会再偏几个点（400 组随机压测量到 τ=0.3 时实测最大 33.6%，
  // 理论值正好 30%，剩下 3.6 是 toRects 修 1px 缝隙造成的）。
  const tol = DEFAULT_STRETCH + 0.05;
  for (const r of rects) {
    assert.ok(Math.abs(r.pw / r.ph / target - 1) <= tol, `${r.index}: ${r.pw}x${r.ph} 变形过头`);
    assert.ok(r.px >= 0 && r.py >= 0 && r.px + r.pw <= 800 && r.py + r.ph <= 450, `${r.index} 越界`);
  }
  assert.deepEqual(rects.map((r) => r.index), rects.map((_, i) => i + 1));
  assert.equal(new Set(rects.map((r) => r.index)).size, rects.length, '编号不能重复');
});

test('toRects: 按 bin 取单张，编号仍然跨张连续', () => {
  const p = solve([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  assert.ok(p.bins >= 1);
  const all = p.cells.map((c) => c.seq + 1);
  const seen = [];
  for (let b = 0; b < p.bins; b += 1) {
    const rects = toRects(p.cells, { width: 800, height: 450, bin: b });
    seen.push(...rects.map((r) => r.index));
    assert.equal(overlaps(rects), 0);
  }
  assert.deepEqual(seen.sort((a, b) => a - b), all, '两边的编号必须拼成 1..N');
});

test('toRects: 混合档位同一行不能有 1px 重叠', () => {
  // [2,0,1,0,0,0] 同一行里 0 档补位格只有 38px 高，旁边的 1 档格是 225px 高。
  // 旧实现把 h 也放进行分组键，两组分开后水平取整差 1px 修不掉。
  const p = solve([2, 0, 1, 0, 0, 0]);
  const rects = toRects(p.cells, { width: 800, height: 450 });
  assert.equal(overlaps(rects), 0, '混合高度的同一行也不能重叠');
  for (const r of rects) {
    assert.ok(r.px >= 0 && r.py >= 0 && r.px + r.pw <= 800 && r.py + r.ph <= 450, `${r.index} 越界`);
  }
});

test('toRects: 最后一行取整后不能越过画布', () => {
  // [5,1,0] 在 800x450 下最后一行 py+ph = 451，旧实现会多出 1px 底边。
  const p = solve([5, 1, 0]);
  const rects = toRects(p.cells, { width: 800, height: 450 });
  for (const r of rects) {
    assert.ok(r.px >= 0 && r.py >= 0, `${r.index} 左上越界`);
    assert.ok(r.px + r.pw <= 800, `${r.index} 右边越界`);
    assert.ok(r.py + r.ph <= 450, `${r.index} 底边越界`);
  }
});

test('rowOptions: 一行填满宽度，行高取最高那格', () => {
  const opts = rowOptions([4, 4, 4]);
  assert.ok(opts.length >= 1);
  // 候选里有"原尺寸不填满"和"拉平填满"两种，至少要有一个填满宽度
  assert.ok(opts.some((o) => Math.abs(o.s.reduce((a, b) => a + b, 0) - UNIT) < 1e-6), '必须有填满宽度的候选');
  for (const o of opts) {
    const total = o.s.reduce((a, b) => a + b, 0);
    assert.ok(total <= UNIT + 1e-6, `行宽不能超 1，实得 ${total}`);
    assert.ok(Math.abs(o.c - Math.max(...o.s)) < 1e-6 || o.flat, '行高必须是本行最高那格');
  }
});

test('bestPlan: 16 格会给"四张满格"，所以正常路径要用 solve(tiers)', () => {
  const best = bestPlan(16);
  assert.ok(best.fill > 0.99);
  // 这就是交接文档 §6 的警告：bestPlan 只看占用率，不看张数
  assert.ok(best.bins >= 1);
  const p = solve(new Array(16).fill(4));
  assert.equal(p.bins, 1, '同样 16 格、统一 1/4 档，一张就装下了');
});

test('性能: 96 帧（长片概览规模）求解 < 50ms', () => {
  const tiers = Array.from({ length: 96 }, (_, i) => 2 + (i % 5));
  const t0 = performance.now();
  const p = solve(tiers);
  const ms = performance.now() - t0;
  assert.equal(p.cells.length, 96);
  assert.ok(ms < 50, `求解 ${ms.toFixed(1)}ms 太慢`);
});

/* ---------------------------------------------------------------- 缓存键（#64） */

test('rowOptions: 不同 stretch 不能共用缓存（flat 行高直接依赖它）', () => {
  const a = rowOptions([3, 3], DEFAULT_GROW, 0.2, true);
  const b = rowOptions([3, 3], DEFAULT_GROW, 0.3, true);
  assert.notDeepEqual(a, b, 'stretch 0.2 和 0.3 必须算出不同的行高');
  // 再算一次 0.2，必须还是 0.2 的结果（不能被 0.3 覆盖）
  const again = rowOptions([3, 3], DEFAULT_GROW, 0.2, true);
  assert.deepEqual(again, a, '回头再算 0.2 仍要拿到 0.2 的结果');
});

test('rowOptions: grow 参与缓存键（决定能不能升档）', () => {
  const allow = rowOptions([3, 3], DEFAULT_GROW, 0.2, true);
  const deny = rowOptions([3, 3], DEFAULT_GROW.map(() => 0), 0.2, true);
  assert.notDeepEqual(allow, deny, 'grow 不同必须算出不同的候选');
});

/* ---------------------------------------------------------------- 排布的三条新前提（2026-11-04） */
/*
 * 这三条是补的：把 DEFAULT_STRETCH / flat 判据 / 部分拉伸逐个改回旧行为，
 * 上面 517 条测试**一条都不会红** —— 也就是说这三个收益没有任何守卫。
 * 补完之后做了变异验证：每个改坏都会被抓到。
 */

test('DEFAULT_STRETCH 是 0.3，而且它确实比 0.2 排得紧', () => {
  assert.equal(DEFAULT_STRETCH, 0.3, '容差被回滚的话这条会红');
  // 这条序列在 0.2 下要 2 张（44.3%），0.3 下 1 张（89.7%）。挑它是因为两者差一整张图，
  // 不是靠小数点后的 fill 差异 —— 那种断言换个平台就会飘。
  const seq = [3, 4, 4, 4, 7, 7, 7, 2, 2];
  const now = solve(seq);
  const old = solve(seq, { stretch: 0.2 });
  assert.equal(old.bins, 2, '0.2 容差下这 9 帧应该装不下');
  assert.equal(now.bins, 1, '0.3 容差下应该刚好一张');
  assert.ok(now.fill > old.fill + 0.2, `占用率该明显更高：${now.fill} vs ${old.fill}`);
});

test('flat 只在该行 最宽/最窄 <= (1+τ)² 时出现（别偷偷拉过头）', () => {
  // [2,4,4,4] 的水位解是 s = [1/3, 2/9, 2/9, 2/9]，wmax/wmin = 1.5。
  //   τ=0.2：边界 (1.2)² = 1.44 → 1.5 超了，不许 flat。
  //          旧的 (1+τ)/(1−τ) = 1.5 会放行，最窄格被拉到 1.25（+25%），
  //          比"最多走形 20%"多出四分之一 —— 这就是要拦的。
  //   τ=0.3：边界 (1.3)² = 1.69 → 1.5 放行。
  const tight = rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.2, true);
  assert.equal(tight.some((o) => o.flat), false, '20% 容差下这行不该有 flat 候选');
  const loose = rowOptions([2, 4, 4, 4], DEFAULT_GROW, 0.3, true);
  assert.equal(loose.some((o) => o.flat), true, '30% 容差下应该允许');
});

test('部分拉伸：矮格被拉高，但不超过行高、也不超过 (1+τ) 倍', () => {
  // [1,4,4] 一行里宽度差 2 倍，flat 不可行（超过 (1+τ)²），只能靠逐格拉。
  const tau = 0.3;
  const p = solve([1, 4, 4], { stretch: tau });
  const stretched = p.cells.filter((c) => c.h > c.w + 1e-9);
  assert.ok(stretched.length > 0, '宽度不等又没有 flat 的行，应该有格子被拉高');
  for (const c of p.cells) {
    assert.ok(c.h <= c.w * (1 + tau) + 1e-9, `拉伸超过容差：${c.w.toFixed(3)} -> ${c.h.toFixed(3)}`);
    assert.ok(Math.abs(c.h * c.stretch - c.w) < 1e-9, 'h / stretch 字段必须自洽（渲染按 st 反查宽高）');
  }
});
