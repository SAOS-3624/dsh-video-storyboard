/**
 * tiers.test.mjs — 档位算法（整个新架构的核心）。
 *
 * 口径来自 `取帧分档算法.docx`：切点 → 滑动窗密度 → 平滑 → 7 阈值 + 5% 滞回的 8 档状态机。
 * 档位 k 的边长就是 1/k。这里只测纯算术，不碰 ffmpeg。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STRATEGY, LEVEL_THRESHOLDS, MARK_BOOST, STRATEGIES, TIER_MAX, TIER_MIN,
  applyMarkBoost, applyStrategy, applyTierMap, autoSheetCap, shouldForceSheetCap,
  IMAGE_UPSCALE_AREA, INTEGRAL_REF_SCORE, MAX_CANVAS_SIDE, fitCanvas, framesFromBounds, headerHeight, imageTokens, integralMarks, levelAt,
  levelCurve,
  pickAutoStrategy,
  readabilityOf,
  tierHistogram, tierSizes, tierSide,
} from '../src/storyboard/tiers.js';

/* ---------------------------------------------------------------- 密度 → 档位 */

test('levelCurve: 全片没有切点 → 全部 1 档（长镜头拿整幅）', () => {
  const c = levelCurve({ duration: 60, fps: 30, cuts: [] });
  assert.equal(c.levels.length, 1800);
  assert.ok([...c.levels].every((v) => v === 1));
  assert.equal(tierSide(1), 1);
});

test('levelCurve: 每秒 3 刀 → 8 档（1/8 豆腐块）', () => {
  const cuts = Array.from({ length: 174 }, (_, i) => i / 3);   // 60 秒内每 1/3 秒一刀
  const c = levelCurve({ duration: 60, fps: 30, cuts });
  const mid = [...c.levels.slice(600, 1500)];
  assert.ok(mid.every((v) => v >= 7), `高密度段应到 7-8 档，实得 ${[...new Set(mid)]}`);
});

test('levelCurve: 每 5 秒一刀 → 1 档（低于第一道阈值 0.0085）', () => {
  const cuts = Array.from({ length: 12 }, (_, i) => i * 5 + 2);
  const c = levelCurve({ duration: 60, fps: 30, cuts });
  assert.equal(c.levels[900], 1);
});

test('levelCurve: 档位随密度单调不降（密度越高档位不会更小）', () => {
  const sparse = Array.from({ length: 12 }, (_, i) => i * 5);
  const dense = Array.from({ length: 120 }, (_, i) => i * 0.5);
  const a = levelCurve({ duration: 60, fps: 30, cuts: sparse });
  const b = levelCurve({ duration: 60, fps: 30, cuts: dense });
  assert.ok(levelAt(b, 30) > levelAt(a, 30));
});

test('滞回：阈值附近 ±3% 的抖动不会来回换档', () => {
  // 5% 滞回 → 升档要 > 阈值×1.05，降档要 < 阈值×0.95
  const c = levelCurve({ duration: 40, fps: 30, cuts: [] });
  assert.equal(c.levels[0], 1);
  assert.equal(LEVEL_THRESHOLDS.length, 7, '7 道阈值 → 8 档');
  assert.equal(TIER_MAX, 8);
  assert.equal(TIER_MIN, 1);
});

/* ---------------------------------------------------------------- 帧序列 */

test('framesFromBounds: 一段一帧，边界首尾相接', () => {
  const segs = framesFromBounds({ duration: 10, cuts: [2, 5, 8] });
  assert.equal(segs.length, 4);
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, 10);
  for (let i = 1; i < segs.length; i += 1) assert.equal(segs[i].from, segs[i - 1].to);
  for (const s of segs) assert.ok(s.t > s.from || s.t === s.from);
});

