/**
 * transcript-pass.test.mjs — 「只转写、不扫图」那一路。
 *
 * 它是陪看字幕轨的底座，所以判据必须和 pipeline 完全一致 —— 差别只有"不要图"。
 * 下面每一条都对应一种"看起来跑通了、其实给错了"的情形：
 *
 *   · 缓存已经覆盖窗口 → 必须秒回，且**不能**去拉起 ASR（拉起一次要好几秒 + 几百 MB）；
 *   · 窗口往后多要 10 秒 → 段边界落在句子中间时，下一段的窗口也能被同一次结果覆盖；
 *   · 裁剪回请求范围 → 多要的那 10 秒不能漏给调用方；
 *   · 没有声音 / 没配后端 → 老实说不行，不要假装成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { prefetchTranscript } from '../src/storyboard/transcript-pass.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 ffmpeg 就跳过 */ }

// **隔离本机配置**：`~/.dsh/asr.json` 里配了 `manage.start` + `waitMs: 60000`，
// 不隔离的话测试会真的去拉起本机的 ASR 服务，然后等它一分钟 —— 跑一次测试就污染一次机器状态。
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'tp-home-'));

async function makeMedia(dir, { audio = true } = {}) {
  const out = join(dir, audio ? 'with-audio.mp4' : 'silent.mp4');
  const args = ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=12'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out);
  await run(DEFAULT_FFMPEG, args);
  return out;
}

/** 带音轨 + 内嵌 mov_text 字幕的本地片：用来验证“内嵌字幕优先于 ASR” */
async function makeMediaWithSubtitles(dir) {
  const srt = join(dir, 'embedded.srt');
  const out = join(dir, 'with-subtitles.mp4');
  await writeFile(srt, [
    '1', '00:00:00,000 --> 00:00:02,500', '内嵌第一句', '',
    '2', '00:00:02,500 --> 00:00:05,500', '内嵌第二句', '',
  ].join('\n'));
  await run(DEFAULT_FFMPEG, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-c:s', 'mov_text', out,
  ]);
  return out;
}

