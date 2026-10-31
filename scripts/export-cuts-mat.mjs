#!/usr/bin/env node
/**
 * export-cuts-mat.mjs — 只导出**切点**：时间轴 + cut(t) ∈ {0,1}，MATLAB 直接 load。
 *
 *   node scripts/export-cuts-mat.mjs <video> [选项]
 *
 * 跑的是插件自己的切点链路，顺序与 pipeline.js 一致：
 *   scanShots（HSV 逐帧打分 → 亮度/黑边归一 → 硬切判定 → 长时差找叠化）
 *   → 极静素材（PPT/录屏）的 spike 兜底
 *   → refineCutsByWindow（逐 2 秒窗口细扫快剪）
 * 不做：取帧、排布、分张、字幕、OCR、缓存 —— 每次都重扫，同参数必然同结果。
 *
 * 选项：
 *   --out <dir>       输出目录（默认 ./cuts-out）
 *   --rate <hz>       cut(t) 的采样率；0 = 跟随视频帧率（默认，一格样点 = 一帧）
 *   --from <sec>      从第几秒开始扫（默认 0）
 *   --dur <sec>       只扫这么长（调试用；不填 = 整片）
 *   --threshold <v>   auto（默认，与插件同口径）或指定分数（如 12）
 *   --min-gap <sec>   两刀最小间隔（默认 0.35，插件的 scanGap）
 *   --no-refine       关掉窗口细扫，只留粗扫结果
 *   --no-spike        关掉极静素材的 spike 兜底
 *   --ffmpeg <path>   指定 ffmpeg（默认走 binaries.js 的解析）
 *
 * 输出（<name> = 视频文件名去扩展名）：
 *   <name>.cut.mat    t / cut / cuts_t / cuts_frame / cuts_score / cuts_kind / fps / rate / …
 *   <name>.cut.csv    切点清单，给人看（也可 readmatrix 读）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import { probeVideo } from '../src/storyboard/probe.js';
import {
  refineCutsByWindow, scanShots, spikeCuts, suppressClose,
} from '../src/storyboard/scan.js';

const USAGE = `usage: node scripts/export-cuts-mat.mjs <video> [--out dir] [--rate hz] [--from s] [--dur s]
                                            [--threshold auto|12] [--min-gap 0.35]
                                            [--no-refine] [--no-spike] [--ffmpeg path]`;

function parseArgs(argv) {
  const input = argv[0];
  const opt = {
    out: 'cuts-out', rate: 0, from: 0, dur: 0,
    threshold: 'auto', minGap: 0.35,
    refine: true, spike: true, ffmpeg: undefined,
  };
  const num = (raw, name) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${name} 需要数字，收到 "${raw}"`);
    return v;
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${key} 缺少值`);
      i += 1;
      return next;
    };
    switch (key) {
      case '--out': opt.out = takeValue(); break;
      case '--rate': opt.rate = num(takeValue(), key); break;
      case '--from': opt.from = num(takeValue(), key); break;
      case '--dur': opt.dur = num(takeValue(), key); break;
      case '--min-gap': opt.minGap = num(takeValue(), key); break;
      case '--ffmpeg': opt.ffmpeg = takeValue(); break;
      case '--threshold': {
        const raw = takeValue();
        opt.threshold = raw === 'auto' ? 'auto' : num(raw, key);
        break;
      }
      case '--no-refine': opt.refine = false; break;
      case '--no-spike': opt.spike = false; break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${key}\n${USAGE}`);
    }
  }
  return { input, opt };
}

/**
 * 写 MATLAB level-4 MAT 文件（只有双精度二维矩阵）。
 *
 * 为什么不用 v5：v5 要套 miMATRIX 元素、按需 zlib 压缩，出错点比收益多；
 * v4 只有 20 字节头 + 名称 + 列主序 double，MATLAB / Octave / scipy.io.loadmat 都能直读。
 * 限制：变量名 ≤ 19 字符（下面前缀都远低于它），且只能是实数矩阵 —— 这里两样都够。
 *
 * @param {Array<[string, ArrayLike<number>, number, number]>} entries [名字, 数据(列主序), 行, 列]
 */
