/**
 * storage.js — 磁盘缓存只有一个总预算：**300 MB，全部加起来**。
 *
 * 之前是两个互不相干的盖子：
 *   - 扫描/ASR 的 JSON 缓存：50 MB（cache.js）
 *   - 下载下来的媒体文件：300 MB（fetch.js）
 * 于是"上限"是 350 MB 起步，而且两边各自为政：媒体满了不会去动 JSON，JSON 满了也不会动媒体。
 *
 * 这里把它们当成一个池子：
 *   1. 先算 JSON 占了多少，给媒体剩下的额度 = 预算 − JSON；
 *   2. 媒体按"整条视频"从旧到新删（不留半条）；
 *   3. 还不够就把 JSON 按最久未用删。
 *
 * 为什么先动媒体：一条 40 分钟的片子低清就是 200–300 MB，删它是唯一有效的手段；
 * 而 JSON 每个才 20 KB，删一千个也只是零头。反过来（先删 JSON）会白丢扫描结果。
 *
 * 台词和图片不在磁盘预算里：台词在 watch.json（几十 KB，受保护，永不裁），
 * 图片只在内存里留最近 8 段、不落盘 —— 所以它们不会挤占这 300 MB。
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir, cacheBytes, pruneCache } from './cache.js';
import { mediaDir, pruneMedia } from './media-store.js';

/** 总预算：媒体 + JSON + 状态文件，加起来不超过这个数 */
export const STORAGE_BUDGET_BYTES = 300 * 1024 * 1024;

/** 媒体目录占用（每个 <key>/ 是一个视频的全部文件） */
async function mediaBytes(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let files = [];
    try {
      files = await readdir(join(dir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      try {
        total += (await stat(join(dir, entry.name, f.name))).size;
      } catch { /* 忽略 */ }
    }
  }
  return total;
}

/** 当前占用（分开报，方便排查是谁吃掉的） */
export async function storageUsage({ dir = cacheDir(), media = mediaDir() } = {}) {
  const json = await cacheBytes({ dir });
  const mediaUsed = await mediaBytes(media);
  return { json, media: mediaUsed, total: json + mediaUsed };
}

/**
 * 按总预算裁剪。
 * @param {{budgetBytes?: number, dir?: string, media?: string}} [o]
 * @returns {Promise<{json:number, media:number, total:number, removedJson:number, removedMedia:number}>}
 */
export async function pruneStorage({
  budgetBytes = STORAGE_BUDGET_BYTES,
  dir = cacheDir(),
  media = mediaDir(),
} = {}) {
  const before = await storageUsage({ dir, media });

  // 1) 媒体先让位（它才是大头）
  const mediaAllowed = Math.max(0, budgetBytes - before.json);
  const mediaCut = await pruneMedia({ dir: media, maxBytes: mediaAllowed });

  // 2) 还不够，再动 JSON
  const afterMedia = await storageUsage({ dir, media });
  const jsonAllowed = Math.max(0, budgetBytes - afterMedia.media);
  const jsonCut = await pruneCache({ dir, maxBytes: jsonAllowed });

  const after = await storageUsage({ dir, media });
  return {
    json: after.json,
    media: after.media,
    total: after.total,
    removedJson: jsonCut.removed,
    removedMedia: mediaCut.removed,
  };
}
