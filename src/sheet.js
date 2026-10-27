/**
 * sheet.js — 取帧 + 拼图 + 烧编号。零图像库：全部在 rawvideo RGB 缓冲上做。
 *
 * 为什么不用 ffmpeg 的 `tile` + `drawtext`：
 *  - drawtext 需要字体文件 + fontconfig + 平台相关的路径转义，装到别人机器上就得炸；
 *  - 我们只需要画 0-9 和一道横杠，用内置点阵字形更可控，且在低分辨率压缩后更抗糊。
 *
 * 布局约定（与 plan.js 一致）：
 *  - 每格按 cover 方式缩放裁切（不变形，溢出部分裁掉）
 *  - 整图面积 <= budget（默认 640k），间隙 4px
 *  - 空位填中性灰 + “—”，且不编号
 */

import { spawn } from 'node:child_process';

import { DEFAULT_FFMPEG } from './probe.js';

export const BACKGROUND = [18, 18, 20];
export const PAD_FILL = [42, 42, 46];
export const PAD_GLYPH = [110, 110, 116];
export const BADGE_BG = [0, 0, 0];
export const BADGE_FG = [255, 235, 59];
export const GUTTER = 4;
export const BADGE_ALPHA = 0.85;

/** 5×7 点阵，只有 0-9。scale 必须是整数，保证放大后边缘锐利。 */
export const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

export const DIGIT_W = 5;
export const DIGIT_H = 7;

/** 徽标时间码：`m:ss`（整数秒）。小格子上小数位读不清，不如省像素。 */
export function formatBadgeTime(t) {
  const sec = Math.max(0, Number(t) || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 画布尺寸：整图面积 <= budget，格宽高按剩余空间均分。
 * @returns {{width:number,height:number,cellW:number,cellH:number}}
 */
export function layoutCanvas(cols, rows, cellAspect, budget = 640_000, gutter = GUTTER) {
  const aspect = (cols * cellAspect) / rows;
  const gw = Math.sqrt(budget * aspect);
  const gh = gw / aspect;
  const cellW = Math.max(1, Math.floor((gw - gutter * (cols + 1)) / cols));
  const cellH = Math.max(1, Math.floor((gh - gutter * (rows + 1)) / rows));
  return {
    width: cols * cellW + gutter * (cols + 1),
    height: rows * cellH + gutter * (rows + 1),
    cellW,
    cellH,
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 在 RGB 画布上填一块矩形（支持 alpha 混合） */
export function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
  const [r, g, b] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    let idx = (py * width + x0) * 3;
    for (let px = x0; px < x1; px++) {
      if (alpha >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b;
      } else {
        buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha);
        buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha);
        buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha);
      }
      idx += 3;
    }
  }
}

/** 单字符步进宽度（含字间距）；冒号比数字窄一截，省横向像素。 */
function glyphAdvance(ch, scale) {
  if (ch === ':') return Math.max(2, Math.round(DIGIT_W * scale * 0.45)) + scale;
  return (DIGIT_W + 1) * scale;
}

/** 用点阵字形画一个字符串（支持 0-9、"-"、":"），返回实际占用尺寸 */
export function drawGlyphs(buf, width, height, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of String(text)) {
    if (ch === '-') {
      fillRect(buf, width, height, cursor, y + Math.floor(DIGIT_H * scale * 0.6),
        DIGIT_W * scale, Math.max(1, scale), color);
      cursor += glyphAdvance(ch, scale);
      continue;
    }
    if (ch === ':') {
      const cx = cursor + Math.floor(glyphAdvance(ch, scale) / 2) - Math.ceil(scale / 2);
      const top = y + Math.floor(DIGIT_H * scale * 0.25);
      const bot = y + Math.floor(DIGIT_H * scale * 0.65);
      fillRect(buf, width, height, cx, top, scale, scale, color);
      fillRect(buf, width, height, cx, bot, scale, scale, color);
      cursor += glyphAdvance(ch, scale);
      continue;
    }
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let row = 0; row < DIGIT_H; row++) {
      for (let col = 0; col < DIGIT_W; col++) {
        if (glyph[row][col] === '1') {
          fillRect(buf, width, height, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += glyphAdvance(ch, scale);
  }
  return { width: cursor - x, height: DIGIT_H * scale };
}

/**
 * 字形的整数缩放比：字号约占格高 22%，同时不超过格宽的 30%（两位编号时尤其重要）。
 * 大一点更抗压缩——低分辨率下"认一个字符"比"数格子"稳得多。
 */
export function badgeScale(cellH, cellW = Infinity, digits = 1, ratio = 0.18) {
  const byHeight = Math.floor((cellH * ratio) / DIGIT_H);
  const byWidth = Number.isFinite(cellW)
    ? Math.floor((cellW * 0.26) / (Math.max(1, digits) * (DIGIT_W + 1)))
    : byHeight;
  return Math.max(2, Math.min(byHeight, byWidth));
}

/** 量一行徽标文字的像素宽（与 drawGlyphs 步进一致） */
function measureGlyphWidth(text, scale) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === '-' || ch === ':' || DIGITS[ch]) w += glyphAdvance(ch, scale);
  }
  return Math.max(0, w - scale);
}