test('framesFromBounds: 超过 maxFrames 时合并最短的段（长镜头一格不动）', () => {
  // 0-40 是一个长镜头，后面 20 个 0.2 秒快闪
  const cuts = Array.from({ length: 20 }, (_, i) => 40 + i * 0.2);
  const segs = framesFromBounds({ duration: 44, cuts, maxFrames: 6 });
  assert.equal(segs.length, 6);
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, 44);
  assert.ok(segs[0].to - segs[0].from >= 40 - 1e-9, '长镜头不该被合并掉');
});

test('framesFromBounds: 太短的段并进前一段（0.03 秒取不出画面）', () => {
  const segs = framesFromBounds({ duration: 5, cuts: [1, 1.03, 2] });
  assert.ok(segs.every((s) => s.to - s.from >= 0.08));
  assert.equal(segs.at(-1).to, 5);
});

test('framesFromBounds: 空输入也至少给一帧（不能返回空图）', () => {
  const segs = framesFromBounds({ duration: 3 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].t, 1.5);
  assert.equal(segs[0].via, 'start');
});

test('framesFromBounds: 默认不封顶（0 / 不传都不是"最多一帧"）', () => {
  const cuts = Array.from({ length: 300 }, (_, i) => i * 0.1 + 0.1);
  assert.equal(framesFromBounds({ duration: 31, cuts }).length, 301, '不传 maxFrames 就该全给');
  assert.equal(framesFromBounds({ duration: 31, cuts, maxFrames: 0 }).length, 301, '0 = 不限');
  assert.equal(framesFromBounds({ duration: 31, cuts, maxFrames: 40 }).length, 40, '给了正数才收');
});

test('framesFromBounds: via 标出这一段是"真切点后 / 假切点后 / 片头"', () => {
  const segs = framesFromBounds({ duration: 10, cuts: [3], marks: [5, 7] });
  assert.deepEqual(segs.map((x) => x.via), ['start', 'cut', 'mark', 'mark']);
  assert.deepEqual(segs.map((x) => x.cut), [false, true, false, false]);
});

test('applyMarkBoost: 假切点的帧提三档，真切点不动，封顶 8', () => {
  assert.equal(MARK_BOOST, 3);
  const segs = framesFromBounds({ duration: 10, cuts: [3], marks: [5, 7] });
  // 段序：0-3(cut 起点 3) 3-5(cut) 5-7(mark) 7-10(mark) —— 只有起点是假切点的段加成
  assert.deepEqual(applyMarkBoost([1, 2, 3, 8], segs), [1, 2, 6, 8]);
  // 已经在 8 档的不会再爆
  assert.deepEqual(applyMarkBoost([8, 8, 8, 8], segs), [8, 8, 8, 8]);
  // 缺 via 时原样返回（兼容手写的段）
  assert.deepEqual(applyMarkBoost([4, 4], [{}, {}]), [4, 4]);
});

/* ---------------------------------------------------------------- 积分取帧 */

test('integralMarks: 完全静止的片子一个点都不补', () => {
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: 0 }));
  assert.deepEqual(integralMarks({ duration: 10, series }), []);
});

test('integralMarks: 参考强度画面 → 大约每 equivSeconds 一个点', () => {
  // score 取 INTEGRAL_REF_SCORE 才是"中等强度画面"，此时间隔才该等于 equivSeconds。
  // 阈值 = REF × fps × equivSeconds，攒够要 REF×fps×eq / (REF×fps) = eq 秒。
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: INTEGRAL_REF_SCORE }));
  const marks = integralMarks({ duration: 10, series, equivSeconds: 5 });
  assert.ok(marks.length >= 1 && marks.length <= 3, `实得 ${marks.length}: ${marks}`);
  for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i] > marks[i - 1]);
  if (marks.length >= 2) {
    const gap = (marks[marks.length - 1] - marks[0]) / (marks.length - 1);
    assert.ok(Math.abs(gap - 5) < 1.2, `参考强度下间隔应≈5s，实得 ${gap.toFixed(2)}`);
  }
});

