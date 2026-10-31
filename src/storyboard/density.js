/**
 * density.js — 按"画面密度"分配格位：快切区多给格，长镜头少给格。
 *
 * 为什么需要：`fitSegments` 会把短镜头**并进邻居**（为了避免 0.3s 的镜头独占一格），
 * 结果是快切爆发区被压成 1 格、只留一张代表帧 —— 那一段里"发生了什么"就丢了。
 * 而 16 格的总预算是固定的，所以正确做法不是"加格"，而是**把格往密的地方挪**。
 *
 * 做法：给时间轴建一条密度曲线（普通处 1.0，快切爆发处 1+boost），
 * 然后在"密度积分"上等分 —— 积分等分 = 每一格承载的"信息量"相同，
 * 于是快切区自然分到更短的时段、更多的格。整段时间轴仍然被完整覆盖。
 */

export const BIN = 0.1;             // 密度采样粒度（秒）
export const RATE_WINDOW = 2.0;     // 局部剪辑率的统计半窗（秒）
export const MAX_DENSITY = 2.5;     // 密度上限：最快的区域最多拿到 2.5 倍格位（再高就会喧宾夺主）

/**
 * 局部剪辑率：t 附近 ±window 秒内有多少个切点，换算成"每秒几刀"。
 * 用二分查找，O(log n)/bin。
 */
function localRate(sorted, t, window, duration) {
  const lo = t - window;
  const hi = t + window;
  const count = upperBound(sorted, hi) - lowerBound(sorted, lo);
  const span = Math.min(duration, hi) - Math.max(0, lo);
  return span > 0 ? count / span : 0;
}

const lowerBound = (arr, v) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
};
const upperBound = (arr, v) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1; else hi = mid;
  }
  return lo;
};

/**
 * 密度曲线：density(t) = clamp(局部剪辑率 / 全片平均剪辑率, 1, MAX_DENSITY)
 *
 * 不用"固定 1.2s 算快切"那种硬阈值——一条 PV 的平均镜头本来就 2.2s，
 * 硬阈值会一个爆发都认不出来。改成**和这条片子自己的平均节奏比**：
 * 比平均快 3 倍的地方拿 3 倍格位，慢于平均的地方不额外给格。
 */
export function densityCurve({
  duration, cuts = [], bin = BIN, window = RATE_WINDOW, max = MAX_DENSITY, speech,
}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const sorted = [...cuts].filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const bins = Math.max(1, Math.ceil(duration / bin));
  const out = new Float64Array(bins);
  if (sorted.length === 0) {
    out.fill(1);
    return { bins, density: out, meanRate: 0, peakRate: 0 };
  }
  const meanRate = sorted.length / duration;
  // 两遍：先算逐 bin 的局部率，再做一次同宽度的箱型平滑。
  // 不平滑的话，**均匀剪辑**的片子会在每个切点附近鼓一个包（窗口里多算了一刀），
  // 实战里会认出一堆假"爆发"。
  const half = Math.max(1, Math.round(window / bin));
  const raw = new Float64Array(bins);
  for (let i = 0; i < bins; i++) raw[i] = localRate(sorted, i * bin, window, duration);
  const prefix = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) prefix[i + 1] = prefix[i] + raw[i];
  let peakRate = 0;
  for (let i = 0; i < bins; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(bins, i + half + 1);
    const smooth = (prefix[hi] - prefix[lo]) / (hi - lo);
    peakRate = Math.max(peakRate, smooth);
    out[i] = Math.min(max, Math.max(1, meanRate > 0 ? smooth / meanRate : 1));
  }

  // 第三条信号：台词密度（每秒字数）。说话快的地方信息密，也该多给格。
  // 只做温和放大（0.75–1.4），免得把画面信号压过去。
  if (speech && speech.mean > 0) {
    for (let i = 0; i < bins; i++) {
      const ratio = speech.curve[Math.min(speech.bins - 1, i)] / speech.mean;
      const factor = Math.min(1.4, Math.max(0.75, ratio));
      out[i] = Math.min(max, Math.max(1, out[i] * factor));
    }
  }
  return { bins, density: out, meanRate, peakRate };
}

