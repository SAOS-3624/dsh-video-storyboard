/**
 * tiers.js — **档位**：这一帧该占多大格子，以及该抓多少像素。
 *
 * 全部是纯算术：给定切点时刻和 fps，输出每一帧的档位（1..8）。不扫、不取帧、不写盘。
 *
 * ## 档位从哪来
 *
 * 用户给的算法（`取帧分档算法.docx`）：把切点看成时间轴上的 0/1 函数 `cut(t)`，
 * 用宽度 dt 的矩形窗做卷积得到"切点密度" `Ro = (窗内切点数) / dt`，再平滑一次；
 * 然后拿 7 个阈值把它切成 **8 个档**，带 5% 滞回（防止在阈值上抖来抖去）。
 *
 *     dt = 100 帧（不是秒）：窗内切点数 / 100 = "每帧碰上切点的概率"
 *     阈值 [0.0085, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1]
 *       → 0.0085 ≈ 3.3 秒一刀（30fps）→ 2 档；0.1 ≈ 每秒 3 刀 → 8 档
 *
 * 档位 k 的**边长就是 1/k**（用户口径："帧的尺寸 = 档位的倒数"）。
 * k=1 是整幅、k=8 是 1/8 边长的豆腐块。
 *
 * ## 为什么阈值用"每帧概率"而不是"刀/秒"
 *
 * 两者差一个 fps 常数，而 docs 里的数值是按帧给的。换 60fps 素材时用"刀/秒"会把
 * 判据整体平移一倍，所以这里严格按帧算，只在注释里换算成人话。
 */

/** 7 道阈值 → 8 个档位（每帧的切点概率，照抄 docx）。 */
export const LEVEL_THRESHOLDS = Object.freeze([0.0085, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1]);

/**
 * 第二套阈值：**按人眼瞬时记忆定标**（see-now 0.2.0 里先做的，这里同步过来）。
 *
 * 端点不是拍脑袋的：一格代表的时间**最多 3 秒**（Pöppel 的"主观现在" 2~3 秒，
 * 电影镜头时长本身就有 ~3 秒的偏好）、**最少 0.3 秒**（注意眨眼 200~500 ms、图标记忆的
 * 部分报告优势在 250~500 ms 内消失 —— 比这更近的两次变化人眼当成一次），中间六道按等比
 * （公比 1.4678，时长辨别服从 Weber 律）。
 *
 * **单位换算是关键**：see-now 那边用「刀/秒」，这边用「每帧概率」，两者差一个 fps。
 * 这里是把 see-now 的表除以 30 得到的 —— 和 docx 那套的换算关系完全一致
 * （0.26/30 = 0.00867 ≈ 0.0085、3.0/30 = 0.1），所以形状没被改，只是端点内收。
 *
 * 实测（see-now 60 秒素材、同样留帧数）：**张数 -14%~-18%，平均档位 +0.5**（格子小一档）。
 * 无切点的素材两套完全一致。默认仍是 docx —— 想压 token 再切过去。
 */
export const PERCEPTUAL_THRESHOLDS = Object.freeze([
  0.0111, 0.0163, 0.0239, 0.0351, 0.0516, 0.0757, 0.1111,
]);

/** 可选的阈值表。加新表在这里登记，`thresholdsFor()` 是唯一入口。 */
export const TIER_CURVES = Object.freeze({
  docx: LEVEL_THRESHOLDS,
  perceptual: PERCEPTUAL_THRESHOLDS,
});

/** `video.json` 里 `storyboard.tierCurve` 认的值。 */
export const TIER_CURVE_KEYS = Object.freeze(['docx', 'perceptual']);

/**
 * 名字 → 阈值表。**认不出来的名字一律退回 docx**，不抛 ——
 * 配置写错不该让整个分镜失败，宁可跑默认那套。
 */
export function thresholdsFor(curve) {
  return TIER_CURVES[String(curve ?? '').trim()] ?? LEVEL_THRESHOLDS;
}
/** 滞回：升档要越过 +(1+h)，降档要跌穿 −(1−h)，免得在阈值附近反复横跳。 */
export const HYSTERESIS = 0.05;
/** 切点密度的积分窗（帧）。docx 的 dt = 100。 */
export const INTEGRAL_FRAMES = 100;
/** 密度曲线的平滑窗（帧）。docx 的 movmean 窗口 50。 */
export const SMOOTH_FRAMES = 50;

export const TIER_MIN = 1;
export const TIER_MAX = 8;

/** 档位 → 边长（占容器宽度的比例）。0 = 自由尺寸，没有固定边长。 */
export const tierSide = (tier) => {
  const t = Math.round(Number(tier));
  if (t === 0) return null;
  return 1 / Math.max(TIER_MIN, Math.min(TIER_MAX, t || 1));
};

/**
 * 画布上限：**单边 1300、面积 1300×1300**。
 *
 * 口径来自官方《图像理解 · Token 用量》（2026-11）：小于约 544×544 的图会被放大，
 * 更大的图会被缩小到"总像素约相当于 1300×1300"，单张封顶 1024 token。
 * 旧的 800×800 / 384 是上一版文档的值，已经过期 —— 但**默认画布仍是 800×450**（见 board.js），
 * 这里的上限只是"允许你自己要更大的画布"，不代表默认变贵。
 */
