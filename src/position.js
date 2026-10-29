/**
 * position.js — 把 Windows SMTC 的稀疏时间轴变成可信的"用户在几分几秒"。
 *
 * ## 为什么需要单独一层
 *
 * Edge 播放 B 站时，SMTC 的 `Position` **只在事件发生时刷新**（起播、暂停、拖动、切集），
 * 不是每帧更新。实测两次刷新之间隔过 143 秒、216 秒，最长 155 秒完全不动。
 *
 * 关键事实（对表验证过 3 次，误差都 ≤1 秒）：
 * **刷新落下来的那个值本身是准的；错的是"刷新时刻到此刻"这一段。**
 *
 * 所以模型必须区分两件事：
 *   - `value`   —— 那次刷新给出的位置（可信）
 *   - `updated` —— 它是**什么时候**被写下来的（决定它现在还准不准）
 *
 * ## 三种可信度
 *
 * - `fresh`        刚刷新过（≤ FRESH_MS）：**直接信**
 * - `extrapolated` 刷新有点旧，但状态是 playing：按墙钟往前推，**推多少有上限**
 * - `unknown`      太久没刷新：连"是不是还在播"都不知道（缓冲/暂停/切页都可能），
 *                  **不许当实时值用**，上层要么要用户报时间，要么按保守策略处理
 *
 * ## 为什么外推要封顶
 *
 * 用户暂停时 SMTC 会刷新一次（Paused），但如果他在缓冲、或者浏览器把页面丢了，
 * 就不一定有刷新。外推越久越不可靠，所以超过 `maxExtrapolate` 就降级成 unknown，
 * 而不是继续线性推下去 —— 这正是上一版"一直 not yet / 误判该说话"的根源。
 */

/** 刷新在这个时间内，认为位置是新鲜的 */
export const FRESH_MS = 10_000;
/** 外推最多推这么久；超过就承认"不知道" */
export const MAX_EXTRAPOLATE_MS = 45_000;

const clampPos = (v, dur) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Number.isFinite(dur) && dur > 0 ? Math.min(n, dur) : n;
};

/**
 * 从一次 SMTC 采样建锚点。
 * @param {{pos:number, dur:number, status:number|string, updated:number, title?:string}} sample
 */
export function makeAnchor(sample, now = Date.now()) {
  const dur = Number(sample?.dur) || 0;
  return {
    pos: clampPos(sample?.pos, dur),
    dur,
    status: sample?.status,
    // updated 缺失就当作"刚刚"——宁可信一次，也不要一开始就 unknown
    updated: Number(sample?.updated) || now,
    title: sample?.title ?? null,
    sampledAt: now,
  };
}

/** 这个状态字符串（或 SMTC 码）是不是"在播" */
export function isPlaying(status) {
  if (status === 4 || status === 'playing') return true;
  return false;
}

export function isPaused(status) {
  if (status === 5 || status === 'paused') return true;
  return false;
}

/**
 * 现在大概是第几秒，以及这个数字能不能信。
 * @returns {{pos:number, confidence:'fresh'|'extrapolated'|'unknown', staleMs:number, why:string}}
 */
export function estimate(anchor, now = Date.now(), {
  freshMs = FRESH_MS, maxExtrapolateMs = MAX_EXTRAPOLATE_MS,
} = {}) {
  if (!anchor) return { pos: 0, confidence: 'unknown', staleMs: Infinity, why: 'no-anchor' };
  const staleMs = Math.max(0, now - anchor.updated);

  // 暂停 / 停止：位置不会自己走，直接用刷新值
  if (isPaused(anchor.status)) {
    return {
      pos: anchor.pos, confidence: staleMs <= freshMs ? 'fresh' : 'unknown', staleMs, why: 'paused',
    };
  }
  if (!isPlaying(anchor.status)) {
    return { pos: anchor.pos, confidence: 'unknown', staleMs, why: 'not-playing' };
  }

  // 在播：刚刷新过就是准的
  if (staleMs <= freshMs) {
    return { pos: anchor.pos, confidence: 'fresh', staleMs, why: 'recent-refresh' };
  }

  // 在播但刷新旧了：按墙钟推，但**有上限**
  if (staleMs <= maxExtrapolateMs) {
    const pos = clampPos(anchor.pos + staleMs / 1000, anchor.dur);
    return { pos, confidence: 'extrapolated', staleMs, why: 'wall-clock' };
  }

  // 推太久了：承认不知道。缓冲/暂停/切页都可能，硬推就是编。
  return {
    pos: clampPos(anchor.pos + maxExtrapolateMs / 1000, anchor.dur),
    confidence: 'unknown',
    staleMs,
    why: 'stale',
  };
}

/**
 * 拿到一次新采样后更新锚点，并算出"上一次外推错多少"。
 *
 * 这个误差很重要：如果采样值明显**落后**于我们外推的（drift < 0 且幅度大），
 * 说明用户中间暂停/缓冲过，我们之前推快了 —— 这时要对当前段更保守。
 *
 * @returns {{anchor:object, driftSec:number, refreshed:boolean, changedVideo:boolean}}
 */
export function updateAnchor(prev, sample, now = Date.now()) {
  const next = makeAnchor(sample, now);
  const refreshed = !prev || Number(sample?.updated) !== Number(prev.updated);
  // 注意包 Boolean()：`prev.title && next.title` 在标题为空时是 null，
  // 不包的话整条表达式会返回 null 而不是 false。
  const changedVideo = Boolean(prev) && Boolean(
    (prev.dur && next.dur && Math.abs(prev.dur - next.dur) > 1)
    || (prev.title && next.title && prev.title !== next.title),
  );
  let driftSec = 0;
  if (prev && refreshed) {
    const before = estimate(prev, now);
    driftSec = +(next.pos - before.pos).toFixed(1);
  }
  return { anchor: next, driftSec, refreshed, changedVideo };
}

/**
 * 该不该说话 —— 把"新鲜度"并进判定。
 *
 * 规则：
 *   - 新鲜（刚刷新过）→ 到了就说
 *   - 外推的 → 必须**越过边界一段安全余量**才说（宁可晚 15 秒，也不要因为推快了而抢话）
 *   - 完全不知道 → 不说，交给上层去问用户
 */
export function shouldSpeak({
  anchor, segments = [], spoken = [], now = Date.now(),
  lead = 15, safetySec = 15, aheadSec = 0,
  freshMs = FRESH_MS, maxExtrapolateMs = MAX_EXTRAPOLATE_MS,
} = {}) {
  const est = estimate(anchor, now, { freshMs, maxExtrapolateMs });
  if (est.confidence === 'unknown') {
    return { speak: false, ...est, reason: 'position-unknown' };
  }
  const pos = est.pos + Math.max(0, aheadSec);
  for (const seg of segments) {
    const sayAt = Number.isFinite(seg.sayAt) ? seg.sayAt : seg.to - lead;
    if (spoken.includes(seg.from)) continue;
    if (pos < sayAt) continue;
    if (pos > seg.to + 60) continue;                     // 早就过去了，不补
    if (est.confidence === 'extrapolated' && pos < sayAt + safetySec) {
      // 推出来的位置刚好压线：等它再走一会儿，或者等一次真刷新
      return { speak: false, ...est, reason: 'extrapolated-not-confirmed', segment: seg.from };
    }
    return { speak: true, ...est, segment: seg.from, sayAt, pos: +pos.toFixed(1), reason: 'due' };
  }
  return { speak: false, ...est, reason: 'not-due', pos: +pos.toFixed(1) };
}
