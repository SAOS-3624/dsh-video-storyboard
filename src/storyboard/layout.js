/**
 * layout.js — **排布决策**：这一趟要几张图、每张几格、时间轴怎么切成格。
 *
 * 从 pipeline.js 抽出来的（2026-10-31）。抽它不是为了结构好看，是因为这一段的真实形态是
 * **一对标量 × 两份数组互相推导**：
 *
 *     cells/sheets（每张几格 / 几张）
 *        └─ planRanges(cells*sheets) ──► cellRanges（格点，按时间排好）
 *              └─ 补满布局容量 ──► 改 cellRanges
 *                    └─ splitSheets ──► groups（每张一组）
 *                          └─ sheets = groups.length ──► 回头改标量
 *
 * 于是同一组数字在 pipeline 里被写了五遍，每一遍都要顺手把另一侧"修好"；清单里的 `reason`
 * 记的是初值、`trace` 记的才是真实过程，两者经常对不上（交接文档 §5 #1）。
 *
 * 这一层只做算术：输入是已经算好的切点 / 统计量 / 几何参数，输出是一份排布方案。
 * 不扫、不取帧、不写盘 —— 所以它能单测，pipeline 也能整段跳过渲染（textOnly）。
 *
 * **判据一条都没改**：下面每个函数的顺序、表达式、常数都是从 pipeline 原样搬过来的。
 * 验收靠 PNG sha256 对比（同一部片、同一组参数，重构前后出图必须逐字节相同），
 * 而不是"看着对"。
 */

import { allocateIntegerBudget, fillLayout, maxCellsForNeed, shapeFromTotal } from './plan.js';
import { planByRodt, planSheetsByFrames } from './density.js';
import { fitSegments, segmentsFromCuts } from './segments.js';
import { measureGroup, subBudgetFor } from './measure.js';

/**
 * @param {object} o
 * @param {number} o.winStart       窗口起点（绝对秒）。密度分支要把它加回格点。
 * @param {number} o.winDur         窗口长度
 * @param {number[]} o.relCuts      相对窗口的切点（秒）
 * @param {number} [o.p90]          全窗口画面变化 p90（<1 判"近乎静止"）
 * @param {Array} [o.darkRuns]      扫描时算好的黑场区间（绝对时间）
 * @param {Array} [o.stats]         逐帧分数（喂 measure，不给就退回 meanMotion 判据）
 * @param {boolean} [o.adaptive]    是否按密度挪格（false = 均分）
 * @param {number} [o.minGap]       取帧最小间隔（并段用）
 * @param {number} [o.cellsIn]      调用方显式格数（0 = 自动）
 * @param {number} [o.sheetsIn]     调用方显式张数（0 = 自动）
 * @param {number} [o.maxPerSheet]  单张最多几格（board.boardGeometry 推出来的）
 * @param {object|null} [o.suggestion] plan.suggest() 的结果（cellsIn=0 时用）
 * @param {number} o.aspect         源画面比例
 * @param {number} o.budget         单图像素预算
 * @param {string} [o.need]         目标可读性（推子帧下限）
 * @param {boolean} [o.audioStrip]  底部有没有音频条带（要扣 10% 预算）
 * @param {boolean} [o.musicDriven]
 * @param {Array} [o.cuts]          真切点（绝对时间，喂 measure）
 * @param {number[]} [o.sampleMarks] 积分采样点（绝对时间）
 * @param {object} [o.printCtx]     { prints, fps, printOffset } —— 逐帧指纹
 * @param {boolean} [o.noTile]      cells:1 的语义：禁止格内摊开
 * @param {string[]} [o.trace]      调用方的 trace 数组（就地追加）
 * @returns {{cells:number, sheets:number, autoPlan:boolean, noTiling:boolean,
 *            filledFrom:number|null, requested:{cells:number,sheets:number},
 *            plannedCells:number, cellRanges:Array, groups:Array<string[]>,
 *            trace:string[], frames:number, perSheetCap:number}}
 */
