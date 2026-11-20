/**
 * shadow-report.js — 把 `shadow-cuts.jsonl` 读成人能判断的东西。
 *
 * ## 为什么需要它
 *
 * shadow 每跑一段素材就往日志里追加一行。单看一行只能知道"这一段差多少"，
 * 而"要不要把切点换成模型出"是个**跨素材**的判断 —— 需要看：
 *
 *   1. 有效读数有几条（`ok:false`、两边都是 0 刀、截断的都不算）；
 *   2. 加权后的分歧率（按刀数加权，不是把几个百分比取平均 —— 刀多的段更可信）；
 *   3. 分歧的分布（<3% / 3~8% / 8~15% / >15%），一支片子掉进 >15% 就说明那类素材不认。
 *
 * 这一层只做**陈述**，不做决定：判据（3%~8% 正常、>15% 不适用）写在交接文档里，
 * 工具只把它算出来并标出来，免得每次都靠人肉对照时间戳。
 *
 * 纯函数：输入日志文本，输出结构。不读盘、不打印，方便单测。
 */

/** 干净读数的门槛：少于这么多条就还判断不了。 */
export const MIN_VALID_READS = 20;

/** 分歧率的分档（右开）。与交接里的判据同一套数。 */
export const BUCKETS = Object.freeze([
  { name: '<3%', max: 0.03 },
  { name: '3~8%', max: 0.08 },
  { name: '8~15%', max: 0.15 },
  { name: '>15%', max: Infinity },
]);

/** 一行 JSONL → 记录。坏行（截断写坏、手改过）直接丢掉，不让它把整份日志读废。 */
export function parseShadowLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && typeof r === 'object') out.push(r);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 当前日志口径版本（`shadow.js` 写进每行）。缺这个字段 = 旧口径，时间基准可能不同。 */
export const LOG_VERSION = 1;

/**
 * 一条记录为什么"不算有效读数"。空数组 = 有效。
 *
 * **0/0 是最容易骗人的一种**：`divergenceRate` 兜底成 0，看起来"完全一致"，
 * 实际上是两边都没出点（录屏素材就这样）。拿它当证据会得出反向结论。
 */
export function flagsOf(r) {
  const f = [];
  if (r?.ok !== true) f.push(`失败：${r?.error ?? '未知'}`);
  if (!(Number(r?.v) >= LOG_VERSION)) f.push('旧口径（时间基准可能不同）');
  if (r?.truncated) f.push('截断');
  if (Number(r?.stride) > 1) f.push(`降采样 ×${r.stride}`);
  if (Number(r?.cutsHsv) === 0 && Number(r?.cutsLiquid) === 0) f.push('两边都是 0 刀');
  else if (Number(r?.cutsHsv) === 0 || Number(r?.cutsLiquid) === 0) f.push('只有一边出点');
  return f;
}

/** 分档：落在哪个区间（用分歧率，0 = 完全一致）。缺值返回 null —— **别把 null 当 0**。 */
export function bucketOf(rate) {
  if (rate === null || rate === undefined || rate === '') return null;
  const v = Number(rate);
  if (!Number.isFinite(v)) return null;
  return BUCKETS.find((b) => v < b.max)?.name ?? null;
}

/**
 * 汇总一批记录。
 *
 * @param {object[]} records `parseShadowLog()` 的输出
 * @returns {{rows:object[], totals:object, buckets:object, verdict:object}}
 */
export function summarizeShadow(records = []) {
  const rows = [];
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b.name, 0]));
  let valid = 0;              // 有效读数 = 两边都出点、没失败、没截断、没降采样
  let sumHsv = 0;
  let sumLiquid = 0;
  let sumAgreed = 0;
  let failed = 0;

  for (const r of records) {
    const flags = flagsOf(r);
    const ok = flags.length === 0;
    if (r?.ok !== true) failed += 1;
    if (ok) {
      valid += 1;
      sumHsv += Number(r.cutsHsv) || 0;
      sumLiquid += Number(r.cutsLiquid) || 0;
      sumAgreed += Number(r.agreed) || 0;
      const b = bucketOf(r.divergenceRate);
      if (b) buckets[b] += 1;
    }
    rows.push({
      ts: r?.ts ?? null,
      video: r?.video ?? null,
      window: r?.window ?? null,
      fps: r?.fps ?? null,
      cutsHsv: Number(r?.cutsHsv) || 0,
      cutsLiquid: Number(r?.cutsLiquid) || 0,
      agreed: Number(r?.agreed) || 0,
      divergenceRate: Number.isFinite(Number(r?.divergenceRate)) ? Number(r.divergenceRate) : null,
      msFeature: Number(r?.msFeature) || 0,
      msForward: Number(r?.msForward) || 0,
      ok: r?.ok === true,
      flags,
      usable: ok,
    });
  }

  const totalCuts = sumHsv + sumLiquid;
  const totals = {
    records: records.length,
    /** 有效读数：两边都出点、没失败、没截断、没降采样 ——**判断只能靠这些** */
    usable: valid,
    failed,
    sumHsv,
    sumLiquid,
    sumAgreed,
    /** 按刀数加权：`1 - 2Σagreed/Σ(hsv+liquid)`。没有有效读数时是 null。 */
    rate: totalCuts === 0 ? null : +(1 - (2 * sumAgreed) / totalCuts).toFixed(3),
  };

  return { rows, totals, buckets, verdict: verdictOf(totals) };
}

/**
 * 结论分三档。措辞刻意保守：工具不替人决定要不要切 `liquid`。
 *
 * @param {{usable:number, rate:number|null}} totals
 */
export function verdictOf(totals) {
  const n = Number(totals?.usable) || 0;
  const rate = totals?.rate;
  if (n === 0) {
    return {
      level: 'insufficient',
      text: '还没有一条有效读数。需要"两边都出点"的素材（有硬切的真人剪辑片）——'
        + '录屏/动效片两边都是 0 刀，读数没有信息量。',
    };
  }
  if (n < MIN_VALID_READS) {
    return {
      level: 'insufficient',
      text: `有效读数 ${n} 条，还不够（门槛 ${MIN_VALID_READS} 条）。加权分歧率 ${rate === null ? '—' : `${(rate * 100).toFixed(1)}%`} 只能当参考。`,
    };
  }
  if (rate === null) return { level: 'insufficient', text: '有效读数里两边都没出点，无法计算。' };
  if (rate <= 0.08) {
    return { level: 'promising', text: `加权分歧率 ${(rate * 100).toFixed(1)}%，落在 3%~8% 的正常带里 —— 这时才值得讨论切 liquid。` };
  }
  if (rate > 0.15) {
    return { level: 'risky', text: `加权分歧率 ${(rate * 100).toFixed(1)}% 超过 15% —— 模型不认这类素材，这时切 liquid 会出事。` };
  }
  return { level: 'watch', text: `加权分歧率 ${(rate * 100).toFixed(1)}%，介于 8%~15% —— 先看 onlyHsv 的样本是不是假切点。` };
}
