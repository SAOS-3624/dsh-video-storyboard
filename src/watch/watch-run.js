/**
 * watch-run.js — `video_watch` 的一次调用（不含宿主胶水，便于直接测）。
 *
 * 一次调用的全部逻辑：
 *   1. 拿到用户的播放位置（宿主给 / 从系统媒体控件读）
 *   2. 算出所在段，**先把这一段算出来**（用户的播放时间就是我们的计算时间）
 *   3. 还没到交付点 → 只回一行状态（几乎不花 token）
 *      到了交付点 → 回这一段的格子图 + 清单 + 陪看行为约束
 *
 * 关键取舍：交付点定在**段末前 lead 秒**，不是段末。用户正看着的时候插一句"这段快完了"，
 * 比卡在两段交界处更自然，也不打断。
 *
 * 本文件只留"一次调用按什么顺序做什么"。四块已经各自独立：
 *   watch-source.js   "用户在看什么"（第 0 步，四条候选路）
 *   watch-modes.js    三种替代入口（waitUntil / waitForRefill / nextLine）
 *   watch-browser.js  陪看浏览器在不在、要不要拉起、怎么说清状态
 *   batches.js        批次表（段边界只在那里定义一次）
 */

import {
  deliveryState, describeStatus, loadWatch, pickSession, probePlayback, readSlot, saveWatch,
  sessionKey, WATCH_LEAD, WATCH_SEGMENT,
} from './watch.js';
import { speechEvents } from './voice.js';
import { describeLatency, recordLatency } from './latency.js';
import { DEFAULT_LOOKAHEAD, makePlan, windowFor } from './batches.js';
import { makeChatWatcher } from './chat.js';
import { probeBrowser, readBrowserPosition } from '../storyboard/browser-time.js';
import { estimate, makeAnchor } from './position.js';
import { boardOptions, charsForDetail } from '../storyboard/board.js';
import { mmss } from './time.js';
import { saveLines } from './watch.js';
import { describeBrowser, ensureWatchBrowser, readPositionOrNull } from './watch-browser.js';
import { resolveWatchSource } from './watch-source.js';
import { runWatchMode } from './watch-modes.js';

/**
 * 给循环用的建段函数：传一次参数，返回 `build(from) => Promise`。
 * 循环负责"什么时候建"，这里只管"怎么建"。
 */
export function makeBuilder({ input, args = {}, runStoryboard, formatManifest, cache }) {
  return (from) => buildSegment({
    input, segStart: from, size: Number(args.segment) > 0 ? Number(args.segment) : 120,
    args, runStoryboard, formatManifest, cache,
  });
}

/**
 * 陪看的清单总预算（字符）。**每格多少字**由 detail 决定（和 storyboard 同一个口径，
 * 见 board.js 的 DETAIL_CHARS），这里只决定"整份最多读多少"——
 * 陪看是反复调用，一次塞两万字会把上下文吃光。
 */
const WATCH_MANIFEST_BUDGET = { low: 1600, med: 2600, high: 6000 };

/**
 * 建一段：分镜 + 清单，放进缓存。
 * 抽出来是为了"当前段"和"下一段的预取"用同一条代码路径（预取跑偏了就是白烧 CPU）。
 */
async function buildSegment({ input, segStart, size, args, runStoryboard, formatManifest, cache }) {
  const key = `${sessionKey(input)}|${segStart}`;
  const hit = cache.get(key);
  if (hit?.png) return hit;

  const detail = args.detail ?? 'med';
  const r = await runStoryboard({
    // 参数默认值只有一处定义（src/board.js）：陪看以前自己抄了一份，
    // 于是 storyboard 有 detail、陪看没有 —— 同一个"仔细程度"在两条路上是两个值。
    ...boardOptions({ ...args, input, from: segStart, to: segStart + size }, { kind: 'watch' }),
    // 陪看是持续调用：让本地 ASR 活过整段，别每段都冷启动一次（实测每段多 5 s）
    asrIdleMs: size * 1000 + 30_000,
  });
  const entry = {
    png: r.sheets?.[0]?.png ?? null,
    manifest: formatManifest(r, {
      maxChars: WATCH_MANIFEST_BUDGET[detail] ?? WATCH_MANIFEST_BUDGET.med,
      maxCellChars: charsForDetail(detail),
    }),
    cells: r.sheets?.[0]?.cells?.length ?? 0,
  };
  cache.set(key, entry);
  // 每段一张 PNG，一部电影会有几十段。只留最近 8 段，别把内存吃掉。
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return entry;
}

