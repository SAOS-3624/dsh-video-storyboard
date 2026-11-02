import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { hostSpeechToText, canonicalizeWav, HOST_ASR_ID } from '../src/storyboard/host-asr.js';
import { resolveTranscript } from '../src/storyboard/transcript-pass.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 ffmpeg 就跳过 */ }

/**
 * 复刻宿主的 `validateWave()`（dsh-experimental-speech-to-text/lib/types/wave.js）。
 * 这些断言就是那道门 —— 只要它绿，宿主那边就不会再报
 * "Audio must be a canonical 16 kHz mono PCM16 WAV recording"。
 */
function canonicalWavProblem(a, maxSeconds = 60) {
  const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  if (b.length < 46) return `too short (${b.length})`;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE'
    || b.toString('ascii', 12, 16) !== 'fmt ') return 'not RIFF/WAVE/fmt';
  if (b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1
    || b.readUInt32LE(24) !== 16000 || b.readUInt32LE(28) !== 32000
    || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16) return 'fmt is not 16k mono PCM16';
  if (b.toString('ascii', 36, 40) !== 'data') return `data chunk at ${b.indexOf('data', 12, 'ascii')}, expected 36`;
  if (b.readUInt32LE(4) !== b.length - 8) return `RIFF size ${b.readUInt32LE(4)} != ${b.length - 8}`;
  if (b.readUInt32LE(40) !== b.length - 44) return `data size ${b.readUInt32LE(40)} != ${b.length - 44}`;
  if ((b.length - 44) % 2 !== 0) return 'odd payload length';
  if ((b.length - 44) / 32000 > maxSeconds) return 'too long';
  return null;
}

test('canonicalizeWav：管道头（0xFFFFFFFF + LIST/INFO）改成 44 字节 canonical', () => {
  // 复刻 `ffmpeg … -f wav -` 的实际输出：RIFF/data 长度都是 0xFFFFFFFF，中间夹一个 LIST/INFO
  const pcm = Buffer.alloc(3200, 7);
  const info = Buffer.from('INFOISFT\r\0\0\0Lavf61.100', 'latin1');   // 20 字节
  const piped = Buffer.alloc(12 + 24 + 8 + info.length + 8 + pcm.length);
  let p = 0;
  const chunk = (id, body) => {
    piped.write(id, p, 'latin1'); p += 4;
    piped.writeUInt32LE(body.length, p); p += 4;
    body.copy(piped, p); p += body.length;
    if (body.length % 2) { piped[p] = 0; p += 1; }
  };
  piped.write('RIFF', 0, 'latin1');
  piped.writeUInt32LE(0xFFFFFFFF, 4);
  piped.write('WAVE', 8, 'latin1');
  p = 12;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4); fmt.writeUInt32LE(32000, 8);
  fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  chunk('fmt ', fmt);
  chunk('LIST', info);
  // data：长度字段故意写 0xFFFFFFFF，模拟流式无法回填
  piped.write('data', p, 'latin1'); p += 4;
  piped.writeUInt32LE(0xFFFFFFFF, p); p += 4;
  pcm.copy(piped, p);

  assert.notEqual(canonicalWavProblem(piped), null, '管道原样必须过不了宿主校验（这就是那个 bug）');
  const fixed = canonicalizeWav(piped);
  assert.equal(canonicalWavProblem(fixed), null, '改写后必须原样通过宿主的 validateWave');
  assert.deepEqual(fixed.subarray(44), pcm, '音频数据一个字节都不能动');
});

test('canonicalizeWav：不是 WAV 就明确报错，不静默放行', () => {
  assert.throws(() => canonicalizeWav(Buffer.alloc(100, 1)), /not a RIFF\/WAVE/);
});

test('没有宿主 speechToText 时返回 null', () => {
  assert.equal(hostSpeechToText(null), null);
  assert.equal(hostSpeechToText({ get: () => undefined }), null);
  assert.equal(hostSpeechToText({ get: () => ({}) }), null);
});

test('有 resolve/transcribe 的宿主服务才启用', () => {
  const service = { resolve() {}, transcribe() {} };
  assert.equal(typeof hostSpeechToText({ get: (name) => name === 'speechToText' ? service : null }), 'function');
});

test('resolveTranscript：有 hostAsr 时优先本地，不再要求 ASR key', async () => {
  let called = null;
  const hostAsr = async (opts) => {
    called = opts;
    return {
      segments: [{ from: opts.start, to: opts.end, text: '本地转写成功' }],
      model: HOST_ASR_ID,
      language: 'zh',
      empty: false,
    };
  };
  const r = await resolveTranscript({
    input: 'dummy.mp4',
    info: { hasAudio: true, hasSubtitle: false, duration: 5 },
    winStart: 0,
    winDur: 5,
    cache: false,
    hostAsr,
  });
  assert.ok(called, 'hostAsr 必须被调用');
  assert.equal(called.start, 0);
  assert.equal(called.end, 5);
  assert.equal(r.transcriptInfo.source, 'asr');
  assert.equal(r.transcriptInfo.model, HOST_ASR_ID);
  assert.equal(r.transcriptInfo.segments[0].text, '本地转写成功');
});

test('hostSpeechToText：切出 16k WAV，并把服务文本按窗口返回', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'host-asr-'));
  const media = join(dir, 'with-audio.mp4');
  await run(DEFAULT_FFMPEG, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', media,
  ]);
  const seen = [];
  const service = {
    snapshot: () => ({
      selection: { providerId: 'fake' },
      providers: [{ id: 'fake', preparation: { phase: 'ready' } }],
    }),
    resolve: (req) => ({ ...req, provider: { info: { id: 'fake' } } }),
    transcribe: async (spec, signal) => {
      seen.push({ bytes: spec.audio.length, signal: signal instanceof AbortSignal, problem: canonicalWavProblem(spec.audio) });
      return { text: '本地一句话', audioSeconds: 3, inferenceSeconds: 0.1 };
    },
  };
  try {
    const bridge = hostSpeechToText({ get: (name) => name === 'speechToText' ? service : null });
    const r = await bridge({ input: media, start: 1, end: 4, ffmpegPath: DEFAULT_FFMPEG });
    assert.equal(seen.length, 1, '一个窗口应调用一次宿主 transcribe');
    assert.ok(seen[0].bytes > 1024, '要交出真正的 WAV 字节');
    // 这一条是回归网：0.6.2 之前交出去的是管道 WAV，宿主三条校验全灭、只报 asr-failed
    assert.equal(seen[0].problem, null, `交给宿主的必须是 canonical WAV：${seen[0].problem}`);
    assert.equal(seen[0].signal, true, '必须给宿主 transcribe 一个 AbortSignal');
    assert.deepEqual(r.segments.map((s) => [s.from, s.to, s.text]), [[1, 4, '本地一句话']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
