/**
 * cells.js — 记住上一次分镜里每一格对应的**绝对时间**，供 `video_zoom({ cellId })` 直接寻址。
 *
 * 为什么需要：清单里每格都有 `t_start/t_end`，但模型想细看某一格时得自己抄数字，
 * 换窗口、改参数之后就抄错。cellId 让它"引用一次就闭环"。
 *
 * 存在哪：<cacheDir>/cells.json，只保留最近若干个文件，坏了就当没有（寻址失败可以退回 from/to）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from './cache.js';

const FILE = 'cells.json';
const MAX_FILES = 12;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

export function cellsPath(env = process.env) {
  return join(cacheDir(env), FILE);
}

/**
 * 记下这次分镜的格子表。
 * @param {string} path 源文件路径
 * @param {Array<{i:number, from:number, to:number}>} cells 绝对时间（秒）
 */
export async function saveCells(path, cells, { env = process.env, at = Date.now() } = {}) {
  if (!path || !Array.isArray(cells) || cells.length === 0) return;
  const file = cellsPath(env);
  let all = {};
  try {
    all = JSON.parse(await readFile(file, 'utf8')) ?? {};
  } catch { /* 没有或坏了：重建 */ }

  all[norm(path)] = {
    at,
    cells: cells.map((c) => ({ i: c.i, from: +c.from.toFixed(3), to: +c.to.toFixed(3) })),
  };
  // 按时间保留最近 MAX_FILES 个文件
  const keys = Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0));
  for (const k of keys.slice(MAX_FILES)) delete all[k];

  try {
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(file, JSON.stringify(all), 'utf8');
  } catch { /* 写不进去就算了，寻址会退回 from/to */ }
}

/**
 * 查某个文件某一格的绝对时间区间。
 * @returns {{from:number, to:number, i:number}|null}
 */
export async function lookupCell(path, cellId, { env = process.env } = {}) {
  if (!path || !Number.isFinite(Number(cellId))) return null;
  try {
    const all = JSON.parse(await readFile(cellsPath(env), 'utf8')) ?? {};
    const rec = all[norm(path)];
    const hit = rec?.cells?.find((c) => c.i === Number(cellId));
    return hit ? { ...hit } : null;
  } catch {
    return null;
  }
}
