/**
 * features.js — 把一帧 64×36 的 HSV 压成 14 维。
 *
 * ## 为什么不接 CNN / CLIP
 *
 * 部署形态是**进程内、零依赖、实时 12fps**。任何视觉骨干都出局（权重体积 + 依赖 + 延迟）。
 * 而且切分要的是"变化"，不是"语义"：
 *
 *   一个 64×36 的降采样帧里，能区分"变的是中间还是四周"的就是块级变化场（6×4）。
 *   而"变的是中间还是四周"恰好是现在靠 `cutBg*` / `cutIsolated*` / `cutFuture*` 那 20 个
 *   手工阈值在描述的东西 —— **同一个信息，从阈值换成特征**。
 *
 * 这不是"退而求其次"，是把已经花掉的计算用满：`scan.js` 为了算一个标量分数，
 * 已经把整帧转成 HSV 了。块级统计和直方图是同一份缓冲上的第二次读取，边际成本接近 0。
 *
 * ## 14 维的来历
 *
 *   #   名字        来源           为什么留着
 *   1   s_adj       相邻帧差       现在唯一的判据，必须保留作为"基线信号"
 *   2   s_long      长时差 0.4s    叠化在相邻帧上看不见，必须隔开看
 *   3   s_mc       运动补偿差     快摇/平移的抑制信号（关掉时置 0）
 *   4   v_mean      亮度均值       暗场/黑场的上下文
 *   5   fp_dist     块指纹距离     "结构有没有变"，与"颜色有没有变"分离
 *   6   blk_mean    块级变化均值   比整帧均值更稳（噪声被 24 块平摊）
 *   7   blk_std     块级变化方差   **局部换 vs 全局闪**的分界线
 *   8   blk_max     块级变化最大   小面积硬切（画中画、字幕卡）
 *   9   blk_frac    变化块占比     "有多少比例的格子变了"
 *   10  hist_h      色相直方图距离 同亮度换色（scdet 就死在这）
 *   11  hist_sv     饱和+亮度距离  同色相换明暗
 *   12  bar         黑边占比       letterbox 会让整帧均值失真
 *   13  dt          帧间隔         **CfC 的必要输入**，抽帧率变了行为要自动一致
 *   14  age         距上次放电     不应期入状态，而不是外挂 markMinGap 常量
 *
 * 前 12 维全是"画面"，后 2 维是"时间"。这个分界线要守住：时间量不许混进画面统计，
 * 否则模型会学到"采样率"而不是"内容"。
 *
 * ## 顺序即契约
 *
 * `FEATURES` 的数组顺序就是二进制权重文件里的顺序，也是归一化参数的顺序。
 * **改顺序 = 旧权重全废**。要加特征只能往后追加，并在 json 里升 `featureVersion`。
 */

/** 块级变化的网格。6×4 是在 64×36 上"每块约 10×9 像素"——再细就全是编码噪声。 */
export const BLK_W = 6;
export const BLK_H = 4;

/**
 * 特征名。**顺序是契约，只能追加，不能重排。**
 *
 * ⚠️ 曾经试过 v4：在末尾追加 24 维**绝对**块亮度（6×4 的亮度缩略图），
 * 想补上"此刻画面里有什么"这层静态信息。**实测对本任务是零收益**：
 * 逻辑回归 85.9 → 85.8，CfC 96.4 → 96.1（都是 5 折，差异在噪声内）。
 * 原因不难理解 —— 切点是"变化"任务，静态构图对它没有信息量。
 * 如果将来要做"选有内容的画面"（字幕/UI/海报），那 24 维才是对症的，
 * 到时按 `git log` 里那条 v4 提交恢复即可（`out[i+14] = curBlk[i]`）。
 */
export const FEATURES = Object.freeze([
  's_adj', 's_long', 's_mc', 'v_mean', 'fp_dist',
  'blk_mean', 'blk_std', 'blk_max', 'blk_frac',
  'hist_h', 'hist_sv',
  'bar', 'dt', 'age',
]);

export const DIM = FEATURES.length;

