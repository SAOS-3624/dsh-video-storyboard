/**
 * transcript-cache.js — 转写结果的**按片缓存**，窗口可以不同。
 *
 * 为什么不能只靠 cache.js 的 `cacheKey`：那个键把 `start`/`end` 也拼进去了，
 * 所以"先看 600–900，再 zoom 到 700–720"会重跑一次 ASR —— 同一段语音被转两遍。
 * SEQUENCE 是**顺序读**，窗口不重叠，这一层帮不上；它帮的是回看、zoom、
 * 以及"先扫整段再看其中一小段"这种最常见的追问。
 *
 * 键是文件身份（路径+大小+mtime）+ ASR 后端；存的是**绝对时间**的句子。
 * 命中判据是"已有一段完整覆盖本次窗口"，不是"有几句话落在里面"——
 * 否则半段转写会被当成完整结果，模型会以为这段没台词。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from './cache.js';

/** 每个文件最多留几段转写；SEQUENCE 24 段也够回看，再多就是磁盘垃圾。 */
const MAX_RANGES = 24;
/** 覆盖判定的容差（秒）：窗口边界常被吸附到剪辑点，差几十毫秒不该判 miss。 */
const COVER_SLACK = 0.25;

async function fileKey(input) {
  try {
    const st = await stat(input);
    return createHash('sha1')
      .update(`${input}|${st.size}|${Math.round(st.mtimeMs)}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return null;
  }
}

const dirFor = () => join(cacheDir(), 'transcripts');

/**
 * 找一段**完整覆盖** [from, to] 的转写。
 *
 * @returns {Promise<{segments:Array, range:{from:number,to:number}}|null>}
 */
export async function cachedTranscript(input, { from, to, backend }) {
  const key = await fileKey(input);
  if (!key) return null;
  let data;
  try {
    data = JSON.parse(await readFile(join(dirFor(), `${key}.json`), 'utf8'));
  } catch {
    return null;                                  // 没有或坏了：退回正常转写
  }
  if (data?.backend !== backend || !Array.isArray(data.ranges)) return null;
  const hit = data.ranges.find((r) => Number.isFinite(r?.from) && Number.isFinite(r?.to)
    && r.from <= from + COVER_SLACK && r.to >= to - COVER_SLACK);
  if (!hit) return null;
  const segments = (Array.isArray(hit.segments) ? hit.segments : [])
    .filter((s) => Number(s.to) > from && Number(s.from) < to)
    .map((s) => ({
      ...s,
      from: Math.max(from, Number(s.from)),
      to: Math.min(to, Number(s.to)),
    }));
  return { segments, range: { from: hit.from, to: hit.to } };
}

/**
 * 记下一段的转写（绝对时间）。同一后端、被新段完整包含的旧段会被丢掉，
 * 避免"先扫 0–300，再扫 0–1800"留下两份重复句子。
 */
export async function rememberTranscript(input, { from, to, segments, backend }) {
  const key = await fileKey(input);
  if (!key || !Array.isArray(segments)) return null;
  const dir = dirFor();
  let data = null;
  try {
    data = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
  } catch { /* 没有就新建 */ }
  const ranges = (data?.backend === backend && Array.isArray(data.ranges) ? data.ranges : [])
    .filter((r) => !(r.from >= from - COVER_SLACK && r.to <= to + COVER_SLACK));
  ranges.push({ from, to, segments });
  // 新的在前，超出上限就丢最旧的
  const trimmed = ranges.slice(-MAX_RANGES);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.json`),
      JSON.stringify({ v: 1, backend, at: Date.now(), ranges: trimmed }), 'utf8');
    return true;
  } catch {
    return null;                                  // 写不进去就算了，不影响出图
  }
}
