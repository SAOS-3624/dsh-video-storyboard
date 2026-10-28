/**
 * asr-local.test.mjs — 用**本地假服务器**验证 ASR 客户端，不需要 key，也不需要模型。
 *
 * 这一步的价值：把"我们这侧对不对"和"服务端有没有跑起来"彻底分开。
 * 如果真机部署后失败，看这个测试是否通过，就能立刻判断是客户端 bug 还是服务端问题。
 *
 * 同时也定义了服务端必须满足的契约（见 docs/ASR-CONTRACT.md）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  applyTermMap, canTranscribe, chunkWindows, describeAsrTarget, filterSuspectSegments, mergeSegments,
  needsCloudKey, resolveAsrConfig, transcribe, transcribeLong,
} from '../src/asr.js';
import { DEFAULT_FFMPEG } from '../src/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 */ }

/** 起一个最小的 OpenAI 兼容转写服务，记录收到的请求 */
async function startFakeAsr(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'] ?? '',
      bytes: body.length,
      body: body.toString('latin1'),   // 断言 multipart 里的字段用
    });
    const { status = 200, json } = handler(req, body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(r)) };
}

async function makeAudio(dir) {
  const out = join(dir, 'a.m4a');
  await run(DEFAULT_FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', out]);
  return out;
}

test('ASR 客户端：能解析 verbose_json，并把时间码偏移回窗口起点', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);

  const fake = await startFakeAsr(() => ({
    json: {
      text: '第一句。第二句。',
      language: 'zh',
      segments: [
        { start: 0.0, end: 1.2, text: '第一句。' },
        { start: 1.2, end: 2.4, text: '第二句。' },
      ],
    },
  }));
  t.after(() => fake.close());

  const result = await transcribe({
    input: file, start: 4, end: 10,
    baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-asr',
  });

  assert.equal(result.segments.length, 2);
  assert.equal(result.model, 'fake-asr');
  assert.equal(result.language, 'zh');
  // 服务端返回的是相对时间，客户端必须加上 start
  assert.ok(Math.abs(result.segments[0].from - 4) < 1e-6, `实得 ${result.segments[0].from}`);
  assert.ok(Math.abs(result.segments[1].to - 6.4) < 1e-6, `实得 ${result.segments[1].to}`);

  // 请求本身要合规
  assert.equal(fake.seen.length, 1);
  assert.match(fake.seen[0].url, /\/v1\/audio\/transcriptions$/);
  assert.equal(fake.seen[0].auth, 'Bearer test-key');
  assert.match(fake.seen[0].contentType, /multipart\/form-data/);
  assert.ok(fake.seen[0].bytes > 1024, '应该真的上传了音频');
});

test('ASR 客户端：服务端只给整段 text 时退化成一条', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);

  const fake = await startFakeAsr(() => ({ json: { text: '整段一句话' } }));
  t.after(() => fake.close());

  const result = await transcribe({
    input: file, start: 2, end: 8, baseUrl: fake.baseUrl, apiKey: 'k',
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, '整段一句话');
  assert.equal(result.segments[0].from, 2);
});

test('ASR 客户端：服务端 4xx 时要抛错（便于上层标 asr-failed）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);

  const fake = await startFakeAsr(() => ({ status: 401, json: { error: 'bad key' } }));
  t.after(() => fake.close());

  await assert.rejects(
    () => transcribe({ input: file, baseUrl: fake.baseUrl, apiKey: 'bad' }),
    /ASR 401/,
  );
});

test('ASR 客户端：云端没配 key → 直接返回 null，不发请求', async () => {
  // 云端必须 key（没有必然 401）。本机服务不在此列 —— 见下一条。
  const result = await transcribe({ input: 'whatever.mp4', baseUrl: 'https://api.example.com/v1', apiKey: null });
  assert.equal(result, null);
});

