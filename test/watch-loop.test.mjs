/**
 * watch-loop.test.mjs — 循环的起停与守卫。
 *
 * 这里不测"到点说话"（那要真宿主），只测**边界**：
 * 没有会话 id 就绝不起循环、重复起会先停旧的、stop 是幂等的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

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
