/**
 * cli-options.js — CLI 参数到 runStoryboard/manifest 的纯映射。
 *
 * 单独放在这里是为了能单测：CLI 曾经漏传 detail/ocr，导致 --detail high
 * 只改了清单字数、却没有真正开启硬字幕校正（#44）。映射一旦集中在这里，
 * 「高细节必须开 OCR」「manifest 必须保留 OCR 结果」都能被测试盯住。
 */

import { defaultBoardStrategy, ocrFor } from './board.js';

/** CLI 的 --detail 是否该开 OCR（与工具路径共用 board.ocrFor 的唯一判据）。 */
export function cliOcr(opt = {}) {
  return ocrFor({ detail: String(opt.detail ?? 'med') });
}

/**
 * 把解析后的 CLI 参数翻成 runStoryboard() 的入参。
 * @param {{opt:object, geom:object, input:string, fetchOptions:object,
 *          textOnly:boolean}} o
 */
export function runOptionsFromCli({
  opt = {}, geom = {}, input, fetchOptions, textOnly = false,
} = {}) {
  return {
    input,
    fetchOptions,
    transcriptFile: opt['transcript-file'] ?? undefined,
    sourceHash: opt['source-hash'] === true,
    from: Number(opt.from) || 0,
    to: Number(opt.to) || 0,
    // **只有三个几何旋钮**：帧数上限 / 升降档策略 / 画布像素（<= 640k）。
    // 0 = 没给（用 pipeline 默认）；0 若透传下去就是「最多 1 帧」
    maxFrames: Number(opt.frames) || Number(opt['max-frames']) || undefined,
    maxSheets: Number(opt['max-sheets']) || undefined,
    // --tier-map '{"1":3,"5":4}'（JSON）；坏 JSON 当没给，不让整次运行失败
    tierMap: (() => {
      const raw = opt['tier-map'];
      if (typeof raw !== 'string' || !raw.trim()) return undefined;
      try { return JSON.parse(raw); } catch { return undefined; }
    })(),
    // 不给就用 board 的默认（auto，可被 DSH_STORYBOARD_AUTO 关掉）；旧名由 resolveStrategy 归一化
    strategy: opt.strategy || defaultBoardStrategy(),
    integral: opt.integral === 'off' ? false : (opt.integral === 'on' ? true : undefined),
    integralSeconds: Number(opt['integral-seconds']) || undefined,
    threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
    scanGap: opt['scan-gap'] === undefined ? undefined : Number(opt['scan-gap']),
    budget: geom.budget,
    maxCanvasSide: geom.maxCanvasSide,
    segment: Number(opt.segment) || 0,
    pick: String(opt.pick),
    burn: String(opt.burn),
    transcript: String(opt.transcript),
    textOnly,
    // --dry-run：只扫描+排布，回报切点数与每档张数，不出图（与工具的 dryRun 同一路径）
    planOnly: opt['dry-run'] === true,
    /**
     * 阴影对照（`--scene shadow --model <模型.json>`）。CLI 一贯只认显式开关
     * （它也不读 video.json 的 `storyboard.*`），所以这里不做任何配置兜底 ——
     * 没给 `--scene` 就跟以前完全一样。
     */
    ...(opt.scene ? { sceneDetector: String(opt.scene) } : {}),
    ...(opt.model ? { liquidModel: String(opt.model) } : {}),
    ...(Number(opt['shadow-stride']) > 1 ? { shadowStride: Math.round(Number(opt['shadow-stride'])) } : {}),
    ...(opt['shadow-log'] ? { shadowLog: String(opt['shadow-log']) } : {}),
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
    // 阴影对照（只在开了 `--scene shadow` 时出现）：分歧率是给人看的数字，必须进清单
    ...(r.shadow ? { shadow: r.shadow } : {}),
    // 场景检测器的结论（`liquid` 有没有接管、没接管的原因）—— 清单里必须能对上，
    // 否则"我明明开了 liquid"和"其实一直在跑 hsv"在文件里区分不出来
    ...(r.sceneDetector ? { sceneDetector: r.sceneDetector } : {}),
    sheets: r.sheets.map((s) => ({
      sheet: s.sheet, width: s.width, height: s.height,
      stripH: s.stripH ?? null, cells: s.cells,
    })),
  };
}
