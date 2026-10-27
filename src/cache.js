/**
 * cache.js — 分层分析缓存。
 *
 * L0 身份：路径 + size + mtime（不做整文件 hash，2GB 读一遍比重扫还慢）
 * L1 artifact：shots / audio / transcript 各有独立键与算法版本
 * L2 计划/渲染：由调用方用 plan_hash 自行命名（本模块只提供通用读写）
 *
 * 旧版 `cacheKey` 仍可用（等价于 shots 键），保持 CLI/测试兼容。
 *
 * 目录可用 DSH_VIDEO_CACHE_DIR 指定（C 盘紧张时指到别的盘）。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CACHE_VERSION = 2;
export const MAX_CACHE_BYTES = 80 * 1024 * 1024;

export function cacheDir(env = process.env) {
  if (env.DSH_VIDEO_CACHE_DIR) return env.DSH_VIDEO_CACHE_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'dsh-video-storyboard', 'cache');
  }
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-video-storyboard');
}

/** L0：文件身份片段；读不到文件时返回 null。 */
export async function fileIdentity(input) {
  try {
    const st = await stat(input);
    return { path: input, size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * L1 artifact 键。`kind` 区分 shots / audio / transcript / plan / …
 * `params` 序列化进键，换算法版本或 ASR 端点会自然 miss。
 */
export async function artifactKey({ input, kind, start, end, params = {} }) {
  const id = await fileIdentity(input);
  if (!id) return null;
  const paramPart = Object.keys(params).sort()
    .map((k) => `${k}=${String(params[k])}`).join('&');
  const raw = [
    CACHE_VERSION, kind, id.path, id.size, id.mtime,
    start ?? 0, end ?? 'eof', paramPart,
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/**
 * 兼容旧调用：等价于 shots artifact（threshold 进 params）。
 * 不用文件内容 hash —— 2GB 的文件读一遍比重新扫描还慢。
 */
export async function cacheKey({ input, start, end, threshold }) {
  return artifactKey({
    input, kind: 'shots', start, end,
    params: { threshold: String(threshold) },
  });
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
 */
export async function withCache(key, producer, opts = {}) {
  const hit = await readCache(key, opts);
  if (hit?.value) {
    // 触摸 mtime，让 pruneCache 按真正 LRU 淘汰
    const dir = opts.dir ?? cacheDir();
    try {
      await utimes(join(dir, `${key}.json`), new Date(), new Date());
    } catch { /* fail-open */ }
    return { ...hit.value, cached: true };
  }
  const value = await producer();
  await writeCache(key, { value }, opts);
  return { ...value, cached: false };
}
