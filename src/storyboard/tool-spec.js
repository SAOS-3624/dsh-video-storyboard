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
      'Turn a local video into ONE addressable storyboard image (a numbered grid of frames)',
      'plus a text index of every cell, so you can look at the video yourself instead of guessing.',
      '',
      'Each cell is one content segment (shot-aware), sampled at its sharpest frame, with the cell',
      'number burned into the top-left corner. The text lists "cell k (r2c3) = 00:12.76-00:31.40"',
      'so you can cite a moment or ask for a close-up later with video_zoom.',
      '',
      'Use it like this:',
      '- Whole short clip: video_storyboard({ input })',
      '- Long film, read in order (SEQUENCE): video_storyboard({ input, from: 0, segment: 300 }) —',
      '  every result prints "segment 5/22 · 22% watched · 82 min left · next: from=..."',
      '- One wide look at a long film (STRUCTURE, spoilers): cells: 9, sheets: 6',
      '',
      'HOW TO PICK PARAMETERS — the one thing to get right:',
      '- A sheet has a fixed pixel budget, so cells and legibility trade off. cells x sheets = how many',
      '  moments you see; budget / cells = how big each moment is. 16 cells is ~341×189 at best.',
      '- Never buy coverage with smaller cells. If you need more moments, add a sheet; if you need to',
      '  read text, say need:"text" (it caps cells per sheet at what is actually readable).',
      '- cells:1 is exactly one frame. The manifest prints the real cell size, the readability level and',
      '  the token cost, and it warns you when the cells are too small to read what you asked for.',
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
      cells: {
        type: 'integer',
        description: 'Cells per image, 1-16 (default: auto). **cells x sheets = how many moments you see; '
          + 'budget / cells = how much you can see in each one.** 9 cells at budget 1.2M is ~456x254 '
          + '(faces, action); 16 is ~341x189 (composition only); 16 at budget 640k is 247x137 '
          + '(286x118 on a 2.39:1 film) — colour blocks, not content. cells:1 is exactly ONE frame: '
          + 'it is never packed into a 2x2 mosaic.',
      },
      sheets: {
        type: 'integer',
        description: 'How many images to return, 1-16 (default: auto). Each image costs ~700 vision tokens '
          + 'at the default budget (~390 at 640k, ~990 at 1.65M — not a flat 384). When you need more '
          + 'coverage, **add a sheet rather than cramming more cells**: 2 images x 9 legible cells beat '
          + '1 image x 16 tiny ones for the same token order.',
      },
      need: {
        type: 'string',
        enum: ['shot', 'scene', 'text'],
        description: 'What you must actually SEE (default "scene"). This, not a size name, decides how many '
          + 'cells fit per image: shot = tell shots apart (160x90 per cell), scene = recognise faces and '
          + 'action (320x180), text = read subtitles / signs / UI (480x270). It caps the auto cell count; '
          + 'when you pass cells explicitly it is still used to warn you that the cells are below what you asked for.',
      },
      budget: {
        type: 'integer',
        description: 'Pixels per image (default 1200000 ~= 700 vision tokens on DSH; 640000 ~= 390; '
          + '1650000 ~= 990, near the host 1024-token cap). Raising it makes every cell bigger without '
          + 'adding a second image — the right way to fix "too blurry". Above ~1.65M the host downscales, '
          + 'and the cell= in the manifest stops matching what you really see.',
      },
      maxPerSheet: {
        type: 'integer',
        description: 'Advanced: hard cap on auto cells per image, 1-16. Default is derived from budget + need '
          + '(9 at 640k/scene, 16 at 1.2M/scene). Only affects auto planning and how sheets are split; '
          + 'it is ignored when you pass cells explicitly.',
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
      minGap: {
        type: 'number',
        description: 'Minimum spacing between sampled frames in seconds (default 1.2). Short shots get merged, not sampled twice.',
      },
      adaptive: {
        type: 'boolean',
        description: 'Default true: distribute cells by local cut density, so a fast-cutting stretch gets ' +
          'more cells than a static one. Set false for evenly spaced cells across the window — more ' +
          'predictable when you want to compare two windows cell-by-cell.',
      },
      tileFirst: {
        type: 'boolean',
        description: 'Default false. Trade cells for resolution: fewer, bigger cells so each one can be ' +
          'tiled 2×2/3×3 instead of staying a single frame. A 4×4 layout at the 640k budget gives 247×137 ' +
          'per cell, and 2×2 of that is 123×68 — too small to read. With 9 cells (3×3 layout) each cell ' +
          'is 331×184 and tiles to 165×92 or 110×61. Use this when the video is fast-cut and you care more ' +
          'about "how many different shots did I see" than "can I read the on-screen text". Tiling is ' +
          'skipped entirely when cells:1, so a single-cell request really returns one frame.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Default "auto": use the embedded subtitle track if present, otherwise ASR when configured. "off" skips speech entirely.',
      },
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing transcript (SRT, or JSON with [{start,end,text}] / ' +
          '[{from,to,text}] / Bilibili {body:[{from,to,content}]}). When given, the subtitle track ' +
          'and ASR are both skipped — use this when the site already has captions.',
      },
      planThresholds: {
        type: 'object',
        description: 'Override the content-classification thresholds for this call. Defaults -18 / 1 / 3 ' +
          'are tuned on one master; loudness varies by up to 9 LU across material, so pass your own when ' +
          'the auto plan misfires. The values actually used are always printed in the manifest.',
        properties: {
          musicLufs: { type: 'number', description: 'Louder than this + low speech rate = music-driven' },
          musicSpeechRate: { type: 'number', description: 'Below this chars/s counts as music-like' },
          speechRateCut: { type: 'number', description: 'Above this chars/s, give the transcript more weight' },
        },
        additionalProperties: false,
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
      size: {
        type: 'string',
        enum: ['small', 'medium', 'large'],
        description: 'Deprecated shorthand for `budget` only: small = 640k px (331×184 at 9 cells), '
          + 'medium = 1.2M (~456×254 with the audio strip, default), large = 1.65M (~530×295). It no longer changes the cell '
          + 'count or the download resolution — those are `need`/`maxPerSheet` and the pixel budget now. '
          + 'Prefer `budget` + `need`.',
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
      cells: {
        type: 'integer',
        description: 'Cells for this window, 1-9 (default 6). Fewer cells = bigger each.',
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
          + '[{from,to,text}] / Bilibili {body:[{from,to,content}]}). Skips the subtitle track and ASR.',
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
      minGap: {
        type: 'number',
        description: 'Minimum spacing between cells in seconds (default 1.2). Lower it to 0.3-0.5 ' +
          'when re-reading a fast-cut montage so short shots get their own cell instead of being merged.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Sharpness of the close-up frames, for http(s) links. low = 480p, medium = 720p, ' +
          'high = 1080p (default). Raise it when the fine detail is not readable; lower it when the ' +
          'download is too slow. Ignored for local files, which are always read at native resolution.',
      },
      size: {
        type: 'string',
        enum: ['small', 'medium', 'high'],
        description: 'Sharpness of the close-up frames: small = 720p source, medium = 1080p (default), ' +
          'high = 1440p. Raise it when fine detail matters; lower it to save bandwidth.',
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
  if (args.cells !== undefined && (!Number.isInteger(args.cells) || args.cells < 1 || args.cells > 16)) {
    problems.push('cells must be an integer 1..16');
  }
  if (args.sheets !== undefined && (!Number.isInteger(args.sheets) || args.sheets < 1 || args.sheets > 16)) {
    problems.push('sheets must be an integer 1..16');
  }
  if (args.need !== undefined && !['shot', 'scene', 'text'].includes(args.need)) {
    problems.push("need must be 'shot', 'scene' or 'text'");
  }
  if (args.budget !== undefined
    && (!Number.isInteger(args.budget) || args.budget < 320_000 || args.budget > 4_000_000)) {
    problems.push('budget must be an integer 320000..4000000 (pixels per image)');
  }
  if (args.maxPerSheet !== undefined
    && (!Number.isInteger(args.maxPerSheet) || args.maxPerSheet < 1 || args.maxPerSheet > 16)) {
    problems.push('maxPerSheet must be an integer 1..16');
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
  if (args.adaptive !== undefined && typeof args.adaptive !== 'boolean') {
    problems.push('adaptive must be a boolean');
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
  if (args.cells !== undefined && (!Number.isInteger(args.cells) || args.cells < 1 || args.cells > 9)) {
    problems.push('cells must be an integer 1..9');
  }
  if (args.minGap !== undefined && !(args.minGap >= 0)) problems.push('minGap must be >= 0');
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