// 模块级：latencyNote() 需要知道"这一轮从什么时候开始"
let tStartForNote = Date.now();

async function latencyNote() {
  const st = await recordLatency(Date.now() - tStartForNote);
  // 标定完成后就不再占 token 了
  return st.samples > 3 ? '' : `\n${describeLatency(st)}`;
}

/**
 * @param {object} args  工具参数
 * @param {object} deps  { saveImage, resolveInput, runStoryboard, formatManifest, cache }
 */
export async function runWatchPass(args, deps) {
  const {
    saveImage, runStoryboard, formatManifest, cache = new Map(),
    probe = probePlayback,
    readBrowser = readBrowserPosition,
    /** "浏览器到底在不在"—— 只用于**如实汇报**，位置仍走 readBrowser（可注入） */
    probeBrowserState = probeBrowser,
    browserPort = undefined,
    autoLaunch = false,
  } = deps;
  // 从"开始读进度"到"结果返回"的耗时 —— 这就是本机延迟的实测值，用来做提前量标定
  const tStart = Date.now();
  tStartForNote = tStart;
  // 批次表：开头短、逐段加长、最后稳定。段边界由它统一提供，
  // 否则"说的是哪一段"和"建的是哪一段"会各算各的。
  const plan = makePlan({
    segment: Number(args.segment) > 0 ? Number(args.segment) : WATCH_SEGMENT,
    ramp: args.ramp === undefined ? null : args.ramp,
  });
  const lead = args.lead !== undefined ? Number(args.lead) : WATCH_LEAD;
  // 余量：进入阻塞前要备好的时长（秒）。默认 5 分钟，和循环用的是同一个口径。
  const lookahead = args.lookahead === undefined
    ? DEFAULT_LOOKAHEAD
    : Math.max(0, Number(args.lookahead) || 0);


  // ---- 0. 源：没给 input 就自己从"系统里在播什么"反推
  const stateEarly = await loadWatch();
  const src = await resolveWatchSource({
    input: args.input, args, probe, readBrowser, browserPort, stateEarly,
  });
  // `ok: false` 是"这次调用到此为止"的完整结果（没视频 / 等超时 / 源搜不到）
  if (src.ok === false) return src;
  const { resolved } = src;
  let { input, activeSession } = src;

  // 已经交付过的段：wait 模式不能把同一段反复交出来
  const state0 = await loadWatch();
  const sk0 = sessionKey(input);
  const lastDelivered = Number(state0[sk0]?.lastDelivered);


  // ---- 0.4 / 0.5 三种替代入口：命中就直接返回，不再往下走
  const mode = await runWatchMode({ args, input, plan, browserPort, readBrowser });
  if (mode) return mode;

  // ---- 1. 播放位置
  // 用户很可能直接说"12:30"，数字里带冒号解析成 NaN 就白跑一次探测，这里先认一下
  const parseCursor = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    const m = v.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return Number(v);
  };
  let cursor = parseCursor(args.cursor);
  let note = '';
  let confidence = Number.isFinite(cursor) ? 'given' : null;

  // ---- 1.0 浏览器在不在：**每次调用都查**，哪怕这一次不需要它给位置。
  // 以前读不到就 `.catch(() => null)` 静默掉，于是"关着"和"开着但没视频"在模型眼里
  // 都是"没有位置"，它只能拿位置去倒推浏览器 —— 猜错就对着空气写台词。
  let launchNote = '';
  if (!Number.isFinite(cursor) && browserPort && autoLaunch && args.attachOnly !== true) {
    const br = await ensureWatchBrowser(browserPort);
    if (br.launched) {
      launchNote = br.ok
        ? ` · I JUST STARTED a watch browser on :${browserPort} (its own profile, ~/.dsh/edge-watch) — `
          + 'it is NOT the window you are watching in, and it has no video open'
        : ` · I tried to start a watch browser on :${browserPort} and it never came up (${br.reason})`;
    }
  }
  const browserState = browserPort
    ? await probeBrowserState({ port: browserPort }).catch(() => ({ state: 'error', port: browserPort }))
    : { state: 'unconfigured', port: null };
  if (!Number.isFinite(cursor)) {
    // 位置仍然走**可注入**的 readBrowser（测试/仿真靠它喂位置，别改成直接调 CDP）
    const b = await readPositionOrNull(readBrowser, browserPort);
    if (b && Number.isFinite(b.pos)) {
      cursor = b.pos;
      confidence = 'browser';
      note = ` (browser, ${b.paused ? 'paused' : 'playing'})`;
      if (b.url) {
        activeSession = { ...(activeSession ?? {}), title: b.title, dur: b.dur };
      }
    }
  }
  const browserLine = describeBrowser(browserState, launchNote);
  if (!Number.isFinite(cursor)) {
    const probeRes = await probe();
    const pick = probeRes.ok
      ? pickSession(probeRes.sessions, { input, title: args.title ?? activeSession?.title ?? null })
      : null;
    if (!pick) {
      return {
        ok: false,
        browser: browserState.state,
        text: `${browserLine}\n`
          + `cannot read your playback position (${probeRes.error ?? 'no active media session'}).\n`
          + 'Tell me how far you are (e.g. "我看到 12:30 了") and call again with cursor: 750. '
          + 'I will not guess — a wrong cursor makes every later segment wrong too.',
        images: [],
      };
    }
    // **不能把 SMTC 的冻结值当实时值**：Edge 只在起播/暂停/拖动时刷新，
    // 实测两次刷新隔过 143 秒。所以先问"这个值有多旧"，再决定信不信。
    const est = estimate(makeAnchor(pick, Date.now()));
    confidence = est.confidence;

    if (est.confidence === 'unknown') {
      return {
        ok: false,
        confidence,
        browser: browserState.state,
        text: `${browserLine}\n`
          + `your playback position is unreadable right now: SMTC last updated `
          + `${Math.round(est.staleMs / 1000)}s ago (${est.why}), so I cannot tell whether you are at `
          + `${mmss(pick.pos)} or further.\n`
          + 'Tell me where you are and pass cursor (e.g. cursor: 750 or "12:30"). '
          + 'I will not extrapolate that far — a wrong position makes every later segment wrong.',
        images: [],
      };
    }

    cursor = est.pos;
    note = ` (${pick.app}, ${describeStatus(pick.status)}`
      + `${est.confidence === 'extrapolated' ? `, measured ${Math.round(est.staleMs / 1000)}s ago` : ''})`;
  }

  const cur = plan.segmentAt(cursor);
  const segStart = cur.from;
  const size = cur.size;
  const d = deliveryState({ cursor, segment: segStart, size, lead });
  const key = `${sessionKey(input)}|${segStart}`;

  // ---- 1.5 预设台词：传了就存，到点由循环直接念
  if (Array.isArray(args.lines) && args.lines.length > 0) {
    const n = await saveLines(input, args.lines).catch(() => 0);
    if (n > 0) note += ` · saved ${n} line(s)`;
  }

  // ---- 2. 预取这一段
  let entry = cache.get(key);
  let builtMs = 0;
  if (!entry?.png) {
    const t0 = Date.now();
    try {
      entry = await buildSegment({
        input, segStart, size, args, runStoryboard, formatManifest, cache,
      });
    } catch (e) {
      // 取流失败（比如地址是"首页"、站点 yt-dlp 不支持）不该把栈抛给宿主：
      // 说清楚是哪一步、什么地址、下一步怎么办。
      return {
        ok: false,
        reason: 'build-failed',
        text: `could not build this segment for "${String(input).slice(0, 80)}".\n`
          + `${String(e?.message ?? e).slice(0, 200)}\n\n`
          + 'If that is a page URL, make sure it is the video page itself (not a homepage or a search page); '
          + 'otherwise pass the direct file path or a supported link.',
        images: [],
      };
    }
    builtMs = Date.now() - t0;
  }

  // ---- 2.4 余量：把"当前位置之后 lookahead 秒"内的段全部备好
  //
  // **这是进入阻塞等待的前提**：等待期间用户还在看，没有人能再建图；所以阻塞之前，
  // 未来那段窗口必须已经在缓存里。以前这里只预取"下一段"，而且是后台异步 ——
  // 于是等到用户在段末要图时，图常常还没建好（或者词根本来不及写）。
  // 两条路径分开处理：
  //   · 本次就要交付（already due）→ 别为了预取拖慢返回，丢后台串行建
  //   · 本次要阻塞等待 → **先把窗口建完再进入等待**，这样醒来时下一批已就绪
  const winSegs = windowFor(plan, cursor, lookahead)
    .filter((s) => !Number.isFinite(activeSession?.dur) || s.from < activeSession.dur);
  const willWait = !d.due && args.wait === true;
  const pending = winSegs
    .filter((s) => s.from !== segStart)
    .filter((s) => !cache.get(`${sessionKey(input)}|${s.from}`)?.png);
  const buildOne = (s) => buildSegment({
    input, segStart: s.from, size: s.size, args, runStoryboard, formatManifest, cache,
  });
  // 一次调用最多补 4 段：再多就是"用户其实不在看"，别把一次工具调用拖成几分钟
  const toBuild = pending.slice(0, 4);
  if (willWait) {
    for (const s of toBuild) {
      try {
        await buildOne(s);
      } catch { /* 备不上就算了，到点再建 */ }
    }
  } else if (args.prefetch !== false && toBuild.length > 0) {
    setTimeout(() => {
      void (async () => {
        for (const s of toBuild) {
          try {
            await buildOne(s);
          } catch { /* 后台失败不响 */ }
        }
      })();
    }, 0).unref?.();
  }

  // **报实数，不报计划**：以前这里写的是"打算建到哪"，于是出现"说 5 分钟余量、
  // 实际只有 3 分钟"——用户一眼就看穿了。现在以缓存里真的有图为准。
  const builtWin = winSegs.filter((s) => s.from === segStart
    || cache.get(`${sessionKey(input)}|${s.from}`)?.png);
  const coverTo = builtWin.length > 0 ? builtWin[builtWin.length - 1].to : segStart + size;
  const stillBuilding = winSegs.length > builtWin.length;
  const bufferHint = (winSegs.length > 1)
    ? `\n[buffer] 图已备到 ${mmss(coverTo)}（${builtWin.length}/${winSegs.length} 段，约 `
      + `${Math.max(0, Math.round((coverTo - cursor) / 60))} 分钟余量`
      + `${stillBuilding ? '，剩下的在后台补' : ''}）。`
      + '词就写这个区间：' + winSegs.map((s) => `${mmss(s.from)}–${mmss(s.to)}`).join('、')
    : '';

  const measuredAt = new Date().toTimeString().slice(0, 8);
  const found = resolved ? ` · source: ${resolved.matchedBy} → ${String(input).split(/[\\/]/).pop()}` : '';
  // **进度必须带"什么时候测的"**：用户看到这句话时可能已经过了几分钟。
  // 之前只写 `watch 08:28`，用户五分钟后再看会以为算错了——那是我把"测量时刻"说成了"现在"。
  const head = `watch ${mmss(cursor)} @ ${measuredAt}${note}${found} `
    + `· segment ${mmss(segStart)}–${mmss(segStart + size)}`
    + ` · ${Math.max(0, d.remaining)}s left`
    + (builtMs ? ` · built in ${(builtMs / 1000).toFixed(1)}s` : ' · ready')
    + `\n${browserLine}`;

  // ---- 2.4 高频模式（speakNow）：循环按固定节奏叫醒时，不必等到段末才交付
  if (args.speakNow === true) d.due = true;

  // ---- 2.5 阻塞等待（wait: true）
  // 用户的思路：与其"结束这轮、等定时器把我叫醒"，不如**让这次调用一直挂着**，
  // 就像等 npm 上传结果一样 —— 到点了工具自己返回，对话根本没断过。
  // 好处：完全不依赖 sessionController.prompt（那个能不能用还没验证过）。
  // 代价：等待期间这个会话被占着，用户插话要等它返回。
  let waitedSec = 0;
  const tWaitStart = Date.now();
  let alreadyDelivered = false;
  // **空闲自关**：位置两倍最长分段都没动过，就当用户已经不看了，主动收工。
  // 为什么是两倍：一段 5 分钟，正常播放最慢也会在一段内推进一次；两段都没动静，
  // 只能是页签挂起/缓冲卡死/人走了 —— 继续挂着只会把会话占死。
  const idleSec = Number(args.idleTimeoutSec) > 0
    ? Number(args.idleTimeoutSec)
    : Math.max(60, 2 * Number(plan.segment));
  const idleMs = idleSec * 1000;
  let idleHit = false;
  if (!d.due && args.wait === true) {
    const capSec = Math.min(600, Math.max(5, Number(args.maxWaitSec)
      || Math.round(idleMs / 1000)));
    const deadline = Date.now() + capSec * 1000;
    let lastSeenPos = cursor;
    let lastMoveAt = Date.now();
    // 外部聊天框：宿主输入框在阻塞期间不会把话送到这里（实测事后补写），
    // 但 chat.jsonl 是我们自己 append 的，写盘即时 —— 这是唯一"边等边能听见"的通道。
    const chatPoll = makeChatWatcher();
    while (Date.now() < deadline) {
      const chatHit = chatPoll();
      if (chatHit) { d.chatNow = chatHit; break; }
      // 位置来源：浏览器（准）> 上次测得的 SMTC 快照（凑合能用来判断"到没到"）
      const np = await readPositionOrNull(readBrowser, browserPort);
      const posNow = np ? np.pos : (Number.isFinite(cursor) ? cursor + waitedSec : null);
      if (posNow !== null) {
        cursor = posNow;
        // 按真实经过时间算，不按"每拍 +2 秒"——轮询频率改了，拍数就不等于秒数
        waitedSec = +((Date.now() - tWaitStart) / 1000).toFixed(1);
        const nd = deliveryState({ cursor, segment: segStart, size, lead });
        // 同一段已经交过一次就别再交：用户刚看完 00:00–01:00，
        // 再等到 00:59 把同一段塞给他一次，看起来像卡住了。
        if (nd.due) {
          if (segStart !== lastDelivered) {
            d.due = true;
            d.remaining = nd.remaining;
          } else {
            // 已经交过的段：不能干等到封顶（那会让会话挂着好几分钟）。
            // 直接结束这次等待，下面回一句"这段已经给过了"。
            alreadyDelivered = true;
          }
          break;
        }
        if (cursor < segStart) break;            // 用户倒回到上一段去了，别干等
        if (np?.paused) break;                   // 暂停了就别挂着了，让用户能说话
        // 位置有没有真的在走？（播放中但一秒都不动 = 缓冲卡死/页签挂起）
        if (Math.abs(posNow - lastSeenPos) >= 0.5) {
          lastSeenPos = posNow;
          lastMoveAt = Date.now();
        } else if (Date.now() - lastMoveAt >= idleMs) {
          idleHit = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      waitedSec = +((Date.now() - tWaitStart) / 1000).toFixed(1);   // 没有浏览器读数也按墙钟推进
    }
  }

  // **这里不能记 lastDelivered**：这一行以前写在"还没到点就返回"之前，于是每一次
  // "not yet" 的调用都会把当前段标成"已交付"。下一次调用在等待途中真到了交付点，
  // 去重判断 `segStart !== lastDelivered` 就会把它挡掉，一直挂到封顶也不交 ——
  // 表现是这一段被推迟到**再下一次**调用才交出去（迟到一段，而不是重复一段）。
  // 记账必须发生在真正交付的那条分支里（见下方第 4 步）。
  const waitNote = waitedSec > 0 ? ` · waited ${Math.round(waitedSec)}s` : '';

  // 位置长时间没动：收工，并把"停在哪儿、多久"说清楚，别让会话悄无声息地占着
  if (!d.due && idleHit) {
    return {
      ok: false,
      reason: 'idle',
      speaking: false,
      confidence,
      input,
      size,
      cursor,
      waitedSec,
      text: `${head}${waitNote}\nplayback has not moved for ${Math.round(idleMs / 60_000)} minutes `
        + `(${mmss(cursor ?? 0)}). Nothing to watch right now - stopping the wait. `
        + 'Call again when they are watching again.',
      images: [],
    };
  }

  // 用户在外部聊天框里说话了：先把这句给他，别等段末
  if (!d.due && d.chatNow) {
    return {
      ok: true,
      speaking: false,
      confidence,
      input,
      size,
      cursor,
      measuredAt,
      segment: segStart,
      chat: d.chatNow,
      text: `${head}${waitNote}\n**用户插话**：「${d.chatNow.text}」\n`
        + '先回这一句，回完立刻再调一次 wait:true 继续陪看。',
      images: [],
    };
  }

  // 这一段已经交过一次（lastDelivered 命中）：不重复塞，也不继续挂着等
  if (!d.due && alreadyDelivered) {
    return {
      ok: true,
      speaking: false,
      confidence,
      input,
      size,
      cursor,
      measuredAt,
      segment: segStart,
      text: `${head}${waitNote}\nalready delivered this segment — not sending it again. `
        + 'Say something of your own, or call again after it moves past '
        + `${mmss(segStart + size)}.`,
      images: [],
    };
  }

  // ---- 3. 还没到交付点：保持安静
  if (!d.due) {
    return {
      ok: true,
      speaking: false,
      confidence,
      status: note.includes('paused') ? 'paused' : 'playing',
      input,
      size,
      cursor,
      measuredAt,
      segment: segStart,
      text: `${head}${waitNote}\nnot yet — keep watching. I will speak near ${mmss(segStart + size - lead)}.`
        + await latencyNote() + bufferHint,
      images: [],
    };
  }

  // ---- 4. 到点：交付（同一段不重复说）
  const st = await loadWatch();
  const sk = sessionKey(input);
  // 旧格式是数组，新格式是 {segStart: 说得有多久了}。倒回去重看同一段时，
  // 隔了 10 分钟以上允许重说一次 —— 否则"我刚才没听清，再看一遍"就永远得不到回应。
  const rawSpoken = st[sk]?.spoken ?? {};
  const spoken = Array.isArray(rawSpoken)
    ? Object.fromEntries(rawSpoken.map((k) => [k, Date.now() - 11 * 60_000]))
    : rawSpoken;
  const REPEAT_AFTER_MS = 10 * 60_000;
  if (spoken[segStart] && Date.now() - spoken[segStart] < REPEAT_AFTER_MS) {
    return {
      ok: true,
      speaking: false,
      text: `${head}\nalready spoke for this segment — not repeating it.`,
      images: [],
    };
  }
  const nextSpoken = { ...spoken, [segStart]: Date.now() };
  // 只留最近 60 段，别让状态文件无限长
  const keptKeys = Object.keys(nextSpoken)
    .sort((a, b) => nextSpoken[b] - nextSpoken[a])
    .slice(0, 60);
  st[sk] = {
    ...(st[sk] ?? {}),
    spoken: Object.fromEntries(keptKeys.map((k) => [k, nextSpoken[k]])),
    // **真的交出去了才记**：wait 模式靠这个字段防止同一段被反复交付。
    lastDelivered: segStart,
    at: Date.now(),
  };
  await saveWatch(st);

  const images = entry.png ? [await saveImage({ data: entry.png, name: `watch-${segStart}.png` })] : [];
  // **文字流那一半**：这一段的稿子连同 `at` 一起交出去，谁接了声音谁就能照着念。
  // 核心自己不发声，也不因此多加载任何东西（见 voice.js）。
  const speech = speechEvents(await readSlot(input, segStart).catch(() => []), {
    fallbackAt: segStart, segment: segStart,
  });
  const guidance = [
    `[together-watch] The user just watched ${mmss(segStart)}–${mmss(segStart + size)} (now at ${mmss(cursor)}).`,
    'They watched it themselves — do NOT retell the plot.',
    'Default: one sentence about what changed or what is worth noticing, then stop.',
    'Say more only if they ask, or if something genuinely deserves one callout.',
    'If nothing is worth saying, say almost nothing — silence is a valid answer,',
    'and so is watching two segments without commenting at all. There is no quota to fill.',
  ].join('\n');

  return {
    ok: true,
    speaking: true,
    confidence,
    status: note.includes('paused') ? 'paused' : 'playing',
    input,
    size,
    cursor,
    measuredAt,
    segment: segStart,
    speech,
    text: `${head}${waitNote}\n${guidance}${await latencyNote()}${bufferHint}\n\n${entry.manifest}`,
    images,
  };
}

