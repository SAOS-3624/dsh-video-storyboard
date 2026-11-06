/**
 * offload.test.mjs — 「把老图省略掉」判断正确性（storyboard 版）。
 *
 * `src/storyboard/offload.js` 和 `dsh-see-now/src/offload.js` 是同一份逻辑的两份拷贝
 * （两个包独立发版，不能互相 import）。**这个测试文件也是镜像的** ——
 * 改一边的判断规则时，两边的用例都要跟着改，否则迟早有一天两边行为不一致。
 *
 * 重点盯「涨到触发线才动手」：`planOffloadWithTrigger` 如果一超留底数就触发，
 * 每出一张图都会改一次历史，前缀缓存每轮全废 —— 而这个**不会报任何错**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planOffload, planOffloadWithTrigger, applyOffload } from '../src/storyboard/offload.js';

const img = (id, bytes = 1024) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${String(id).padStart(64, '0')}`, bytes },
});

/** 造一条 user/message；`surfaceOp` 传 'append' 或 replace 对象 */
const msg = (seq, images, surfaceOp = 'append') => ({
  type: 'user/message',
  seq,
  data: { message: { role: 'user', content: images.map((v) => img(v)) } },
  surfaceOp,
});

/** 造 N 张、每条消息一张的连续历史 */
const chain = (n) => Array.from({ length: n }, (_, i) => msg(i + 1, [i + 1]));

// ---------------------------------------------------------------- planOffload（留几张）

test('保留最近 N 张：前面的被省略，后面的不动', () => {
  const plan = planOffload([msg(1, [1]), msg(2, [2]), msg(3, [3]), msg(4, [4])], { keep: 2 });
  assert.equal(plan.total, 4);
  assert.equal(plan.offloading, 2);
  assert.equal(plan.kept, 2);
  assert.deepEqual(plan.targets, [
    { seq: 1, imageIndexes: [0] },
    { seq: 2, imageIndexes: [0] },
  ]);
});

test('一条消息里多张图：按 seq 分组，index 递增', () => {
  const plan = planOffload([msg(1, [1, 2, 3]), msg(2, [4, 5])], { keep: 1 });
  assert.deepEqual(plan.targets, [
    { seq: 1, imageIndexes: [0, 1, 2] },
    { seq: 2, imageIndexes: [0] },
  ]);
  assert.equal(plan.kept, 1);
});

test('keep 大于总数：一张都不省', () => {
  const plan = planOffload([msg(1, [1]), msg(2, [2])], { keep: 100 });
  assert.equal(plan.offloading, 0);
  assert.deepEqual(plan.targets, []);
});

test('keep=0：能省的全省', () => {
  const plan = planOffload([msg(1, [1, 2]), msg(2, [3])], { keep: 0 });
  assert.equal(plan.offloading, 3);
  assert.equal(plan.kept, 0);
});

test('已经省略过的跳过，不会重复标记', () => {
  const events = [
    msg(1, [1]),
    msg(2, [2]),
    { type: 'image/offload', seq: 3, data: { targets: [{ seq: 1, imageIndexes: [0] }] } },
  ];
  const plan = planOffload(events, { keep: 1 });
  assert.equal(plan.total, 1); // seq1 已省，只剩 seq2
  assert.equal(plan.offloading, 0);
});

test('被 replace 遮蔽的图不算进历史', () => {
  const events = [
    msg(1, [1]),
    msg(2, [2]),
    msg(3, [], { op: 'replace', startSeq: 1, endSeq: 1 }),
    msg(4, [3]),
  ];
  const plan = planOffload(events, { keep: 1 });
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.targets, [{ seq: 2, imageIndexes: [0] }]);
});

test('tool/result 里的图也算（宿主允许这两种载体）', () => {
  const events = [
    { type: 'tool/result', seq: 1, data: { message: { role: 'tool', content: [img(1)] } }, surfaceOp: 'append' },
    msg(2, [2]),
  ];
  assert.deepEqual(planOffload(events, { keep: 1 }).targets, [{ seq: 1, imageIndexes: [0] }]);
});

test('非 surface 事件（compaction/*、turn/*）直接忽略', () => {
  const events = [
    { type: 'compaction/start', seq: 1, data: {} },
    msg(2, [1]),
    { type: 'turn/start', seq: 3, data: {} },
  ];
  const plan = planOffload(events, { keep: 0 });
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.targets, [{ seq: 2, imageIndexes: [0] }]);
});

