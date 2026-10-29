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
 */

import {
  deliveryState, describeStatus, loadWatch, pickSession, probePlayback, saveWatch, segmentStart,
  sessionKey, WATCH_LEAD, WATCH_SEGMENT,
} from './watch.js';
import { describeLatency, recordLatency } from './latency.js';
import { DEFAULT_LOOKAHEAD, makePlan, windowFor } from './batches.js';
import {
  fileUrlToPath, hasDebugPort, launchBrowser, looksLikeVideoUrl, readBrowserPosition, waitForPort,
} from './browser-time.js';
import { estimate, makeAnchor } from './position.js';
import { resolvePlayingSource } from './resolve-playing.js';
import { boardOptions, charsForDetail } from './board.js';
import { mmss } from './time.js';
import { consumeLine, dueLine, hasLine, saveLines } from './watch.js';

// 模块级：latencyNote() 需要知道"这一轮从什么时候开始"
let tStartForNote = Date.now();
// 自动拉浏览器每个进程只试一次（失败也别每次调用都弹窗）
let launchTried = false;

/**
 * 端口没开时**自己把浏览器拉起来**（仅当 video.json 里 launchBrowser: true）。
 * 为什么必须插件来起：外部工具进程派生出的浏览器会随它的 Job Object 被回收。
 */