/** 最小 OpenAI 兼容转写服务；记录每次请求，便于断言"到底有没有拉起 ASR" */
async function startFakeAsr(segments) {
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* 读完 body */ }
    seen.push({ url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: segments.map((s) => s.text).join(''), segments }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 把 ASR 配置临时指向假服务（配置优先读 env，改完 env 立刻生效），结束后还原 */
async function withAsr(baseUrl, fn) {
  const prev = {
    base: process.env.DSH_ASR_BASE_URL,
    key: process.env.DSH_ASR_KEY,
    model: process.env.DSH_ASR_MODEL,
  };
  process.env.DSH_ASR_BASE_URL = baseUrl;
  process.env.DSH_ASR_KEY = 'test-key';
  process.env.DSH_ASR_MODEL = 'whisper-1';
  try { return await fn(); } finally {
    for (const [k, v] of [
      ['DSH_ASR_BASE_URL', prev.base], ['DSH_ASR_KEY', prev.key], ['DSH_ASR_MODEL', prev.model],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('没有音轨：直接说不行，不要假装成功', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'tp-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const media = await makeMedia(dir, { audio: false });
    const r = await prefetchTranscript({ input: media, from: 0, to: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.source, 'no-audio');
    assert.deepEqual(r.segments, [], '拿不到就说没有，不要给空壳句子');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('内嵌字幕 + 无 ASR key：字幕先到，不要回 no-key', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'tp-sub-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  const prev = {
    key: process.env.DSH_ASR_KEY,
    base: process.env.DSH_ASR_BASE_URL,
    model: process.env.DSH_ASR_MODEL,
  };
  delete process.env.DSH_ASR_KEY;
  delete process.env.DSH_ASR_BASE_URL;
  delete process.env.DSH_ASR_MODEL;
  try {
    const media = await makeMediaWithSubtitles(dir);
    const r = await prefetchTranscript({
      input: media, from: 0, to: 5, ffmpegPath: DEFAULT_FFMPEG,
    });
    assert.equal(r.source, 'subtitle', `应走内嵌字幕，实得 ${r.source}：${r.reason ?? ''}`);
    assert.equal(r.ok, true, '内嵌字幕有句子时必须 ok');
    assert.ok(r.segments.some((s) => /内嵌第一句/.test(s.text)), '要把字幕原句带回来');
  } finally {
    for (const [k, v] of [
      ['DSH_ASR_KEY', prev.key], ['DSH_ASR_BASE_URL', prev.base], ['DSH_ASR_MODEL', prev.model],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('本地片 + ASR：句子落在请求窗口内，且窗口外多要的那 10 秒不漏给调用方', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'tp2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  // 句子铺满 0–30 秒，每 2 秒一句 —— 请求 0–10 秒时，10 秒之后的句子必须被裁掉
  const raw = [];
  for (let i = 0; i < 15; i += 1) raw.push({ start: i * 2, end: i * 2 + 2, text: `第${i + 1}句内容` });
  const fake = await startFakeAsr(raw);
  try {
    const media = await makeMedia(dir);
    const r = await withAsr(fake.baseUrl, () => prefetchTranscript({
      input: media, from: 0, to: 10, ffmpegPath: DEFAULT_FFMPEG, asrKey: 'test-key',
    }));
    assert.equal(r.ok, true, `应该成功，实得 ${r.source} ${r.reason ?? ''}`);
    assert.ok(r.segments.length > 0, '要有句子');
    for (const s of r.segments) {
      assert.ok(s.from >= 0 && s.to <= 10 + 0.001, `句子越界了：${s.from}–${s.to}（请求 0–10）`);
    }
    assert.ok(fake.seen.length >= 1, '这一路应该是真的打了 ASR');
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存已覆盖窗口：秒回，且不再拉起 ASR', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'tp3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  const raw = [];
  for (let i = 0; i < 15; i += 1) raw.push({ start: i * 2, end: i * 2 + 2, text: `第${i + 1}句内容` });
  const fake = await startFakeAsr(raw);
  try {
    const media = await makeMedia(dir);
    const first = await withAsr(fake.baseUrl, () => prefetchTranscript({
      input: media, from: 0, to: 10, ffmpegPath: DEFAULT_FFMPEG, asrKey: 'test-key',
    }));
    assert.equal(first.ok, true);
    const callsAfterFirst = fake.seen.length;

    // 第二次要的是**里面**的一小段（0–5）：缓存已经覆盖，不该再打服务
    const second = await withAsr(fake.baseUrl, () => prefetchTranscript({
      input: media, from: 0, to: 5, ffmpegPath: DEFAULT_FFMPEG, asrKey: 'test-key',
    }));
    assert.equal(second.ok, true);
    assert.equal(fake.seen.length, callsAfterFirst, '缓存命中还在打 ASR —— 冷启动那几百 MB 就白省了');
    assert.ok(second.segments.length > 0, '缓存里也要能切出句子');
    // 句子跨越窗口边界时允许整句保留（切成半句更糟），但起点必须落在窗口内
    for (const s of second.segments) {
      assert.ok(s.from < 5, `切到了窗口外的句子：${s.from}–${s.to}（请求 0–5）`);
      assert.ok(s.to > 0.001, `切到了窗口前的句子：${s.from}–${s.to}`);
    }
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('后端不可达：失败要带原因，不能静默返回空句子', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'tp4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const media = await makeMedia(dir);
    // 指到一个一定没人听的端口：这条路必须"报错且说清"，而不是 ok:true + []
    const r = await withAsr('http://127.0.0.1:9/v1', () => prefetchTranscript({
      input: media, from: 0, to: 5, ffmpegPath: DEFAULT_FFMPEG, asrKey: 'test-key', cache: false,
    }));
    assert.equal(r.ok, false, '服务不可达时必须返回 ok:false');
    assert.deepEqual(r.segments, [], '不许给空壳句子');
    assert.ok(String(r.reason ?? '').length > 0, '失败必须带原因');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
