/**
 * layout-order.js — **按内容重要度分配画幅**的排版（不做均匀网格）。
 *
 * ⚠️ **状态：实验性，还没有接进 pipeline。** 实测结论见文件末尾。
 *
 * 为什么需要：均匀网格把"0.3 秒的一闪"和"1 分钟的长镜头"当成一样大。
 * 但那两种画面在观感上根本不是一回事 —— 一个只是节奏点，一个是真正要看内容的场景。
 * 均匀切法会逼出很怪的结果：一格里塞十几个快切，或者一格空得只剩一个远景。
 *
 * 做法分三步：
 *   1. sizeForShot()  镜头时长 → 画幅尺寸（离散档位，"吸附"到这上面）
 *   2. groupShots()   相邻且同档位的镜头合并成一块（块内 k×k 摊开，复用二重细分）
 *   3. packOrdered()  按时间顺序把这些块塞进矩形，塞满就换下一页
 *
 * 保序是硬约束：观众从左到右、从上到下读，顺序一乱整张图就没法读了。
 * 保序的矩形装箱（ordered strip packing）里最简单可靠的是 **shelf / next-fit**。
 */

/** 画幅宽度占页面宽的比例，按镜头时长分档（秒）。这些就是"吸附"的目标值。 */
export const SIZE_STEPS = Object.freeze([
  { maxDur: 0.4, ratio: 1 / 6 },   // 极快闪，只是节奏点
  { maxDur: 1.0, ratio: 1 / 5 },   // 快切
  { maxDur: 2.5, ratio: 1 / 4 },   // 正常短镜
  { maxDur: 6.0, ratio: 1 / 3 },   // 常规镜头
  { maxDur: 15.0, ratio: 1 / 2 },  // 长镜头，开始值得给一半宽
  { maxDur: 40.0, ratio: 2 / 3 },  // 很长的场景
  { maxDur: Infinity, ratio: 1 },  // 一整段都在同一个画面里
]);

/**
 * 镜头时长 → 画幅宽度比例。
 * 分档而不是连续，是为了让尺寸可枚举：连续尺寸没有两个镜头会一样，
 * 排版时会切出一堆没法对齐的碎条。
 */
export function sizeForShot(dur) {
  const d = Number.isFinite(dur) && dur > 0 ? dur : 0;
  for (const s of SIZE_STEPS) if (d <= s.maxDur) return s.ratio;
  return 1;
}

/**
 * 保序条带装箱。
 *
 * @param {Array<{ratio:number}>} items 按时间顺序；ratio 是宽度占页面宽的比例
 * @param {{pageW:number, pageH:number, aspect?:number, gap?:number,
 *          align?:'center'|'top', maxHeightDelta?:number}} opts
 *   maxHeightDelta: 一行内允许的高度差（相对），超出就另起一行。
 *     纯 shelf 的问题是"一行里塞一个 300px 高的长镜头和一个 120px 高的快切"，
 *     行高按 300 算，快切上面白 180px —— 实测利用率只有 52%。
 *     限制高度差之后每行更"平"，利用率能到 80% 以上，代价只是行尾可能剩一点。
 * @returns {{pages: Array<Array<{x:number,y:number,w:number,h:number,i:number}>>,
 *            utilization:number, pageCount:number}}
 */
export function packOrdered(items, {
  pageW, pageH, aspect = 16 / 9, gap = 0, align = 'center', maxHeightDelta = 0.3,
} = {}) {
  if (!(pageW > 0) || !(pageH > 0)) throw new RangeError('pageW/pageH must be > 0');

  // 1) 尺寸吸附：宽度取档位，高度按宽高比；超过页面就压回页面内
  const boxes = items.map((it, i) => {
    let w = Math.min(pageW, Math.max(1, Math.round(it.ratio * pageW)));
    let h = Math.round(w / aspect);
    if (h > pageH) { h = pageH; w = Math.min(pageW, Math.round(h * aspect)); }
    return { w, h, i };
  });

  // 2) 分行：保序 + **高度差约束**。
  //    只按宽度分行的话，行高会被最高那一项撑起来，矮的全部留白。
  const rows = [];
  let cur = [];
  let curW = 0;
  let curH = 0;
  for (const b of boxes) {
    const need = cur.length ? b.w + gap : b.w;
    const nextH = Math.max(curH, b.h);
    const heightOk = cur.length === 0
      || (nextH - Math.min(...cur.map((c) => c.h), b.h)) <= nextH * maxHeightDelta;
    if (cur.length && (curW + need > pageW || !heightOk)) {
      rows.push({ items: cur, w: curW, h: curH });
      cur = []; curW = 0; curH = 0;
    }
    curW += cur.length ? b.w + gap : b.w;
    curH = Math.max(curH, b.h);
    cur.push(b);
  }
  if (cur.length) rows.push({ items: cur, w: curW, h: curH });

  // 3) 行 → 页：行高累加，放不下就开新页
  const pages = [];
  let page = [];
  let y = 0;
  for (const row of rows) {
    const rowH = row.h;
    if (page.length && y + rowH > pageH) { pages.push(page); page = []; y = 0; }
    let x = 0;
    for (const b of row.items) {
      const dy = align === 'center' ? Math.max(0, Math.round((rowH - b.h) / 2)) : 0;
      page.push({ x, y: y + dy, w: b.w, h: b.h, i: b.i });
      x += b.w + gap;
    }
    y += rowH + gap;
  }
  if (page.length) pages.push(page);

  return { pages, utilization: utilization(pages, pageW, pageH), pageCount: pages.length };
}

