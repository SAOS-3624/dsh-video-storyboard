/**
 * latency.test.mjs — 每台机器的"测量延迟"标定。
 *
 * 为什么值得测：这个值决定"提前多少说话"。偏小 = 还是慢半拍；偏大 = 抢在用户前面剧透。
 * 规则：自动量（不需要用户配）、异常值不进、样本不够就不猜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aheadSeconds, describeLatency, loadLatency, recordLatency } from '../src/latency.js';

test('一开始没有样本，提前量为 0（不猜）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lat-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    const st = await loadLatency(env);
    assert.equal(st.samples, 0);
    assert.equal(aheadSeconds(st), 0);
    assert.match(describeLatency(st), /calibrating/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('一个样本也不当作常数（要 ≥2 才生效）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lat2-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    const st = await recordLatency(9000, { env });
    assert.equal(st.samples, 1);
    assert.equal(aheadSeconds(st), 0, '一个样本定不了常数');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('两个以上样本后按 EWMA 收敛，并给出提前量', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lat3-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    await recordLatency(10_000, { env });
    const st = await recordLatency(10_000, { env });
    assert.equal(st.samples, 2);
    assert.ok(Math.abs(st.ms - 10_000) < 500, `应接近 10s，实得 ${st.ms}`);
    assert.ok(Math.abs(aheadSeconds(st) - 10) < 0.6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('异常值不进：太快（没真干活）或太慢（下载/卡死）都丢掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lat4-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    assert.equal((await recordLatency(50, { env })).samples, 0, '50ms 不算一次测量');
    assert.equal((await recordLatency(300_000, { env })).samples, 0, '5 分钟是卡死，不是常态');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('提前量有上限，不能因为一次异常把判定推到很前面', async () => {
  assert.equal(aheadSeconds({ ms: 100_000, samples: 5 }), 30, '封顶 30 秒');
});