export const MAX_CANVAS_SIDE = 1300;
/** 一张图的像素上限（服务端不会再缩回去的范围）。 */
export const MAX_IMAGE_AREA = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;

/**
 * 单张封顶（官方 1024；宿主按 patch 网格算，实际最大是 994）。
 */
const IMAGE_TOKEN_CAP = 1024;
/** 地板：小于 544×544 的图**计费时**会被放大到这个面积（发送时并不放大）。 */
export const IMAGE_UPSCALE_AREA = 544 * 544;

/**
 * 默认画布像素预算 = 360k（16:9 → 800×450 ≈ **233 token**）。
 * **只在这里定义一次** —— board.js 只是把它转出。以前 tiers 的 fitCanvas 默认 640k、
 * board 的 DEFAULT_BUDGET 也写 640k，结果超过 800 边长被裁成 360k，参数和行为对不上。
 */
export const DEFAULT_BUDGET = 360_000;

/* ---- 像素 → token：照抄宿主的实现，不再用"像素÷1650"这种近似 -------------------
 *
 * 出处：`@deepseek-ai/dsh-llm-deepseek` 的 image-tokens 模块（服务端 v41 配置），
 * 它按官方口径实现了完整算法，我们照抄是为了**报数 = 计费**：
 *
 *   - 图先按 14px 的 patch 对齐（**向上**取整到 14 的倍数）；
 *   - 每轴再 3:1 降采样 → 一个 token 格 = 42×42 px；
 *   - **每行多带 1 个分隔 token，整张再加 2 个框架 token**： tokens = rows × (cols + 1) + 2；
 *   - 超过 1024 时按长宽比解出能塞进预算的最大网格（服务端会自己缩到那儿）。
 *
 * 所以"像素÷1650"只是粗估：800×450 真值是 **233**（不是 218，也不是旧的 384）；
 * 地板是 **192**（不是 179）；封顶实际是 **994**（1300×1300 正好 994）。
 * 改了这里必须跟宿主对拍（`scripts/verify-image-tokens.mjs`）。
 */
const IMAGE_PATCH = 14;
const IMAGE_DOWNSAMPLE = 3;
/** 一个 token 格覆盖的像素边长（14×3）。 */
const IMAGE_CELL = IMAGE_PATCH * IMAGE_DOWNSAMPLE;
const intDiv = (v, d) => Math.floor(v / d);
const ceilDiv = (v, d) => Math.floor((v + d - 1) / d);
/** patch 对齐（向上取整到 14 的倍数）后，这一轴有多少个 token 格。 */
const gridCells = (padded) => ceilDiv(intDiv(padded, IMAGE_PATCH), IMAGE_DOWNSAMPLE);
/** 网格 → token：每行带 1 个分隔符，另加 2 个框架 token。 */
const gridTokens = (rows, cols) => rows * (cols + 1) + 2;
const padToPatch = (px) => ceilDiv(px, IMAGE_PATCH) * IMAGE_PATCH;

/** 一次"对齐 → 投影"：塞得下就原样，塞不下解出最大网格（宿主的闭式解）。 */
function projectSize(W, H, cap) {
  const tw = gridTokens(gridCells(padToPatch(H)), gridCells(padToPatch(W)));
  if (tw <= cap) return { W, H, tokens: tw };
  const aspect = H / W;
  const idealW = Math.sqrt((cap - 2) / aspect + 0.25) - 0.5;
  let solvedW = Math.trunc(idealW);
  let solvedH = Math.trunc(idealW * aspect);
  if (solvedW < 1) { solvedW = 1; solvedH = intDiv(cap - 2, 2); }
  else if (solvedH < 1) { solvedH = 1; solvedW = intDiv(cap - 2, solvedH) - 1; }
  const scale = Math.min((solvedW * IMAGE_CELL) / W, (solvedH * IMAGE_CELL) / H);
  const bw = Math.trunc((W * scale) / IMAGE_PATCH) * IMAGE_PATCH;
  const bh = Math.trunc((H * scale) / IMAGE_PATCH) * IMAGE_PATCH;
  return { W: bw, H: bh, tokens: gridTokens(gridCells(bh), gridCells(bw)) };
}

/**
 * **像素 → token**。全仓库只有这一处把尺寸换成钱，别在别处再写死一个数。
 *
 * @param {number} w 像素宽
 * @param {number} h 像素高
 * @returns {number} 估算 token（整数，≤ 1024）
 */
export function imageTokens(w, h) {
  const cap = Number(process.env.DSH_IMAGE_TOKEN_CAP) > 0
    ? Number(process.env.DSH_IMAGE_TOKEN_CAP) : IMAGE_TOKEN_CAP;
  let W = Math.round(Number(w) || 0);
  let H = Math.round(Number(h) || 0);
  if (W <= 0 || H <= 0) return 0;
  // 地板：计费时先按面积放大到 544×544（宿主发送时不会放大，只是这么收费）
  const px = W * H;
  if (px < IMAGE_UPSCALE_AREA) {
    const scale = Math.sqrt(IMAGE_UPSCALE_AREA / px);
    W = Math.max(1, Math.trunc(W * scale));
    H = Math.max(1, Math.trunc(H * scale));
  }
  let cur = projectSize(W, H, cap);
  // 宿主迭代到不动点（缩完再投影可能又变），这里同样最多跑 10 轮
  for (let i = 0; i < 10; i += 1) {
    const next = projectSize(cur.W, cur.H, cap);
    if (next.tokens === cur.tokens && next.W === cur.W && next.H === cur.H) return next.tokens;
    cur = next;
  }
  return cur.tokens;
}