test('ASR 客户端：配了热词就把它作为 hotword 字段发出去', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);
  const fake = await startFakeAsr(() => ({ json: { text: '测试', segments: [{ start: 0, end: 1, text: '测试' }] } }));
  t.after(() => fake.close());

  await transcribe({ input: file, baseUrl: fake.baseUrl, apiKey: 'x', hotwords: '像差 焦段' });
  const body = fake.seen.at(-1).body;
  assert.match(body, /name="hotword"/, '必须带 hotword 字段');
  // multipart 里中文是 UTF-8 原文，转 latin1 会变乱码，用 Buffer 再核对一次
  const raw = Buffer.from(body, 'latin1').toString('utf8');
  assert.match(raw, /像差 焦段/);
});

test('ASR 客户端：本机服务没配 key 也会真的去请求（不要求假 key）', async () => {
  // 自己跑的 FunASR 不校验 Authorization；逼用户填 key 只会让"能不能用"取决于文档
  await assert.rejects(
    () => transcribe({ input: 'whatever.mp4', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null }),
    /./,
    '应该尝试连接（然后失败），而不是提前 return null',
  );
});

/**
 * 这两条锁的是**同一个判据的两侧**：`canTranscribe()` 必须和 `transcribe()` 的门同源。
 * 只看 key 的实现会把"本机服务正在跑"误判成"不会转写"，而那正好和事实相反 ——
 * 清单会说"没配 key、不会转写"，调用却真的发出去了。0.4.1 起本机服务不需要 key，
 * 所以判据只能是"有 key 或 baseUrl 指向本机"。
 */
test('canTranscribe / needsCloudKey: 判据必须和 transcribe() 的门一致', () => {
  const cloud = { baseUrl: 'https://api.example.com/v1', keyEnv: '__NO_SUCH_ENV__' };
  const local = { baseUrl: 'http://127.0.0.1:8000/v1', keyEnv: '__NO_SUCH_ENV__' };

  assert.equal(needsCloudKey(cloud.baseUrl, undefined), true);
  assert.equal(needsCloudKey(local.baseUrl, undefined), false);

  assert.equal(canTranscribe(cloud, undefined), false, '云端无 key → 不会转写');
  assert.equal(canTranscribe(cloud, 'k'), true);
  assert.equal(canTranscribe(local, undefined), true, '本机服务无 key 也会真的发请求');
  assert.equal(canTranscribe(local, null), true, '显式 null 只是"别查 env"，本机仍然能跑');
});

test('transcribeLong: 本机服务没 key 时返回 empty 而不是 null（真的跑了、只是没听到话）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);

  // 服务在跑，只是返回 0 段 —— 术语上属于"跑了、没听到话"，不能报成"没跑"
  const fake = await startFakeAsr(() => ({ json: { text: '', segments: [] } }));
  t.after(() => fake.close());

  const r = await transcribeLong({
    input: file, start: 0, end: 12, maxChunk: 45,
    baseUrl: fake.baseUrl, apiKey: null, model: 'fake-asr',
  });
  assert.ok(r, '本机服务确实被调用了，不该返回 null');
  assert.equal(r.empty, true, 'empty 才是"跑了但没结果"的正确表达');
  assert.equal(fake.seen.length, 1, '必须真的发出了请求');
  assert.equal(fake.seen[0].auth, undefined, '本机服务不该带 Authorization');
});


/* ---------------------------------------------------------------- 切片与漂移 */

test('chunkWindows: 不超过上限、首尾相接、覆盖全段', () => {
  const w = chunkWindows({ start: 0, end: 100, maxChunk: 45 });
  assert.deepEqual(w.map((x) => [x.from, x.to]), [[0, 45], [45, 90], [90, 100]]);
});

test('chunkWindows: 短于上限时只有一个窗口', () => {
  assert.deepEqual(chunkWindows({ start: 10, end: 40, maxChunk: 45 }), [{ from: 10, to: 40 }]);
});

test('chunkWindows: 切点优先落在静音中点（不劈词）', () => {
  // 理想的 45s 处正好有句话，静音在 38.5–40.5
  const w = chunkWindows({
    start: 0, end: 100, maxChunk: 45,
    silences: [{ from: 38.5, to: 40.5 }, { from: 82, to: 84 }],
  });
  assert.deepEqual(w.map((x) => +x.to.toFixed(1)), [39.5, 83, 100]);
});

