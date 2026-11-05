/**
 * tools/help.js — `video_help` 的 execute。
 *
 * 全部价值在于"**不碰视频、不出图、零 token**"：模型在猜参数含义时，最便宜的确认方式
 * 就是读一页纸。正文在 `../storyboard/help.js`（干跑结果里印的是同一份）。
 */

import { videoHelp } from '../storyboard/help.js';

export async function execute(ctx, args) {
  return { text: videoHelp(args?.topic) };
}
