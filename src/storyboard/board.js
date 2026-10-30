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

import {
  DEFAULT_ASPECT, DEFAULT_NEED, NEED_TIERS, PIXEL_BUDGET, maxCellsForNeed,
} from './plan.js';

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

/**
 * `<quality>` → 下载清晰度。**这是给"看不清"准备的**。
 *
 * 为什么需要它：URL 模式下宫格图是用**下载的那份文件**拼的，不是原片。
 * 原来写死 360p，4K 源缩到 360 再摊成 2×2（123×68），字和细节全糊 —— 这是真实反馈。
 * 本地文件不走这条路（直接读原片），所以只有链接会受影响。
 *
 * 默认 medium：low 太快糊、high 下载翻三倍，medium 是"看得清 + 还能接受"的那一档。
 */
export const QUALITY_HEIGHTS = Object.freeze({ low: 360, medium: 720, high: 1080 });
const DEFAULT_QUALITY = 'medium';

/**
 * 出图预算（**只表示一张图多少像素**）。
 *
 * 旧版把三件事绑在 `<size>` 上：像素预算、每张几格、下载清晰度。结果是
 * small 允许 16 格（4×4 每格 247×137，看不清），large 反而只允许 9 格 —— 方向和直觉是反的。
 * 现在这里只留像素；格数由 `need` + `budget` 推（plan.maxCellsForNeed），下载高度由像素推。
 *
 * 为什么默认不是 small：一图 640k 是"省钱档"，9 格只剩 331×184。
 * 默认抬到 1.2M（≈700 vision token/图），9 格 456×254 —— 能认出脸和动作。
 * 真抠成本就显式传 size:'small' / budget:640000，清单会把代价写出来。
 *
 * large 取 1.65M 而不是 2.4M：DSH 宿主按 42px 网格计价、单图封顶 1024 token，
 * 1.65M 刚好落在封顶前；再大也会被宿主缩回去，白花字节还让清单里的 cell= 变成假数。
 */
export const SIZE_BUDGETS = Object.freeze({
  small: { budget: 640_000, scanHeight: 360, zoomHeight: 720,
    note: '9 cells = 331×184（scene），最省' },
  medium: { budget: 1_200_000, scanHeight: 720, zoomHeight: 1080,
    note: '9 cells = 456×254（含音频条），16 cells = 341×189，默认' },
  large: { budget: 1_650_000, scanHeight: 1080, zoomHeight: 1440,
    note: '9 cells = 530×295，可读字幕；宿主 1024-token 封顶附近' },
});
const DEFAULT_SIZE = 'medium';
const DEFAULT_ZOOM_HEIGHT = 1080;

/** 像素预算 → 扫描副本高度。够用就好，但不为了"够用"把 0.5.3 的 720p 降回去。 */
export function scanHeightForBudget(budget) {
  // 宁可多下一档：0.5.3 已经把链接默认提到 720p，这里不能借"像素预算"之名把它降回 480，
  // 那会让"字刚能认出来"的素材重新变糊。格子 237 高时 720p 是 3× 超采样，锐度也确实更好。
  if (budget >= 1_500_000) return 1080;
  if (budget >= 1_000_000) return 720;
  return 360;
}

/**
 * 把 `size` / `budget` / `need` / `maxPerSheet` 收成一个"这次出图用什么几何"的答案。
 *
 * 四者的优先级（高 → 低）：显式 maxPerSheet > need 推出的上限；
 * 显式 budget > size 档位 > PIXEL_BUDGET。
 *
 * 返回的 `maxPerSheet` 是**建议上限**：自动排格时不会超过它；
 * 调用方显式给了 cells 就按调用方来（清单会报出可读性代价）。
 */
export function boardGeometry(args = {}) {
  const budget = Number(args.budget) > 0
    ? Math.round(Number(args.budget))
    : (SIZE_BUDGETS[args.size ?? DEFAULT_SIZE]?.budget ?? PIXEL_BUDGET);
  const need = NEED_TIERS[args.need] ? args.need : DEFAULT_NEED;
  // 用 16:9 估：宽银幕的格高更小，按 16:9 算出来的上限对宽银幕是保守的（宁可少一格）
  const derived = maxCellsForNeed(budget, DEFAULT_ASPECT, need);
  const wanted = Number(args.maxPerSheet) > 0 ? Math.round(Number(args.maxPerSheet)) : derived;
  const maxPerSheet = Math.max(1, Math.min(16, wanted));
  return { budget, need, maxPerSheet, derivedMaxPerSheet: derived };
}

/**
 * `<detail>` 决定每格给多少字。只有故事板/zoom 用它，watch 用自己的总预算（见 MANIFEST_BUDGET）。
 * 这里是"什么时候开 OCR"的唯一判据：要能引用原话（high）才值得花 3 秒做硬字幕校正。
 */
export function ocrFor(args = {}, detail = args.detail ?? 'med') {
  if (args.ocr === true) return true;
  if (args.ocr === false) return false;
  return detail === 'high';
}

function fetchOptionsFor(args = {}, kind = 'board', geom = null) {
  return {
    cookies: args.cookies,
    allowAnonymous: args.allowAnonymous === true,
    // 扫描用低清落盘、zoom 回原始流取高清：这是两级取流的分工，三个入口一致
    // 下载高度按 `size` 自动配（格子小就别下一份高清）。quality 是显式覆盖，scanHeight 再覆盖它。
    // 只对 board 生效：zoom 有 1080 高清直链，它的 scanHeight 只是**本地兜底**；
    // watch 同理（分段取图，用的缓存副本）。抬高它们只会白下一份没人用的 720p。
    // 下载高度跟着**像素预算**走（不是跟着档位名字）：1.2M → 720p、1.65M → 1080p。
    // quality 是显式覆盖，scanHeight 再覆盖它。
    scanHeight: kind === 'board'
      ? (args.scanHeight
        ?? QUALITY_HEIGHTS[args.quality]
        ?? scanHeightForBudget((geom ?? boardGeometry(args)).budget)
        ?? DEFAULT_SCAN_HEIGHT)
      : (args.scanHeight ?? DEFAULT_SCAN_HEIGHT),
    // zoom 的清晰度走 zoomHeight：quality 是给人的旋钮，zoomHeight 是给"我要正好多少像素"的
    // zoom 的 size 决定高清直链的高度：看特写本来就需要更多像素
    ...(kind === 'zoom'
      // **不传 size 时保持 1080p 原默认**：zoom 就是看细节的，不该因为 board 的档位被降下来
      ? { zoomHeight: args.zoomHeight
        ?? (args.size ? SIZE_BUDGETS[args.size]?.zoomHeight : undefined)
        ?? QUALITY_HEIGHTS[args.quality]
        ?? DEFAULT_ZOOM_HEIGHT }
      : {}),
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
  // 只算一次：预算/档位在三个地方要用（下载档位、maxPerSheet、清单），算三次容易走样。
  const geom = boardGeometry(args);
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
    fetchOptions: fetchOptionsFor(args, kind, geom),
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
    // **两个独立旋钮**：budget 给像素，maxPerSheet 给"一张最多几格"。
    // need 是给模型说人话用的（我要看清到什么程度），它只参与推 maxPerSheet。
    budget: geom.budget,
    maxPerSheet: geom.maxPerSheet,
    need: geom.need,
    // 自动分段：只传 from 时，窗口默认这么长（秒）；0 = 一直看到片尾
    ...(Number(args.segment) > 0 ? { segment: Math.round(Number(args.segment)) } : {}),
  };
}
