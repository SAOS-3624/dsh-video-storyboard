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
  snap = 2.0, snapRatio = 0.3, minLen = 0.3, speech, audioEvents = [],
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  if (!Number.isInteger(cells) || cells < 1) throw new RangeError(`cells must be a positive integer, got ${cells}`);

  const { density, bins } = densityCurve({ duration, cuts, bin, window, max, speech });

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
