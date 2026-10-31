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
/**
 * **宁可挤一挤，也不为几格多开一张图。** 一张图 ~700 token，
 * 总格数只比单张容量多一点点（≤15%）时，塞进一张、少看两三格，比多一张划算。
 * 用在 `shapeFromTotal` 里。
 */
const OVERFLOW_TOLERANCE = 0.15;
export const DEFAULT_ASPECT = 16 / 9;

/**
 * 可读性档位 —— **模型该说的不是"图多大"，而是"我需要看清到什么程度"**。
 *
 * 一图一预算，格数越多每格越小：640k px 的图放 16 格，每格只有 247×137，
 * 那是"看得出构图"，不是"看得清内容"。所以格数必须由**目标可读性**反推，
 * 而不是由档位名字暗示（旧版 small 允许 16 格、large 只允许 9 格，正好是反的）。
 *
 * 门限来自 2026-10-30 的盲评：123×68 认不出字幕/UI（1~2 分），165×92 只能分辨镜头，
 * 252×156 能认字。取整成三档，并留 5% 容差（真实布局有 gutter，见 sheet.layoutCanvas）。
 */
export const NEED_TIERS = Object.freeze({
  shot: { minCellW: 160, minCellH: 90, label: 'tell one shot from another (no reading)' },
  scene: { minCellW: 320, minCellH: 180, label: 'recognise faces, action and large titles' },
  text: { minCellW: 480, minCellH: 270, label: 'read subtitles, signs and UI text' },
});
export const DEFAULT_NEED = 'scene';
/** 布局有 gutter，纯算术按 96% 估；差 1~2 格时宁可保守。 */
const CELL_GEOMETRY_SLACK = 0.96;
/**
 * 选格数时再保守 6%：`cellPixels` 没算 gutter 与取整，用来**展示**是准的，
 * 用来**卡门槛**就会偏乐观（640k 的 12 格算 323×181，实际出图 303×166，低于 scene）。
 * 这条只用于 maxCellsForNeed，不污染清单里的 cell= 数字。
 */
const CELL_FIT_SLACK = 0.94;

/**
 * 一张图放 n 格时，每格**大致**多少像素（按 96% 估 gutter，给模型看的量级）。
 * 真实出图以 sheet.layoutCanvas 为准；这里只用于选格数与写清单。
 */
export function cellPixels(cells, aspect = DEFAULT_ASPECT, budget = PIXEL_BUDGET) {
  const n = Math.max(1, Math.round(Number(cells) || 1));
  const area = Math.max(1, budget) / n;
  const w = Math.round(Math.sqrt(area * aspect) * CELL_GEOMETRY_SLACK);
  return { w, h: Math.round(w / aspect), area: Math.round(area) };
}

/**
 * 一格实际能支撑到哪一档可读性。**这是清单要对模型说的实话**：
 * 它不需要知道像素，只需要知道"这张图能读到字，还是只能看构图"。
 */
export function readabilityOf(cellW, cellH) {
  if (!(cellW > 0) || !(cellH > 0)) return 'unknown';
  for (const level of ['text', 'scene', 'shot']) {
    const t = NEED_TIERS[level];
    if (cellW >= t.minCellW * 0.95 && cellH >= t.minCellH * 0.95) return level;
  }
  return 'composition';
}

/**
 * **子帧像素下限 = `need` 的下一档。**
 *
 * 语义：**整帧给你 need 这一档，摊开允许降一档**（至少还能分辨"是不是不同镜头"）。
 *   need=scene(320×180) → 子帧门槛 160×90 → 341×189 的格子最多 2×2（170×94）
 *   need=text (480×270) → 子帧门槛 320×180 → 456×254 的格子只能整帧
 *   need=shot (160×90 ) → 子帧门槛 160×90（已经最底，不再降）
 *
 * 放在 plan.js 而不是 measure.js：它只依赖 `NEED_TIERS`，而 `maxCellsForNeed`（同在本文件）
 * 也要用它判断"16 格这一档摊开之后还剩多少余量"。measure 那边 re-export 一次保持原调用点不变。
 */
const NEED_ORDER = ['shot', 'scene', 'text'];
export function subFloorForNeed(need = DEFAULT_NEED) {
  const i = Math.max(0, NEED_ORDER.indexOf(need));
  const lower = NEED_TIERS[NEED_ORDER[Math.max(0, i - 1)]] ?? NEED_TIERS.shot;
  return { minSubW: lower.minCellW, minSubH: lower.minCellH };
}

