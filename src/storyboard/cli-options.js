/**
 * cli-options.js — CLI 参数到 runStoryboard/manifest 的纯映射。
 *
 * 单独放在这里是为了能单测：CLI 曾经漏传 detail/ocr，导致 --detail high
 * 只改了清单字数、却没有真正开启硬字幕校正（#44）。映射一旦集中在这里，
 * 「高细节必须开 OCR」「manifest 必须保留 OCR 结果」都能被测试盯住。
 */

import { ocrFor } from './board.js';

/** CLI 的 --detail 是否该开 OCR（与工具路径共用 board.ocrFor 的唯一判据）。 */
export function cliOcr(opt = {}) {
  return ocrFor({ detail: String(opt.detail ?? 'med') });
}

/**
 * 把解析后的 CLI 参数翻成 runStoryboard() 的入参。
 * @param {{opt:object, geom:object, input:string, fetchOptions:object, adaptive:boolean,
 *          textOnly:boolean, tileFirst:boolean}} o
 */
export function runOptionsFromCli({
  opt = {}, geom = {}, input, fetchOptions, adaptive = true, textOnly = false, tileFirst = false,
} = {}) {
  return {
    input,
    fetchOptions,
    transcriptFile: opt['transcript-file'] ?? undefined,
    sourceHash: opt['source-hash'] === true,
    from: Number(opt.from) || 0,
    to: Number(opt.to) || 0,
    cells: Number(opt.cells) || 0,
    sheets: Number(opt.sheets) || 0,
    threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
    minGap: Number(opt['min-gap']) || 0,
    // --size 现在只是 --budget 的别名；格数上限由 need + 预算推。
    // 这三个必须由 boardGeometry 的 camelCase 结果喂进去，不能直接传 opt。
    budget: geom.budget,
    maxPerSheet: geom.maxPerSheet,
    need: geom.need,
    segment: Number(opt.segment) || 0,
    pick: String(opt.pick),
    burn: String(opt.burn),
    // --badge 0 必须真的等于 0：Number(0) || 0.15 会把它变成默认大小。
    badgeRatio: opt.badge === undefined ? 0.15 : Number(opt.badge),
    transcript: String(opt.transcript),
    adaptive,
    tileFirst,
    textOnly,
    // 这一段是 #44 的核心：detail=high 必须把 ocr=true 交给 pipeline，
    // 否则 CLI 只改了清单字数，硬字幕校正从入口起就没开。
    ocr: cliOcr(opt),
  };
}

/** --manifest 的 JSON 负载（含 OCR 结果；fixed=0 也保留，文本清单仍按原设计省 token）。 */
export function manifestFromCli({ input, r }) {
  return {
    input,
    window: r.window,
    threshold: r.threshold,
    summary: r.summary,
    provenance: r.provenance,
    audio: r.audio ? { mean: r.audio.mean, peak: r.audio.peak, silences: r.audio.silences } : null,
    transcript: r.transcript,
    plan: r.plan,
    // 清单正文在 fixed=0 时故意不写（省 token），但机器可读的 manifest 不能跟着丢：
    // 否则“OCR 跑过但一条没改”和“根本没开 OCR”在文件里无法区分。
    ...(r.ocr ? { ocr: r.ocr } : {}),
    sheets: r.sheets.map((s) => ({
      sheet: s.sheet, cols: s.cols, rows: s.rows, width: s.width, height: s.height,
      stripH: s.stripH ?? null, cells: s.cells,
    })),
  };
}
