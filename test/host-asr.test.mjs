import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { hostSpeechToText, HOST_ASR_ID } from '../src/storyboard/host-asr.js';
import { resolveTranscript } from '../src/storyboard/transcript-pass.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 ffmpeg 就跳过 */ }

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
      seen.push({ bytes: spec.audio.length, signal: signal instanceof AbortSignal });
      return { text: '本地一句话', audioSeconds: 3, inferenceSeconds: 0.1 };
    },
  };
  try {
    const bridge = hostSpeechToText({ get: (name) => name === 'speechToText' ? service : null });
    const r = await bridge({ input: media, start: 1, end: 4, ffmpegPath: DEFAULT_FFMPEG });
    assert.equal(seen.length, 1, '一个窗口应调用一次宿主 transcribe');
    assert.ok(seen[0].bytes > 1024, '要交出真正的 WAV 字节');
    assert.equal(seen[0].signal, true, '必须给宿主 transcribe 一个 AbortSignal');
    assert.deepEqual(r.segments.map((s) => [s.from, s.to, s.text]), [[1, 4, '本地一句话']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