test('字节统计：省掉的 / 留着的分别算', () => {
  const MB = 1024 * 1024;
  const events = [
    { ...msg(1, []), data: { message: { role: 'user', content: [img(1, 50 * MB)] } } },
    { ...msg(2, []), data: { message: { role: 'user', content: [img(2, 30 * MB)] } } },
  ];
  const plan = planOffload(events, { keep: 1 });
  assert.equal(plan.totalBytes, 80 * MB);
  assert.equal(plan.offloadingBytes, 50 * MB);
  assert.equal(plan.keptBytes, 30 * MB);
});

// ---------------------------------------------------------------- 触发线 / 留底

test('触发线以下不动手：299 张 / 触发 300 留 100 → 不触发', () => {
  const r = planOffloadWithTrigger(chain(299), { trigger: 300, keep: 100 });
  assert.equal(r.triggered, false);
});

test('刚超留底数（101 张）也不动手 —— 这是"别每次都重算"的核心', () => {
  for (const n of [100, 101, 150, 299]) {
    assert.equal(planOffloadWithTrigger(chain(n), { trigger: 300, keep: 100 }).triggered, false, `n=${n}`);
  }
});

test('涨到触发线才动手，一次省到留底：300 张 → 省 200 留 100', () => {
  const r = planOffloadWithTrigger(chain(300), { trigger: 300, keep: 100 });
  assert.equal(r.triggered, true);
  assert.equal(r.plan.offloading, 200);
  assert.equal(r.plan.kept, 100);
});

test('省完之后再攒 200 张才触发下一次（不会每张都触发）', () => {
  // 先造一次"已省略到只剩 100 张"的历史：100 张原样 + 一条把前 200 张省掉的记录
  const events = [
    ...chain(300),
    { type: 'image/offload', seq: 301, data: { targets: chain(300).slice(0, 200).map((m) => ({ seq: m.seq, imageIndexes: [0] })) } },
  ];
  // 现在 total = 100，再加 199 张仍不触发
  for (let extra = 0; extra <= 199; extra += 1) {
    const more = [...events, ...Array.from({ length: extra }, (_, i) => msg(400 + i, [400 + i]))];
    assert.equal(planOffloadWithTrigger(more, { trigger: 300, keep: 100 }).triggered, false, `extra=${extra}`);
  }
  // 加到 200 张（total = 300）才触发
  const full = [...events, ...Array.from({ length: 200 }, (_, i) => msg(400 + i, [400 + i]))];
  const r = planOffloadWithTrigger(full, { trigger: 300, keep: 100 });
  assert.equal(r.triggered, true);
  assert.equal(r.plan.offloading, 200);
});

test('trigger=0：关掉，永不触发', () => {
  assert.equal(planOffloadWithTrigger(chain(5000), { trigger: 0, keep: 100 }).triggered, false);
});

test('keep >= trigger：不触发（配置已在写入时夹住，这里兜一次）', () => {
  assert.equal(planOffloadWithTrigger(chain(500), { trigger: 100, keep: 100 }).triggered, false);
  assert.equal(planOffloadWithTrigger(chain(500), { trigger: 100, keep: 300 }).triggered, false);
});

// ---------------------------------------------------------------- applyOffload

test('applyOffload 没有 targets 时什么都不做（不写空事件）', async () => {
  const appended = [];
  const r = await applyOffload({ append: (t, d) => appended.push([t, d]) }, [], null);
  assert.equal(r.ok, true);
  assert.equal(appended.length, 0);
});

test('applyOffload 把事件写进去，并 flush', async () => {
  const appended = [];
  let flushed = 0;
  const r = await applyOffload(
    { append: (t, d) => appended.push([t, d]) },
    [{ seq: 1, imageIndexes: [0] }],
    { flush: async () => { flushed += 1; } },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(appended, [['image/offload', { targets: [{ seq: 1, imageIndexes: [0] }] }]]);
  assert.equal(flushed, 1);
});

test('applyOffload 的 append 抛错要变成 ok:false，不能炸穿调用方', async () => {
  const r = await applyOffload(
    { append: () => { throw new Error('target seq is not a current surface node'); } },
    [{ seq: 1, imageIndexes: [0] }],
    null,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /surface node/);
});

test('flush 失败不算失败：事件已经在内存里了', async () => {
  const r = await applyOffload(
    { append: () => {} },
    [{ seq: 1, imageIndexes: [0] }],
    { flush: async () => { throw new Error('disk full'); } },
  );
  assert.equal(r.ok, true);
});
