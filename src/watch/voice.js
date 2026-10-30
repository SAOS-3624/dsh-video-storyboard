/**
 * voice.js — 陪看的**声音接口**：核心只发事件，永不发声。
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
 * 用法（消费方）见 README 的「接声音」。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/** 仅测试用：清空订阅者与最近事件，避免用例之间互相污染 */
export function __resetSpeech() {
  subscribers.clear();
  lastEvent = null;
  seq = 0;
}

/* --------------------------------------------------------------- 外部适配器 */

/** 已挂载的适配器：specifier → 它的 detach（可能没有） */
const attached = new Map();

/**
 * 读 `~/.dsh/voice.json` 里的 `adapter`，或者环境变量 `DSH_VOICE_ADAPTER`。
 *
 * **只读"装哪个适配器"这一个字段**，音色、语速、引擎路径都是适配器自己的事 ——
 * 这就是"核心不读 TTS 配置"的具体含义。
 *
 * ```json
 * { "adapter": "D:/code/my-voice.mjs" }
 * ```
 */
export function configuredVoiceAdapter(env = process.env) {
  const fromEnv = String(env.DSH_VOICE_ADAPTER ?? '').trim();
  if (fromEnv) return fromEnv;
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const spec = String(cfg?.adapter ?? '').trim();
    if (spec) return spec;
  } catch { /* 没配就算了：这是可选能力 */ }
  return null;
}

/** `D:/code/x.mjs`、`./x.mjs`、`/opt/x.mjs` 当路径；`my-voice-adapter` 当包名 */
function toImportSpecifier(spec) {
  const s = String(spec).trim();
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(s)) return pathToFileURL(s).href;
  return s;
}

/**
 * 挂载一个外部适配器。**核心只做 dynamic import，不内置任何引擎**。
 *
 * 适配器模块导出 `attach(api)`（或 default 导出同名函数），`api` 是：
 * `{ onSpeech, speechSubscribers, emitSpeech, lastSpeech }`。
 * `attach` 可以返回一个 detach 函数；不返回也行，但要自己管好退订。
 *
 * 失败一律**不抛**：声音是可选能力，装坏了最多没声音，不能让陪看起不来。
 *
 * @param {string} spec 模块名或文件路径
 * @param {{ log?: (msg:string)=>void }} [o]
 * @returns {Promise<{ok:boolean, reason?:string, cached?:boolean, name?:string}>}
 */
export async function loadVoiceAdapter(spec, { log = () => {} } = {}) {
  const raw = String(spec ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty-specifier' };
  if (attached.has(raw)) return { ok: true, cached: true, name: raw };

  let mod = null;
  try {
    mod = await import(toImportSpecifier(raw));
  } catch (e) {
    const reason = `import failed: ${String(e?.message ?? e).slice(0, 200)}`;
    log(`[voice] ${raw}: ${reason}`);
    return { ok: false, reason };
  }

  const attach = mod?.attach ?? mod?.default;
  if (typeof attach !== 'function') {
    const reason = 'module does not export attach(api) (or a default function)';
    log(`[voice] ${raw}: ${reason}`);
    return { ok: false, reason };
  }

  try {
    const detach = await attach({ onSpeech, speechSubscribers, emitSpeech, lastSpeech });
    attached.set(raw, typeof detach === 'function' ? detach : null);
    // 模块没有自报名字时用路径末段 —— `attach.name` 永远是 "attach"，没有信息量
    const name = String(mod?.adapterName ?? raw).split(/[\\/]/).filter(Boolean).pop() || raw;
    log(`[voice] adapter attached: ${name}`);
    return { ok: true, name };
  } catch (e) {
    const reason = `attach failed: ${String(e?.message ?? e).slice(0, 200)}`;
    log(`[voice] ${raw}: ${reason}`);
    return { ok: false, reason };
  }
}

/** 按配置挂载（没配就是 no-op）。**这是核心唯一碰声音的地方**。 */
export async function attachConfiguredVoice({ env = process.env, log = () => {} } = {}) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return { ok: false, reason: 'not-configured' };
  return loadVoiceAdapter(spec, { log });
}

/** 已挂载的适配器列表（`statusOnly` 和排查用） */
export function attachedAdapters() {
  return [...attached.keys()];
}

/** 全部卸载（测试/热重载用） */
export async function detachAdapters() {
  for (const [spec, detach] of attached) {
    try { await detach?.(); } catch { /* 卸不掉也继续 */ }
    void spec;
  }
  attached.clear();
  subscribers.clear();
}