test('chunkWindows: 窗口太短时不采用更近的静音（避免碎请求）', () => {
  // 静音在 3–4s，太靠近起点，应该忽略它、用固定步长
  const w = chunkWindows({ start: 0, end: 100, maxChunk: 45, silences: [{ from: 3, to: 4 }] });
  assert.equal(w[0].to, 45);
});

test('mergeSegments: 相邻重复文本只留一个', () => {
  const merged = mergeSegments([
    { from: 0, to: 1, text: 'A' },
    { from: 0.9, to: 2, text: 'A' },
    { from: 2, to: 3, text: 'B' },
  ]);
  assert.deepEqual(merged.map((s) => s.text), ['A', 'B']);
  assert.equal(merged[0].to, 2, '重复段应合并成一条并取并集时长');
});

/**
 * 这个假服务器**复现了实测到的那个 bug**：请求音频越长，时间码压缩越多
 * （SEACO-Paraformer 实测 299s 压早 13s ≈ 4.5%）。
 * 如果客户端不在调用侧切片，长音频的时间码就会整体漂移。
 */
function driftingHandler(req, body) {
  const duration = body.length / 32000;            // 16k 单声道 16bit
  const compress = duration > 6 ? 0.955 : 1;
  const segments = [];
  for (let t = 0; t + 1 <= Math.floor(duration); t += 1) {
    segments.push({ start: +(t * compress).toFixed(3), end: +((t + 1) * compress).toFixed(3), text: `t${t}` });
  }
  return { json: { text: segments.map((s) => s.text).join(''), segments, model: 'drift-fake', language: 'zh' } };
}

test('漂移回归：长音频单发会偏移，切片后归位', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudio(dir);                 // 12s

  const fake = await startFakeAsr(driftingHandler);
  t.after(() => fake.close());

  // ① 单发 12s（>6s）→ 假服务器压缩时间码
  const single = await transcribe({ input: file, start: 0, end: 12, baseUrl: fake.baseUrl, apiKey: 'k' });
  const singleLast = single.segments.at(-1).from;
  assert.ok(singleLast < 10.7, `应复现漂移，实得 ${singleLast}`);

  // ② 切成 4s（<=6s）→ 不压缩，时间码归位
  const chunked = await transcribeLong({
    input: file, start: 0, end: 12, maxChunk: 4, baseUrl: fake.baseUrl, apiKey: 'k',
  });
  const chunkedLast = chunked.segments.at(-1).from;
  assert.ok(Math.abs(chunkedLast - 11) < 0.2, `切片后末段应≈11s，实得 ${chunkedLast}`);
  assert.equal(chunked.chunks, 3);
  assert.equal(chunked.model, 'drift-fake', 'model 应回填服务端返回的真身');
  // 时间码必须单调
  for (let i = 1; i < chunked.segments.length; i++) {
    assert.ok(chunked.segments[i].from >= chunked.segments[i - 1].from);
  }
});


/* ---------------------------------------------------------------- 配置解析 */

