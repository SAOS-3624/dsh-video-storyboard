/**
 * audio-rhythm.test.mjs — 语音/音乐判别（不用响度，只看能量包络的节奏）。
 *
 * 起因：原来的判据是「mean LUFS > -18 且 话少」，两个量量的不是一回事。
 * 《记忆管理局》正式 PV 是纯音乐快剪、母带 -18.4，差 0.4 被当成"有字"，
 * 90 秒只出 9 个画面；同一作者的《概念 PV》(-14.2) 却有 33 个。
 *
 * 换成包络的调制频率之后（Scheirer & Slaney 那条线），10 支真实素材上
 * 说话类主导 1–2 Hz、配乐 3–4 Hz，跟母带电平无关。
 *
 * 这里用合成包络锁住行为，不依赖真实文件（CI 上没有素材）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rhythmProfile } from '../src/storyboard/audio.js';

const STEP = 1 / 25;

/** 造一条 dB 包络：基准 + 某个频率的正弦调制 */
function envelope(modHz, seconds = 20, depthDb = 8) {
  const n = Math.round(seconds / STEP);
  return {
    step: STEP,
    db: Array.from({ length: n }, (_, i) => -30 + depthDb * Math.sin(2 * Math.PI * modHz * i * STEP)),
  };
}

test('rhythmProfile: 4 Hz 调制被判成节拍型（音乐）', () => {
  const p = rhythmProfile(envelope(4));
  assert.ok(p.windows > 10, `窗数太少：${p.windows}`);
  assert.ok(Math.abs(p.peakHz - 4) <= 0.5, `主导频率应落在 4 Hz 附近，实际 ${p.peakHz}`);
  assert.ok(p.rhythmRatio >= 1.15, `节拍比应 ≥1.15，实际 ${p.rhythmRatio}`);
});

test('rhythmProfile: 1 Hz 调制被判成短语型（说话）', () => {
  const p = rhythmProfile(envelope(1));
  assert.ok(p.peakHz <= 1.5, `主导频率应 ≤1.5 Hz，实际 ${p.peakHz}`);
  assert.ok(p.rhythmRatio < 1.15, `节拍比应 <1.15，实际 ${p.rhythmRatio}`);
});

test('rhythmProfile: 深慢起伏（配乐段落感）不会被当成说话', () => {
  // 2 Hz 的强调制是"慢速节拍"，不该被算成短语型，但也不能算节拍型 ——
  // 这里只锁一件事：它必须落在阈值下方（保守），因为它离人声的重音节奏很远。
  const p = rhythmProfile(envelope(2, 20, 12));
  assert.ok(p.peakHz <= 2.5, `2 Hz 不该越过 2.5，实际 ${p.peakHz}`);
});

test('rhythmProfile: 大半是静音的窗口不参与', () => {
  // 前 10 秒 4 Hz 调制、后 10 秒全是 -120：只有前 10 秒的窗算数
  const loudN = Math.round(10 / STEP);
  const db = [
    ...Array.from({ length: loudN }, (_, i) => -30 + 8 * Math.sin(2 * Math.PI * 4 * i * STEP)),
    ...new Array(loudN).fill(-120),
  ];
  const p = rhythmProfile({ db, step: STEP });
  assert.ok(p.windows >= 8 && p.windows <= 12, `应只统计有声的前半段，实际 ${p.windows} 窗`);
  assert.ok(p.peakHz >= 3.5, `静音窗不该把峰值拉低，实际 ${p.peakHz}`);
});

test('rhythmProfile: 素材太短时给 NaN，不抛', () => {
  const p = rhythmProfile({ db: [-30, -31, -29], step: STEP });
  assert.ok(Number.isNaN(p.peakHz));
  assert.equal(p.windows, 0);
  const empty = rhythmProfile(null);
  assert.ok(Number.isNaN(empty.peakHz));
});