/**
 * 顶部时间抬头的高度（像素）。**只跟图宽有关** —— 字号是 5×7 点阵的整数倍，
 * 宽了就该更高一点。
 *
 * 定义在 tiers 而不是 sheet，是因为 `fitCanvas` 要按它算**总高**（见下面的高度卡线）：
 * 出图尺寸 = 格子区 + 这条抬头，只对格子区做对齐会把它漏掉。
 */
export function headerHeight(width) {
  return Math.max(18, Math.round((Number(width) || 0) * 0.024));
}

/**
 * 把格子区高度压回"格子区 + 页眉 = 42 的整数倍"，**只在溢出量 <= 8px 时生效**。
 *
 * 出图时顶上会叠一条 `headerHeight` 的抬头，真正的 PNG 高度是两者之和。
 * 不把抬头算进来就会卡在行边界上多收一整行 token：
 *
 *   449 + 19 = 468 → 12 行 → 242 token
 *   443 + 19 = 462 → 11 行 → 222 token   ← 格子区只矮 1.3%
 *
 * 压太多（差 30px 也去压）是拿面积换 token —— 两者近似线性，不划算。所以设 8px 的闸。
 */
function snapHeightToHeader(height, width) {
  const hh = headerHeight(width);
  const over = (height + hh) % IMAGE_CELL;
  if (over <= 0 || over > 8) return height;
  const next = height - over;
  if (next < 36) return height;
  // **只在真降价时才压**：地板区（<544²）压多少都是同一个价，白掉像素反而是亏。
  return imageTokens(width, next + hh) < imageTokens(width, height + hh) ? next : height;
}

/**
 * 画布尺寸：面积 <= budget，且**任一边不超过 maxSide**。
 *
 * 16:9 + 640k 算出来是 1066×600，会被 800 卡成 800×450 —— 这正是用户实测的
 * "再大就没意义"：超过 800 的部分宿主会缩回去，而清单里的格子尺寸就成了假数。
 *
 * ## 为什么宽度要向下对齐到 42px
 *
 * 计费网格是 `ceil(ceil(px/14)/3)` 个 token 格，一格 42px，而每行还要多收 1 个
 * 分隔 token。所以 **W 落在 42 的整数倍上时，一行才不多收那个 token**。
 *
 *   800×450 → 812 对齐 → 20 列 → 11×(20+1)+2 = 233
 *   798×450 → 19 列       → 11×(19+1)+2 = 222   ← 面积只少 0.25%，便宜 4.7%
 *
 * 只对"对齐真能降价"的情况生效（下面那个 if）：地板区（<544²）本来就按 544² 收费，
 * 对齐只会白掉像素，所以原样返回。
 *
 * 高度则**按含页眉的总高**卡线（`snapHeightToHeader`），不是简单地对齐 450 这个数。
 */
export function fitCanvas(aspect, { maxSide = MAX_CANVAS_SIDE, budget = DEFAULT_BUDGET } = {}) {
  const a = Math.max(0.2, Math.min(5, Number(aspect) || 16 / 9));
  // **地板**：计费时小于 544² 的图一律按 544² 收，所以画得比它小一分钱不省、只是更糊。
  // 这里直接把面积抬到地板（清单会说明"已抬升"），别让调用方以为自己省了钱。
  const area = Math.min(MAX_IMAGE_AREA, Math.max(IMAGE_UPSCALE_AREA, Number(budget) || DEFAULT_BUDGET));
  const w = Math.sqrt(area * a);
  const h = w / a;
  const shrink = Math.min(1, maxSide / w, maxSide / h);
  const width = Math.max(64, Math.round(w * shrink));
  const height = snapHeightToHeader(Math.max(36, Math.round(h * shrink)), width);

  const snapped = Math.floor(width / IMAGE_CELL) * IMAGE_CELL;
  if (snapped >= 64) {
    const snapH = snapHeightToHeader(Math.max(36, Math.round(snapped / a)), snapped);
    if (imageTokens(snapped, snapH) < imageTokens(width, height)) {
      return { width: snapped, height: snapH, aspect: a };
    }
  }
  return { width, height, aspect: a };
}

/**
 * 每个档位在这块画布上占多少像素 —— 也就是**这一档该按什么分辨率抓帧**。
 *
 * 抓得比格子大只是浪费解码；抓得比格子小才会糊。所以直接按格子像素抓。
 * 档位 2 以上（1/2 边长）在 800 宽画布上最多 400×225 —— 这就是"再抓 720p 没意义"的由来。
 */
