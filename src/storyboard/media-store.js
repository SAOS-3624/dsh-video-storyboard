/**
 * media-store.js — 「下载到哪、占多大、什么时候删」。
 *
 * 从 fetch.js 拆出来的。落盘那份低清全片是"后面随便跳"的入场费（见 fetch.js 头部的实测），
 * 于是它就成了一份需要**自己管自己**的缓存：有容量上限、有 LRU 淘汰、有磁盘余量检查。
 * 这些和"怎么把 URL 变成本地文件"是两件事，出错时查的地方也不同。
 */

import { createHash } from 'node:crypto';
import { access, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return env[MEDIA_ENV] || join(tmpdir(), 'dsh-video-storyboard', 'media');
}

export function mediaMaxBytes(env = process.env) {
  const mb = Number(env[MEDIA_MAX_MB_ENV]);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MEDIA_MAX_MB) * 1024 * 1024;
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
 */
export async function pruneMedia({ dir = mediaDir(), maxBytes = mediaMaxBytes() } = {}) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const { total, newest } = await dirSize(path);
    if (total > 0) dirs.push({ path, size: total, at: newest });
  }
  dirs.sort((a, b) => a.at - b.at);
  let total = dirs.reduce((n, d) => n + d.size, 0);
  let removed = 0;
  for (const d of dirs) {
    if (total <= maxBytes) break;
    try {
      await rm(d.path, { recursive: true, force: true });
      total -= d.size;
      removed += 1;
    } catch { /* 忽略 */ }
  }
  return { removed, bytes: total };
}

/** 磁盘剩余空间（字节）。拿不到就返回 null，由调用方决定是否放行。 */
export async function freeBytes() {
  try {
    const { statfs } = await import('node:fs/promises');
    const s = await statfs(tmpdir());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