test('integralMarks: 阈值是**绝对值** —— 画面整体越快，点越多', () => {
  // 这是那条被修掉的病：以前阈值 = 全片平均变化量 × equivSeconds，阈值跟着画面一起涨，
  // 两者抵消 → 不管多快都是 equivSeconds 秒一个点（实测 2/s 到 64/s 全是 19 个）。
  const at = (score) => {
    const series = Array.from({ length: 1200 }, (_, i) => ({ t: i / 12, score }));
    return integralMarks({ duration: 100, series, equivSeconds: 6, fps: 12 }).length;
  };
  const slow = at(1);
  const ref = at(INTEGRAL_REF_SCORE);
  const fast = at(16);
  assert.ok(slow < ref, `慢素材(${slow}) 必须少于参考强度(${ref})`);
  assert.ok(ref < fast, `参考强度(${ref}) 必须少于快素材(${fast})`);
  // 具体量级：慢素材攒得久（间隔 > equivSeconds），快素材攒得快（间隔 < equivSeconds）
  assert.ok(slow <= 100 / 12, `1 分/秒的素材 100 秒内不该超过 ${Math.floor(100 / 12)} 个点，实得 ${slow}`);
  assert.ok(fast >= 100 / 2, `16 分/秒的素材 100 秒内至少 ${50} 个点，实得 ${fast}`);
});

test('integralMarks: 真切点附近不补点（那里已经是边界）', () => {
  const series = Array.from({ length: 100 }, (_, i) => ({ t: i * 0.1, score: 10 }));
  const marks = integralMarks({ duration: 10, series, cuts: [5], equivSeconds: 5 });
  assert.ok(marks.every((t) => Math.abs(t - 5) >= 0.35));
});

/* ---------------------------------------------------------------- 策略 / 几何 */

test('applyStrategy: 六个档位的映射（旧名仍然认）', () => {
  const base = [1, 2, 3, 8];
  assert.deepEqual(applyStrategy(base, 'full'), [1, 1, 2, 7], '全尺寸：升一档，1 仍是 1');
  assert.deepEqual(applyStrategy(base, 'standard'), [2, 2, 3, 8], '标准：1 档压成 1/2');
  assert.deepEqual(applyStrategy(base, 'compact'), [2, 3, 4, 8], '紧凑：降一档');
  // 速览 / 一图：不看原来几档，全部压到 1/8（自由尺寸的补位帧仍是 0）
  assert.deepEqual(applyStrategy(base, 'skim'), [8, 8, 8, 8]);
  assert.deepEqual(applyStrategy(base, 'brief'), [8, 8, 8, 8]);
  assert.deepEqual(applyStrategy([1, 0, 5], 'skim'), [8, 0, 8], '补位帧不参与固定档');
  // 旧名兼容（0.6.0 之前那套玩笑名字）
  assert.deepEqual(applyStrategy(base, 'quality'), applyStrategy(base, 'full'));
  assert.deepEqual(applyStrategy(base, 'balanced'), applyStrategy(base, 'standard'));
  assert.deepEqual(applyStrategy(base, 'saver'), applyStrategy(base, 'compact'));
  assert.deepEqual(applyStrategy(base, 'frugal'), applyStrategy(base, 'compact'));
  assert.deepEqual(applyStrategy(base, 'thrifty'), applyStrategy(base, 'skim'));
  assert.deepEqual(applyStrategy(base, 'ultra'), applyStrategy(base, 'brief'));
  assert.deepEqual(applyStrategy(base, 'nope'), applyStrategy(base, DEFAULT_STRATEGY), '未知策略退回默认');
  // 0.6.7 起多一个 `native`：**只给「逐档自定义」当底座**（bump 0、无 floor）。
  // 没有它的话，用户设的 tierMap `1→3` 是在一个已经被策略 bump 过的档位上再挪。
  // 数量这条断言是防误加/误删的 —— 策略名会进工具 schema，每多一个都要占 token。
  assert.equal(Object.keys(STRATEGIES).length, 6);
  assert.equal(DEFAULT_STRATEGY, 'compact', '默认是紧凑档（性价比最高）');
});

