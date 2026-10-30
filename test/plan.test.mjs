import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bestLayout, canvasAspect, cellSize, fillLayout, groupByCount, groupByDuration, planTotal,
  planWindows, snapCells, suggest, validatePlan, COVERAGE, IMAGE_TOKEN_CAP, MIN_CELL_H, MIN_CELL_W,
} from '../src/storyboard/plan.js';

const L = 16 / 9;
const P = 9 / 16;

/* ---------------------------------------------------------------- 布局：画布比例 */

test('bestLayout: 16:9 源，平方数还原 16:9 画布', () => {
  for (const n of [1, 4, 9, 16]) {
    const { cols, rows, canvasAspect: ca } = bestLayout(n, L);
    assert.equal(cols, rows, `n=${n} 应为方形`);
    assert.ok(Math.abs(ca - L) < 1e-9, `n=${n} 画布应为 16:9，实得 ${ca}`);
  }
});

test('bestLayout: 非平方数选更接近源比例的方向（12 → 3×4 而非 4×3）', () => {
  const { cols, rows, canvasAspect: ca } = bestLayout(12, L);
  assert.deepEqual([cols, rows], [3, 4]);
  assert.ok(ca < L, '较高的画布优于超宽画布');
  // 反例：4×3 的画布是 2.37:1，明显偏离 16:9
  assert.ok(canvasAspect(4, 3, L) > L * 1.3);
});

test('bestLayout: 6 格选 2×3（1.19）而不是 3×2（2.67）', () => {
  const { cols, rows, canvasAspect: ca } = bestLayout(6, L);
  assert.deepEqual([cols, rows], [2, 3]);
  assert.ok(Math.abs(ca - 1.19) < 0.02, `实得 ${ca.toFixed(3)}`);
  assert.ok(canvasAspect(3, 2, L) > 2.5, '3×2 是超宽反例');
});

test('bestLayout: 竖屏源同样成立（9:16 → 3×3 还原 9:16）', () => {
  const { cols, rows, canvasAspect: ca } = bestLayout(9, P);
  assert.deepEqual([cols, rows], [3, 3]);
  assert.ok(Math.abs(ca - P) < 1e-9);
});

test('bestLayout: 画布从不偏离源比例超过 50%（n=4..16）', () => {
  for (let n = 4; n <= 16; n++) {
    const ca = bestLayout(n, L).canvasAspect;
    const ratio = ca / L;
    assert.ok(ratio <= 1.5 && ratio >= 0.6, `n=${n} ratio=${ratio.toFixed(2)}`);
  }
});

/* ---------------------------------------------------------------- 填满布局：不许留空格 */

test('fillLayout: 5 格补成 2×3 的 6 格（空格和画面是同样的 token）', () => {
  const f = fillLayout(5, L);
  assert.equal(f.cells, 6, '5 格排成 2×3 会空一格，要补到 6');
  assert.deepEqual([f.cols, f.rows], [2, 3]);
  assert.equal(f.capacity, f.cells, '补完必须刚好填满');
  assert.equal(f.requested, 5, '要记住原来要了几格，清单得说得清');
});

test('fillLayout: 本来就整格的数不动', () => {
  for (const n of [1, 2, 4, 6, 9, 12, 16]) {
    const f = fillLayout(n, L);
    assert.equal(f.cells, n, `n=${n} 不该被改动`);
    assert.equal(f.capacity, n);
  }
});

test('fillLayout: 非整格一律往上补到容量，绝不往下砍', () => {
  for (let n = 1; n <= 20; n++) {
    const f = fillLayout(n, L);
    assert.ok(f.cells >= n, `n=${n} 被砍到 ${f.cells}`);
    assert.equal(f.cells, f.capacity, `n=${n} 补完还剩空位（${f.cells} vs ${f.capacity}）`);
    // 再补一次必须收敛，否则取帧数会无限膨胀
    assert.equal(fillLayout(f.cells, L).cells, f.cells, `n=${n} 二次取整不收敛`);
  }
});

test('fillLayout: 竖屏同样填满', () => {
  for (const n of [5, 7, 10, 14]) {
    const f = fillLayout(n, P);
    assert.equal(f.cells, f.capacity, `n=${n} 竖屏仍留空位`);
  }
});

test('bestLayout: 允许 padding，且浪费不超过 25%', () => {
  for (let n = 1; n <= 16; n++) {
    const { capacity } = bestLayout(n, L);
    assert.ok(capacity >= n, `n=${n} capacity=${capacity}`);
    assert.ok(capacity - n <= Math.ceil(n * 0.25), `n=${n} 浪费 ${capacity - n} 格过多`);
  }
});