async function ensureWatchBrowser(port) {
  // 小于 1024 是特权端口，起不来的；测试里也常用 1 这类假端口
  if (!port || port < 1024 || launchTried) return false;
  if (await hasDebugPort({ port })) return true;
  launchTried = true;
  const r = launchBrowser({ port });
  if (!r.ok) return false;
  return waitForPort(port, { timeoutMs: 10_000 });
}

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
  // 用户只会说"我在看这个"，不会报路径。SMTC 给标题和时长，够我们去找。
  let input = args.input;
  let resolved = null;
  let activeSession = null;
  const stateEarly = await loadWatch();
  const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
  if (!input) {
    // 浏览器开过调试端口时，**页面地址就是源**（能直接拿到 BV 号），比拿标题去搜准得多
    const b0 = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
    // 只认"视频页地址"：B 站首页也有 <video>（自动播放的推荐），但它不是任何一条视频
    if (b0?.url && looksLikeVideoUrl(b0.url) && /^https?:/i.test(b0.url)) {
      input = b0.url;
      resolved = { input: b0.url, matchedBy: 'browser-url' };
    } else if (fileUrlToPath(b0?.url)) {
      // **本地视频用浏览器打开**：页面地址就是那个文件，直接当 input（不用下载、不用问用户）
      input = fileUrlToPath(b0.url);
      resolved = { input, matchedBy: 'browser-file' };
    }
  }
  if (!input) {
    let p0 = await probe();
    activeSession = p0.ok ? pickSession(p0.sessions, {}) : null;

    // ---- 等视频出现（waitForVideo）
    // 用户常常先叫一声、再去开视频。与其立刻失败让他再叫一次，不如在这里挂着等，
    // 并且**把等待的结果说清楚**（等了多少秒、有没有等到）。
    // 注意：工具调用中途没法说话，所以"我在等"这句必须由模型在调用**之前**说 ——
    // 这一点写在工具描述和 manifest 的 guidance 里。
    let waitedVideoSec = 0;
    if (!activeSession?.title && args.waitForVideo === true) {
      const cap = Math.min(600, Math.max(10, Number(args.maxWaitSec) || 120));
      const deadline = Date.now() + cap * 1000;
      const tWait = Date.now();
      // **快慢两档**：浏览器读一次 CDP 是毫秒级，SMTC 要起一个 python 进程（最慢能到几秒）。
      // 以前两者绑在同一个 2 秒节拍里，等于每个节拍都在等 python —— 用户视频都播半分钟了，
      // 这边还在"等视频出现"。现在浏览器 300ms 一次，SMTC 2 秒一次且超时收到 1.5 秒。
      let lastProbeAt = 0;
      while (Date.now() < deadline) {
        const bv = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
        if (bv?.url) {
          if (looksLikeVideoUrl(bv.url) && /^https?:/i.test(bv.url)) {
            input = bv.url;
            resolved = { input: bv.url, matchedBy: 'browser-url' };
          } else if (fileUrlToPath(bv.url)) {
            input = fileUrlToPath(bv.url);
            resolved = { input, matchedBy: 'browser-file' };
          }
          if (input) break;
        }
        if (Date.now() - lastProbeAt >= 2000) {
          lastProbeAt = Date.now();
          // eslint-disable-next-line no-await-in-loop
          p0 = await probe({ timeoutMs: 1500 });
          activeSession = p0.ok ? pickSession(p0.sessions, {}) : null;
          if (activeSession?.title) break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300));
        waitedVideoSec = Math.round((Date.now() - tWait) / 1000);
      }
      if (!input && !activeSession?.title) {
        return {
          ok: false,
          waitedSec: waitedVideoSec,
          reason: 'no-video-timeout',
          text: `I waited ${waitedVideoSec}s and no video appeared `
            + '(no browser tab holding a <video>, no OS media session).\n'
            + 'Tell the user you are still waiting and that you will pick it up when it starts; '
            + 'call again with waitForVideo: true when they say it is playing.',
          images: [],
        };
      }
    }

    if (!activeSession?.title && !input) {
      return {
        ok: false,
        reason: 'no-video',
        text: `no video is playing right now (${p0.error ?? 'no active media session'}).\n`
          + 'Play something, or pass input yourself (path or link). '
          + 'If you would rather wait for them to start it, call again with waitForVideo: true — '
          + 'but say you are waiting first: this call stays silent while it blocks.',
        images: [],
      };
    }

    // 已经有 input（从浏览器读到了地址）就不用再解析标题
    if (!input) {
    // 记住上一次为这个标题找到的源：搜索接口会限流，重复搜没意义，也慢（11 秒）。
    const cachedInput = stateEarly.sources?.[titleKey(activeSession.title)];
    if (cachedInput) {
      input = cachedInput;
      resolved = { input: cachedInput, matchedBy: 'remembered' };
    } else {
      resolved = await resolvePlayingSource({ title: activeSession.title, duration: activeSession.dur });
      if (resolved?.kind !== 'failed') {
        stateEarly.sources = {
          ...(stateEarly.sources ?? {}),
          [titleKey(activeSession.title)]: resolved.input,
        };
        await saveWatch(stateEarly);
      }
    }
    if (resolved?.kind === 'failed') {
      // **不同的失败原因要说不同的话**：被限流和"不是 B 站"对用户是两件事，
      // 都归成"没搜到"会让人以为工具坏了（实际是它在猜一个猜不到的源）。
      const why = {
        'search-blocked': 'the Bilibili search endpoint is rate-limiting me right now (412 / captcha), '
          + 'so this is not "no such video", it is "I could not look".',
        'no-match': 'nothing on Bilibili matches that title *and* duration, so this is most likely not a '
          + 'Bilibili source (Douyin / WeChat Channels / YouTube look exactly like this from the outside).',
        'no-ytdlp': 'yt-dlp is not available, so I cannot search or fetch anything by myself.',
        'title-too-short': 'the title is too short to search for anything meaningful.',
        'search-failed': 'the Bilibili search failed for an unknown reason.',
      }[resolved.reason] ?? `resolution failed (${resolved.reason}).`;
      return {
        ok: false,
        reason: resolved.reason,
        text: `you are watching "${activeSession.title}" (${Math.round(activeSession.dur)}s).\n`
          + `${why}\n\n`
          + 'Two ways forward, either is fine://n'
          + '  1. paste the link or the file path — I remember it per title and stop asking;\n'
          + '  2. start the browser with --remote-debugging-port=9222 and set DSH_BROWSER_DEBUG_PORT=9222 — '
          + 'then I read the page URL directly and never have to guess.',
        images: [],
      };
    }
    input = resolved.input;
    }
  }

  // 已经交付过的段：wait 模式不能把同一段反复交出来
  const state0 = await loadWatch();
  const sk0 = sessionKey(input);
  const lastDelivered = Number(state0[sk0]?.lastDelivered);

  // ---- 0.4 两种"阻塞到条件成立"的等待（模型侧的节奏由它自己掌握）
  //
  // 用户描述的模型循环：
  //   看视频 → 写台词 → （可选）阻塞到某个时间点核对进度 → 阻塞到"上一段余量用完" → 再看视频 …
  //
  // 这两种等待都不是定时器，而是**条件**：
  //   waitUntil    : 等到播放进度到某个秒数（用来在下一段之前核对时间）
  //   waitForRefill: 等到台词库存低于 refillBelow 段（用来知道"该看下一段了"）
  if (args.waitUntil !== undefined || args.waitForRefill === true) {
    const capSec = Math.min(900, Math.max(5, Number(args.maxWaitSec) || 300));
    const deadline = Date.now() + capSec * 1000;
    const below = Math.max(1, Number(args.refillBelow) || 2);
    let last = null;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const b = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
      last = b?.pos ?? null;
      if (b?.ended) break;
      if (b?.paused) break;

      if (args.waitForRefill === true && last !== null) {
        const idx = plan.indexAt(last);
        let stocked = 0;
        for (let i = idx + 1; i <= idx + below; i += 1) {
          const seg = plan.from(i, 1)[0];
          if (!seg) break;
          // eslint-disable-next-line no-await-in-loop
          if (await hasLine(input, seg.from).catch(() => false)) stocked += 1;
        }
        if (stocked < below) {
          const missing = plan.from(idx + 1, below).filter((x) => x);
          return {
            ok: true, reason: 'refill-needed', at: last,
            text: `库存不足（现在 ${mmss(last)}）：${missing.map((m) => `${mmss(m.from)}–${mmss(m.to)}`).join('、')}`
              + '\n去看画面，用 lines: [...] 补上。',
            images: [],
          };
        }
      }

      if (Number.isFinite(Number(args.waitUntil)) && last !== null && last >= Number(args.waitUntil)) {
        return {
          ok: true, reason: 'reached', at: last,
          text: `到 ${mmss(last)} 了（目标 ${mmss(Number(args.waitUntil))}）。`,
          images: [],
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return {
      ok: true, reason: 'wait-timeout', at: last,
      text: `等到封顶（${capSec}s）也没等到条件成立，现在 ${last !== null ? mmss(last) : '读不到位置'}。`,
      images: [],
    };
  }

  // ---- 0.5 逐句模式（nextLine）
  // 一次调用只返回**一句**台词，并且阻塞到该说这句的时刻。
  // 这样每次工具返回 = 一条真实消息，会话里能看见"它到点说了一句"，
  // 而不是一口气把六句打印出来（那是脚本，不像陪看）。
  if (args.nextLine === true) {
    const everySec = Math.min(300, Math.max(3, Number(args.everySec) || 10));
    const st = await loadWatch();
    const key = sessionKey(input);
    const lastAt = Number(st[key]?.lastLineAt) || 0;
    const due = lastAt + everySec * 1000;
    let waited = 0;
    // 阻塞到点；中途暂停/视频结束就提前返回，让模型能说话
    while (Date.now() < due) {
      await new Promise((r) => setTimeout(r, 1000));
      waited += 1;
      const b = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
      if (b?.paused) break;
      if (b?.ended) break;
      if (waited > 600) break;
    }
    const b = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
    const pos = b?.pos ?? null;
    const plan2 = plan;
    const seg = pos !== null ? plan2.segmentAt(pos) : { from: 0, to: 0 };
    // 先问"到点了没有"：带 at 的台词只在它的时刻之后才发，否则同样的词会在段首提前跑出来。
    // **这里不做迟到作废**（lateSec: Infinity）：逐句模式下是模型主动来要下一句，
    // 位置停着不动也该把欠着的那句给它，而不是因为"晚了 30 秒"就丢掉。
    const line = (Number.isFinite(pos)
      ? await dueLine(input, pos, { size: seg.size ?? 0, lateSec: Infinity }).catch(() => null)
      : null)
      ?? await consumeLine(input, seg.from).catch(() => null);

    // **必须重新读一次状态再写**：consumeLine 内部已经保存过（把队列推进了一格），
    // 如果拿上面那份旧 st 覆盖回去，队列会退回原样 —— 表现就是同一句被反复返回。
    const st2 = await loadWatch();
    st2[key] = { ...(st2[key] ?? {}), lastLineAt: Date.now(), at: Date.now() };
    await saveWatch(st2).catch(() => {});

    if (!line) {
      return {
        ok: true,
        speaking: false,
        reason: 'no-line',
        text: `[${pos !== null ? mmss(pos) : '??:??'}] （这一段没有预设台词了）`
          + '\nLook at the picture with speakNow: true and say one sentence of your own, '
          + 'or write the next lines with lines: [...]',
        images: [],
      };
    }
    return {
      ok: true,
      speaking: true,
      at: pos,
      text: `[${pos !== null ? mmss(pos) : '??:??'}] ${line}`,
      images: [],
    };
  }

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
  if (!Number.isFinite(cursor)) {
    // 浏览器里的 currentTime 是毫秒级真值（需显式开调试端口），比 SMTC 的稀疏刷新可靠
    if (browserPort && autoLaunch) await ensureWatchBrowser(browserPort);
    const b = browserPort ? await readBrowser({ port: browserPort }).catch(() => null) : null;
    if (b && Number.isFinite(b.pos)) {
      cursor = b.pos;
      confidence = 'browser';
      note = ` (browser, ${b.paused ? 'paused' : 'playing'})`;
      if (b.url) activeSession = { ...(activeSession ?? {}), title: b.title, dur: b.dur };
    }
  }
  if (!Number.isFinite(cursor)) {
    const probeRes = await probe();
    const pick = probeRes.ok
      ? pickSession(probeRes.sessions, { input, title: args.title ?? activeSession?.title ?? null })
      : null;
    if (!pick) {
      return {
        ok: false,
        text: `cannot read your playback position (${probeRes.error ?? 'no active media session'}).\n`
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
        text: `your playback position is unreadable right now: SMTC last updated `
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
        // eslint-disable-next-line no-await-in-loop
        await buildOne(s);
      } catch { /* 备不上就算了，到点再建 */ }
    }
  } else if (args.prefetch !== false && toBuild.length > 0) {
    setTimeout(() => {
      void (async () => {
        for (const s of toBuild) {
          try {
            // eslint-disable-next-line no-await-in-loop
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
    + (builtMs ? ` · built in ${(builtMs / 1000).toFixed(1)}s` : ' · ready');

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
    while (Date.now() < deadline) {
      // 位置来源：浏览器（准）> 上次测得的 SMTC 快照（凑合能用来判断"到没到"）
      const np = browserPort
        ? await readBrowser({ port: browserPort }).catch(() => null)
        : null;
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
    text: `${head}${waitNote}\n${guidance}${await latencyNote()}${bufferHint}\n\n${entry.manifest}`,
    images,
  };
}
