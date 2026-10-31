/**
 * measure.js — **一张图到底会产生多少帧**，只算一次，切张和渲染共用这一个答案。
 *
 * 为什么要有这个文件（2026-10-30，Kimi 的 review 指出的真问题）：
 * 切张时用 `chooseSubGrid({ cellW: 250, cellH: 140 })` 估算每格 k，渲染时又用
 * `layoutCanvas()` 算出来的**真实** cellW/cellH 再算一次。子帧下限提到 200×112 之后，
 * 这两次必然给出不同答案：
 *
 *     切张：250×140 → 250/2=125 < 200 → k=1，认为这一格 1 帧
 *     渲染：505×312 → 252/2=156 ≥ 112，252 ≥ 200 → k=2，实际拼出 4 帧
 *
 * 于是 `planSheetsByFrames()` 名义上"按帧数切张"，实际按一套错的帧数在切；
 * 清单里报的 token/格数也跟着不可信。
 *
 * 这里把"测量"收成一个纯函数：给定一组时间段，返回真实布局、每格的 k、以及总帧数。
 * **切张和渲染都调它，渲染不再自己重新决定 k。**
 *
 * 它不取像素、不写盘 —— 只做算术，所以能单测。
 */

import { NEED_TIERS, bestLayout } from './plan.js';
import { layoutCanvas } from './sheet.js';
import {
  BUSY_MOTION, FRAME_DIV_MID, TILE_MOTION, chooseSubGrid, subTileTimes,
} from './frames.js';

/**
 * **这一格摊成 2×2 时，那 4 张画面彼此差多少**（0–255）。null = 拿不到指纹。
 *
 * 为什么要它：`chooseSubGrid` 原来靠 `meanMotion` 判断"该不该摊"，而 meanMotion 是
 * **相邻帧**的差（段内运动）。摊开问的是**隔很远的 4 帧**彼此像不像（段间差异）——
 * 两者经常反向：长镜头帧差小、但每 5 秒截一张是 4 个完全不同镜头；连续动作帧差大、
 * 但截 4 张是同一动作的 4 个瞬间。
 *
 * 实测（记管MAD02，27 格，ground truth = 出图里切出的子帧两两差）：
 *   meanMotion −0.19 / cutScore +0.23 / SI +0.34 / 分块方差 +0.39 / **指纹 +0.51**
 * 指纹是全部候选里相关性最高的，而且它**已经在扫描流里算好了**（`scan.prints`，16×9 块均值），
 * 之前只给 `tagCuts()` 识别闪光，算完就丢。
 *
 * 取的时刻复刻 `subTileTimes` 的规则（按段中点），所以量出来的就是出图时真会取到的那 4 张。
 *
 * @param {{from:number,to:number}} range 绝对时间
 * @param {number[]} cutTimes 格内分段边界（绝对时间）
 * @param {Uint8Array[]|null} prints 逐帧 16×9 指纹
 * @param {number} fps
 * @param {number} offset 指纹的 t=0 对应哪个绝对时刻（= 窗口起点 winStart）
 */
export function frameDiversityOf(range, cutTimes, prints, fps, offset = 0, k = 2) {
  if (!Array.isArray(prints) || prints.length === 0 || !(fps > 0)) return null;
  if (!(range.to > range.from)) return null;
  const n = k * k;
  const times = subTileTimes(range.from, range.to, n, cutTimes);
  const vecs = [];
  for (const t of times) {
    const i = Math.round((t - offset) * fps);
    if (i < 0 || i >= prints.length) return null;   // 越界说明 offset/fps 对不上，宁可不用
    const v = prints[i];
    if (!v || !v.length) return null;
    vecs.push(v);
  }
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let d = 0;
      const len = Math.min(vecs[i].length, vecs[j].length);
      for (let p = 0; p < len; p++) d += Math.abs(vecs[i][p] - vecs[j][p]);
      sum += d / len;
      pairs += 1;
    }
  }
  return pairs ? +(sum / pairs).toFixed(1) : null;
}

/**
 * 一格里"有几个分段"和"刀够不够狠"—— 决定 k 的内容侧输入。
 * 抽出来是为了让 measure 与渲染用的是同一份判断（以前这段在两处各写一遍）。
 */
