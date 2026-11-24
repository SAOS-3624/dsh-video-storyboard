/**
 * tools/video-index.js — `video_index` 的 execute。
 *
 * 只有三件事：校验参数 → 取索引（`sprite-index.js`）→ 把雪碧图交成附件 + 印映射表。
 * **不碰解码、不碰 ffmpeg、不碰缓存** —— 这条路的全部价值就是"不用碰它们"。
 */

import { fetchSpriteIndex, formatIndex } from '../storyboard/sprite-index.js';
import { validateIndexArgs } from '../storyboard/tool-spec.js';
import { attachPngImages } from './shared.js';

export async function execute(ctx, args) {
  const problems = validateIndexArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  const log = (m) => { try { ctx?.logger?.info?.(`[video_index] ${m}`); } catch { /* ignore */ } };
  const idx = await fetchSpriteIndex({
    input: args.input,
    // `allParts` 与 `page` 两种说法：前者优先（显式"全要"比默认值更强）
    page: args.allParts ? 'all' : (args.page ?? 1),
    maxGapSec: args.maxGapSec ?? 10,
    log,
  });

  /**
   * 每张雪碧图都交成附件。**不重编码**（#95 里定过的形态）：原图已经是 JPEG，
   * 重编码一次只会损失细节、还多一次 CPU。
   */
  const items = [];
  for (const part of idx.parts) {
    part.sheets.forEach((sheet, i) => {
      items.push({
        data: sheet.data,
        mediaType: 'image/jpeg',
        name: `index-${idx.bvid}-p${part.part.page}-${i + 1}.jpg`,
      });
    });
  }
  const images = await attachPngImages(ctx, items);

  return { images, text: formatIndex(idx) };
}
