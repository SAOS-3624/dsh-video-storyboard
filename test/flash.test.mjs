import assert from 'node:assert/strict';
import test from 'node:test';

import { flashEvidence, tagCuts, NV_MAX, PULSE_MIN, CORR_MIN } from '../src/storyboard/flash.js';
import { FP_W, FP_H } from '../src/storyboard/scan.js';

const N = FP_W * FP_H;

/** 固定种子的基准纹理（16×9，值 60–180） */
function baseTexture() {
  const a = new Uint8Array(N);
  let s = 12345;
  for (let i = 0; i < N; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = 60 + Math.floor((s / 4294967296) * 120);
  }
  return a;
}

/**
 * 造一段逐帧数据。
 * @param {{flashAt?:number, flashLen?:number, flashDelta?:number, cutAt?:number, frames?:number}} o
 */
function build({ flashAt = -1, flashLen = 2, flashDelta = 60, cutAt = -1, frames = 40 } = {}) {
  const A = baseTexture();
  const B = baseTexture().map((v) => 255 - v);   // 结构完全不同
  const prints = [];
  const means = [];
  for (let i = 0; i < frames; i++) {
    let src = cutAt >= 0 && i >= cutAt ? B : A;
    let v = src;
    if (flashAt >= 0 && i >= flashAt && i < flashAt + flashLen) {
      v = src.map((x) => Math.min(255, x + flashDelta));
    }
    prints.push(Uint8Array.from(v));
    means.push(v.reduce((a, b) => a + b, 0) / N);
  }
  return { prints, means };
}

test('flash: 亮度脉冲（闪电）判成 flash，且三条判据都成立', () => {
  const { prints, means } = build({ flashAt: 20, flashLen: 3, flashDelta: 60 });
  const ev = flashEvidence({ prints, means, t: 20 / 25, fps: 25 });
  assert.equal(ev.isFlash, true, `pulse=${ev.pulse} nv=${ev.nv} corr=${ev.corr}`);
  assert.ok(ev.pulse > PULSE_MIN, 'pulse 应该超过下限');
  assert.ok(ev.nv < NV_MAX, 'nv 应该低于上限（回到原样）');
  assert.ok(ev.corr > CORR_MIN, 'corr 应该高于下限（结构没变）');
});

test('flash: 真快切不判 flash（画面换了，nv 大）', () => {
  const { prints, means } = build({ cutAt: 20 });
  const ev = flashEvidence({ prints, means, t: 20 / 25, fps: 25 });
  assert.equal(ev.isFlash, false);
  assert.ok(ev.nv >= NV_MAX, `真快切的 nv 应该大，实得 ${ev.nv}`);
});

test('flash: 整体提亮但结构不变 → corr 接近 1（对亮度免疫）', () => {
  const { prints, means } = build({ flashAt: 20, flashLen: 3, flashDelta: 90 });
  const ev = flashEvidence({ prints, means, t: 20 / 25, fps: 25 });
  assert.ok(ev.corr > 0.99, `整帧提亮后结构应该几乎一致，实得 ${ev.corr}`);
});

test('flash: 白闪**转场**不该被判 flash（闪完画面换了）', () => {
  // 帧 20 全白，之后切到 B
  const A = baseTexture();
  const B = baseTexture().map((v) => 255 - v);
  const prints = [];
  const means = [];
  for (let i = 0; i < 40; i++) {
    let v = i < 20 ? A : B;
    if (i === 20) v = new Uint8Array(N).fill(255);
    prints.push(Uint8Array.from(v));
    means.push(v.reduce((a, b) => a + b, 0) / N);
  }
  const ev = flashEvidence({ prints, means, t: 20 / 25, fps: 25 });
  assert.equal(ev.isFlash, false, '白闪转场画面换了，nv 应该大');
  assert.ok(ev.nv > 10, `实得 nv=${ev.nv}`);
});

test('tagCuts: 一个切点都不删，只补类型', () => {
  const { prints, means } = build({ flashAt: 20, flashLen: 3, cutAt: 30 });
  const cuts = [{ t: 20 / 25 }, { t: 30 / 25 }];
  const tagged = tagCuts(cuts, { prints, means, fps: 25 });
  assert.equal(tagged.length, cuts.length, '长度必须不变');
  assert.equal(tagged[0].type, 'flash', '第一刀是闪白');
  assert.notEqual(tagged[1].type, 'flash', '第二刀是真切');
  assert.ok(tagged.every((c) => 'evidence' in c), '每刀都要带证据');
});

test('tagCuts: 没有逐帧数据时安全退化成 null 标签', () => {
  const cuts = [{ t: 1 }, { t: 2 }];
  const tagged = tagCuts(cuts, {});
  assert.equal(tagged.length, 2);
  assert.deepEqual(tagged.map((c) => c.type), [null, null]);
});

test('flashEvidence: 没有任何帧数据时返回 null，不抛异常', () => {
  assert.equal(flashEvidence({ prints: [], means: [], t: 0, fps: 25 }), null);
});

test('flash: 闪烁紧邻真剪辑时，两刀各自拿到对的标签', () => {
  // 帧 10 闪、帧 20 真切、帧 25 闪 —— 因为只打标签不删点，不需要"附近有真切就放弃"的护栏
  const A = baseTexture();
  const B = baseTexture().map((v) => 255 - v);
  const prints = [];
  const means = [];
  for (let i = 0; i < 40; i++) {
    let v = i < 20 ? A : B;
    if (i >= 10 && i < 12) v = A.map((x) => Math.min(255, x + 70));
    if (i >= 30 && i < 32) v = B.map((x) => Math.min(255, x + 70));
    prints.push(Uint8Array.from(v));
    means.push(v.reduce((a, b) => a + b, 0) / N);
  }
  // 闪光离真切 0.4s 以上（> 2δ），窗口才不会跨过真切点 —— 窗口本身的边界见方案 §10
  const tagged = tagCuts([{ t: 10 / 25 }, { t: 20 / 25 }, { t: 30 / 25 }], { prints, means, fps: 25 });
  assert.equal(tagged[1].type === 'flash', false, '真切那刀不该是 flash');
  assert.equal(tagged[0].type, 'flash', '闪的那刀应该是 flash');
  assert.equal(tagged[2].type, 'flash', '后面那刀也是 flash');
  assert.equal(tagged.length, 3, '一个都不许删');
});