export function tierSizes(canvas) {
  const out = [];
  for (let t = TIER_MIN; t <= TIER_MAX; t += 1) {
    out.push({
      tier: t,
      w: Math.max(2, Math.round(canvas.width / t)),
      h: Math.max(2, Math.round(canvas.height / t)),
    });
  }
  return out;
}

/**
 * 切点密度曲线 + 档位序列（逐帧）。
 *
 * @param {{duration:number, fps:number, cuts:number[],
 *          thresholds?:number[], hysteresis?:number,
 *          integralFrames?:number, smoothFrames?:number}} o
 * @returns {{fps:number, frames:number, density:Float64Array, smoothed:Float64Array,
 *            levels:Uint8Array}}
 */
export function levelCurve({
  duration, fps, cuts = [],
  thresholds = LEVEL_THRESHOLDS,
  hysteresis = HYSTERESIS,
  integralFrames = INTEGRAL_FRAMES,
  smoothFrames = SMOOTH_FRAMES,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const n = Math.max(1, Math.ceil(duration * rate));

  // 1) 切点落到帧桶里，前缀和 O(1) 查任意窗
  const bin = new Float64Array(n);
  for (const c of cuts) {
    if (!Number.isFinite(c) || c < 0 || c >= duration) continue;
    bin[Math.min(n - 1, Math.max(0, Math.round(c * rate)))] += 1;
  }
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) cum[i + 1] = cum[i] + bin[i];

  // 2) 卷积 = 窗内切点数 / 窗宽（帧）→ "每帧切点概率"
  const W = Math.max(1, Math.min(n, Math.round(integralFrames)));
  const density = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const hi = Math.min(n, i + Math.ceil(W / 2));
    const lo = Math.max(0, hi - W);
    density[i] = (cum[hi] - cum[lo]) / W;
  }

  // 3) movmean 平滑
  const S = Math.max(1, Math.min(n, Math.round(smoothFrames)));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + density[i];
  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - Math.floor(S / 2));
    const hi = Math.min(n, lo + S);
    smoothed[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }

  // 4) 带滞回的状态机（照抄 docx 的 calc_levels_and_jumps）
  const up = thresholds.map((v) => v * (1 + hysteresis));
  const down = thresholds.map((v) => v * (1 - hysteresis));
  const countAtLeast = (val, arr) => {
    let k = 0;
    for (const v of arr) if (val >= v) k += 1;
    return k;
  };
  const levels = new Uint8Array(n);
  let cur = 1 + countAtLeast(smoothed[0], up);
  levels[0] = cur;
  for (let i = 1; i < n; i += 1) {
    const val = smoothed[i];
    if (cur < TIER_MAX && val > up[cur - 1]) {
      cur = 1 + countAtLeast(val, up);
    } else if (cur > TIER_MIN && val < down[cur - 2]) {
      cur = 1 + countAtLeast(val, down);
    }
    levels[i] = Math.max(TIER_MIN, Math.min(TIER_MAX, cur));
  }
  return { fps: rate, frames: n, density, smoothed, levels, thresholds };
}

/** 某一时刻的档位（就近取帧）。 */
export function levelAt(curve, t) {
  if (!curve || !curve.levels?.length) return TIER_MIN;
  const i = Math.round((Number(t) || 0) * curve.fps);
  return curve.levels[Math.min(curve.levels.length - 1, Math.max(0, i))] ?? TIER_MIN;
}

/* ------------------------------------------------------------------ 升降档 */

/**
 * 四种省钱/画质取向。**改的是档位，不是排布** —— 排布永远按真实档位求最优。
 *
 *   quality  高性能：每帧升一档（1/2 → 1/1），1 档已经最清楚，不再升
 *   balanced 均衡  ：1 档的帧压到 2 档（1/2 尺寸）—— 单帧占满整张太奢侈
 *   saver    节省  ：每帧降一档
 *   frugal   乞丐  ：每帧降三档
 */
export const STRATEGIES = Object.freeze({
  full: { bump: -1, floor: 1, label: '全尺寸', note: '每帧尺寸升一档（1 档不再升）' },
  standard: { bump: 0, floor: 2, label: '标准', note: '1 档压成 1/2 尺寸' },
  compact: { bump: 1, label: '紧凑', note: '每帧尺寸降一档' },
  /**
   * 原生：**什么都不挪**，按密度算出来几档就是几档。
   *
   * 它和 `standard` 的区别只在 floor —— standard 把 1 档压成 1/2（`floor: 2`），
   * native 保留 1 档满格。存在的理由是**给"逐档自定义"当底座**：自定义映射表
   * 接在策略之后，底座必须是"原样"，否则用户设的 `1→3` 是在一个已经被挪过的档位上再挪。
   */
  native: { bump: 0, label: '原生', note: '按密度算出来的档位原样使用' },
  // 速览：**全部 1/8 档 + 不要假切点 + 扫描期按最小间隔合并切点**。
  // 目标不是"看清"，是"用最少的 token 知道这 90 秒大概发生了什么"。
  skim: {
    fixed: 8, label: '速览', note: '全部 1/8 档、无假切点、切点按 0.35s 合并',
    noIntegral: true, defaultScanGap: 0.35,
  },
  // 一图：**自适应最小间隔，把整段压进一张图**。间隔一路加大到帧数 <= 一张 1/8 档图的容量
  // （8×8=64，留余量取 56）。5 分钟视频也能一张 384 token 看完。
  brief: {
    fixed: 8, label: '一图', note: '全部 1/8 档、自适应加大切点间隔直到装进一张图',
    noIntegral: true, fitOneSheet: true,
  },
});

