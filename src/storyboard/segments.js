/**
 * segments.js — 从切点推导内容段，并把它调到目标格数。纯函数。
 *
 * 三条规则（顺序不能反）：
 *  1. 切点 → 区间，丢掉过短段（闪光/抖动误检）
 *  2. 段数 > 目标：合并最短的一对相邻段（保护长镜头与关键段）
 *  3. 段数 < 目标：对半拆最长的段（单镜头长视频的唯一出路）
 */

/** 切点 → 有序、首尾相接的区间（from 用于"只看全片某一段"的场景） */
export function segmentsFromCuts(duration, cuts, minLen = 0.4, from = 0) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  const lo = from + minLen;
  const hi = from + duration - minLen;
  const inner = cuts
    .filter((c) => c > lo && c < hi)
    .sort((a, b) => a - b);
  const bounds = [from, ...inner, from + duration];
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] >= minLen) segs.push([bounds[i], bounds[i + 1]]);
  }
  // 窗口本身就比 minLen 还短（例如模型要 zoom 看 0.2 秒）：
  // 所有段都过不了长度门槛 → 这里会返回空数组，下游 fitSegments 解构 undefined 直接崩。
  // 短窗口本来就只能是一段，原样给它一整段。
  if (segs.length === 0 && duration > 0) return [[from, from + duration]];
  return mergeTail(segs);
}

/** 兜底：过滤后若出现空隙（被丢掉的切点），把尾段并回前一段，保证首尾相接 */
function mergeTail(segs) {
  if (segs.length === 0) return [];
  const out = [segs[0].slice()];
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1];
    if (Math.abs(segs[i][0] - prev[1]) < 1e-6) out.push(segs[i].slice());
    else prev[1] = segs[i][1];
  }
  return out;
}

export const segDur = (seg) => seg[1] - seg[0];
export const totalDur = (segs) => segs.reduce((s, seg) => s + segDur(seg), 0);

/**
 * 把短于 minGap 的段并进更短的那一侧邻居。
 *
 * 为什么需要：快剪处的 0.3s 镜头占一整格毫无意义（它的代表帧和相邻格几乎一样），
 * 而每格的机会成本是固定的。并掉之后，相邻采样点的间隔不会小于 minGap，
 * 等价于给"取帧"加了一个最小间隔。
 */
function mergeShorterThan(out, minGap) {
  if (!(minGap > 0)) return out;
  let guard = 0;
  while (out.length > 1 && guard++ < 10000) {
    const idx = out.findIndex((s) => segDur(s) < minGap);
    if (idx === -1) break;
    const left = idx > 0 ? segDur(out[idx - 1]) : Infinity;
    const right = idx < out.length - 1 ? segDur(out[idx + 1]) : Infinity;
    if (left <= right && idx > 0) {
      out.splice(idx - 1, 2, [out[idx - 1][0], out[idx][1]]);
    } else if (right < left && idx < out.length - 1) {
      out.splice(idx, 2, [out[idx][0], out[idx + 1][1]]);
    } else {
      break;
    }
  }
  return out;
}

/** 段长中位数：用来判断"这条片子能给到的最细粒度是多少" */
function medianDuration(segs) {
  const d = segs.map(segDur).sort((a, b) => a - b);
  if (d.length === 0) return 0;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
}

/**
 * 把段数调到 k，并保证每段不短于 minGap。
 * 顺序很重要：先并短段（保证采样间隔），再按 k 合并/拆分。
 * - 多于 k：反复合并"合并后最短"的那对相邻段
 * - 少于 k：反复对半拆最长的段（拆到 < minGap 就停）
 */
export function fitSegments(segs, k, { minGap = 0 } = {}) {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`);
  let out = segs.map((s) => [Number(s[0]), Number(s[1])]);
  // minGap 是"偏好"，不能超过素材本身能提供的粒度：
  // 一条全是 1s 短镜头的片子，硬按 1.2s 合并会把 6 段并成 3 段，反而凑不够格数。
  const gap = minGap > 0 ? Math.min(minGap, Math.max(0.2, medianDuration(out) * 0.9)) : 0;

  out = mergeShorterThan(out, gap);

  while (out.length > k) {
    let bestIdx = 0;
    let bestSum = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const sum = segDur(out[i]) + segDur(out[i + 1]);
      if (sum < bestSum) { bestSum = sum; bestIdx = i; }
    }
    const merged = [out[bestIdx][0], out[bestIdx + 1][1]];
    out.splice(bestIdx, 2, merged);
  }

  let guard = 0;
  while (out.length < k) {
    if (guard++ > 1000) break;
    let idx = 0;
    for (let i = 1; i < out.length; i++) if (segDur(out[i]) > segDur(out[idx])) idx = i;
    const [a, b] = out[idx];
    const floor = Math.max(0.2, gap);             // 拆完两半都不能比最小间隔还短
    if (b - a < floor * 2) break;
    const mid = (a + b) / 2;
    out.splice(idx, 1, [a, mid], [mid, b]);
  }
  return out;
}
