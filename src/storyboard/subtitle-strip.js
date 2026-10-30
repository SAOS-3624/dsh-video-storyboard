/**
 * subtitle-strip.js — 「把整片里的硬字幕一条条裁下来，纵向拼成一张长图」。
 *
 * 为什么需要（2026-10-31，用户那边真实发生的事）：另一个会话在对比两支 PV，那两支**没有字幕轨**、
 * 也没跑 ASR（`--transcript off`），字幕是烧在画面里的。它手上一个字都没有，只能自己
 * `ffmpeg crop + vstack` 手搓 —— 一次起 8 路输入，撞上 `0xC000012D`（提交内存超限）崩了两回。
 *
 * 插件原有的四个工具全是"按**时间**取帧"（storyboard / zoom / locate / probe），
 * 没有"跨时间裁同一区域再拼接"。这个文件补的就是那一块。
 *
 * 和 `ocr-subs.js` 的区别：那是**校正**（先有 ASR 文本，再去画面里对字，只采样几条）；
 * 这里是**读**（没有文本时，把字幕全部摊开给眼睛看）。两者共用 `ocr.js` 的字幕带检测。
 *
 * 内存纪律：裁剪**串行**、只留小图，最后一次 `vstack` 合成。
 * 这台机器 16GB、ASR 常驻 ~6.8GB 提交额，并发裁剪必崩（用户就是这么撞的）。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { detectSubtitleBand, ocrPython } from './ocr.js';

/**
 * 没有 OCR 时的兜底字幕带：画面底部 16%。
 *
 * 原来是 26%（0.72 起）。实测那支 PV 的中文字幕在 87%、英文在 92%，即 85%–97% ——
 * 26% 的带子里一多半是空的画面，裁出来的长图有大量无用的部分（用户原话
 * "感觉无用部分太多了"）。收到 82%–98% 后条带高度从 148px 降到 96px，同样条数图短了三分之一。
 *
 * 烧在上方或中间的（日式竖排、顶部提示条）会漏 —— 那种情况让调用方显式传 band。
 */
export const DEFAULT_BAND = [0.82, 0.98];

/** 条带输出宽度。1280 够认出中文，再宽只是放大字节数。 */
export const STRIP_WIDTH = 1280;

const run = (bin, args, { timeoutMs = 120_000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) return resolve();
    const tail = err.trim().split('\n').slice(-2).join(' | ');
    reject(new Error(`ffmpeg exited ${code}${tail ? `: ${tail}` : ''}`));
  });
});

/**
 * 时间轴上摊开哪些时刻。
 *
 * 均匀抽样而不是"检测字幕变化点"：后者要先逐帧比像素，比裁几十条贵得多，
 * 而这条工具的用途是"让人一眼扫完整片字幕"，均匀已经够 —— 重复的那几条
 * 在长图上紧挨着，反而能看出"这句话停了多久"。
 */
export function planStripTimes({ from = 0, to, maxStrips = 24, stepSec = 3 } = {}) {
  const dur = Math.max(0, to - from);
  if (!(dur > 0)) return [];
  const n = Math.max(1, Math.min(maxStrips, Math.ceil(dur / Math.max(0.5, stepSec))));
  const step = dur / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(+(from + step * (i + 0.5)).toFixed(2));
  return out;
}

/** 定字幕带：显式给了就用；能跑 OCR 就检测一次；都不行退回底部默认值。 */
export async function resolveBand({ input, ffmpegPath, from, to, workDir, override = null }) {
  if (Array.isArray(override) && override.length === 2) {
    return { band: override.map(Number), source: 'explicit' };
  }
  try {
    const python = await ocrPython();
    if (python) {
      const probes = [];
      for (const [i, r] of [0.2, 0.5, 0.8].entries()) {
        const out = join(workDir, `probe${i}.jpg`);
        await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-ss',
          String(Math.max(0, from + (to - from) * r)), '-i', input,
          '-frames:v', '1', '-q:v', '2', out], { timeoutMs: 60_000 });
        probes.push(out);
      }
      const hit = await detectSubtitleBand({ python, frames: probes });
      if (hit?.band) return { band: hit.band, source: 'detected' };
    }
  } catch {
    /* 检测是可选的：装不上 python / rapidocr 时不该让整条路失败 */
  }
  return { band: DEFAULT_BAND, source: 'default-bottom' };
}