/**
 * 旧名 → 新名。0.6.0 之前叫 quality / balanced / saver / frugal / thrifty / ultra，
 * 那套名字一半是玩笑（"乞丐""恭喜发财""丐中丐"），跟"每帧多大"没有语义关系。
 * 现在统一成五个按尺寸排的词：full / standard / compact / skim / brief。
 * 旧名留一年，不报错，只是内部换成新名。
 */
export const STRATEGY_ALIASES = Object.freeze({
  quality: 'full',
  balanced: 'standard',
  saver: 'compact',
  frugal: 'compact',      // 降三档 → 并入紧凑（真要更省用 skim）
  thrifty: 'skim',
  ultra: 'brief',
});

/** 把可能过时的策略名解析成当前的名字；不认识的原样返回（交给上层报错）。 */
export function resolveStrategy(name) {
  const key = String(name ?? '').trim();
  return STRATEGY_ALIASES[key] ?? key;
}

export const STRATEGY_NAMES = Object.freeze(Object.keys(STRATEGIES));

/**
 * 每种策略下"多开一张图"的代价（`pack.solve` 的 binCost）。
 *
 * 这个数决定**档位保真度 vs 张数**的取舍：
 *   - 1.02（balanced）：宁可把格子压到半格，也要少开一张图 —— 因为一张图固定 384 token；
 *   - 0.55（quality）：四张满格（area 4）胜过一张压扁的（area 1），档位几乎不缩水；
 *   - 2.5（frugal）：把"多一张"算得很贵，尽量一张装完，格子可以很小。
 */
export const BIN_COST = Object.freeze({
  full: 0.55,       // 宁可多开一张，也要保住格子尺寸
  standard: 1.02,
  compact: 1.5,
  /**
   * `native` 不给 auto 用（`AUTO_CANDIDATES` 里没有它），但用户显式传的时候要走这个数。
   * 它和 `standard` 的保真度一样（都不改档位），只是不压 1 档。
   * 不写的话会落到 `BIN_COST[name] ?? 1.02` 的兜底 —— 值一样，但那是巧合，不是设计。
   */
  native: 1.02,
  skim: 2.5,        // 把"多一张"算贵，尽量一张装完
  brief: 2.5,
});
/** 默认从"标准"改成"紧凑"：实测同一段 5 分钟素材 19 张 → 10 张，画面还看得清。 */
export const DEFAULT_STRATEGY = 'compact';

/* ------------------------------------------------------------------ 自动选档 */

/**
 * `auto` **不是一种尺寸策略**，而是一个决策器：它拿同一批帧把三个候选各排一次，
 * 挑"最小格还认得出、张数又最少"的那个。
 *
 * 为什么要它：schema 里把 `full` 写在第一个，模型就真的选了 `full`（2026-11-01 实报，
 * 一次 90 秒 PV 花掉了原本三倍的钱）。只要默认值是"安全的那一个"，模型没有理由去猜。
 *
 * 候选只有 full / standard / compact：`skim` / `brief` 会改采样（丢积分帧、合并切点），
 * 排出来的不是同一批画面，拿它们比"张数"没有意义，所以不进候选，只能显式点名。
 */
export const AUTO_STRATEGY = 'auto';
/** 从省到贵。auto 只在这里面挑。 */
export const AUTO_CANDIDATES = Object.freeze(['compact', 'standard', 'full']);
/** auto 的下限：最小格至少要到这一档，否则"这格是不是同一个镜头"都判断不了。 */
const AUTO_MIN_READABILITY = 'shot';

const READABILITY_RANK = Object.freeze({ composition: 0, shot: 1, scene: 2, text: 3 });
/** 可读性从差到好。调用方要比较"够不够清楚"时用它，别自己排字符串数组。 */
export const READABILITY_ORDER = Object.freeze(['composition', 'shot', 'scene', 'text']);

/**
 * auto 的**张数预算**：一段视频摊到几张图上，只由时长决定，跟切点密度无关。
 *
 * 这是用户 2026-11-01 的口径："让固定时长的一段视频有尽量相同的 chunk 数量，
 * 尽量 5 分钟一张图，或者 2~3 分钟一张图"。默认 240 s ≈ 4 分钟一张，落在他的区间中线：
 * 10 分钟 → 3 张，30 分钟 → 8 张，一部 2.5 小时的片子 → 37 张（整片概览时）。
 *
 * 为什么必须是"按时长"而不是"按张数上限"：切点密度能差一个数量级（一条 5 分钟的
 * 快剪 PV 有 300 刀，一段 5 分钟的讲座只有 3 刀）。同一句"最多 8 张"在两边意味着
 * 完全不同的钱和完全不同的画面。按时长定预算，用户每次付的钱才可预期。
 */
