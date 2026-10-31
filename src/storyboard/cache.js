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
// 2 → 3：扫描结果里新增了逐帧指纹（Uint8Array），而这里是 JSON.stringify —— 一旦被写进
// 条目就是几十 MB 的 {"0":12,…} 且类型全丢。现在指纹已改为不进缓存，升版本把可能写坏的条目作废。
// 3 → 4：扫描结果里新增了 darkRuns（黑场段）。旧条目没有这一项，命中后黑场会并回内容格，
// 同一支片子第一次跑和第二次跑出图不一样 —— 升版本让旧条目重扫一次。
export const CACHE_VERSION = 20;
// 4 → 5：扫描结果里新增了**抽稀指纹**（printPack，8fps base64）。
// `frameDiv` 判据靠它，旧条目没有就只能退回 meanMotion —— 同一支片第一次跑和第二次跑
// 摊开方式不一样，而且清单上看不出来。升版本让旧条目重扫一次。
// 11 → 12：细扫的两个常数按亮度增益折回原始刻度（归一化把暗片的分数整体放大了，
// 同一个 30/25 在放大后的刻度上更容易踩到，概念 PV 因此多出 30 刀）。
// 10 → 11：stats 里多了 `spread`（改动面积占比），切点判定要用它挡一拍二/局部特效。
// 旧条目没有这个字段，判定会与当前算法不同 —— 作废。
// 9 → 10：`auto-low` 的下限也回退成 4（抬高它反而让更多窗口过采纳关）。
// 8 → 9：细扫采纳门槛回退成绝对值（相对基线在"一拍二"动画上会造假刀），
// 与 6 的行为一致但多了"逐帧动画"护栏 —— 旧条目是相对判据产出的，作废。
// 7 → 8：`auto-low` 的下限从常数 4 改成"本窗 auto 阈值的 1/5" —— 细扫窗口里 4–7 分的
// 抖动被当成刀了（概念 PV 66–74s 段实测）。同样的 stats 会给出不同的 cuts，必须重扫。
// 6 → 7：细扫采纳加了"逐帧动画（一拍二）"护栏 —— 同样的 stats 会给出不同的 cuts，
// 旧条目留着就会把 2 帧一换的画面当成剪辑点（记管概念 PV 里 8 秒数出 20 刀）。
// 5 → 6：切点判据整体换了口径 —— 分数做了亮度/黑边归一（暗场、2.39:1 遮幅不再漏）、
// 抑制半径按内容自适应（0.3s 快剪不再对半）、新增长时差渐变转场（叠化/淡入淡出）。
// 旧条目里的 cuts 与新判据不是一回事，留着就是"改了却看不出变化"。
/** 单独用（没有统一预算时）的默认上限；正常路径走 storage.js 的 300MB 总预算。 */
export const MAX_CACHE_BYTES = 50 * 1024 * 1024;

/**
 * 这些文件不是"缓存"：删了就丢状态（台词队列、看过哪、cell 映射、延迟标定）。
 * 以前 pruneCache 会把所有 *.json 按 mtime 删，理论上包括 watch.json —— 台词会凭空消失。
 */
export const PROTECTED_FILES = Object.freeze([
  'watch.json', 'seen.jsonl', 'latency.json', 'cells.json',
]);

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

/** 当前 JSON 缓存占用（不含受保护的状态文件） */
export async function cacheBytes({ dir = cacheDir() } = {}) {
  let entries = [];
  try { entries = await readdir(dir); } catch { return 0; }
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') || PROTECTED_FILES.includes(name)) continue;
    try { total += (await stat(join(dir, name))).size; } catch { /* 忽略 */ }
  }
  return total;
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
    if (PROTECTED_FILES.includes(name)) continue;
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
