import test from 'node:test';
import assert from 'node:assert/strict';

import {
  averageHash, hamming64, noveltyFromHashes, attachFingerprints, parseHash, FP_BYTES,
} from '../src/fingerprints.js';
import { buildCandidates, scoreCandidates, selectWithCoverage } from '../src/candidates.js';

function rgbSolid(r, g, b) {
  const buf = Buffer.alloc(FP_BYTES);
  for (let i = 0; i < FP_BYTES; i += 3) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
  return buf;
}

function rgbHalf() {
  // 左半白右半黑 → 稳定非零哈希
  const buf = Buffer.alloc(FP_BYTES);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 3;
      const v = x < 4 ? 255 : 0;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  return buf;
}

test('averageHash: 纯色全等于均值 → 全 1；半区图案非平凡', () => {
  // 均匀画面每个像素 == mean，bit 全置 1（不是 0）
  assert.equal(averageHash(rgbSolid(128, 128, 128)), (1n << 64n) - 1n);
  assert.equal(averageHash(Buffer.alloc(0)), 0n);
  const half = averageHash(rgbHalf());
  assert.notEqual(half, 0n);
  assert.notEqual(half, (1n << 64n) - 1n);
});

test('hamming64 / noveltyFromHashes', () => {
  const a = averageHash(rgbHalf());
  const b = averageHash(rgbSolid(255, 255, 255));
  assert.ok(hamming64(a, b) > 0);
  assert.equal(noveltyFromHashes(a, []), 1);
  assert.ok(noveltyFromHashes(a, [a]) < 0.2);
  assert.ok(noveltyFromHashes(a, [b]) > 0.3);
});

test('attachFingerprints: 挂最近时刻的 hash', () => {
  const cands = [{ t: 1.0, sources: ['uniform'] }, { t: 5.0, sources: ['shot'] }];
  const fps = [
    { t: 10.0, hash: averageHash(rgbHalf()).toString(16).padStart(16, '0') },
    { t: 14.0, hash: 'ffffffffffffffff' },
  ];
  // 窗口起点 9 → 相对 1 / 5
  const out = attachFingerprints(cands, fps, 9);
  assert.ok(out[0].hash != null);
  assert.equal(out[1].hash, parseHash('ffffffffffffffff'));
});

test('selectWithCoverage: aHash 抑制近重复视觉', () => {
  const duration = 20;
  const candidates = buildCandidates({
    duration,
    cuts: [2, 4, 6, 8, 10, 12, 14, 16],
    uniformStep: 1,
  });
  const scored = scoreCandidates(candidates, { duration, cuts: [2, 4, 6, 8, 10, 12, 14, 16] });
  const same = averageHash(rgbHalf());
  const other = averageHash(rgbSolid(255, 255, 255));
  // 前半段候选全同一 hash，后半段不同
  for (const c of scored) {
    c.hash = c.t < 10 ? same : other;
  }
  const sel = selectWithCoverage(scored, { k: 6, duration, minTemporalGap: 0.4, coverageRatio: 0.4 });
  assert.equal(sel.length, 6);
  const late = sel.filter((s) => s.t >= 10);
  assert.ok(late.length >= 2, '视觉新颖性应把名额分给后半段');
});
