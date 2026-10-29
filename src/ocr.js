/**
 * ocr.js — 用画面上的硬字幕校正语音转写。
 *
 * 为什么需要：ASR 会听错专有名词（实测「像差」→「相差」、「也要忘记吗」→「他也忘记」），
 * 而画面里烧进去的字幕是**确定的文本**。两者对不上时，画面更可信。
 *
 * 为什么不是"让模型自己看图"：模型看到的格子是 331×184，实测同一句字幕在那一档会掉字
 * （"也要忘记吗" → "也要记"），而且它只看得到 9–20 帧，覆盖不了全片。OCR 是在原分辨率上做的。
 *
 * 为什么走 Python：中文 OCR 的现成实现（rapidocr）在 Python 侧。用一次 subprocess 换 JSON，
 * 比在 Node 里重造一套现实得多。**没装就跳过**，不报错、不影响出图。
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPython } from './python.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 单次最多校正多少条 —— 每条要解一次 ffmpeg、跑一次 OCR，太多就不划算了 */
export const OCR_MAX_ITEMS = 16;

/**
 * 找一台能 `import rapidocr_onnxruntime` 的 python。
 *
 * 早期版本在这里硬编码了开发机的 `.venv` 路径 —— 跟着包发出去，别人的机器上永远找不到，
 * 于是"OCR 校正"对所有人都是静默跳过。现在统一走 python.js 的候选链 + 实际 import 验证。
 */
export async function ocrPython({ config = {}, env = process.env } = {}) {
  return findPython('rapidocr_onnxruntime', { config, env });
}

function runBridge({ python, mode, images, timeoutMs = 120_000 }) {
  const bridge = join(HERE, 'ocr_bridge.py');
  return new Promise((resolve) => {
    execFile(python, [bridge, mode, ...images], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout ?? '').trim() || '{}');
          resolve(parsed?.ok ? parsed : null);
        } catch {
          resolve(null);
        }
      });
  });
}

/** 用 2–3 帧全图检测，找出字幕带（y 的归一化区间）。检测是最贵的一步，只跑这一次。 */
export async function detectSubtitleBand({ python, frames }) {
  if (!python || !frames?.length) return null;
  const res = await runBridge({ python, mode: 'detect', images: frames.slice(0, 3) });
  if (!res?.band) return null;
  return { band: res.band, detected: Boolean(res.detected), boxes: res.boxes ?? [] };
}

/** 已知字幕带后只做识别（比全图检测快约 12 倍） */
export async function readBand({ python, images }) {
  if (!python || !images?.length) return null;
  const res = await runBridge({ python, mode: 'read', images });
  return res?.items ?? null;
}

/**
 * 文本相似度：用「公共子序列长度 / 较长者长度」做粗判。
 * 不用编辑距离的绝对值 —— 两句 20 字的台词差 2 个字和两句 8 字的台词差 2 个字，含义完全不同。
 */
export function similarity(a, b) {
  const s1 = String(a ?? '').replace(/[\s，。、！？；：""''（）()]/g, '');
  const s2 = String(b ?? '').replace(/[\s，。、！？；""''（）()]/g, '');
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const m = s1.length;
  const n = s2.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = s1[i - 1] === s2[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n] / Math.max(m, n);
}

/**
 * 决定"要不要用 OCR 文本替换 ASR 文本"。
 *
 * 规则刻意保守：只有**三条同时成立**才替换，否则保留 ASR 并记一笔"存疑"。
 *   1. OCR 置信度 ≥ 0.75（低置信的 OCR 比 ASR 还不可信）
 *   2. 两边长度差不超过 30%（差太多说明截到别的字幕了）
 *   3. 相似度在 0.2–0.9 之间
 *      —— <0.2：完全是两句话，可能帧没对上；>0.9：本来就一致，没必要动
 */
export function shouldReplace({ asr, ocr, conf }) {
  const clean = (x) => String(x ?? '').replace(/[\s，。、！？；：""''（）()…—]/g, '');
  const A = clean(asr);
  const B = clean(ocr);
  if (B.length < 2) return { replace: false, reason: 'empty-ocr' };
  if (!(conf >= 0.65)) return { replace: false, reason: 'low-conf' };
  if (A.length === 0) return { replace: true, reason: 'asr-empty', text: String(ocr).trim() };

  // 一条字幕带里常常同时留着上下两句（上一句还没消失），所以先把 OCR 切成分句，
  // 再挑"和这句 ASR 最吻合的那一块"——拿整条去比长度，永远会被判成"长度差太多"。
  const pieces = String(ocr).split(/[，。、！？；,;!?\n]/).map((x) => clean(x)).filter((x) => x.length >= 2);
  const candidates = pieces.length > 0 ? pieces : [B];
  let best = { cover: 0, piece: B, raw: String(ocr).trim() };
  for (let i = 0; i < candidates.length; i += 1) {
    const cover = lcsLength(A, candidates[i]) / A.length;
    if (cover > best.cover) best = { cover, piece: candidates[i], raw: candidates[i] };
  }
  const cover = best.cover;

  // 长度差（对"最吻合那块"而言）：差太多说明截到的是别的字幕
  if (Math.abs(A.length - best.piece.length) / Math.max(A.length, best.piece.length) > 0.5) {
    return { replace: false, reason: 'length-gap', cover: +cover.toFixed(2) };
  }
  // 判据是**覆盖度**：ASR 的典型错误是漏字/换字，OCR 常常是完整那句。
  // 问"ASR 里有多少字按顺序出现在 OCR 里"，而不是两边各占多少。
  if (cover < 0.6) return { replace: false, reason: 'unrelated', cover: +cover.toFixed(2) };
  if (cover > 0.98) return { replace: false, reason: 'agree' };
  // 多出来的字如果明显多于这句台词，说明带子把相邻那句也截进来了 —— 按匹配区间剪掉两头
  const match = lcsMatch(A, best.piece);
  // 剪到匹配区间，两侧各放宽 1 个字：ASR 常常漏掉句尾的语气词（吗/了/啊），
  // 但再宽就会把相邻那句的头一个字带进来。
  const text = best.piece.length - A.length > 2
    ? best.piece.slice(Math.max(0, match.lo - 1), Math.min(best.piece.length, match.hi + 2))
    : best.raw;
  return { replace: true, reason: 'ocr-covers-asr', cover: +cover.toFixed(2), text };
}

/** 最长公共子序列长度（按字符） */
function lcsLength(a, b) {
  return lcsMatch(a, b).length;
}

/**
 * 最长公共子序列 + 它在 b 里覆盖的区间。
 * 区间用来把"顺带截进来的上一句/下一句"剪掉：字幕带上常常同时有两条字幕。
 */
function lcsMatch(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = m; let j = n; let lo = Infinity; let hi = -1;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lo = Math.min(lo, j - 1);
      hi = Math.max(hi, j - 1);
      i -= 1; j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i -= 1;
    else j -= 1;
  }
  return { length: dp[m][n], lo: hi >= 0 ? lo : 0, hi: hi >= 0 ? hi : n - 1 };
}
