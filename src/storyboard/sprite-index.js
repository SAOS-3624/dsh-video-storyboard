/**
 * sprite-index.js — `video_index` 的实现：**不解码**地拿一份全片索引（issue #95）。
 *
 * ## 它为什么和 `video_storyboard` 分开
 *
 * `video_storyboard` 的语义是"从视频里切出画面"：下载、解码、按时间轴切、拼宫格、保证每格能读清。
 * 这条路**一次解码都不需要** —— 输入是 B 站已经替我们拼好的雪碧图。塞进同一个工具的结果是
 * 一个函数里两条完全不同的资源路径（本地解码 vs 纯 HTTP），`quality` / `region` / `maxFrames`
 * 这些参数对索引路径全部无意义，schema 里就得开始写"仅当 mode=… 时生效"。
 *
 * 所以分工是：**索引归索引，取帧归取帧**。这里只产出「第 k 格 = 第 s 秒」的映射 + 雪碧图本身；
 * 要看清楚某一页，把时刻交给 `video_zoom`（或对直链 `ffmpeg -ss`）。
 *
 * ## 三条从实测里来的硬约束（2026-11-24，BV1ris26hEa2）
 *
 * 1. **`index` 的长度不等于 `张数 × 格数`**。这条实测是 185 而 2×10×10=200 ——
 *    最后一张雪碧图尾部是**空的**（不够 100 格）。所以校验不能用等号：
 *    只要 `(张数-1)×格数 < len ≤ 张数×格数` 就是正常，等号那版会天天误报。
 * 2. **`index` 必须按格号取，不能去重**。头两格都是 0 秒但画面不同（#95 的实测），
 *    去重会让后面整体错位一格。
 * 3. **只有 `index=1` 给秒数数组**，而且它间歇性返回空数组（8 次里 1 次）。所以空数组要重试，
 *    重试完还是空就**明确报错并建议退回 `video_storyboard`**，不返回半张图让人猜。
 *
 * ⚠️ 这一份**只够定位、不够读数**：一格 480×270（老稿可能 160×90），传进模型还会被再降采样一次。
 * 返回里要把这句话写死，避免模型拿索引图当证据去抄数字。
 */

const API = 'https://api.bilibili.com';
/** B 站的公开接口会挑 UA，通用 SDK 名会被挡；带上 Referer 才给直链下载。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** 空数组重试几次（不含第一次）。#95 的实测是 8 次里 1 次，两次足够。 */
const RETRIES = 2;

/**
 * 从 `BV1ris26hEa2` / `https://www.bilibili.com/video/BV1ris26hEa2` / 带 `?p=3` 的链接里取 bvid。
 *
 * **只认 B 站**：这类工具的路子就是"用 B 站已有的旁路数据"，别的站没有这条接口，
 * 与其半路报错，不如在入口就说清楚。
 *
 * @param {string} raw
 * @param {string} [toolName] 报错时点名的工具（`video_danmaku` 也用它，别让用户以为自己调错了）
 * @returns {{bvid:string, page:number|null}} `page` 只有链接里带 `?p=` 时才非空
 */
export function parseBvid(raw, toolName = 'video_index') {
  const text = String(raw ?? '').trim();
  const fromUrl = text.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i);
  const bare = text.match(/^(BV[0-9A-Za-z]{10})$/i);
  const bvid = fromUrl?.[1] ?? bare?.[1] ?? null;
  if (!bvid) {
    throw new Error(`${toolName} only accepts a bilibili video: a BV id (BV1xxxxxxxxx) or a `
      + 'bilibili.com/video/BV… link. For anything else use video_storyboard (it decodes locally).');
  }
  let page = null;
  if (fromUrl) {
    try {
      const p = new URL(text).searchParams.get('p');
      if (p && /^\d+$/.test(p)) page = Number(p);
    } catch { /* 解析不了就当没带 p */ }
  }
  return { bvid, page };
}

/**
 * 校验 `index` 的形状（纯函数，好测）。
 *
 * 规则见文件头第 1 条：**不是等号**。`sheets × cols × rows` 是"最多能装多少格"，
 * `index.length` 是"实际有多少个时间点"，后者小于前者是正常的（最后一张填不满）。
 *
 * @returns {{ok:boolean, reason?:string, expected:number, actual:number, covered:number}}
 *   `covered` = 实际覆盖到的格数（用来告诉模型"第几格之后是空的"）
 */