/**
 * 裁一条字幕带（串行调用，不要并发）。
 * @returns {Promise<string>} 输出的 PNG 路径
 */
async function grabStrip({ input, ffmpegPath, at, band, out, width = STRIP_WIDTH }) {
  const [y0, y1] = band;
  const crop = `crop=iw:ih*${(y1 - y0).toFixed(4)}:0:ih*${y0.toFixed(4)},scale=${width}:-1`;
  await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-ss', String(Math.max(0, at)),
    '-i', input, '-frames:v', '1', '-vf', crop, out]);
  return out;
}

/**
 * 把若干张等宽图片纵向拼起来。**一次 ffmpeg 进程**，输入用文件而不是管道。
 * @returns {Promise<{height:number, width:number, bytes:number}>}
 */
async function vstack({ ffmpegPath, images, out }) {
  if (images.length === 0) throw new Error('no strips to stack');
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const p of images) args.push('-i', p);
  // 每张等高（同一 crop + scale），vstack 不需要额外 padding
  const filter = images.length === 1 ? 'null' : `vstack=inputs=${images.length}`;
  // JPEG q=4：实测 16 条 1280 宽的图 PNG 1804KB、JPEG 287KB，而字幕（黑底白字）照样认得清。
  // 这条工具的唯一用户是'看图读字'，1.8MB 的图上传慢、宿主也更容易把它折进磁盘。
  args.push('-filter_complex', filter, '-q:v', '4', out);
  await run(ffmpegPath, args, { timeoutMs: 180_000 });
  const st = await stat(out);
  // 高度从 filter 结果反推太麻烦，这里只在单条时算得准；调用方主要关心文件存在和大小
  return { bytes: st.size };
}

/** 拿时长（`to` 没给时用）。ffprobe 读容器头，不解码。 */
async function mediaDuration({ input, ffprobePath = DEFAULT_FFPROBE }) {
  const out = await new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', input], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `ffprobe ${code}`))));
  });
  const n = Number(String(out).trim());
  if (!(n > 0)) throw new Error(`cannot read duration: ${JSON.stringify(String(out).trim())}`);
  return n;
}

/**
 * 扫字幕带，找出「字幕换句」的时刻 —— **纯视觉，不碰 ASR**。
 *
 * 为什么不能用 ASR 的时间码对齐（2026-10-31 用户当场指出，并且是对的）：
 * ASR 在唱歌 / 纯音乐 / 多语言艺术字上会漏掉大半 —— 实测那支 92 秒 PV 只转出 **4 段 35 字**，
 * 而画面上有十几句。拿这 4 个时刻去裁字幕带，只会覆盖 4 句、漏掉 10 句，**越对越错**。
 * 字幕是画在像素上的，那就直接看像素：变了就是换句，没变就是同一句。这个过程不需要任何文本。
 *
 * 做法：把字幕带压成 96×12 灰度、4 fps，一次 ffmpeg 吐出原始字节流（250 秒 ≈ 1.1 MB，
 * 比逐帧调 500 次 ffmpeg 便宜两个数量级），再比相邻帧的平均绝对差。
 *
 * @returns {Promise<Array<{t:number, diff:number}>>} 变化时刻（已按 minGap 合并）
 */
