/**
 * watch-scenarios.test.mjs — 用仿真跑整条循环（不需要 DSH、不需要真时钟）。
 *
 * 每个场景都是真机上出现过的情况：
 *   ① Edge 每 30 秒刷新    → 应该正常说话
 *   ② Edge 每 150 秒刷新   → 也就是说得话，但会更晚一点
 *   ③ 用户中途暂停          → 暂停期间不该说
 *   ④ 换片                 → 循环自己停
 *   ⑤ 时间轴彻底冻结        → 不说，先问一次，最后停表
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { createSim } from './helpers/sim.mjs';

const SEGMENTS = [
  { from: 0, to: 120 }, { from: 120, to: 240 }, { from: 240, to: 360 },
];
const ctxStub = { sessionController: { prompt: async () => {} } };

const boot = (sim) => {
  startWatchLoop({
    ctx: ctxStub, sessionId: 's1', input: 'A', segments: SEGMENTS, deps: sim.deps, log: () => {},
  });
};

test('① 每 30 秒刷新：第 1 段在段末前说话', async () => {
  const sim = createSim({ refreshEveryMs: 30_000 });
  boot(sim);
  await sim.runTo(115);
  assert.equal(sim.wakes.length, 1, `应在 1:45 说一次，实得 ${sim.wakes.length}`);
  assert.match(sim.wakes[0].text, /00:00–02:00/);
  stopWatchLoop('test');
});

test('① 同一段不重复说', async () => {
  const sim = createSim({ refreshEveryMs: 30_000 });
  boot(sim);
  await sim.runTo(118);          // 仍在第 1 段内
  const n = sim.wakes.length;
  assert.equal(n, 1);
  stopWatchLoop('test');
});

test('② 每 150 秒刷新（Edge 真实间隔）：仍会说，只是晚一点', async () => {
  const sim = createSim({ refreshEveryMs: 150_000 });
  boot(sim);
  await sim.runTo(130);
  assert.equal(sim.wakes.length, 1, '外推也要能说，否则就等于永远读不到');
  // 外推需要越过安全余量，所以晚于 1:45
  const spokeAt = sim.wakes[0].at / 1000;
  assert.ok(spokeAt >= 105 && spokeAt <= 125, `应在 105–125 秒之间说，实得 ${spokeAt}`);
  stopWatchLoop('test');
});

test('③ 用户在 60–120 秒暂停：暂停期间不说，也不打扰', async () => {
  const sim = createSim({ refreshEveryMs: 30_000, paused: [{ from: 60, to: 120 }] });
  boot(sim);
  await sim.runTo(110);
  assert.equal(sim.wakes.length, 0, '暂停时既不该说话，也不该问"读不到进度"');
  await sim.runTo(175);          // 恢复后继续看到 115 秒内容
  assert.equal(sim.wakes.length, 1, '恢复后该补上');
  stopWatchLoop('test');
});

test('④ 换片：循环自己停，不拿旧时间轴继续报', async () => {
  const sim = createSim({ refreshEveryMs: 30_000, changes: [{ at: 50, title: 'B', duration: 1087 }] });
  boot(sim);
  await sim.runTo(60);
  assert.equal(loopStatus().active, false);
  assert.match(loopStatus().reason, /video-changed/);
});

test('⑤ 时间轴冻结：前 3 分钟还能靠外推，之后不再猜、先问一次，最后停表', async () => {
  // 永远不刷新：模拟"155 秒甚至更久没有更新"的病态情况
  const sim = createSim({ refreshEveryMs: 10 ** 9 });
  boot(sim);
  await sim.runTo(60);
  assert.equal(sim.wakes.length, 0, '刚起播、还没到边界，不该说话');

  await sim.runTo(200);
  assert.equal(sim.wakes.length, 1, '前 3 分钟内按外推正常工作（这段确实该说话）');

  await sim.runTo(260);
  const asked = sim.wakes.filter((w) => /读不到你的播放进度/.test(w.text));
  assert.equal(asked.length, 1, `超过外推上限后应主动问一次，实得 ${asked.length}`);

  await sim.runTo(820);
  assert.equal(loopStatus().active, false, '长时间读不到就停表，不空转');
  assert.match(loopStatus().reason, /position-unreadable/);
});

test('⑥ 窗口自己往前滚：不靠外部再调一次工具', async () => {
  // 只给 2 段（240 秒），lookahead 300 → 循环应自己补出第 3、4 段
  const sim = createSim({ refreshEveryMs: 30_000, duration: 900 });
  startWatchLoop({
    ctx: ctxStub, sessionId: 's1', input: 'A',
    segments: [{ from: 0, to: 120 }, { from: 120, to: 240 }],
    size: 120, lookahead: 300, deps: sim.deps, log: () => {},
  });
  const first = loopStatus().segments;
  await sim.runTo(400);
  assert.ok(loopStatus().segments > first, `窗口应随进度增长（起始 ${first}）`);
  assert.ok(sim.wakes.length >= 3, `应说至少 3 次，实得 ${sim.wakes.length}`);
  stopWatchLoop('test');
});

test('⑦ 窗口不会无限长（跟着 lookahead 走）', async () => {
  const sim = createSim({ refreshEveryMs: 30_000, duration: 900 });
  startWatchLoop({
    ctx: ctxStub, sessionId: 's1', input: 'A',
    segments: [{ from: 0, to: 120 }],
    size: 120, lookahead: 300, deps: sim.deps, log: () => {},
  });
  await sim.runTo(600);
  const n = loopStatus().segments;
  // 10 分钟 / 2 分钟一段 = 5 段，加 lookahead 3 段 → 最多约 8 段
  assert.ok(n <= 10, `不该排到整片，实得 ${n} 段`);
  stopWatchLoop('test');
});

test('⑧ 双缓冲：当前批次还没用完，下一个已经建好了', async () => {
  const built = [];
  const sim = createSim({ refreshEveryMs: 30_000, duration: 900 });
  startWatchLoop({
    ctx: ctxStub, sessionId: 's1', input: 'A',
    segments: [{ from: 0, to: 120 }, { from: 120, to: 240 }],
    size: 120, depth: 2,
    deps: {
      ...sim.deps,
      build: async (from) => { built.push(from); },
    },
    log: () => {},
  });
  // 看到 100 秒：第 0 段还在看，第 120 段应该已经建好了
  await sim.runTo(100);
  assert.ok(built.includes(120), `第 2 段应在第 1 段结束前建好，实际建了 ${built.join(',') || '无'}`);
  assert.ok(!built.includes(240), '第 3 段这时还不该建（只保留 2 个批次）');
  stopWatchLoop('test');
});

test('⑨ 换批次后立刻开始建再下一个（永远留一个余量）', async () => {
  const built = [];
  const sim = createSim({ refreshEveryMs: 30_000, duration: 1200 });
  startWatchLoop({
    ctx: ctxStub, sessionId: 's1', input: 'A',
    segments: [{ from: 0, to: 120 }, { from: 120, to: 240 }],
    size: 120, depth: 2,
    deps: { ...sim.deps, build: async (from) => { built.push(from); } },
    log: () => {},
  });
  await sim.runTo(150);          // 已经进入第 2 段
  assert.ok(built.includes(240), `应已开始建第 3 段，实际 ${built.join(',')}`);
  stopWatchLoop('test');
});
