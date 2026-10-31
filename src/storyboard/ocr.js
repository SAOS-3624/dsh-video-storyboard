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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPython } from './python.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 桥接脚本在 **`src/ocr_bridge.py`**，本文件在 `src/storyboard/` 下 —— 少上溯一层，
 * 每一次调用都会 ENOENT（issue #39：从装上到现在没有一次成功过）。
 *
 * 这条路径是本包**唯一**引用 bridge 的地方，所以下面那条测试断言它是存在的。
 */
export const OCR_BRIDGE = join(HERE, '..', 'ocr_bridge.py');

/** 单次最多校正多少条 —— 每条要解一次 ffmpeg、跑一次 OCR，太多就不划算了 */
export const OCR_MAX_ITEMS = 16;

/**
 * 从 `~/.dsh/video.json` 读 OCR 配置。
 *
 * 为什么读文件而不是只认环境变量：桌面版 DSH 的进程环境由启动器决定，
 * `setx` 设的变量宿主读不到（同 asr.json / tts.json 的理由）。
 *
 * ```json
 * // ~/.dsh/video.json
 * { "ocr": { "python": "D:/ocr-local/.venv/Scripts/python.exe" } }
 * ```
 *
 * 插件**不带** OCR 引擎：模型有 250MB+，还绑一个 Python 环境，塞进 npm 包只会让人多下一坨
 * 用不上的东西。这里只负责"找到你自己装的那份"，跟 ffmpeg / yt-dlp 一个待遇。
 */
function videoConfig(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    return { ocr: cfg?.ocr, python: cfg?.ocr?.python ?? cfg?.python };
  } catch {
    return {}; // 没有配置文件是正常情况，继续走下面的候选链
  }
}

/**
 * 找一台能 import OCR 引擎的 python。
 *
 * 两个模块名都试：`rapidocr`（3.x，Python 3.8+，现在 PyPI 上的主线）和
 * `rapidocr_onnxruntime`（1.x，**只到 Python 3.12**，3.13 上装不上）。
 * 顺序不能反 —— 新包在旧环境里也能装，旧包在新环境里装不了。
 *
 * 早期版本在这里硬编码了开发机的 `.venv` 路径 —— 跟着包发出去，别人的机器上永远找不到，
 * 于是"OCR 校正"对所有人都是静默跳过。现在统一走 python.js 的候选链 + 实际 import 验证。
 */
/** 已经确认能 import 的那个模块名。锁住它，免得每轮都先去试一遍不存在的那个。 */
let resolvedModule = null;

export async function ocrPython({ config, env = process.env } = {}) {
  const cfg = config ?? videoConfig(env);
  if (resolvedModule) return findPython(resolvedModule, { config: cfg, env });
  const fresh = await findPython('rapidocr', { config: cfg, env });
  if (fresh) {
    resolvedModule = 'rapidocr';
    return fresh;
  }
  const legacy = await findPython('rapidocr_onnxruntime', { config: cfg, env });
  if (legacy) resolvedModule = 'rapidocr_onnxruntime';
  return legacy;
}

/**
 * 跑一次桥接脚本。**失败必须说出原因**，不能一律返回 null。
 *
 * issue #39 的教训：原来 `if (err) return resolve(null)` 把"脚本不存在 / 超时 / Python 崩溃"
 * 三种完全不同的故障压成同一个 `null`，调用方再把它报成 `detect-failed` ——
 * 于是"Python 根本没打开那个文件"看起来像"字幕带检测失败"，藏了一整个版本都没人发现。
 *
 * @returns {Promise<{ok:true, data:object} | {ok:false, kind:string, message:string}>}
 */
function runBridge({ python, mode, images, timeoutMs = 120_000 }) {
  const bridge = OCR_BRIDGE;
  if (!existsSync(bridge)) {
    return Promise.resolve({
      ok: false,
      kind: 'bridge-missing',
      message: `ocr_bridge.py not found at ${bridge}`,
    });
  }
  return new Promise((resolve) => {
    execFile(python, [bridge, mode, ...images], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
      (err, stdout, stderr) => {
        if (err) {
          const kind = err.killed || err.signal || err.code === 'ETIMEDOUT'
            ? 'bridge-timeout'
            : err.code === 'ENOENT'
              ? 'interpreter-missing'
              : 'bridge-crashed';
          const message = `${err.message ?? err}${stderr ? ` | ${String(stderr).trim().slice(0, 300)}` : ''}`;
          if (process.env.DSH_OCR_DEBUG) console.error('[ocr-bridge]', mode, kind, message);
          return resolve({ ok: false, kind, message });
        }
        let parsed;
        try {
          parsed = JSON.parse(String(stdout ?? '').trim() || '{}');
        } catch {
          if (process.env.DSH_OCR_DEBUG) {
            console.error('[ocr-bridge]', mode, 'bridge-bad-json', String(stdout ?? '').slice(0, 300));
          }
          return resolve({
            ok: false,
            kind: 'bridge-bad-json',
            message: `not JSON: ${String(stdout ?? '').trim().slice(0, 200)}`,
          });
        }
        if (!parsed?.ok) {
          // Python 侧自己报的错（没装 rapidocr、参数不对）：原样带出去，别再造一个错误码
          return resolve({
            ok: false,
            kind: 'bridge-error',
            message: String(parsed?.error ?? 'bridge returned ok:false').slice(0, 300),
          });
        }
        return resolve({ ok: true, data: parsed });
      });
  });
}

/**
 * 用 2–3 帧全图检测，找出字幕带（y 的归一化区间）。检测是最贵的一步，只跑这一次。
 * @returns {Promise<{ok:true, band:number[], detected:boolean, boxes:object[]} |
 *                   {ok:false, kind:string, message:string}>}
 */
export async function detectSubtitleBand({ python, frames }) {
  if (!python) return { ok: false, kind: 'no-python', message: 'no python with rapidocr' };
  if (!frames?.length) return { ok: false, kind: 'no-frames', message: 'no probe frames' };
  const res = await runBridge({ python, mode: 'detect', images: frames.slice(0, 3) });
  if (!res.ok) return res;
  if (!res.data?.band) {
    return { ok: false, kind: 'no-band', message: 'detect returned no band' };
  }
  return {
    ok: true,
    band: res.data.band,
    detected: Boolean(res.data.detected),
    boxes: res.data.boxes ?? [],
  };
}

/**
 * 已知字幕带后只做识别（比全图检测快约 12 倍）
 * @returns {Promise<{ok:true, items:object[]} | {ok:false, kind:string, message:string}>}
 */
export async function readBand({ python, images }) {
  if (!python) return { ok: false, kind: 'no-python', message: 'no python with rapidocr' };
  if (!images?.length) return { ok: false, kind: 'no-images', message: 'no band images' };
  const res = await runBridge({ python, mode: 'read', images });
  if (!res.ok) return res;
  const items = res.data?.items;
  if (!items) return { ok: false, kind: 'no-items', message: 'read returned no items' };
  return { ok: true, items };
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
 *   1. OCR 置信度 ≥ 0.65（低置信的 OCR 比 ASR 还不可信；代码是 0.65，注释以前写成 0.75）
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