/**
 * **子帧像素下限 = `need` 的下一档。**
 *
 * 以前这里是另一套数（200×112 / 110×56），和 `NEED_TIERS`（160×90 / 320×180 / 480×270）
 * 完全不相干 —— 结果 need=scene 的图摊成 3×3 之后每张 113×63，比 `shot` 档（160×90）还低，
 * 模型看到清单上写着 `cell=341×189 (scene)`，实际看到的是色块。这就是"两套口径"。
 *
 * 现在的语义是：**整帧给你 need 这一档，摊开给你低一档**（至少还能分辨"是不是不同镜头"）。
 *   need=scene(320×180) → 子帧门槛 160×90 → 341×189 的格子最多 2×2（170×94）
 *   need=text (480×270) → 子帧门槛 320×180 → 456×254 的格子只能整帧
 *   need=shot (160×90 ) → 子帧门槛 160×90（已经最底，不再降）
 *
 * 例外见 `TINY_FLOOR`：指纹证明"又动又确实不一样"的格子，仍允许用 110×56 换更多帧。
 */
const NEED_ORDER = ['shot', 'scene', 'text'];
export function subFloorForNeed(need = 'scene') {
  const i = Math.max(0, NEED_ORDER.indexOf(need));
  const lower = NEED_TIERS[NEED_ORDER[Math.max(0, i - 1)]] ?? NEED_TIERS.shot;
  return { minSubW: lower.minCellW, minSubH: lower.minCellH };
}

/**
 * **例外档**：110×56，只给"真的值得"的格子。
 *
 * 这是旧版实测的"能分辨不同镜头"下限，比 `shot` 还低 —— 它换来的是更多帧：
 * 341×189 用 110 能摊 3×3（113×63），用 160 只能 2×2（170×94）。
 * 所以只在**指纹证明这格又快又确实不同**（frameDiv ≥ FRAME_DIV_MID）时才放行，
 * 或者整片判成音乐驱动（信息全在画面上，宁可小而密）。
 */
const TINY_FLOOR = Object.freeze({ minSubW: 110, minSubH: 56 });

function cellSignals(range, { cuts, sampleMarks, stats, prints, fps, printOffset }) {
  const cutList = cuts.filter((c) => c.t >= range.from && c.t < range.to);
  const marks = sampleMarks.filter((t) => t >= range.from && t < range.to);
  const cutScore = cutList.length
    ? cutList.reduce((n, c) => n + (c.score ?? 0), 0) / cutList.length
    : Infinity;
  const cellStats = stats.filter((x) => x.t >= range.from && x.t < range.to);
  const meanMotion = cellStats.length
    ? cellStats.reduce((n, x) => n + x.score, 0) / cellStats.length
    : 0;
  // 格内的分段边界，和渲染时喂给 subTileTimes 的是同一份
  const cutTimes = [...cutList.map((c) => c.t), ...marks].sort((x, y) => x - y);
  const frameDiv = frameDiversityOf(range, cutTimes, prints, fps, printOffset);
  return { cutList, marks, cutScore, meanMotion, cutTimes, frameDiv };
}

/**
 * 按「刀/秒」从高到低分配子帧预算，不够就降档。
 *
 * 这一步是"预算削减"，不是"重新决策"：k 的**愿望值**由 chooseSubGrid 定，
 * 这里只在整张图的总帧预算（subBudget）不够时往下降。放在 measure 里是因为
 * 它直接决定"实际会产生多少帧"—— 切张要用这个数，渲染也必须用同一个结果。
 */
function shrinkToBudget(cells, subBudget) {
  let left = subBudget;
  for (const c of [...cells].sort((x, y) => y.rate - x.rate)) {
    let s = c.want;
    while (s > 1 && s * s - 1 > left) s -= 1;
    if (s > 1) left -= s * s - 1;
    c.k = s;
  }
  return cells;
}

