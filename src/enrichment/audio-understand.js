/**
 * 音频理解（情绪 / 事件）客户端。契约：POST /v1/audio/understand
 * 也可从 SenseVoice 风格的 ASR 标签里本地解析（零外呼）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from '../probe.js';
import { enrichAuthHeaders } from './http.js';

const run = promisify(execFile);

/** SenseVoice / FunASR 常见标签 */
const TAG_RE = /<\|([^|>]+)\|>/g;
const EMOTION_SET = new Set([
  'HAPPY', 'SAD', 'ANGRY', 'NEUTRAL', 'FEARFUL', 'DISGUSTED', 'SURPRISED',
  'EMO_UNKNOWN', 'happy', 'sad', 'angry', 'neutral', 'fear', 'disgust', 'surprise',
]);
const EVENT_SET = new Set([
  'Speech', 'Music', 'Applause', 'Laughter', 'Cry', 'Sneeze', 'Breath',
  'SPEECH', 'MUSIC', 'BGM', 'speech', 'music',
]);

/**
 * 从 ASR 文本/段里拆出情绪与事件标签（SenseVoice 风格）。
 * @returns {{cleanText:string, emotion?:string, event?:string, tags:string[]}}
 */
export function parseSenseVoiceTags(text) {
  const src = String(text ?? '');
  const tags = [];
  let emotion;
  let event;
  let clean = src.replace(TAG_RE, (_, raw) => {
    const tag = String(raw).trim();
    tags.push(tag);
    const up = tag.toUpperCase();
    if (EMOTION_SET.has(tag) || EMOTION_SET.has(up)) emotion = up.replace(/^EMO_/, '');
    if (EVENT_SET.has(tag) || EVENT_SET.has(up)) event = up;
    return '';
  }).replace(/\s+/g, ' ').trim();
  return { cleanText: clean, emotion, event, tags };
}

/** 批量清洗 ASR segments，附带 emotion/event。 */
export function enrichTranscriptEmotions(segments) {
  let n = 0;
  const out = (segments ?? []).map((seg) => {
    const parsed = parseSenseVoiceTags(seg.text);
    if (!parsed.emotion && !parsed.event && parsed.cleanText === seg.text) return { ...seg };
    n += 1;
    return {
      ...seg,
      text: parsed.cleanText || seg.text,
      ...(parsed.emotion ? { emotion: parsed.emotion } : {}),
      ...(parsed.event ? { event: parsed.event } : {}),
      ...(parsed.tags.length ? { asr_tags: parsed.tags } : {}),
    };
  });
  return { segments: out, tagged: n };
}

/**
 * @returns {Promise<{spans:Array, model:string}|null>}
 */
export async function understandAudioRemote({
  input,
  from = 0,
  to,
  baseUrl,
  key,
  timeoutMs = 120_000,
  ffmpegPath = DEFAULT_FFMPEG,
} = {}) {
  if (!baseUrl || !input) return null;
  const root = String(baseUrl).replace(/\/$/, '');

  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  if (from > 0) args.push('-ss', String(from));
  if (to !== undefined) args.push('-t', String(Math.max(0.1, to - from)));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-');
  const { stdout } = await run(args[0], args.slice(1), {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs,
  });
  if (!stdout || stdout.length < 1024) return null;

  const form = new FormData();
  form.append('file', new Blob([stdout], { type: 'audio/wav' }), 'audio.wav');
  form.append('from', String(from));
  if (to !== undefined) form.append('to', String(to));

  const res = await fetch(`${root}/audio/understand`, {
    method: 'POST',
    headers: { ...enrichAuthHeaders(key) },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  if (!res.ok) {
    throw new Error(`audio-understand HTTP ${res.status}: ${(json?.error || text).toString().slice(0, 200)}`);
  }

  const spans = Array.isArray(json?.spans)
    ? json.spans.map((s) => ({
      from: +(Number(s.from ?? s.start) + from).toFixed(3),
      to: +(Number(s.to ?? s.end) + from).toFixed(3),
      ...(s.emotion ? { emotion: String(s.emotion) } : {}),
      ...(s.event ? { event: String(s.event) } : {}),
      ...(Number.isFinite(Number(s.confidence)) ? { confidence: +Number(s.confidence) } : {}),
    })).filter((s) => Number.isFinite(s.from) && s.to > s.from)
    : [];

  return {
    spans,
    model: String(json?.model || 'remote-audio-understand'),
  };
}
