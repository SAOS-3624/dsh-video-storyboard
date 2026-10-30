/**
 * speech-bus.js — 陪看的**声音事件总线**：核心只发事件，永不发声。
 *
 * 这个文件和"引擎"没有一行关系。它只回答三个问题：
 *   谁在听（`onSpeech`，带 `voice` 标记）
 *   有没有人真会出声（`speechSubscribers`，只数 `voice: true`）
 *   发生了什么事（`emitSpeech`）
 *
 * ## 为什么引擎被赶出去了
 *
 * 原来 `src/tts.js` 有 229 行，其中和"看视频"有关的：**0 行**。
 * SAPI 的 COM 调用、注册表读取、edge-tts 子进程、ffplay 播放、`~/.dsh/tts.json` 解析 ——
 * 全是某个平台上的某种实现。后果是具体的：
 *
 *   - 通用视频插件为了配音，被迫在 Linux / 容器里也带着一段 Windows 专用代码；
 *   - 宿主里已经有语音插件时，两边会**抢着念同一句**；
 *   - 想换音色/换引擎，得改核心，而不是换一个消费者。
 *
 * ## 现在的边界
 *
 * ```
 *   核心  ──emitSpeech({ at, text })──▶  订阅者（companion 插件 / 宿主 speech service / CLI）
 *        永远不 import 任何引擎                自己决定念不念、用什么念
 * ```
 *
 * **守时仍然在核心**：循环每 2 秒读一次真实播放位置，到点才发事件 ——
 * 所以消费方不需要自己盯时间轴，收到就念即可。`at` 是这句话在时间轴上的计划位置，
 * 留给需要校准或做淡入淡出的消费者。
 *
 * 没有订阅者时，核心不产生任何副作用：不会加载引擎、不会建子进程，
 * 到点的台词照旧走"叫醒模型、让模型自己说"那条路。
 *
 * 适配器怎么挂见 `voice-adapter.js`；用法（消费方）见 README 的「接声音」。
 */

/** 事件形状。`state` 目前只有 `scheduled`（排队）和 `due`（发出时刻）两种。 */
export const SPEECH_EVENT_FIELDS = Object.freeze(
  ['seq', 'at', 'text', 'state', 'input', 'segment', 'origin', 'emittedAt'],
);

/**
 * 订阅者。`voice: true` = **会真的出声**（音频适配器）；`voice: false` = 只是看（聊天框、日志）。
 *
 * 这个区分很要紧：循环靠"有没有会出声的订阅者"决定**要不要把台词交出去、从而不叫醒模型**。
 * 只做展示的订阅者不该替模型做这个决定 —— 否则装个聊天框就会让陪看默默变成哑巴。
 *
 * @type {Map<(e:object)=>void, {voice:boolean}>}
 */
const subscribers = new Map();
let lastEvent = null;
let seq = 0;

/**
 * 订阅"某句台词到点了"。返回**退订函数**（不是 index，避免调用方自己记编号）。
 *
 * 订阅者在同一进程里才收得到事件。跨进程（比如自己的 CLI）要自己读 `speech` 结果或
 * 台词槽文件 —— 那种场景下消费方自己实现引擎更简单，参考 `tools/watch-cli/tts.mjs`。
 *
 * @param {(event:{seq:number, at:number, text:string, state:'due'|'scheduled', input?:string, segment?:number}) => void} handler
 * @returns {() => boolean} 退订；返回是否真的摘掉了
 */
export function onSpeech(handler, { voice = true } = {}) {
  if (typeof handler !== 'function') throw new TypeError('onSpeech(handler) needs a function');
  subscribers.set(handler, { voice: Boolean(voice) });
  return () => subscribers.delete(handler);
}

/** **会出声的**订阅者数量。循环用它判断"要不要把台词交出去、并因此不叫醒模型"。 */
export function speechSubscribers() {
  let n = 0;
  for (const s of subscribers.values()) if (s.voice) n += 1;
  return n;
}

/** 全部订阅者（含只做展示的）。emitSpeech 用；排查"到底谁在听"也用。 */
export function speechObservers() {
  return subscribers.size;
}

/** 最近发出的一条事件（排查"它到底发没发"用，不参与逻辑） */
export function lastSpeech() {
  return lastEvent;
}

/**
 * 广播一条到点的台词。**没有订阅者时是空操作**（返回 0），这是零依赖路径的保证。
 *
 * 单个订阅者抛异常不会影响其他人，也不会打断陪看 —— 声音挂掉不该让画面跟着停。
 *
 * @returns {number} 实际送达的订阅者数量
 */
export function emitSpeech(event) {
  if (subscribers.size === 0) return 0;
  seq += 1;
  const payload = Object.freeze({
    seq,
    at: Number.isFinite(event?.at) ? Number(event.at) : null,
    text: String(event?.text ?? ''),
    state: event?.state === 'scheduled' ? 'scheduled' : 'due',
    ...(event?.input ? { input: String(event.input) } : {}),
    ...(Number.isFinite(event?.segment) ? { segment: Number(event.segment) } : {}),
    // `origin: 'chat'` = 这条已经被写进聊天流了（插话时说的那句），展示层不要再写一遍
    ...(event?.origin ? { origin: String(event.origin) } : {}),
  });
  lastEvent = { ...payload, emittedAt: Date.now() };
  let delivered = 0;
  for (const fn of [...subscribers.keys()]) {
    try { fn(payload); delivered += 1; } catch { /* 订阅者自己的事 */ }
  }
  return delivered;
}

/**
 * 把存下来的台词槽（`[{ text, at }]`）转成事件形状，写进 `watch_together` 的返回值。
 *
 * 这是"文字流"那一半：**不依赖有没有订阅者**，模型和外部消费者都能拿到同一份带时间点的稿子。
 *
 * @param {Array<{text:string, at:number|null}>} lines
 * @param {{ fallbackAt?: number, segment?: number }} [o] 没写 `at` 的台词落在哪儿
 */
export function speechEvents(lines, { fallbackAt = 0, segment } = {}) {
  const base = Number.isFinite(fallbackAt) ? Number(fallbackAt) : 0;
  return (Array.isArray(lines) ? lines : [])
    .map((l) => {
      const text = String(l?.text ?? '').trim();
      if (!text) return null;
      // **注意 Number(null) === 0**：写没写 at 必须显式判 null/undefined，
      // 否则"没写 at 的台词"会全部落到 0 秒，而不是落在段首。
      const hasAt = l?.at !== null && l?.at !== undefined && Number.isFinite(Number(l.at));
      return {
        at: hasAt ? Number(l.at) : +base.toFixed(3),
        text,
        state: 'scheduled',
        ...(Number.isFinite(segment) ? { segment: Number(segment) } : {}),
      };
    })
    .filter(Boolean);
}

/** 仅测试/卸载用：清空订阅者与最近事件，避免用例之间互相污染 */
export function __resetSpeech() {
  subscribers.clear();
  lastEvent = null;
  seq = 0;
}