/**
 * 在给定像素预算下，为了达到 need 档可读性，一张图最多放几格。
 *
 * 从大到小试，返回**布局友好的整数**（4/6/9/12/16 的子集）。
 * 1.2M + scene → 12（见下）；1.65M + scene → 16；1.2M + text → 6；640k + text → 4。
 *
 * **16 格是"满铺"档，要额外的余量**：只有在摊成 2×2 之后、子帧仍比 need 的下一档高 15% 以上
 * 才给这一档。理由是实测（250 s / 1.2M / scene）：
 *   16 格 → cell 341×189 → 摊 2×2 = 170×94，只比 shot(160×90) 高 6% —— 一压缩就掉档；
 *   12 格 → cell 394×220 → 摊 2×2 = 197×110，余量 23%，且 token 几乎不变（1396 vs 1393）。
 * 代价是每张少 4 格（覆盖变粗一档），换来的是"摊开之后还认得出"。
 * `need:'shot'` 不受这条约束 —— 那个档位本来就不指望看清内容，铺满更重要。
 */
export function maxCellsForNeed(budget = PIXEL_BUDGET, aspect = DEFAULT_ASPECT, need = DEFAULT_NEED) {
  const tier = NEED_TIERS[need] ?? NEED_TIERS[DEFAULT_NEED];
  const subFloor = subFloorForNeed(need);
  const SUB_FRAME_MARGIN = 1.15;
  for (const n of [16, 12, 9, 6, 4, 2, 1]) {
    const c = cellPixels(n, aspect, budget);
    if (c.w * CELL_FIT_SLACK < tier.minCellW || c.h * CELL_FIT_SLACK < tier.minCellH) continue;
    if (n === 16 && need !== 'shot'
      && (c.w / 2 < subFloor.minSubW * SUB_FRAME_MARGIN
        || c.h / 2 < subFloor.minSubH * SUB_FRAME_MARGIN)) continue;
    return n;
  }
  return 1;
}

/**
 * DSH 宿主的视觉 token 计价：14px patch、每轴 3:1 下采样（一格 42px），每行加一个分隔 token。
 *
 * 用它而不是常数 384：384 只对"640k px 的图"成立。默认预算提到 1.2M 之后，
 * 一张图约 700 token —— 报 384 就是谎报，模型会据此做出错误的成本判断。
 * API 宿主按像素计费，口径不同，所以这个数只标成 DSH 口径。
 */
export function imageTokens(width, height) {
  const gw = Math.ceil(Math.max(1, width) / 42);
  const gh = Math.ceil(Math.max(1, height) / 42);
  return gw * (gh + 1) + 2;
}

/**
 * Content-classification thresholds. Kept in one place so the manifest can report them.
 *
 * `musicLufs` 只在**既没有台词、也没有音频包络**时兜底（见 isMusicDriven 第 3 条）。
 * 它单独用不成立：母带电平反映响度，不反映内容 ——《记忆管理局》正式 PV（纯音乐快剪）
 * −18.4、概念 PV −14.2，同一类东西差 4 LU，拿固定响度去切，切的是母带处理，不是内容。
 */