/** 画幅总面积 / 页面总面积 —— 就是"信噪比"，空白越少越高 */
export function utilization(pages, pageW, pageH) {
  if (!pages?.length) return 0;
  let used = 0;
  for (const p of pages) for (const c of p) used += c.w * c.h;
  return used / (pages.length * pageW * pageH);
}

/**
 * 把相邻的、档位相同的镜头**合并成一个块**，块内用 k×k 摊开。
 *
 * 为什么必须合并：41 个镜头各自一个画幅、尺寸又参差，实测要 7 页才排得下，
 * 利用率只有 45%（一页里一堆大小不一的方块互相挤）。合并之后：
 *   - 小块数骤减（41 → 十几个），排版不再碎
 *   - 块内 k×k 是**填满**的，没有空白，面积利用率接近 100%
 *   - 宫格编号也少了，模型读起来省事
 *
 * 合并只发生在**时间上相邻**且**档位相同**的镜头上 —— 顺序不能乱，
 * 否则模型读图的顺序和片子对不上。
 *
 * @param {Array<{dur:number, i?:number}>} shots 按时间顺序
 * @param {{maxCount?:number}} opts maxCount: 一个块最多装几个镜头（防止单块过大）
 * @returns {Array<{ratio:number, count:number, k:number, shots:number[]}>}
 */
export function groupShots(shots, { maxCount = 9 } = {}) {
  const blocks = [];
  let cur = null;
  for (let idx = 0; idx < shots.length; idx++) {
    const s = shots[idx];
    const ratio = sizeForShot(s.dur);
    if (cur && cur.ratio === ratio && cur.count < maxCount) {
      cur.count += 1;
      cur.shots.push(idx);
    } else {
      if (cur) blocks.push(cur);
      cur = { ratio, count: 1, shots: [idx] };
    }
  }
  if (cur) blocks.push(cur);
  // k 由块内镜头数决定：1~2 个不摊（摊了也是重复），3~4 → 2×2，5~9 → 3×3
  return blocks.map((b) => ({
    ...b,
    k: b.count <= 2 ? 1 : Math.min(4, Math.ceil(Math.sqrt(b.count))),
  }));
}

// ---------------------------------------------------------------------------
// 实测记录（2026-10-30，概念PV 90s / 41 个镜头 / 页面 1064×600）
//
// 直接按档位排：            6 张，利用率 52.5%
// 限制行内高度差 0.3：       7 张，45.0%（约束越严越差，因为行尾浪费变多）
// 相邻同档位合并（41→22 块）：4 张，47%
// 合并 + 压缩到 3 档：      3 张，41%
// 合并 + 按目标页数归一化：  目标 1 页 → 实际 3 张，33%（每张块数 4 / 17 / 1）
//
// **结论：保序 + 尺寸跨度大 = 碎片化，shelf 算法救不回来。**
//
// 看最后一行就懂了：一个大块（50% 宽）独占一张，它后面的 17 个小块只能等下一张。
// 块的时间顺序是固定的，大块出现在中间时，前后的小块没法绕过去填满剩余空间。
//
// 要真正提升利用率只有三条路：
//   A. 放弃保序（squarified treemap 能到 85%+，但读图顺序会乱）
//   B. 多页（3~5 张），token 涨 3~5 倍
//   C. **反推块尺寸**：先定页数和每页块数，再倒算每块该多大、块内装几个镜头。
//      这是唯一能在"保序 + 单页 + 有大小差异"之间取得平衡的路，但还没实现。
//
// 现状（均匀网格 9 格 1 张）虽然"大小一视同仁"，但利用率接近 100%，
// 所以这个模块在 C 做出来之前，**不要接进主流程**。
// ---------------------------------------------------------------------------
