/**
 * plan.js — 纯算术层。零 IO、零依赖、可单测。
 *
 * 所有"该切几格、发几张、画布多大、够不够清晰"的判断都在这里，
 * 媒体层（ffmpeg）只负责执行，不参与决策。
 *
 * 关键常量来自实测：
 *  - DSH 单图像素预算 ≈ 640_000（与 dsh-llm-deepseek 的 imagePixelBudget 默认值一致）
 *  - 单图 token 封顶 384（14px patch + 3:1 降采样）
 */

export const PIXEL_BUDGET = 640_000;
export const IMAGE_TOKEN_CAP = 384;
export const MIN_CELL_W = 240;
export const MIN_CELL_H = 135;
export const MAX_SHEETS = 4;
export const DEFAULT_ASPECT = 16 / 9;

/** Content-classification thresholds. Kept in one place so the manifest can report them. */
export const PLAN_THRESHOLDS = Object.freeze({
  musicLufs: -18,
  musicSpeechRate: 1,
  speechRateCut: 3,
});

/** 画布比例 = (cols / rows) × 源比例。方形宫格才会还原源比例。 */
export const canvasAspect = (cols, rows, aspect) => (cols / rows) * aspect;

/**
 * 给定格数 n 与源比例，选一组 (cols, rows) 使画布比例最接近源比例。
 * - 允许 cols*rows >= n（多余位置补灰格），所以非平方数也不会被硬塞成怪形状
 * - 同分时略偏袒"更高"的画布：超宽画布被方形/16:9 编码器裁掉的部分更多
 */
export function bestLayout(n, aspect = DEFAULT_ASPECT) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (!(aspect > 0)) throw new RangeError(`aspect must be > 0, got ${aspect}`);
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const canvas = canvasAspect(cols, rows, aspect);
    let cost = Math.abs(Math.log(canvas / aspect));
    if (canvas > aspect) cost += 0.12;
    const padded = cols * rows - n;
    const key = [Math.round((cost + 0.15 * padded) * 1e6) / 1e6, cols * rows];
    if (best === null || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
      best = { key, cols, rows };
    }
  }
  const { cols, rows } = best;
  return { cols, rows, capacity: cols * rows, canvasAspect: canvasAspect(cols, rows, aspect) };
}

/** coverage 档位 → 建议格数（n 由 bestLayout 决定具体行列）。显式指定时用它覆盖自动推荐。 */
export const COVERAGE = {
  overview: 4,
  balanced: 9,
  detailed: 12,
  timeline: 16,
};

/**
 * 从廉价元数据推导建议：多少格、几张。
 *
 * 依据实测（B站 5 分钟镜头密集素材，1920×1080）：
 *  - 9 格（33s/格）大量重复的草地镜头；16 格（19s/格）才把产品、人物、采访都覆盖到
 *  - 所以格数不该按"时长÷固定值"硬算，而是按"每格看多少秒"反推，且不超过镜头数
 *  - 镜头密集（均镜头 <4s）时每格 15s，否则 40s
 *
 * 每格看多少秒由**画面变化密度**决定（不是由切点数量，因为切点数量已被速率法归一化）：
 *  - motion（分数 p90）≥15 ：快剪，12s/格
 *  - 5 ≤ motion < 15    ：中等，20s/格
 *  - motion < 5         ：静，40s/格
 * 实测：B-roll 类 p90=7.9→16 格（19s/格）；快剪 PV p90=26→9 格；静态单镜头 p90=2.2→4 格。
 *
 * @param {{duration:number, cuts?:number, motion?:number, aspect?:number,
 *          hasSubtitle?:boolean, speechRate?:number}} meta
 *   motion：scanSummary().p90，拿不到就退回按均镜头长估
 *   speechRate：台词字数/秒（有字幕或 ASR 时才有；没有就传 0）
 */