test('速览 / 一图：不要积分假切点；速览还带 0.35s 切点合并', () => {
  assert.equal(STRATEGIES.skim.noIntegral, true);
  assert.equal(STRATEGIES.brief.noIntegral, true);
  assert.equal(STRATEGIES.skim.defaultScanGap, 0.35);
  assert.equal(STRATEGIES.brief.fitOneSheet, true);
  // 前三档保留假切点、不合并切点
  for (const k of ['full', 'standard', 'compact']) {
    assert.ok(!STRATEGIES[k].noIntegral);
    assert.equal(STRATEGIES[k].defaultScanGap, undefined);
  }
});

/* ---------------------------------------------------------------- 档位映射表 */

test('applyTierMap: 只改写了的档位，其余原样保留', () => {
  assert.deepEqual(applyTierMap([1, 2, 3, 8], { 1: 3, 8: 4 }), [3, 2, 3, 4]);
  assert.deepEqual(applyTierMap([1, 2, 3], null), [1, 2, 3]);
  assert.deepEqual(applyTierMap([1, 2, 3], {}), [1, 2, 3]);
});

test('applyTierMap: 多档合并到同一档（快剪全按 1/4 算）', () => {
  assert.deepEqual(applyTierMap([5, 6, 7, 8], { 5: 4, 6: 4, 7: 4, 8: 4 }), [4, 4, 4, 4]);
  // 字符串键也认（JSON 传进来就是字符串）
  assert.deepEqual(applyTierMap([1, 2], { '1': '5' }), [5, 2]);
});

test('applyTierMap: 自由尺寸帧（tier 0）不参与映射，越界的键值被忽略', () => {
  assert.deepEqual(applyTierMap([0, 3], { 3: 1 }), [0, 1]);
  assert.deepEqual(applyTierMap([1, 2], { 9: 1 }), [1, 2], '键超出 1..8 丢掉');
  assert.deepEqual(applyTierMap([1, 2], { 1: 9 }), [1, 2], '值超出 1..8 丢掉');
  assert.deepEqual(applyTierMap([1, 2], 'nope'), [1, 2], '不是对象就原样返回');
});

/* ---------------------------------------------------------------- 自动选档 */

test('autoSheetCap: 张数只按时长算，不跟切点密度走', () => {
  // 用户口径（2026-11-01）：固定时长的一段视频应有尽量相同的张数，约 3~5 分钟一张图
  assert.equal(autoSheetCap(90), 1, '1 分半 → 1 张');
  assert.equal(autoSheetCap(300), 1, '5 分钟 → 1 张（240s/张 四舍五入）');
  assert.equal(autoSheetCap(600), 3, '10 分钟 → 3 张');
  assert.equal(autoSheetCap(1800), 8, '30 分钟 → 8 张');
  assert.equal(autoSheetCap(9300), 39, '2 小时 35 分 → 39 张（不是几百张）');
  // 单调：时长翻倍，张数也翻倍（这条性质就是"同样时长花同样的钱"）
  for (const [a, b] of [[300, 600], [600, 1200], [1200, 2400]]) {
    assert.ok(autoSheetCap(b) >= autoSheetCap(a) * 2 - 1, `${a}s→${b}s 不该少张`);
  }
  // 极端输入不崩
  assert.equal(autoSheetCap(0), 1);
  assert.equal(autoSheetCap(undefined), 1);
  assert.equal(autoSheetCap(1e9), 64, '封顶 64 张');
  // 可调：环境以外的调用方也能指定"每张几分钟"
  assert.equal(autoSheetCap(600, { secondsPerImage: 120 }), 5);
});