/**
 * 特征表版本。改顺序/语义时 +1，权重加载时对不上就拒绝。
 *
 * v2：`s_mc` 从恒 0 变为真实的运动补偿分（v1 的样本里它是一列常数，等于没有这一维）。
 * v3：**`s_adj` / `s_long` 开始真正写入**（v1/v2 的样本里这两列恒为 0，见 `push()` 里的说明）。
 *     v1/v2 的 `.feat` 缓存必须重抽，v2 的权重不能再加载。
 * v4：**修 `s_long` 的环形缓冲预热 bug**（见 `push()` 里"读在写前"那段注释）。
 *     v3 的样本里，每段开头 `lag .. 2lag-2` 帧（25fps 下是第 10~18 帧）的 `s_long`
 *     是拿**全 0 缓冲**比出来的，量级约 50 而正常 `s_adj` 只有 5~20 —— 等于每段开头
 *     塞给模型一串"假巨变"。**语义变了，所以 v3 的缓存和权重全部作废**。
 *
 * v4 之前试过又撤了的：24 维绝对块亮度（实测对切点零收益，理由见 `FEATURES` 上方注释）。
 */
export const FEATURE_VERSION = 4;

/** 色相直方图 bin 数。12 个（每 30°）够区分"换色系"，再多就被编码噪声填满。 */
export const HUE_BINS = 12;
/** 饱和 / 亮度各 4 bin。 */
export const SV_BINS = 4;

/** 黑边判定：该行 V 均值低于它算黑。与 scan.js 的 `BAR_MEAN` 同源。 */
export const BAR_MEAN = 16;

/** `age` 的初始值（秒）。给一个"很久没放电"的大数，让第一帧不受不应期压制。 */
const AGE_INIT = 10;

/**
 * @param {{w?:number, h?:number, fps?:number, longSec?:number, scorePair?:Function}} o
 *   `scorePair` 传进来是为了**和 scan.js 用完全相同的度量**——各写一份必然漂。
 */
