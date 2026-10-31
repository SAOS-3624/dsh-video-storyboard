import test from 'node:test';
import assert from 'node:assert/strict';

import { cliOcr, manifestFromCli, runOptionsFromCli } from '../src/storyboard/cli-options.js';

const baseOpt = {
  detail: 'med',
  from: '10',
  to: '0',
  frames: '40',
  strategy: 'saver',
  threshold: 'auto',
  'scan-gap': '0',
  segment: '300',
  pick: 'mid',
  burn: 'index',
  transcript: 'auto',
  'transcript-file': 'subs.srt',
  'source-hash': true,
};
const geom = { budget: 640_000, maxCanvasSide: 800 };

test('CLI: --detail high 必须把 ocr=true 交给 runStoryboard（#44）', () => {
  const o = runOptionsFromCli({
    opt: { ...baseOpt, detail: 'high' },
    geom,
    input: 'video.mp4',
    fetchOptions: { cookies: 'cookies.txt' },
    textOnly: true,
  });
  assert.equal(o.ocr, true, '旧实现这里没有 ocr，pipeline 永远走 ocr=false');
  assert.equal(o.budget, 640_000);
  assert.equal(o.maxCanvasSide, 800);
  assert.equal(o.transcriptFile, 'subs.srt');
  assert.equal(o.sourceHash, true);
  assert.equal(o.from, 10);
  assert.equal(o.maxFrames, 40);
  assert.equal(o.strategy, 'saver');
  assert.equal(o.textOnly, true);
});

test('CLI: 默认 med 与 low 不自动开 OCR', () => {
  assert.equal(cliOcr({ ...baseOpt, detail: 'med' }), false);
  assert.equal(cliOcr({ ...baseOpt, detail: 'low' }), false);
  assert.equal(cliOcr({ ...baseOpt, detail: 'high' }), true);
});

test('CLI: manifest 保留 fixed=0 的 OCR 结果（正文仍可省 token）', () => {
  const r = {
    window: { from: 0, to: 10 },
    threshold: 'auto',
    summary: { frames: 1 },
    provenance: {},
    audio: { mean: -20, peak: -1, silences: [] },
    transcript: { source: 'asr' },
    plan: { frames: 4, sheets: 1, strategy: 'balanced' },
    ocr: { status: 'applied', fixed: 0, checked: 16, changes: [] },
    sheets: [{ sheet: 1, width: 100, height: 100, stripH: null, cells: [] }],
  };
  const m = manifestFromCli({ input: 'video.mp4', r });
  assert.equal(m.ocr.fixed, 0, '机器可读文件要能区分"跑过但 0 条"和"没跑"');
  assert.equal(m.audio.mean, -20);
  assert.equal(m.sheets[0].stripH, null);
});
