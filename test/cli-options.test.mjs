import test from 'node:test';
import assert from 'node:assert/strict';

import { cliOcr, manifestFromCli, runOptionsFromCli } from '../src/storyboard/cli-options.js';

const baseOpt = {
  detail: 'med',
  from: '10',
  to: '0',
  cells: '6',
  sheets: '0',
  threshold: 'auto',
  'min-gap': '1.2',
  segment: '300',
  pick: 'sharp',
  burn: 'index',
  badge: '0',
  transcript: 'auto',
  'transcript-file': 'subs.srt',
  'source-hash': true,
};
const geom = { budget: 1_200_000, maxPerSheet: 9, need: 'scene' };

test('CLI: --detail high 必须把 ocr=true 交给 runStoryboard（#44）', () => {
  const o = runOptionsFromCli({
    opt: { ...baseOpt, detail: 'high' },
    geom,
    input: 'video.mp4',
    fetchOptions: { cookies: 'cookies.txt' },
    adaptive: false,
    textOnly: true,
    tileFirst: true,
  });
  assert.equal(o.ocr, true, '旧实现这里没有 ocr，pipeline 永远走 ocr=false');
  assert.equal(o.badgeRatio, 0, '--badge 0 不能被默认值吃掉');
  assert.equal(o.budget, 1_200_000);
  assert.equal(o.maxPerSheet, 9);
  assert.equal(o.need, 'scene');
  assert.equal(o.transcriptFile, 'subs.srt');
  assert.equal(o.sourceHash, true);
  assert.equal(o.from, 10);
  assert.equal(o.tileFirst, true);
  assert.equal(o.adaptive, false);
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
    plan: { cells: 4, sheets: 1 },
    ocr: { status: 'applied', fixed: 0, checked: 16, changes: [] },
    sheets: [{ sheet: 1, cols: 2, rows: 2, width: 100, height: 100, stripH: null, cells: [] }],
  };
  const m = manifestFromCli({ input: 'video.mp4', r });
  assert.equal(m.ocr.fixed, 0, '机器可读文件要能区分“跑过但 0 条”和“没跑”');
  assert.equal(m.audio.mean, -20);
  assert.equal(m.sheets[0].stripH, null);
});