export async function scanBandChanges({
  input, ffmpegPath = DEFAULT_FFMPEG, band, from = 0, to,
  fps = 4, w = 96, h = 12, threshold = 12, minGap = 0.9,
}) {
  const [y0, y1] = band;
  const vf = `crop=iw:ih*${(y1 - y0).toFixed(4)}:0:ih*${y0.toFixed(4)},scale=${w}:${h},format=gray,fps=${fps}`;
  const args = ['-hide_banner', '-v', 'error'];
  if (from > 0) args.push('-ss', String(from));
  if (Number.isFinite(to) && to > from) args.push('-t', String(to - from));
  args.push('-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', '-');

  const buf = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim().split('\n').slice(-1)[0] || `ffmpeg ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });

  const frameSize = w * h;
  const n = Math.floor(buf.length / frameSize);
  const out = [];
  for (let i = 1; i < n; i += 1) {
    const cur = buf.subarray(i * frameSize, (i + 1) * frameSize);
    const prev = buf.subarray((i - 1) * frameSize, i * frameSize);
    let sum = 0;
    for (let k = 0; k < frameSize; k += 1) sum += Math.abs(cur[k] - prev[k]);
    const diff = sum / frameSize;
    if (diff < threshold) continue;
    const t = from + i / fps;
    // 淡入淡出会连着好几帧都过阈值：靠得太近的当同一次变化
    if (out.length > 0 && t - out[out.length - 1].t < minGap) continue;
    out.push({ t: +t.toFixed(2), diff: +diff.toFixed(1) });
  }
  return out;
}

/**
 * 主流程。
 *
 * @param {object} o
 * @param {string} o.input 视频路径
 * @param {string} [o.ffmpegPath]
 * @param {number} [o.from=0] @param {number} [o.to] 秒（不给就取全片）
 * @param {number} [o.maxStrips=24] 最多几条（也决定图有多长）
 * @param {number} [o.stepSec=3] 目标间隔；实际会按 maxStrips 放宽
 * @param {[number,number]|null} [o.band] 显式字幕带（y0/y1 占画面高度的比例）
 * @param {string} o.out 输出 PNG
 * @returns {Promise<{out:string, band:number[], bandSource:string, strips:Array<{t:number, bytes:number}>, bytes:number, to:number}>}
 */
export async function buildSubtitleStrip({
  input, ffmpegPath = DEFAULT_FFMPEG, ffprobePath = DEFAULT_FFPROBE, from = 0, to,
  maxStrips = 24, stepSec = 3, band = null, out, times = null,
}) {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-subs-'));
  try {
    const end = Number.isFinite(Number(to)) && Number(to) > from
      ? Number(to)
      : await mediaDuration({ input, ffprobePath });
    const resolved = await resolveBand({ input, ffmpegPath, from, to: end, workDir, override: band });
    // 只有**可靠的时间码**才对齐；没有就老实均匀抽样。理由（2026-10-31 实测）：
    //
    //   · ASR 的时间码不能用 —— 唱歌/纯音乐片上它漏掉大半（92 秒 PV 只转出 4 段 35 字），
    //     拿它去对齐只会覆盖更少、还可能是错的时刻。**越对越错。**
    //   · 像素变化也不行 —— 字幕带里混着画面运动，阈值提到 40 还有 32 个"变化点"，
    //     分不清是换字幕还是人物走过。要分清得有精确的字幕框，而那要靠 OCR 检测，
    //     没装 rapidocr 的机器上就是默认那条 26% 高的带子。
    //
    // 所以：调用方有字幕轨或 video_locate 的真实时间码 → 传 times，一条对应一句，省一半条数；
    // 没有 → 均匀抽样。宁可多几条空白，也不拿一个不可靠的时刻表去"精确"对齐。
    const plan = Array.isArray(times) && times.length > 0
      ? times.map(Number).filter((t) => Number.isFinite(t) && t >= from && t <= end)
        .slice(0, Math.max(1, maxStrips))
      : planStripTimes({ from, to: end, maxStrips, stepSec });
    if (plan.length === 0) throw new RangeError('empty time window');

    const images = [];
    const strips = [];
    // **串行**：一次只开一个 ffmpeg，峰值内存 = 一张条带
    for (const [i, t] of plan.entries()) {
      const p = join(workDir, `s${String(i).padStart(3, '0')}.png`);
      await grabStrip({ input, ffmpegPath, at: t, band: resolved.band, out: p });
      const st = await stat(p);
      images.push(p);
      strips.push({ t, bytes: st.size });
    }

    await vstack({ ffmpegPath, images, out });
    const st = await stat(out);
    return {
      out,
      band: resolved.band,
      bandSource: resolved.source,
      strips,
      bytes: st.size,
      to: end,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
