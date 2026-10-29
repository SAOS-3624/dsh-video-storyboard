#!/usr/bin/env node
/**
 * watch-sim.mjs — 不用 DSH、不用真片、不用真时钟，把陪看循环跑一遍看时间线。
 *
 * 为什么需要：真机验证要重启宿主、要真的看片、一次十几分钟。而"到点该不该说话"
 * 是纯逻辑，可以离线跑：把时钟、SMTC、会话推送换成假的就行。
 *
 *   node scripts/watch-sim.mjs                 # 跑全部场景
 *   node scripts/watch-sim.mjs frozen          # 只跑某一个
 *
 * 输出的每一行都是一次真实判定：说了 / 没说（为什么）。
 */

import { LOOP_LIMITS, loopStatus, startWatchLoop, stopWatchLoop } from '../src/watch-loop.js';
import { createSim } from '../test/helpers/sim.mjs';

const SEG = 120;
const segments = (n = 6) => Array.from({ length: n }, (_, i) => ({ from: i * SEG, to: (i + 1) * SEG }));

const SCENARIOS = {
  // Edge 每 30 秒刷新：最理想的情况
  steady: { label: '每 30 秒刷新（理想）', opts: { refreshEveryMs: 30_000 }, until: 200 },
  // 真机实测：两次刷新隔过 143 s / 216 s
  sparse: { label: '每 150 秒刷新（Edge 真实）', opts: { refreshEveryMs: 150_000 }, until: 260 },
  // 用户中途暂停 —— 暂停时不该说话，也不该问"读不到"
  paused: { label: '60–120 秒暂停', opts: { refreshEveryMs: 30_000, paused: [{ from: 60, to: 120 }] }, until: 260 },
  // 换片
  switched: { label: '第 50 秒换片', opts: { refreshEveryMs: 30_000, changes: [{ at: 50, title: 'B', duration: 1087 }] }, until: 80 },
  // 时间轴彻底冻结
  frozen: { label: '时间轴冻结（从不刷新）', opts: { refreshEveryMs: 10 ** 9 }, until: 820 },
};

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function run(name) {
  const { label, opts, until } = SCENARIOS[name];
  const sim = createSim({ duration: 1016, title: 'A', ...opts });
  const log = [];

  startWatchLoop({
    ctx: { sessionController: { prompt: async () => {} } },
    sessionId: 'sim', input: 'A', segments: segments(),
    deps: sim.deps,
    log: (m) => log.push(m),
  });

  const marks = [];
  let lastReason = '';
  await sim.runTo(until, {
    onTick: (sec) => {
      const st = loopStatus();
      if (st.reason !== lastReason) {
        marks.push(`  ${fmt(sec)}  → ${st.reason}${st.pos !== null ? ` @ ${fmt(st.pos)} (${st.confidence})` : ''}`);
        lastReason = st.reason;
      }
    },
  });

  console.log(`\n【${label}】`);
  const order = ['fresh', 'extrapolated', 'unknown', 'paused', 'none'];
  const spoken = sim.wakes.filter((w) => !w.text.includes('读不到'));
  const asked = sim.wakes.filter((w) => w.text.includes('读不到'));
  console.log(`  说话 ${spoken.length} 次${spoken.length ? '：' + spoken.map((w) => fmt(w.at / 1000)).join(', ') : ''}`);
  console.log(`  求助 ${asked.length} 次${asked.length ? '：' + asked.map((w) => fmt(w.at / 1000)).join(', ') : ''}`);
  // **先取状态再停**：stopWatchLoop 会把 reason 改成 'sim-end'，覆盖掉真正的原因
  const finalStatus = loopStatus();
  console.log(`  结束状态：${finalStatus.reason}（active=${finalStatus.active}）`);
  if (process.env.SIM_VERBOSE) console.log(marks.join('\n'));
  stopWatchLoop('sim-end');
  return { spoken: spoken.length, asked: asked.length, status: finalStatus.reason };
}

const only = process.argv[2];
const names = only ? [only] : Object.keys(SCENARIOS);
console.log(`陪看循环仿真（tick ${LOOP_LIMITS.TICK_MS} ms，读进度 ${LOOP_LIMITS.PROBE_EVERY_MS} ms，`
  + `外推上限 ${LOOP_LIMITS.MAX_EXTRAPOLATE_MS / 1000}s）`);

let bad = 0;
for (const n of names) {
  if (!SCENARIOS[n]) { console.error(`没有这个场景：${n}`); process.exit(2); }
  const r = await run(n);
  if (n === 'steady' && r.spoken !== 1) bad += 1;
  if (n === 'paused' && (r.spoken !== 1 || r.asked !== 0)) bad += 1;
  if (n === 'switched' && !/video-changed/.test(r.status)) bad += 1;
  if (n === 'frozen' && (r.asked < 1 || r.status !== 'position-unreadable')) bad += 1;
}
console.log(bad === 0 ? '\n全部场景符合预期。' : `\n${bad} 个场景不符合预期。`);
process.exit(bad === 0 ? 0 : 1);
