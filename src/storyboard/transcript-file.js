/**
 * transcript-file.js — 读取一份**已有的**转写，跳过 ASR。
 *
 * 为什么需要它：B 站视频大多带 CC / AI 字幕，`yt-dlp --write-subs` 或字幕接口能直接
 * 拿到带时间码的文本。为了这份已经存在的东西去跑一遍 ASR，是纯粹浪费——一条 10 分钟
 * 的口播要 60–120 秒，还多一次模型调用。
 *
 * 顺带解决另一类问题：很多宿主的 ASR 走 chat/completions 方言，接不上
 * `/audio/transcriptions`。有字幕文件时，这条路根本不需要通。
 *
 * 支持三种形态，自动识别：
 *   1. SRT               `00:00:01,000 --> 00:00:03,500`
 *   2. 通用 JSON 数组     `[{start,end,text}]` 或 `[{from,to,text}]`
 *   3. B 站字幕 JSON      `{"body":[{"from":0.0,"to":2.5,"content":"..."}]}`
 *
 * 统一输出 `[{from, to, text}]` —— 和 asr.js 的 segments 同构，下游 alignCells 不用改。
 */

import { readFile } from 'node:fs/promises';

/** `00:01:02,500` / `00:01:02.500` / `1:02,5` → 秒 */
export function parseTimecode(raw) {
  const s = String(raw).trim().replace(',', '.');
  const parts = s.split(':');
  if (parts.length === 3) {
    const [h, m, sec] = parts;
    return Number(h) * 3600 + Number(m) * 60 + Number(sec);
  }
  if (parts.length === 2) {
    const [m, sec] = parts;
    return Number(m) * 60 + Number(sec);
  }
  const n = Number(parts[0]);
  return Number.isFinite(n) ? n : NaN;
}

/** 去掉字幕里常见的标记：`<i>` `<font color=...>` `{\an8}` 和 `&nbsp;` */
export function stripMarkup(text) {
  return String(text)
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/\{\\[^}]{1,40}\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 解析 SRT。容忍：BOM、CRLF、缺序号、时间码用 `.` 而不是 `,`、正文多行。
 * @returns {{from:number,to:number,text:string}[]}
 */
export function parseSrt(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const segments = [];
  // 以空行分块，比逐行状态机更耐受"最后一块没有尾随空行"的畸形文件
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    const arrowAt = lines.findIndex((line) => line.includes('-->'));
    if (arrowAt === -1) continue;
    const [left, right] = lines[arrowAt].split('-->');
    const from = parseTimecode(left);
    // 右侧可能带坐标后缀：`00:00:03,500 X1:100 X2:200 Y1:...`
    const to = parseTimecode(String(right).trim().split(/\s+/)[0]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const body = stripMarkup(lines.slice(arrowAt + 1).join(' '));
    if (!body) continue;
    segments.push({ from, to: Math.max(to, from), text: body });
  }
  return segments;
}

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

/**
 * 解析 JSON 形态。不假设固定 schema —— 三种常见布局都认：
 *   数组 + {start,end,text} / {from,to,text} / {from,to,content}
 *   {body:[...]}（B 站）   {segments:[...]}（OpenAI verbose_json / whisper）
 */
export function parseJsonTranscript(payload) {
  let list = null;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === 'object') {
    for (const key of ['body', 'segments', 'subtitles', 'items', 'data']) {
      if (Array.isArray(payload[key])) { list = payload[key]; break; }
    }
  }
  if (!list) throw new Error('unrecognised transcript JSON: expected an array, or an object with body/segments/subtitles/items/data');

  const segments = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const start = Number(pick(item, ['start', 'from', 'startTime', 'start_time', 'st']));
    const end = Number(pick(item, ['end', 'to', 'endTime', 'end_time', 'et']));
    const raw = pick(item, ['text', 'content', 'line', 'transcript', 'caption']);
    if (!Number.isFinite(start) || !Number.isFinite(end) || raw === undefined) continue;
    const body = stripMarkup(raw);
    if (!body) continue;
    segments.push({ from: start, to: Math.max(end, start), text: body });
  }
  return segments;
}

/** 猜格式：先看内容，再看扩展名。JSON 解析失败就退回 SRT，让错误信息更具体。 */
export function parseTranscript(source, filename = '') {
  const text = String(source).replace(/^\uFEFF/, '');
  const head = text.trimStart().slice(0, 1);
  const looksJson = head === '[' || head === '{';
  const ext = String(filename).toLowerCase().split('.').pop();

  if (looksJson || ext === 'json') {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`transcript JSON is not valid JSON: ${error.message}`);
    }
    return { segments: parseJsonTranscript(payload), format: 'json' };
  }
  const segments = parseSrt(text);
  if (segments.length === 0) {
    throw new Error('could not find any timed text: no "--> " blocks (SRT) and no JSON array');
  }
  return { segments, format: 'srt' };
}

/**
 * 读文件并解析。时间轴统一成**相对整段视频**的秒数；窗口偏移由 pipeline 负责减。
 * @param {string} path
 * @returns {Promise<{segments:{from:number,to:number,text:string}[], format:string}>}
 */
export async function loadTranscriptFile(path) {
  const text = await readFile(path, 'utf8');
  const { segments, format } = parseTranscript(text, path);
  // 按起点排序：手工编辑过的 SRT 时常出现顺序错乱，alignCells 假设递增
  segments.sort((a, b) => a.from - b.from || a.to - b.to);
  return { segments, format };
}
