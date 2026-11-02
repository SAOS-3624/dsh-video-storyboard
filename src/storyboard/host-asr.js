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
 * 把 ffmpeg 吐出来的 WAV 改写成宿主认的 **canonical** 形式。
 *
 * 宿主的 `validateWave()`（`dsh-experimental-speech-to-text/lib/types/wave.js`）不是
 * "能解码就行"，它逐字节认死三条：
 *   - `RIFF size === len - 8`
 *   - `data` 块**必须正好在偏移 36**
 *   - `data size === len - 44`
 *
 * 而 `-f wav -` 走管道时这两点必坏：
 *   1. 管道不能 seek → `RIFF size` / `data size` 都写 `0xFFFFFFFF`（没法回填）；
 *   2. ffmpeg 默认还塞一个 `LIST/INFO`（`ISFT=Lavf61…`），把 `data` 从 36 顶到 70。
 * 三条校验全灭 → 宿主抛 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"
 * → 被折成 `transcript="asr-failed"`，日志里看不出任何线索（2026-11-02 macOS 实报）。
 *
 * **不写临时文件**：管道拿不到的长度我们自己会算（`len-8` / `len-44`）。
 * 按 RIFF chunk 走一遍、只留 `fmt ` + `data`，重组成 44 字节头 —— 零额外磁盘 I/O，
 * win/mac 同一套代码，也不会有残留临时文件。
 *
 * @param {Buffer|Uint8Array} input  ffmpeg 直接写到 stdout 的字节
 * @returns {Buffer} 44 字节头 + PCM payload
 * @throws 结构认不出来时**明确报错**（宁可失败也别静默跳过一整段台词）
 */
export function canonicalizeWav(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('host ASR: ffmpeg output is not a RIFF/WAVE stream');
  }
  let fmt = null;
  let payload = null;
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      // 管道写的 size 是 0xFFFFFFFF（流式没法回填）→ 只能读到哪算哪
      const end = size === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + size);
      payload = bytes.subarray(body, end - ((end - body) & 1)); // PCM16 长度必须偶数
      break;
    }
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) fmt = bytes.subarray(body, body + 16);
    if (size === 0xFFFFFFFF || body + size > bytes.length) break;  // 后面没法再走了
    p = body + size + (size & 1);   // chunk 按 2 字节对齐
  }
  if (!fmt) throw new Error('host ASR: WAV has no `fmt ` chunk');
  if (!payload) throw new Error('host ASR: WAV has no `data` chunk');

  const out = Buffer.alloc(44 + payload.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);       // PCM 的 fmt 块固定 16 字节
  fmt.copy(out, 20);               // 格式字段原样保留，采样率对不对交给宿主判
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(payload.length, 40);
  payload.copy(out, 44);
  return out;
}

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
  // 取法和 `tools/shared.js` 的 `serviceOf()` 同一个机制：`ctx.get(name)`，服务没注册就返回
  // undefined。**不能改成 `ctx.speechToText`** —— cordis 对未声明的服务在 get 陷阱里直接抛，
  // `?.` 挡不住（0.5.9 那个回归）。这里不直接 import serviceOf，是为了避免
  // shared.js → host-asr.js → shared.js 的循环依赖。
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
      // 管道 WAV 的两个头字段回填不了 → 在这里补齐，否则宿主直接拒收（见 canonicalizeWav）
      const audio = canonicalizeWav(stdout);
      if (audio.length < 1024) continue;
      const spec = service.resolve({ audio: new Uint8Array(audio), language, ...(providerId ? { providerId } : {}) });
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