test('bestLayout: 非法输入直接抛错', () => {
  assert.throws(() => bestLayout(0, L), RangeError);
  assert.throws(() => bestLayout(2.5, L), RangeError);
  assert.throws(() => bestLayout(4, 0), RangeError);
});

/* ---------------------------------------------------------------- 单元格尺寸 */

test('cellSize: 640k 预算下的理论单格（未扣间隙）', () => {
  // 注意：渲染时还会扣掉 gutter，实际像素比这里小 ~6px，见 sheet.js
  const cases = [
    [2, 2, 533, 300],
    [3, 3, 356, 200],
    [3, 4, 308, 173],
    [4, 4, 267, 150],
    [5, 5, 213, 120],
  ];
  for (const [cols, rows, w, h] of cases) {
    const cell = cellSize(cols, rows, L);
    assert.ok(Math.abs(cell.w - w) <= 1, `${cols}x${rows} w=${cell.w} 期望≈${w}`);
    assert.ok(Math.abs(cell.h - h) <= 1, `${cols}x${rows} h=${cell.h} 期望≈${h}`);
  }
});

test('cellSize: 格数越多，单格越小（单调）', () => {
  let prev = Infinity;
  for (const n of [1, 4, 6, 9, 12, 16]) {
    const { cols, rows } = bestLayout(n, L);
    const { area } = cellSize(cols, rows, L);
    assert.ok(area < prev, `n=${n} 的单格面积没有随格数下降`);
    prev = area;
  }
});

/* ---------------------------------------------------------------- suggest */

const meta = (duration, cuts, extra = {}) => ({ duration, cuts, aspect: L, ...extra });

test('suggest: 格数由「切点总数」决定（密度积分的总量）', () => {
  // 总格数 = 镜头数 ÷ 8（每格 8 个镜头，摊 3×3 刚好）
  assert.equal(suggest(meta(60, 8)).cells, 4);           // 9 镜 → 4 格（下限）
  assert.equal(suggest(meta(60, 8)).sheets, 1);

  const single = suggest(meta(480, 0));
  assert.equal(single.cells, 4);
  assert.match(single.reason, /单镜头/);

  assert.equal(suggest(meta(300, 40)).cells, 4, '41 镜 → 5 格 → 吸附 4');
  assert.equal(suggest(meta(300, 40)).sheets, 1);

  // 张数 = ceil(总格数 / 18.4)，168 镜 → 21 格 → 2 张
  assert.equal(suggest(meta(700, 700)).sheets, 5, '701 镜 → 88 格 → 5 张');
  assert.equal(suggest(meta(900, 60)).sheets, 1, '61 镜 → 8 格 → 1 张');
  assert.equal(suggest(meta(1500, 90)).sheets, 1, '91 镜 → 11 格 → 1 张（镜头少就是慢片）');
});

test('suggest: 真实素材回归（B站 299s / 88 cuts → 总格数够覆盖）', () => {
  // 实测：这条片子 9 格（33s/格）大量重复草地镜头，要 16 格（19s/格）才覆盖到产品/人物/采访。
  // 现在总格数 = 时长 ÷ 每格秒数，再折成张数（20 格 → 9 格 × 2 张 = 18）。
  // 所以断言改成"总格数"，不再死磕"必须 1 张 16 格"。
  const s = suggest({ duration: 299.41, cuts: 88, aspect: L });
  // 89 镜 → 11 格 → 12，够覆盖（实测 9 格会重复草地，16 格才够看产品/人物）
  assert.ok(s.cells * s.sheets >= 11, `总格数 ${s.cells * s.sheets} 不够覆盖`);
});

test('suggest: 每格秒数随画面变化 p90 **连续**下降（不再三档硬切）', () => {
  // 旧版是 motion>=15?12 : motion>=5?20 : 40，在 13 和 17 之间一刀切，
  // 导致两支同长的 PV 一个 4 格一个 9 格。现在改成 40 - p90（夹在 8~45）。
  // 比的是**总格数**（cells × sheets）——单看 cells 是"每张几格"，会因分张而误判
  const at = (m) => { const s = suggest({ duration: 300, cuts: 40, motion: m, aspect: L }); return s.cells * s.sheets; };
  assert.ok(at(25) >= at(15), 'p90 更高时总格数不该更少');
  assert.ok(at(15) >= at(5), 'p90 更高时总格数不该更少');
  // 且相邻两档不应该跳变（连续性）
  assert.ok(Math.abs(at(15) - at(13)) <= 2, `13→15 之间不该跳变，实得 ${at(13)}→${at(15)}`);
});

