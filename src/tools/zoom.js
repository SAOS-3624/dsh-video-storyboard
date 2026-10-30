/**
 * tools/zoom.js — `video_zoom` 的 execute。
 *
 * 两件事这里必须自己做（不能交给 boardOptions）：
 *   1. `cellId` → 该格的绝对时间区间。查不到就**明确报错并指路**，不悄悄退回一个猜的窗口。
 *   2. 链接模式下先设法拿到高清直链 —— storyboard 那次 `-J` 通常已经记下了，
 *      这里多半是内存命中；实在没有才真的再解析一次（2.4 s）。
 */

import { boardOptions } from '../board.js';
import { lookupCell } from '../cells.js';
import { resolveInput } from '../fetch.js';
import { isHttpUrl } from '../url.js';
import { resolveDirectUrl } from '../direct-url.js';
import { runStoryboard } from '../pipeline.js';
import { formatForDetail } from '../format.js';
import { validateZoomArgs } from '../tool-spec.js';
import { attachSheetImages } from './shared.js';

export async function execute(ctx, args) {
  const problems = validateZoomArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  // cellId → 该格的绝对时间区间（上一次分镜落下的表）。
  let from = args.from;
  let to = args.to;
  if (args.cellId !== undefined && args.cellId !== null) {
    const hit = await lookupCell(args.input, args.cellId);
    if (!hit) {
      throw new Error(`no cell map recorded for this input (cellId ${args.cellId}). ` +
        'Run video_storyboard on it first, or pass from/to.');
    }
    from = hit.from;
    to = hit.to;
  }
  // zoom 的参数只在一处定义（src/board.js）。这里先拿它的 fetchOptions 去解析直链，
  // 免得"扫描清晰度/zoom 清晰度"在解析和取帧两处出现两个值。
  const opts = boardOptions({ ...args, from, to }, { kind: 'zoom' });
  const fetchOptions = opts.fetchOptions;
  let frameSource = null;
  if (isHttpUrl(args.input)) {
    try {
      const resolved = await resolveInput(args.input, fetchOptions);
      frameSource = resolved.frameSource
        ?? await resolveDirectUrl(args.input, { ...fetchOptions, height: fetchOptions.zoomHeight });
    } catch {
      /* 直链拿不到就退回本地低清：糊一点，但整次调用不该失败 */
    }
  }
  const result = await runStoryboard({ ...opts, frameSource });
  return {
    images: await attachSheetImages(ctx, result),
    text: formatForDetail(result, { detail: args.detail ?? 'med' }),
  };
}

