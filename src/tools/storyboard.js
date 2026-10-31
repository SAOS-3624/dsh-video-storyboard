/**
 * tools/storyboard.js — `video_storyboard` 的 execute。
 *
 * 参数 → runStoryboard 选项全在 board.js 的 `boardOptions(args, {kind:'board'})` 里，
 * 这里只补一个"清单分页"的 cellRange。
 */

import { boardOptions } from '../storyboard/board.js';
import { validateToolArgs } from '../storyboard/tool-spec.js';
import { runAndAttach } from './shared.js';

export function execute(ctx, args) {
  return runAndAttach(
    ctx,
    boardOptions(args, { kind: 'board' }),
    validateToolArgs(args),
    args.cellRange ?? null,
  );
}