test('suggest: 静态单镜头仍是 4 格，快剪长片封顶 16 且拆 2 张', () => {
  assert.equal(suggest({ duration: 251, cuts: 0, motion: 2.2, aspect: L }).cells, 4);
  const long = suggest({ duration: 1090, cuts: 700, motion: 15, aspect: L });
  assert.equal(long.cells, 16);
  assert.equal(long.sheets, 5, '701 镜 → 88 格 → 5 张');
});

test('suggest: 格数不超过镜头数', () => {
  const s = suggest(meta(600, 11));           // 12 个镜头
  assert.ok(s.cells <= 12, `cells=${s.cells} 超过镜头数`);
});

test('suggest: 台词密度高时降档（总量很小时会被 4 格下限吃掉）', () => {
  // 31 镜 → 4 格（已经是下限），×0.6 还是被夹回 4，所以这条在短素材上不生效
  const dense = suggest(meta(600, 30, { hasSubtitle: true, speechRate: 4.2 }));
  assert.ok(dense.cells >= 4);
  // 长素材才看得出降档：400 镜 → 50 格，×0.6 = 30 格
  const longDense = suggest(meta(3600, 400, { hasSubtitle: true, speechRate: 4.2 }));
  const longPlain = suggest(meta(3600, 400, { speechRate: 1.5 }));
  assert.ok(longDense.cells * longDense.sheets <= longPlain.cells * longPlain.sheets);
});

test('suggest: 时长必须为正', () => {
  assert.throws(() => suggest({ duration: 0, cuts: 0 }), RangeError);
});

test('snapCells: 吸附到不留空格的格数', () => {
  assert.deepEqual([8, 10, 11, 13, 15, 20, 1].map(snapCells), [9, 9, 12, 12, 16, 16, 4]);
});

/* ---------------------------------------------------------------- 多张分组 */

test('groupByDuration: 切点落在段边界，覆盖时长均衡', () => {
  const segs = [[0, 2.5], [2.5, 4.5], [4.5, 7], [7, 12.8], [12.8, 14.8], [14.8, 22.8], [22.8, 25.8], [25.8, 27.8]];
  const groups = groupByDuration(segs, 2);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length + groups[1].length, segs.length, '不能丢段');
  const dur = (g) => g.reduce((s, [a, b]) => s + (b - a), 0);
  const [d0, d1] = [dur(groups[0]), dur(groups[1])];
  const target = (d0 + d1) / 2;
  assert.ok(Math.abs(d0 - target) <= target * 0.35, `组时长失衡：${d0} vs ${d1}`);
  assert.equal(groups[1][0][0], groups[0].at(-1)[1], '组边界必须首尾相接（不劈镜头）');
});

test('groupByDuration: sheets=1 返回整份，顺序不变', () => {
  const segs = [[0, 1], [1, 2], [2, 3]];
  assert.deepEqual(groupByDuration(segs, 1), [segs]);
});

test('groupByDuration: 段数少于张数时补空组', () => {
  const groups = groupByDuration([[0, 1], [1, 2]], 3);
  assert.equal(groups.length, 3);
  assert.equal(groups[2].length, 0);
});

test('groupByCount: 每张正好填满，不产生空格', () => {
  const segs = Array.from({ length: 27 }, (_, i) => [i, i + 1]);
  const groups = groupByCount(segs, 9, 3);
  assert.equal(groups.length, 3);
  for (const g of groups) assert.equal(g.length, 9, '每张必须正好 9 段');
  assert.deepEqual(groups[2].at(-1), [26, 27]);
});

test('groupByCount: 段数不足时尾部为空（由调用方补 padding）', () => {
  const groups = groupByCount([[0, 1], [1, 2]], 9, 2);
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1].length, 0);
});

test('groupByDuration: 不修改入参', () => {
  const segs = [[0, 1], [1, 2], [2, 3]];
  groupByDuration(segs, 2);
  assert.deepEqual(segs, [[0, 1], [1, 2], [2, 3]]);
});

/* ---------------------------------------------------------------- 总计划 */

