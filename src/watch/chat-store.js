/**
 * chat-store.js — 统一文本流：一个 jsonl 文件，三种 role。
 *
 * ```
 *   role:'line'       剧本台词（say:true 时会被念）
 *   role:'assistant'  模型插话（watch_together 的 say 参数写进来）
 *   role:'user'       用户从聊天框说的话（不念）
 * ```
 *
 * ## 为什么用文件而不是别的
 *
 * 阻塞等待期间，**宿主的输入框不能实时把话送到模型手里**。实测（WorkBuddy）：
 * 用户 03:05:35 发的消息，写进会话文件时排在我 03:05:52 那条回复**之后** —— 事后补写。
 * 42 秒的文件大小监控里一个字节都没长。所以"发消息打断阻塞"在宿主这一层不成立。
 *
 * 而这里的 jsonl 是我们自己 append 的，**写盘即时**：阻塞循环每 500ms 读一次就能看见。
 * 这是唯一真正"边等边能听见"的通道。
 *
 * 这个文件只管"流里有什么"。HTTP 服务和页面在 `chat-server.js` / `chat-view.js`。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cacheDir } from '../storyboard/cache.js';
import { emitSpeech, onSpeech } from './voice.js';

/** 聊天记录（jsonl，一行一条 {role, text, at}） */
export function chatFile(env = process.env) {
  return join(cacheDir(env), 'chat.jsonl');
}

export function readChat(env = process.env) {
  try {
    return readFileSync(chatFile(env), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 追加一条到统一流。
 *
 * `at` 是**墙钟毫秒**（什么时候写进来的）；`t` 是**播放位置秒**（这句对应视频的哪一刻）——
 * 两者别混：`at` 用来排序，`t` 用来和画面比对。
 *
 * @param {'line'|'assistant'|'user'} role
 * @param {string} text
 * @param {{ t?: number|null, say?: boolean }} [meta] `say` = 这条要不要念出来
 */
export function appendChat(role, text, meta = {}, env = process.env) {
  const dir = cacheDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const entry = {
    role,
    text: String(text).slice(0, 2000),
    at: Date.now(),
    ...(Number.isFinite(meta?.t) ? { t: +Number(meta.t).toFixed(2) } : {}),
    ...(meta?.say === true ? { say: true } : {}),
  };
  appendFileSync(chatFile(env), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * 把"到点的台词"写进统一流 —— 这样聊天框里能看见剧本，声音也有得念。
 *
 * 只在 `state === 'due'` 时写：`scheduled` 是清单，不是"这句话现在说出来"。
 * 订阅时带 `voice: false` —— 聊天框只是**看**，它不该让循环以为"有人会念"。
 */
export function attachSpeechToChat({ env = process.env, onEntry = null } = {}) {
  return onSpeech((e) => {
    if (e.state !== 'due') return;
    // 插话那句是**先写流再广播**的（appendAssistantSay），这里再写就重复了
    if (e.origin === 'chat') return;
    const text = String(e.text ?? '').trim();
    if (!text) return;
    const entry = appendChat('line', text, { t: e.at, say: true }, env);
    try { onEntry?.(entry); } catch { /* 展示层的事，别影响写盘 */ }
  }, { voice: false });
}

/** 模型插话时说的那一句：写进流 + 交给声音（同一条事件，两个消费者各取所需） */
export function appendAssistantSay(text, { t = null, env = process.env } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const entry = appendChat('assistant', clean, { t, say: true }, env);
  // `origin: 'chat'` 告诉展示层的订阅者"这条已经在流里了，别再写第二遍"
  emitSpeech({ at: t, text: clean, state: 'due', origin: 'chat' });
  return entry;
}

/**
 * 盯"新来的用户消息"。
 *
 * 以创建时刻的条数为基线，之后只看增量 —— 历史消息一条都不会被误判成新插话。
 * 同一批里如果有多条，先返回最早那条（模型回完话再来取剩下的）。
 */
export function makeChatWatcher(env = process.env) {
  let seen = readChat(env).length;
  return function poll() {
    const all = readChat(env);
    if (all.length <= seen) return null;
    const fresh = all.slice(seen);
    seen = all.length;
    const u = fresh.find((m) => m.role === 'user' && String(m.text ?? '').trim());
    return u ? { text: u.text, at: u.at } : null;
  };
}
