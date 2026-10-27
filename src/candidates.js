/**
 * candidates.js — 候选代表时刻 + 覆盖约束选帧（纯函数，零 IO）。
 *
 * 目标：在固定格数预算下，先保证时间轴覆盖，再把剩余名额给高分事件，
 * 并用时间/镜头新颖性避免相邻重复格。
 */

/** 归一化到 [0,1]；空数组 → 全 0 */
function normalize(values) {
  const nums = values.map((v) => Number(v) || 0);
  const lo = Math.min(...nums, 0);
  const hi = Math.max(...nums, 0);
  const span = hi - lo;
  if (!(span > 0)) return nums.map(() => 0);
  return nums.map((v) => (v - lo) / span);
}

/**
 * 从分析信号生成候选时刻（相对窗口起点，秒）。
 * @returns {Array<{t:number, sources:string[], shot:number, raw:object}>}
 */
export function buildCandidates({
  duration, cuts = [], audioEvents = [], dialogue = [],
  uniformStep = 0, maxUniform = 48,
} = {}) {
  if (!(duration > 0)) return [];
  const bag = new Map(); // t*100 → candidate
  const push = (t, source, extra = {}) => {
    const x = Math.max(0, Math.min(duration, Number(t)));
    if (!Number.isFinite(x)) return;
    const key = Math.round(x * 100);
    const cur = bag.get(key);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
      Object.assign(cur.raw, extra);
      return;
    }
    bag.set(key, { t: +(x.toFixed(2)), sources: [source], raw: { ...extra } });
  };

  push(0, 'edge');
  push(duration, 'edge');
  for (const c of cuts) push(c, 'shot', { cut: true });
  for (const e of audioEvents) push(e.t, 'audio', { kind: e.kind, delta: e.delta });
  for (const d of dialogue) {
    push(d.from, 'dialogue', { text: d.text });
    if (d.to - d.from > 1.5) push((d.from + d.to) / 2, 'dialogue');
  }

  const step = uniformStep > 0
    ? uniformStep
    : Math.max(0.5, duration / Math.max(4, Math.min(maxUniform, Math.ceil(duration / 2))));
  for (let t = step; t < duration; t += step) push(t, 'uniform');

  const sortedCuts = [...cuts].filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const shotOf = (t) => {
    let id = 0;
    for (const c of sortedCuts) { if (c <= t) id += 1; else break; }
    return id;
  };

  return [...bag.values()]
    .map((c) => ({ ...c, shot: shotOf(c.t) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * 综合评分（已归一化的子分加权）。权重随内容类型微调。
 */
export function scoreCandidates(candidates, {
  duration,
  cuts = [],
  speechRate = 0,
  meanLufs = null,
  weights = null,
} = {}) {
  const musicDriven = meanLufs != null && meanLufs > -18 && speechRate < 1;
  const w = weights ?? (musicDriven
    ? { shot: 0.35, motion: 0.15, audio: 0.35, dialogue: 0.05, novelty: 0.10 }
    : speechRate > 3
      ? { shot: 0.25, motion: 0.10, audio: 0.15, dialogue: 0.35, novelty: 0.15 }
      : { shot: 0.30, motion: 0.15, audio: 0.20, dialogue: 0.20, novelty: 0.15 });

  const cutSet = new Set(cuts.map((c) => +Number(c).toFixed(2)));
  const shotRaw = candidates.map((c) => (cutSet.has(c.t) || c.sources.includes('shot') ? 1 : 0));
  const audioRaw = candidates.map((c) => {
    if (!c.sources.includes('audio')) return 0;
    return Math.min(1, Math.abs(Number(c.raw.delta) || 0) / 20);
  });
  const dialogueRaw = candidates.map((c) => (c.sources.includes('dialogue') ? 1 : 0));
  // motion 代理：靠近切点集群
  const motionRaw = candidates.map((c) => {
    let near = 0;
    for (const cut of cuts) if (Math.abs(cut - c.t) < 1.0) near += 1;
    return near;
  });

  const sShot = normalize(shotRaw);
  const sMotion = normalize(motionRaw);
  const sAudio = normalize(audioRaw);
  const sDialogue = normalize(dialogueRaw);

  return candidates.map((c, i) => {
    const base = w.shot * sShot[i] + w.motion * sMotion[i]
      + w.audio * sAudio[i] + w.dialogue * sDialogue[i];
    return {
      ...c,
      score: +base.toFixed(4),
      parts: {
        shot: +sShot[i].toFixed(3),
        motion: +sMotion[i].toFixed(3),
        audio: +sAudio[i].toFixed(3),
        dialogue: +sDialogue[i].toFixed(3),
      },
      weights: w,
      duration,
    };
  });
}

/**
 * 两阶段选择：① 时间桶各取最高分；② 剩余名额按「分 × 新颖性」取。
 * @returns {Array} 选中的候选（按时间排序）
 */
export function selectWithCoverage(scored, {
  k, duration, minTemporalGap = 0.35, coverageRatio = 0.5,
} = {}) {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
  if (!scored.length) return [];
  const n = Math.min(k, scored.length);
  const coverSlots = Math.max(1, Math.min(n, Math.round(n * coverageRatio)));
  const bucketW = duration / coverSlots;
  const selected = [];
  const taken = new Set();

  const tooClose = (t) => selected.some((s) => Math.abs(s.t - t) < minTemporalGap);

  // ① 覆盖
  for (let b = 0; b < coverSlots; b++) {
    const lo = b * bucketW;
    const hi = (b + 1) * bucketW;
    let best = null;
    for (const c of scored) {
      if (c.t < lo || c.t > hi + 1e-9) continue;
      if (taken.has(c.t)) continue;
      if (tooClose(c.t)) continue;
      if (!best || c.score > best.score) best = c;
    }
    if (!best) {
      // 桶内无人：取桶中心最近的候选
      const mid = lo + bucketW / 2;
      for (const c of scored) {
        if (taken.has(c.t) || tooClose(c.t)) continue;
        if (!best || Math.abs(c.t - mid) < Math.abs(best.t - mid)) best = c;
      }
    }
    if (best) {
      selected.push({
        ...best,
        novelty: 1,
        selection_phase: 'coverage',
        reasons: [...best.sources, 'coverage'],
      });
      taken.add(best.t);
    }
  }

  // ② 事件加密：分 × 新颖性（时间距 / 镜头 / 可选 aHash）
  while (selected.length < n) {
    let best = null;
    let bestVal = -1;
    for (const c of scored) {
      if (taken.has(c.t) || tooClose(c.t)) continue;
      let minDist = Infinity;
      let sameShot = false;
      for (const s of selected) {
        minDist = Math.min(minDist, Math.abs(c.t - s.t));
        if (s.shot === c.shot) sameShot = true;
      }
      let novelty = Math.min(1, (minDist / Math.max(duration * 0.15, 1)) * (sameShot ? 0.6 : 1));
      if (c.hash != null && selected.some((s) => s.hash != null)) {
        let minHam = 64;
        for (const s of selected) {
          if (s.hash == null) continue;
          let x = c.hash ^ s.hash;
          let ham = 0;
          while (x) { ham += Number(x & 1n); x >>= 1n; }
          minHam = Math.min(minHam, ham);
        }
        const visual = Math.min(1, minHam / 24);
        novelty = Math.max(novelty * 0.45, visual);
      }
      const val = c.score * (0.55 + 0.45 * novelty) + novelty * 0.05;
      if (val > bestVal) {
        bestVal = val;
        best = { ...c, novelty: +novelty.toFixed(3), selection_phase: 'salience',
          reasons: [...c.sources, 'salience', novelty > 0.5 ? 'novel' : 'near-duplicate'] };
      }
    }
    if (!best) break;
    selected.push(best);
    taken.add(best.t);
  }

  return selected.sort((a, b) => a.t - b.t);
}

/**
 * 代表时刻 → 首尾相接的格区间（相邻时刻中点为界）。
 * `t` 为相对窗口；返回相对区间，调用方再平移。
 */
export function representativesToRanges(selected, duration) {
  if (!selected.length) return [{ from: 0, to: duration, density: 1, reasons: ['empty'] }];
  const ts = selected.map((c) => c.t);
  const bounds = [0];
  for (let i = 0; i < ts.length - 1; i++) bounds.push((ts[i] + ts[i + 1]) / 2);
  bounds.push(duration);
  return selected.map((c, i) => ({
    from: bounds[i],
    to: bounds[i + 1],
    density: +(1 + (c.score || 0)).toFixed(2),
    representative: c.t,
    reasons: c.reasons ?? c.sources ?? [],
    shot: c.shot,
  }));
}