export function suggest(meta) {
  const { duration, cuts = 0, motion, speechRate = 0, hasSubtitle = false, meanLufs } = meta;
  // 阈值可覆盖：不同母带的响度能差 9 LU（实测 −23 … −14），写死的常数换一批片源就会误判。
  const T = { ...PLAN_THRESHOLDS, ...(meta.thresholds ?? {}) };
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const shots = Math.max(1, cuts + 1);
  const avgShot = duration / shots;

  if (shots <= 1) {
    return pick('overview', 4, 1,
      `单镜头 ${(duration / 60).toFixed(1)}min → 视觉切分无用；建议配合台词，或直接用 zoom 看某几秒`);
  }
  if (duration <= 90) {
    return pick('overview', 4, 1, `${duration.toFixed(0)}s、${shots} 个镜头 → 4 帧足够概览`);
  }

  const perCell = typeof motion === 'number'
    ? (motion >= 15 ? 12 : motion >= 5 ? 20 : 40)
    : (avgShot < 4 ? 15 : 40);
  // 内容类型分流（实测基准）：口播片最轻最吵（5.6 字/秒 @ −23 LUFS），音乐片最响最静
  // （0.3 字/秒 @ −14.2 LUFS）。响度与字/秒是反向的，两个一起看比任何主观判断都准。
  const musicDriven = Number.isFinite(meanLufs)
    && meanLufs > T.musicLufs
    && speechRate < T.musicSpeechRate;

  let cells = Math.round(duration / perCell);
  cells = Math.min(cells, shots);            // 格数不该超过镜头数
  if (musicDriven) cells = Math.max(cells, 9);  // 音乐片的信息在画面上，别把格数压太低
  cells = snapCells(clamp(cells, 4, 16));
  if (!musicDriven && (hasSubtitle || speechRate > 0)
    && speechRate > T.speechRateCut) {
    cells = snapCells(clamp(Math.round(cells * 0.6), 4, 12));   // 台词承担信息，图只做锚点
  }

  let sheets = 1;
  if (duration > 1200) sheets = Math.min(MAX_SHEETS, Math.ceil(duration / 300));
  else if (duration > 600) sheets = 2;

  const label = cells <= 4 ? 'overview' : cells <= 9 ? 'balanced' : cells <= 12 ? 'detailed' : 'timeline';
  const pace = typeof motion === 'number'
    ? `画面变化 p90=${motion.toFixed(1)}（${perCell}s/格）`
    : `均镜头 ${avgShot.toFixed(1)}s（${perCell}s/格）`;
  return pick(label, cells, sheets,
    `${duration.toFixed(0)}s、${shots} 个镜头、${pace} → ${cells} 格 × ${sheets} 张（≈${Math.round(duration / (cells * sheets))}s/格）` +
    (musicDriven ? '·音乐驱动，画面承担信息' : ''));
}