/**
 * 用**画面变化率本身**当密度，而不是用切点计数。
 *
 * 为什么：切点计数是"离散事件"——一处误报就在那里顶起一个密度尖峰；
 * 而变化率是连续信号，一段时间都在动就是一段平台，分格自然平滑。
 * 三个一镜到底的真实素材上量过，格长离散度从 0.53/0.52/0.26 降到 0.33/0.36/0.21。
 *
 * 更关键的是：**它不依赖切点检测准不准**。一镜到底的素材就算误报 3 个切点，
 * 分格结果依然平滑 —— 因为 3 个孤立切点在半秒的箱型平滑里根本鼓不起来。
 * 这也是"多一两帧误判无所谓"这句话在数学上的依据。
 *
 * @param {{duration:number, scores:Array<{t:number,score:number}>, bin?:number,
 *          window?:number, max?:number, offset?:number, speech?:object}} opts
 *   scores: 逐帧分数，t 用绝对秒；offset 是本窗口起点（转成相对时间用）
 * @returns {{bins:number, density:Float64Array, meanScore:number}}
 */
export function densityFromScore({
  duration, scores, bin = BIN, window = 0.5, max = MAX_DENSITY, offset = 0, speech,
}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const bins = Math.max(1, Math.ceil(duration / bin));

  // 先算逐帧分数的 p95 当上限（winsorize）。
  // 不截的话，单帧极端值会主导整段密度：实测 MAD 前 30 秒有一次黑场，score 78.9，
  // 而同期真切只有 40 —— 那一帧把旁边的格子吸成 1.83 秒，格长离散度从 0.174 恶化到 0.276。
  // 削到 p95 之后极端值只保留"很多帧都这么大"的那部分，符合"这段一直在变"才有资格拿格位。
  const usable = (scores ?? []).filter((s) => s.t - offset >= 0 && s.t - offset < duration);
  const sortedAll = usable.map((s) => s.score).sort((a, b) => a - b);
  const scoreCap = sortedAll.length ? sortedAll[Math.floor(sortedAll.length * 0.95)] : Infinity;

  const acc = new Float64Array(bins);
  const cnt = new Uint32Array(bins);
  for (const s of usable) {
    const rel = s.t - offset;
    const i = Math.min(bins - 1, Math.floor(rel / bin));
    acc[i] += Math.min(s.score, scoreCap);
    cnt[i] += 1;
  }

  const raw = new Float64Array(bins);
  let filled = 0;
  for (let i = 0; i < bins; i++) {
    if (cnt[i]) { raw[i] = acc[i] / cnt[i]; filled += 1; }
  }
  if (filled === 0) return { bins, density: new Float64Array(bins).fill(1), meanScore: 0 };

  // 箱型平滑：不平滑的话，一次切点会在它前后各鼓一个包，分格跟着抖
  const half = Math.max(1, Math.round(window / bin));
  const pre = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) pre[i + 1] = pre[i] + raw[i];
  const smooth = new Float64Array(bins);
  let mean = 0;
  for (let i = 0; i < bins; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(bins, i + half + 1);
    smooth[i] = (pre[hi] - pre[lo]) / (hi - lo);
    mean += smooth[i];
  }
  mean /= bins;

  // 归一化到"全片平均变化率 = 1"，再夹到 [1, max]：
  // 比平均安静的地方也至少拿 1 份（格子不会因为"没内容"被压没），
  // 比平均剧烈的地方最多拿 max 倍（MAX_DENSITY 原本就有这层意思）。
  const out = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    out[i] = Math.min(max, Math.max(1, mean > 0 ? smooth[i] / mean : 1));
  }

  // 台词密度：说话快的地方信息密，温和放大（0.75–1.4），和 densityCurve 同一口径
  if (speech && speech.mean > 0) {
    for (let i = 0; i < bins; i++) {
      const ratio = speech.curve[Math.min(speech.bins - 1, i)] / speech.mean;
      const factor = Math.min(1.4, Math.max(0.75, ratio));
      out[i] = Math.min(max, Math.max(1, out[i] * factor));
    }
  }
  return { bins, density: out, meanScore: mean };
}

/**
 * 找出"剪辑最密"的时段（只用于报告，不影响分配）。
 */
export function findBursts(cuts, duration, { window = RATE_WINDOW, max = MAX_DENSITY } = {}) {
  // densityCurve 只认数字；调用方有时传 {t}，这里统一一次
  const ts = cuts.map((c) => (typeof c === 'number' ? c : c.t));
  const { density, bins, meanRate } = densityCurve({ duration, cuts: ts, window, max });
  if (meanRate === 0) return [];
  const bursts = [];
  let start = -1;
  for (let i = 0; i <= bins; i++) {
    const hot = i < bins && density[i] > 1.5;
    if (hot && start < 0) start = i;
    if (!hot && start >= 0) {
      const to = +Math.min(duration, i * BIN).toFixed(2);
      const from = +(start * BIN).toFixed(2);
      bursts.push({
        from,
        to,
        density: +density[start].toFixed(2),
        // 这一小段里切了几刀 —— 只有密度数字时，模型还得自己反推"到底几个镜头"
        shots: ts.filter((t) => t >= from && t < to).length,
      });
      start = -1;
    }
  }
  return bursts;
}

