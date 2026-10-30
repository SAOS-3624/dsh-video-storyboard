/**
 * watch-actions.js — `video_watch` 的**单发命令**：不进主流程，一问一答就结束。
 *
 * 从 index.js 拆出来的。这些东西放在工具注册函数里，会把"注册五个工具"这件事淹掉，
 * 而且它们各自回答的是不同的运维问题：
 *
 *   stopLoop    停钟（唯一一个"只写不读"的命令）
 *   statusOnly  钟在哪、浏览器在不在 —— **只问不建**，排查"它为什么没反应"的第一站
 *   checkCookies   B 站登录态 / 字幕可用性 —— 能立刻回答"为什么还在用 ASR"
 *   testWake    5 秒内回答"loop 到底叫不叫得醒我"
 *
 * **没有语音相关的命令**：核心不发声，念不念由订了 `speech` 事件的那一方决定
 * （见 voice.js 和 README 的「接声音」）。
 *
 * 返回 `null` 表示"这一轮不是单发命令"，交给主流程。**判据在调用方之外只有这一条**。
 */

import { configuredPort, probeBrowser } from '../storyboard/browser-time.js';
import { checkBiliLogin, fetchRemoteSubtitles } from '../storyboard/subtitles.js';
import { wakeSession } from './timer.js';
import { loopStatus, stopWatchLoop } from './watch-loop.js';
import { appendAssistantSay } from './chat.js';
import { lastSpeech } from './voice.js';

export async function runWatchAction(args, { ctx = null, sessionId = null, browserPort } = {}) {
  // 模型插话时说的那一句：写进统一流 + 交给声音。不占图片、不等位置，所以排在所有单发命令最前面。
  if (typeof args.say === 'string' && args.say.trim()) {
    const entry = appendAssistantSay(args.say, { t: lastSpeech()?.at ?? null });
    return { text: JSON.stringify({ ok: true, said: entry?.text ?? '', inChat: true }), images: [] };
  }

  if (args.stopLoop === true) {
    return { text: JSON.stringify(stopWatchLoop('requested')), images: [] };
  }

  // 只看钟的状态，不读进度、不出图 —— 排查"它为什么不说话"时用。
  // **顺带报浏览器状态**：这是唯一一个"只问不建"的入口，模型想知道
  // "浏览器到底开着没"的时候应该走这里，而不是拿播放位置去倒推。
  if (args.statusOnly === true) {
    const bp = browserPort ?? configuredPort() ?? null;
    const browser = bp
      ? await probeBrowser({ port: bp }).catch(() => ({ state: 'error', port: bp }))
      : { state: 'unconfigured', port: null };
    return { text: JSON.stringify({ ...loopStatus(), browser }, null, 1), images: [] };
  }

  // 检查 B 站登录态与字幕可用性：这一条能立刻回答"为什么还在用 ASR"
  if (args.checkCookies === true) {
    const login = await checkBiliLogin({ cookies: args.cookies });
    const url = typeof args.input === 'string' && /^https?:/i.test(args.input) ? args.input : null;
    const subs = url ? await fetchRemoteSubtitles({ url, cookies: args.cookies }) : null;
    return {
      text: JSON.stringify({
        login,
        subtitles: subs
          ? { ok: subs.ok, reason: subs.reason, count: subs.segments?.length ?? 0, lang: subs.lang }
          : 'pass a video URL in input to check subtitles',
      }),
      images: [],
    };
  }

  // 立刻试一次唤醒，把结果原样报出来。这一条能 5 秒内回答"loop 到底叫不叫得醒我"。
  if (args.testWake === true) {
    const r = await wakeSession(ctx, {
      sessionId,
      text: '[一起看] 这是一次唤醒连通性测试，收到就不用回复内容，回一句"收到"即可。',
    });
    return {
      text: JSON.stringify({
        sessionId: sessionId ?? null,
        hasSessionController: Boolean(ctx?.sessionController),
        hasPrompt: typeof ctx?.sessionController?.prompt === 'function',
        ...r,
      }),
      images: [],
    };
  }

  return null;
}

