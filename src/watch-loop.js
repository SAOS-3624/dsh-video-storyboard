/**
 * watch-loop.js — 陪看循环：起钟、读进度、到点叫醒。
 *
 * 三件事，各自独立：
 *   1. **钟**（2 秒 tick，纯本地比较，不调模型）
 *   2. **进度**（每 15 秒读一次系统媒体控件，1 秒开销）
 *   3. **叫醒**（真到点才发一条极短消息进会话）
 *
 * 为什么叫醒消息里不放内容：叫醒只是给 AI 一个"该说话了"的由头，
 * 真正的图和清单由它自己调 `video_watch` 拿到——那条消息越短，上下文越干净。
 */

import {
  dueDecision, startTicker, wakeSession,
} from './timer.js';
import { describeStatus, pickSession, probePlayback } from './watch.js';

const mmss = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.round(Math.max(0, s) % 60)).padStart(2, '0')}`;

/** 进程内唯一的陪看循环 */
const loop = {
  active: false,
  ctx: null,
  sessionId: null,
  input: null,
  segments: [],
  spoken: [],
  cursor: null,
  measuredAt: 0,
  status: null,
  lastProbeAt: 0,
  ticker: null,
  log: () => {},
  onWake: null,
};

const PROBE_EVERY_MS = 15_000;
const TICK_MS = 2000;

export function loopStatus() {
  return {
    active: loop.active,
    session: loop.sessionId,
    input: loop.input,
    spoken: loop.spoken.length,
    cursor: loop.cursor,
    status: loop.status,
    segments: loop.segments.length,
  };
}

export function stopWatchLoop(reason = 'stopped') {
  loop.ticker?.dispose();
  loop.ticker = null;
  if (loop.active) loop.log(`[watch] loop stopped (${reason})`);
  loop.active = false;
  return loopStatus();
}

/**
 * 起循环。重复调用会先停旧的（同一个用户只会有一段陪看）。
 * @param {object} o
 * @param {object} o.ctx        宿主上下文（用 sessionController 叫醒）
 * @param {string} o.sessionId  要叫醒哪个会话
 * @param {string} o.input      源（本地路径或链接）
 * @param {Array<{from:number,to:number}>} o.segments 待说的段（绝对时间）
 */
export function startWatchLoop({
  ctx, sessionId, input, segments, cursor = null, status = null, log = () => {}, onWake = null,
}) {
  if (!sessionId) return { ok: false, reason: 'no-session-id' };
  if (!Array.isArray(segments) || segments.length === 0) return { ok: false, reason: 'no-segments' };

  stopWatchLoop('restart');

  loop.active = true;
  loop.ctx = ctx;
  loop.sessionId = sessionId;
  loop.input = input;
  loop.segments = segments.map((s) => ({
    from: Number(s.from),
    to: Number(s.to),
    sayAt: Number.isFinite(s.sayAt) ? s.sayAt : Number(s.to) - 15,
  }));
  loop.spoken = [];
  loop.cursor = Number.isFinite(cursor) ? cursor : null;
  loop.measuredAt = Date.now();
  loop.status = status;
  loop.lastProbeAt = 0;
  loop.log = log;

  loop.ticker = startTicker({
    everyMs: TICK_MS,
    tick: async () => {
      const now = Date.now();
      // 进度每 15 秒读一次：读一次要起个 python 进程（≈1 s），没必要跟着 2 秒的钟跑
      if (now - loop.lastProbeAt >= PROBE_EVERY_MS) {
        loop.lastProbeAt = now;
        const p = await probePlayback({ env: process.env });
        const s = p.ok ? pickSession(p.sessions ?? [], { input: loop.input }) : null;
        if (s) {
          // 位置在动就更新；暂停时保留旧值，但记下状态
          loop.cursor = s.pos;
          loop.measuredAt = now;
          loop.status = describeStatus(s.status);
        } else if (p.ok) {
          loop.status = 'no-session';
        }
      }

      const pausedMs = loop.status === 'paused' ? now - loop.measuredAt : null;
      const d = dueDecision({
        cursor: loop.cursor,
        measuredAt: loop.measuredAt,
        now,
        segments: loop.segments,
        spoken: loop.spoken,
        lead: 15,
        pausedMs,
      });

      if (!d.wake) {
        if (d.why === 'paused-too-long') stopWatchLoop('paused-too-long');
        return;
      }

      loop.spoken.push(d.segment);
      const seg = loop.segments.find((x) => x.from === d.segment);
      const text = `[一起看] ${mmss(seg.from)}–${mmss(seg.to)} 这一段该说话了`
        + `（用户现在看到 ${mmss(d.pos)}）。调 video_watch 拿这一段的画面，然后说一句。`;
      const r = await wakeSession(loop.ctx, { sessionId: loop.sessionId, text });
      loop.log(`[watch] wake ${d.segment}s → ${r.ok ? 'ok' : r.reason}`);
      onWake?.({ ...d, text, ok: r.ok, reason: r.reason });
    },
  });

  loop.log(`[watch] loop started: ${loop.segments.length} segment(s), session ${sessionId}`);
  return { ok: true, ...loopStatus() };
}
