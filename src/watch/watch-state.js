/**
 * watch-state.js — 陪看会话的状态存哪儿、怎么存，以及"一段多长、什么时候该说话"的算术。
 *
 * 存盘是为了宿主重启后接着看，不必重头。**只记指针，不记内容**：
 * 内容和图都在分镜缓存里，重复算一遍也就 8 s。
 *
 * 和 watch-lines.js 的分工：这里只管"这一部片子看到哪了"，
 * 台词队列怎么增删是那边的事 —— 两边都调 loadWatch/saveWatch，但互不了解对方写了什么。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from '../storyboard/cache.js';

/** 默认一段多长（秒）。120 s：60 分钟片 = 30 段，成本与连贯性的折中。 */
export const WATCH_SEGMENT = 120;
/** 提前多少秒交付：用户还在看，但这段快到尾巴了，此刻插话不打断。 */
export const WATCH_LEAD = 15;

/** 路径归一成小写正斜杠 —— 同一个文件在不同写法下必须算同一个会话。 */
export const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

export const segmentStart = (cursor, size = WATCH_SEGMENT) => Math.floor(Math.max(0, cursor) / size) * size;

export function watchPath(env = process.env) {
  return join(cacheDir(env), 'watch.json');
}

export async function loadWatch(env = process.env) {
  try {
    return JSON.parse(await readFile(watchPath(env), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveWatch(state, env = process.env) {
  try {
    // 只留最近 20 个源：不然看几十部片子之后这个文件会无限长
    const keys = Object.keys(state).sort((a, b) => (state[b]?.at ?? 0) - (state[a]?.at ?? 0));
    const pruned = {};
    for (const k of keys.slice(0, 20)) pruned[k] = state[k];
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(watchPath(env), JSON.stringify(pruned), 'utf8');
  } catch { /* 存不下就算了，最多重启后重算一段 */ }
}

export function sessionKey(input) {
  return norm(input);
}

/**
 * 这一段该不该说话了。
 *
 * 交付点刻意放在**段末前 lead 秒**，不是段末：
 * 用户正看着的时候插一句"这段快完了"，比卡在切换点更自然。
 */
export function deliveryState({ cursor, segment, size = WATCH_SEGMENT, lead = WATCH_LEAD }) {
  const end = segment + size;
  const remaining = end - cursor;
  return {
    segmentEnd: end,
    remaining: +remaining.toFixed(1),
    due: remaining <= lead,
    // 已经越界（用户看到下一段去了）也算该说，否则这段永远不会交付
    overdue: remaining <= 0,
  };
}
