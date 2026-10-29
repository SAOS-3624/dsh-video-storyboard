/**
 * watch-loop.js — 陪看循环：起钟、读进度、到点叫醒。
 *
 * 进度这一层交给 `position.js`：SMTC 的 `Position` **只在事件时刷新**
 * （实测两次刷新隔过 143 s / 216 s，最长 155 s 不动），所以"位置值 + 刷新时刻"必须一起看，
 * 不能把冻结值当实时值 —— 上一版就是这么一直 `not yet` 的。
 *
 * 循环只做三件事，各自频率不同：
 *   每 2 秒   本地判定（纯算术，不调模型）
 *   每 15 秒  读一次 SMTC（起 python ≈1 s），更新锚点
 *   真到点    往会话投一条极短消息（这才贵）
 */

import { aheadSeconds, loadLatency } from './latency.js';
import {
  MAX_EXTRAPOLATE_MS, estimate, makeAnchor, shouldSpeak, updateAnchor,
} from './position.js';
import { startTicker, wakeSession } from './timer.js';
import { pickSession, probePlayback } from './watch.js';

const mmss = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.round(Math.max(0, s) % 60)).padStart(2, '0')}`;

const TICK_MS = 2000;
const PROBE_EVERY_MS = 15_000;
/** 连续多久读不到可信位置就停表等人给 cursor（别在那儿空转 20 分钟） */
const UNKNOWN_GIVE_UP_MS = 180_000;

const loop = {
  active: false,
  ctx: null,
  sessionId: null,
  input: null,
  segments: [],
  spoken: [],
  anchor: null,
  aheadSec: 0,
  unknownSince: 0,
  lastProbeAt: 0,
  lastReason: '',
  ticker: null,
  log: () => {},
};

export function loopStatus() {
  const est = loop.anchor ? estimate(loop.anchor) : null;
  return {
    active: loop.active,
    session: loop.sessionId,
    input: loop.input,
    segments: loop.segments.length,
    spoken: loop.spoken.length,
    pos: est ? +est.pos.toFixed(1) : null,
    confidence: est?.confidence ?? 'none',
    staleMs: est ? est.staleMs : null,
    reason: loop.lastReason,
  };
}

export function stopWatchLoop(reason = 'stopped') {
  loop.ticker?.dispose();
  loop.ticker = null;
  if (loop.active) loop.log(`[watch] loop stopped (${reason})`);
  loop.active = false;
  loop.lastReason = reason;
  return loopStatus();
}

/**
 * 起循环。重复调用先停旧的（同一时刻只允许一段陪看）。
 *
 * @param {object} o
 * @param {object} o.ctx
 * @param {string} o.sessionId
 * @param {string} o.input
 * @param {Array<{from:number,to:number,sayAt?:number}>} o.segments
 * @param {number} [o.cursor]  用户自报的真实进度 —— 传了就以它当锚点（SMTC 不可信时的兜底）
 * @param {'playing'|'paused'} [o.status]
 */
export function startWatchLoop({
  ctx, sessionId, input, segments, cursor = null, status = 'playing', log = () => {},
}) {
  if (!sessionId) return { ok: false, reason: 'no-session-id' };
  if (!Array.isArray(segments) || segments.length === 0) return { ok: false, reason: 'no-segments' };

  stopWatchLoop('restart');

  Object.assign(loop, {
    active: true,
    ctx,
    sessionId,
    input,
    segments: segments.map((s) => ({
      from: Number(s.from),
      to: Number(s.to),
      sayAt: Number.isFinite(s.sayAt) ? s.sayAt : Number(s.to) - 15,
    })),
    spoken: [],
    aheadSec: 0,
    unknownSince: 0,
    lastProbeAt: 0,
    lastReason: 'started',
    log,
  });

  // 用户自报的 cursor 当作"刚刚刷新过的真值"，比任何外推都可信
  loop.anchor = Number.isFinite(cursor)
    ? makeAnchor({ pos: cursor, dur: null, status, updated: Date.now() })
    : null;

  void loadLatency().then((st) => { loop.aheadSec = aheadSeconds(st); });

  loop.ticker = startTicker({
    everyMs: TICK_MS,
    tick: async () => {
      const now = Date.now();

      if (now - loop.lastProbeAt >= PROBE_EVERY_MS) {
        loop.lastProbeAt = now;
        const p = await probePlayback();
        const s = p.ok ? pickSession(p.sessions ?? [], { input: loop.input }) : null;
        if (s) {
          if (loop.anchor) {
            const { anchor, driftSec, refreshed, changedVideo } = updateAnchor(loop.anchor, s, now);
            if (changedVideo) {
              stopWatchLoop('video-changed');
              return;
            }
            if (refreshed && Math.abs(driftSec) > 5) {
              // 刷新给出的真值和我们的外推差得多：中间暂停/缓冲过。
              // 不惩罚，只是用新锚点重算。
              loop.log(`[watch] re-anchored, drift ${driftSec}s`);
            }
            loop.anchor = anchor;
          } else {
            loop.anchor = makeAnchor(s, now);
          }
          const st = await loadLatency();
          loop.aheadSec = aheadSeconds(st);
        }
      }

      if (!loop.anchor) {
        loop.lastReason = 'no-anchor';
        return;
      }

      const r = shouldSpeak({
        anchor: loop.anchor,
        segments: loop.segments,
        spoken: loop.spoken,
        now,
        lead: 15,
        aheadSec: loop.aheadSec,
      });
      loop.lastReason = r.reason ?? 'not-due';

      if (r.reason === 'position-unknown') {
        if (!loop.unknownSince) loop.unknownSince = now;
        if (now - loop.unknownSince > UNKNOWN_GIVE_UP_MS) {
          // 读不到就别空转：停掉，等用户给 cursor 重新起
          stopWatchLoop('position-unreadable');
        }
        return;
      }
      loop.unknownSince = 0;

      if (!r.speak) return;

      loop.spoken.push(r.segment);
      const seg = loop.segments.find((x) => x.from === r.segment);
      const text = `[一起看] ${mmss(seg.from)}–${mmss(seg.to)} 这一段该说话了`
        + `（用户大约看到 ${mmss(r.pos)}${r.confidence === 'extrapolated' ? '，按墙钟推算' : ''}）。`
        + '调 video_watch 拿这一段的画面，然后只说一句。';
      const w = await wakeSession(loop.ctx, { sessionId: loop.sessionId, text });
      loop.log(`[watch] wake ${r.segment}s (${r.confidence}) → ${w.ok ? 'ok' : w.reason}`);
    },
  });

  loop.log(`[watch] loop started: ${loop.segments.length} segment(s), session ${sessionId}`);
  return { ok: true, ...loopStatus() };
}

/** 仅测试用：直接注入锚点，跳过 SMTC */
export function __setAnchorForTest(anchor) {
  loop.anchor = anchor;
}

export const LOOP_LIMITS = Object.freeze({
  TICK_MS, PROBE_EVERY_MS, UNKNOWN_GIVE_UP_MS, MAX_EXTRAPOLATE_MS,
});