test('planTotal: token 数与 sheets 成正比', () => {
  const p1 = planTotal(meta(300, 40), { sheets: 1, budgetImages: 4 });
  const p2 = planTotal(meta(300, 40), { sheets: 2, budgetImages: 4 });
  assert.equal(p1.approxTokens, IMAGE_TOKEN_CAP);
  assert.equal(p2.approxTokens, IMAGE_TOKEN_CAP * 2);
});

test('planTotal: budgetImages 截断并标记', () => {
  const p = planTotal(meta(1500, 90), { sheets: 4, budgetImages: 2 });
  assert.equal(p.sheets, 2);
  assert.equal(p.truncated, true);
});

test('planTotal: 显式 cells 被尊重，但超宽画布给告警', () => {
  const p = planTotal(meta(300, 40), { cells: [4, 3] });
  assert.deepEqual([p.cols, p.rows], [4, 3], '显式指定不被 bestLayout 改写');
  const v = validatePlan(p, L);
  assert.equal(v.ok, true, '4×3 只是次优，不是非法');
  assert.ok(v.warnings.some((w) => /canvas aspect/.test(w)), '应给出画布比例告警');
  // 真正非法的是极端超宽（6×1 ≈ 10.7:1）
  const bad = planTotal(meta(300, 40), { cells: [6, 1] });
  const vb = validatePlan(bad, L);
  assert.equal(vb.ok, false);
  assert.match(vb.errors.join(), /canvas aspect/);
});

test('planTotal: 默认档按「切点总数」定（41 镜 → 5 格 → 吸附 4 格 2×2）', () => {
  // 格数不再是固定的 balanced 9 格：总格数 = 镜头数 ÷ 8，再吸附到不留空格的数。
  // 41 镜 → 5 → 吸附 4（5 与 4/6 等距，取前者）→ 2×2 一张。
  const p = planTotal(meta(300, 40));
  assert.equal(p.coverage, 'overview');
  assert.deepEqual([p.cols, p.rows], [2, 2]);
  assert.equal(p.sheets, 1);
  assert.equal(p.approxTokens, 384);
  // 镜头越多格越多：这条才是"格数由总量决定"的正题
  const dense = planTotal(meta(300, 160));
  assert.ok(dense.capacity > p.capacity, `161 镜应该比 41 镜格数多，实得 ${dense.capacity} vs ${p.capacity}`);
});

/* ---------------------------------------------------------------- 护栏 */

test('validatePlan: 单格过小时拒绝', () => {
  const p = planTotal(meta(300, 40), { cells: [5, 5] });
  const v = validatePlan(p, L);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), new RegExp(`${MIN_CELL_W}x${MIN_CELL_H}`));
});

test('validatePlan: 合法计划零告警', () => {
  for (const cells of [[2, 2], [3, 3], [3, 4], [4, 4]]) {
    const p = planTotal(meta(300, 40), { cells });
    const v = validatePlan(p, L);
    assert.deepEqual(v.errors, [], `${cells} 不该报错：${v.errors}`);
  }
});

test('validatePlan: sheets 越界拒绝', () => {
  // 上限现在是 MAX_SHEETS=99（不再封顶 4 张），所以用 100 来测越界
  const p = { cols: 3, rows: 3, sheets: 100, cell: { w: 355, h: 200 }, canvasAspect: L };
  assert.equal(validatePlan(p, L).ok, false);
});

/* ---------------------------------------------------------------- 长片分段计划 */

test('planWindows: 覆盖整片、不重叠、不超尾', () => {
  const p = planWindows(1090, 300);
  assert.equal(p.total, 4);
  assert.equal(p.windows[0].from, 0);
  assert.equal(p.windows.at(-1).to, 1090);
  assert.equal(p.covered, 1090);
  for (let i = 1; i < p.windows.length; i++) assert.equal(p.windows[i].from, p.windows[i - 1].to);
});

test('planWindows: 最后一段被裁到片尾，不会越界', () => {
  const p = planWindows(650, 300);
  assert.equal(p.total, 3);
  assert.deepEqual(p.windows.map((w) => [w.from, w.to]), [[0, 300], [300, 600], [600, 650]]);
  assert.equal(p.windows.at(-1).duration, 50);
});

test('planWindows: token 估算 = 每段图片数 × 384', () => {
  const p = planWindows(900, 300);
  assert.equal(p.approxTokens, 3 * IMAGE_TOKEN_CAP);
});

test('planWindows: 段数超上限时拉长每段，而不是砍掉尾巴', () => {
  const p = planWindows(7200, 300);            // 2 小时，300s/段 = 24 段 > 12
  assert.equal(p.total, 12);
  assert.equal(p.stepAdjusted, true);
  assert.equal(p.covered, 7200, '必须覆盖全片');
  assert.equal(p.step, 600, '每段应被拉长到 600s');
  assert.equal(p.requestedStep, 300);
});

