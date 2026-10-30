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
import { DEFAULT_LOOKAHEAD, describePlan, makePlan, windowFor } from './batches.js';
import { readBrowserPosition } from '../storyboard/browser-time.js';
import { readPositionOrNull } from './watch-browser.js';
import { emitSpeech, speechSubscribers } from './voice.js';
import { consumeLine, dueLine, hasLine, loadLine, pickSession, probePlayback } from './watch.js';
import { mmss } from './time.js';

const TICK_MS = 2000;
const PROBE_EVERY_MS = 15_000;
/** 读不到位置多久后主动问一次（静默比问一句更糟：用户不知道它在等什么） */
const ASK_AFTER_MS = 20_000;
/** 两次主动问之间至少隔这么久 */
const ASK_COOLDOWN_MS = 300_000;
/** 连续多久读不到就停表，等人给 cursor（别在那儿空转 20 分钟） */
const UNKNOWN_GIVE_UP_MS = 600_000;
/** 浏览器和 SMTC 都没有可用源超过这么久，就停（视频关了 / 浏览器退出了） */
const NO_SOURCE_GIVE_UP_MS = 300_000;
/** 余量默认值在 batches.js（批次规划的策略），这里转出给老的调用方 */
export { DEFAULT_LOOKAHEAD };

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
  askedAt: 0,
  noSourceSince: 0,
  dur: null,
  lastWake: null,
  wakeFails: 0,
  logs: [],
  lastProbeAt: 0,
  lastReason: '',
  ticker: null,
  log: () => {},
};

/**
 * 记一次唤醒的结果（四处叫醒共用）。
 *
 * **叫不醒必须能看出来**：以前只写进 log，而 log 被调用方传成了空函数，
 * 于是"loop 在跑、位置也对、就是没人说话"完全查不出来。所以失败要计数 + 改 lastReason。
 * `countFailure: false` 给"本来就只是通知一声"的场景（台词念完的提醒不算失败）。
 */
function recordWake(loop, w, { segment, cause, countFailure = true } = {}) {
  loop.lastWake = {
    at: new Date().toTimeString().slice(0, 8),
    ok: Boolean(w?.ok),
    reason: w?.reason ?? null,
    segment,
    ...(cause ? { cause } : {}),
  };
  if (!w?.ok && countFailure) {
    loop.wakeFails += 1;
    loop.lastReason = 'wake-failed';
  }
}

