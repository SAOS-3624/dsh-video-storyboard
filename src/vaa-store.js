/**
 * vaa-store.js — 进程内近期 VAA，供同会话 zoom 切片复用（不替代磁盘 L1 缓存）。
 *
 * storyboard 跑完后 put；zoom 时若窗口被某份 VAA 覆盖，则 slice 而不重扫。
 */

import { createHash } from 'node:crypto';
import { fileIdentity } from './cache.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX = 8;

/** @type {Map<string, {at:number, analysis:object, identity:string}>} */
const store = new Map();

export function vaaIdentityKey(identity, window) {
  const raw = [
    identity?.path, identity?.size, identity?.mtime,
    window?.from ?? 0, window?.to ?? 'eof',
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

export async function putAnalysis(analysis, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!analysis?.info?.path || !analysis?.window) return null;
  const id = await fileIdentity(analysis.info.path);
  if (!id) return null;
  const key = vaaIdentityKey(id, {
    from: analysis.window.from,
    to: analysis.window.from + analysis.window.duration,
  });
  // 也用 path 粗键，方便 zoom 按路径查找覆盖窗口
  const pathKey = `path:${id.path}|${id.size}|${id.mtime}`;
  const entry = { at: Date.now(), analysis, identity: key, ttlMs };
  store.set(key, entry);
  store.set(pathKey, entry);
  prune(DEFAULT_MAX);
  return key;
}

export function getAnalysis(key) {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > (e.ttlMs ?? DEFAULT_TTL_MS)) {
    store.delete(key);
    return null;
  }
  return e.analysis;
}

/**
 * 找一份覆盖 [from,to] 的近期 VAA（同文件身份）。
 */
export async function findCoveringAnalysis(input, from, to) {
  const id = await fileIdentity(input);
  if (!id) return null;
  const pathKey = `path:${id.path}|${id.size}|${id.mtime}`;
  const e = store.get(pathKey);
  if (!e) return null;
  if (Date.now() - e.at > (e.ttlMs ?? DEFAULT_TTL_MS)) {
    store.delete(pathKey);
    return null;
  }
  const w = e.analysis.window;
  const winEnd = w.from + w.duration;
  if (from >= w.from - 0.05 && to <= winEnd + 0.05) return e.analysis;
  // 也扫一遍所有 entry（多窗口 storyboard 后 zoom）
  for (const [k, ent] of store) {
    if (!k.startsWith('path:')) {
      if (Date.now() - ent.at > (ent.ttlMs ?? DEFAULT_TTL_MS)) { store.delete(k); continue; }
      const id2 = await fileIdentity(ent.analysis.info.path);
      if (!id2 || id2.path !== id.path || id2.size !== id.size || id2.mtime !== id.mtime) continue;
      const ww = ent.analysis.window;
      const end = ww.from + ww.duration;
      if (from >= ww.from - 0.05 && to <= end + 0.05) return ent.analysis;
    }
  }
  return null;
}

export function clearAnalysisStore() {
  store.clear();
}

function prune(max) {
  if (store.size <= max * 2) return; // path 键翻倍
  const timed = [...store.entries()]
    .filter(([k]) => !k.startsWith('path:'))
    .sort((a, b) => a[1].at - b[1].at);
  while (timed.length > max) {
    const [k, ent] = timed.shift();
    store.delete(k);
    for (const [pk, pe] of store) {
      if (pk.startsWith('path:') && pe.identity === ent.identity) store.delete(pk);
    }
  }
}