test('resolveAsrConfig: 环境变量优先于 asr.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  await writeFile(join(dir, 'asr.json'), JSON.stringify({ baseUrl: 'http://file/v1', key: 'file-key', model: 'file-model' }));
  try {
    const env = { DSH_HOME: dir, DSH_ASR_BASE_URL: 'http://env/v1', DSH_ASR_KEY: 'env-key' };
    const cfg = resolveAsrConfig(env);
    assert.equal(cfg.baseUrl, 'http://env/v1');
    assert.equal(cfg.source, 'env');
    assert.equal(cfg.model, 'file-model', '没被 env 覆盖的字段应落到文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAsrConfig: 没有 env 时读 $DSH_HOME/asr.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  await writeFile(join(dir, 'asr.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8000/v1', key: 'local-key' }));
  try {
    const cfg = resolveAsrConfig({ DSH_HOME: dir });
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:8000/v1');
    assert.equal(cfg.fileKey, 'local-key');
    assert.equal(cfg.source, 'file');
    assert.ok(cfg.configPath.endsWith('asr.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAsrConfig: 坏 JSON / 缺文件时退回默认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  await writeFile(join(dir, 'asr.json'), '{ broken');
  try {
    const cfg = resolveAsrConfig({ DSH_HOME: dir });
    assert.equal(cfg.source, 'default');
    assert.equal(cfg.baseUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(cfg.fileKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeAsrTarget: 带出目标与配置来源，但绝不含 key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  await writeFile(join(dir, 'asr.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8000/v1', key: 'super-secret' }));
  try {
    const label = describeAsrTarget(resolveAsrConfig({ DSH_HOME: dir }));
    assert.match(label, /127\.0\.0\.1:8000/);
    assert.match(label, /config file/);
    assert.ok(!label.includes('super-secret'), '不能把 key 打进日志');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 幻觉段过滤 */

test('filterSuspectSegments: 长时段+极低字/秒 判为幻觉', () => {
  const { kept, dropped } = filterSuspectSegments([
    { from: 2.68, to: 5.42, text: '所以你连他也要忘记吗' },      // 9字/2.74s = 3.3 字/秒
    { from: 45.35, to: 74.33, text: 'the 的不个就是嗯。' },       // 8字/29s = 0.28
    { from: 13.51, to: 32.35, text: '不多' },                    // 2字/18.8s = 0.11
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].from, 2.68);
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0].reason, 'music-like');
  assert.ok(dropped[0].charsPerSec < 0.8);
});

test('filterSuspectSegments: 只有标点的段直接丢', () => {
  const { kept, dropped } = filterSuspectSegments([
    { from: 1, to: 2, text: '。' },
    { from: 3, to: 4, text: '  ' },
    { from: 5, to: 6, text: '正常一句' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0].reason, 'punctuation-only');
});

test('filterSuspectSegments: 正常长句不会被误杀', () => {
  // 10 秒说 40 个字 = 4 字/秒，是正常语速
  const { kept, dropped } = filterSuspectSegments([
    { from: 0, to: 10, text: '这一段话有四十个字用来验证正常语速不会被当成音乐噪声处理掉的情况' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('filterSuspectSegments: 空输入不炸', () => {
  assert.deepEqual(filterSuspectSegments([]), { kept: [], dropped: [] });
  assert.deepEqual(filterSuspectSegments(undefined), { kept: [], dropped: [] });
});

/* ---------------------------------------------------------------- 术语校正 */

test('applyTermMap: 确定性替换，并统计次数', () => {
  const { segments, replaced, touched } = applyTermMap([
    { from: 0, to: 1, text: '这个绘插很明显，绘插也是' },
    { from: 1, to: 2, text: '无关的一句' },
  ], { 绘插: '彗差' });
  assert.equal(replaced, 2);
  assert.equal(touched, 1);
  assert.equal(segments[0].text, '这个彗差很明显，彗差也是');
  assert.equal(segments[1].text, '无关的一句');
});

test('applyTermMap: 长词优先（像散 vs 像）', () => {
  const { segments } = applyTermMap([{ from: 0, to: 1, text: '球差彗差像散' }],
    { 像: 'X', 像散: '像散(AST)' });
  assert.equal(segments[0].text, '球差彗差像散(AST)');
});

test('applyTermMap: 空词典 / 空输入不炸', () => {
  assert.deepEqual(applyTermMap([], {}), { segments: [], replaced: 0, touched: 0 });
  assert.deepEqual(applyTermMap(undefined, undefined), { segments: [], replaced: 0, touched: 0 });
});

test('resolveAsrConfig: 读取 asr.json 里的 terms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  await writeFile(join(dir, 'asr.json'), JSON.stringify({
    baseUrl: 'http://127.0.0.1:8000/v1', key: 'k', terms: { 苍野: '沧野' },
  }));
  try {
    const cfg = resolveAsrConfig({ DSH_HOME: dir });
    assert.deepEqual(cfg.terms, { 苍野: '沧野' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