/**
 * 把 [0, duration] 切成 cells 段，使每段承载的"密度积分"相等。
 * 切点会尝试吸附到真实剪辑点，但**位移超过理想格长的 30% 就放弃吸附**——
 * 否则吸附会把权重分配整个打乱（实测踩过：全片都被拉到剪辑点上，格长变得不均匀）。
 *
 * @returns {Array<{from:number,to:number,density:number,dur:number}>}
 */
export function planCellRanges({
  duration, cuts = [], cells, bin = BIN, window = RATE_WINDOW, max = MAX_DENSITY,
  snap = 2.0, snapRatio = 0.3, minLen = 0.3, speech, audioEvents = [], scoreDensity,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  if (!Number.isInteger(cells) || cells < 1) throw new RangeError(`cells must be a positive integer, got ${cells}`);

  // 密度来源二选一：
  //   默认走「切点计数」（densityCurve），保留了多年的行为；
  //   传了 scoreDensity 就走「画面变化率」（densityFromScore）。
  // 后者在三个一镜到底的真实素材上量过，格长离散度 0.53/0.52/0.26 → 0.33/0.36/0.21，
  // 而且不依赖切点检得准不准 —— 误报 3 个切点也造不出密度尖峰。
  const { density, bins } = scoreDensity
    ? { density: Float64Array.from(scoreDensity.density), bins: scoreDensity.bins }
    : densityCurve({ duration, cuts, bin, window, max, speech });

  // 声音事件加权：突然变响/突然安静的地方，画面往往没变但事情发生了，
  // 给它 ±1 秒的密度加成，让边界往那儿靠（权重保守，1.6 倍，避免盖过画面信号）。
  for (const e of audioEvents) {
    const center = Math.round(e.t / bin);
    const half = Math.round(1.0 / bin);
    for (let i = Math.max(0, center - half); i < Math.min(bins, center + half); i++) {
      density[i] = Math.min(max, density[i] * 1.6);
    }
  }
  const cum = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) cum[i + 1] = cum[i] + density[i] * bin;
  const total = cum[bins] || duration;
  const idealLen = duration / cells;

  const candidates = [...cuts].filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const snapTo = (t, limit) => {
    let best = t;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestD) { best = c; bestD = d; }
    }
    return bestD <= Math.min(limit, snap) ? best : t;
  };

  const bounds = [0];
  for (let j = 1; j < cells; j++) {
    const target = (total * j) / cells;
    let lo = 0;
    let hi = bins;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    let t = Math.min(duration, Math.max(0, lo * bin));
    t = snapTo(t, idealLen * snapRatio);
    t = Math.max(t, bounds.at(-1) + minLen);
    t = Math.min(t, duration - minLen * (cells - bounds.length));
    if (t > bounds.at(-1)) bounds.push(t);
  }
  bounds.push(duration);

  const ranges = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    const idx = Math.min(bins - 1, Math.floor(((from + to) / 2) / bin));
    ranges.push({ from, to, density: +density[idx].toFixed(2), dur: to - from });
  }
  return ranges;
}


/**
 * **rodt 函数** —— 每格长度 = 常数 ÷ 该处的切点密度。
 *
 * 密度 A（刀/秒）越大 → 每格长度 B 越短，B = K / A。这是最直觉的关系：
 * 一分钟切 30 刀的地方，一格放 2 秒就够；一分钟才切 1 刀的地方，一格放 60 秒也不算长。
 *
 * 和 `planCellRanges` 的区别在这里：
 *   - `planCellRanges` 把密度夹到 [1, 2.5] 倍（MAX_DENSITY），且算的是**相对全片平均**的倍数。
 *     结果最密的地方和最疏的地方最多只差 2.5 倍 —— 实测段长 8.5~21.1s，拉不开。
 *   - 这里用**绝对密度**、不做上限夹取（只兜一个下限防止除零），
 *     所以快段和慢段能差十几倍，正好对应"快切要细、长镜头要粗"。
 *
 * 实现上用"累积密度等分"：∫density·dt 每段相等 → 段长 L = C/density，天然就是 1/A。
 * 不用逐点算 1/A 再累加（那反而会算成 L ∝ A，方向是反的）。
 *
 * @param {{cuts:number[], duration:number, cells:number,
 *          window?:number, minDensity?:number, snapTo?:number}} opts
 *   window      算局部密度的观察半径（秒）
 *   minDensity  密度下限（刀/秒），防止长时间无切点时除零
 *   snapTo      段长吸附粒度（秒）：数据是离散的，掐到 0.5 秒的整数倍便于对齐
 * @returns {Array<{from:number,to:number,dur:number,density:number,shots:number}>}
 */
