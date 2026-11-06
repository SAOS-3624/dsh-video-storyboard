/**
 * storyboard/tool-spec.js — 视频识别那四个工具的 schema 与兜底校验。
 *
 * `video_storyboard` / `video_zoom` / `video_probe` / `video_locate` 的契约都在这里。
 * 陪看那份不在这里 —— `watch_together` 属于另一个包 `dsh-watch-together`，
 * 契约在它的 `src/tool-spec.js`。两边各自持有自己的契约，谁也别去对方目录里改。
 *
 * ## 为什么这份文件值得单独存在
 *
 * 宿主是**按 schema 过滤参数**的：handler 读了、schema 没声明的参数会被静默丢掉，不报错。
 * 这个病今天一次性暴露成四个 PR（#24 #26 #33 + 审计自己扫出来的 loop/ocr/scanHeight/adaptive）。
 * 所以"handler 读了哪些 args"必须能被静态扫出来 —— 一个文件里塞五个 handler 就扫不出边界，
 * 一个文件里塞五份 schema 就会让人改错地方。
 *
 * 加参数时跑 `test/schema-audit.test.mjs`。
 */

/**
 * tool-spec.js — 工具定义（**不含 execute**）。
 *
 * 单独抽出来是为了让 test/contract.test.mjs 能把同一份 spec 丢给宿主真实的
 * `defineTool` 编译一遍。这一步必须做：schema 用了宿主不认的关键字时，
 * `ctx.tools.register()` 会在 apply() 阶段抛错，整棵插件树（连带应用）都起不来。
 *
 * 宿主支持的子集（见 @deepseek-ai/dsh-tools 的 ValueSchemaSpec）：
 *   string / number / integer / boolean / null / array(items) / object(properties, additionalProperties) / json / oneOf
 * **不支持** minimum、maximum、pattern、maxItems、minLength、format 等注解式约束。
 * 所以取值范围（比如 cells 1..16）写在 description 里，由 execute 兜底校验。
 */

export const TOOL_NAME = 'video_storyboard';
export const ZOOM_TOOL_NAME = 'video_zoom';
export const PROBE_TOOL_NAME = 'video_probe';
export const LOCATE_TOOL_NAME = 'video_locate';
export const HELP_TOOL_NAME = 'video_help';

/**
 * `video_help` —— 手册按需取（正文在 `./help.js`）。
 *
 * 工具契约是**每一轮都要重发**的常驻文案，所以"为什么 / 多少 token / 6 个策略各是什么"
 * 这类一问不到两次的东西不写在 description 里，交给这个工具现取。
 * 它自己必须极短：这个工具存在的唯一理由就是省常驻 token。
 */
