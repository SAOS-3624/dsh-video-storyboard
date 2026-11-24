/**
 * tools/video-danmaku.js — `video_danmaku` 的 execute。
 *
 * 取弹幕（`danmaku.js::fetchDanmaku`）→ 合并判型（纯函数）→ 印表。
 * 不出图，所以不碰 attachments。
 */

import { fetchDanmaku, formatDanmaku, summarizeDanmaku } from '../storyboard/danmaku.js';
import { validateDanmakuArgs } from '../storyboard/tool-spec.js';

export async function execute(ctx, args) {
  const problems = validateDanmakuArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  const log = (m) => { try { ctx?.logger?.info?.(`[video_danmaku] ${m}`); } catch { /* ignore */ } };
  const got = await fetchDanmaku({ input: args.input, page: args.page ?? 1 });
  if (got.rows.length === 0) {
    // 空弹幕是**真实存在**的状态（新稿 / 关了弹幕），不是故障 —— 别让它长得像 bug
    return {
      text: `${got.bvid} 第 ${got.part.page} 集（cid ${got.part.cid}）没有弹幕`
        + `（接口返回 0 条）。这可能是新稿、或者 UP 主关了弹幕池 —— 不是工具出错。`,
    };
  }

  const report = summarizeDanmaku(got.rows, {
    topShort: args.topShort ?? 20,
    minChars: args.minChars ?? 10,
    maxLong: args.maxLong ?? 60,
    filterAds: args.filterAds ?? true,
  });
  log(`${got.bvid} p${got.part.page}: ${got.rows.length} 条 → ${report.groupCount} 组，`
    + `覆盖 ${(report.coverage * 100).toFixed(0)}%`);
  return { text: formatDanmaku(report, { stats: got.stats }) };
}