export function checkShape({ index, imgXLen, imgYLen, sheets }) {
  const cols = Number(imgXLen);
  const rows = Number(imgYLen);
  const perSheet = cols * rows;
  const expected = perSheet * sheets;
  const actual = Array.isArray(index) ? index.length : 0;
  if (!(cols > 0 && rows > 0 && sheets > 0)) {
    return { ok: false, reason: `geometry missing (img_x_len=${imgXLen}, img_y_len=${imgYLen}, sheets=${sheets})`, expected, actual, covered: 0 };
  }
  if (actual === 0) {
    return { ok: false, reason: 'index is empty', expected, actual, covered: 0 };
  }
  if (actual > expected) {
    // 多出来 = 接口语义变了（比如一张图不止 100 格），这种情况不能猜，让调用方看得见
    return { ok: false, reason: `index longer than the sheet grid (${actual} > ${expected})`, expected, actual, covered: 0 };
  }
  if (actual <= (sheets - 1) * perSheet) {
    // 少了一整张：多半是 `image` 给了张数而 `index` 没跟上，取下去会整段错位
    return { ok: false, reason: `index covers fewer sheets than image (${actual} ≤ ${(sheets - 1) * perSheet})`, expected, actual, covered: 0 };
  }
  return { ok: true, expected, actual, covered: actual };
}

/**
 * 索引的采样间隔（秒）。给"这份索引够不够密"一个数，而不是让人凭感觉。
 *
 * **不能拿 `index[0]` 当起点算平均**：头两格都是 0 秒（同一时刻两张不同画面），
 * 拿 (末-首)/格数 会把它算进去、把平均值拉低一点点。这里用相邻差的中位数做"典型间隔"，
 * 用最大差做"最坏间隔" —— 中途插了一段高密度索引的片子，平均会骗人，最坏不会。
 */
