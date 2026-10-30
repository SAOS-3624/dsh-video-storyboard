/**
 * probe.js — ffprobe 封装 + 旋转归一。纯 IO 层，不做决策。
 *
 * 两个安静出错的坑（都有测试）：
 *  1. 手机竖拍常是"编码 1920×1080 + rotation 90"，ffmpeg 解码会转正，ffprobe 报的是编码尺寸；
 *     拿编码尺寸去算 scale 会把画面拉扁。
 *  2. 末尾边界没有帧：时长的最后一帧在 duration - 1/fps 附近，-ss duration 抽不出东西。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE, describeMediaSearch } from './binaries.js';

const run = promisify(execFile);

export { DEFAULT_FFMPEG, DEFAULT_FFPROBE };

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
