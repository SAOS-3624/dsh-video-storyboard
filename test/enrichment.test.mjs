import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  attachSpeakers,
  enrichTranscriptEmotions,
  mergeShotCuts,
  parseSenseVoiceTags,
  resolveEnrichmentConfig,
  detectShotsRemote,
} from '../src/enrichment/index.js';

test('parseSenseVoiceTags: 剥离标签并识别情绪/事件', () => {
  const p = parseSenseVoiceTags('<|zh|><|HAPPY|><|Speech|>你好世界');
  assert.equal(p.cleanText, '你好世界');
  assert.equal(p.emotion, 'HAPPY');
  assert.ok(p.event);
  assert.ok(p.tags.includes('HAPPY'));
});

test('enrichTranscriptEmotions: 批量清洗', () => {
  const { segments, tagged } = enrichTranscriptEmotions([
    { from: 0, to: 1, text: '<|SAD|>唉' },
    { from: 1, to: 2, text: '普通句' },
  ]);
  assert.equal(tagged, 1);
  assert.equal(segments[0].emotion, 'SAD');
  assert.equal(segments[0].text, '唉');
  assert.equal(segments[1].text, '普通句');
});

test('mergeShotCuts: remote 近邻优先', () => {
  const merged = mergeShotCuts(
    [{ t: 10.0, score: 0.5 }, { t: 20.0, score: 0.4 }],
    [{ t: 10.1, score: 0.9, kind: 'dissolve' }, { t: 30.0, score: 0.8, kind: 'cut' }],
    { minGap: 0.35 },
  );
  assert.equal(merged.length, 3);
  assert.equal(merged[0].kind, 'dissolve');
  assert.ok(Math.abs(merged[0].t - 10.1) < 0.01);
});

test('attachSpeakers: 按中点贴标签', () => {
  const { segments, labeled } = attachSpeakers(
    [{ from: 0, to: 2, text: 'a' }, { from: 5, to: 7, text: 'b' }],
    [{ from: 0, to: 3, speaker: 'SPEAKER_00' }, { from: 4, to: 8, speaker: 'SPEAKER_01' }],
  );
  assert.equal(labeled, 2);
  assert.equal(segments[0].speaker, 'SPEAKER_00');
  assert.equal(segments[1].speaker, 'SPEAKER_01');
});

test('resolveEnrichmentConfig: 默认全关', () => {
  const cfg = resolveEnrichmentConfig({});
  assert.equal(cfg.shots.enable, false);
  assert.equal(cfg.diarization.enable, false);
  assert.equal(cfg.audioUnderstand.enable, false);
});

test('detectShotsRemote: 对接假 HTTP 服务', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/shots\/detect$/);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body);
      assert.equal(json.path, '/tmp/x.mp4');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'fake-transnet',
        cuts: [{ t: 1.5, score: 0.99, kind: 'cut' }, { t: 8.0, score: 0.7, kind: 'dissolve' }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const out = await detectShotsRemote({
      input: '/tmp/x.mp4', from: 0, to: 20,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      key: 'k',
    });
    assert.equal(out.model, 'fake-transnet');
    assert.equal(out.cuts.length, 2);
    assert.equal(out.cuts[1].kind, 'dissolve');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