export function helpToolSpec() {
  return {
    name: HELP_TOOL_NAME,
    description: 'Manual for the video_* tools: token cost, strategies, tiers/tierMap, cutFloor, text '
      + 'index. Free — no image tokens, no video needed. Read it when an option or its price is '
      + 'unclear ("6格 / 12格?").',
    parameters: {
      topic: {
        type: 'string',
        description: 'cost | strategy | tiers | cuts | text | links | order | subtitles — omit for all.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The manual (all topics or the one asked).' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 5_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/* ---- 多个工具共用的参数文案 ----------------------------------------------
 *
 * `video_storyboard` 与 `video_zoom` 接受的是同一批内容参数（scanGap / integral /
 * integralSeconds / tierMap），以前每处各抄一遍。文案抄两遍的下场已经踩过：
 * 改了一处忘了另一处，schema 与实现说的不是一回事（0.6.1 修的就是这个）。
 * 语义确实相同的东西，文案就只该有一份。
 */
const DESC_SCAN_GAP = 'Min seconds between cuts (0 = merge none).';
const DESC_INTEGRAL = 'Add frames inside long takes (default true).';
const DESC_INTEGRAL_SECONDS = 'Change per sampled frame, 1-30 (default 6); NOT "N s per frame".';
/**
 * 逐档覆盖（`tierMap`）的 schema。**故意不写 8 个子属性**：那样每个工具多 8 行
 * `"1":{"type":"integer"}`，两个工具就是 480 字符的常驻 JSON —— 而它约束的只是"值是不是
 * 整数"，键（`"1".."8"`）本来也只能靠 `validateToolArgs` 挡。现在由 execute 兜底，
 * 报错还更清楚（会指出哪个键错、合法范围是多少）。
 */
const TIER_MAP_SCHEMA = {
  type: 'object',
  description: 'Override tiers after the policy: {"1":3,"5":4} → tier 1..8 (keys and values both 1..8).',
  additionalProperties: true,
};
// probe / locate / 段图那三个工具都只做"读"，cookies 只用来取流，一句话就够。
const DESC_COOKIES_SHORT = 'cookies.txt for links (or DSH_VIDEO_COOKIES).';

export function storyboardToolSpec() {
  return {
    name: TOOL_NAME,
    description: [
      'Turn a video into storyboard images you can cite (cell 7 = 00:12.76-00:31.40), instead of',
      'guessing what is in it. One frame per shot — a 20 s take gets a full-width cell, a machine-gun',
      'montage gets 1/8 cells — and cells are numbered across images, so you can cite a moment or',
      're-read one with video_zoom({ cellId: 7 }).',
      '',
      '**Do not pass `strategy`** unless the user asked for a specific look: "full" means BIGGER cells',
      '= MORE images, never a safe default, while "auto" (the default) already picks the cheapest',
      'readable policy. Images bill by PIXELS on a 42px grid (~222 tokens at the default 800x450',
      'whatever the frame count) and the text index on top is often the bigger bill — `dryRun: true`',
      'prices a run before you spend an image token.',
      '',
      'Long film / episode: read it in windows (`from` + `segment`), not in one overview.',
      'Cost table, strategies, tiers/tierMap, cutFloor: video_help.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Path or http(s) link. Required.',
      },
      from: {
        type: 'number',
        description: 'Start seconds (default 0).',
      },
      to: {
        type: 'number',
        description: 'End seconds — or give `segment` with `from`.',
      },
      scanGap: {
        type: 'number',
        description: 'Min seconds between cuts (0 = merge none).',
      },
      integral: {
        type: 'boolean',
        description: 'Add frames inside long takes (default true).',
      },
      integralSeconds: {
        type: 'number',
        description: 'Change per sampled frame, 1-30 (default 6); NOT "N s per frame".',
      },
      maxFrames: {
        type: 'integer',
        description: 'Cap on frames (0 = no cap).',
      },
      tierMap: { ...TIER_MAP_SCHEMA },
      maxSheets: {
        type: 'integer',
        description: 'Cap on images (0 = no cap).',
      },
      strategy: {
        type: 'string',
        enum: ['auto', 'compact', 'standard', 'native', 'skim', 'full', 'brief'],
        description: 'Size policy. Omit → auto picks the cheapest readable one.',
      },
      cutFloor: {
        type: 'integer',
        description: 'Shot-change sensitivity, 0-255 (omit → 80: film/documentary; 60: fast-cut '
          + 'short-form). Lower = more shots, more images.',
      },
      budget: {
        type: 'integer',
        description: 'Pixels per image (default 360000 = 798x449 ≈222 tokens).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Plan only: cut count + per-policy image counts, no image.',
      },
      segment: {
        type: 'integer',
        description: 'Window seconds when only `from` given (default 300).',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame choice: sharp (default) / mid / thumb.',
      },
      burn: {
        type: 'string',
        enum: ['index', 'none'],
        description: 'Burn cell numbers: index (default) / none.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'auto (default) or off.',
      },
      transcriptFile: {
        type: 'string',
        description: 'Existing SRT/JSON transcript → skips track and ASR.',
      },
      ocr: {
        type: 'boolean',
        description: 'Force hard-subtitle OCR on/off (default: only at detail=high).',
      },
      hotwords: {
        type: 'string',
        description: 'Space-separated terms to bias transcription.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Link download height: low/medium/high = 360/720/1080p.',
      },
      scanHeight: {
        type: 'integer',
        description: 'Exact link download height (wins over quality).',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'Transcript chars per cell: low 60 / med 120 / high 400.',
      },
      cellRange: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Render only cells [first,last] of the text index.',
      },
      textOnly: {
        type: 'boolean',
        description: 'Text index only — no image, no frame decode.',
      },
      sourceHash: {
        type: 'boolean',
        description: 'Internal: scan cache key.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The addressable cell index for the model.' },
          images: {
            type: 'array',
            required: true,
            items: { type: 'json' },
            description: 'Committed image attachments, one per storyboard sheet.',
          },
        },
      },
      render(args, value) {
        return [
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/**
 * 第二个工具：一段的近距离重看。与 storyboard 共用管线，只是把窗口收窄、格数调少，
 * 于是每格能分到接近原生分辨率的像素。
 */
export function zoomToolSpec() {
  return {
    name: ZOOM_TOOL_NAME,
    description: [
      'Re-read a short window at higher per-cell resolution.',
      '',
      'Use it after video_storyboard when one cell needs a closer look ("what is on screen at',
      '01:12-01:20?"), or pass the `cellId` storyboard printed. Returns ONE image with few large cells',
      '(default 6), so faces, subtitles and on-screen text become legible where a 16-cell overview',
      'cannot. Costs one image (~233 tokens). For another wide pass use video_storyboard.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Path or http(s) link. Required.',
      },
      from: { type: 'number', description: 'Window start in seconds. Required unless cellId is given.' },
      to: { type: 'number', description: 'Window end in seconds. Required unless cellId is given.' },
      scanGap: {
        type: 'number',
        description: 'Min seconds between cuts (0 = merge none).',
      },
      integral: {
        type: 'boolean',
        description: 'Add frames inside long takes (default true).',
      },
      integralSeconds: {
        type: 'number',
        description: 'Change per sampled frame, 1-30 (default 6); NOT "N s per frame".',
      },
      maxFrames: {
        type: 'integer',
        description: 'Frames in this window (default 9, max 48).',
      },
      tierMap: { ...TIER_MAP_SCHEMA },
      maxSheets: {
        type: 'integer',
        description: 'Cap on images (default 1).',
      },
      strategy: {
        type: 'string',
        enum: ['full', 'standard', 'compact', 'native', 'skim', 'brief'],
        description: 'Size policy, default full.',
      },
      // zoom 的窗口通常只有几十秒、格数很少，切点门槛对结果影响极小；
      // 声明它纯粹是因为 boardOptions 共用了同一批参数（schema 审计要求两边一致）。
      cutFloor: {
        type: 'integer',
        description: 'Shot-change sensitivity, 0-255 (omit → 80). Rarely matters for zoom.',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame choice: sharp (default) / mid / thumb.',
      },
      burn: {
        type: 'string',
        enum: ['index', 'none'],
        description: 'Burn cell numbers: index (default) / none.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'auto (default) or off.',
      },
      transcriptFile: {
        type: 'string',
        description: 'Existing SRT/JSON transcript → skips track and ASR.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'Transcript chars per cell: low 60 / med 120 / high 400.',
      },
      cellId: {
        type: 'integer',
        description: 'Cell number from the last storyboard of this input.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Close-up height: low/medium/high = 480/720/1080p.',
      },
      zoomHeight: {
        type: 'integer',
        description: 'Read the original stream at this height (default 1080).',
      },
      scanHeight: {
        type: 'integer',
        description: 'Fallback scan copy height (default 360).',
      },
      ocr: {
        type: 'boolean',
        description: 'Force hard-subtitle OCR on/off.',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
      sourceHash: {
        type: 'boolean',
        description: 'Internal: scan cache key.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Cell index for this window.' },
          images: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render(args, value) {
        return [
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/**
 * 第三个工具：只读容器头，几毫秒。让模型在花掉第一张图（≈233 token）之前，
 * 先知道"多长、多大、有没有音轨/字幕、按什么粒度读"。
 */
export function probeToolSpec() {
  return {
    name: PROBE_TOOL_NAME,
    description: [
      'Read container metadata without decoding a frame: duration, resolution, frame rate, rotation,',
      'audio and subtitle tracks. No image tokens.',
      '',
      'Call this FIRST when you do not know how long the file is. Then read it as a SEQUENCE:',
      'video_storyboard({ input, from: 0, segment: 300 }) and follow the "next: from=..." it prints.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Path or http(s) link. Required.',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Metadata plus a suggested reading plan.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/**
 * 把整片里的**硬字幕**一条条裁下来、纵向拼成一张长图。
 *
 * 补的是原来四个工具都不覆盖的一块：它们全是"按**时间**取帧"，
 * 没有"跨时间裁同一区域再拼接"。真实场景是那种**没有字幕轨、ASR 也转不出来**的片子
 * （PV / 唱歌 / 多语言艺术字）：92 秒只转出 35 个字，剩下全靠眼睛看画面。
 * 裁成字幕带之后，一张图就能读完所有台词，比在 9 宫格里找那 144 像素高的字幕强得多。
 */
export function subtitlesToolSpec() {
  return {
    name: 'video_subtitles',
    description: [
      'Clip the burned-in subtitle band out of a video and stack all strips into ONE tall image in',
      'time order — read every on-screen line without a dozen zoom calls.',
      '',
      'Use it when the video has **hard-coded** subtitles but no subtitle track and no usable',
      'transcript (PV / lyrics / bilingual titles). If ASR works on the file, video_locate is',
      'cheaper — try that first.',
      '',
      'Each strip is one moment ~stepSec apart, top to bottom; a blank strip means "no subtitle',
      'here", which is also information. The returned text lists every strip\'s timestamp. Cost: one',
      'image.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Path or http(s) link. Required.',
      },
      from: {
        type: 'number',
        description: 'Start seconds (default 0).',
      },
      to: {
        type: 'number',
        description: 'End seconds — or give `segment` with `from`.',
      },
      maxStrips: {
        type: 'integer',
        description: 'How many strips (default 12).',
      },
      stepSec: {
        type: 'number',
        description: 'Seconds between strips (default 3).',
      },
      band: {
        type: 'array',
        items: { type: 'number' },
        description: 'Subtitle band [y0,y1] as frame fractions (default 0.82-0.98).',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            required: true,
            description: 'Strip count, spacing, band source, and the timestamp of every strip.',
          },
          images: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render(args, value) {
        return [
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/** execute 内部兜底校验（schema 子集不支持 minimum/maximum，只能在这里挡） */
export function validateToolArgs(args) {
  const problems = [];
  if (!args?.input || typeof args.input !== 'string') problems.push('input is required');
  if (args.maxFrames !== undefined
    && (!Number.isInteger(args.maxFrames) || args.maxFrames < 0 || args.maxFrames > 10_000)) {
    problems.push('maxFrames must be an integer 0..10000 (0 = no cap)');
  }
  if (args.strategy !== undefined
    && !['auto', 'full', 'standard', 'compact', 'native', 'skim', 'brief',
      'quality', 'balanced', 'saver', 'frugal', 'thrifty', 'ultra'].includes(args.strategy)) {
    problems.push("strategy must be 'auto' | 'compact' | 'standard' | 'native' | 'skim' | 'full' | 'brief'"
      + ' (old names quality/balanced/saver/frugal/thrifty/ultra are still accepted)');
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
    problems.push('dryRun must be a boolean');
  }
  if (args.scanGap !== undefined
    && (typeof args.scanGap !== 'number' || !(args.scanGap >= 0) || args.scanGap > 30)) {
    problems.push('scanGap must be a number 0..30 seconds (0 = do not merge cuts)');
  }
  if (args.integral !== undefined && typeof args.integral !== 'boolean') {
    problems.push('integral must be a boolean');
  }
  if (args.integralSeconds !== undefined
    && (typeof args.integralSeconds !== 'number'
      || !(args.integralSeconds >= 1) || args.integralSeconds > 30)) {
    problems.push('integralSeconds must be a number 1..30');
  }
  if (args.budget !== undefined
    && (!Number.isInteger(args.budget) || args.budget < 64_000 || args.budget > 1_690_000)) {
    problems.push('budget must be an integer 64000..1690000 (pixels per image; 1.69M = 1300x1300 cap)');
  }
  if (args.maxSheets !== undefined
    && (!Number.isInteger(args.maxSheets) || args.maxSheets < 0 || args.maxSheets > 64)) {
    problems.push('maxSheets must be an integer 0..64 (0 = no cap)');
  }
  if (args.tierMap !== undefined) {
    const m = args.tierMap;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      problems.push('tierMap must be an object like {"1":3,"5":4}');
    } else {
      for (const [k, v] of Object.entries(m)) {
        const key = Number(k);
        if (!Number.isInteger(key) || key < 1 || key > 8) {
          problems.push(`tierMap keys must be tiers 1..8 (got "${k}")`);
        } else if (!Number.isInteger(v) || v < 1 || v > 8) {
          problems.push(`tierMap["${k}"] must be a tier 1..8`);
        }
      }
    }
  }
  if (args.segment !== undefined
    && (!Number.isInteger(args.segment) || args.segment < 30 || args.segment > 3600)) {
    problems.push('segment must be an integer 30..3600 (seconds)');
  }
  if (args.from !== undefined && args.from < 0) problems.push('from must be >= 0');
  if (args.maxStrips !== undefined && (!Number.isInteger(args.maxStrips) || args.maxStrips < 1 || args.maxStrips > 40)) {
    problems.push('maxStrips must be an integer 1..40');
  }
  if (args.times !== undefined
    && (!Array.isArray(args.times) || !args.times.every((v) => Number.isFinite(v) && v >= 0))) {
    problems.push('times must be an array of non-negative seconds');
  }
  if (args.band !== undefined
    && (!Array.isArray(args.band) || args.band.length !== 2
      || !args.band.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))) {
    problems.push('band must be [y0, y1] as fractions 0..1');
  }
  if (args.to !== undefined && args.from !== undefined && args.to <= args.from) {
    problems.push('to must be greater than from');
  }
  if (args.minGap !== undefined && !(args.minGap >= 0)) problems.push('minGap must be >= 0');
  if (args.transcript !== undefined && !['auto', 'off'].includes(args.transcript)) {
    problems.push("transcript must be 'auto' or 'off'");
  }
  if (args.cellRange !== undefined) {
    const r = args.cellRange;
    if (!Array.isArray(r) || r.length !== 2 || r.some((v) => !Number.isInteger(v))) {
      problems.push('cellRange must be two integers: [first, last]');
    } else if (r[0] < 1 || r[1] < r[0]) {
      problems.push('cellRange must satisfy 1 <= first <= last');
    }
  }
  if (args.textOnly !== undefined && typeof args.textOnly !== 'boolean') {
    problems.push('textOnly must be a boolean');
  }
  if (args.sourceHash !== undefined && typeof args.sourceHash !== 'boolean') {
    problems.push('sourceHash must be a boolean');
  }
  if (args.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push("detail must be 'low', 'med' or 'high'");
  }
  if (args.transcriptFile !== undefined
    && (typeof args.transcriptFile !== 'string' || args.transcriptFile.trim() === '')) {
    problems.push('transcriptFile must be a non-empty path');
  }
  if (args.scanHeight !== undefined
    && (!Number.isInteger(args.scanHeight) || args.scanHeight < 120 || args.scanHeight > 2160)) {
    problems.push('scanHeight must be an integer 120..2160');
  }
  if (args.quality !== undefined && !['low', 'medium', 'high'].includes(args.quality)) {
    problems.push('quality must be one of low / medium / high');
  }
  if (args.cookies !== undefined && (typeof args.cookies !== 'string' || args.cookies.trim() === '')) {
    problems.push('cookies must be a non-empty path');
  }
  if (args.allowAnonymous !== undefined && typeof args.allowAnonymous !== 'boolean') {
    problems.push('allowAnonymous must be a boolean');
  }
  if (args.ocr !== undefined && typeof args.ocr !== 'boolean') {
    problems.push('ocr must be a boolean');
  }
  return problems;
}

/** video_zoom 的兜底校验 */
export function validateZoomArgs(args) {
  const problems = [];
  if (!args?.input || typeof args.input !== 'string') problems.push('input is required');
  const hasCell = args?.cellId !== undefined && args?.cellId !== null;
  if (!hasCell) {
    if (!(args?.from >= 0)) problems.push('from is required and must be >= 0 (or pass cellId)');
    if (!(args?.to > 0)) problems.push('to is required and must be > 0 (or pass cellId)');
  } else if (!Number.isInteger(args.cellId) || args.cellId < 1) {
    problems.push('cellId must be a positive integer');
  }
  if (args?.from !== undefined && args?.to !== undefined && args.to <= args.from) {
    problems.push('to must be greater than from');
  }
  if (args.maxFrames !== undefined
    && (!Number.isInteger(args.maxFrames) || args.maxFrames < 0 || args.maxFrames > 200)) {
    problems.push('maxFrames must be an integer 0..200 (0 = no cap)');
  }
  if (args.strategy !== undefined
    && !['full', 'standard', 'compact', 'native', 'skim', 'brief',
      'quality', 'balanced', 'saver', 'frugal', 'thrifty', 'ultra'].includes(args.strategy)) {
    problems.push("strategy must be 'full' | 'standard' | 'compact' | 'native' | 'skim' | 'brief'");
  }
  if (args.zoomHeight !== undefined
    && (!Number.isInteger(args.zoomHeight) || args.zoomHeight < 120 || args.zoomHeight > 2160)) {
    problems.push('zoomHeight must be an integer 120..2160');
  }
  if (args.cookies !== undefined && (typeof args.cookies !== 'string' || args.cookies.trim() === '')) {
    problems.push('cookies must be a non-empty path');
  }
  if (args.allowAnonymous !== undefined && typeof args.allowAnonymous !== 'boolean') {
    problems.push('allowAnonymous must be a boolean');
  }
  if (args.transcript !== undefined && !['auto', 'off'].includes(args.transcript)) {
    problems.push("transcript must be 'auto' or 'off'");
  }
  if (args.transcriptFile !== undefined
    && (typeof args.transcriptFile !== 'string' || args.transcriptFile.trim() === '')) {
    problems.push('transcriptFile must be a non-empty path');
  }
  if (args.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push("detail must be 'low', 'med' or 'high'");
  }
  if (args.ocr !== undefined && typeof args.ocr !== 'boolean') {
    problems.push('ocr must be a boolean');
  }
  if (args.scanHeight !== undefined
    && (!Number.isInteger(args.scanHeight) || args.scanHeight < 120 || args.scanHeight > 2160)) {
    problems.push('scanHeight must be an integer 120..2160');
  }
  if (args.sourceHash !== undefined && typeof args.sourceHash !== 'boolean') {
    problems.push('sourceHash must be a boolean');
  }
  return problems;
}

/**
 * video_locate — 纯文本的"那句话在第几分钟"。
 *
 * 刻意不读帧、不出图：定位靠的是转写文本，本来就在手里。
 * 模型拿到时间窗之后自己去 video_zoom，省掉一次整段的重新取帧。
 */
export function locateToolSpec() {
  return {
    name: LOCATE_TOOL_NAME,
    description: [
      'Find where a phrase is spoken: timestamped transcript lines that match, best first. Text',
      'only — no frame decode, no image tokens.',
      '',
      'Use it when you know roughly what was said but not when. Then pass the returned from/to to',
      'video_zoom to see that moment.',
      '',
      'Needs a transcript. If video_storyboard already ran on this file, its transcript is reused;',
      'otherwise ASR runs for the window (slow if long).',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Path or http(s) link. Required.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'Phrase to find (fuzzy).',
      },
      from: { type: 'number', description: 'Only search after this second. Default: start of file.' },
      to: { type: 'number', description: 'Only search before this second. Default: end of file.' },
      max: { type: 'number', description: 'How many matches to return, 1-20. Default 5.' },
      transcriptFile: {
        type: 'string',
        description: 'Existing SRT/JSON transcript → skips ASR.',
      },
      cookies: { type: 'string', description: 'cookies.txt path for login-gated sources.' },
      allowAnonymous: { type: 'boolean', description: 'Allow anonymous fetches for links.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Timestamped matching lines, best first.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe() {
      return true;
    },
  };
}
