#!/usr/bin/env node
/**
 * watch-e2e.mjs — 真文件、真解码、真转写，把整条链路跑一遍（不需要 DSH、不需要播放器）。
 *
 * 假的部分只有两样：
 *   - **时钟/播放头**：用 `--speed` 倍速推进，所以 8 分钟的片子 80 秒跑完
 *   - **叫醒之后的事**：真的没有会话可推，所以这里"扮演"那个 agent ——
 *     收到叫醒就调 `runWatchPass` 真的出图，然后打印它本来会说的话头
 *
 * 真的部分：SMTC 之外的整条流水线（解码 → 切点 → 分镜 → 转写 → 清单 → PNG）。
 *
 * 用法：
 *   node scripts/watch-e2e.mjs --input "D:/Movie/xx.mp4" --from 0 --minutes 8 --speed 6
 *   node scripts/watch-e2e.mjs --input "D:/Movie/xx.mp4" --from 0 --segment 120 --lead 15
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatManifest, runStoryboard } from '../src/pipeline.js';
import { makeBuilder, runWatchPass } from '../src/watch-run.js';
import { startWatchLoop, loopStatus, stopWatchLoop } from '../src/watch-loop.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const input = args.input;
if (!input) {
  console.error('用法: node scripts/watch-e2e.mjs --input <视频> [--from 0] [--minutes 8] [--speed 6] [--segment 120] [--lead 15]');
  process.exit(2);
}

const from = Number(args.from ?? 0);
const segment = Number(args.segment ?? 120);
const lead = Number(args.lead ?? 15);
const speed = Number(args.speed ?? 8);
const minutes = Number(args.minutes ?? 8);

const fmt = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.round(Math.max(0, s) % 60)).padStart(2, '0')}`;
const t0 = Date.now();
/** 假的播放头：真实时间 × 倍速 */
const playhead = () => from + ((Date.now() - t0) / 1000) * speed;

const segments = Array.from({ length: Math.ceil(minutes * 60 / segment) + 1 }, (_, i) => {
  const s = Math.floor(from / segment) * segment + i * segment;
  return { from: s, to: s + segment, sayAt: s + segment - lead };
});

const events = [];
const cache = new Map();
const inflight = new Set();     // 叫醒引发的"出图"可能比看片预算更久，收尾要等它

console.log(`[e2e] 源 ${input}`);
console.log(`[e2e] 从 ${fmt(from)} 起看 ${minutes} 分钟，${speed}× 倍速（墙钟约 ${Math.round(minutes * 60 / speed)}s）`);
console.log(`[e2e] 段长 ${segment}s，提前 ${lead}s 说\n`);

const deps = {
  // 播放头就是假的：每次返回"刚刚刷新过"的快照
  probe: async () => ({
    ok: true,
    sessions: [{
      app: 'fake-player', status: 4, pos: playhead(),
      dur: from + minutes * 60 + 600, title: input, updated: Date.now(),
    }],
  }),
  now: () => Date.now(),
  // 倍速跑的时候要读得勤：否则一段 120 秒会在两次采样之间被整段跳过
  probeEveryMs: Math.max(500, Math.round(2000 / Math.max(1, speed / 4))),
  loadLatency: async () => ({ ms: 0, samples: 5, at: 0 }),
  // 叫醒 → 扮演 agent：真的去出图
  wake: async (_ctx, { text }) => {
    const t = Date.now();
    const p = (async () => {
    console.log(`\n[e2e] ${fmt(playhead())} 叫醒 → ${text.split('\n')[0].slice(0, 60)}…`);
    const r = await runWatchPass({ input, cursor: playhead(), segment, lead }, {
      cache: watchCache, runStoryboard, formatManifest,
      saveImage: async ({ data, name }) => { await writeFile(join('.tmp', name), data); return name; },
    });
    const cost = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`[e2e] ${fmt(playhead())} 出图完成（${cost}s），本该说的话头：`);
    const line = r.text.split('\n').find((l) => l.startsWith('watch '));
    console.log(`       ${line ?? r.text.split('\n')[0]}`);
    const cell = r.text.split('\n').find((l) => l.startsWith('cell '));
    if (cell) console.log(`       ${cell.slice(0, 100)}`);
    events.push({ at: playhead(), cost: +cost, spoke: r.ok });
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    await p;
    return { ok: true };
  },
};

const watchCache = new Map();
const build = makeBuilder({
  input, args: { segment }, runStoryboard, formatManifest, cache: watchCache,
});
startWatchLoop({
  ctx: { sessionController: { prompt: async () => {} }, _fake: true },
  sessionId: 'e2e', input, segments, size: segment,
  // 余量按时间（默认 5 分钟）——和线上一致；要固定段数就显式传 --depth
  lookahead: Number(args.lookahead ?? 300),
  depth: args.depth === undefined ? null : Number(args.depth),
  deps: { ...deps, build }, log: (m) => console.log(`[loop] ${m}`),
});

// 等到预算时间用完
const budgetMs = (minutes * 60 / speed) * 1000;
await new Promise((r) => setTimeout(r, budgetMs + 2000));
stopWatchLoop('e2e-done');
// 等还在出图的那些跑完，否则统计会漏
if (inflight.size) {
  console.log(`[e2e] 等待 ${inflight.size} 个进行中的出图…`);
  await Promise.allSettled([...inflight]);
}

console.log('\n[e2e] 结果');
console.log(`  叫醒 ${events.length} 次：${events.map((e) => `${fmt(e.at)}(${e.cost}s)`).join(', ') || '—'}`);
console.log(`  最终状态：${loopStatus().reason}`);
const expected = Math.floor((minutes * 60 - lead) / segment) + 1;
console.log(`  预期约 ${expected} 次（每段 ${segment}s，提前 ${lead}s）`);
process.exit(events.length >= Math.max(1, expected - 1) ? 0 : 1);