export function loopStatus() {
  const est = loop.anchor ? estimate(loop.anchor) : null;
  return {
    active: loop.active,
    session: loop.sessionId,
    input: loop.input,
    segments: loop.segments.length,
    batchPlan: loop.plan ? describePlan(loop.plan) : null,
    // 余量：depth 是"给了就按段数"，null 表示按 bufferSec 动态算
    depth: loop.depth ?? 'auto',
    bufferSec: loop.bufferSec ?? null,
    spoken: loop.spoken.length,
    // 声音：核心只发事件。listeners = 0 表示"没人接声音"，到点的词会改走叫醒模型。
    voice: {
      listeners: speechSubscribers(),
      lastAt: loop.lastSpeechAt ?? null,
    },
    pos: est ? +est.pos.toFixed(1) : null,
    confidence: est?.confidence ?? 'none',
    staleMs: est ? est.staleMs : null,
    reason: loop.lastReason,
    lastWake: loop.lastWake,
    wakeFails: loop.wakeFails,
    positionSource: loop.positionSource ?? null,
    log: loop.logs.slice(-8),
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
  size = 120, depth = null, segment, ramp, speakEvery = 0,
  // 余量按**时间**算（秒）：当前位置之后已备好的时长不少于它。
  // 不再用"留两段"—— 批次表开头是 1/2/3 分钟，两段在最前面只有 2 分钟，等于没有余量。
  lookahead = DEFAULT_LOOKAHEAD,
  // 台词库存低于这么多段时，叫醒模型去补写。0 = 不管（默认关）
  refillBelow = 0,
  // 台词念完就唤醒模型续写（默认关）。TTS 模式本来“念了就不叫醒”，
  // 代价是词一空就失联 —— 开了这个，至少在“这段没词了”时醒一次。
  wakeOnLinesEmpty = false,
  // 依赖可注入：进程内默认真实实现；测试/仿真用假的，于是"到点会不会说话"可以离线验证
  deps = {},
}) {
  const probe = deps.probe ?? probePlayback;
  const wake = deps.wake ?? ((c, o) => wakeSession(c, o));
  const now = deps.now ?? (() => Date.now());
  const ticker = deps.ticker ?? startTicker;
  const readLatency = deps.loadLatency ?? loadLatency;
  // 读进度的间隔可注入：真机 15 秒够了（起一次 python ≈1 s）；
  // 但仿真用倍速跑，倍速越高越要读得勤，否则一整段会在两次采样之间被跳过。
  const probeEveryMs = deps.probeEveryMs ?? PROBE_EVERY_MS;
  const build = deps.build ?? null;
  const note = (msg) => {
    loop.logs.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
    if (loop.logs.length > 20) loop.logs.shift();
  };
  // 浏览器里有 video 元素时，`currentTime` 是**毫秒级真值**，比 SMTC 的稀疏刷新可靠得多。
  // 拿不到（没开调试端口）就退回 SMTC，不报错。
  const readBrowser = deps.readBrowser ?? ((o) => readBrowserPosition(o));
  // 端口来源：显式参数 → ~/.dsh/video.json → 环境变量（桌面版读不到 setx 的 env，所以文件优先）
  // 端口只从调用方传进来（工具层读配置）；库层不隐式读机器配置，否则单测会被本机状态影响
  const browserPort = deps.browserPort ?? undefined;
  // 没有会话 id 也不许起循环 —— **除非**已经有声音订阅者：那种情况下到点的词
  // 交给订阅者念，不需要叫醒任何模型（宿主的 speech service 就属于这一类）。
  if (!sessionId && speechSubscribers() === 0) return { ok: false, reason: 'no-session-id' };
  // 段可以由批次表生成，所以只有"既没给段、也没给段长"才算没段
  if ((!Array.isArray(segments) || segments.length === 0) && !(Number(segment) > 0 || Array.isArray(ramp))) {
    return { ok: false, reason: 'no-segments' };
  }

  // 批次表：开头短、逐段加长、最后稳定到 segment。
  // 传了 segments 就用它推断等长档（保持旧调用方/测试的行为）；传了 ramp 就走阶梯。
  const seedSize = Number(segment) > 0
    ? Number(segment)
    : (segments?.[0] ? Number(segments[0].to) - Number(segments[0].from) : Number(size) || 120);
  const plan = makePlan({ segment: seedSize, ramp: ramp ?? null });

  // 余量怎么算：
  //   给了 depth → 按段数（旧行为，测试和"我就想固定几段"的场合用）
  //   没给      → 按时间（默认 5 分钟），段短就自动多备几段
  const fixedDepth = Number(depth) >= 1 ? Math.min(64, Math.floor(Number(depth))) : null;
  const bufferSec = Math.max(0, Number(lookahead) || 0);
  // 余量窗口：**按位置算**（到 pos + bufferSec 为止），不是按段数
  const windowAt = (pos) => (fixedDepth
    ? plan.from(plan.indexAt(pos), fixedDepth)
    : windowFor(plan, pos, bufferSec));

  // **同一个源 + 同一张批次表 → 接着跑，不要重开。**
  // 之前每次工具调用都 stopWatchLoop('restart')，于是：① 已说过的段（spoken）被清空；
  // ② 正在等的那一段被新表重切、原时间点消失。用户看到的就是"说要 04:45 开口，结果 05:45 才说"。
  const samePlan = loop.active
    && loop.input === input
    && loop.sessionId === sessionId
    && loop.plan
    && loop.plan.segment === plan.segment
    && JSON.stringify(loop.plan.ramp) === JSON.stringify(plan.ramp);
  if (samePlan) {
    loop.ctx = ctx;
    loop.depth = fixedDepth;
    loop.bufferSec = bufferSec;
    if (Number.isFinite(cursor)) {
      loop.anchor = makeAnchor({ pos: cursor, dur: loop.dur, status, updated: Date.now() }, Date.now());
    }
    // "行为开关"在 resume 时也必须跟着最新参数走，否则会一直用旧值
    loop.wakeOnLinesEmpty = Boolean(wakeOnLinesEmpty);
    note('resumed (same input + same batch plan)');
    return { ok: true, resumed: true, ...loopStatus() };
  }

  // 走到这里说明是新的一段陪看（换源或换批次表）：停掉旧的，重建状态
  stopWatchLoop('restart');

  Object.assign(loop, {
    active: true,
    ctx,
    sessionId,
    input,
    plan,
    segments: segments?.length
      ? segments.map((s) => ({
        from: Number(s.from),
        to: Number(s.to),
        sayAt: Number.isFinite(s.sayAt) ? s.sayAt : Number(s.to) - 15,
      }))
      : plan.from(0, Math.min(64, (fixedDepth ?? windowFor(plan, 0, bufferSec).length) + 1)),
    spoken: [],
    // 余量：fixedDepth 为 null 时按 bufferSec 动态算（段短就多备几段）。
    // 起点那几段只有 1/2/3 分钟，固定"两段"在最前面等于只有 2 分钟余量 —— 不够。
    depth: fixedDepth,
    bufferSec,
    speakEvery: Math.max(0, Number(speakEvery) || 0),
    lastSpeechAt: null,
    wakeOnLinesEmpty: Boolean(wakeOnLinesEmpty),
    refillBelow: Math.max(0, Number(refillBelow) || 0),
    refillAskedAt: 0,
    lastSpeakAt: 0,
    built: new Set(),        // 已经建好的批次（按 from 记）
    building: null,          // 正在建的那一个（同时只建一个，别把 CPU 打满）
    aheadSec: 0,
    lastIdlePos: null,
    lastMoveAt: 0,
    unknownSince: 0,
    askedAt: 0,
    lastProbeAt: 0,
    lastReason: 'started',
    log,
  });

  // 用户自报的 cursor 当作"刚刚刷新过的真值"，比任何外推都可信
  loop.anchor = Number.isFinite(cursor)
    ? makeAnchor({ pos: cursor, dur: null, status, updated: Date.now() })
    : null;

  void readLatency().then((st) => { loop.aheadSec = aheadSeconds(st); });

  loop.ticker = ticker({
    everyMs: TICK_MS,
    tick: async () => {
      const tNow = now();

      if (tNow - loop.lastProbeAt >= probeEveryMs) {
        loop.lastProbeAt = tNow;
        // 1) 先问浏览器（准，但**必须显式开端口**）　2) 再问 SMTC（旧但能用）
        // 不默认读：这台机器上 WorkBuddy 自己就占着 9222，盲读会读到它的界面元素。
        const b = await readPositionOrNull(readBrowser, browserPort);
        if (b) {
          loop.anchor = makeAnchor({
            pos: b.pos, dur: b.dur, status: b.paused ? 5 : 4,
            // 浏览器是刚读的，所以永远算"新鲜"
            updated: Date.now(), title: b.title,
          }, tNow);
          loop.status = b.paused ? 'paused' : 'playing';
          if (Number.isFinite(b.dur)) loop.dur = b.dur;
          if (b.url) loop.sourceUrl = b.url;
          loop.positionSource = 'browser';
          if (b.ended) {
            stopWatchLoop('video-ended');
            return;
          }
        } else {
          loop.positionSource = 'smtc';
          const p = await probe();
          const sg = p.ok ? pickSession(p.sessions ?? [], { input: loop.input }) : null;
          if (sg) {
            if (loop.anchor) {
              const { anchor, driftSec, refreshed, changedVideo } = updateAnchor(loop.anchor, sg, tNow);
              if (changedVideo) {
                stopWatchLoop('video-changed');
                return;
              }
              if (refreshed && Math.abs(driftSec) > 5) {
                // 刷新给出的真值和我们的外推差得多：中间暂停/缓冲过。不惩罚，用新锚点重算。
                note(`re-anchored, drift ${driftSec}s`);
              }
              loop.anchor = anchor;
            } else {
              loop.anchor = makeAnchor(sg, tNow);
            }
            if (Number.isFinite(sg.dur)) loop.dur = sg.dur;
          }
          // 浏览器和 SMTC 都读不到东西：可能是视频关了、也可能浏览器退出了。
          // 这时候每 15 秒还在起一次 python，纯属白烧 CPU —— 给一个宽限期后停表。
          if (!sg) {
            loop.noSourceSince = loop.noSourceSince || tNow;
            if (tNow - loop.noSourceSince > NO_SOURCE_GIVE_UP_MS) {
              stopWatchLoop('no-source');
              return;
            }
          } else {
            loop.noSourceSince = 0;
          }
        }
        const st = await readLatency();
        loop.aheadSec = aheadSeconds(st);
      }

      if (!loop.anchor) {
        loop.lastReason = 'no-anchor';
        return;
      }

      // ---- 空闲自关：位置两倍最长分段都没动过，就别再空转。
      // 正常播放（哪怕在缓冲）两段之内总会推进一次；两段都没动静，
      // 多半是页签被挂起、播放器崩了、或者人已经走了。继续跑只会白烧 CPU。
      {
        const estIdle = estimate(loop.anchor, tNow);
        const idleMs = Math.max(60_000, 2 * Number(plan.segment) * 1000);
        // 只在"读得到、而且是刚刷新过的读数"时判空闲：
        // 读不到（stale/unknown）是另一条路（先问一次，再停表），别在这里抢它的活儿。
        if (Number.isFinite(estIdle.pos) && estIdle.confidence === 'fresh'
          && estIdle.why === 'recent-refresh') {
          if (Math.abs(estIdle.pos - (loop.lastIdlePos ?? -1)) >= 0.5) {
            loop.lastIdlePos = estIdle.pos;
            loop.lastMoveAt = tNow;
          } else if (loop.lastMoveAt && tNow - loop.lastMoveAt >= idleMs) {
            loop.log(`[watch] idle ${Math.round(idleMs / 60_000)} min at ${Math.round(estIdle.pos)}s - stopping`);
            stopWatchLoop('idle');
            return;
          }
        }
      }

      // ---- 预取：保证"当前段 + 后面的余量"里，还没建好的那一个有人在建。
      // 余量按时间算（默认 5 分钟），所以开头段短时会连着建 3、4 段，不是固定两段。
      // 一个时刻只建一个批次 —— 这台机器解码是 CPU 密集的，并行只会互相拖慢。
      if (build && !loop.building) {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        const winNow = windowAt(nowEst.pos);
        const next = loop.segments
          .slice(idxNow, idxNow + winNow.length)
          .find((sg) => !loop.built.has(sg.from));
        if (next) {
          loop.building = (async () => {
            const t = Date.now();
            try {
              await build(next.from);
              loop.built.add(next.from);
              note(`built ${Math.round(next.from)}s in ${((Date.now() - t) / 1000).toFixed(1)}s`);
            } catch (e) {
              note(`build ${Math.round(next.from)}s failed: ${String(e?.message ?? e).slice(0, 80)}`);
            } finally {
              loop.building = null;
            }
          })();
        }
      }

      // ---- 窗口自增长：只排到"当前位置 + 余量"，然后随进度往前滚。
      // 早先这里只在起循环时排一次（3 段），如果 agent 用了预设台词而不调工具，
      // 循环就再也没被重启过 —— 6 分钟之后它会在 not-due 里静静躺着，再也不说话。
      {
        const nowEst = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(nowEst.pos);
        // 段列表要比"预取范围"再长一段，否则 slice 拿不到够多的段可建
        const want = idxNow + windowAt(nowEst.pos).length + 1;
        let guard = 0;
        while (loop.segments.length < want && guard < 200) {
          const i = loop.segments.length;
          const seg = plan.from(i, 1)[0];
          if (Number.isFinite(loop.dur) && seg.from >= loop.dur) break;
          loop.segments.push(seg);
          guard += 1;
        }
      }

      // ---- 台词库存检查：余量不足就**叫醒模型去写**（这是唯一该叫它的理由）
      // 脚本自己不会写台词 —— 它只念。写作是模型的事，库存不够就得有人去补。
      if (loop.refillBelow > 0 && tNow - (loop.refillAskedAt || 0) > 300_000) {
        const estR = estimate(loop.anchor, tNow);
        const idxNow = plan.indexAt(estR.pos);
        const missing = [];
        for (let i = idxNow + 1; i <= idxNow + loop.refillBelow; i += 1) {
          const seg = plan.from(i, 1)[0];
          if (!seg) break;
          if (!(await hasLine(loop.input, seg.from).catch(() => false))) missing.push(seg);
        }
        if (missing.length > 0) {
          loop.refillAskedAt = tNow;
          const list = missing.map((m) => `${mmss(m.from)}–${mmss(m.to)}`).join('、');
          const w = await wake(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看·补词] 台词库存不够了：${list} 还没有词（现在 ${mmss(estR.pos)}）。`
              + '先用 video_watch({ speakNow: true }) 看画面，再用 lines: [...] 补上。',
          });
          recordWake(loop, w, { segment: missing[0].from });
          note(`refill-needed ${missing.map((m) => m.from).join(',')} → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
          return;
        }
      }

      // ---- 声音：到点就把这句**交出去**，自己不发声。
      // **由播放位置触发，不由墙钟**：位置停在 03:12 就一直等着；位置到哪一句的 at，就发哪一句。
      // 这里不看 speakEvery —— 那是"多久叫一次模型"，和"什么时候该念这句话"是两件事。
      //
      // **没有订阅者就完全跳过**（一个引擎模块都不会加载）：到点的词改走下面那条路，
      // 由模型自己说 —— 也就是把"谁来说"这件事交回给宿主。
      if (speechSubscribers() > 0) {
        const est = estimate(loop.anchor, tNow);
        if (est.why !== 'paused' && Number.isFinite(est.pos)) {
          const segNow = plan.segmentAt(est.pos);
          const line = await dueLine(loop.input, est.pos, { size: segNow.size }).catch(() => null);
          if (line) {
            const delivered = emitSpeech({
              at: est.pos, text: line, input: loop.input, segment: segNow.from,
            });
            if (delivered > 0) {
              loop.lastSpeechAt = tNow;
              note(`speech ${Math.round(est.pos)}s → ${delivered} listener(s): ${line.slice(0, 20)}…`);
              loop.lastReason = 'spoke';
              return;        // 交出去了，就不用叫醒模型
            }
          }
        }
      }

      // ---- 高频模式：不受批次边界限制，每 speakEvery 秒叫一次（测试/密集解说用）
      if (loop.speakEvery > 0) {
        const est = estimate(loop.anchor, tNow);
        const gap = tNow - (loop.lastSpeakAt || 0);
        const within = Number.isFinite(loop.dur) ? est.pos < loop.dur - 1 : true;
        if (gap >= loop.speakEvery * 1000 && within && est.why !== 'paused') {
          loop.lastSpeakAt = tNow;
          const seg = plan.segmentAt(est.pos);
          const w = await wake(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看·高频] 现在 ${mmss(est.pos)}（这一段 ${mmss(seg.from)}–${mmss(seg.to)}）。`
              + '调 video_watch({ speakNow: true }) 拿当前画面，然后说一句。',
          });
          recordWake(loop, w, { segment: seg.from });
          note(`speak-now ${Math.round(est.pos)}s → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
          return;
        }
      }

      const r = shouldSpeak({
        anchor: loop.anchor,
        segments: loop.segments,
        spoken: loop.spoken,
        now: tNow,
        lead: 15,
        aheadSec: loop.aheadSec,
      });
      loop.lastReason = r.reason ?? 'not-due';

      if (r.reason === 'position-unknown') {
        if (!loop.unknownSince) loop.unknownSince = tNow;
        const unknownFor = tNow - loop.unknownSince;

        // 读不到就**问一次**，别静默。静默的后果是用户以为它坏了。
        if (unknownFor >= ASK_AFTER_MS && tNow - (loop.askedAt ?? 0) >= ASK_COOLDOWN_MS) {
          loop.askedAt = tNow;
          const stale = Math.round((r.staleMs ?? 0) / 1000);
          const w = await wake(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看] 读不到你的播放进度了（系统媒体控件最后一次更新在 ${stale} 秒前）。`
              + '问一句"你看到几分几秒了"，拿到答复就带 cursor 再调 video_watch。',
          });
          loop.log(`[watch] ask-for-cursor (${stale}s stale) → ${w.ok ? 'ok' : w.reason}`);
        }

        if (unknownFor > UNKNOWN_GIVE_UP_MS) {
          // 读不到就别空转：停掉，等用户给 cursor 重新起
          stopWatchLoop('position-unreadable');
        }
        return;
      }
      loop.unknownSince = 0;
      loop.askedAt = 0;

      if (!r.speak) return;
      const seg = loop.segments.find((x) => x.from === r.segment);

      // **wakeOnLinesEmpty**：这一段没有预写台词了 → 醒一次让模型补写。
      // 以前这个开关只在 TTS 模式下有意义（脚本负责念，词空了就彻底失联）；
      // 现在核心不发声，模型就是那个"声音"，所以它对普通陪看同样成立。
      if (loop.wakeOnLinesEmpty) {
        const left = await hasLine(loop.input, seg.from).catch(() => true);
        if (!left) {
          const w = await wake(loop.ctx, {
            sessionId: loop.sessionId,
            text: `[一起看] ${mmss(seg.from)}–${mmss(seg.to)} 这一段的词已经用完了，`
              + '没有新词可念。看一眼画面写下一段的台词，写好调 video_watch({ lines: [...] }) 存上。',
          });
          recordWake(loop, w, { segment: seg.from, cause: 'lines-empty', countFailure: false });
          loop.log(`[watch] wake-on-lines-empty (${mmss(seg.from)}) → ${w.ok ? 'ok' : w.reason}`);
          loop.lastReason = 'woke-lines-empty';
          return;
        }
      }

      loop.spoken.push(r.segment);
      // 有预设台词就直接给稿子：省掉"现场想"的那 2–4 秒，也省一次看图的 token
      // **念完就删**：取和删放一起，避免"取到了但没删"导致重看时同一句说两遍
      const line = await consumeLine(loop.input, r.segment)
        .catch(() => loadLine(loop.input, r.segment).catch(() => null));
      const head = `[一起看] ${mmss(seg.from)}–${mmss(seg.to)} 该说话了`
        + `（用户大约看到 ${mmss(r.pos)}${r.confidence === 'extrapolated' ? '，按墙钟推算' : ''}）。`;
      const text = line
        ? `${head}\n你之前写好的那句：「${line}」\n直接说这句就行；觉得不对就调 video_watch 看一眼再改。`
        : `${head}\n调 video_watch 拿这一段的画面，然后只说一句。`;
      const w = await wake(loop.ctx, { sessionId: loop.sessionId, text });
      recordWake(loop, w, { segment: r.segment });
      note(`wake ${r.segment}s (${r.confidence}) → ${w?.ok ? 'ok' : w?.reason ?? 'failed'}`);
    },
  });

  loop.log(`[watch] loop started: ${loop.segments.length} segment(s), session ${sessionId}`);
  return { ok: true, ...loopStatus() };
}

export const LOOP_LIMITS = Object.freeze({
  TICK_MS, PROBE_EVERY_MS, UNKNOWN_GIVE_UP_MS, MAX_EXTRAPOLATE_MS, ASK_AFTER_MS, ASK_COOLDOWN_MS,
  NO_SOURCE_GIVE_UP_MS,
});

