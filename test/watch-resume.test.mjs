/**
 * watch-resume.test.mjs — 重复调用不能把正在跑的陪看"重开"。
 *
 * 真机症状：DSH 说"下一段 03:00–05:00"，实际调度是 03:00–06:00；再调一次工具，
 * 正在等的段被新表重切、原时间点消失，用户等了五分钟没等到。
 * 根因：每次 startWatchLoop 都 stopWatchLoop('restart')，spoken 和 segments 全部重置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';

const ok = { sessionController: { prompt: async () => {} } };
const base = {
  ctx: ok, sessionId: 's1', input: 'same.mp4', segment: 300, ramp: [60, 120, 180, 240], depth: 2,
  deps: {
    probe: async () => ({ ok: true, sessions: [] }),
    wake: async () => ({ ok: true }),
    now: () => Date.now(),
    ticker: () => ({ dispose() {} }),
    loadLatency: async () => ({ ms: 0, samples: 5 }),
  },
  log: () => {},
};

test('同源同表再调一次 → 续跑，不重置', () => {
  stopWatchLoop('test-init');
  const a = startWatchLoop({ ...base, cursor: 30 });
  assert.equal(a.ok, true);
  const before = loopStatus();

  const b = startWatchLoop({ ...base, cursor: 62 });
  assert.equal(b.resumed, true, '应走续跑分支');
  const after = loopStatus();
  assert.equal(after.segments, before.segments, '段不该被重排');
  assert.equal(after.spoken, before.spoken, '已说过的不该被清空');
  assert.match(after.log.join('\n'), /resumed/, '日志里要留痕');
  stopWatchLoop('done');
});

test('换了批次表 → 重开（这是有意的：新节奏要重新排）', () => {
  stopWatchLoop('t');
  startWatchLoop({ ...base, cursor: 30 });
  const b = startWatchLoop({ ...base, ramp: [], segment: 60 });
  assert.equal(b.resumed, undefined, '换表不该续跑');
  assert.match(loopStatus().batchPlan, /^1m$/, '新表生效');
  stopWatchLoop('done');
});

test('叫不醒要能查出来：reason=wake-failed，且记下原因', async () => {
  stopWatchLoop('t');
  const deps = {
    ...base.deps,
    // 位置直接越过第一个到期点
    probe: async () => ({ ok: true, sessions: [
      { app: 'x', status: 4, pos: 50, dur: 600, title: 'same.mp4', updated: Date.now() },
    ] }),
    wake: async () => ({ ok: false, reason: 'no-session-controller' }),
  };
  let tick = null;
  startWatchLoop({
    ...base, cursor: 50,
    deps: { ...deps, ticker: ({ tick: t }) => { tick = t; return { dispose() {} }; } },
  });
  await tick();
  const st = loopStatus();
  assert.equal(st.wakeFails, 1, '失败次数要计数');
  assert.equal(st.lastWake.ok, false);
  assert.equal(st.lastWake.reason, 'no-session-controller');
  assert.equal(st.reason, 'wake-failed', '状态要能一眼看出是唤醒失败，而不是 not-due');
  assert.match(st.log.join('\n'), /wake .* no-session-controller/);
  stopWatchLoop('done');
});
