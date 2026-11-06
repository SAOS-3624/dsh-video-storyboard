/**
 * media-store.js — 「下载到哪、占多大、什么时候删」。
 *
 * 从 fetch.js 拆出来的。落盘那份低清全片是"后面随便跳"的入场费（见 fetch.js 头部的实测），
 * 于是它就成了一份需要**自己管自己**的缓存：有容量上限、有 LRU 淘汰、有磁盘余量检查。
 * 这些和"怎么把 URL 变成本地文件"是两件事，出错时查的地方也不同。
 */

import { createHash } from 'node:crypto';
import { access, readdir, rm, stat, statfs } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configuredText, readVideoFile } from './user-config.js';

/** 文件在不在、可不可读。**一行一个坑**：裸 access() 抛异常，用 try 包住才是判断而不是报错。 */
export async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export const MEDIA_ENV = 'DSH_VIDEO_MEDIA_DIR';
export const MEDIA_MAX_MB_ENV = 'DSH_VIDEO_MEDIA_MAX_MB';
export const DEFAULT_MEDIA_MAX_MB = 300;

/* ------------------------------------------------------------------ 媒体缓存 */

export function mediaDir(env = process.env) {
  const configured = configuredText(readVideoFile(env), 'mediaDir');
  return env[MEDIA_ENV] || configured || join(tmpdir(), 'dsh-video-storyboard', 'media');
}

export function mediaMaxBytes(env = process.env) {
  const fromEnv = Number(env[MEDIA_MAX_MB_ENV]);
  const fromConfig = Number(readVideoFile(env).mediaMaxMb);
  const mb = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : Number.isFinite(fromConfig) && fromConfig > 0 ? fromConfig : DEFAULT_MEDIA_MAX_MB;
  return mb * 1024 * 1024;
}

/** 缓存键：归一化链接 + 落盘清晰度。**路径必须稳定**，否则下游的 sha1(路径+窗口) 会全部失效。 */
export function mediaKey(normalizedUrl, height) {
  return createHash('sha1').update(`${normalizedUrl}|${height}`).digest('hex').slice(0, 20);
}

async function dirSize(dir) {
  let total = 0;
  let newest = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { total: 0, newest: 0 };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      const st = await stat(path);
      total += st.size;
      newest = Math.max(newest, st.mtimeMs);
    } catch { /* 忽略 */ }
  }
  return { total, newest };
}

/**
 * 超限就**按 mtime 从旧到新**删整个 `<key>/` 目录。
 * 单个目录一起删，不留半个视频——否则下次会命中一个没有 video.mp4 的空壳。
 *
 * ## 两条不能省的护栏（issue #81）
 *
 * 1. **最新那个目录永远不删。** 它就是这一轮刚下好的片子。长片的 720p 副本
 *    本身就超过上限（实测 72 分钟 544 MB > 300 MB），只按"总量超了就删最旧的"
 *    会在下载完成的下一行把正在用的文件删掉，然后 `ffprobe: No such file`。
 *    保它意味着这一轮之后缓存可能仍然超限 —— 那也比"刚下完就删"好。
 * 2. `exclude`：调用方明确知道"这个目录正在用"时直接跳过，连统计都不算它。
 *    两处保险叠在一起，是因为 `pipeline.js` 的 `pruneStorage()` 不传 `exclude`
 *    也照样要安全。
 *
 * @param {{dir?: string, maxBytes?: number, exclude?: string|null}} [o]
 */
export async function pruneMedia({ dir = mediaDir(), maxBytes = mediaMaxBytes(), exclude = null } = {}) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const skip = exclude ? resolve(exclude) : null;
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (skip && resolve(path) === skip) continue;
    const { total, newest } = await dirSize(path);
    if (total > 0) dirs.push({ path, size: total, at: newest });
  }
  dirs.sort((a, b) => a.at - b.at);
  // 调用方点了名就保它；没点名才退回"保最新的那个"（`pruneStorage()` 走这条）。
  const keep = skip ?? (dirs.length > 0 ? dirs[dirs.length - 1].path : null);
  let total = dirs.reduce((n, d) => n + d.size, 0);
  let removed = 0;
  for (const d of dirs) {
    if (total <= maxBytes) break;
    if (keep && d.path === keep) continue;
    try {
      await rm(d.path, { recursive: true, force: true });
      total -= d.size;
      removed += 1;
    } catch { /* 忽略 */ }
  }
  return { removed, bytes: total };
}

/** 找到第一个存在的祖先目录：媒体目录还没建时，statfs 也要落在那块盘上。 */
function existingAncestor(path) {
  let probe = path;
  while (probe) {
    if (existsSync(probe)) return probe;
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return null;
}

/** 磁盘剩余空间（字节）。**按目标目录所在的盘**算，不是系统临时目录。 */
export async function freeBytes(dir = mediaDir(), { statfs: statfsFn = statfs } = {}) {
  try {
    const s = await statfsFn(existingAncestor(dir) ?? tmpdir());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
