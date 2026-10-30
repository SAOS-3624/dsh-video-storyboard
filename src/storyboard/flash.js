/**
 * flash.js — 给每个切点**打标签**，不删除任何一个。
 *
 * 为什么是"打标签"不是"过滤"：删掉误检会让这段在插件眼里变成"完全静止的连续镜头"，
 * 反而丢了「这里一直在动」的信息。实测三个一镜到底的素材（体积雾/瀑布/手持），
 * 误报的切点删不删对分格影响很小，但**留着它们**能让密度曲线知道"这附近有变化"。
 *
 * 所以这里的产出是 `{...cut, type, evidence}`：
 *   flash    亮度脉冲（闪电、闪白）—— 画面没换，只是亮了一下
 *   white    白闪**转场** —— 闪完画面换了，这是真剪辑
 *   black    黑场转场
 *   hardcut  硬切 —— 一帧完成
 *   dissolve 溶解 —— 摊在好几帧
 *   motion   疑似运动 —— 前后都不安静，这个"切点"可能压根不是切点
 *
 * 判据（三条 AND，缺一不可，理由见 docs/看视频插件-闪光误判-方案.md）：
 *   pulse > PULSE_MIN   整帧亮度确实冲高过
 *   nv    < NV_MAX      冲高之后**回到了原样**（净位移极小）
 *   corr  > CORR_MIN    而且**结构没变**（只是变亮，不是换了画面）
 *
 * 真实素材实测：闪电 pulse=151/nv=3.9/corr=0.996；真切点 pulse=36/nv=72.7/corr=0.49。
 * 白闪转场 nv 大（画面换了）所以不会被误判成 flash。
 */

import { FP_W, FP_H } from './scan.js';

/** 亮度脉冲下限：真实弱闪电实测 30，真切点最高 36（靠 nv 挡住，不靠这条） */
export const PULSE_MIN = 20;
/** 净位移上限：闪电 1.3–3.9（真实素材），真切点 72.7–74.8。阈值 8 落在中间，余量 20 倍 */
export const NV_MAX = 8;
/** 结构相关度下限：闪电 0.996–0.999，真切 0.49–0.50 */
export const CORR_MIN = 0.85;
/** 窗口半宽（秒）。不写死帧数：6fps 素材上 6 帧是 1 秒，早就不是"闪一下"了 */
export const DELTA_SEC = 0.24;
/** 全局平移补偿的搜索半径（16×9 指纹上的格数） */
export const DX_RANGE = 8;

const mean = (arr, from = 0, to = arr.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return to > from ? s / (to - from) : 0;
};

const fpDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

function shiftFp(a, dx) {
  const out = new Uint8Array(a.length);
  const d = ((Math.round(dx) % FP_W) + FP_W) % FP_W;
  for (let y = 0; y < FP_H; y++) {
    const row = y * FP_W;
    for (let x = 0; x < FP_W; x++) out[row + x] = a[row + ((x - d + FP_W) % FP_W)];
  }
  return out;
}

/** 结构相关度：各自去均值、除以标准差后的余弦相似度（对整帧提亮免疫） */
function structCorr(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sa = 0;
  let sb = 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sa += x * x;
    sb += y * y;
    dot += x * y;
  }
  const d = Math.sqrt(sa) * Math.sqrt(sb);
  return d < 1e-9 ? 0 : dot / d;
}

/**
 * 单个切点处的证据。
 *
 * @param {{prints:Uint8Array[], means:number[], t:number, fps:number, deltaSec?:number}} opts
 *   t：切点时刻（秒）；prints/means 的下标是帧号
 */
