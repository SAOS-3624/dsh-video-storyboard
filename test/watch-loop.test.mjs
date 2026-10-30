/**
 * watch-loop.test.mjs — 循环的起停与守卫。
 *
 * 这里不测"到点说话"（那要真宿主），只测**边界**：
 * 没有会话 id 就绝不起循环、重复起会先停旧的、stop 是幂等的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { depthForBuffer, makePlan } from '../src/batches.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { onSpeech } from '../src/voice.js';

const segs = [{ from: 0, to: 120 }, { from: 120, to: 240 }];
const ctxStub = { sessionController: { prompt: async () => {} } };

test('没有会话 id 就不起循环（退化成手动模式）', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: null, input: 'a.mp4', segments: segs });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-session-id');
  assert.equal(loopStatus().active, false);
});

test('没有段就不起循环', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-segments');
});

test('起了之后状态可读，stop 之后停住，且 stop 幂等', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: segs, cursor: 10 });
  assert.equal(r.ok, true);
  const st = loopStatus();
  assert.equal(st.active, true);
  assert.equal(st.segments, 2);
  assert.equal(st.session, 's1');

  stopWatchLoop('test');
  assert.equal(loopStatus().active, false);
  stopWatchLoop('again');       // 幂等：再停一次不该抛
  assert.equal(loopStatus().active, false);
});

test('重复起会先停旧的（同一时刻只允许一段陪看）', () => {
  startWatchLoop({ ctx: ctxStub, sessionId: 's1', input: 'a.mp4', segments: segs });
  const r2 = startWatchLoop({ ctx: ctxStub, sessionId: 's2', input: 'b.mp4', segments: segs });
  assert.equal(r2.ok, true);
  assert.equal(loopStatus().session, 's2');
  stopWatchLoop('cleanup');
});

test('余量按时间算：2 分钟一段时要备 4 段，不是 2 段', () => {
  // 这条守的是"别把两小时都排上"的另一面：也不能只排两段。
  const plan = makePlan({ segment: 120, ramp: [] });
  assert.equal(depthForBuffer(plan, 0, 300), 4, '120×3=360 才够 300 秒');
  assert.equal(depthForBuffer(plan, 7, 300), 4, '稳定档也一样，与位置无关');
});

test('余量按时间算：5 分钟一段时是 2 段（旧默认值在这里恰好等价）', () => {
  const plan = makePlan({ segment: 300, ramp: [60, 120, 180, 240] });
  assert.equal(depthForBuffer(plan, 3, 300), 2);
  assert.equal(depthForBuffer(plan, 9, 300), 2);
});

test('余量按时间算：开头 1/2/3 分钟的阶梯上要多备几段，凑满 5 分钟', () => {
  const plan = makePlan({ segment: 300, ramp: [60, 120, 180, 240] });
  // 第 0 段 60s：后面要 120+180 才到 300 → 当前段之外再备 2 段，也就是 depth 3
  assert.equal(depthForBuffer(plan, 0, 300), 3);
  assert.ok(depthForBuffer(plan, 0, 300) > 2, '固定两段在第 0 段只有 2 分钟余量');
});

test('余量按时间算：任何位置上，后面备好的时长都 ≥ lookahead', () => {
  const plan = makePlan({ segment: 300, ramp: [60, 120, 180, 240] });
  for (let i = 0; i < 20; i += 1) {
    const depth = depthForBuffer(plan, i, 300);
    let covered = 0;
    for (let k = 1; k < depth; k += 1) covered += plan.sizeAt(i + k);
    assert.ok(covered >= 300, `第 ${i} 段后面只有 ${covered}s，少于 300s`);
  }
});

test('lookahead: 0 表示只保当前段（不做余量）', () => {
  const plan = makePlan({ segment: 120, ramp: [] });
  assert.equal(depthForBuffer(plan, 0, 0), 1);
});

test('显式 depth 仍然按段数（旧口径），status 里能看到', () => {
  startWatchLoop({
    ctx: ctxStub, sessionId: 's-depth', input: 'd.mp4', segment: 60, ramp: [], depth: 2,
  });
  const st = loopStatus();
  assert.equal(st.depth, 2);
  assert.equal(st.bufferSec, 300);
  stopWatchLoop('cleanup');
});

test('不传 depth 时按时间算，status 报告 auto', () => {
  startWatchLoop({ ctx: ctxStub, sessionId: 's-auto', input: 'e.mp4', segment: 60, ramp: [] });
  const st = loopStatus();
  assert.equal(st.depth, 'auto');
  assert.equal(st.bufferSec, 300);
  stopWatchLoop('cleanup');
});

test('没有会话 id 但有声音订阅者：仍然起循环（台词交给订阅者念，不用叫醒谁）', () => {
  const off = onSpeech(() => {});
  try {
    const r = startWatchLoop({
      ctx: ctxStub, sessionId: null, input: 'voice.mp4', segment: 60, ramp: [],
    });
    assert.equal(r.ok, true, '有订阅者时不该被 sessionId 挡住');
    assert.equal(loopStatus().active, true);
    assert.equal(loopStatus().voice.listeners, 1);
  } finally {
    off();
    stopWatchLoop('cleanup');
  }
});

test('没有会话 id 又没有订阅者：照旧拒绝（没人可叫，也没人接声音）', () => {
  const r = startWatchLoop({ ctx: ctxStub, sessionId: null, input: 'x.mp4', segment: 60, ramp: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-session-id');
});
