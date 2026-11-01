/**
 * host-asr.js — 可选的 DSH 宿主 speechToText 桥。
 *
 * DSH 桌面版自带 SenseVoice，但它的 SPEECH SERVICE 只返回整段文字（没有词级时间戳），
 * 所以这里按窗口切 16k 单声道 WAV，一块一块交给宿主；每个块作为一条带 from/to 的台词。
 *
 * **只在宿主提供 speechToText 时启用**：CLI / 其他宿主没有这个服务，仍然走原来的
 * asr.json / OpenAI 兼容 HTTP，不改变现有行为。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chunkWindows } from './asr.js';
import { DEFAULT_FFMPEG } from './probe.js';

const run = promisify(execFile);

export const HOST_ASR_ID = 'host:speechToText';
const MAX_HOST_CHUNK = 30;

/**
 * 宿主 provider 不会因为“服务存在”就自动加载模型；先 prepare 并等它 ready。
 * snapshot 不可用时直接放行，让 transcribe() 给出它自己的错误。
 */
async function ensureHostReady(service, timeoutMs) {
  if (typeof service.snapshot !== 'function') return undefined;
  const initial = service.snapshot();
  const id = initial?.selection?.providerId;
  if (!id) return undefined;
  const view = () => service.snapshot()?.providers?.find((p) => p.id === id);
  if (!view()?.preparation) return id;
  const phase = () => view()?.preparation?.phase;
  let p = phase();
  if (p === 'ready' || p === 'standby') return id;
  if (p === 'failed') throw new Error('host speech provider is in failed state');
  if (typeof service.prepare !== 'function') {
    throw new Error('host speech provider is not prepared and cannot be prepared');
  }
  service.prepare(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    p = phase();
    if (p === 'ready' || p === 'standby') return id;
    if (p === 'failed') throw new Error('host speech provider preparation failed');
  }
  throw new Error(`host speech provider did not become ready within ${timeoutMs} ms`);
}

/**
 * 探测宿主服务并返回一个 transcribe 适配器；不可用时返回 null（绝不抛）。
 *
 * @param {object|null|undefined} ctx
 * @returns {null | ((options:object) => Promise<{segments:Array,model:string,language:string,empty:boolean}>)}
 */
export function hostSpeechToText(ctx) {
  let service = null;
  try {
    service = ctx?.get?.('speechToText') ?? null;
  } catch {
    service = null;
  }
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    return null;
  }

  return async function transcribeViaHost({
    input, ffmpegPath = DEFAULT_FFMPEG, start = 0, end,
    silences = [], maxChunk = MAX_HOST_CHUNK, language = 'zh', timeoutMs = 180_000,
  } = {}) {
    if (!(end > start)) throw new RangeError('end must be greater than start');
    const providerId = await ensureHostReady(service, timeoutMs);
    const windows = chunkWindows({
      start, end, silences, maxChunk: Math.min(Number(maxChunk) || MAX_HOST_CHUNK, MAX_HOST_CHUNK),
    });
    const segments = [];
    for (const win of windows) {
      const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
      if (win.from > 0) args.push('-ss', String(win.from));
      args.push('-t', String(Math.max(0.1, win.to - win.from)));
      args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-');
      const { stdout } = await run(args[0], args.slice(1), {
        encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,
      });
      if (stdout.length < 1024) continue;
      const spec = service.resolve({ audio: new Uint8Array(stdout), language, ...(providerId ? { providerId } : {}) });
      // 宿主 provider 的 transcribe 需要显式 signal；单次超时由这里的 timeout 管。
      const result = await service.transcribe(spec, AbortSignal.timeout(timeoutMs));
      const text = String(result?.text ?? '').trim();
      if (!text) continue;
      segments.push({
        from: +win.from.toFixed(3),
        to: +win.to.toFixed(3),
        text,
      });
    }
    return { segments, model: HOST_ASR_ID, language, empty: segments.length === 0 };
  };
}
