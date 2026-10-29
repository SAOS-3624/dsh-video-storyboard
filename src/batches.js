/**
 * batches.js — 批次时长表：开头短、逐段加长、最后稳定。
 *
 * 为什么不是固定批次：固定 5 分钟意味着**第一次说话要等将近 5 分钟**。
 * 用户刚点开视频，最想要的是"它已经跟上了"这个确认感，而不是等满一个批次。
 *
 * 所以开头短、后面逐渐加长：
 *
 *   1 分钟 → 2 分钟 → 3 分钟 → 4 分钟 → 5 分钟 → 5 分钟 → …
 *
 * 短批次只在起步时出现，代价是那几分钟多跑几次分镜；稳定后回到 5 分钟一档，
 * 长期成本和固定批次一样。
 *
 * 这个模块是**唯一的批次边界来源**：循环用它排段、工具用它找"当前在第几段"，
 * 两边必须用同一张表，否则会出现"它说 04:00 开始、实际建的是 03:00 那段"。
 */

/**
 * 默认余量（秒）。用户定的：**少于 5 分钟不保险**。
 * 按段数算的话，开头 1/2/3 分钟一段，"两段"只有 2 分钟。
 */
export const DEFAULT_LOOKAHEAD = 300;

/** 默认起步：1/2/3/4 分钟，之后稳定到 segment */
export const DEFAULT_RAMP = Object.freeze([60, 120, 180, 240]);
/** 稳定档（秒） */
export const DEFAULT_SEGMENT = 300;

/**
 * @param {object} o
 * @param {number} [o.segment] 稳定后的批次长度（秒）
 * @param {number[]|null} [o.ramp] 起步阶梯；不传 = 用默认阶梯；传 null/[] = 全程等长
 */
export function makePlan({ segment = DEFAULT_SEGMENT, ramp } = {}) {
  const steady = Number(segment) > 0 ? Number(segment) : DEFAULT_SEGMENT;
  // undefined = 用默认阶梯；null / [] = 明确不要阶梯（库/测试的等长行为）
  const source = ramp === undefined ? DEFAULT_RAMP : ramp;
  const steps = Array.isArray(source) && source.length > 0
    ? source.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];

  const sizeAt = (index) => (index < steps.length ? steps[index] : steady);

  /** 前 n 段的起点（含第 n 段起点，便于取边界） */
  const starts = [0];
  for (let i = 0; i < 512; i += 1) starts.push(starts[i] + sizeAt(i));

  const indexAt = (pos) => {
    const p = Math.max(0, Number(pos) || 0);
    let i = 0;
    while (i < starts.length - 1 && starts[i + 1] <= p) i += 1;
    return i;
  };

  return {
    segment: steady,
    ramp: steps,
    sizeAt,
    starts,
    indexAt,
    /** 覆盖 pos 的那一段 */
    segmentAt(pos) {
      const i = indexAt(pos);
      return { index: i, from: starts[i], to: starts[i] + sizeAt(i), size: sizeAt(i) };
    },
    /** 从第 index 段开始，往后取 count 段 */
    from(index, count) {
      const out = [];
      for (let k = 0; k < count; k += 1) {
        const i = index + k;
        out.push({
          index: i,
          from: starts[i],
          to: starts[i] + sizeAt(i),
          size: sizeAt(i),
          sayAt: starts[i] + sizeAt(i) - 15,
        });
      }
      return out;
    },
    /** 是否还处在"加长阶段"（给 statusOnly 看） */
    isRamping(index) {
      return index < steps.length;
    },
  };
}

/** 人类可读的阶梯描述，例如 "1m → 2m → 3m → 4m → 5m" */
export function describePlan(plan) {
  const head = plan.ramp.map((x) => `${Math.round(x / 60)}m`).join(' → ');
  const tail = `${Math.round(plan.segment / 60)}m`;
  return head ? `${head} → ${tail}（之后固定）` : tail;
}

/**
 * 余量按**时间**算，不按段数算。
 *
 * 为什么："留两段"在开头只等于 2 分钟（批次表是 1/2/3/4/5 分钟），
 * 比一次构建失败还短 —— 那时候的"余量"其实等于没有余量。
 *
 * 这里返回"当前段之后还要备好几段"，使**当前位置之后已就绪的时长 ≥ lookahead 秒**：
 * 从下一段开始累加，凑够 lookahead 为止。稳定档 5 分钟时结果是 2（当前 + 下一段），
 * 和旧的固定两段一致；开头段短，就会自动变成 3 段、4 段。
 *
 * 之所以从**下一段**开始算：当前段的剩余时长随播放位置变化，不能拿它当余量。
 * 这样任何位置上的最小余量都恰好 ≥ lookahead，而不是"平均看起来够"。
 */
export function depthForBuffer(plan, index, lookahead = 300) {
  const target = Number(lookahead);
  if (!(target > 0)) return 1;
  let acc = 0;
  let ahead = 0;
  // 256 是保险丝：万一 sizeAt 返回 0（不该发生），别在这里转死
  while (acc < target && ahead < 256) {
    ahead += 1;
    acc += Number(plan.sizeAt(index + ahead)) || 0;
  }
  return 1 + ahead;
}
