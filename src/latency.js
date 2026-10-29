/**
 * latency.js — 每台机器的"测量延迟"自动标定。
 *
 * 问题：从"读进度"到"这句话出现在屏幕上"之间有一段固定延迟（读 SMTC 1 s + 解码分镜 8 s +
 * 模型开口）。用户看到的总比 AI 以为的晚，于是"该说话了"永远慢半拍。
 *
 * 解法：**自动量，不要问用户**。
 * 每次交付时记下「开始读进度 → 结果返回」这段耗时，做指数平滑（EWMA），
 * 之后把这段延迟当成提前量加进判定（`aheadSec`），让所有动作都往前挪一点。
 *
 * 每台机器不一样（硬件、有没有 cookies、ASR 是不是冷的），所以值存在本地，
 * 不做成默认常量。样本不足时**不猜**，按 0 处理并在结果里说明还在标定。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cacheDir } from './cache.js';

const FILE = 'latency.json';
const ALPHA = 0.4;          // 指数平滑系数：新样本占 40%
const MAX_SAMPLES = 40;

export function latencyPath(env = process.env) {
  return join(cacheDir(env), FILE);
}

export async function loadLatency(env = process.env) {
  try {
    const raw = JSON.parse(await readFile(latencyPath(env), 'utf8'));
    return {
      ms: Number(raw?.ms) > 0 ? Number(raw.ms) : 0,
      samples: Number(raw?.samples) || 0,
      at: Number(raw?.at) || 0,
    };
  } catch {
    return { ms: 0, samples: 0, at: 0 };
  }
}

/** 记一次耗时（毫秒）。只用中位数附近的正常值，异常值直接丢。 */
export async function recordLatency(ms, { env = process.env, now = Date.now() } = {}) {
  const v = Number(ms);
  // 0.2 s 以下说明没真的干活；2 分钟以上多半是下载/卡死，都不能拿来当"常态延迟"
  if (!Number.isFinite(v) || v < 200 || v > 120_000) return loadLatency(env);
  const cur = await loadLatency(env);
  const next = cur.samples === 0 ? v : cur.ms * (1 - ALPHA) + v * ALPHA;
  const out = { ms: Math.round(next), samples: Math.min(MAX_SAMPLES, cur.samples + 1), at: now };
  try {
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(latencyPath(env), JSON.stringify(out), 'utf8');
  } catch { /* 存不下就下次再量 */ }
  return out;
}

/** 提前量（秒）。样本 < 2 时返回 0 —— 一个样本定不了常数。 */
export function aheadSeconds(state) {
  if (!state || state.samples < 2) return 0;
  return Math.min(30, state.ms / 1000);
}

/** 给工具结果用的一行说明：让模型知道现在是否已标定。 */
export function describeLatency(state) {
  if (!state || state.samples === 0) {
    return 'latency: calibrating (this machine has no timing sample yet — it is measured automatically '
      + 'on each segment, nothing for you to do)';
  }
  if (state.samples < 2) {
    return `latency: ~${(state.ms / 1000).toFixed(1)}s (1 sample, still settling)`;
  }
  return `latency: ~${(state.ms / 1000).toFixed(1)}s over ${state.samples} samples `
    + `(speaking this much earlier to make up for it)`;
}
