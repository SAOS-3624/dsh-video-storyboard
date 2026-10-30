/**
 * watch-source.js — "用户到底在看什么"：从**零信息**反推到一条能用的 input。
 *
 * 从 watch-run.js 拆出来的第 0 步。用户只会说"我在看这个"，不会报路径；
 * 所以这里有四条候选路，按可靠度排序：
 *   1. 浏览器的视频页地址（能直接拿到 BV 号，比拿标题去搜准得多）
 *   2. 浏览器打开的是本地文件（file:// → 直接当路径用）
 *   3. 系统媒体会话（SMTC）给的标题 + 时长 → 去站点搜
 *   4. 上一次为这个标题记住的源（搜索接口会限流，重复搜没意义）
 *
 * 返回值有两种：`{ ok: false, ... }` 是"这次调用到此为止"的完整工具结果；
 * 否则是 `{ input, resolved, activeSession }`。**判据只看 ok**。
 */

import { fileUrlToPath, hasDebugPort, looksLikeVideoUrl } from '../storyboard/browser-time.js';
import { readPositionOrNull } from './watch-browser.js';
import { pickSession, saveWatch } from './watch.js';
import { resolvePlayingSource } from './resolve-playing.js';

/**
 * "可以开始看了"的判据 —— **能读到播放位置**，而不是"能读到页面地址"。
 *
 * 这两个以前被混为一谈：只要浏览器里有一个视频页，就把 input 定死、跳过 waitForVideo，
 * 然后因为页面还没起播读不到位，秒回一句 "cannot read your playback position"，
 * 还反过来让用户报时间。而"页面开着、但还没点播放"恰恰是最常见的场景。
 *
 * pos > 0.5 或正在播，才算就绪：暂停在 0:00 的人只是开着页面，不是在看。
 */
const positionReady = (b) => Boolean(b) && Number.isFinite(b?.pos)
  && (b.pos > 0.5 || b.paused === false);

/**
 * "为什么两边都没有视频"的那一行。两处失败文案共用同一份措辞 ——
 * 以前各写一遍，改一处就会让两条路径说出两种解释。
 */
async function whyNoVideoOnEitherSide(browserPort) {
  if (!browserPort) {
    return 'browser: NOT configured (no debug port), so only the OS media session could be read';
  }
  return await hasDebugPort({ port: browserPort })
    ? `browser: open :${browserPort} but no tab is holding a <video>`
    : `browser: CLOSED :${browserPort} — no debug port is listening`;
}

export async function resolveWatchSource({
  input: given, args, probe, readBrowser, browserPort, stateEarly,
}) {
  let input = given;
  let resolved = null;
  let activeSession = null;
  const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);

  if (!input) {
    // 浏览器开过调试端口时，**页面地址就是源**（能直接拿到 BV 号），比拿标题去搜准得多
    const b0 = await readPositionOrNull(readBrowser, browserPort);
    // 只认"视频页地址"：B 站首页也有 <video>（自动播放的推荐），但它不是任何一条视频
    if (b0?.url && looksLikeVideoUrl(b0.url) && /^https?:/i.test(b0.url) && positionReady(b0)) {
      input = b0.url;
      resolved = { input: b0.url, matchedBy: 'browser-url' };
    } else if (fileUrlToPath(b0?.url) && positionReady(b0)) {
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
        const bv = await readPositionOrNull(readBrowser, browserPort);
        // 页面在、但还没起播 -> 继续等（以前这里只看有没有地址，于是"打开但没播"会立刻过关）
        if (positionReady(bv)) {
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
          p0 = await probe({ timeoutMs: 1500 });
          activeSession = p0.ok ? pickSession(p0.sessions, {}) : null;
          if (activeSession?.title) break;
        }
        await new Promise((r) => setTimeout(r, 300));
        waitedVideoSec = Math.round((Date.now() - tWait) / 1000);
      }
      if (!input && !activeSession?.title) {
        const whyBrowser = await whyNoVideoOnEitherSide(browserPort);
        return {
          ok: false,
          waitedSec: waitedVideoSec,
          reason: 'no-video-timeout',
          browser: browserPort ? 'checked' : 'unconfigured',
          text: `I waited ${waitedVideoSec}s and no video appeared `
            + '(no browser tab holding a <video>, no OS media session).\n'
            + `${whyBrowser}\n`
            + 'Tell the user you are still waiting and that you will pick it up when it starts; '
            + 'call again with waitForVideo: true when they say it is playing.',
          images: [],
        };
      }
    }

    if (!activeSession?.title && !input) {
      const whyBrowser = await whyNoVideoOnEitherSide(browserPort);
      return {
        ok: false,
        reason: 'no-video',
        browser: browserPort ? 'checked' : 'unconfigured',
        text: `no video is playing right now (${p0.error ?? 'no active media session'}).\n`
          + `${whyBrowser}\n`
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
          + 'Two ways forward, either is fine:\n'
          + '  1. paste the link or the file path — I remember it per title and stop asking;\n'
          + '  2. start the browser with --remote-debugging-port=9222 and set DSH_BROWSER_DEBUG_PORT=9222 — '
          + 'then I read the page URL directly and never have to guess.',
        images: [],
      };
    }
    input = resolved.input;
    }
  }

  return { input, resolved, activeSession };
}