export function createFeatures({
  w = 64, h = 36, fps = 12, longSec = 0.4, scorePair = null,
  mcScore = null, mcOpts = null,
} = {}) {
  if (!(w > 0 && h > 0)) throw new RangeError('w/h 必须为正');
  const n = w * h;
  const blkCells = BLK_W * BLK_H;
  const hueBins = HUE_BINS;
  const svBins = SV_BINS * 2;

  /**
   * ---- 构造期算一次的表 ------------------------------------------------
   *
   * 原来这三个映射都是**每个像素**现算的（`Math.floor((x * BLK_W) / w)` 等），
   * 2304 像素 × 每帧 = 每帧四千多次除法和取整。尺寸在一份素材里是常数，
   * 没有理由每帧重算。三个表的取值与原式逐位一致（同一公式、同一 Math.floor）。
   */
  const byOf = new Int32Array(h);
  for (let y = 0; y < h; y += 1) byOf[y] = Math.min(BLK_H - 1, Math.floor((y * BLK_H) / h));
  const bxOf = new Int32Array(w);
  for (let x = 0; x < w; x += 1) bxOf[x] = Math.min(BLK_W - 1, Math.floor((x * BLK_W) / w));
  /** 每块的像素数。原实现是在热循环里 `+= 1` 数出来的，其实只取决于尺寸。 */
  const blkCnt = new Float64Array(blkCells);
  for (let y = 0; y < h; y += 1) {
    const base = byOf[y] * BLK_W;
    for (let x = 0; x < w; x += 1) blkCnt[base + bxOf[x]] += 1;
  }
  /**
   * 每个块列的右边界（行内 3 倍像素坐标）。
   *
   * 用它可以把一行拆成"按块连续读"：游标 `i` 一直往前推进，不再需要每像素算
   * `bi = by * BLK_W + bx`，也不需要算 `(y*w+x)*3`。
   */
  const xStop3 = new Int32Array(BLK_W);
  let xCursor = 0;
  for (let bx = 0; bx < BLK_W; bx += 1) {
    for (let x = 0; x < w; x += 1) if (bxOf[x] === bx) xCursor = x + 1;
    // 空块（BLK_W > w 时可能出现）沿用上一块的右边界，保证游标单调
    xStop3[bx] = xCursor * 3;
  }
  /** `bins / 255` 折叠成一次乘法；`| 0` 代替 `Math.floor`（hh/ss/vv 都非负）。 */
  const KH = hueBins / 255;
  const KS = SV_BINS / 255;
  const hLast = hueBins - 1;
  const svLast = SV_BINS - 1;
  const edge = Math.max(1, Math.round(h * 0.08));

  const prev = new Float32Array(n * 3);
  let hasPrev = false;

  const lag = Math.max(1, Math.round(longSec * fps));
  const ring = Array.from({ length: lag }, () => new Float32Array(n * 3));
  let ringIdx = 0;
  let ringWarm = 0;

  const prevHue = new Float32Array(hueBins);
  const prevSv = new Float32Array(svBins);
  const curHue = new Float32Array(hueBins);
  const curSv = new Float32Array(svBins);

  const prevBlk = new Float32Array(blkCells);
  const curBlk = new Float32Array(blkCells);
  /** 块差。原来每帧 `new Float32Array(blkCells)` —— 每秒 25 次小对象分配。 */
  const diffs = new Float64Array(blkCells);

  const out = new Float32Array(DIM);
  let lastT = null;
  let lastDischarge = null;

  /**
   * HSV → 直方图 + 块亮度。一次遍历，两个产物。
   *
   * 结构：`行 → 块列 → 该块在本行覆盖的像素`。三个好处：
   *   1. 块下标 `bi` 是循环变量，不用每像素算；
   *   2. 像素下标就是一个只加 3 的游标 `i`；
   *   3. 每行一次 `rowSum`，黑边判定不必再维护 `rowV[h]` 数组。
   * 遍历顺序与"逐像素行主序"完全一致，所以累加顺序不变、结果逐位相同。
   */
  function analyze(buf) {
    curHue.fill(0);
    curSv.fill(0);
    curBlk.fill(0);
    let vSum = 0;
    let darkRows = 0;
    let i = 0;
    for (let y = 0; y < h; y += 1) {
      const rowBase = y * w * 3;
      const byBase = byOf[y] * BLK_W;
      let rowSum = 0;
      for (let bx = 0; bx < BLK_W; bx += 1) {
        const stop = rowBase + xStop3[bx];
        let acc = 0;
        while (i < stop) {
          const hh = buf[i];
          const ss = buf[i + 1];
          const vv = buf[i + 2];
          i += 3;
          acc += vv;

          let hb = (hh * KH) | 0;
          if (hb > hLast) hb = hLast;
          curHue[hb] += 1;
          let sb = (ss * KS) | 0;
          if (sb > svLast) sb = svLast;
          curSv[sb] += 1;
          let vb = (vv * KS) | 0;
          if (vb > svLast) vb = svLast;
          curSv[SV_BINS + vb] += 1;
        }
        curBlk[byBase + bx] += acc;
        rowSum += acc;
      }
      vSum += rowSum;
      // 黑边：只数最上/最下 edge 行。中间的黑不算（舞台剧、夜景会误判）。
      if (y < edge || y >= h - edge) {
        if (rowSum / w < BAR_MEAN) darkRows += 1;
      }
    }

    for (let k = 0; k < blkCells; k += 1) curBlk[k] /= (blkCnt[k] || 1);
    for (let k = 0; k < hueBins; k += 1) curHue[k] /= n;
    for (let k = 0; k < svBins; k += 1) curSv[k] /= n;

    return { vMean: vSum / n, bar: darkRows / (edge * 2) };
  }

  /** 两个直方图的 L1 距离，归一到 0..1。 */
  function histDist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
    return s / 2;   // 两个归一化分布，L1 的一半就是"总变化比例"
  }

  return {
    dim: DIM,
    names: FEATURES,

    /**
     * 喂一帧。`hsv` 必须是长度 w*h*3 的 HSV（H/S/V 各 0..255）。
     *
     * @returns {Float32Array} 复用同一个缓冲，**调用方要立刻用或拷贝**
     */
    push(hsv, t) {
      if (!hsv || hsv.length !== n * 3) throw new RangeError(`帧长度应为 ${n * 3}，得到 ${hsv?.length}`);
      const { vMean, bar } = analyze(hsv);

      let sAdj = 0;
      let sLong = 0;
      let fpDist = 0;
      let blkMean = 0;
      let blkStd = 0;
      let blkMax = 0;
      let blkFrac = 0;
      let histH = 0;
      let histSv = 0;

      if (hasPrev) {
        // 相邻帧：交给调用方传进来的 scorePair（与 scan.js 同一度量）
        sAdj = scorePair ? scorePair(prev, hsv) : fallbackPair(prev, hsv);

      /**
       * 环形缓冲：**无条件写**，读在写前。
       *
       * ## 这里修过一个真 bug（v4，2026-11-22）
       *
       * 原写法是
       *   `if (warm) ring[idx].set(); else warm += 1; if (warm >= lag) ring[idx].set();`
       * 预热那几帧**一帧都不写**，可 `ringWarm` 一满就立刻开始读 —— 于是第
       * `lag .. 2lag-2` 帧的 `s_long` 是拿**全 0 缓冲**跟当前帧比出来的，
       * 量级约 `(mean_S + mean_V)/3 ≈ 50`，而正常 `s_adj` 只有 5~20。
       * 也就是每段开头 0.4 秒会塞给模型一串"假巨变"。
       *
       * `scan.js` 的同名逻辑一直是无条件写的，所以**它没有这个问题**（那边的 `longStats` 是对的）。
       *
       * ## 为什么"读在写前"正好是 lag 帧之前那一帧
       *
       * 处理第 f 帧时 `ringIdx === f % lag`，而 `ring[f % lag]` 上一次被写是第 `f-lag` 帧
       * （`(f-lag) % lag === f % lag`）。所以先读后写拿到的就是 `hsv_{f-lag}`。
       */
      if (ringWarm >= lag) {
        const old = ring[ringIdx];
        sLong = scorePair ? scorePair(old, hsv) : fallbackPair(old, hsv);
      }

        // 块级：先算每块的 V 差，再出四个统计量。
        // 两遍扫描（先求均值、再求方差）是原实现就有的，这里只把
        // 每帧的 `new Float32Array` 换成复用缓冲，并把 `** 2` 写成 `z * z`。
        let sum = 0;
        for (let i = 0; i < blkCells; i += 1) {
          const d = Math.abs(curBlk[i] - prevBlk[i]);
          diffs[i] = d;
          sum += d;
          if (d > blkMax) blkMax = d;
        }
        blkMean = sum / blkCells;
        let varSum = 0;
        let changed = 0;
        for (let i = 0; i < blkCells; i += 1) {
          const d = diffs[i];
          const z = d - blkMean;
          varSum += z * z;
          if (d > 12) changed += 1;                  // 12 = 单块"明显变了"的地板
        }
        blkStd = Math.sqrt(varSum / blkCells);
        blkFrac = changed / blkCells;

        /**
         * 指纹距离 `fp_dist` 与 `blk_mean` **是同一个数**：两者都是
         * `Σ|curBlk[i] - prevBlk[i]| / 24`，只是原来算了两遍。
         *
         * （所以 14 维里实际只有 13 个互不相同；这不影响已训好的权重 ——
         * 一列重复对网络就是"同一条信息出现在两个位置"，删掉才会破坏契约。）
         * 这里直接复用，省掉第三遍 24 次取绝对值。
         */
        fpDist = blkMean;

        histH = histDist(curHue, prevHue);
        histSv = histDist(curSv, prevSv);
      }

      const dt = lastT === null ? 1 / fps : clamp(t - lastT, 1 / (fps * 4), 1.0);
      /**
       * `age` 必须**随时间增长**，即使一次都没放过电。
       *
       * 早先写成 `lastDischarge === null ? AGE_INIT : t - lastDischarge`，于是没放过电时
       * 它恒等于 10 —— 模型看到的是一个常数，等于"这一维没信息"。而且第一帧和第一万帧
       * 的 age 一样大，网络没法从它学到"开场往往没有切点"这种事。
       *
       * 现在 = 初值 + t，单调递增且开局就很大（不压制首个切点）。
       */
      const age = lastDischarge === null ? AGE_INIT + t : t - lastDischarge;

      /**
       * `s_mc`：运动补偿分。**这一维是探针跑完之后补上的。**
       *
       * 探针（`bench/eval/probe/`）的结论很直接：14 维里没有运动补偿时，
       * BBC 的 oracle F1 只有 83.3%（基线 mc 90.1%），SHOT 只有 64.4%（基线 69.1%）——
       * 即使把真值刀数告诉它，Top-K 也打不赢现有算法。缺的就是这一维：
       * `mc` 模式靠"每个格子在下一帧附近找最像的位置"把运镜和真切点分开，拿到 90.1。
       *
       * 计算成本比 `s_adj` 贵 3~5 倍（每块 25 次邻域比较），所以默认关：
       * 只评测/训练时打开。线上如果整条链路换成 CfC，这一维就是必需品。
       */
      /**
       * ⚠️ **前两维曾经是死的（2026-11-20 修）**。
       *
       * `sAdj` / `sLong` 一直只算进局部变量、**从没写进 `out`** —— 于是 `FEATURES[0]`、
       * `FEATURES[1]` 恒为 0，14 维里实际只有 12 维活着。
       *
       * 为什么一直没被发现：单测只覆盖了"第一帧"和"相同两帧"，那两种情况下 s_adj
       * 本来就该是 0，断言 0 全过。而下游更难发现 —— 一列常数对 BCE 只是"没信息"，
       * 切点 F1 照样能到 90（靠 `blk_*` / `hist_*`）。真正被它打死的是 `q` 头：
       * 它的 teacher 是 `acc += s_adj`，累加一列 0 得到恒为 0 的目标，
       * 模型被训成"永远输出 0"，表现为"膜电位学不出来"。
       *
       * 顺序即契约，所以**不能靠挪位置修**；补上赋值 + 升 `FEATURE_VERSION` 才是唯一正解。
       */
      out[0] = sAdj;
      out[1] = sLong;
      out[2] = (hasPrev && mcScore) ? mcScore(prev, hsv, w, h, mcOpts ?? {}) * 255 : 0;
      out[3] = vMean;
      out[4] = fpDist;
      out[5] = blkMean;
      out[6] = blkStd;
      out[7] = blkMax;
      out[8] = blkFrac;
      out[9] = histH;
      out[10] = histSv;
      out[11] = bar;
      out[12] = dt;
      out[13] = age;


      // 轮转
      prev.set(hsv);
      prevBlk.set(curBlk);
      prevHue.set(curHue);
      prevSv.set(curSv);
      hasPrev = true;
      /**
       * 环形缓冲**无条件写**，且只写一次。
       * 原写法在预热期跳过写入（那是上面那个 bug 的根源），预热结束后又因为两个 `if`
       * 同时成立而每帧白拷两遍 27 KB。现在一个 set。
       */
      ring[ringIdx].set(hsv);
      ringIdx = (ringIdx + 1) % lag;
      if (ringWarm < lag) ringWarm += 1;
      lastT = t;

      return out;
    },

    /** 事件反馈：放电后调用，把 `age` 归零。 */
    discharge(t) {
      lastDischarge = t;
    },

    reset() {
      hasPrev = false;
      ringWarm = 0;
      ringIdx = 0;
      lastT = null;
      lastDischarge = null;
    },
  };
}

/** 没有传 scorePair 时的退化实现。**只用于单测**，线上必须传真的。 */
function fallbackPair(a, b) {
  let sum = 0;
  for (let i = 0; i < b.length; i += 3) {
    const dh = Math.abs(b[i] - a[i]);
    sum += Math.min(dh, 255 - dh) * 0.34 + Math.abs(b[i + 1] - a[i + 1]) * 0.33 + Math.abs(b[i + 2] - a[i + 2]) * 0.33;
  }
  return sum / (b.length / 3);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
