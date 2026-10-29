/**
 * cache.js — 扫描结果缓存。
 *
 * 缓存什么：切点、阈值、分数摘要。这三样只跟"(文件, 窗口, 阈值策略)"有关，
 * 与格数/取帧方式无关，所以 storyboard 和 zoom 能共用同一份。
 *
 * **不缓存**响度序列：2 小时片子有 7 万个点，JSON 会涨到几百 KB；而音频解码比
 * 视频解码便宜得多，重算更划算。
 *
 * 目录可用 DSH_VIDEO_CACHE_DIR 指定（C 盘紧张时指到别的盘）。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// 缓存版本：**切点判定逻辑一变就要加 1** —— 版本进了 key，旧条目自动失效，不需要用户手清。
// 1 → 2：0.4.3 改了极静素材的相对基线判定（spikeCuts）、平铺格与 suppressClose 的用法，
// 旧缓存里的 cuts 与现在的算法不是一回事，留着会让"改了却看不出变化"。
export const CACHE_VERSION = 2;
export const MAX_CACHE_BYTES = 50 * 1024 * 1024;

export function cacheDir(env = process.env) {
  if (env.DSH_VIDEO_CACHE_DIR) return env.DSH_VIDEO_CACHE_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'dsh-video-storyboard', 'cache');
  }
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-video-storyboard');
}

/**
 * 缓存键：路径 + 大小 + mtime + 窗口 + 阈值模式。
 * 不用文件内容 hash —— 2GB 的文件读一遍比重新扫描还慢。
 */
export async function cacheKey({ input, start, end, threshold }) {
  let size = 0;
  let mtime = 0;
  try {
    const st = await stat(input);
    size = st.size;
    mtime = Math.round(st.mtimeMs);
  } catch {
    return null;                                  // 文件不可读就不缓存
  }
  const raw = [CACHE_VERSION, input, size, mtime, start ?? 0, end ?? 'eof', String(threshold)].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

export async function readCache(key, { dir = cacheDir() } = {}) {
  if (!key) return null;
  try {
    const payload = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
    return payload?.v === CACHE_VERSION ? payload : null;
  } catch {
    return null;
  }
}

export async function writeCache(key, value, { dir = cacheDir() } = {}) {
  if (!key) return null;
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${key}.json`);
    await writeFile(path, JSON.stringify({ v: CACHE_VERSION, at: Date.now(), ...value }), 'utf8');
    return path;
  } catch {
    return null;                                  // 缓存失败不能影响主流程
  }
}

/** 超过上限就按最久未用的删（简单 LRU） */
export async function pruneCache({ dir = cacheDir(), maxBytes = MAX_CACHE_BYTES } = {}) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = await stat(join(dir, name));
      files.push({ path: join(dir, name), size: st.size, at: st.mtimeMs });
    } catch { /* 忽略 */ }
  }
  files.sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await unlink(f.path);
      total -= f.size;
      removed += 1;
    } catch { /* 忽略 */ }
  }
  return { removed, bytes: total };
}

/**
 * 包一层：命中就读，未命中就执行并写回。fails-open —— 缓存坏掉最多是"慢一点"，
 * 绝不能让分镜失败。
 *
 * producer 返回 null/undefined 时**原样返回**，不包成 `{cached:false}`：`{...null}` 出来的是
 * 一个 **truthy 的空壳对象**，调用方写 `if (result)` 就会把自己骗过去 —— ASR 一条都没跑，
 * 清单却写 "ASR ran and found no speech"（真实的假消息）。这类"什么都没做"的结果也不写缓存。
 */
export async function withCache(key, producer, opts = {}) {
  const hit = await readCache(key, opts);
  if (hit?.value) return { ...hit.value, cached: true };
  const value = await producer();
  if (value === null || value === undefined) return value;
  await writeCache(key, { value }, opts);
  return { ...value, cached: false };
}
