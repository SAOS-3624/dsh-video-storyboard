/**
 * tools/shared.js — 分镜类工具（storyboard / zoom）共用的宿主胶水。
 *
 * 这里只做"把库层的结果变成宿主认得的返回值"：提交附件、渲染清单。
 * **不要在这里读 args** —— 每个工具的 schema 各自独立，共用的读法会让
 * `test/schema-audit.test.mjs` 分不清某个参数到底属于哪个工具。
 */

import { runStoryboard } from '../storyboard/pipeline.js';
import { formatForDetail } from '../storyboard/format.js';

/** 把每张分镜图提交成附件。两个入口各写过一遍这段循环，收成一处 —— mediaType / 命名改一次就够。 */
export async function attachSheetImages(ctx, result) {
  // **运行期探测，不是 inject 声明**（原因见 src/index.js 的 inject 注释）：
  // 宿主没注册 attachments 时，插件必须照样能加载、工具照样能跑，只是拿不到图片。
  const saveImage = ctx?.attachments?.saveImage;
  if (typeof saveImage !== 'function') {
    throw new Error('this DSH build has no `attachments` service, so the storyboard image '
      + 'cannot be shown. Upgrade DSH, or use `video_probe` / `video_locate` (text only).');
  }
  const images = [];
  for (const sheet of result.sheets) {
    images.push(await saveImage({
      data: sheet.png,
      mediaType: 'image/png',
      name: `storyboard-${sheet.sheet}.png`,
    }));
  }
  return images;
}

/**
 * 跑一次管线，把每张图提交成附件，返回规范值 { images, text }。
 *
 * 预算：单次工具结果有上限，超出会被宿主折进磁盘（模型常常不会去读）。
 * 24k 字符 ≈ 一张 16 格图的完整清单还有余量；超了就在 cell 边界截断并给出续读方式。
 */
export async function runAndAttach(ctx, options, problems, cellRange) {
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  const result = await runStoryboard(options);
  return {
    images: await attachSheetImages(ctx, result),
    text: formatForDetail(result, { detail: options.detail, cellRange }),
  };
}