function matV4(entries) {
  const chunks = [];
  for (const [name, values, rows, cols] of entries) {
    if (name.length > 19) throw new RangeError(`v4 变量名太长：${name}`);
    if (values.length !== rows * cols) {
      throw new RangeError(`${name}: 数据 ${values.length} 个，与 ${rows}×${cols} 不符`);
    }
    const head = Buffer.alloc(20 + name.length + 1);
    head.writeInt32LE(0, 0);                      // MOPT=0 → 双精度
    head.writeInt32LE(rows, 4);
    head.writeInt32LE(cols, 8);
    head.writeInt32LE(0, 12);                     // 无虚部
    head.writeInt32LE(name.length + 1, 16);       // 名称长度含结尾 NUL
    head.write(name, 20, 'ascii');
    head.writeUInt8(0, 20 + name.length);
    const body = Buffer.alloc(values.length * 8);
    for (let i = 0; i < values.length; i++) body.writeDoubleLE(values[i], i * 8);
    chunks.push(head, body);
  }
  return Buffer.concat(chunks);
}

/** 1×N 行向量（v4 的列主序对行向量就是自然序） */
const row = (arr) => [arr, 1, arr.length];
const scalar = (v) => [[v], 1, 1];

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const { input, opt } = parseArgs(argv);
  if (opt.rate > 0 && opt.rate < 1) throw new Error(`--rate 至少 1 Hz（收到 ${opt.rate}），否则切点会并成一格`);
  const file = resolve(input);

  const info = await probeVideo(file);
  if (!(info.fps > 0)) throw new Error('探测不到帧率，无法扫描');
  console.log(`[probe] ${info.width}×${info.height} ${info.fps.toFixed(3)}fps ` +
    `${info.duration.toFixed(2)}s${info.rotation ? ` rotation=${info.rotation}` : ''}`);

  const winFrom = Math.max(0, opt.from);
  const winDur = opt.dur > 0 ? opt.dur : Math.max(0, info.duration - winFrom);
  if (!(winDur > 0)) throw new Error(`扫描窗口为空（from=${winFrom}s, duration=${info.duration}s）`);

  // ---- 扫描：进度打到 stderr，结果打到 stdout
  let lastTick = 0;
  const t0 = Date.now();
  const scan = await scanShots({
    input: file,
    fps: info.fps,
    threshold: opt.threshold,
    minGap: opt.minGap,
    start: winFrom,
    end: opt.dur > 0 ? winFrom + winDur : undefined,
    ffmpegPath: opt.ffmpeg,
    // 进度只在终端里刷；重定向到文件时只留一行结论（否则满屏 \r）
    onProgress: process.stderr.isTTY ? ({ frames }) => {
      const now = Date.now();
      if (now - lastTick < 400) return;
      lastTick = now;
      const done = frames / info.fps;
      process.stderr.write(`\r[scan] ${done.toFixed(1)}s / ${winDur.toFixed(1)}s ` +
        `(${Math.min(100, (done / winDur) * 100).toFixed(1)}%)   `);
    } : undefined,
  });
  if (lastTick > 0) process.stderr.write('\r\x1b[K');
  const scanMs = Date.now() - t0;
  console.log(`[scan] ${scan.frames} 帧  threshold=${scan.threshold.toFixed(2)}` +
    `（${opt.threshold === 'auto' ? 'auto' : '指定'}）  ${scan.cuts.length} 刀  ${scanMs}ms`);

  // ---- 与 pipeline 同序：极静素材兜底 → 窗口细扫
  let cuts = scan.cuts;
  if (opt.spike && scan.stats.length > 20) {
    const perSec = cuts.length / Math.max(1, winDur);
    if (perSec < 0.25) {
      const spikes = suppressClose(spikeCuts(scan.stats, { k: 4, minAbs: 4, halfWindow: 12 }), opt.minGap);
      if (spikes.length > cuts.length) {
        console.log(`[spike] 刀密度 ${perSec.toFixed(2)}/s < 0.25（极静素材）→ ${cuts.length} → ${spikes.length} 刀`);
        cuts = spikes;
      }
    }
  }
  const coarseCount = cuts.length;

  let refined = [];
  if (opt.refine) {
    const r = refineCutsByWindow({
      stats: scan.stats,
      coarseCuts: cuts,
      fps: info.fps,
      winStart: winFrom,
      winDur,
      coarseThreshold: scan.threshold ?? 0,
    });
    cuts = r.cuts;
    refined = r.refined;
    console.log(`[refine] ${coarseCount} → ${cuts.length} 刀` +
      `（采纳 ${refined.length} 个窗口：${refined.map((w) => `${w.from.toFixed(0)}-${w.to.toFixed(0)}s ${w.coarse}→${w.fine}`).join(', ') || '无'}）`);
  } else {
    console.log('[refine] 已关闭（--no-refine）');
  }

  // ---- 采样成 cut(t) ∈ {0,1}
  // +1 个样点：让网格覆盖到窗口末尾（片尾最后一帧的刀不会被四舍五入丢掉）
  const rate = opt.rate > 0 ? opt.rate : info.fps;
  const n = Math.max(1, Math.round(winDur * rate) + 1);
  const t = new Float64Array(n);
  const cut = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = winFrom + i / rate;
  let offGrid = 0;
  for (const c of cuts) {
    const i = Math.round((c.t - winFrom) * rate);
    if (i >= 0 && i < n) cut[i] = 1;
    else offGrid += 1;
  }
  const marks = cut.reduce((a, v) => a + v, 0);
  if (marks !== cuts.length) {
    throw new Error(`样点对不上：${cuts.length} 刀只落了 ${marks} 个 1 —— 采样率 ${rate}Hz 太粗，` +
      `两刀并到了同一格；把 --rate 调高（或让它跟随帧率）`);
  }
  if (offGrid > 0) console.log(`[warn] ${offGrid} 刀落在扫描窗口外，已丢弃`);

  // ---- 落盘
  const outDir = resolve(opt.out);
  mkdirSync(outDir, { recursive: true });
  const stem = basename(file, extname(file));
  const matPath = join(outDir, `${stem}.cut.mat`);
  const csvPath = join(outDir, `${stem}.cut.csv`);

  const cutsT = new Float64Array(cuts.length);
  const cutsFrame = new Float64Array(cuts.length);
  const cutsScore = new Float64Array(cuts.length);
  const cutsKind = new Float64Array(cuts.length);
  cuts.forEach((c, i) => {
    cutsT[i] = c.t;
    cutsFrame[i] = Math.round((c.t - winFrom) * info.fps);   // 窗口内 0 基帧号
    cutsScore[i] = Number.isFinite(c.score) ? c.score : NaN;
    // 0 = 帧差判出来的硬切；1 = 长时差补的转场（叠化/淡入淡出，或分数偏低被帧差漏掉的硬切）。
    // 后者的中心是算出来的，不落在帧网格上（样点取最近一格，偏差 ≤ 半帧）。
    cutsKind[i] = c.kind ? 1 : 0;
  });

  writeFileSync(matPath, matV4([
    ['t', ...row(t)],
    ['cut', ...row(cut)],
    ['cuts_t', ...row(cutsT)],
    ['cuts_frame', ...row(cutsFrame)],
    ['cuts_score', ...row(cutsScore)],
    ['cuts_kind', ...row(cutsKind)],
    ['fps', ...scalar(info.fps)],
    ['rate', ...scalar(rate)],
    ['duration', ...scalar(winDur)],
    ['win_from', ...scalar(winFrom)],
    ['n_cuts', ...scalar(cuts.length)],
    ['threshold', ...scalar(scan.threshold)],
    ['min_gap', ...scalar(opt.minGap)],
  ]));

  const csv = ['t_sec,frame,score,kind'];
  cuts.forEach((c, i) => csv.push([
    cutsT[i].toFixed(3), cutsFrame[i], cutsScore[i].toFixed(1), cutsKind[i] ? 'long' : 'hard',
  ].join(',')));
  writeFileSync(csvPath, `${csv.join('\n')}\n`);

  console.log(`[out] ${matPath}`);
  console.log(`      ${csvPath}`);
  console.log(`[cut(t)] ${n} 个样点 @ ${rate}Hz（1 个样点 = ${(1 / rate).toFixed(4)}s）  ` +
    `${cuts.length} 刀 → ${marks} 个 1  窗口 ${winFrom.toFixed(2)}–${(winFrom + winDur).toFixed(2)}s`);
  console.log('');
  console.log('MATLAB:');
  console.log(`  S = load('${basename(matPath)}');   plot(S.t, S.cut);   % cut(t) 只取 0 / 1`);
  console.log('  dt = round(0.5 * S.rate);          % 0.5 秒积分窗 → dt 个样点（采样率 S.rate）');
  console.log('  Ro = conv(S.cut, ones(1, dt)); Ro = Ro(1:numel(S.cut));   % 因果积分，长度对齐');
  console.log('  % 精确切点列表在 S.cuts_t（秒），S.cuts_frame 是窗口内 0 基帧号');
}

main().catch((err) => {
  console.error(`\n[error] ${err?.message ?? err}`);
  process.exit(1);
});
