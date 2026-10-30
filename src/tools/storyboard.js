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
    // 摊开优先只属于 board（zoom/watch 是短窗口，不需要换格数）——
    // 放在这里而不是 board.js，是因为 schema 审计按工具扫，zoom 的 schema 不该被牵连。
    { ...boardOptions(args, { kind: 'board' }), tileFirst: args.tileFirst === true },
    validateToolArgs(args),
    args.cellRange ?? null,
  );
}

