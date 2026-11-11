/**
 * probe.js — ffprobe 封装 + 旋转归一。纯 IO 层，不做决策。
 *
 * 两个安静出错的坑（都有测试）：
 *  1. 手机竖拍常是"编码 1920×1080 + rotation 90"，ffmpeg 解码会转正，ffprobe 报的是编码尺寸；
 *     拿编码尺寸去算 scale 会把画面拉扁。
 *  2. 末尾边界没有帧：时长的最后一帧在 duration - 1/fps 附近，-ss duration 抽不出东西。
 */

import { execFile } from 'node:child_process';

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE, describeMediaSearch } from './binaries.js';

/**
 * 回调式 execFile，**不用 promisify**。
 *
 * 有宿主的 `promisify` 实现会丢掉 execFile 的 custom symbol，只把 stdout 字符串当结果交回来
 * （用户实测：probe 的 catch 里读 `stderr.length` 直接 TypeError，报出来像是 ffprobe 坏了，
 * 其实是 promisify 坏了）。回调式的三个参数不会丢，而且这里本来就要 stdout + stderr 两样。
 */
function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, opts, (error, stdout, stderr) => {
      if (error) {
        // 把 stdout/stderr 挂在 error 上：调用方要能拿到 ffprobe 的原话去解释失败原因
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export { DEFAULT_FFMPEG, DEFAULT_FFPROBE };

/**
 * 从 cropdetect 的 stderr 里取最后一个 `crop=w:h:x:y`。
 *
 * cropdetect 每帧打一行，前面几帧常常是 `crop=0:0:0:0` 或全画幅（还没累积够），
 * 所以要**取最后一条**，不是第一条。
 */
export function parseCropdetect(stderr) {
  const hits = [...String(stderr ?? '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!hits.length) return null;
  const [, w, h, x, y] = hits[hits.length - 1];
  const box = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
  if (!(box.w > 0 && box.h > 0)) return null;
  return box;
}

/**
 * **画面里真正有内容的那块矩形**（去掉上下/左右的黑边）。
 *
 * 为什么必须检测：竖屏素材塞进横屏容器后，四成的付费像素是黑的。分镜本身不看那些像素，
 * 但它们照样按 42px 网格收钱，而且把画布比例拽成 16:9 —— 格子里一半是黑边。
 *
 * 做法：抽两个位置（1/3、2/3）各解 0.6 秒，两次结果取**并集**（更保守：宁可少裁不可多裁），
 * 再夹一层理智检查（面积 <20%、宽或高 <20% 都当检测失败）。
 *
 * 失败一律返回 null —— 拿不到就不能瞎裁，宁可留着黑边。
 *
 * @returns {Promise<{x:number,y:number,w:number,h:number}|null>}
 */
export async function detectContentBox({
  input, width, height, duration, ffmpegPath = DEFAULT_FFMPEG, timeoutMs = 15_000,
}) {
  const W = Number(width) || 0;
  const H = Number(height) || 0;
  const dur = Number(duration) || 0;
  if (!(W > 0 && H > 0)) return null;
  const spots = dur > 3 ? [dur / 3, (dur * 2) / 3] : [0];
  const boxes = [];
  for (const at of spots) {
    try {
      const { stderr } = await run(ffmpegPath, [
        '-hide_banner', '-nostdin', '-v', 'info',
        '-ss', String(Math.max(0, at)), '-t', '0.6', '-i', input,
        '-an', '-sn', '-vf', 'cropdetect=limit=24:round=2:reset=1',
        '-frames:v', '18', '-f', 'null', '-',
      ], { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs });
      const box = parseCropdetect(stderr);
      if (box) boxes.push(box);
    } catch {
      /* 这一处抽不到就算了，另一处还能用 */
    }
  }
  if (!boxes.length) return null;
  // 并集：x 取最小、右边取最大 —— 任一采样点里有内容的地方都不能裁掉
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const box = {
    x: Math.max(0, x0), y: Math.max(0, y0),
    w: Math.min(W, x1) - Math.max(0, x0), h: Math.min(H, y1) - Math.max(0, y0),
  };
  // 理智检查：检测器抽风时会吐出窄条，照着裁就是把画面切了
  if (!(box.w >= W * 0.2 && box.h >= H * 0.2)) return null;
  if (box.w * box.h < W * H * 0.2) return null;
  return box;
}


/** "25/1" | "30000/1001" → number | null */
export function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [num, den = '1'] = value.split('/');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 像素宽高比（SAR）：`4:3` / `1:1` / `0:1`。
 * 0:1 或缺失表示"未声明"，按方像素（1:1）处理。
 */
export function parseSar(value) {
  // ffprobe 的 sample_aspect_ratio 是 `4:3` 这种冒号写法（不是帧率的 `24/1` 斜杠写法）
  if (typeof value !== 'string' || !value.includes(':')) return 1;
  const [num, den = '1'] = value.split(':');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0 || a <= 0) return 1;
  return a / b;
}

/**
 * 显示宽高比（DAR）= 编码宽 × SAR / 编码高；转 90° 后取倒数。
 *
 * 为什么不能用 width/height 直接算：非方形像素的素材（DVD 时代的 1440×1080 存成 4:3 SAR、
 * 部分手机的变形录制）编码尺寸和**显示**尺寸不是一回事。用编码尺寸算比例，格子会被压扁/拉长，
 * 而模型对"人脸比例不对"是敏感的。
 */
export function displayAspect(codedW, codedH, sar, rotation = 0) {
  if (!(codedW > 0) || !(codedH > 0)) return 16 / 9;
  const dar = (codedW * (sar > 0 ? sar : 1)) / codedH;
  return Math.abs(rotation) % 180 === 90 ? 1 / dar : dar;
}

/** 旋转角归一化到 (-180, 180] */
export function normalizeRotation(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  let a = v % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.round(a);
}

/** 旋转 90/270 时，观众看到的宽高与编码宽高互换 */
export function uprightSize(codedWidth, codedHeight, rotation) {
  return Math.abs(rotation) % 180 === 90
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}

/** 末尾避让量：等分采样最后一帧若取 duration，会落在"不存在的帧"上 */
export const endEdge = (fps) => (fps > 0 ? 0.5 / fps : 0.02);

export async function probeVideo(input, { ffprobePath = DEFAULT_FFPROBE } = {}) {
  let stdout;
  try {
    ({ stdout } = await run(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
      { maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(describeMediaSearch('ffprobe'));
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe did not return JSON for "${input}"`);
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  if (!video) throw new Error(`"${input}" has no video stream`);
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const subtitle = streams.find((s) => s?.codec_type === 'subtitle');

  const duration =
    Number(parsed?.format?.duration) || Number(video?.duration) || 0;
  const rotation = normalizeRotation(
    video?.side_data_list?.find((d) => d?.rotation !== undefined)?.rotation ?? video?.tags?.rotate,
  );
  const coded = { width: Number(video.width) || 0, height: Number(video.height) || 0 };
  const { width, height } = uprightSize(coded.width, coded.height, rotation);
  // VFR 素材上 r_frame_rate 可能是 1000/1 之类的时间基噪声，avg_frame_rate 才是真实平均帧率。
  // 我们的窗口扫描要用 fps 换算时长，帧率错 → 时长错 → 格边界错。
  const rFps = parseRational(video.r_frame_rate);
  const avgFps = parseRational(video.avg_frame_rate);
  const fps = (rFps && rFps <= 240 ? rFps : null) ?? avgFps ?? 25;
  const sar = parseSar(video.sample_aspect_ratio);

  return {
    duration,
    width,
    height,
    coded,
    rotation,
    fps,
    sar,
    aspect: displayAspect(coded.width, coded.height, sar, rotation),
    videoCodec: video.codec_name ?? 'unknown',
    container: parsed?.format?.format_name ?? 'unknown',
    hasAudio: Boolean(audio),
    hasSubtitle: Boolean(subtitle),
    audioCodec: audio?.codec_name ?? null,
  };
}
