/**
 * position.test.mjs — SMTC 稀疏时间轴的可信度模型。
 *
 * 这些数字来自真机对表（3 次快照，误差都 ≤1 秒）：
 *   17:42:44 pos=00:01.14 Playing   ← 之后 155 秒没有任何刷新
 *   18:02:56 pos=02:08.60 Playing   ← 用户屏幕 02:09
 *   18:05:51 pos=03:33.52 Paused    ← 用户屏幕 03:34
 *
 * 结论：**刷新落下来的值可信，错的是"刷新时刻到此刻"那一段**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EXTRAPOLATE_MS, estimate, makeAnchor, shouldSpeak, updateAnchor,
} from '../src/position.js';

const T0 = 1_700_000_000_000;   // 任意基准时刻

test('刚刷新过的位置直接信（fresh）', () => {
  const a = makeAnchor({ pos: 128.6, dur: 1087, status: 4, updated: T0 }, T0);
  const e = estimate(a, T0 + 3000);
  assert.equal(e.confidence, 'fresh');
  assert.ok(Math.abs(e.pos - 128.6) < 0.01, '不该外推，直接用刷新值');
});

test('在播但刷新旧了：按墙钟推（extrapolated）', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 4, updated: T0 }, T0);
  const e = estimate(a, T0 + 20_000);
  assert.equal(e.confidence, 'extrapolated');
  assert.ok(Math.abs(e.pos - 120) < 0.2, `应推成 120，实得 ${e.pos}`);
});

test('推太久就承认不知道（unknown），不硬推', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 4, updated: T0 }, T0);
  const e = estimate(a, T0 + MAX_EXTRAPOLATE_MS + 60_000);
  assert.equal(e.confidence, 'unknown');
  assert.equal(e.why, 'stale');
  assert.ok(e.pos <= 100 + MAX_EXTRAPOLATE_MS / 1000 + 0.01, '位置不能无限外推');
});

test('暂停：位置就是刷新值，且不会自己走', () => {
  const a = makeAnchor({ pos: 213.5, dur: 1087, status: 5, updated: T0 }, T0);
  const e = estimate(a, T0 + 60_000);
  assert.ok(Math.abs(e.pos - 213.5) < 0.01, '暂停一分钟位置都不该变');
  assert.equal(e.why, 'paused');
});

test('refresh 会带来真值，并算出我们外推错了多少（drift）', () => {
  const a1 = makeAnchor({ pos: 100, dur: 1087, status: 4, updated: T0 }, T0);
  // 我们以为过了 30 秒（外推到 130）
  // 但刷新说其实只有 112（用户中间暂停过）
  const { anchor, driftSec, refreshed, changedVideo } = updateAnchor(
    a1, { pos: 112, dur: 1087, status: 4, updated: T0 + 30_000 }, T0 + 30_000,
  );
  assert.equal(refreshed, true);
  assert.equal(changedVideo, false);
  assert.ok(driftSec < 0, `外推推快了应该得到负 drift，实得 ${driftSec}`);
  assert.ok(Math.abs(driftSec + 18) < 1, `drift 应约 -18，实得 ${driftSec}`);
  assert.equal(anchor.pos, 112);
});

test('换片检测：时长或标题变了就是换了片子', () => {
  const a = makeAnchor({ pos: 10, dur: 1016, status: 4, updated: T0, title: 'A' }, T0);
  const sameDur = updateAnchor(a, { pos: 10, dur: 1087, status: 4, updated: T0 + 1, title: 'A' }, T0 + 1);
  assert.equal(sameDur.changedVideo, true, '时长变了应判定换片');
  const sameTitle = updateAnchor(a, { pos: 10, dur: 1016, status: 4, updated: T0 + 1, title: 'B' }, T0 + 1);
  assert.equal(sameTitle.changedVideo, true, '标题变了应判定换片');
});

test('该说：新鲜时到点就说', () => {
  const a = makeAnchor({ pos: 110, dur: 1087, status: 4, updated: T0 }, T0);
  const r = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 2000, lead: 15 });
  assert.equal(r.speak, true);
  assert.equal(r.segment, 0);
});

test('该说：外推的必须越过安全余量才说（不抢话）', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 4, updated: T0 }, T0);
  // 刷新已过 12 秒（超出 FRESH_MS=10s，属于外推）→ 外推到 112，刚过 sayAt=105 但没越过 15 秒余量
  const near = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 12_000, lead: 15 });
  assert.equal(near.speak, false);
  assert.equal(near.reason, 'extrapolated-not-confirmed');
  // 外推到 125（超过 sayAt+15）
  const past = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 25_000, lead: 15 });
  assert.equal(past.speak, true);
});

test('该说：完全不知道就闭嘴', () => {
  const a = makeAnchor({ pos: 100, dur: 1087, status: 4, updated: T0 }, T0);
  const r = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0 + 10 * 60_000 });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'position-unknown');
});

test('该说：说过的段不重复，早就过去的不补', () => {
  const a = makeAnchor({ pos: 110, dur: 1087, status: 4, updated: T0 }, T0);
  assert.equal(shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], spoken: [0], now: T0 }).speak, false);

  const b = makeAnchor({ pos: 600, dur: 1087, status: 4, updated: T0 }, T0);
  assert.equal(shouldSpeak({ anchor: b, segments: [{ from: 0, to: 120 }], now: T0 }).speak, false);
});

test('提前量让判定往前挪（本机延迟补偿）', () => {
  const a = makeAnchor({ pos: 92, dur: 1087, status: 4, updated: T0 }, T0);
  const noAhead = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0, lead: 15, aheadSec: 0 });
  assert.equal(noAhead.speak, false, '92 秒还没到 105');
  const withAhead = shouldSpeak({ anchor: a, segments: [{ from: 0, to: 120 }], now: T0, lead: 15, aheadSec: 15 });
  assert.equal(withAhead.speak, true, '补 15 秒提前量后应该到了');
});
