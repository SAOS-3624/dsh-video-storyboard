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
    const band = await detectSubtitleBand({ python, frames: probes });
    if (!band) return { status: 'failed', reason: 'detect-failed' };

    const [y0, y1] = band.band;
    const crop = `crop=iw:ih*${(y1 - y0).toFixed(4)}:0:ih*${y0.toFixed(4)},scale=1280:-1`;

    // ② 均匀抽样若干条台词（不取全部，成本与收益不成正比）
    const picks = [];
    const n = Math.min(OCR_MAX_ITEMS, segments.length);
    const step = segments.length / n;
    for (let i = 0; i < n; i += 1) picks.push(Math.floor(i * step));

    const images = [];
    for (const [k, idx] of picks.entries()) {
      const seg = segments[idx];
      const mid = winStart + (seg.from + seg.to) / 2;
      images.push(await grab(mid, `band${k}.jpg`, crop));
    }
    const items = await readBand({ python, images });
    if (!items) return { status: 'failed', reason: 'read-failed' };

    const out = segments.map((x) => ({ ...x }));
    const changes = [];
    for (const [k, idx] of picks.entries()) {
      const seg = segments[idx];
      const ocrText = (items[k]?.text ?? '').replace(/\s+/g, '');
      const verdict = shouldReplace({ asr: seg.text, ocr: ocrText, conf: items[k]?.conf ?? 0 });
      if (process.env.DSH_OCR_DEBUG) {
        console.error('[ocr]', seg.from.toFixed(1), JSON.stringify(seg.text), '| ocr:', JSON.stringify(ocrText),
          '| conf', items[k]?.conf, '|', verdict.reason, verdict.cover ?? '');
      }
      if (verdict.replace) {
        const fixedText = verdict.text ?? ocrText;
        changes.push({ from: seg.from, was: seg.text, now: fixedText, cover: verdict.cover });
        out[idx] = { ...seg, text: fixedText };
      }
    }
    return {
      status: 'applied',
      fixed: changes.length,
      checked: picks.length,
      band: { y0: +y0.toFixed(3), y1: +y1.toFixed(3), detected: band.detected },
      // URL 模式下跑的是下载的扫描副本：字幕本身就糊，校正的可信度低于本地高清文件。
      // 这个事实必须传到清单，否则读起来像"原片台词已核对"。
      ...(sourceCopyHeight
        ? { basedOn: 'low-res-copy', copyHeight: sourceCopyHeight }
        : { basedOn: 'source' }),
      changes: changes.slice(0, 5),
      segments: out,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