/**
 * 在一格里画编号徽标（黑底 + 黄字，左上角固定位置）。
 * 不透明优先：半透明底块在白板/雪景上会直接消失（实测见设计方案 §3.5）。
 * `label` 可含 `\n` 画多行（`index+time`：编号 + 时间码）。
 */
export function drawBadge(buf, width, height, x, y, cellW, cellH, label, ratio = 0.18) {
  const lines = String(label).split('\n').filter((s) => s.length > 0);
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 1);
  const scale = badgeScale(cellH, cellW, longest, ratio);
  const pad = Math.max(2, Math.round(cellH * 0.025));
  const lineGap = Math.max(1, Math.round(scale * 0.5));
  const textW = Math.max(...lines.map((line) => measureGlyphWidth(line, scale)));
  const textH = lines.length * DIGIT_H * scale + (lines.length - 1) * lineGap;
  fillRect(buf, width, height, x, y, textW + pad * 2, textH + pad * 2, BADGE_BG, BADGE_ALPHA);
  let cy = y + pad;
  for (const line of lines) {
    drawGlyphs(buf, width, height, line, x + pad, cy, scale, BADGE_FG);
    cy += DIGIT_H * scale + lineGap;
  }
  return { w: textW + pad * 2, h: textH + pad * 2 };
}

/** 空位：灰底 + 居中横杠，且绝对不编号 */
export function drawPadding(buf, width, height, x, y, cellW, cellH) {
  fillRect(buf, width, height, x, y, cellW, cellH, PAD_FILL);
  const barW = Math.max(6, Math.round(cellW * 0.32));
  const barH = Math.max(2, Math.round(cellH * 0.03));
  fillRect(buf, width, height,
    x + Math.round((cellW - barW) / 2), y + Math.round((cellH - barH) / 2),
    barW, barH, PAD_GLYPH);
}

/**
 * 把若干帧（rawvideo rgb24）拼成一张画布。
 * @param {{frames:Array<{buffer:Buffer, index:number}|null>, cols:number, rows:number,
 *          cellAspect:number, budget?:number, gutter?:number, burn?:'index'|'none'|'index+time'}} opts
 *   frames 顺序对应格位 1..cols*rows；null = 空位（补灰）
 * @returns {{buffer:Buffer,width:number,height:number,cellW:number,cellH:number}}
 */
export function composeSheet(opts) {
  const {
    frames, cols, rows, cellAspect, budget = 640_000, gutter = GUTTER,
    burn = 'index', badgeRatio = 0.18,
  } = opts;
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (frames.length > cols * rows) throw new RangeError('more frames than cells');
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, cellAspect, budget, gutter);
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = BACKGROUND[0]; buf[i + 1] = BACKGROUND[1]; buf[i + 2] = BACKGROUND[2];
  }

  for (let pos = 0; pos < cols * rows; pos++) {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const x = gutter + c * (cellW + gutter);
    const y = gutter + r * (cellH + gutter);
    const frame = frames[pos];
    if (!frame) {
      drawPadding(buf, width, height, x, y, cellW, cellH);
      continue;
    }
    blit(buf, width, height, x, y, cellW, cellH, frame.buffer);
    if (burn === 'none') continue;
    const label = burn === 'index+time' && Number.isFinite(frame.t)
      ? `${frame.index}\n${formatBadgeTime(frame.t)}`
      : frame.index;
    drawBadge(buf, width, height, x + 2, y + 2, cellW, cellH, label, badgeRatio);
  }
  return { buffer: buf, width, height, cellW, cellH };
}