/**
 * 测一组时间段（= 一张图）。
 *
 * @param {Array<{from:number,to:number}>} ranges 这一张要放的格
 * @param {object} o
 * @param {number} o.aspect        源画面比例
 * @param {number} o.budget        整张图的像素预算（layoutCanvas 的口径）
 * @param {boolean} [o.audioStrip] 是否有音频条带（要扣 10% 预算）
 * @param {boolean} [o.musicDriven]
 * @param {number} [o.subBudget]   整张图最多摊出多少子帧（默认 48）
 * @param {Array} [o.cuts]         真切点（绝对时间）
 * @param {Array} [o.sampleMarks]  积分采样点（绝对时间）
 * @param {Array} [o.stats]        逐帧分数
 * @returns {{cols:number, rows:number, width:number, height:number, cellW:number, cellH:number,
 *            cells:Array<object>, frameCount:number}}
 */
export function measureGroup(ranges, {
  aspect = 16 / 9, budget = 640_000, audioStrip = false, musicDriven = false,
  // 目标可读性：决定**摊开之后的子帧**要多大（见 subFloorForNeed）。整帧永远按 need 走，
  // 摊开允许降一档 —— 因为"看 4 个不同瞬间"和"看清一张"本来就是两种需求。
  need = 'scene',
  subBudget = 48, cuts = [], sampleMarks = [], stats = [],
  // 逐帧指纹（拿不到就是 null —— 缓存命中 / precomputed 时如此，判据会自动退回 meanMotion）
  prints = null, fps = 0, printOffset = 0,
  // 1 = 禁止格内摊开。`cells:1` 的语义是"就要这一帧"，不能悄悄拼成 2×2。
  maxK = 4,
} = {}) {
  const n = Math.max(1, ranges.length);
  const { cols, rows } = bestLayout(n, aspect);
  // 有音频带时先扣掉条带占用的预算：layoutCanvas 与 composeSheet 必须用**同一个** budget，
  // 否则取帧尺寸和拼图尺寸不一致，图会变成斜条纹（踩过）
  const cellBudget = audioStrip ? Math.round(budget * 0.9) : budget;
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, aspect, cellBudget);

  const cells = ranges.map((range) => {
    const { cutList, marks, cutScore, meanMotion, cutTimes, frameDiv } = cellSignals(
      range, { cuts, sampleMarks, stats, prints, fps, printOffset },
    );
    const shots = cutList.length + 1 + marks.length;
    const want = chooseSubGrid({
      shots, cellW, cellH, dur: range.to - range.from, cutScore, meanMotion, frameDiv, maxK,
      // 音乐驱动：单镜头但有动静就摊（门槛 1.5 → 0.7）
      minMotion: musicDriven ? 0.7 : 1.5,
      // **子帧下限：默认跟着 need 走，只有"确实值得"的格子才降到 110×56。**
      // 以前这里是"逐格按 meanMotion 判"，但 meanMotion 是段内运动 —— 它高的格子往往
      // 反而是连续动作（4 张像），拿它换取更小的子帧是白送分辨率。改用指纹：
      // frameDiv ≥ FRAME_DIV_MID 表示这 4 张真的不一样，那时"小而密"才划算。
      // 拿不到指纹（缓存旧版 / precomputed 无 prints）时退回旧的 meanMotion 判断。
      ...((musicDriven || (frameDiv != null
        ? frameDiv >= FRAME_DIV_MID
        : meanMotion >= TILE_MOTION)) ? TINY_FLOOR : subFloorForNeed(need)),
    });
    return {
      ...range,
      k: want,
      want,
      cellCuts: cutList.length,
      // 本格的分段边界（真切点 + 积分采样点），摊开时用它决定每个子帧落在哪一段里
      cutTimes,
      rate: shots / Math.max(0.1, range.to - range.from),
      // 段内逐帧分数的均值（画面"有多热闹"）：静止约 0.2、匀速摇镜 1.5~3、快剪 5+。
      // 和"镜头数"是两个维度：快剪 8 个镜头和慢摇 8 个镜头，前者该摊细、后者该留大图。
      meanMotion: +meanMotion.toFixed(2),
      // **摊开到底有没有东西**：指纹直接量出来的 4 张差异。null = 这次没指纹。
      // 清单里报它，模型才能知道"这格为什么只给整帧"；不报就只剩 meanMotion 那个反指标。
      ...(frameDiv !== null ? { frameDiv } : {}),
    };
  });
  shrinkToBudget(cells, subBudget);
  const frameCount = cells.reduce((sum, c) => sum + c.k * c.k, 0);
  return { cols, rows, width, height, cellW, cellH, cellBudget, cells, frameCount };
}
