/**
 * 说话人分离客户端。契约：POST /v1/audio/diarize
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from '../probe.js';
import { enrichAuthHeaders } from './http.js';

const run = promisify(execFile);

/**
 * @returns {Promise<{segments:Array<{from:number,to:number,speaker:string}>, model:string}|null>}
 */
export async function diarizeRemote({
  input,
  from = 0,
  to,
  baseUrl,
  key,
  timeoutMs = 180_000,
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

  const res = await fetch(`${root}/audio/diarize`, {
    method: 'POST',
    headers: { ...enrichAuthHeaders(key) },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  if (!res.ok) {
    throw new Error(`diarize HTTP ${res.status}: ${(json?.error || text).toString().slice(0, 200)}`);
  }

  // 服务端返回相对「上传 WAV」的时间（WAV 从视频的 `from` 起算）→ 加回窗口偏移
  const segments = Array.isArray(json?.segments)
    ? json.segments
      .map((s) => ({
        from: +(Number(s.from ?? s.start) + from).toFixed(3),
        to: +(Number(s.to ?? s.end) + from).toFixed(3),
        speaker: String(s.speaker ?? s.label ?? 'SPEAKER_00'),
      }))
      .filter((s) => Number.isFinite(s.from) && s.to > s.from)
    : [];

  return {
    segments,
    model: String(json?.model || 'remote-diarize'),
    speakers: [...new Set(segments.map((s) => s.speaker))],
  };
}

/** 把说话人标签按时间重叠贴到 ASR 段落上（改写副本，不改入参）。 */
export function attachSpeakers(transcriptSegments, diarSegments) {
  if (!transcriptSegments?.length || !diarSegments?.length) {
    return { segments: transcriptSegments ?? [], labeled: 0 };
  }
  let labeled = 0;
  const segments = transcriptSegments.map((seg) => {
    const mid = (seg.from + seg.to) / 2;
    const hit = diarSegments.find((d) => mid >= d.from && mid < d.to)
      || diarSegments.find((d) => d.to > seg.from && d.from < seg.to);
    if (!hit) return { ...seg };
    labeled += 1;
    return { ...seg, speaker: hit.speaker };
  });
  return { segments, labeled };
}
