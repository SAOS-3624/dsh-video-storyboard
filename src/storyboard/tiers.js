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

/** 画布上限：DS 视觉只吃 800×800 / 384 token，超过就是白花字节。 */
export const MAX_CANVAS_SIDE = 800;

/**
 * 画布尺寸：面积 <= budget，且**任一边不超过 800**（DS 的视觉上限）。
 *
 * 16:9 + 640k 算出来是 1066×600，会被 800 卡成 800×450 —— 这正是用户实测的
 * "再大就没意义"：超过 800 的部分宿主会缩回去，而清单里的格子尺寸就成了假数。
 */
export function fitCanvas(aspect, { maxSide = MAX_CANVAS_SIDE, budget = 640_000 } = {}) {
  const a = Math.max(0.2, Math.min(5, Number(aspect) || 16 / 9));
  const area = Math.max(64_000, Number(budget) || 640_000);
  let w = Math.sqrt(area * a);
  let h = w / a;
  const shrink = Math.min(1, maxSide / w, maxSide / h);
  return {
    width: Math.max(64, Math.round(w * shrink)),
    height: Math.max(36, Math.round(h * shrink)),
    aspect: a,
  };
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
  skim: 2.5,        // 把"多一张"算贵，尽量一张装完
  brief: 2.5,
});
/** 默认从"标准"改成"紧凑"：实测同一段 5 分钟素材 19 张 → 10 张，画面还看得清。 */
export const DEFAULT_STRATEGY = 'compact';

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
 * **积分采样点（假切点）**：沿时间累加画面变化率，累够阈值就记一个点、然后清零。
 *
 * 这是用户要的"积分取帧"，顺序上**排在真切点之后**：
 *   - 真切点先定边界（它们是硬切，不能动）；
 *   - 假切点只在真切点之间补，并且离真切点太近就不补（真切点自己已经是边界）。
 *
 * 阈值 `T = 全片平均每秒变化量 × equivSeconds`，所以每个采样点代表"约 equivSeconds 秒
 * 的平均变化"：长时间静止的段落一个点都攒不出来（那一段就该一张整帧），
 * 摇镜/推拉/连续动作的地方会连续触发（那一段自然多几帧）。
 *
 * @param {{duration:number, series:Array<{t:number,score:number}>, cuts?:number[],
 *          start?:number, equivSeconds?:number, minGap?:number, skipNearCut?:number}} o
 * @returns {number[]} 采样时刻（绝对秒，升序）
 */
export function integralMarks({
  duration, series = [], cuts = [], start = 0,
  equivSeconds = 6, minGap = 0.8, skipNearCut = 0.35,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const pts = (Array.isArray(series) ? series : [])
    .filter((s) => Number.isFinite(s?.t) && s.t >= start && s.t < start + duration)
    .sort((a, b) => a.t - b.t);
  const real = [...cuts].filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
  // 真切点附近的分不参与累加：那一帧的分是"跨过这一刀"的差值（40~100），
  // 混进来会把阈值抬到"只有连续狂甩才够"。
  const clean = pts.filter((s) => !real.some((c) => Math.abs(c - s.t) < skipNearCut));
  const total = clean.reduce((acc, s) => acc + Math.max(0, Number(s.score) || 0), 0);
  if (!(total > 0)) return [];
  const T = (total / duration) * equivSeconds;
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
 * **积分假切点切出来的帧，档位提两档。**
 *
 * 真切点是"换镜头"，假切点是"这一段一直在变、攒够了才切"——后者没有硬边界，
 * 一帧代表不了多久，所以给更小的格子（1/1 → 1/3、1/4 → 1/6）。
 *
 * 加在 `applyStrategy` **之前**：策略是全局偏向（quality 全体升一档），
 * 假切点的额外 +2 是内容驱动的，两者叠起来才能让"运动段"在任何策略下都比周围细。
 */
export const MARK_BOOST = 2;

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