export const PLAN_THRESHOLDS = Object.freeze({
  musicLufs: -18,
  musicSpeechRate: 1,
  speechRateCut: 3,
  // 能量包络的主导调制频率：≥2.5 Hz 是节拍型（配乐），1–2 Hz 是短语型（说话）。
  musicPeakHz: 2.5,
  // 3–6 Hz 能量 ÷ 0.5–2 Hz 能量：音乐有持续节拍，这个比值明显更高。
  // 1.15 不是 1.1：实测沧野（口播 vlog）全天算出来 1.077，离 1.1 只差 0.02，
  // 换个母带就可能翻过去；两支 PV 是 1.24 / 1.48，留到 1.15 两边都有余量。
  musicRhythmRatio: 1.15,
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
/**
 * 「这部片子的信息是不是主要在画面上」—— 分三档取证，**优先级从硬到软**。
 *
 * 1. **有台词**（字幕轨 / 转写文件 / ASR 结果）：台词的密度就是直接答案。
 *    响度和节奏都不参与 —— 说了多少话，数一下就知道，不需要再猜。
 * 2. **没台词但有音频**：听能量包络的节奏（`audio.rhythmProfile()`）。
 *    说话的包络主导在 1–2 Hz（短语、重音），配乐在 3–4 Hz（节拍）。
 *    这一条**跟母带电平无关**：整段响度调大调小，包络形状不变。
 * 3. **连音频都没有**：退回响度。这是最弱的证据，只保证"总比瞎猜强"。
 *
 * 为什么不再用「响度 > -18 且 话少」这个与关系：两者量的是不同的东西，与在一起会让
 * 母带电平低一点的纯音乐片被当成"有字"（正式 PV 就是这样被挡在门外的，−18.4 差 0.4）。
 *
 * @returns {{musicDriven:boolean, basis:'speech'|'rhythm'|'loudness', detail:string}}
 *   basis 要写进清单：模型看到"因为什么判的"，才有可能推翻它。
 */
export function musicDrivenVerdict({
  meanLufs, speechRate = 0, hasSpeech = false, rhythm = null, thresholds,
} = {}) {
  const T = { ...PLAN_THRESHOLDS, ...(thresholds ?? {}) };
  if (hasSpeech) {
    return {
      musicDriven: speechRate < T.musicSpeechRate,
      basis: 'speech',
      detail: `${speechRate.toFixed(2)} 字/秒（阈值 <${T.musicSpeechRate}）`,
    };
  }
  if (rhythm && Number.isFinite(rhythm.peakHz) && rhythm.windows >= 2) {
    return {
      musicDriven: rhythm.peakHz >= T.musicPeakHz && rhythm.rhythmRatio >= T.musicRhythmRatio,
      basis: 'rhythm',
      detail: `包络主导 ${rhythm.peakHz} Hz、3-6Hz/0.5-2Hz=${rhythm.rhythmRatio}` +
        `（阈值 ≥${T.musicPeakHz} Hz 且 ≥${T.musicRhythmRatio}）`,
    };
  }
  return {
    musicDriven: Number.isFinite(meanLufs) && meanLufs > T.musicLufs,
    basis: 'loudness',
    detail: `${meanLufs} LUFS（无台词数据、无音频包络，只能用响度兜底；阈值 >${T.musicLufs}）`,
  };
}

/** 同上的布尔版（老调用方的签名没变）。 */
export function isMusicDriven(opts = {}) {
  return musicDrivenVerdict(opts).musicDriven;
}

/**
 * 从廉价元数据推导建议：多少格、几张。
 *
 * 依据实测（C站 5 分钟镜头密集素材，1920×1080）：
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

  // 内容类型分流（判据见 musicDrivenVerdict）：只影响取帧密度，不影响下面算出的格数。
  const musicDriven = isMusicDriven({
    meanLufs,
    speechRate,
    hasSpeech: meta.hasSpeech === true,
    rhythm: meta.rhythm ?? null,
    thresholds: meta.thresholds,
  });

  // **格数多 ≠ 看到的多**：格数是"把时间切成几段"，摊开才是"每段看几张"。
  // 曾经试过再叠加"剪辑密度（刀/秒）取更密者"想让快剪 PV 拿到更多格，实测反而更差 ——
  // 概念 PV 被推到 12 格，每格只剩 3~4 个镜头，摊开也覆盖不住。

  // **每格装 8 个镜头**：摊 2×2/3×3 刚好覆盖。
  const TARGET_SHOTS_PER_CELL = 8;
  // 每张最多几格：由 `board.boardGeometry()` 按 budget + need 推（1.2M+scene → 12）。
  // 这里只做兜底，正常路径 pipeline 会把它传进来。
  const MAX_PER_SHEET = Math.max(4, Math.min(16, Number(meta.maxPerSheet) || 16));
  // **单格最多 90 秒**：再长，格子里取哪一帧都不像这一段的代表了。
  const MAX_CELL_SECONDS = 90;

  // **每格多少秒** = 上面两条约束里更紧的那个。
  // 以前写成 `max(shots/8, duration/90)`：这两个式子是同一个数的倒数
  // （shots/8 = duration ÷ (8×平均镜头长)），绕一圈再取大，读的人看不出是一回事。
  const stride = Math.min(MAX_CELL_SECONDS, TARGET_SHOTS_PER_CELL * (duration / shots));
  // 格数不能多过镜头数（把一个镜头劈成 7 段没意义），也不能少于 4 格
  let totalCells = Math.max(4, Math.min(Math.round(duration / stride), shots));
  // 单格不超过 90 秒所要求的**最少**格数。下面两个降档分支拿它当地板 ——
  // 格数可以砍，但不能砍到"一格 165 秒"。
  const evenCells = Math.min(Math.round(duration / MAX_CELL_SECONDS), shots);

  if (meta.tileFirst) {
    // **摊开优先**：宁可少几格，把画布让给"每格摊 2×2 / 3×3"。
    // 起因（2026-10-30）：记管 MAD02 是 16 格 4×4，单格 247×137，摊 2×2 只剩 123×68 ——
    // 低于"能分辨镜头"的 110×56 那条线，165 个镜头只看到 32 个。
    // 降到 9 格（3×3 布局）单格 331×184，摊 3×3 是 110×61、摊 2×2 是 165×92，都成立。
    // 9 是硬下限：再少就排成 2×2（4 格），92 秒的片子每格 23 秒，那不是"细看"是"抽帧"。
    totalCells = Math.max(9, Math.round(shots / 18), evenCells);
  }
  if (!musicDriven && (hasSubtitle || speechRate > 0) && speechRate > T.speechRateCut) {
    // 台词承担信息，图只做锚点 —— 但**不能锚到 90 秒才一张**：
    // 降档之后再拿 evenCells 兜一次底，否则 66 分钟讲座会被降成 24 格（每格 165 秒）。
    totalCells = Math.max(4, Math.round(totalCells * 0.6), evenCells);
  }

  // 形状（每张几格 / 几张）由 `shapeFromTotal` 一处算，layout 用的是同一个函数。
  const { cells, sheets } = shapeFromTotal(totalCells, MAX_PER_SHEET);
  const label = cells <= 4 ? 'overview' : cells <= 9 ? 'balanced' : cells <= 12 ? 'detailed' : 'timeline';
  const pace = typeof motion === 'number'
    ? `画面变化 p90=${motion.toFixed(1)}`
    : `均镜头 ${avgShot.toFixed(1)}s`;
  // **只说"计划铺多少格"，不说"几张"、不说"每格多大"。**
  // 张数要等 layout 按真实上限算，写在这里必然和清单首行对不上（实测 6 格→9 格、18 格→24 格）；
  // "每格多大"清单里另有一行 `cell=W×H (档位)`，这里再算一次只会多一个近似值（405 vs 394）。
  return pick(label, cells, sheets,
    `${duration.toFixed(0)}s、${shots} 个镜头、${pace} → 计划 ${totalCells} 格（≈${Math.round(duration / totalCells)}s/格）` +
    (musicDriven ? '·音乐驱动（取帧更密，格数不受影响）' : ''), musicDriven, totalCells);
}

/**
 * **总格数 → 每张几格 / 几张。** 唯一实现。
 *
 * - `suggest()` 调它，只为把"大概几张"说出来；
 * - `layout.planLayout()` 调它，决定**真正**排几张。
 *
 * 两边必须是同一个函数：以前各自算一遍，于是"建议 6 格、实际 9 格"成了常态。
 *
 * 15% 的余量：一张图容量是 cap 格，但"多出两三格就多买一张图"不划算，
 * 所以装到 cap×1.15 才另起一张。
 */
export function shapeFromTotal(totalCells, maxPerSheet = 12) {
  const cap = Math.max(4, Math.min(16, Math.round(Number(maxPerSheet) || 12)));
  const n = Math.max(1, Math.round(Number(totalCells) || 1));
  const sheets = Math.min(MAX_SHEETS, Math.max(1, Math.ceil(n / (cap * (1 + OVERFLOW_TOLERANCE)))));
  // 每张分到的格数：总格数摊到各张，再吸附成能整除的布局
  const cells = snapCells(clamp(Math.ceil(n / sheets), 4, cap));
  return { cells, sheets };
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
function pick(label, cells, sheets, reason, musicDriven, totalCells = cells * sheets) {
  return {
    coverage: label,
    // **`totalCells` 才是建议的主语言**：layout 按它排布。
    // `cells`/`sheets` 是同一件事折算成网格形状的样子，给清单展示和 planTotal 用。
    totalCells, cells, sheets, reason,
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

  const budget = opts.budget ?? PIXEL_BUDGET;
  const cell = cellSize(cols, rows, aspect, budget);
  return {
    cols,
    rows,
    capacity: cols * rows,
    sheets,
    coverage,
    cell,
    readable: readabilityOf(cell.w, cell.h),
    budget,
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