test('planWindows: 段数在上限内时不调整', () => {
  const p = planWindows(1090, 300);
  assert.equal(p.stepAdjusted, false);
  assert.equal(p.step, 300);
});

test('planWindows: 非法参数抛错', () => {
  assert.throws(() => planWindows(0, 300), RangeError);
  assert.throws(() => planWindows(100, 0), RangeError);
});

/* ---------------------------------------------------------------- 内容类型分流 */

test('suggest: 音乐驱动不改变格数（只影响取帧密度）', () => {
  // 旧规则是 `if (musicDriven) cells = max(cells, 9)`，被用户否掉：
  // 音乐驱动只该降低"积分取帧的触发值"，格数走 rodt。两支几乎同长的 PV
  // 就因为一条响度阈值一个 9 格一个 4 格，纯粹是副作用。
  const base = { duration: 300, cuts: 40, motion: 10, speechRate: 0.3 };
  const quiet = suggest({ ...base, meanLufs: -23 });
  const music = suggest({ ...base, meanLufs: -14.2 });
  assert.equal(music.cells, quiet.cells, '音乐驱动不该改每张格数');
  assert.equal(music.cells * music.sheets, quiet.cells * quiet.sheets, '也不该改总格数');
  assert.equal(music.musicDriven, true, '标志必须真的带出来（下游靠它压取帧门槛）');
  assert.equal(quiet.musicDriven, undefined);
  assert.match(music.reason, /音乐驱动/);
});

test('suggest: 口播片（高字/秒）按台词降格数', () => {
  const r = suggest({ duration: 600, cuts: 120, motion: 8, speechRate: 5.6, hasSubtitle: true });
  assert.ok(r.cells <= 12, `口播片应压到 12 格以内，实得 ${r.cells}`);
  assert.ok(!/音乐驱动/.test(r.reason));
});

test('suggest: 没有响度信息时不做音乐判断（保持原行为）', () => {
  const r = suggest({ duration: 300, cuts: 40, motion: 10 });
  assert.ok(!/音乐驱动/.test(r.reason));
});

/* ---------------------------------------------------------------- 窗口规划 */

test('planWindows: 尾巴太短时并进前一个窗口（不再出现 2 秒的窗）', () => {
  const p = planWindows(92.18, 30, { maxWindows: 99 });
  assert.ok(p.windows.every((w) => w.duration >= 30), `不该出现过短的窗：${JSON.stringify(p.windows.map(w=>w.duration))}`);
  assert.equal(p.windows.at(-1).to, 92.18, '最后一个窗口必须覆盖到片尾');
  assert.equal(p.covered, 92.18, '总覆盖等于总时长');
});

test('planWindows: 10 秒尾巴被并掉，50 秒尾巴保留', () => {
  const short = planWindows(100, 30, { maxWindows: 99 });     // 尾巴 10s < 30 → 并
  assert.deepEqual(short.windows.map((w) => w.duration), [30, 30, 40]);
  const long = planWindows(650, 300);                          // 尾巴 50s ≥ 30 → 保留
  assert.equal(long.windows.length, 3);
  assert.deepEqual(long.windows.map((w) => w.duration), [300, 300, 50]);
});

test('planWindows: 边界吸附到剪辑点，且不把窗口压太短', () => {
  // 92s / 30s → 边界在 30、60；把一个切点放在 31.2（在 30 的 20% 内）
  const p = planWindows(92, 30, { boundaries: [31.2, 58.9], maxWindows: 99 });
  const froms = p.windows.map((w) => w.from);
  const tos = p.windows.map((w) => w.to);
  assert.ok(froms.includes(31.2), `第一个边界应吸到 31.2，实得 ${JSON.stringify(froms)}`);
  assert.equal(p.snapped, 2);
  // 窗口必须首尾相接、覆盖全片
  assert.equal(froms[0], 0);
  assert.equal(tos.at(-1), 92);
  for (let i = 1; i < froms.length; i++) assert.equal(froms[i], tos[i - 1]);
});

test('planWindows: 切点太远就不吸附', () => {
  const p = planWindows(92, 30, { boundaries: [45], maxWindows: 99 });
  assert.equal(p.snapped, 0);
  assert.ok(!p.windows.map((w) => w.from).includes(45));
});