const AUTO_SECONDS_PER_IMAGE = 240;

/**
 * 时长 → 这一窗最多几张图（auto 用）。环境变量 `DSH_STORYBOARD_SECONDS_PER_IMAGE` 可调。
 * @returns {number} 1..max 的整数
 */
export function autoSheetCap(duration, { secondsPerImage = AUTO_SECONDS_PER_IMAGE, max = 64 } = {}) {
  const per = Number(secondsPerImage) > 0 ? Number(secondsPerImage) : AUTO_SECONDS_PER_IMAGE;
  const d = Number(duration);
  if (!(d > 0)) return 1;
  return Math.max(1, Math.min(max, Math.round(d / per)));
}

/**
 * 不封顶的张数是不是已经**失控**了（该强行兑现预算，哪怕格子变小）。
 *
 * 正常逻辑是"可读性优先"：压不进预算就退回不封顶。但有些片子（BBC《Mountains》：
 * 49 分钟、316 刀、其中 305 帧是 1 档大格）不封顶要 **344 张图 ≈ 8 万 token** ——
 * 那不是"多花一张"，是失控。超过 `max(64, 8×预算)` 就认定为失控。
 *
 * 64 是绝对下限：5 分钟的 PV 就算要 60 张也不算失控（那是它真实的镜头数）。
 */
export function shouldForceSheetCap(naturalBins, targetCap) {
  const n = Number(naturalBins);
  const l = Number(targetCap);
  if (!(n > 0) || !(l > 0)) return false;
  return n > Math.max(64, l * 8);
}

/**
 * 从若干候选里挑一个。纯函数，便于单测。
 *
 * 排序口径（**钱优先，信息量其次**）：
 *   1. 张数少 —— 一张图 ≈ 384 token，这是唯一真正花钱的维度；
 *   2. 张数相同时**帧多**的赢 —— 同样的钱，多看几个瞬间；
 *   3. 再相同就按候选顺序（省的那档在前），保证结果可复现。
 *
 * 也就是说：只要能保持"最小格还认得出"，永远选最省的那档。**不做"更清楚优先"** ——
 * 在一个已经够用的画面上多花一倍钱，正是这次要治的病。
 *
 * @param {Array<{name:string, bins:number, frames?:number, minW:number, minH:number}>} variants
 * @returns {string|null} 选中的策略名；没有候选时 null
 */
export function pickAutoStrategy(variants = []) {
  const ok = (Array.isArray(variants) ? variants : [])
    .filter((v) => v && AUTO_CANDIDATES.includes(v.name) && Number.isFinite(v.bins));
  if (ok.length === 0) return null;
  const rank = (v) => READABILITY_RANK[readabilityOf(v.minW, v.minH)] ?? 0;
  const fits = ok.filter((v) => rank(v) >= READABILITY_RANK[AUTO_MIN_READABILITY]);
  const order = (v) => AUTO_CANDIDATES.indexOf(v.name);
  // 一个都看不清时**先看钱，再看格子**。
  //
  // 这里踩过坑：原来按"最小格面积最大"退，等于永远选 full —— 因为 full 把 1 档帧
  // 原样留着（一帧独占整张画布），格子在数字上确实最大，可一张图就只能装一帧。
  // 实测一条 191 刀的 5 分钟素材：full **59 张**、compact 9 张、skim 3 张，差 6.5 倍钱，
  // 而三者都到不了 shot 可读性。反正都要糊，那就糊在少花钱的那一档上。
  if (fits.length === 0) {
    return [...ok].sort((a, b) => (a.bins - b.bins)
      || ((b.minW * b.minH) - (a.minW * a.minH))
      || (order(a) - order(b)))[0].name;
  }
  return [...fits].sort((a, b) => (a.bins - b.bins)
    || ((b.frames ?? 0) - (a.frames ?? 0))
    || (order(a) - order(b)))[0].name;
}

export function applyStrategy(tiers, strategy = DEFAULT_STRATEGY) {
  const s = STRATEGIES[resolveStrategy(strategy)] ?? STRATEGIES[DEFAULT_STRATEGY];
  // 固定档：不管原来算出来是几档，全部压到同一档（恭喜发财档就是全 1/8）
  if (s.fixed) return tiers.map((t) => (Number(t) === 0 ? 0 : s.fixed));
  return tiers.map((t) => {
    const n = Number(t);
    // 0 = 自由尺寸的补位帧：没有档位可调，原样保留
    if (n === 0) return 0;
    let v = (Number.isFinite(n) ? n : TIER_MIN) + s.bump;
    if (s.floor) v = Math.max(s.floor, v);
    return Math.max(TIER_MIN, Math.min(TIER_MAX, v));
  });
}

/* ------------------------------------------------------------------ 积分取帧 */

/**
 * 积分阈值的**绝对**参考分："中等强度画面"每帧该有的变化量（0–255 尺度）。
 *
 * 标定自真实素材的 clean 均分（剔除真切点 ±0.35s 后真正参与积分的样本）：
 * 慢节奏动画 0.79 / 实拍 2.92 / 连续运动 3.37 / 快剪 4.75 / 缓慢渐变 7.33。
 * 取 4 让"常规实拍运动"落在原来的 equivSeconds 附近，只在两端拉开差距。
 */