export function planLayout({
  winStart = 0, winDur, relCuts = [],
  p90 = 0, darkRuns = [], stats = [],
  adaptive = true, minGap = 1.2,
  cellsIn = 0, sheetsIn = 0, maxPerSheet = 16,
  suggestion = null,
  aspect, budget, need, audioStrip = false, musicDriven = false,
  cuts = [], sampleMarks = [], printCtx = {}, noTile = false,
  trace = [],
} = {}) {
  // ---- 起点：调用方显式给了格数就尊重它，否则用 suggest() 的**总格数**建议
  let cells = Math.max(0, Number(cellsIn) || 0);
  let sheets = Math.max(0, Number(sheetsIn) || 0);
  const autoPlan = cells === 0;

  // 单张上限要先算出来：suggest 只给"总共想铺多少格"，摊成几张由这里按真实上限折算
  // （原来是 suggest 自己折一遍、这里再折一遍，于是"建议 6 格 / 实际 9 格"成了常态）。
  const derivedCap = maxCellsForNeed(budget, aspect, need);
  const perSheetCap = Math.max(
    1,
    Math.min(16, Math.max(Number(maxPerSheet) || derivedCap, Number(cells) || 0)),
  );

  if (cells === 0) {
    const shape = shapeFromTotal(suggestion.totalCells, perSheetCap);
    cells = shape.cells;
    sheets = shape.sheets;
  }
  sheets = sheets || 1;

  // 记录"你原本要了什么"，和最终生效值分开 —— 否则事后没法判断
  // "9 格"是用户要的、还是算法补出来的。
  const requested = { cells: cells * Math.max(1, sheets), sheets: Math.max(1, sheets) };

  // ---- 格数**往上补满**：5 格排 2×3 会空一个黑位，空格和画面占同一张画布、同样的 token。
  const fitted = fillLayout(cells, aspect);
  const filledFrom = fitted.cells > cells ? cells : null;
  if (filledFrom) trace.push(`cells-filled:${filledFrom}->${fitted.cells}`);
  cells = fitted.cells;

  // **cells:1 就真的给一帧**。旧版即使只要 1 格，格内摊开逻辑也会把它拼成 2×2，
  // 清单却写"1 cell" —— 模型以为看到的是一帧，其实是四帧拼图。
  const noTiling = noTile === true || (cells === 1 && sheets === 1);

  // ---- 黑场格：额外占格，但要封顶。
  // 一格纯黑几乎不带信息，却和真帧占同样的画布和 token。实测概念 PV（90 秒）有 6 段
  // ≥2 秒黑场，不封顶就要拿 6 格去画黑屏 —— 整张图一半是黑的，盲评"代表/冗余"直接掉分。
  // 封顶 25%（至少 1 格、最多 4 格），多出来的黑场并入相邻内容格。
  const darkCap = Math.min(4, Math.max(1, Math.floor(Math.max(1, cells * sheets) * 0.25)));
  const darkRunsKept = darkRuns.slice(0, darkCap);
  // 黑场是从"内容格数"里抠出来的（每段独占一格），所以总段数会比原计划多。
  const extraDark = (adaptive && relCuts.length > 0 && p90 >= 1) ? darkRunsKept.length : 0;

  // 按给定总格数排一遍 → [{from,to,density,dark}]。抽成函数是为了能"补满后重排一次"。
  const planRanges = (total) => {
    // **近乎静止的素材不吃"变化量"这套**。
    // rodt / 积分采样点的前提是"变化多的地方更值得看"，可当整片 p90 < 1（讲义、监控、
    // 固定机位口播）时，切点集中在少数几页翻页动画上，按密度分格就会把格位堆在那几页，
    // 出来一堆几乎一样的幻灯片（实测：66 分钟讲座 16 格里有 6 格是同一页的不同配色）。
    // 这种素材没有任何"更值得看"的区域，均匀铺开才是对的 —— 退回按时间等分。
    const nearStatic = p90 < 1;
    if (adaptive && relCuts.length > 0 && !nearStatic) {
      let segRanges;
      if (darkRunsKept.length > 0) {
        // **黑场单独成段**：黑屏在分数上几乎是 0（前后都黑，没有"变化"），永远不会被当成切点，
        // 于是它和后面的 logo/正片挤在同一格里，而那一格取中点数 —— 正好落在黑里，整格纯黑。
        const parts = [];
        let cursor = 0;
        for (const d of darkRunsKept) {
          if (d.from > cursor + 0.5) parts.push({ from: cursor, to: d.from, dark: false });
          parts.push({ from: d.from, to: Math.min(d.to, winDur), dark: true });
          cursor = Math.min(d.to, winDur);
        }
        if (cursor < winDur - 0.5) parts.push({ from: cursor, to: winDur, dark: false });

        // 黑场**额外占格**，不从内容格数里扣 —— 否则 4 段黑场就把 4 格吃光，
        // 剩下 65 秒的内容挤成一格。多出来的格由调用方"补满到布局容量"吸收。
        const contentTotal = Math.max(1, total);
        const countIn = (p2) => relCuts.filter((c) => c >= p2.from && c < p2.to).length;
        // **各段配额必须精确加总到 contentTotal**（最大余额法）。以前每段各自 round + max(1)，
        // 一段一段往上报，总和可以超出（实测轴承 24 格算出 25 段）。
        const contentParts = parts.filter((x) => !x.dark);
        const shares = allocateIntegerBudget(contentTotal, contentParts.map(countIn), { min: 1 });
        let ci = 0;

        segRanges = [];
        for (const p2 of parts) {
          if (p2.dark) {
            segRanges.push({ from: p2.from, to: p2.to, density: 0, dark: true });
            continue;
          }
          // 内容区按各自占的刀数比例分格，内部仍用 rodt
          const share = shares[ci++] ?? 1;
          const rs = planByRodt({
            duration: p2.to - p2.from,
            cuts: relCuts.filter((c) => c >= p2.from && c < p2.to).map((c) => c - p2.from),
            cells: share,
          });
          segRanges.push(...rs.map((r) => ({ from: r.from + p2.from, to: r.to + p2.from, density: r.density })));
        }
        segRanges.sort((a, b) => a.from - b.from);
      } else {
        // **rodt**：每格长度 = 常数 ÷ 该处的切点密度（B = K/A）。
        // 一分钟切 70 刀的地方一格 5 秒，一分钟才 18 刀的地方一格 24 秒 —— 实测相差 4.6~5.5 倍。
        // 而且因为用"累积切点等分"实现，每格的镜头数也顺带均匀，不用再单独约束。
        segRanges = planByRodt({ duration: winDur, cuts: relCuts, cells: total });
      }
      return segRanges
        .map((r) => ({ from: r.from + winStart, to: r.to + winStart, density: r.density, dark: r.dark === true }));
    }
    const segs = segmentsFromCuts(winDur, relCuts, 0.4, winStart);
    return fitSegments(segs, total, { minGap })
      .map(([a, b]) => ({ from: a, to: b, density: 1 }));
  };
  const planToCapacity = (cap) => planRanges(Math.max(1, cap - extraDark));

  const plannedCells = cells * sheets;
  let cellRanges = planRanges(plannedCells);

  // 黑场格是"额外占格"，但**不能因为多一格就多买一张图**：48 格 3 张本来是满的，
  // 多一个黑场格就变成 49 格 → 4 张 → 多花 384 图像 token，只为了画一块黑屏。
  // 这种情况把内容让出一格（内容 47 + 黑场 1 = 48），张数不变。
  //
  // **上限只能有一个来源**：调用方没给就按 `budget + need` 推（和 board.boardGeometry
  // 走同一个函数）。以前这里缺省写死 16，于是"直接调 runStoryboard"和"走 CLI/工具"
  // 对同一个 budget 给出两种几何 —— 那正是这一轮要把口径收掉的东西。
  // **显式 cells 不能被这个上限切碎**：调用方说"一张 16 格"，就不能因为默认上限是 12
  // 而把它拆成两张各 8 格 —— 那是另一个决定，必须由调用方自己做。
  // （perSheetCap 已在函数开头算好，上面折 suggest 的总格数时就要用它。）
  const sheetsAt = (n) => Math.ceil(Math.max(1, n) / perSheetCap);
  if (extraDark > 0 && sheetsAt(cellRanges.length) > sheetsAt(plannedCells)) {
    const trimmed = planRanges(Math.max(1, plannedCells - extraDark));
    if (sheetsAt(trimmed.length) <= sheetsAt(plannedCells)) {
      trace.push(`dark-trimmed:${cellRanges.length}->${trimmed.length}`);
      cellRanges = trimmed;
    }
  }
  // 另一种溢出：`fitSegments` 在极短尾段上会多给一格（讲座 48 → 49），跨过 16 的边界 → 4 张。
  // 把末尾两格并成一格（时间覆盖不变，只是少一次取样）。
  if (!(Number(sheetsIn) > 0)) {
    let merged = 0;
    while (cellRanges.length > plannedCells
      && sheetsAt(cellRanges.length) > sheetsAt(plannedCells)
      && cellRanges.length >= 2) {
      const a = cellRanges[cellRanges.length - 2];
      const b = cellRanges[cellRanges.length - 1];
      cellRanges.splice(-2, 2, {
        from: a.from, to: b.to,
        density: (a.density + b.density) / 2,
        ...(a.dark && b.dark ? { dark: true } : {}),
      });
      merged += 1;
    }
    if (merged > 0) trace.push(`tail-merged:${merged}`);
  }
  // ---- 把"因为取整而空出来的格位"填成真帧（只对自动张数生效：显式 `--sheets` 要精确张数）
  if (!(Number(sheetsIn) > 0) && cellRanges.length > 0) {
    const cap = fillLayout(cellRanges.length, aspect).cells;
    if (cap > cellRanges.length) {
      const retried = planToCapacity(cap);
      // 补满**不得把格数顶过一张图的边界**：48 格 3 张是满的，补成 49 就要第 4 张。
      if (retried.length > cellRanges.length
        && sheetsAt(retried.length) <= sheetsAt(plannedCells)) {
        cellRanges = retried;
      } else if (retried.length > cellRanges.length) {
        trace.push(`skip-fill-would-add-sheet:${cellRanges.length}->${retried.length}`);
      }
    }
  }
  if (cellRanges.length !== plannedCells) trace.push(`ranges:${plannedCells}->${cellRanges.length}`);
  if (cellRanges.length > cells * sheets) cells = Math.ceil(cellRanges.length / sheets);

  // ---- 先排好画面，再按累计帧数切 sheet（流程的最后一步）。
  // 一格不摊是 1 帧、摊 3×3 是 9 帧，格数一样但信息量差 9 倍，所以只能按"贡献多少帧"切。
  // 切的是格点边界（= 切点），上一张末尾切点就是下一张起点，天然衔接不断裂。
  //
  // 子帧预算只跟"这张图有几种格子"有关，**不再看这一趟有几刀** ——
  // 那曾经是第三个统计量（另外两个是 chooseSubGrid 的格内证据、shrinkToBudget 的刀/秒）。
  const budgetFor = (n) => subBudgetFor({ cells: n });

  const splitSheets = (ranges) => {
    if (Number(sheetsIn) > 0) {
      // 调用方显式指定了张数（测试、批量脚本）就尊重它，仍按格数均分
      const out = [];
      for (let i = 0; i < sheets; i++) out.push(ranges.slice(i * cells, (i + 1) * cells));
      return out;
    }
    // 没指定张数 → 按累计帧数切（自适应）。
    // **必须先真量一遍**：每格产生几帧取决于它真实的格子像素（layoutCanvas），
    // 用 250×140 这种假尺寸估出来的 k 与渲染时不一致 —— 那是"按错的帧数切张"。
    const measured = measureGroup(ranges, {
      aspect, budget, audioStrip, musicDriven,
      subBudget: budgetFor(Math.min(16, ranges.length)), cuts, sampleMarks, stats,
      need, ...printCtx,
      ...(noTiling ? { maxK: 1 } : {}),
    });
    // frameBudget 卡的是**渲染时间**，不是 token：一张图 9 格摊满 3×3 是 81 帧，
    // 而 token 还是按张算。设 64 时"9 格全摊开"会被判成要 2 张，补满逻辑再把 2 张压成
    // 12 格 1 张，格子从 331×184 缩到 286×159，反而摊不动 3×3（95×53 < 110）。
    // 96 让常见的 9 格 / 12 格满摊都留在同一张里。
    return planSheetsByFrames(measured.cells, { frameBudget: 96, maxCellsPerSheet: perSheetCap });
  };
  let groups = splitSheets(cellRanges);

  // ---- 每张图也要**补满布局容量**：切张按帧预算均分，均分出来常是 13 格 → 排 4×4 空 3 个黑位。
  // 黑位和真帧占同一张画布、扣同一份 token。最多两轮、只往上补。
  if (!(Number(sheetsIn) > 0) && groups.length > 0) {
    for (let pass = 0; pass < 2; pass += 1) {
      const short = groups.some((g) => g.length > 0 && g.length < fillLayout(g.length, aspect).cells);
      if (!short) break;
      const cap = Math.max(...groups.map((g) => fillLayout(Math.max(1, g.length), aspect).cells));
      const total = cap * groups.length;
      if (total <= cellRanges.length) break;
      const re = planToCapacity(total);
      if (re.length < total) break;
      const nextGroups = splitSheets(re);
      if (nextGroups.some((g) => g.length === 0)) break;
      // **补满空格不得新增 sheet**：多一张图就是多一份图像 token，那不是"同 token 优化"，
      // 是偷偷加预算（讲座 48 格 3 张 → 64 格 4 张就是这种）。
      if (nextGroups.length > groups.length) {
        trace.push(`skip-refill-would-add-sheet:${groups.length}->${nextGroups.length}`);
        break;
      }
      trace.push(`sheets-refilled:${cellRanges.length}->${re.length}`);
      cellRanges = re;
      groups = nextGroups;
    }
  }
  sheets = groups.length;
  if (cellRanges.length > cells * sheets) cells = Math.ceil(cellRanges.length / sheets);
  // 建议是"4 格 × 3 张"，按帧预算切张后可能变成"6 格 × 2 张" —— 两个都写进 trace，
  // 否则 reason 里的数字和首行对不上，模型会以为哪里出错了。
  if (requested.sheets !== sheets) trace.push(`sheets:${requested.sheets}->${sheets}`);

  // **只量一次**：这张图的布局、每格 k、总帧数都由同一次 measureGroup 给出。
  // 旧的写法是"算 frames 时量一遍、渲染前再量一遍"，参数一样、结果一样，纯白算一份；
  // 更糟的是两处参数一旦漂移（比如漏传 printCtx），切张的 k 就和渲染的 k 不同 ——
  // 那正是 measure.js 成立的原因（切张按错的帧数切）。
  const measurements = groups.map((g) => measureGroup(g, {
    aspect, budget, audioStrip, musicDriven,
    subBudget: budgetFor(g.length), cuts, sampleMarks, stats,
    need, ...printCtx,
    ...(noTiling ? { maxK: 1 } : {}),
  }));
  const frames = measurements.reduce((n, m) => n + m.frameCount, 0);

  return {
    cells, sheets, autoPlan, noTiling, filledFrom, requested,
    plannedCells, cellRanges, groups, trace, frames, perSheetCap,
    // 与 groups 一一对应的测量结果：渲染直接用它，不要再自己算一遍
    measurements,
  };
}
