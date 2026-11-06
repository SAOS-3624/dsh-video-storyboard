/**
 * tools/shared.js — 分镜类工具（storyboard / zoom）共用的宿主胶水。
 *
 * 这里只做"把库层的结果变成宿主认得的返回值"：提交附件、渲染清单。
 * **不要在这里读 args** —— 每个工具的 schema 各自独立，共用的读法会让
 * `test/schema-audit.test.mjs` 分不清某个参数到底属于哪个工具。
 */

import { runStoryboard } from '../storyboard/pipeline.js';
import { formatForDetail, formatPlanPreview } from '../storyboard/format.js';
import { hostSpeechToText } from '../storyboard/host-asr.js';
import { notifyDelivery } from '../storyboard/offload.js';

/**
 * 从 cordis 上下文里取一个**可选**服务（取不到返回 null，绝不抛）。
 *
 * ## 为什么不能用 `ctx?.attachments?.saveImage`
 *
 * cordis 的 `ctx` 是个 Proxy：服务**没在 `inject` 里声明**时，它的 `get` 陷阱会
 * **直接抛** `cannot get property "attachments" without inject`。`?.` 只挡
 * `null` / `undefined`，**挡不住异常** —— 所以 `ctx?.attachments?.saveImage` 看着像
 * 运行期探测，在真宿主里照样炸。
 *
 * 这是 0.5.9 的回归：为了修"装插件卡死"把 `attachments` 从 `inject` 里去掉，
 * 而访问点只是加了个 `?.`，用户装上去就得到 `cannot get property "attachments"
 * without inject`（2026-11-01 用户实报）。
 *
 * `ctx.get(name)` 是 cordis 给可选依赖的正规取法：服务没注册就返回 `undefined`。
 * 老宿主没有 `get()` 才退回属性访问，并且**整段包在 try 里**。
 */
export function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch { /* 没有 get()，或者服务没注册：往下退 */ }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;      // Proxy 抛的那个 "without inject"，在这里收住
  }
}

/**
 * 把每张分镜图提交成附件。两个入口各写过一遍这段循环，收成一处 —— mediaType / 命名改一次就够。
 *
 * 交完顺手 `notifyDelivery()`：图上进了会话历史就跟着每一轮请求走，`src/storyboard/offload.js`
 * 会按 `imageKeep` / `imageKeepMB` 把更早的省略掉（异步、不阻塞、失败只记日志）。
 */
export async function attachSheetImages(ctx, result) {
  // **运行期探测，不是 inject 声明**（原因见 src/index.js 的 inject 注释）：
  // 宿主没注册 attachments 时，插件必须照样能加载、工具照样能跑，只是拿不到图片。
  const attachments = serviceOf(ctx, 'attachments');
  const saveImage = attachments?.saveImage;
  if (typeof saveImage !== 'function') {
    throw new Error('this DSH build has no `attachments` service, so the storyboard image '
      + 'cannot be shown. Upgrade DSH, or use `video_probe` / `video_locate` (text only).');
  }
  const images = [];
  for (const sheet of result.sheets) {
    // **必须 `.call(attachments, ...)`**：新版宿主的 saveImage 内部读 `this.compression`，
    // 把方法从服务上取下来裸调，`this` 就是 undefined ——
    // 报的是 `Cannot read properties of undefined (reading 'compression')`（0.2.1-rc.5 实报）。
    images.push(await saveImage.call(attachments, {
      data: sheet.png,
      mediaType: 'image/png',
      name: `storyboard-${sheet.sheet}.png`,
    }));
  }
  // 图已经进历史了，看一眼要不要把更早的省略掉（**绝不能影响这一轮的交付**）
  notifyDelivery();
  return images;
}

/**
 * 跑一次管线，**带上宿主的 speechToText**（有就优先，没有就原样走 asr.json/HTTP）。
 *
 * 两个工具都必须走这里，不要各自 `runStoryboard()`：
 * `video_zoom` 曾经自己直调，于是同一个文件「分镜能转写、放大变 no-key」（2026-11-02 实报）。
 * 以后再加入口也请先接这个函数。
 */
export async function runWithHost(ctx, options) {
  const hostAsr = hostSpeechToText(ctx);
  return runStoryboard(hostAsr ? { ...options, hostAsr } : options);
}

/**
 * 跑一次管线，把每张图提交成附件，返回规范值 { images, text }。
 *
 * 预算：单次工具结果有上限，超出会被宿主折进磁盘（模型常常不会去读）。
 * 24k 字符 ≈ 一张 16 格图的完整清单还有余量；超了就在 cell 边界截断并给出续读方式。
 */
export async function runAndAttach(ctx, options, problems, cellRange) {
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  // 宿主有本地 speechToText 时优先用它；没有则 options 原样不变，继续走 asr.json/HTTP。
  const result = await runWithHost(ctx, options);
  // 预演：没有图可提交，也**不去碰 attachments 服务**（干跑不该要求宿主有出图能力）
  if (result.planOnly) {
    return { images: [], text: formatPlanPreview(result) };
  }
  return {
    images: await attachSheetImages(ctx, result),
    text: formatForDetail(result, { detail: options.detail, cellRange }),
  };
}