export const INTEGRAL_REF_SCORE = 4;

/**
 * **积分采样点（假切点）**：沿时间累加画面变化率，累够阈值就记一个点、然后清零。
 *
 * 这是用户要的"积分取帧"，顺序上**排在真切点之后**：
 *   - 真切点先定边界（它们是硬切，不能动）；
 *   - 假切点只在真切点之间补，并且离真切点太近就不补（真切点自己已经是边界）。
 *
 * **阈值必须是绝对值**：`T = INTEGRAL_REF_SCORE × fps × equivSeconds`。
 *
 * 曾经写成 `T = 全片平均每秒变化量 × equivSeconds` —— 那是错的：画面动得越厉害，
 * 平均分越高，阈值也跟着涨，两者抵消，于是不管素材多快多慢，都是固定
 * `equivSeconds` 秒一个点（实测变化率 2/s 到 64/s 都输出 19 个点、间隔恒为 6.0s）。
 * 积分就此退化成等间隔抽样，"动的快的地方多取帧"这个能力完全消失。
 * 同一段素材内部的快慢差异（相对）当时是保留的，丢的是**整段素材的快慢**（绝对）。
 *
 * 换成绝对阈值后：慢素材要攒更久（帧少、格子大），快素材很快攒满（帧多、格子小），
 * 这才是用户要的"跟着画面走"。
 *
 * @param {{duration:number, series:Array<{t:number,score:number}>, cuts?:number[],
 *          start?:number, equivSeconds?:number, minGap?:number, skipNearCut?:number,
 *          fps?:number}} o
 * @returns {number[]} 采样时刻（绝对秒，升序）
 */