/** 吸附到"能整除成好布局"的格数，避免出现大量 padding（8→9 比 8+1 空格好） */
export const SNAP_CELLS = [4, 6, 9, 12, 16];
export function snapCells(n) {
  let best = SNAP_CELLS[0];
  for (const c of SNAP_CELLS) if (Math.abs(c - n) < Math.abs(best - n)) best = c;
  return best;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function pick(label, cells, sheets, reason) {
  return { coverage: label, cells, sheets, reason };
}

/** 按数量均分（用于"已用 fitSegments 调好段数"的场景，保证每张图正好填满） */
export function groupByCount(segs, per, sheets = 1) {
  const out = [];
  for (let s = 0; s < sheets; s++) out.push(segs.slice(s * per, (s + 1) * per));
  return out;
}

/**
 * 把有序段列表切成 sheets 组，使每组覆盖时长尽量相等；切点只落在段边界（不劈镜头）。
 * 注意：不保证每组段数相同，可能出现空格（padding）。如果你已经 fitSegments 到
 * per×sheets，请用 groupByCount，那样不会浪费格位。
 * @param {Array<[number, number]>} segs 有序、不重叠的 [t0, t1]
 */
export function groupByDuration(segs, sheets) {
  if (!Array.isArray(segs)) throw new TypeError('segs must be an array');
  if (sheets <= 1) return [segs.slice()];
  const total = segs.reduce((sum, [a, b]) => sum + (b - a), 0);
  const target = total / sheets;
  const groups = [];
  let cur = [];
  let acc = 0;
  let left = sheets;
  for (let i = 0; i < segs.length; i++) {
    cur.push(segs[i]);
    acc += segs[i][1] - segs[i][0];
    const restSegs = segs.length - (i + 1);
    if (left > 1 && acc >= target && restSegs >= left - 1) {
      groups.push(cur);
      cur = [];
      acc = 0;
      left -= 1;
    }
  }
  if (cur.length > 0) groups.push(cur);
  while (groups.length < sheets) groups.push([]);
  return groups.slice(0, sheets);
}

/** 单格像素尺寸（按预算与布局推导）。 */
export function cellSize(cols, rows, aspect = DEFAULT_ASPECT, budget = PIXEL_BUDGET) {
  const area = budget / (cols * rows);
  const w = Math.round(Math.sqrt(area * aspect));
  return { w, h: Math.round(w / aspect), area: Math.round(area) };
}

/**
 * 生成一次完整的出图计划。
 * 显式给 cells: [m,n] 时尊重调用方；只给 coverage 时由 bestLayout 决定行列。
 */
export function planTotal(meta, opts = {}) {
  const s = suggest(meta);
  const aspect = meta.aspect ?? DEFAULT_ASPECT;
  const coverage = opts.coverage ?? s.coverage;
  const budgetImages = Math.min(MAX_SHEETS, opts.budgetImages ?? MAX_SHEETS);

  let cols;
  let rows;
  if (Array.isArray(opts.cells) && opts.cells.length === 2) {
    [cols, rows] = opts.cells.map(Number);
  } else {
    const n = opts.cells ?? (opts.coverage ? COVERAGE[opts.coverage] : s.cells);
    ({ cols, rows } = bestLayout(Number(n), aspect));
  }

  let sheets = Math.max(1, opts.sheets ?? s.sheets);
  const truncated = sheets > budgetImages;
  if (truncated) sheets = budgetImages;

  const cell = cellSize(cols, rows, aspect);
  return {
    cols,
    rows,
    capacity: cols * rows,
    sheets,
    coverage,
    cell,
    canvasAspect: canvasAspect(cols, rows, aspect),
    images: sheets,
    approxTokens: sheets * IMAGE_TOKEN_CAP,
    truncated,
    reason: s.reason,
  };
}

/**
 * 把长片切成 N 个窗口，供"分段看"用。**在扫描之前**就要能算，
 * 所以格数只能按时长估（每格约 20s），是预估值，不是最终值。
 *
 * @param {number} duration 全片时长（秒）
 * @param {number} step 每段最长多少秒
 * @param {{cells?:number, maxWindows?:number}} opts
 */
export function planWindows(duration, step = 300, {
  cells, maxWindows = 12, boundaries = [], snapRatio = 0.2,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  if (!(step > 0)) throw new RangeError(`step must be > 0, got ${step}`);
  // 段数超上限时不是"砍掉尾巴"，而是把每段拉长，保证覆盖全片
  let span = step;
  let total = Math.ceil(duration / span);
  let stepAdjusted = false;
  if (total > maxWindows) {
    span = duration / maxWindows;
    total = maxWindows;
    stepAdjusted = true;
  }
  total = Math.max(1, total);
  // 尾巴短于 30 秒就并进前一个窗口：92s 按 30s 切会剩一个 2.18s 的窗口，只够 1 格，
  // 白白多花 384 token 换一张几乎没信息的图。用绝对阈值（而不是按比例），
  // 这样 650s/300s 那种 50s 的尾巴不会被无谓地并掉。
  if (total > 1) {
    const tail = duration - (total - 1) * span;
    if (tail < 30) total -= 1;
  }
  const windows = [];
  for (let i = 0; i < total; i++) {
    const from = +(i * span).toFixed(2);
    // 最后一个窗口吸收剩下的全部（含被并掉的尾巴）
    const to = i === total - 1 ? +duration.toFixed(2) : +Math.min(duration, from + span).toFixed(2);
    const len = to - from;
    const n = cells ?? snapCells(Math.max(4, Math.round(len / 20)));
    const images = 1;
    windows.push({
      index: i + 1, from, to, duration: +len.toFixed(2),
      cells: n, images, approxTokens: images * IMAGE_TOKEN_CAP,
    });
  }
  // 窗口边界吸附到最近的剪辑点：按钟表切会把一句话劈成两半，
  // 按内容切则每个窗口都是"几个完整镜头"。只吸附到 step×snapRatio 以内的点，
  // 太远就不动（否则窗口长度会失控）。
  let snapped = 0;
  if (boundaries.length > 0 && windows.length > 1) {
    const sorted = [...boundaries].filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
    const limit = span * snapRatio;
    for (let i = 1; i < windows.length; i++) {
      const target = windows[i].from;
      let best = null;
      let bestD = limit;
      for (const t of sorted) {
        const d = Math.abs(t - target);
        if (d < bestD) { best = t; bestD = d; }
      }
      if (best === null) continue;
      const prevFrom = windows[i - 1].from;
      if (best - prevFrom < span * 0.3) continue;      // 别把窗口压得太短
      windows[i].from = +best.toFixed(2);
      windows[i - 1].to = +best.toFixed(2);
      windows[i].duration = +(windows[i].to - windows[i].from).toFixed(2);
      windows[i - 1].duration = +(windows[i - 1].to - windows[i - 1].from).toFixed(2);
      snapped += 1;
    }
  }

  return {
    total,
    snapped,
    step: +span.toFixed(2),
    requestedStep: step,
    stepAdjusted,
    covered: +windows.reduce((sum, w) => sum + w.duration, 0).toFixed(2),
    windows,
    approxTokens: windows.reduce((sum, w) => sum + w.approxTokens, 0),
  };
}

/** 护栏：不可商量的硬约束，写死在工具里，不靠模型自觉。 */
export function validatePlan(plan, aspect = DEFAULT_ASPECT) {
  const errors = [];
  const warnings = [];
  const { cols, rows, sheets, cell } = plan;
  if (cols < 1 || rows < 1) errors.push('cols/rows must be >= 1');
  if (cell.w < MIN_CELL_W || cell.h < MIN_CELL_H) {
    errors.push(`cell ${cell.w}x${cell.h} below minimum ${MIN_CELL_W}x${MIN_CELL_H}; reduce cells or add sheets`);
  }
  const ratio = plan.canvasAspect / aspect;
  if (ratio > 1.5 || ratio < 0.6) {
    errors.push(`canvas aspect ${plan.canvasAspect.toFixed(2)} deviates too far from source ${aspect.toFixed(2)}`);
  } else if (ratio > 1.25 || ratio < 0.8) {
    warnings.push(`canvas aspect ${plan.canvasAspect.toFixed(2)} is off source ${aspect.toFixed(2)}; ` +
      `auto layout would pick a friendlier shape`);
  }
  if (sheets < 1 || sheets > MAX_SHEETS) errors.push(`sheets must be 1..${MAX_SHEETS}`);
  return { ok: errors.length === 0, errors, warnings };
}