/** 把一格 rawvideo（尺寸必须等于 cellW×cellH）贴到画布上 */
export function blit(dst, dstW, dstH, x, y, cellW, cellH, src) {
  const need = cellW * cellH * 3;
  if (src.length < need) throw new RangeError(`frame buffer too small: ${src.length} < ${need}`);
  for (let row = 0; row < cellH; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dstH) continue;
    const sStart = row * cellW * 3;
    const dStart = (dy * dstW + x) * 3;
    src.copy(dst, dStart, sStart, sStart + cellW * 3);
  }
}

/* ---------------------------------------------------------------- 音频条带 */

export const STRIP_BG = [11, 11, 13];
export const STRIP_BAR = [63, 184, 175];
export const STRIP_SILENCE = [42, 42, 46];
export const STRIP_TICK = [255, 235, 59];
export const STRIP_SEP = [60, 60, 66];

/**
 * 在画布底部接一条音频带：响度包络（越高越响）+ 静音块 + 切点刻度。
 *
 * 关键价值是**同一条时间轴**：模型能把"第 5 格"和"这里最响"直接对上，
 * 不用自己在脑子里做时间映射。同图内不额外花 token。
 *
 * @param {{buffer:Buffer,width:number,height:number}} sheet composeSheet 的产物
 * @param {{loudness?:{series:number[],step:number}, silences?:Array<{from:number,to:number}>,
 *          cuts?:number[], window:{from:number,to:number}, stripH?:number}} opts
 */
export function addAudioStrip(sheet, opts) {
  const { buffer, width, height } = sheet;
  const { loudness, silences = [], cuts = [], window: win } = opts;
  const stripH = opts.stripH ?? Math.max(24, Math.round(width * 0.055));
  const out = Buffer.alloc(width * (height + stripH) * 3);
  buffer.copy(out, 0, 0, buffer.length);

  const base = height * width * 3;
  for (let i = base; i < out.length; i += 3) {
    out[i] = STRIP_BG[0]; out[i + 1] = STRIP_BG[1]; out[i + 2] = STRIP_BG[2];
  }

  const series = loudness?.series ?? [];
  const step = loudness?.step ?? 0.1;
  const span = Math.max(0.001, win.to - win.from);
  const t2x = (t) => Math.round(((t - win.from) / span) * (width - 1));

  // 静音块：整段压暗，先铺底
  for (const s of silences) {
    const x0 = Math.max(0, t2x(s.from));
    const x1 = Math.min(width - 1, t2x(s.to));
    for (let x = x0; x <= x1; x++) {
      for (let y = 0; y < stripH; y++) {
        const i = ((height + y) * width + x) * 3;
        out[i] = STRIP_SILENCE[0]; out[i + 1] = STRIP_SILENCE[1]; out[i + 2] = STRIP_SILENCE[2];
      }
    }
  }

  // 响度包络：按列聚合，避免 600 列里丢细节
  if (series.length > 0) {
    const audible = series.filter((v) => v > -70);
    const sorted = [...audible].sort((a, b) => a - b);
    // 参照下限至少取到 hi-12dB：否则「全程恒定响度」的素材（如测试音、压得很平的成片）
    // 会被归一化成一条几乎贴底的细线，看起来像坏了。
    const hi = sorted[Math.floor(sorted.length * 0.97)] ?? -10;
    const lo = Math.min(sorted[Math.floor(sorted.length * 0.1)] ?? -60, hi - 12);
    const range = Math.max(6, hi - lo);
    for (let x = 0; x < width; x++) {
      const t0 = win.from + (x / width) * span;
      const i0 = Math.max(0, Math.floor((t0 - win.from) / step));
      const i1 = Math.max(i0 + 1, Math.min(series.length, Math.ceil(((t0 - win.from) + span / width) / step)));
      let peak = -120;
      for (let i = i0; i < i1; i++) peak = Math.max(peak, series[i]);
      const norm = Math.max(0, Math.min(1, (peak - lo) / range));
      const barH = Math.round(norm * (stripH - 4));
      for (let y = 0; y < barH; y++) {
        const py = height + stripH - 1 - y;
        const i = (py * width + x) * 3;
        out[i] = STRIP_BAR[0]; out[i + 1] = STRIP_BAR[1]; out[i + 2] = STRIP_BAR[2];
      }
    }
  }

  // 切点刻度：顶部短竖线（过密时抽稀，避免糊成黄带）
  for (const t of thinCutTicks(cuts, { from: win.from, to: win.to, maxTicks: Math.max(40, Math.floor(width / 3)) })) {
    const x = t2x(t);
    for (let y = 0; y < Math.max(3, Math.round(stripH * 0.35)); y++) {
      const i = ((height + y) * width + x) * 3;
      out[i] = STRIP_TICK[0]; out[i + 1] = STRIP_TICK[1]; out[i + 2] = STRIP_TICK[2];
    }
  }

  // 与宫格之间的分隔线
  for (let x = 0; x < width; x++) {
    const i = (height * width + x) * 3;
    out[i] = STRIP_SEP[0]; out[i + 1] = STRIP_SEP[1]; out[i + 2] = STRIP_SEP[2];
  }

  return { buffer: out, width, height: height + stripH, stripH };
}

