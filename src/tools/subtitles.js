/**
 * tools/subtitles.js — `video_subtitles` 的 execute。
 *
 * 什么都不算，只做三件事：把输入解析成本地文件 → 让库层裁+拼 → 交图和时间码。
 * 判据、裁剪、拼接全在 `storyboard/subtitle-strip.js` 里，这里不重复一遍。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInput } from '../storyboard/fetch.js';
import { buildSubtitleStrip, DEFAULT_BAND } from '../storyboard/subtitle-strip.js';
import { validateToolArgs } from '../storyboard/tool-spec.js';

const tc = (s) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

export async function execute(ctx, args) {
  const problems = validateToolArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-subsout-'));
  try {
    const out = join(dir, 'subtitle-strip.jpg');
    const { path } = await resolveInput(args.input, {
      cookies: args.cookies,
      allowAnonymous: args.allowAnonymous === true,
    });
    const r = await buildSubtitleStrip({
      input: path,
      from: args.from ?? 0,
      ...(args.to !== undefined ? { to: args.to } : {}),
      maxStrips: args.maxStrips ?? 24,
      stepSec: args.stepSec ?? 3,
      band: Array.isArray(args.band) ? args.band : null,
      times: Array.isArray(args.times) ? args.times : null,
      out,
    });

    const jpg = await readFile(out);
    const image = await ctx.attachments.saveImage({
      data: jpg, mediaType: 'image/jpeg', name: 'subtitle-strip.jpg',
    });

    // 时间码必须交出去：没有它，模型只能按"第几条"数，数错一个就全歪。
    const bandText = r.bandSource === 'explicit'
      ? `explicit ${(r.band[0] * 100).toFixed(0)}%–${(r.band[1] * 100).toFixed(0)}%`
      : r.bandSource === 'detected'
        ? `detected ${(r.band[0] * 100).toFixed(0)}%–${(r.band[1] * 100).toFixed(0)}%`
        : `bottom ${(DEFAULT_BAND[0] * 100).toFixed(0)}%–${(DEFAULT_BAND[1] * 100).toFixed(0)}% ` +
          '(fallback: no subtitle band detected — pass band:[y0,y1] if the subtitles sit higher)';
    const every = r.strips.length > 1
      ? (r.strips[1].t - r.strips[0].t).toFixed(1)
      : '—';
    const text = [
      `subtitle strip: ${r.strips.length} strips, top to bottom, ~${every}s apart · ` +
        `${tc(r.strips[0]?.t ?? 0)}–${tc(r.to)} · band = ${bandText}`,
      `timeline: ${r.strips.map((s) => tc(s.t)).join(' ')}`,
      'Read them in order: strip i (1-based) = the i-th time above. ' +
        'Blank strips mean no on-screen subtitle at that moment — that is information too, not a failure.',
    ].join('\n');

    return { images: [image], text };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
