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
export const MAX_SHEETS = 99;   // 不封顶：片长决定张数（每 5 分钟一张），token 随片长线性增长
export const DEFAULT_ASPECT = 16 / 9;

/**
 * Content-classification thresholds. Kept in one place so the manifest can report them.
 *
 * `musicLufs` 从 -18 放宽到 -22（2026-10-30 实测打脸）：
 * 原来的 -18 是从"口播 -23 / 音乐 -14.2"两个极端样本的中点划的，**中间地带从没有样本**。
 * 《记忆管理局》正式 PV 是纯音乐快剪，母带 -18.4 —— 差 0.4 没过线，于是整片按"有字"处理，
 * 一格不摊，90 秒只有 9 个画面；同一作者的《概念 PV》(-14.2) 却有 33 个。两支差 3.7 倍。
 * 响度不是"有没有字"的可靠代理：它反映母带电平，不反映内容。
 * 口播片普遍在 -23（实测基准），留 1 LU 余量取 -22。
 */
export const PLAN_THRESHOLDS = Object.freeze({
  musicLufs: -22,
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

/**
 * 把"想要 n 格"补到布局能盛下的整格数。
 *
 * 为什么：5 格会排成 2×3（容量 6），右下留一个空格。空格和画面占的是**同一张画布、
 * 同样的 token** —— 空着等于白丢一帧，纯损失。所以只往上补，绝不往下砍。
 *
 * 5 → 6、7 → 9、10 → 12、14 → 16；4/6/9/12/16 本来就是整格，不动。
 * 补出来的数自己是 cols×rows 的乘积，再算一次布局通常就稳定了（最多再一轮）。
 *
 * **它只解决"因为布局取整而空出来的格"**。如果 minGap / 素材太短导致取不到那么多帧，
 * 那属于几何上给不出，仍然会补灰 —— 那是事实，不是取整。
 */
export function fillLayout(n, aspect = DEFAULT_ASPECT) {
  const requested = Math.max(1, Math.round(Number(n) || 0));
  let cells = requested;
  let layout = bestLayout(cells, aspect);
  for (let i = 0; i < 3 && layout.capacity > cells; i += 1) {
    cells = layout.capacity;
    layout = bestLayout(cells, aspect);
  }
  return { ...layout, cells, requested };
}

/** coverage 档位 → 建议格数（n 由 bestLayout 决定具体行列）。显式指定时用它覆盖自动推荐。 */
export const COVERAGE = {
  overview: 4,
  balanced: 9,
  detailed: 12,
  timeline: 16,
};

/**
 * 音乐驱动判据：**响度高 + 几乎不说话**。
 * 实测基准：口播片最轻最吵（5.6 字/秒 @ −23 LUFS），音乐片最响最静（0.3 字/秒 @ −14.2 LUFS）。
 * 两个信号反向，一起看比任何主观判断都准。
 *
 * 它**只表示"这片子的信息全在画面上"**，因此只该影响"取帧密不密"（摊开门槛 / 积分触发值），
 * 不该影响格数 —— 格数走 rodt，由切点密度决定。
 */
export function isMusicDriven({ meanLufs, speechRate = 0, thresholds } = {}) {
  const T = { ...PLAN_THRESHOLDS, ...(thresholds ?? {}) };
  return Number.isFinite(meanLufs) && meanLufs > T.musicLufs && speechRate < T.musicSpeechRate;
}

/**
 * 从廉价元数据推导建议：多少格、几张。
 *
 * 依据实测（B站 5 分钟镜头密集素材，1920×1080）：
 *  - 9 格（33s/格）大量重复的草地镜头；16 格（19s/格）才把产品、人物、采访都覆盖到
 *  - 所以格数不该按"时长÷固定值"硬算，而是按"每格看多少秒"反推，且不超过镜头数
 *  - 镜头密集（均镜头 <4s）时每格 15s，否则 40s
 *
 * 每格看多少秒由**画面变化 p90** 连续决定（40 - p90，夹 8~45），不再三档硬切：
 * 实测 B-roll 类 p90=7.9、快剪 PV p90=26、静态单镜头 p90=2.2 都能落在合理档位。
 *
 * @param {{duration:number, cuts?:number, motion?:number, aspect?:number,
 *          hasSubtitle?:boolean, speechRate?:number, meanLufs?:number, thresholds?:object}} meta
 *   motion：scanSummary().p90，拿不到就退回按均镜头长估
 *   speechRate：台词字数/秒（有字幕或 ASR 时才有；没有就传 0）
 *   meanLufs：整片平均响度，用来判"音乐驱动"（只影响取帧，不影响格数）
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
  // "短就 4 格"只对**内容简单**的短片成立。这条规则原来只看时长，于是 90 秒 41 个镜头的
  // 概念 PV 被一句"4 帧足够概览"打发了 —— 那是这支片子最需要细看的时候。
  // 现在要求镜头数也少，才认为是"真的能一眼看全"。
  if (duration <= 90 && shots <= 8) {
    return pick('overview', 4, 1, `${duration.toFixed(0)}s、${shots} 个镜头 → 4 帧足够概览`);
  }

  // 每格多少秒，只看**画面变化 p90**。
  // 曾经试过再叠加一个"剪辑密度（刀/秒）取更密者"，想让快剪 PV 拿到更多格 ——
  // 实测反而更差：概念 PV 会被推到 12 格，每格只剩 3~4 个镜头，摊开也覆盖不住，
  // 一张图只能展示 36 个画面；而 9 格（每格 4~5 镜）配摊开能做到 41/41 全覆盖。
  // **格数多 ≠ 看到的多**：格数是"把时间切成几段"，摊开才是"每段看几张"。
  // 每格秒数随画面变化 p90 **连续**下降，不再三档硬切。
  // 旧的 `motion>=15?12:motion>=5?20:40` 在 13.2 和 17.1 之间划了一刀：
  // 两支几乎同长的 PV，一个 4 格一个 9 格，纯属跨不跨这条线的运气。
  // 经验式：p90 每高 1 分，每格少 1 秒，夹在 [8, 45] —— 画面越"忙"，越该细看。
  const perCell = typeof motion === 'number'
    ? Math.max(8, Math.min(45, 40 - motion))
    : (avgShot < 4 ? 15 : 40);
  // 内容类型分流（判据见 isMusicDriven）：只影响取帧密度，不影响下面算出的格数。
  const musicDriven = isMusicDriven({ meanLufs, speechRate, thresholds: meta.thresholds });

  // **总格数直接由「切点总数」决定 —— 这就是对整片密度做积分。**
  //
  // 切点总数 = ∫(局部密度)dt，是全片"热闹程度"的精确总量。
  // 原来用 p90（全片第 90 百分位）当代理指标，它只反映"平时多热闹"，
  // 快慢混杂的片子会被平均掉：前 5 分钟狂切、后面 30 分钟长镜头，p90 只看到中间值。
  //
  // 现在：**每格装 TARGET_SHOTS 个镜头**，格数 = 镜头数 ÷ TARGET_SHOTS。
  // 每格 12 个镜头 → 摊 3×3 或 4×4 刚好，也不至于一格塞十几个看不清。
  const TARGET_SHOTS_PER_CELL = 8;
  const MAX_PER_SHEET = 16;
  // 单格最多覆盖多少秒。超过这个长度，一格里的"中点"就开始不像这一段的代表了
  // （6 分钟的格子里，取哪一帧都是随便挑的）。
  const MAX_CELL_SECONDS = 90;
  // **宁可挤一挤，也不为几格多开一张图。** 一张图 384 token，
  // 如果总格数只比单张容量多一点点（≤15%），塞进一张、少看两三格，比多一张划算。
  const OVERFLOW_TOLERANCE = 0.15;
  // 格数取两个口径里更大的那个：
  //   按镜头数：每格 8 个镜头（快剪素材的节奏基准）
  //   按时长：  单格不超过 90 秒（安静的长素材的覆盖基准，且不超过镜头数）
  // 只用镜头数会漏掉一整类素材：66 分钟讲座只有 150 刀，算出来 19 格 ——
  // 最后是 12 格看 66 分钟（每格 5.5 分钟）。实测就是这么翻的车。
  // 也不按"每格 40 秒"算：那会把 15 分钟 61 镜的片子推到 24 格，
  // 而它 8 格就够 —— 只在"单格长到没法看"时才介入。
  const byShots = Math.round(shots / TARGET_SHOTS_PER_CELL);
  const bySeconds = Math.min(Math.round(duration / MAX_CELL_SECONDS), shots);
  let totalCells = Math.max(4, byShots, bySeconds);
  if (!musicDriven && (hasSubtitle || speechRate > 0) && speechRate > T.speechRateCut) {
    // 台词承担信息，图只做锚点 —— 但**不能锚到 90 秒才一张**：
    // 降档之后再拿 bySeconds 兜一次底，否则 66 分钟讲座会被降成 24 格（每格 165 秒）。
    totalCells = Math.max(4, Math.round(totalCells * 0.6), bySeconds);
  }
  const perSheetCap = MAX_PER_SHEET * (1 + OVERFLOW_TOLERANCE);
  const sheets = Math.min(MAX_SHEETS, Math.max(1, Math.ceil(totalCells / perSheetCap)));
  // 每张分到的格数：总格数摊到各张，再吸附成能整除的布局
  let cells = snapCells(clamp(Math.ceil(totalCells / sheets), 4, MAX_PER_SHEET));

  const label = cells <= 4 ? 'overview' : cells <= 9 ? 'balanced' : cells <= 12 ? 'detailed' : 'timeline';
  // 说明里把两个信号都写出来，否则"为什么给这个格数"又变成猜的
  const pace = typeof motion === 'number'
    ? `画面变化 p90=${motion.toFixed(1)}（${perCell.toFixed(0)}s/格）`
    : `均镜头 ${avgShot.toFixed(1)}s（${perCell.toFixed(0)}s/格）`;
  return pick(label, cells, sheets,
    `${duration.toFixed(0)}s、${shots} 个镜头、${pace} → ${cells} 格 × ${sheets} 张（≈${Math.round(duration / (cells * sheets))}s/格）` +
    (musicDriven ? '·音乐驱动（取帧更密，格数不受影响）' : ''), musicDriven);
}

/** 吸附到"能整除成好布局"的格数，避免出现大量 padding（8→9 比 8+1 空格好） */
export const SNAP_CELLS = [4, 6, 9, 12, 16];
export function snapCells(n) {
  let best = SNAP_CELLS[0];
  for (const c of SNAP_CELLS) if (Math.abs(c - n) < Math.abs(best - n)) best = c;
  return best;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {boolean} [musicDriven] 音乐驱动。**必须真的带出去**：
 *   下游 pipeline 靠 `suggest().musicDriven` 决定"取帧门槛压不压低"。
 *   这个参数曾经在调用处传了、在这里没接 → 返回值里永远是 undefined，
 *   于是"音乐片取帧更密"这条规则写了一套却从没生效过。
 */
function pick(label, cells, sheets, reason, musicDriven) {
  return {
    coverage: label, cells, sheets, reason,
    ...(musicDriven ? { musicDriven: true } : {}),
  };
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

/**
 * 把 `total` 个整数配额按 `weights` 分给 n 份，**总和精确等于 total**，且每份 ≥ min。
 *
 * 为什么需要它：原来分给"黑场之间的内容区"时，每段各自 `Math.max(1, Math.round(份额))`，
 * 一段一段往上报，总和可以超过 total（实测 24 格算出 25 段，多出来那一格只能靠下游"补满"
 * 或者"按容量砍"去兜）。偏差一旦进了调用方，后面所有"格数/张数/token"都对不上账。
 *
 * 最大余额法：先按权重取整，余数按小数部分从大到小补。加权为零时退化成均分。
 */
export function allocateIntegerBudget(total, weights, { min = 0 } = {}) {
  const n = weights.length;
  if (n === 0) return [];
  const t = Math.max(0, Math.round(Number(total) || 0));
  const floor = Math.max(0, Math.round(Number(min) || 0));
  // 连保底都给不出：按顺序发到没有为止（总和仍然精确）
  if (t < floor * n) {
    let rest = t;
    return weights.map(() => {
      const v = Math.min(floor, rest);
      rest -= v;
      return v;
    });
  }
  const left = t - floor * n;
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  const raw = sumW > 0 ? w.map((x) => (x / sumW) * left) : w.map(() => left / n);
  const out = raw.map((x) => Math.floor(x));
  let rest = left - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rest; k += 1) out[order[k % n].i] += 1;
  return out.map((x) => x + floor);
}
