/**
 * board.js — 「跑一次分镜要传什么」只有一份定义。
 *
 * 为什么要有这个文件：storyboard / zoom / watch 三个入口，以前各自手写一遍
 * runStoryboard 的参数默认值。三次抄写已经长出了三种行为：
 *
 *   - storyboard 有 detail（60/120/400 字每格），**watch 没有** → 陪看永远只能拿 80 字；
 *   - ocr 的「detail: high 才开」规则只在 storyboard 里存在；
 *   - zoom 把 scanHeight 写死 360，storyboard 可以传。
 *
 * 这些都是"同一件事写三遍"的必然结果，不是谁忘了。收成一处之后，加参数只需要加一次，
 * 三个入口自然同时拥有它。
 *
 * **不合并的部分**（有意为之）：
 *   - 段边界：storyboard 用 plan.js（按密度建议格数），watch 用 batches.js（按分钟阶梯）——
 *     两件事，硬合并只会多一层 if；
 *   - 交付时机：只有 watch 有"等到段末才给图"的逻辑，别处没有，也就没有可复用的东西。
 */

/** 三个入口。默认值不同，但都由这里决定。 */
export const BOARD_KINDS = Object.freeze(['board', 'zoom', 'watch']);

/**
 * `<detail>` → 每格给多少字。**这里定义一次**，storyboard / zoom / watch 共用
 * （watch 另外还按档位给整份清单一个总预算，见 watch-run.js）。
 *
 * 60/120/400 是实测出来的：中文台词比图贵得多，med 比"每格硬切 180 字"还便宜 12%。
 */
export const DETAIL_CHARS = Object.freeze({ low: 60, med: 120, high: 400 });

/** 每格多少字（未知档位退回 med，别让一个拼错的 detail 把清单变成空的） */
export const charsForDetail = (detail) => DETAIL_CHARS[detail] ?? DETAIL_CHARS.med;

const DEFAULT_SCAN_HEIGHT = 360;
const DEFAULT_ZOOM_HEIGHT = 1080;

/**
 * `<detail>` 决定每格给多少字。只有故事板/zoom 用它，watch 用自己的总预算（见 MANIFEST_BUDGET）。
 * 这里是"什么时候开 OCR"的唯一判据：要能引用原话（high）才值得花 3 秒做硬字幕校正。
 */
export function ocrFor(args = {}, detail = args.detail ?? 'med') {
  if (args.ocr === true) return true;
  if (args.ocr === false) return false;
  return detail === 'high';
}

function fetchOptionsFor(args = {}, kind = 'board') {
  return {
    cookies: args.cookies,
    allowAnonymous: args.allowAnonymous === true,
    // 扫描用低清落盘、zoom 回原始流取高清：这是两级取流的分工，三个入口一致
    scanHeight: args.scanHeight ?? DEFAULT_SCAN_HEIGHT,
    ...(kind === 'zoom' ? { zoomHeight: args.zoomHeight ?? DEFAULT_ZOOM_HEIGHT } : {}),
  };
}

/**
 * 组装 runStoryboard 的参数。
 *
 * @param {object} args 工具参数（或它们的合并结果）
 * @param {{kind?: 'board'|'zoom'|'watch', frameSource?: object|null}} [o]
 * @returns {object} 直接喂给 runStoryboard
 */
export function boardOptions(args = {}, { kind = 'board', frameSource = null } = {}) {
  if (!BOARD_KINDS.includes(kind)) throw new RangeError(`unknown board kind: ${kind}`);
  const detail = args.detail ?? 'med';
  const base = {
    input: args.input,
    from: args.from ?? 0,
    to: args.to ?? 0,
    pick: args.pick ?? 'sharp',
    burn: args.burn ?? 'index',
    transcript: args.transcript ?? 'auto',
    ...(args.transcriptFile !== undefined ? { transcriptFile: args.transcriptFile } : {}),
    sourceHash: args.sourceHash === true,
    // 每格多少字：三个入口同一个口径
    detail,
    // 硬字幕校正：同一条规则，不再各自判断
    ocr: ocrFor(args, detail),
    fetchOptions: fetchOptionsFor(args, kind),
  };

  if (kind === 'zoom') {
    return {
      ...base,
      cells: args.cells ?? 6,
      sheets: 1,
      // **必须显式传**：runStoryboard 的默认值是 1.2，不传就永远是 1.2 ——
      // zoom 恰恰最需要小间隔（把半秒镜头拆成独立格）。
      minGap: args.minGap ?? 1.2,
      // 近距离重看不再按密度挪格：窗口本来就短，均分更好预测
      adaptive: false,
      frameSource,
    };
  }

  if (kind === 'watch') {
    return {
      ...base,
      cells: Number(args.cells) > 0 ? Number(args.cells) : 5,
      sheets: 1,
      minGap: 0.5,
      adaptive: false,
      frameSource,
    };
  }

  return {
    ...base,
    cells: args.cells ?? 0,
    sheets: args.sheets ?? 0,
    minGap: args.minGap ?? 1.2,
    // 这一次的热词（覆盖 asr.json）。学科不对时的负偏置，比不传更糟。
    ...(typeof args.hotwords === 'string' ? { hotwords: args.hotwords } : {}),
    textOnly: args.textOnly === true,
    ...(args.planThresholds && typeof args.planThresholds === 'object'
      ? { planThresholds: args.planThresholds }
      : {}),
    adaptive: args.adaptive ?? true,
  };
}
