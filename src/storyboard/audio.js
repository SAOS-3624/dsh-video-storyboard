/**
 * audio.js — 音频侧的"测量层"。零模型：只用 ffmpeg 的 ebur128 与 silencedetect。
 *
 * 目的是给画面配一条**同时间轴的**参考线：哪里响、哪里静。它回答"哪里在响"，
 * 不回答"为什么响"——后者是音乐理解，得靠模型（见设计方案 §12）。
 */

import { spawn } from 'node:child_process';

import { DEFAULT_FFMPEG } from './probe.js';

export const LUFS_FLOOR = -70;      // 低于这个值当静音（ebur128 静音输出 -120 左右）
export const SILENCE_DB = -40;
export const SILENCE_MIN = 0.6;

/** 跑一次 ffmpeg，收集 stderr（ebur128 / silencedetect 都往 stderr 打） */
function runAudioFilter({ input, ffmpegPath, filter, start, end, timeoutMs = 180_000 }) {
  return new Promise((resolve, reject) => {
    const args = [ffmpegPath, '-hide_banner', '-nostdin', '-v', 'info'];
    if (start > 0) args.push('-ss', String(start));
    if (end !== undefined) args.push('-t', String(Math.max(0.1, end - start)));
    args.push('-i', input, '-vn', '-sn', '-dn', '-af', filter, '-f', 'null', '-');
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(err);
      const tail = err.trim().split('\n').slice(-2).join(' | ');
      reject(new Error(`ffmpeg audio filter exited ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

const M_RE = /lavfi\.r128\.M=(-?[0-9.]+)/g;

/**
 * 瞬时响度曲线（EBU R128 momentary，约每 100ms 一个点）。
 * @returns {Promise<{series:number[], step:number, mean:number, peak:number, dynamic:number, samples:number}>}
 */
export async function measureLoudness({ input, ffmpegPath = DEFAULT_FFMPEG, start = 0, end } = {}) {
  const stderr = await runAudioFilter({
    input, ffmpegPath, start, end,
    filter: 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M',
  });
  const series = [];
  for (const m of stderr.matchAll(M_RE)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) series.push(v);
  }
  const audible = series.filter((v) => v > LUFS_FLOOR);
  const mean = audible.length ? audible.reduce((s, v) => s + v, 0) / audible.length : LUFS_FLOOR;
  const peak = audible.length ? Math.max(...audible) : LUFS_FLOOR;
  return {
    series,
    step: 0.1,
    mean: +mean.toFixed(1),
    peak: +peak.toFixed(1),
    dynamic: +(peak - (audible.length ? Math.min(...audible) : LUFS_FLOOR)).toFixed(1),
    samples: series.length,
  };
}

const SS_RE = /silence_start: (-?[0-9.]+)/g;
const SE_RE = /silence_end: (-?[0-9.]+)/g;

/**
 * 静音段（默认 -40dB 持续 0.6s 以上）。人声停顿与 BGM 间隙都在这里。
 * @returns {Promise<Array<{from:number,to:number}>>}
 */
export async function detectSilence({
  input, ffmpegPath = DEFAULT_FFMPEG, start = 0, end,
  noise = SILENCE_DB, minDur = SILENCE_MIN,
} = {}) {
  const stderr = await runAudioFilter({
    input, ffmpegPath, start, end,
    filter: `silencedetect=noise=${noise}dB:d=${minDur}`,
  });
  // ffmpeg 输出的是相对本次输入的时间；加上 start 还原成绝对时间
  const starts = [...stderr.matchAll(SS_RE)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(SE_RE)].map((m) => Number(m[1]));
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i] + start;
    const to = (ends[i] ?? (end !== undefined ? end - start : from + minDur)) + start;
    if (to > from) out.push({ from: +from.toFixed(2), to: +to.toFixed(2) });
  }
  return out;
}

/**
 * 一次调用同时拿响度与静音（省一遍音频解码）。
 */
export async function analyzeAudio({ input, ffmpegPath, start = 0, end } = {}) {
  // 音频分析是**增量**信息：任何一项失败都不能让分镜整体失败
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch {
      try { return await fn(); } catch { return fallback; }   // 并发时偶发的失败，重试一次
    }
  };
  const [loudness, silences] = await Promise.all([
    safe(() => measureLoudness({ input, ffmpegPath, start, end }), null),
    safe(() => detectSilence({ input, ffmpegPath, start, end }), []),
  ]);
  if (!loudness || loudness.samples === 0) {
    // 拿不到响度但有静音信息时，仍然把静音交出去（ASR 切片要用）
    return silences.length > 0 ? { series: [], step: 0.1, mean: NaN, peak: NaN, dynamic: NaN, samples: 0, silences, source: 'silencedetect' } : null;
  }
  return { ...loudness, silences, source: 'ebur128' };
}

/**
 * 声音事件检测：突然变响 / 突然安静。
 *
 * 为什么需要（社区反馈里最有用的一条）：帧差只能看见"画面变了"。人说话忽然提高音量、
 * 突然一片死寂、观众爆笑的那一刻——画面可能一动不动，但事情全在声音里。
 *
 * 判据（都对瞬时响度序列做，不引入模型）：
 *  - **rise**：0.5 秒内上升 > 6 dB（一句台词突然激动、音乐进副歌）
 *  - **drop**：从有声跌到静音区，跌幅 > 12 dB（突然安静、话说完、留白）
 * 相邻事件至少间隔 `minGap` 秒，避免把一段渐强拆成一串。
 *
 * @param {{series:number[], step:number, silences?:Array}} loudness
 * @returns {Array<{t:number, kind:'rise'|'drop', delta:number}>}
 */
export function detectOnsets(loudness, {
  riseDb = 8, dropDb = 15, windowSec = 0.5, minGap = 1.5, maxDelta = 30,
} = {}) {
  const series = loudness?.series ?? [];
  const step = loudness?.step ?? 0.1;
  if (series.length === 0) return [];
  const win = Math.max(1, Math.round(windowSec / step));
  const out = [];
  const push = (t, kind, delta) => {
    const prev = out.at(-1);
    if (prev && t - prev.t < minGap) {
      if (Math.abs(delta) > Math.abs(prev.delta)) out[out.length - 1] = { t, kind, delta };
      return;
    }
    out.push({ t, kind, delta });
  };
  for (let i = win; i < series.length; i++) {
    const now = series[i];
    const before = series[i - win];
    if (now <= LUFS_FLOOR && before <= LUFS_FLOOR) continue;
    const raw = now - before;
    // 数字静音（-120 LUFS）里起声会算出 100dB 以上的假落差，截断到 maxDelta，
    // 免得它把"真正的大事"挤出排行榜。
    const delta = Math.max(-maxDelta, Math.min(maxDelta, raw));
    if (delta > riseDb) push(+(i * step).toFixed(2), 'rise', +delta.toFixed(1));
    else if (delta < -dropDb) push(+(i * step).toFixed(2), 'drop', +delta.toFixed(1));
  }
  return out;
}

/** 给文本清单用的一句话事实（明确区分"测出来的"和"看出来的"） */
export function describeAudio(audio, window) {
  if (!audio) return 'no audio track';
  if (audio.samples === 0) return `${audio.silences.length} silence gaps (loudness unavailable)`;
  const quiet = audio.silences.length;
  const quietTime = audio.silences.reduce((s, r) => s + (r.to - r.from), 0);
  return `mean ${audio.mean} LUFS, peak ${audio.peak} LUFS, ` +
    `${audio.dynamic} dB dynamic range, ${quiet} silence gaps (${quietTime.toFixed(1)}s of ${window.toFixed(0)}s)`;
}