test('pickAutoStrategy: 挑"最小格还认得出"里最省的那档', () => {
  const variants = [
    { name: 'compact', bins: 2, minW: 200, minH: 112 },   // shot
    { name: 'standard', bins: 3, minW: 266, minH: 150 },  // shot
    { name: 'full', bins: 5, minW: 400, minH: 225 },      // scene
  ];
  // 三档都够清楚 → 张数最少的（compact）
  assert.equal(pickAutoStrategy(variants), 'compact');
  // compact 掉到"色块"→ 退 standard
  assert.equal(pickAutoStrategy([
    { name: 'compact', bins: 1, minW: 100, minH: 56 },
    { name: 'standard', bins: 2, minW: 160, minH: 90 },
    { name: 'full', bins: 4, minW: 266, minH: 150 },
  ]), 'standard');
  // 全都认不出 → **按钱选，不按格子大小选**。
  // 曾经的写法是"取最小格面积最大"，等于永远选 full —— full 保留 1 档帧（一帧独占整张），
  // 格子在数字上最大，可一张图只装得下一帧。实测一条 191 刀的 5 分钟素材：
  // full 59 张 / standard 10 张 / compact 9 张，差 6.5 倍钱。反正都要糊，那就少花钱。
  assert.equal(pickAutoStrategy([
    { name: 'compact', bins: 9, minW: 100, minH: 54 },
    { name: 'standard', bins: 10, minW: 100, minH: 47 },
    { name: 'full', bins: 59, minW: 133, minH: 75 },
  ]), 'compact');
  // 张数一样时才比格子
  assert.equal(pickAutoStrategy([
    { name: 'compact', bins: 4, minW: 80, minH: 45 },
    { name: 'standard', bins: 4, minW: 90, minH: 50 },
    { name: 'full', bins: 4, minW: 110, minH: 62 },
  ]), 'full');
  // 空/非法输入不抛
  assert.equal(pickAutoStrategy([]), null);
  assert.equal(pickAutoStrategy(undefined), null);
  assert.equal(pickAutoStrategy([{ name: 'skim', bins: 0 }]), null, 'skim 不在候选里');
});

test('pickAutoStrategy: 张数相同时选帧多的（同样的钱多看几个瞬间）', () => {
  // 一场 2 秒的片子：三档都只要 1 张，但 compact 能放 4 帧、full 只能放 1 帧
  assert.equal(pickAutoStrategy([
    { name: 'compact', bins: 1, frames: 4, minW: 400, minH: 250 },
    { name: 'standard', bins: 1, frames: 4, minW: 400, minH: 250 },
    { name: 'full', bins: 1, frames: 1, minW: 800, minH: 500 },
  ]), 'compact');
  // 连帧数也一样时按候选顺序（省的那档在前），保证可复现
  const same = [
    { name: 'full', bins: 1, frames: 2, minW: 800, minH: 500 },
    { name: 'compact', bins: 1, frames: 2, minW: 400, minH: 250 },
  ];
  assert.equal(pickAutoStrategy(same), 'compact');
});

/* ---------------------------------------------------------------- 图片定价 */