/* ---------------------------------------------------------------- 锐度 */

/**
 * Laplacian 方差：越大越锐。用来避开"淡入/对焦中/高斯模糊转场"的中间帧。
 *
 * 为什么直方图不够：模糊不改变颜色分布，`thumbnail` 的"最接近均值"判据对
 * 模糊→清晰这种渐变完全不敏感。实测概念 PV 的片尾人员表就中过招：
 * 开头那 1 秒是高斯模糊，`thumbnail` 照样选它当代表帧。
 */
export function sharpness(buf, width, height) {
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < buf.length; i += 3, p++) {
    gray[p] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  }
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      sum += v;
      sum2 += v * v;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sum2 / count - mean * mean;
}

/**
 * 切点刻度抽稀：同一窗口内最多画 maxTicks 根，均匀保留，避免蒙太奇糊成黄带。
 * @param {number[]} cuts
 * @param {{from:number,to:number,maxTicks?:number}} opts
 */
export function thinCutTicks(cuts, { from, to, maxTicks = 80 } = {}) {
  const lo = Number(from);
  const hi = Number(to);
  const list = [...(cuts || [])]
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= lo && t <= hi)
    .sort((a, b) => a - b);
  const cap = Math.max(1, Math.floor(maxTicks));
  if (list.length <= cap) return list;
  const out = [];
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * (list.length - 1)) / (cap - 1));
    const t = list[idx];
    if (!out.length || out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

/**
 * 锐度搜索窗口：有 focusAt（规划代表时刻）时，在其附近小窗内采候选，避免漂到段两端。
 * @returns {{at:number,dur:number,seedTimes:number[]}}
 */
export function sharpSearchWindow({
  at, dur, focusAt, focusRadius, candidates = 3, margin = 0.25,
} = {}) {
  const safeDur = Math.max(0, Number(dur) || 0);
  const start = Number(at) || 0;
  let searchAt = start;
  let searchDur = safeDur;
  const focus = Number(focusAt);
  if (Number.isFinite(focus) && safeDur > 0) {
    const radius = Number.isFinite(focusRadius)
      ? Math.max(0.1, focusRadius)
      : Math.min(2, Math.max(0.4, safeDur * 0.35));
    const lo = Math.max(start, focus - radius);
    const hi = Math.min(start + safeDur, focus + radius);
    if (hi > lo + 0.05) {
      searchAt = lo;
      searchDur = hi - lo;
    }
  }
  const pad = Math.min(margin, searchDur / 3);
  const span = Math.max(0, searchDur - pad * 2);
  const times = [];
  if (candidates <= 1 || span < 0.1) {
    times.push(searchDur > 0 ? searchAt + searchDur / 2 : searchAt);
  } else {
    for (let i = 0; i < candidates; i++) {
      times.push(searchAt + pad + (span * i) / (candidates - 1));
    }
  }
  if (Number.isFinite(focus) && focus >= start && focus <= start + safeDur) {
    const near = times.some((t) => Math.abs(t - focus) < 0.04);
    if (!near) times.push(focus);
  }
  return { at: searchAt, dur: searchDur, seedTimes: times.sort((a, b) => a - b) };
}

/**
 * 段内取最锐的一帧：均匀取 candidates 个候选点，各抽一帧，比 Laplacian 方差。
 * 传入 focusAt（绝对秒）时优先在代表时刻附近搜索。
 *
 * 成本：candidates 次「seek + 解 1 帧」，而不是解码整段。3 帧 ≈ 3 倍单帧耗时，
 * 但仍是毫秒级——真正的开销是进程启动，不是解码。
 */
export async function extractSharpest(opts) {
  const {
    input, at, dur, cellW, cellH, ffmpegPath = DEFAULT_FFMPEG,
    candidates = 3, margin = 0.25, timeoutMs, focusAt, focusRadius,
  } = opts;
  const { seedTimes } = sharpSearchWindow({
    at, dur, focusAt, focusRadius, candidates, margin,
  });
  const picked = await Promise.all(seedTimes.map((t) =>
    extractFrameRaw({ input, at: t, cellW, cellH, ffmpegPath, timeoutMs })
      .then((f) => ({ ...f, sharp: sharpness(f.buffer, cellW, cellH) }))));
  return picked.reduce((best, cur) => (cur.sharp > best.sharp ? cur : best));
}

/* ---------------------------------------------------------------- ffmpeg IO */

function exec(args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
      else resolve({ stdout: Buffer.concat(out), stderr: err });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

/** cover 缩放：等比放大到完全覆盖 cell，再居中裁切（绝不变形） */
export const coverFilter = (cellW, cellH) =>
  `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH}`;

const PTS_RE = /pts_time:([0-9.]+)/g;

/**
 * 取一帧，返回 rawvideo rgb24（正好 cellW*cellH*3 字节）与真实时刻。
 * @param {{input:string, at:number, dur?:number, cellW:number, cellH:number,
 *          ffmpegPath?:string, mode?:'mid'|'thumb', timeoutMs?:number}} opts
 */
export async function extractFrameRaw(opts) {
  const {
    input, at, dur, cellW, cellH, ffmpegPath = DEFAULT_FFMPEG, mode = 'mid', timeoutMs,
  } = opts;
  const filter = coverFilter(cellW, cellH);
  let args;
  let seek;
  if (mode === 'thumb' && dur > 0) {
    // 段内取"直方图最接近该段均值"的帧：对溶解/过曝/空镜比硬取中点稳
    seek = at;
    const n = Math.max(2, Math.min(300, Math.round(dur * 25)));
    args = ['-hide_banner', '-v', 'info', '-nostdin', '-ss', String(at), '-t', String(dur), '-i', input,
      '-an', '-sn', '-vf', `thumbnail=n=${n},showinfo,${filter}`, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  } else {
    seek = dur > 0 ? at + dur / 2 : at;
    args = ['-hide_banner', '-v', 'error', '-nostdin', '-ss', String(seek), '-i', input,
      '-an', '-sn', '-vf', filter, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  }
  const { stdout, stderr } = await exec([ffmpegPath, ...args], { timeoutMs });
  const need = cellW * cellH * 3;
  if (stdout.length < need) {
    throw new Error(`frame @${seek.toFixed(2)}s too small: ${stdout.length} < ${need}`);
  }
  let actual = seek;
  if (mode === 'thumb') {
    const hits = [...stderr.matchAll(PTS_RE)].map((m) => Number(m[1]));
    if (hits.length > 0) actual = at + hits[hits.length - 1];
  }
  return { buffer: Buffer.from(stdout.subarray(0, need)), t: actual };
}

/**
 * 把 rawvideo 画布编码成 **PNG 字节**（内存里，不落盘）。
 *
 * 宿主 `ctx.attachments.saveImage()` 会**解码**校验传入字节，所以必须给真正的
 * PNG，不能给 raw RGB（媒体类型写 image/png 但内容是裸像素 → "Unsupported or malformed image data"）。
 */
export async function encodePngBuffer(buffer, width, height, opts = {}) {
  const { ffmpegPath = DEFAULT_FFMPEG, timeoutMs = 60_000 } = opts;
  const { stdout } = await exec([ffmpegPath, '-hide_banner', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { input: buffer, timeoutMs });
  if (stdout.length < 8 || stdout[0] !== 0x89 || stdout.subarray(1, 4).toString() !== 'PNG') {
    throw new Error(`PNG encode produced ${stdout.length} bytes of non-PNG output`);
  }
  return stdout;
}

/** 把画布编码成图片（PNG 无损 / JPEG 体积小） */
export async function encodeRaw(buffer, width, height, out, opts = {}) {
  const { ffmpegPath = DEFAULT_FFMPEG, quality, timeoutMs = 60_000 } = opts;
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-',
    '-frames:v', '1'];
  if (quality !== undefined) args.push('-q:v', String(quality));
  args.push(out);
  await exec(args, { input: buffer, timeoutMs });
  return out;
}