export function gapStats(index) {
  const list = (index ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (list.length < 2) return { avg: null, worst: null, worstAt: null, median: null };
  let worst = 0;
  let worstAt = null;
  const diffs = [];
  for (let i = 1; i < list.length; i += 1) {
    const d = list[i] - list[i - 1];
    if (d < 0) continue;            // 接口抽风给倒序时不算，别把最坏间隔算成负数
    diffs.push(d);
    if (d > worst) { worst = d; worstAt = list[i - 1]; }
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const avg = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  return { avg, worst, worstAt, median };
}

/** 一个请求超时。接口是公开的，慢的时候十几秒也可能；给够但别无限等。 */
const TIMEOUT_MS = 30_000;

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: REFERER, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

async function getBinary(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: REFERER },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading a sprite sheet`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 取一集的索引（含雪碧图原图）。
 *
 * @param {object} o
 * @param {string} o.bvid
 * @param {{cid:number, page:number, part:string, duration:number}} o.part  pagelist 里的一项
 * @param {number} [o.maxGapSec]  平均/中位间隔超过它就告警（默认 10）
 * @param {typeof fetch} [o.fetchImpl]  测试注入用
 * @returns {Promise<object>}
 */
async function fetchPart({ bvid, part, maxGapSec = 10, fetchImpl, log = () => {} }) {
  const { cid } = part;
  let shot = null;
  let shape = null;
  let lastReason = 'not fetched';
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) {
      log(`videoshot 索引不可用（${lastReason}），第 ${attempt} 次重试…`);
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
    // `index=1` 才是"给秒数数组"的那种；0 / 2 / 空都只有图
    const raw = await getJson(fetchImpl,
      `${API}/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=1`);
    const data = raw?.data ?? {};
    const sheets = Array.isArray(data.image) ? data.image.length : 0;
    const index = Array.isArray(data.index) ? data.index : [];
    shape = checkShape({
      index, imgXLen: data.img_x_len, imgYLen: data.img_y_len, sheets,
    });
    if (raw?.code === 0 && shape.ok) {
      shot = data;
      break;
    }
    // 报错要带上**形状**：只报"索引为空"等于把判断甩给调用方（#95 里对方专门要的这条）
    lastReason = `code=${raw?.code ?? '?'} ${shape.ok ? '' : shape.reason} `
      + `期望 ${shape.expected} 格（${data.img_x_len}×${data.img_y_len}×${sheets} 张），实际 ${shape.actual}`;
  }
  if (!shot) {
    throw new Error(`videoshot 索引不可用：${lastReason}（bvid=${bvid} cid=${cid}）。`
      + '这条接口是公开但不是契约接口，随时可能改；要画面请用 video_storyboard（下载+分镜，永远能走）。');
  }

  const cols = Number(shot.img_x_len);
  const rows = Number(shot.img_y_len);
  const cellW = Number(shot.img_x_size);
  const cellH = Number(shot.img_y_size);
  // `image` 给的是 `//bimp.hdslb.com/...`，要补协议
  const urls = shot.image.map((u) => (String(u).startsWith('//') ? `https:${u}` : String(u)));
  const sheets = [];
  for (const url of urls) {
    sheets.push({ url, data: await getBinary(fetchImpl, url), cols, rows, cellWidth: cellW, cellHeight: cellH });
  }

  const index = shot.index.map(Number);
  const gap = gapStats(index);
  const warnings = [];
  if (gap.worst !== null && gap.worst > maxGapSec) {
    warnings.push(
      `这份索引太稀：最坏间隔 ${gap.worst}s（第 ${gap.worstAt}s 之后），典型 ${gap.median}s 一帧，`
      + `阈值 ${maxGapSec}s。关键页可能整段漏掉 —— 这种情况直接走 video_storyboard 更稳。`,
    );
  }
  if (cellW < 320) {
    warnings.push(`一格只有 ${cellW}×${cellH}，是偏小的老稿件：连定位都勉强，别拿它读字。`);
  }
  return { part, index, gap, sheets, shape, warnings };
}

/**
 * 取一份完整的索引。
 *
 * @param {object} o
 * @param {string} o.input  BV 号或链接
 * @param {number|'all'} [o.page]  第几集（默认 1）；`'all'` = 逐集都取
 * @param {number} [o.maxGapSec]
 * @param {typeof fetch} [o.fetchImpl]
 */
export async function fetchSpriteIndex({ input, page = 1, maxGapSec = 10, fetchImpl = globalThis.fetch, log = () => {} }) {
  const { bvid, page: pageFromUrl } = parseBvid(input);
  const want = page === 'all' ? 'all' : (Number(page) || pageFromUrl || 1);

  const list = await getJson(fetchImpl, `${API}/x/player/pagelist?bvid=${bvid}`);
  if (list?.code !== 0) {
    throw new Error(`pagelist failed (code=${list?.code ?? '?'} ${list?.message ?? ''}) for ${bvid}`);
  }
  const parts = (list.data ?? []).map((p) => ({
    cid: p.cid, page: p.page, part: p.part ?? '', duration: p.duration ?? null,
  }));
  if (parts.length === 0) throw new Error(`pagelist returned no parts for ${bvid}`);

  /**
   * 多 P 默认只做第 1 集。**不悄悄只给第一集**（#95 第 4 条）：默认值要在返回里说出来，
   * 要全部就显式 `page:"all"`。
   */
  const picked = want === 'all' ? parts : parts.filter((p) => p.page === Number(want));
  if (picked.length === 0) {
    throw new Error(`${bvid} has ${parts.length} part(s); page ${want} does not exist `
      + `(use 1–${parts.length}, or "all").`);
  }

  const out = [];
  for (const part of picked) {
    out.push(await fetchPart({ bvid, part, maxGapSec, fetchImpl, log }));
  }
  return {
    bvid,
    totalParts: parts.length,
    requested: want,
    parts: out,
    maxGapSec,
  };
}

/**
 * 把一份索引印成给模型看的文本。
 *
 * 秒数表**整串印出来**：模型数格子比调用一个新的分页接口便宜得多，而且这份表就是要被"数"的。
 * 200 个数字 ≈ 800 字符，比再要一次图便宜一个量级。
 *
 * @param {object} idx  `fetchSpriteIndex` 的返回
 */
export function formatIndex(idx) {
  const lines = [];
  lines.push(`索引：${idx.bvid} · 共 ${idx.totalParts} 集，本次取 ${idx.parts.length} 集`
    + `（${idx.requested === 'all' ? '全部' : `第 ${idx.requested} 集`}）。`);
  for (const p of idx.parts) {
    const { part, index, gap, sheets, shape } = p;
    const first = sheets[0];
    lines.push('');
    lines.push(`## 第 ${part.page} 集${part.part ? `：${part.part}` : ''}`
      + `（cid ${part.cid}，${part.duration ?? '?'}s）`);
    lines.push(`雪碧图 ${sheets.length} 张 × ${first.cols}×${first.rows} 格 = 最多 ${shape.expected} 格；`
      + `一格 ${first.cellWidth}×${first.cellHeight}，实际有 ${shape.actual} 个时间点`
      + `（从第 ${shape.actual + 1} 格起是空的）。`);
    lines.push(`采样：典型 ${gap.median ?? '?'}s 一帧，平均 ${gap.avg !== null ? gap.avg.toFixed(1) : '?'}s，`
      + `最坏 ${gap.worst ?? '?'}s（阈值 ${idx.maxGapSec}s）。`);
    lines.push('秒数表（**第 k 个数 = 第 k 格，从 0 起，行优先**；头两格都是 0 秒但画面不同，'
      + '**不要去掉重复的 0**）：');
    lines.push(index.join(','));
    lines.push('读法：从表里挑几格 → 那几格的秒数 → 用 `video_zoom({ input, from: 秒, to: 秒 })` 取全尺寸。');
    for (const w of p.warnings) lines.push(`⚠ ${w}`);
  }
  lines.push('');
  /**
   * 这段必须写死在返回里（#95 里交底过）：索引图**只够定位、不够读数**。
   * 不同客户端的图片预算不同，降采样倍数也不同，所以不写死一个数字，只说"以你环境实测为准"。
   */
  lines.push('**这张图只够定位，不够读数**：传进模型时还会被再降采样一次，正文会糊。'
    + '要读某一页的字，请用 `video_zoom` 取全尺寸帧，不要从索引图上抄数字。');
  return lines.join('\n');
}