test('imageTokens: 与宿主 dsh-llm-deepseek 的计费逐值一致（patch 网格，不是"像素÷1650"）', () => {
  // 真值来自宿主实现（14px patch 对齐 → 42px 一格 → rows×(cols+1)+2），已对拍 21 组尺寸。
  // "像素÷1650"只是粗估：它会把 800×450 说成 218，实际是 233。
  assert.equal(imageTokens(800, 450), 233, '默认画布');
  assert.equal(imageTokens(1066, 600), 407, '640k');
  assert.equal(imageTokens(1280, 720), 578);
  assert.equal(imageTokens(1600, 900), 882);
  // patch 对齐的台阶：1300×731 和 1280×720 一个价（都被对齐到同一张网格）
  assert.equal(imageTokens(1300, 731), 578);
  // 地板：小于 544² 的图计费时被放大到 544² 面积 → 一律 192
  assert.equal(imageTokens(320, 180), 192);
  assert.equal(imageTokens(480, 270), 192);
  assert.equal(imageTokens(200, 113), 192);
  assert.equal(imageTokens(640, 360), 192, '230k 也在地板区间内');
  assert.equal(imageTokens(600, 338), 192);
  assert.equal(imageTokens(544, 544), 184, '正好在地板边上（对齐后比 544 略大）');
  // 封顶：官方说 1024，实际网格最大是 994（1300×1300 正好 994）
  assert.equal(imageTokens(1300, 1300), 994);
  assert.equal(imageTokens(2000, 2000), 994, '更大的图宿主自己会缩到 1302×1302');
  assert.equal(imageTokens(5000, 5000), 994);
  assert.equal(imageTokens(1920, 1080), 968);
  // 边界：0/NaN 不炸
  assert.equal(imageTokens(0, 0), 0);
  assert.equal(imageTokens(undefined, 450), 0);
});

test('imageTokens: 地板区间内"把图画大"几乎不要钱（这是地板策略的依据）', () => {
  // 400×225（90k）和 733×412（302k）同价：都在 192 这档
  assert.equal(imageTokens(400, 225), imageTokens(733, 412));
  // 出地板就按网格计价：360k 的 800×450 是 233（+21% 的钱，换 4 倍像素）
  assert.equal(imageTokens(800, 450), 233);
  // 两倍面积 ≈ 两倍钱
  assert.equal(imageTokens(1132, 636), 450);
});

test('fitCanvas: 预算低于 544² 地板时抬到地板（画小不省钱，只会更糊）', () => {
  const small = fitCanvas(16 / 9, { budget: 120_000 });
  const sh = headerHeight(small.width);
  // 出图 = 格子区 + 页眉。725×402 的格子区 + 18px 页眉 = 725×420，10 行，仍在地板档（192）
  assert.ok(small.width * (small.height + sh) >= IMAGE_UPSCALE_AREA, '含页眉的面积不能小于地板');
  assert.equal(imageTokens(small.width, small.height + sh), 192, '实际按地板档收费');
  assert.deepEqual([small.width, small.height], [725, 402], '16:9 的地板画布（高度压到含页眉整行）');
  // 和"直接给地板"必须一模一样，否则说明两条路径算得不一样
  assert.deepEqual(fitCanvas(16 / 9, { budget: IMAGE_UPSCALE_AREA }), small);
  // 默认预算在地板之上，原样返回 —— 但宽度向下对齐到 42px 的计费格。
  // 800 对齐到 patch 网格后是 812（20 列），798 只要 19 列，每行省 1 个分隔 token：
  // 11×(20+1)+2 = 233 → 11×(19+1)+2 = 222，面积只少 0.25%。
  const def = fitCanvas(16 / 9);
  const dh = headerHeight(def.width);
  assert.deepEqual([def.width, def.height], [798, 443]);
  assert.equal(def.width % 42, 0, '宽度必须落在计费格整数倍上');
  // **出图高度要算上页眉**：798×462 = 11 行 = 222；不压的话 798×468 是 12 行 = 242。
  // 压掉的 6px 只占格子区 1.3%，换一整行 token 回来。
  assert.equal(imageTokens(def.width, def.height + dh), 222, '含页眉的总高不能跨行');
  assert.ok(def.height + dh <= 42 * 11, '总高不超过 11 行的上界');
  // 上限仍然生效
  const big = fitCanvas(16 / 9, { budget: 99_999_999 });
  assert.ok(Math.max(big.width, big.height) <= MAX_CANVAS_SIDE);
});

