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

export function storyboardToolSpec() {
  return {
    name: TOOL_NAME,
    description: [
      'Turn a video into storyboard images you can actually cite, instead of guessing what is in it.',
      '',
      'Every frame is ONE SHOT. Its cell is sized by how fast that stretch cuts: a 20-second take',
      'gets a full-width cell, a machine-gun montage gets 1/8-side cells. Cuts are detected first,',
      'an integral sampler adds frames inside long moving shots, then a row-packing solver fills each',
      'image (optimum for the given size sequence) and opens the next one when it is full.',
      '',
      'Each cell is numbered, the numbering continues across images, each image carries a header with',
      'its own time range and index, and the text index lists "cell 7 (image 2) = 00:12.76-00:31.40 k=3"',
      'so you can cite a moment or ask for a close-up with video_zoom({ cellId: 7 }).',
      '',
      'Use it like this:',
      '- Whole short clip: video_storyboard({ input })',
      '- Long film, read in order (SEQUENCE): video_storyboard({ input, from: 0, segment: 300 }) —',
      '  every result prints "segment 5/22 · 22% watched · 82 min left · next: from=..."',
      '- One wide look at a long film (STRUCTURE, spoilers): video_storyboard({ input, maxFrames: 96 })',
      '',
      'KNOBS THAT MATTER (there are only three):',
      '- maxFrames: how many moments you see at most (default 96).',
      '- strategy: quality | balanced (default) | saver | frugal — each step down shrinks every cell',
      '  by one tier, fitting more frames per image (fewer tokens, blurrier cells).',
      '- budget: pixels per image, capped at 640000 (800x800 / 384 vision tokens).',
      '',
      'The manifest prints the smallest cell and its readability, the tier histogram, the fill ratio',
      'and the token cost, and it warns you when the smallest cells are below readable size.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path (mp4/mov/mkv/webm...), or any http(s) link that yt-dlp can ' +
          'resolve — you are responsible for having the right to download it. Links are fetched once ' +
          'at low resolution for scanning; video_zoom re-reads the original stream at high resolution.',
      },
      from: {
        type: 'number',
        description: 'Window start in seconds (default 0). Only this window is scanned and sampled.',
      },
      to: {
        type: 'number',
        description: 'Window end in seconds. Omit it to let `segment` size the window: 300 s when from > 0, '
          + 'or the whole file when from = 0. Pass `to` only when you deliberately want a specific range.',
      },
      scanGap: {
        type: 'number',
        description: 'Minimum seconds between two detected cuts, 0-30. Default 0 = merge nothing.'
          + ' Raise it to collapse machine-gun edits into one boundary (`skim` sets 0.35, `brief` raises'
          + ' it until the whole window fits one image).',
      },
      integral: {
        type: 'boolean',
        description: 'Sample extra frames inside long takes by integrating on-screen change (default'
          + ' true). Turn it off to keep ONLY real cuts — `skim` / `brief` do that for you.',
      },
      integralSeconds: {
        type: 'number',
        description: 'How many seconds of accumulated change one sampled frame stands for, 1-30'
          + ' (default 6). Smaller = more sampled frames inside long takes; bigger = fewer, and long'
          + ' takes get one big cell each.',
      },
      maxFrames: {
        type: 'integer',
        description: 'Cap on how many frames you see, 1-10000. **Default 0 = no cap**: every cut becomes'
          + ' a frame and every long moving shot gets extra frames from the integral sampler. Set a number'
          + ' only to bound cost — above it the shortest segments get merged (you lose fast-cut coverage,'
          + ' never long takes).',
      },
      tierMap: {
        type: 'object',
        description: 'Override the computed tiers, one entry per source tier: {"1":3,"5":4}.'
          + ' Keys and values are tiers 1-8 (1 = full width, 8 = 1/8 side). This runs AFTER'
          + ' `strategy`, and **tiers you do not list keep their computed value**. Mapping several'
          + ' tiers to the same value merges their visual size (e.g. {"5":4,"6":4,"7":4,"8":4} turns'
          + ' every fast-cut cell into a 1/4 cell). Mapping everything to 1 makes every frame'
          + ' full-width, which multiplies the image count — the manifest always prints the result.',
        properties: {
          '1': { type: 'integer' },
          '2': { type: 'integer' },
          '3': { type: 'integer' },
          '4': { type: 'integer' },
          '5': { type: 'integer' },
          '6': { type: 'integer' },
          '7': { type: 'integer' },
          '8': { type: 'integer' },
        },
        additionalProperties: false,
      },
      maxSheets: {
        type: 'integer',
        description: 'Cap on how many images this call may return, 1-16 (default 8). It is a budget cap,'
          + ' not a layout request: when the packer would exceed it, the shortest segments get merged and'
          + ' the layout is re-solved, so you still get full time coverage — just fewer, longer frames.',
      },
      strategy: {
        type: 'string',
        enum: ['full', 'standard', 'compact', 'skim', 'brief'],
        description: 'Size policy, applied to the tier every frame got from cut density. Each step costs'
          + ' or saves about one tier of cell size (a tier doubles or halves the pixel side):'
          + ' quality = one tier bigger (1/1 stays 1/1) for reading text and faces;'
          + ' balanced = default, and it only shrinks the 1/1 tier to 1/2 so a single frame never eats a'
          + ' whole image; saver = one tier smaller everywhere; frugal = three tiers smaller (cheapest,'
          + ' cell sides down to ~100 px — you will recognise shots, not content).',
      },
      budget: {
        type: 'integer',
        description: 'Pixels per image, default 640000 = 800x800. **640000 is the ceiling**: the vision'
          + ' API caps a picture at 800x800 (384 tokens), so anything above that is silently downscaled'
          + ' and the cell sizes printed in the manifest stop being true. Lower it (e.g. 230000) only when'
          + ' you are deliberately trading legibility for bytes.',
      },
      segment: {
        type: 'integer',
        description: 'Window length in seconds when you pass `from` without `to` (default 300 when from > 0; '
          + 'with from=0 and no segment you get the whole file). This is the SEQUENCE reader: call once with '
          + 'from:0, segment:300, then pass back the `next: from=...` printed at the end of every result — '
          + 'it also prints "segment 5/22 · 22% watched · 82 min left". Use 300 for films/episodes, '
          + '120-180 for dense action.',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame selection inside a segment. Default "sharp" (Laplacian variance) avoids blurred transition frames.',
      },
      burn: {
        type: 'string',
        enum: ['index', 'none'],
        description: 'What to burn into each cell. Default "index" (the cell number, so the model can cite ' +
          '"cell 5"). Timecodes are never burned in - they live in the text at 0.01 s precision, and pixels ' +
          'spent on a timecode are pixels lost from the frame.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Default "auto": use the embedded subtitle track if present, otherwise ASR when configured. "off" skips speech entirely.',
      },
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing transcript (SRT, or JSON with [{start,end,text}] / ' +
          '[{from,to,text}] / C站 {body:[{from,to,content}]}). When given, the subtitle track ' +
          'and ASR are both skipped — use this when the site already has captions.',
      },
      ocr: {
        type: 'boolean',
        description: 'Correct ASR text against burned-in on-screen subtitles (local OCR, no extra tokens). ' +
          'Defaults to true when detail=high. Only helps when the video actually has hard-coded subtitles; ' +
          'silently skipped otherwise.',
      },
      hotwords: {
        type: 'string',
        description: 'Space-separated terms to bias this run\'s transcription (e.g. "位错 滑移 柏氏矢量"). ' +
          'Overrides asr.json for this call only. Use it when the subject has its own vocabulary — a global ' +
          'list from another subject is a negative bias, not a neutral default.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Override the download resolution (http(s) links only; a local file is always read at ' +
          'its own resolution). Normally leave it out: the scan tier is derived from the pixel budget ' +
          '(640k -> 360p, 1.2M -> 720p, 1.65M -> 1080p). low = 360p, medium = 720p, high = 1080p. Turn it ' +
          'up only when video_zoom needs a sharper fallback copy.',
      },
      scanHeight: {
        type: 'integer',
        description: 'Advanced override: exact download height for http(s) links (120-2160). Prefer ' +
          '`quality` — this one exists for cases where you know the exact pixel budget you want. ' +
          'Takes precedence over `quality` when both are given.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt for http(s) links. Falls back to DSH_VIDEO_COOKIES. ' +
          'Required by default: without a signed-in session the available resolution is unpredictable ' +
          'and a 1080p tier can simply be absent from the format list.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous fetching is always allowed. Set this to true to suppress the ' +
          '"resolution not guaranteed" note when you already know this source is fine without cookies.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'How many characters of transcript per cell: low=60 (is this stretch about X?), ' +
          'med=120 (default), high=400 (quote-level). Truncation lands on a sentence boundary. ' +
          'Use cellRange + textOnly to read one cell in full.',
      },
      cellRange: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Only render cells [first, last] (1-based, inclusive) in the text index. ' +
          'For a 2-hour film the full 64-cell index is ~75 KB, which can exceed one tool result — ' +
          'the index says where it stopped and which cellRange to ask for next.',
      },
      textOnly: {
        type: 'boolean',
        description: 'Return only the text index (respecting cellRange) — no image is produced and no ' +
          'frame is decoded. Use it to page through a long film after the first visual pass; the scan is cached.',
      },
      sourceHash: {
        type: 'boolean',
        description: 'Also compute the source file SHA-256 and put it in the manifest. Off by default: ' +
          'it reads the whole file, so on a multi-GB video it adds real I/O.',
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
      'Re-read a short window of a video at higher per-cell resolution.',
      '',
      'Use it after video_storyboard when one cell needs a closer look: "what exactly is on screen',
      'at 01:12-01:20?" A zoom returns ONE image with few, large cells (default 6), so faces,',
      'subtitles and on-screen text become legible — things a 16-cell overview cannot show.',
      '',
      'Keep the window short (a few seconds to a minute). For another wide pass use video_storyboard.',
      'Costs one image (~384 tokens in DSH, host-dependent), like any other tool result with one image.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path, or the same http(s) link you passed to video_storyboard. ' +
          'A link is re-read from the original stream at high resolution, so cells here can be ' +
          'sharper than the storyboard even when the scan itself used a low tier.',
      },
      from: { type: 'number', description: 'Window start in seconds. Required unless cellId is given.' },
      to: { type: 'number', description: 'Window end in seconds. Required unless cellId is given.' },
      scanGap: {
        type: 'number',
        description: 'Minimum seconds between two detected cuts, 0-30. Default 0 = merge nothing.'
          + ' Raise it to collapse machine-gun edits into one boundary (`skim` sets 0.35, `brief` raises'
          + ' it until the whole window fits one image).',
      },
      integral: {
        type: 'boolean',
        description: 'Sample extra frames inside long takes by integrating on-screen change (default'
          + ' true). Turn it off to keep ONLY real cuts — `skim` / `brief` do that for you.',
      },
      integralSeconds: {
        type: 'number',
        description: 'How many seconds of accumulated change one sampled frame stands for, 1-30'
          + ' (default 6). Smaller = more sampled frames inside long takes; bigger = fewer, and long'
          + ' takes get one big cell each.',
      },
      maxFrames: {
        type: 'integer',
        description: 'How many frames for this window, 1-48 (default 9). Frames get a UNIFORM tier'
          + ' ceil(sqrt(n)) so n cells tile a sqrt(n)×sqrt(n) grid in ONE image — 9 frames = 3×3 full.'
          + ' This is the "re-read a few seconds properly" tool.',
      },
      tierMap: {
        type: 'object',
        description: 'Override the computed tiers, one entry per source tier: {"1":3,"5":4}.'
          + ' Keys and values are tiers 1-8 (1 = full width, 8 = 1/8 side). This runs AFTER'
          + ' `strategy`, and **tiers you do not list keep their computed value**. Mapping several'
          + ' tiers to the same value merges their visual size (e.g. {"5":4,"6":4,"7":4,"8":4} turns'
          + ' every fast-cut cell into a 1/4 cell). Mapping everything to 1 makes every frame'
          + ' full-width, which multiplies the image count — the manifest always prints the result.',
        properties: {
          '1': { type: 'integer' },
          '2': { type: 'integer' },
          '3': { type: 'integer' },
          '4': { type: 'integer' },
          '5': { type: 'integer' },
          '6': { type: 'integer' },
          '7': { type: 'integer' },
          '8': { type: 'integer' },
        },
        additionalProperties: false,
      },
      maxSheets: {
        type: 'integer',
        description: 'How many images at most, 1-4 (default 1). A zoom is meant to be one image with a'
          + ' few large cells; raise it only when the window needs more cells than one image holds.',
      },
      strategy: {
        type: 'string',
        enum: ['full', 'standard', 'compact', 'skim', 'brief'],
        description: 'Size policy, default "quality" (one tier bigger everywhere). Only lower it if you'
          + ' are re-reading a very busy window and want more frames per image instead of detail.',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame selection inside each cell. Default "sharp".',
      },
      burn: {
        type: 'string',
        enum: ['index', 'none'],
        description: 'What to burn into each cell. Default "index".',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Include subtitle/ASR text for this window. Default "auto".',
      },
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing transcript (SRT, or JSON with [{start,end,text}] / '
          + '[{from,to,text}] / C站 {body:[{from,to,content}]}). Skips the subtitle track and ASR.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'Characters of transcript per cell: low=60, med=120 (default), high=400.',
      },
      cellId: {
        type: 'integer',
        description: 'Zoom by cell number from the last storyboard of this same input (e.g. 3 = the cell ' +
          'labelled 3 in the sheet). Resolves to that cell\'s absolute time range, so you never copy ' +
          'timestamps by hand. Falls back to an error if no cell map is recorded — then pass from/to.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Sharpness of the close-up frames, for http(s) links. low = 480p, medium = 720p, ' +
          'high = 1080p (default). Raise it when the fine detail is not readable; lower it when the ' +
          'download is too slow. Ignored for local files, which are always read at native resolution.',
      },
      zoomHeight: {
        type: 'integer',
        description: 'For http(s) links: which resolution to read the original stream at (default 1080). ' +
          'One frame only — cheaper than downloading. Never exceeds what the source itself offers.',
      },
      scanHeight: {
        type: 'integer',
        description: 'For http(s) links: which resolution the downloaded scan copy uses (default 360). ' +
          'Only matters when zoom has to fall back to the local copy because the direct URL expired — ' +
          'raising it makes that fallback sharper at the cost of a bigger download.',
      },
      ocr: {
        type: 'boolean',
        description: 'Force hard-subtitle OCR correction on/off. Default: on only when detail is "high" ' +
          '(it costs ~3 s of local OCR). Set false to keep the raw ASR text even at high detail.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt. Falls back to DSH_VIDEO_COOKIES.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous reading is always allowed. Set this to true to suppress the warning note.',
      },
      sourceHash: {
        type: 'boolean',
        description: 'Also compute the source file SHA-256 and put it in the manifest. Off by default.',
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
 * 第三个工具：只读容器头，几毫秒。让模型在花掉第一张图的 384 token 之前，
 * 先知道"多长、多大、有没有音轨/字幕、按什么粒度读"。
 */
export function probeToolSpec() {
  return {
    name: PROBE_TOOL_NAME,
    description: [
      'Read a video\'s container metadata without decoding a single frame: duration, resolution,',
      'frame rate, rotation, audio track, subtitle tracks, and a suggested reading plan.',
      '',
      'Call this FIRST when you do not already know how long the file is. It costs no image tokens.',
      'Then read it: for a film / episode / any story use SEQUENCE —',
      'video_storyboard({ input, from: 0, segment: 300 }) and follow the "next: from=..." it prints.',
      'A one-shot overview of the whole file is only for identifying what it is (it spoils the ending',
      'and makes every cell smaller). video_zoom is for a close-up of one moment.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path, or an http(s) link. For a link this resolves metadata ' +
          'only (no download): title, duration, and the resolutions the source actually offers.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt. Falls back to DSH_VIDEO_COOKIES.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous probing is always allowed. Set this to true to suppress the warning note.',
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
      'Clip the burned-in subtitle band out of a video and stack all the strips into ONE tall image,',
      'in time order — so you can read every on-screen line without asking for a dozen zoom calls.',
      '',
      'Use this when the video has **hard-coded** subtitles on screen but no subtitle track and no',
      'usable transcript (PV / music videos / lyrics / bilingual art titles). If ASR works on the file,',
      'video_locate is cheaper and gives text directly — try that first.',
      '',
      'Each strip is one moment ~stepSec apart, top to bottom. Blank strips mean "no subtitle at that',
      'moment", which is also information. The returned text lists the timestamp of every strip.',
      '',
      'Cost: one image. Strips are cut **sequentially** (one ffmpeg at a time) — deliberately, because',
      'parallel cropping on a memory-tight machine dies with 0xC000012D.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path, or any http(s) link yt-dlp can resolve (you are responsible ' +
          'for having the right to download it).',
      },
      from: {
        type: 'number',
        description: 'Window start in seconds (default 0).',
      },
      to: {
        type: 'number',
        description: 'Window end in seconds. Omit for the whole file.',
      },
      maxStrips: {
        type: 'integer',
        description: 'Upper bound on strips, 1-40 (default 24). More strips = taller image = more ' +
          'subtitles caught, but a long window gets coarser sampling.',
      },
      stepSec: {
        type: 'number',
        description: 'Target spacing in seconds (default 3). Actual spacing widens when the window is ' +
          'long enough that `maxStrips` would be exceeded.',
      },
      band: {
        type: 'array',
        items: { type: 'number' },
        description: 'Subtitle band as [y0, y1], fractions of frame height. Default 0.82-0.98 ' +
          '(bottom 16%). **Tune it from what you actually SEE in the returned image**: if text is ' +
          'clipped at the top of a strip, lower y0; if most of a strip is empty background, raise y0. ' +
          'Reference values: single-line bottom 0.86-0.98, bilingual bottom 0.82-0.98, top caption bar ' +
          '0.02-0.14, centered lyric 0.40-0.60.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt. Falls back to DSH_VIDEO_COOKIES.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous access is always allowed; set true to suppress the warning note.',
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
    && !['full', 'standard', 'compact', 'skim', 'brief',
      'quality', 'balanced', 'saver', 'frugal', 'thrifty', 'ultra'].includes(args.strategy)) {
    problems.push("strategy must be 'full' | 'standard' | 'compact' | 'skim' | 'brief'"
      + ' (old names quality/balanced/saver/frugal/thrifty/ultra are still accepted)');
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
    && (!Number.isInteger(args.budget) || args.budget < 64_000 || args.budget > 640_000)) {
    problems.push('budget must be an integer 64000..640000 (pixels per image; 640k = 800x800 cap)');
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
    && !['quality', 'balanced', 'saver', 'frugal', 'thrifty', 'ultra'].includes(args.strategy)) {
    problems.push("strategy must be 'quality', 'balanced', 'saver', 'frugal', 'thrifty' or 'ultra'");
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
      'Find where a phrase is spoken in a video: returns timestamped transcript lines that match,',
      'best first. Text only - no frame decode, no image, no tokens spent on pixels.',
      '',
      'Use this when you know roughly what was said but not when ("where does it mention X").',
      'Then pass the returned from/to window to video_zoom to see that moment.',
      '',
      'Needs a transcript. If video_storyboard already ran on this file in this session, its',
      'transcript is reused; otherwise ASR runs for the requested window (slow if the window is long).',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path or http(s) link. Must be the same string used for ' +
          'video_storyboard if you want its transcript reused.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'The phrase to look for. Chinese and English both work; punctuation and spacing ' +
          'are ignored. Long quotes match better than single characters.',
      },
      from: { type: 'number', description: 'Only search after this second. Default: start of file.' },
      to: { type: 'number', description: 'Only search before this second. Default: end of file.' },
      max: { type: 'number', description: 'How many matches to return, 1-20. Default 5.' },
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing SRT/JSON transcript. Skips ASR entirely.',
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