export function planByRodt({
  cuts = [], duration, cells, window = 5, minDensity = 0.02, snapTo = 0.5, maxDensity = 20,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  if (!Number.isInteger(cells) || cells < 1) throw new RangeError(`cells must be a positive integer, got ${cells}`);

  const marks = cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const shots = marks.length + 1;
  if (shots <= cells) {
    const bounds = [0, ...marks, duration];
    return bounds.slice(0, -1).map((from, i) => {
      const to = bounds[i + 1];
      return { from, to, dur: to - from, density: +(1 / Math.max(0.1, to - from)).toFixed(2), shots: 1 };
    });
  }

  // 1) 累积密度：cum(t) = 从 0 到 t 一共"切了多少刀"
  //    用累积而不是逐点密度，是为了让等分等价于 ∫density·dt 相等。
  const cum = (t) => marks.filter((c) => c <= t).length;
  // 2) 找 cells-1 个内点，让每段的"切点数"尽可能相等
  //    （切点数相等 = 密度积分相等 → 段长 ∝ 1/密度）
  const targets = [];
  for (let j = 1; j < cells; j++) targets.push((marks.length * j) / cells);

  const bounds = [0];
  for (const tgt of targets) {
    // 3) 离散化：边界直接落在**切点**上。
    //    切点本身就是离散的（0.01 秒精度），再吸附到 0.5 秒反而会把边界挪离切点，
    //    导致一段里跨进半个镜头 —— 那正是"每格装多少镜头"失准的原因。
    const idx = Math.min(marks.length - 1, Math.max(0, Math.round(tgt)));
    let t = marks[idx] ?? duration;
    t = Math.max(t, bounds.at(-1) + (snapTo > 0 ? snapTo : 0.01));
    t = Math.min(t, duration - snapTo * (cells - bounds.length));
    if (t > bounds.at(-1)) bounds.push(t);
  }
  bounds.push(duration);

  return bounds.slice(0, -1).map((from, i) => {
    const to = bounds[i + 1];
    const n = cum(to) - cum(from) + 1;
    return {
      from, to, dur: +(to - from).toFixed(2),
      density: +(n / Math.max(0.1, to - from)).toFixed(2),
      shots: n,
    };
  });
}

/**
 * **按「累计画面帧数」切 sheet** —— 流程的最后一步。
 *
 * 为什么不能用"时间"或"格数"来切：
 *   - 按时间切：快剪段和长镜头段拿到一样长的图，前者塞不下、后者太空
 *   - 按格数切：一格不摊是 1 帧、摊 3×3 是 9 帧，格数一样但信息量差 9 倍
 *
 * 正确做法是先把画面**排好**（rodt 分格 + 每格决定摊几×几），
 * 再沿时间累加每个格点贡献的帧数（k²），累到预算就切一张。
 * 因为切的是**格点边界**，而格点边界本来就在切点上，所以两张之间天然衔接、不断裂：
 * 上一张最后一个切点就是下一张的起点。
 *
 * @param {Array<{from:number,to:number,k?:number}>} cells 已排好的格点（时序）
 * @param {{frameBudget?:number, maxCellsPerSheet?:number}} opts
 *   frameBudget      一张图累计多少帧就切（建议 64）
 *   maxCellsPerSheet 单张最多几个大格点（布局上限，默认 16）
 * @returns {Array<Array>} 每个元素是一张 sheet 的格点数组
 */
export function planSheetsByFrames(cells, { frameBudget = 64, maxCellsPerSheet = 16 } = {}) {
  if (!Array.isArray(cells)) throw new TypeError('cells must be an array');
  if (cells.length === 0) return [];
  const framesOf = (c) => Math.max(1, (c.k ?? 1) ** 2);
  const totalFrames = cells.reduce((n, c) => n + framesOf(c), 0);
  const cap = Math.max(1, Math.round(Number(maxCellsPerSheet)) || 16);

  // **先算要几张，再按帧数比例分格**（2026-10-31 二审：原来是"装满再切"的贪心）。
  //
  // 旧写法两个毛病：
  //  1. **张数会超出这个公式**：`acc + frames > target*1.1` 一到就 flush，没有"剩余格数还够不够
  //     填满剩余张数"的兜底。实测 25 格 / cap 9：公式 3 张，实际切出 4 张（9+8+6+2）；
  //     真实素材更难看 —— 18 格 / cap 9 切出 **9+8+1**，最后一张是 1377×771 的单格巨图。
  //  2. flush 的时机取决于**下一格有多重**，于是同样的格数换个 k 分布就换一种切法。
  //
  // 现在：count 定死，每张在"给后面留够格数"的前提下，取**帧数最接近剩余均值**的那一刀。
  // 于是每张帧数接近、张数恒等于 count、不会出现只剩 1 格的尾巴。
  const count = Math.min(
    cells.length,
    Math.max(
      1,
      Math.ceil(totalFrames / Math.max(1, frameBudget)),
      Math.ceil(cells.length / cap),
    ),
  );
  const prefix = new Array(cells.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < cells.length; i += 1) prefix[i + 1] = prefix[i] + framesOf(cells[i]);

  const sheets = [];
  let start = 0;
  for (let s = 0; s < count; s += 1) {
    const left = count - s;              // 含正在装的这张
    const rest = cells.length - start;   // 还没装进去的格数（含当前这一格）
    if (left === 1) {
      // 最后一张把剩下的全收下（它一定 ≤ cap，因为 count 是向上取整来的）
      sheets.push(cells.slice(start));
      break;
    }
    // 本张能装几格：后面每张至少留 1 格、至多留 cap 格
    const minTake = Math.max(1, rest - (left - 1) * cap);
    const maxTake = Math.min(cap, rest - (left - 1));
    const target = (prefix[cells.length] - prefix[start]) / left;
    let take = minTake;
    let bestErr = Infinity;
    for (let n = minTake; n <= maxTake; n += 1) {
      const err = Math.abs(prefix[start + n] - prefix[start] - target);
      if (err < bestErr) { bestErr = err; take = n; }
    }
    sheets.push(cells.slice(start, start + take));
    start += take;
  }
  return sheets;
}

/**
 * **积分采样点（假切点）** —— 沿时间累加画面变化率，累够阈值就记一个点、然后清零。
 *
 * 为什么放在"扫描之后"而不是"取帧的时候"：取帧那一层只知道"这一格要几张"，
 * 而这里能拿到**全片的逐帧分数**。把触发点当成额外的切点交给下游，
 * rodt 分格、二重细分、取帧全部原样复用 —— 不需要新的一套采样器。
 *
 * 阈值怎么定：`T = 全片平均每秒变化量 × equivSeconds`。
 * 所以每个采样点代表"约 equivSeconds 秒的平均变化"：
 *   - 长时间静止的段落永远累积不到 T → 一个点都不加 → 那一格还是一张整帧；
 *   - 摇镜/推拉/连续动作的地方会连续触发 → 那一段自然被切成几块、多取几张。
 * **它是唯一真正自由的旋钮**：音频驱动（音乐片信息全在画面上）就是把 equivSeconds 调小。
 *
 * 两条必须的排除：
 *  1. 真切点附近不补点 —— 真切点本身就是边界，再补一个是重复；
 *  2. 两个点之间至少 minGap 秒 —— 一次爆发里的连续触发会挤成一堆。
 *
 * 注意：这些点**只用于"格内怎么取帧"**，不并进 `cuts`。清单里的"切点 N 个"必须是真切点，
 * 否则模型会以为那些地方有硬切 —— 假切点描述的是"这里变化攒够了"，不是"这里是一刀"。
 *
 * @param {{duration:number, series:Array<{t:number,score:number}>, cuts?:number[],
 *          start?:number, equivSeconds?:number, minGap?:number, skipNearCut?:number}} opts
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
  // **真切点附近的分不参与累加**。那一帧的分数是"跨过这一刀"的差值（实测 40~100），
  // 比一次摇镜高一两个数量级；混进来会把阈值抬到"只有连续动作狂甩才够"，
  // 于是这批切点密的地方一个采样点都加不出来。真切点本来就自带边界，不需要再补。
  const clean = pts.filter((s) => !real.some((c) => Math.abs(c - s.t) < skipNearCut));
  const total = clean.reduce((acc, s) => acc + Math.max(0, Number(s.score) || 0), 0);
  if (!(total > 0)) return [];

  // 全片平均每秒变化量 × equivSeconds。用全片均值当基准，换素材不用重新调参。
  const T = (total / duration) * equivSeconds;
  if (!(T > 0)) return [];

  const out = [];
  let acc = 0;
  let last = -Infinity;
  for (const p of clean) {
    acc += Math.max(0, Number(p.score) || 0);
    if (acc < T) continue;
    acc = 0;                                     // 触发即清零
    if (p.t - last < minGap) continue;
    if (real.some((c) => Math.abs(c - p.t) < skipNearCut)) continue;
    out.push(+p.t.toFixed(3));
    last = p.t;
  }
  return out;
}