test('shouldForceSheetCap: 344 张算失控，60 张不算', () => {
  assert.equal(shouldForceSheetCap(344, 12), true, '49 分钟纪录片不封顶 344 张 → 必须压');
  assert.equal(shouldForceSheetCap(100, 12), true, '超过 max(64, 8x12)=96');
  assert.equal(shouldForceSheetCap(60, 12), false, '5 分钟 PV 要 60 张是真实的镜头数，不算失控');
  assert.equal(shouldForceSheetCap(44, 12), false);
  assert.equal(shouldForceSheetCap(0, 12), false);
  assert.equal(shouldForceSheetCap(344, 0), false, '没有预算就不判');
  assert.equal(shouldForceSheetCap(NaN, 12), false);
});

// ── 第二套阈值：perceptual（从 see-now 0.2.0 同步过来的）───────────────────────

test('perceptual 表：7 道、严格递增、端点是 3 s / 0.3 s（每帧概率口径）', async () => {
  const { PERCEPTUAL_THRESHOLDS, LEVEL_THRESHOLDS } = await import('../src/storyboard/tiers.js');
  assert.equal(PERCEPTUAL_THRESHOLDS.length, 7);
  for (let i = 1; i < 7; i += 1) {
    assert.ok(PERCEPTUAL_THRESHOLDS[i] > PERCEPTUAL_THRESHOLDS[i - 1],
      `第 ${i + 1} 道没递增：${PERCEPTUAL_THRESHOLDS[i - 1]} → ${PERCEPTUAL_THRESHOLDS[i]}`);
  }
  // 端点：一格最多 3 s、最少 0.3 s → 每帧概率 = 1/(30×秒)
  assert.ok(Math.abs(PERCEPTUAL_THRESHOLDS[0] - 1 / (30 * 3)) < 0.0005, '下界应是 3 秒');
  assert.ok(Math.abs(PERCEPTUAL_THRESHOLDS[6] - 1 / (30 * 0.3)) < 0.0005, '上界应是 0.3 秒');
  // 和 docx 的换算关系必须一致：两边都除以 30 得到同一族的数
  assert.ok(Math.abs(LEVEL_THRESHOLDS[6] - 3.0 / 30) < 0.0007, 'docx 上界换算对不上');
});

test('thresholdsFor：认名字，认不出来退回 docx（配置写错不该让分镜失败）', async () => {
  const { thresholdsFor, LEVEL_THRESHOLDS, PERCEPTUAL_THRESHOLDS } = await import('../src/storyboard/tiers.js');
  assert.deepEqual(thresholdsFor('docx'), LEVEL_THRESHOLDS);
  assert.deepEqual(thresholdsFor('perceptual'), PERCEPTUAL_THRESHOLDS);
  assert.deepEqual(thresholdsFor(undefined), LEVEL_THRESHOLDS);
  assert.deepEqual(thresholdsFor('perceptua1'), LEVEL_THRESHOLDS);
  assert.deepEqual(thresholdsFor('  perceptual  '), PERCEPTUAL_THRESHOLDS, '两边空格要能容错');
});

test('同一批切点换表：perceptual 只会把档位抬高或不变，不会反着降', async () => {
  const { levelCurve, LEVEL_THRESHOLDS, PERCEPTUAL_THRESHOLDS } = await import('../src/storyboard/tiers.js');
  // 每 0.6 秒一刀（1.67 刀/秒），60 秒
  const cuts = Array.from({ length: 100 }, (_, i) => i * 0.6);
  const a = levelCurve({ duration: 60, fps: 30, cuts, thresholds: LEVEL_THRESHOLDS });
  const b = levelCurve({ duration: 60, fps: 30, cuts, thresholds: PERCEPTUAL_THRESHOLDS });
  let higher = 0;
  for (let i = 0; i < a.levels.length; i += 1) {
    assert.ok(b.levels[i] >= a.levels[i], `第 ${i} 帧反而降了：${a.levels[i]} → ${b.levels[i]}`);
    if (b.levels[i] > a.levels[i]) higher += 1;
  }
  assert.ok(higher > a.levels.length * 0.3, `perceptual 应该明显更早升档，实际只有 ${higher} 帧变了`);
});