export function integralMarks({
  duration, series = [], cuts = [], start = 0,
  equivSeconds = 6, minGap = 0.8, skipNearCut = 0.35, fps,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const pts = (Array.isArray(series) ? series : [])
    .filter((s) => Number.isFinite(s?.t) && s.t >= start && s.t < start + duration)
    .sort((a, b) => a.t - b.t);
  const real = [...cuts].filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
  // 真切点附近的分不参与累加：那一帧的分是"跨过这一刀"的差值（40~100），
  // 混进来会把阈值抬到"只有连续狂甩才够"。
  const clean = pts.filter((s) => !real.some((c) => Math.abs(c - s.t) < skipNearCut));
  // 阈值只跟"参考画面 + 时间"有关，**和本片自己的平均变化量无关**（见上面的说明）。
  // 缺省用 series 自身的采样率推 fps：stats 是逐帧来的，间隔就是 1/fps。
  const rate = Number(fps) > 0
    ? Number(fps)
    : (pts.length > 1 && pts[pts.length - 1].t > pts[0].t
      ? (pts.length - 1) / (pts[pts.length - 1].t - pts[0].t)
      : 12);
  const T = INTEGRAL_REF_SCORE * rate * equivSeconds;
  if (!(T > 0)) return [];

  const out = [];
  let acc = 0;
  let last = -Infinity;
  for (const p of clean) {
    acc += Math.max(0, Number(p.score) || 0);
    if (acc < T) continue;
    acc = 0;                                   // 触发即清零，重新积
    if (p.t - last < minGap) continue;
    if (real.some((c) => Math.abs(c - p.t) < skipNearCut)) continue;
    out.push(+p.t.toFixed(3));
    last = p.t;
  }
  return out;
}

/* ------------------------------------------------------------------ 帧序列 */

/**
 * 边界 → 帧序列（一段一帧）。
 *
 * 边界 = 真切点 + 积分假切点 + 两端。太短的段（< minLen）并进前一段：
 * 0.03 秒的"段"取不出有意义的画面，只会多花一次 ffmpeg。
 *
 * `maxFrames <= 0` = **不封顶**（默认）。给了正数才按"合并最短的段"收缩：
 * 快剪区的段本来就短、相邻画面也最像，合并它们的损失最小；长镜头每段只有一帧，动了就整段消失。
 *
 * 每段带 `via`，说明它是被什么切出来的：
 *   'cut'   真切点之后 —— 一个独立的镜头
 *   'mark'  积分假切点之后 —— 画面在**连续变化**，攒够了才切一刀
 *   'start' 片头第一段
 * 假切点的段要给更小的格子（见 `applyMarkBoost`）。
 *
 * @returns {Array<{from:number,to:number,t:number,cut:boolean,via:'cut'|'mark'|'start'}>}
 */
export function framesFromBounds({
  duration, cuts = [], marks = [], maxFrames = 0, minLen = 0.08, start = 0,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const rawCap = Number(maxFrames);
  // 0 / 负数 / 非数字 = 不限。**不要**用 `|| 1` 兜底：那会把"没限制"变成"最多一帧"
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? Math.max(1, Math.round(rawCap)) : Infinity;
  const cutSet = new Set(cuts.map((c) => +Number(c).toFixed(3)));
  const markSet = new Set(marks.map((c) => +Number(c).toFixed(3)));
  const all = [...cuts, ...marks]
    .filter((t) => Number.isFinite(t) && t > start && t < start + duration)
    .sort((a, b) => a - b);

  const bounds = [start];
  for (const t of all) {
    if (t - bounds[bounds.length - 1] >= minLen) bounds.push(t);
  }
  bounds.push(start + duration);

  let segs = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (!(to > from)) continue;
    const key = +from.toFixed(3);
    segs.push({
      from, to,
      t: (from + to) / 2,
      cut: cutSet.has(key),
      via: cutSet.has(key) ? 'cut' : (markSet.has(key) ? 'mark' : 'start'),
    });
  }
  if (segs.length === 0) {
    return [{ from: start, to: start + duration, t: start + duration / 2, cut: false, via: 'start' }];
  }

  // 合并最短段 → 直到不超过上限
  while (segs.length > cap) {
    let k = 0;
    for (let i = 1; i < segs.length; i += 1) {
      if (segs[i].to - segs[i].from < segs[k].to - segs[k].from) k = i;
    }
    const left = k > 0 ? segs[k - 1] : null;
    const right = k < segs.length - 1 ? segs[k + 1] : null;
    const pickLeft = left && (!right
      || (left.to - left.from) <= (right.to - right.from));
    if (pickLeft) {
      segs.splice(k - 1, 2, {
        from: left.from, to: segs[k].to, t: (left.from + segs[k].to) / 2, cut: left.cut, via: left.via,
      });
    } else if (right) {
      segs.splice(k, 2, {
        from: segs[k].from, to: right.to, t: (segs[k].from + right.to) / 2, cut: segs[k].cut, via: segs[k].via,
      });
    } else break;
  }
  return segs;
}

/**
 * **积分假切点切出来的帧，档位提 `MARK_BOOST`（3）档。**
 *
 * 真切点是"换镜头"，假切点是"这一段一直在变、攒够了才切"——后者没有硬边界，
 * 一帧代表不了多久，所以给更小的格子（1/1 → 1/4、1/4 → 1/7）。
 *
 * 加在 `applyStrategy` **之前**：策略是全局偏向（quality 全体升一档），
 * 假切点的额外加成是内容驱动的，两者叠起来才能让"运动段"在任何策略下都比周围细。
 */
export const MARK_BOOST = 3;

export function applyMarkBoost(tiers, segs, boost = MARK_BOOST) {
  return tiers.map((t, i) => {
    const n = Number(t);
    if (n === 0) return 0;                     // 自由尺寸的补位帧不参与档位加成
    const extra = segs[i]?.via === 'mark' ? boost : 0;
    return Math.max(TIER_MIN, Math.min(TIER_MAX, (Number.isFinite(n) ? n : TIER_MIN) + extra));
  });
}

/**
 * **档位映射表**：模型直接说"原 1 档的帧给我放到 3 档、5 档以上全都按 4 档算"。
 *
 * 这是最后一道闸门，接在 `applyStrategy` 之后 —— 前面那套（切点密度 → 档位 → 策略）
 * 是算法自己的判断，这里是调用方的覆盖意见，说啥就是啥：
 *
 *     { 1: 3, 2: 2, 5: 4, 6: 4, 7: 4, 8: 4 }   // 长镜头放大、快剪全部合并到 1/4
 *     { 1: 1, 2: 1 }                            // 只要两档，其余不动
 *
 * **没写的档位原样保留**（不是"消失"），补位帧（tier 0）不参与映射。
 * 映射到同一档 = 合并视觉尺寸；全映射到 1 = 每帧满格（张数会炸，清单会报）。
 *
 * @param {number[]} tiers
 * @param {Record<number|string, number>|null} map
 * @returns {number[]}
 */
export function applyTierMap(tiers, map) {
  if (!map || typeof map !== 'object') return tiers;
  const norm = {};
  for (const [k, v] of Object.entries(map)) {
    const from = Math.round(Number(k));
    const to = Math.round(Number(v));
    if (from >= TIER_MIN && from <= TIER_MAX && to >= TIER_MIN && to <= TIER_MAX) norm[from] = to;
  }
  if (Object.keys(norm).length === 0) return tiers;
  return tiers.map((t) => {
    const n = Math.round(Number(t));
    if (n === 0) return 0;                    // 自由尺寸帧不映射
    return norm[n] ?? n;
  });
}

/** 档位分布，给清单用：`{1:2, 3:8, 4:5}`。 */
export function tierHistogram(tiers) {
  const out = {};
  for (const t of tiers) out[t] = (out[t] ?? 0) + 1;
  return out;
}

/**
 * 可读性分档：清单要据此说"这格能不能认字"，而不只是报两个数字。
 * 口径是**像素**不是比例 —— 换画布大小不该改变"读不清"这个结论。
 *
 *   text        480×270 以上，字能认
 *   scene       320×180 以上，能认出脸和动作
 *   shot        160×90 以上，能分辨"是不是同一个镜头"
 *   composition 再小就只是色块
 */
export function readabilityOf(w, h) {
  const area = (Number(w) || 0) * (Number(h) || 0);
  if (w >= 480 && h >= 270) return 'text';
  if (area >= 320 * 180) return 'scene';
  if (area >= 160 * 90) return 'shot';
  return 'composition';
}