export function flashEvidence({ prints, means, t, fps, deltaSec = DELTA_SEC, scores }) {
  const delta = Math.max(1, Math.round(deltaSec * fps));
  const center = Math.round(t * fps);
  const lo = Math.max(0, center - delta);
  const hi = Math.min(prints.length - 1, center + delta);
  if (hi <= lo) return null;

  // ① 亮度脉冲：相对两端基线的最大正向偏离
  const base = (means[lo] + means[hi]) / 2;
  let pulse = 0;
  let minV = 255;
  let maxV = 0;
  for (let i = lo; i <= hi; i++) {
    pulse = Math.max(pulse, means[i] - base);
    minV = Math.min(minV, means[i]);
    maxV = Math.max(maxV, means[i]);
  }

  // ② 净位移：先做全局平移补偿，再取残差（挡快速甩镜）
  let nv = Infinity;
  let dx = 0;
  let shifted = prints[lo];
  for (let k = -DX_RANGE; k <= DX_RANGE; k++) {
    const s = shiftFp(prints[lo], k);
    const v = fpDiff(s, prints[hi]);
    if (v < nv) { nv = v; dx = k; shifted = s; }
  }

  // ③ 结构相关度（用补偿后的那一对帧，和 nv 同一个对齐点）
  const corr = structCorr(shifted, prints[hi]);

  // ④ 过渡集中度：窗口内的分数是不是集中在少数几帧（硬切高、溶解低）
  let conc = 0;
  if (Array.isArray(scores) && scores.length) {
    const seg = [];
    // scores 的第 i 项是「第 i 帧相对第 i-1 帧」的分数，所以下标要减一
    for (let i = lo; i <= hi; i++) {
      const s = scores[i - 1];
      if (Number.isFinite(s)) seg.push(s);
    }
    if (seg.length >= 2) {
      const sorted = [...seg].sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)];
      const sum = seg.reduce((x, y) => x + y, 0);
      const mx = sorted[sorted.length - 1];
      const den = sum - med * seg.length;
      conc = den > 0.5 ? (mx - med) / den : 0;
    }
  }

  return {
    pulse: +pulse.toFixed(1), nv: +nv.toFixed(1), corr: +corr.toFixed(3), dx,
    minV: +minV.toFixed(0), maxV: +maxV.toFixed(0), conc: +conc.toFixed(2),
    isFlash: pulse > PULSE_MIN && nv < NV_MAX && corr > CORR_MIN,
  };
}

/**
 * 给一批切点打标签。**不删除任何一个**，只补 `type` 和 `evidence`。
 *
 * 护栏（防止把一镜到底的素材全判成 flash）：只有"前后 2δ 内没有真切锚点"的切点
 * 才允许判 flash —— 一段连续闪光里每一刀都会满足判据，但那不是"误检"，是这段本身在闪。
 * 反过来，如果附近有真切锚点（nv 大），说明画面真的换了，这一刀不该被压成 flash。
 *
 * @param {Array<{t:number}>} cuts
 * @param {{prints?:Uint8Array[], means?:number[], fps?:number, scores?:number[]}} data
 * @returns {Array<object>} 新数组，元素是 {...cut, type, evidence}
 */
export function tagCuts(cuts, { prints, means, fps = 25, scores } = {}) {
  if (!Array.isArray(cuts)) return [];
  if (!Array.isArray(prints) || !Array.isArray(means) || prints.length === 0) {
    // 没有逐帧数据（例如复用缓存）：保持原样，只补一个中性标签
    return cuts.map((c) => ({ ...c, type: null, evidence: null }));
  }

  const rows = cuts.map((c) => ({
    ...c,
    evidence: flashEvidence({ prints, means, t: c.t, fps, scores }),
    type: null,
  }));

  for (const r of rows) {
    const ev = r.evidence;
    if (!ev) { r.type = 'unknown'; continue; }
    // **不再加"附近有没有真切锚点"的护栏**：早先的版本要求「前后 2δ 内没有真切点」
    // 才允许判 flash，实测会把"闪一下紧接着真剪辑"这种正常素材也挡掉（两个切点隔 0.4s，
    // 比 2δ=0.48s 还近）。既然现在只打标签、不删切点，标签错的代价只是表述不准，
    // 而漏标会让模型误以为"这里没有闪"。所以直接按证据说话。
    if (ev.isFlash) r.type = 'flash';
    else if (ev.minV < 12) r.type = 'black';
    else if (ev.maxV > 245 && ev.nv > 10) r.type = 'white';
    else if (ev.nv >= NV_MAX) r.type = ev.conc >= 0.45 ? 'hardcut' : 'dissolve';
    else r.type = 'motion';
  }

  return rows;
}
