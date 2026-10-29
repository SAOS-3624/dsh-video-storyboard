/**
 * sim.mjs — 不用 DSH、不用真时钟，把整条陪看循环跑起来。
 *
 * 为什么要有这个：真机测试要重启 DSH、要真的看片、一次要十几分钟。
 * 而"到点该不该说话"是个**纯逻辑问题**，完全可以离线验证——
 * 只要把三个外部世界换成假的：时钟、SMTC、会话推送。
 *
 * 假 SMTC 的关键：**只在"刷新点"更新快照**，中间返回同一份冻结值。
 * 这正是 Edge 的真实行为（实测刷新间隔 143 s / 216 s），也是之前踩坑的地方。
 */

/** 建立一个可回放的仿真环境 */
export function createSim({
  duration = 1016,
  title = 'A',
  tickMs = 2000,
  refreshEveryMs = 30_000,
  playingFrom = 0,
  paused = [],          // [{from, to}] 秒
  changes = [],         // [{at, title, duration}] 秒
} = {}) {
  let t = 0;                                  // 虚拟时间（毫秒）
  const start = Date.now();                   // 真实基准，只用于"看起来像时间戳"
  const wakes = [];
  let snapshot = null;
  let lastRefreshAt = -Infinity;
  let current = { title, duration };
  let lastPos = null;

  const pausedAt = (sec) => paused.some((p) => sec >= p.from && sec < p.to);

  /** 当前位置：只在非暂停时前进 */
  function positionAt(ms) {
    let pos = 0;
    let last = 0;
    for (let s = 0; s <= ms / 1000; s += 1) {
      if (s > 0 && !pausedAt(s - 1)) pos += 1;
      last = s;
    }
    return { pos: Math.min(pos + playingFrom, current.duration), at: last * 1000 };
  }

  function refresh(ms) {
    const { pos } = positionAt(ms);
    const isPaused = pausedAt(ms / 1000);
    snapshot = {
      app: 'MSEdge',
      status: isPaused ? 5 : 4,
      pos,
      dur: current.duration,
      title: current.title,
      updated: start + ms,
    };
    lastRefreshAt = ms;
    lastPos = pos;
  }

  refresh(0);

  /** 每次 tick 之前推进虚拟时间，并按刷新策略更新快照 */
  function advance(ms) {
    t = ms;
    // 换片：立刻刷新
    for (const c of changes) {
      if (Math.round(c.at * 1000) === ms) {
        current = { title: c.title ?? current.title, duration: c.duration ?? current.duration };
        refresh(ms);
        return;
      }
    }
    // 暂停/恢复：立刻刷新（真机行为：暂停动作会把 SMTC 刷一次）
    const justPaused = paused.some((p) => Math.round(p.from * 1000) === ms || Math.round(p.to * 1000) === ms);
    if (justPaused) { refresh(ms); return; }
    // 常规刷新
    if (ms - lastRefreshAt >= refreshEveryMs) refresh(ms);
  }

  const probe = async () => ({ ok: true, sessions: snapshot ? [snapshot] : [] });
  const wake = async (_ctx, { text }) => { wakes.push({ at: t, text }); return { ok: true }; };
  const now = () => start + t;

  /** 假 ticker：不注册真定时器，把 tick 交出来由测试驱动 */
  let tickFn = null;
  const ticker = ({ tick }) => {
    tickFn = tick;
    return { dispose() { tickFn = null; } };
  };

  return {
    deps: { probe, wake, now, ticker, loadLatency: async () => ({ ms: 0, samples: 5, at: 0 }) },
    get t() { return t; },
    get wakes() { return wakes; },
    get snapshot() { return snapshot; },
    /** 推进到第 sec 秒，逐 tick 调用 */
    async runTo(sec, { onTick } = {}) {
      while (t < sec * 1000) {
        const next = Math.min(t + tickMs, sec * 1000);
        advance(next);
        if (tickFn) await tickFn();
        onTick?.(t / 1000);
        if (!tickFn) break;                 // 循环已经停了
      }
      return this;
    },
  };
}
