/**
 * ocr-subs.js — 用画面硬字幕**校正 ASR 文本**（只在 detail=high 时开）。
 *
 * 从 pipeline.js 拆出来的。它是唯一一条"读像素来改文字"的路径，
 * 失败方式（没装 rapidocr / 检测不到字幕带 / 相似度不够）和转写本身完全不同，
 * 混在编排里既难查也难单独关。
 *
 * 硬约束：三条都成立才替换（置信度够 / 长度差不多 / 相似度在 0.2–0.9）。
 * 剩下的一律保留 ASR 原文 —— 宁可留一个已知的错字，也不要引入一个来源不明的句子。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detectSubtitleBand, OCR_MAX_ITEMS, ocrPython, readBand, shouldReplace } from './ocr.js';

const runFile = promisify(execFile);

/**
 * 用画面硬字幕校正 ASR。流程刻意分两步，因为检测是最贵的一环：
 *   ① 抽 2–3 张**原分辨率**帧做一次全图检测，定出字幕带   （≈3 s）
 *   ② 对若干条台词，只裁那一条带子做识别（不做检测）      （≈0.26 s/条）
 *
 * 只有三条都成立才替换（见 shouldReplace）：OCR 置信度够、长度差不多、相似度落在 0.2–0.9。
 * 剩下的情况一律保留 ASR 原文 —— 宁可留一个已知的错字，也不要引入一个来源不明的句子。
 */
export function planOcrSamples(segments, { winStart = 0, winDur = Infinity, max = OCR_MAX_ITEMS } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const n = Math.min(Math.max(0, Math.round(Number(max) || 0)), list.length);
  if (n === 0) return [];
  const step = list.length / n;
  const limit = Number.isFinite(winDur) ? Math.max(0, winStart + winDur) : Infinity;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(i * step);
    const from = Number(list[idx]?.from);
    const to = Number(list[idx]?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const mid = (from + to) / 2;
    // 转录段的 from/to 已经是**整条视频的绝对时间**；这里不能再加 winStart，
    // 否则窗口从 261.5s 开始时会把 269.6s 的帧 seek 到 531.1s（#45）。
    samples.push({ idx, at: Math.min(Math.max(0, mid), limit) });
  }
  return samples;
}

export function applyOcrSamples(segments, samples, items) {
  const out = segments.map((x) => ({ ...x }));
  const changes = [];
  for (const [k, sample] of samples.entries()) {
    const seg = segments[sample.idx];
    const ocrText = (items[k]?.text ?? '').replace(/\s+/g, '');
    const verdict = shouldReplace({ asr: seg.text, ocr: ocrText, conf: items[k]?.conf ?? 0 });
    if (process.env.DSH_OCR_DEBUG) {
      console.error('[ocr]', seg.from.toFixed(1), JSON.stringify(seg.text), '| ocr:', JSON.stringify(ocrText),
        '| conf', items[k]?.conf, '|', verdict.reason, verdict.cover ?? '');
    }
    if (verdict.replace) {
      const fixedText = verdict.text ?? ocrText;
      changes.push({ from: seg.from, was: seg.text, now: fixedText, cover: verdict.cover });
      out[sample.idx] = { ...seg, text: fixedText };
    }
  }
  return { segments: out, changes };
}

export async function correctByOnScreenSubs({
  input, winStart, winDur, ffmpegPath, segments, remoteFrame, sourceCopyHeight = null,
}) {
  // 直链是另一套取帧路径（带 header），第一版不做 —— 明确说"跳过"，而不是悄悄不生效
  if (remoteFrame?.uri) return { status: 'skipped', reason: 'remote-frame-source' };
  const python = await ocrPython();
  if (!python) return { status: 'skipped', reason: 'no-python-with-rapidocr' };

  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr-'));
  try {
    const grab = async (at, outName, crop) => {
      const out = join(dir, outName);
      const args = ['-hide_banner', '-v', 'error', '-y', '-ss', String(Math.max(0, at)), '-i', input,
        '-frames:v', '1', '-q:v', '2'];
      if (crop) args.push('-vf', crop);
      args.push(out);
      await runFile(ffmpegPath, args);
      return out;
    };

    // ① 定字幕带：取窗口内均匀分布的 3 个时刻
    const probes = await Promise.all([0.2, 0.5, 0.8].map((r, i) => grab(
      winStart + winDur * r, `probe${i}.jpg`, null,
    )));
    const det = await detectSubtitleBand({ python, frames: probes });
    // 失败原因要原样传出去：`detect-failed` 曾经同时代表"脚本不存在""超时""检测真失败"，
    // 于是"ocr_bridge.py 路径拼错"藏了一整个版本（#39）。
    if (!det.ok) return { status: 'failed', reason: det.kind, detail: det.message };

    const [y0, y1] = det.band;
    const crop = `crop=iw:ih*${(y1 - y0).toFixed(4)}:0:ih*${y0.toFixed(4)},scale=1280:-1`;

    // ② 均匀抽样若干条台词（不取全部，成本与收益不成正比）
    const samples = planOcrSamples(segments, { winStart, winDur });

    const images = [];
    for (const [k, sample] of samples.entries()) {
      images.push(await grab(sample.at, `band${k}.jpg`, crop));
    }
    const read = await readBand({ python, images });
    if (!read.ok) return { status: 'failed', reason: read.kind, detail: read.message };
    const items = read.items;

    const applied = applyOcrSamples(segments, samples, items);
    return {
      status: 'applied',
      fixed: applied.changes.length,
      checked: samples.length,
      band: { y0: +y0.toFixed(3), y1: +y1.toFixed(3), detected: det.detected },
      // URL 模式下跑的是下载的扫描副本：字幕本身就糊，校正的可信度低于本地高清文件。
      // 这个事实必须传到清单，否则读起来像"原片台词已核对"。
      ...(sourceCopyHeight
        ? { basedOn: 'low-res-copy', copyHeight: sourceCopyHeight }
        : { basedOn: 'source' }),
      changes: applied.changes.slice(0, 5),
      segments: applied.segments,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
