/**
 * memory.js — "这个文件我看过，看到哪了"
 *
 * 缓存（cache.js）按 (路径, 大小, mtime, 窗口, 阈值) 存扫描与 ASR 结果，回答的是
 * **"这一段的账算过没有"**。它回答不了"这部片子我是不是看过、看了哪一段"——
 * 换个窗口、隔一天、换一个对话，全部重来，于是 agent 会把同一部片子重新描述一遍。
 *
 * 这里记的是最轻的一层事实：哪个文件、哪一段、多少格、多少刀、什么时候。
 * **不存模型输出**（那是调用方的职责），只存能证明"看过"的机械指标——
 * 也正因如此，它不会把上一次的结论当成事实带进新对话。
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from './cache.js';

const FILE = 'seen.jsonl';
const MAX_LINES = 400;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

export function memoryPath(env = process.env) {
  return join(cacheDir(env), FILE);
}

/**
 * 记一笔。失败就算了——记忆是锦上添花，不该让主流程挂掉。
 *
 * @param {{path?:string, duration?:number}} info probe 的结果
 * @param {{from:number, to:number, cells:number, cuts:number}} look 这一次看了什么
 */
export async function remember(info, look, { env = process.env, at = Date.now() } = {}) {
  if (!info?.path) return;
  const rec = {
    path: norm(info.path),
    duration: +(info.duration ?? 0).toFixed(2),
    from: +Number(look.from ?? 0).toFixed(2),
    to: +Number(look.to ?? info.duration ?? 0).toFixed(2),
    cells: look.cells ?? 0,
    cuts: look.cuts ?? 0,
    at,
  };
  try {
    await appendFile(memoryPath(env), `${JSON.stringify(rec)}\n`, 'utf8');
    await prune(env);
  } catch { /* 磁盘满 / 没权限：静默 */ }
}

/** 读到这个文件的所有历史记录（按时间倒序）。 */
export async function recall(info, { env = process.env } = {}) {
  if (!info?.path) return { entries: [], lastAt: null, windows: 0 };
  try {
    const raw = await readFile(memoryPath(env), 'utf8');
    const key = norm(info.path);
    const entries = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.path === key)
      .sort((a, b) => b.at - a.at);
    return {
      entries,
      lastAt: entries[0]?.at ?? null,
      windows: new Set(entries.map((e) => `${e.from}-${e.to}`)).size,
    };
  } catch {
    return { entries: [], lastAt: null, windows: 0 };
  }
}

/** 只保留最近 MAX_LINES 条，避免无限长。 */
async function prune(env) {
  try {
    const raw = await readFile(memoryPath(env), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    await writeFile(memoryPath(env), `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

/**
 * 给清单用的一句话："看过 2 段，上次 2026-10-27 23:10"。
 * 只在**确实看过**时返回，否则 null —— 没看过就不该占字符。
 */
export async function describeMemory(info, { env = process.env } = {}) {
  const m = await recall(info, { env });
  if (!m.windows) return null;
  const d = new Date(m.lastAt);
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ranges = [...new Set(m.entries.map((e) => `${e.from}-${e.to}s`))].slice(0, 4).join(', ');
  return `${m.windows} window(s) analysed before (${ranges}), last on ${when}. ` +
    'If you already described this file, cite that instead of describing it again.';
}
