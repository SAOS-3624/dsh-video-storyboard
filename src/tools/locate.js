/**
 * tools/locate.js — `video_locate` 的 execute。
 *
 * 纯文本：不读帧、不出图。没有现成转写时补跑一次 textOnly 的管线（复用 storyboard
 * 的全套配置），跑完它会自己把转写塞进 locate 的缓存里，下次直接命中。
 */

import { formatMatches, matchSegments, recallSegments } from '../locate.js';
import { resolveInput } from '../fetch.js';
import { runStoryboard } from '../pipeline.js';

export async function execute(ctx, args) {
  if (!args?.input) throw new Error('input is required');
  if (!args?.query) throw new Error('query is required');
  const max = Math.min(20, Math.max(1, Number(args.max) || 5));
  const resolved = await resolveInput(args.input, {
    cookies: args.cookies, allowAnonymous: args.allowAnonymous === true,
  });
  let segments = recallSegments(resolved.path);
  if (!segments) {
    await runStoryboard({
      input: resolved.path, from: args.from, to: args.to, cells: 1,
      transcriptFile: args.transcriptFile, textOnly: true, encode: false,
    });
    segments = recallSegments(resolved.path);
  }
  if (!segments || segments.length === 0) {
    return {
      text: 'no transcript available for this file: run video_storyboard first, ' +
        'or pass transcriptFile. Without a transcript there is nothing to match on.',
    };
  }
  const lo = Number.isFinite(args.from) ? args.from : 0;
  const hi = Number.isFinite(args.to) ? args.to : Infinity;
  const inWindow = segments.filter((x) => x.to >= lo && x.from <= hi);
  const matches = matchSegments(inWindow, args.query, { max });
  return { text: formatMatches(args.query, matches, { total: inWindow.length }) };
}

