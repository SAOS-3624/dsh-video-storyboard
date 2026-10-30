/**
 * frames.js — **取像素**：本地 / 高清直链两条路、单帧 / 摊格两种形状、固定并发。
 *
 * 从 pipeline.js 拆出来的。这一层只做一件事：给定时间段，交出 RGB buffer。
 * 它不知道转写、不知道排布、不知道清单 —— 所以能单独压测（换并发的收益都是在这一层量出来的）。
 */

import { extractFrameRaw, extractSharpest, tileSubFrames } from './sheet.js';

/**
 * 取一帧：有高清直链就先走远程，失败回落本地低清。
 *
 * **远程时把候选帧降到 1。** 一次 HTTP seek 实测 1.92 s，3 候选即使并发也要 3–4 s/格，
 * 6 格就是 20 秒以上；而 zoom 的窗口本来就短、格间距小，段中点足够代表。
 * 本地文件仍然用 3 候选（0.35 s/次，几乎免费，且段内可能有转场帧）。
 */
export async function extractFrameWithFallback({ input, remote, at, dur, cellW, cellH, ffmpegPath, pick }) {
  const grab = (src, http, candidates) => {
    if (pick === 'sharp') {
      return extractSharpest({ input: src, at, dur, cellW, cellH, ffmpegPath, http, candidates });
    }
    return extractFrameRaw({
      input: src, at, dur, cellW, cellH, ffmpegPath, http,
      mode: pick === 'thumb' ? 'thumb' : 'mid',
    });
  };
  if (remote?.uri) {
    try {
      return { ...(await grab(remote.uri, remote.http, 1)), via: 'remote' };
    } catch {
      /* 直链过期或 CDN 抖动：不整次失败，落到本地那份低清 */
    }
  }
  return { ...(await grab(input, null, 3)), via: remote?.uri ? 'local-fallback' : 'local' };
}

/**
 * 固定并发数的 map：保持输出顺序，任何一个失败就整体失败（取帧失败不能静默跳过，否则图会缺格）。
 * 为什么不用 Promise.all：一次起 16 个 ffmpeg 会把机械硬盘打到爬行，也会把内存顶上去。
 */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * 这一格要不要摊成 k×k 子格？返回 k（1 = 不摊）。
 *
 * 判据（都来自实测）：
 *  - 镜头数少不值得摊：4 个镜头以下摊开只是把画面切碎；
 *  - k ≈ ceil(sqrt(镜头数))，上限 4 —— 让子帧数刚好覆盖镜头数，不多抽重复帧；
 *  - 子帧不能小于 200×112：再小就只剩色块。
 *    2026-10-30 对比测试实测（640×360 扫描源、640k 画布预算）：
 *      4×4 格 247×137 → 摊 2×2 得 123×68，字幕和 UI 标签**完全认不出**（盲评可读 1~2 分）；
 *      3×3 格 331×184 → 摊 2×2 得 165×92，仍然只能"看出是不同镜头"，认不出字（可读 2 分）；
 *      2×2 格 505×312 → 摊 2×2 得 252×156，可读。
 *    所以摊开的门槛不是"能分辨镜头"（110×61），而是"能认出内容"。原来写 100×56 的那条注释
 *    用的是"能分辨不同镜头"的标准，在文字密集的素材上等于把 16 格里 12 格换成噪点。
 */

/** "够热闹"：≥ 它才升到 3×3（9 个小图）。段内逐帧分数均值，快剪 8~15、摇镜 2~4、静止 <1。 */
export const BUSY_MOTION = 8;

/** "看得出来在动"：≥ 它就允许二重细分（子帧可以压到 110×56）。低于它的格子只给整帧。 */
export const TILE_MOTION = 3;

export function chooseSubGrid({
  shots, cellW, cellH, dur, cutScore = Infinity, meanMotion = 0,
  // minShots 从 4 降到 3：这个门槛以前会把"1 秒 3 镜（3 刀/秒）"挡掉，
  // 而它比"10 秒 4 镜（0.4 刀/秒）"密 7 倍 —— 真正该摊的是前者。
  // 密度判据（minRate）已经能拦住"镜头少但时长长的正常叙事"，minShots 只防"1 镜没东西可摊"。
  minShots = 3, minRate = 0.4, minSubScore = 30, minSubW = 200, minSubH = 112,
  minMotion = 1.5, maxK = 4, busyMotion = BUSY_MOTION,
}) {
  // **一个镜头、但画面一直在动**（摇镜、推拉、转场）：整段只取 1 帧会把运动过程全丢掉。
  // meanMotion 是段内逐帧分数的均值 —— 静止画面约 0.2，匀速摇镜约 1.5~3。
  // 这种段没有切点，下面几条判据（靠刀数/刀密度）全都拦得住，所以单独放行 2×2。
  if (shots <= 1 && meanMotion >= minMotion) {
    let k = 2;
    while (k > 1 && (cellW / k < minSubW || cellH / k < minSubH)) k -= 1;
    return k > 1 ? k : 1;
  }
  // 那些"刀"本身要有分量。2D 线稿动画、游戏 UI 这类内容每帧都在变一点，
  // 刀数能到 0.7/s，但摊出来的 9 张几乎一模一样（实测 RETAS 演示片就是这样）——
  // 摊开只有在"刀是硬切"时才有意义。
  if (cutScore < minSubScore) return 1;
  if (!(shots >= minShots)) return 1;
  // 密度门槛 0.7 → 0.4（平均 2.5 秒一个镜头就摊）：实测概念 PV 上 0.7 只摊 4/9 格，
  // 41 个镜头里只覆盖 31 个；0.4 摊 6/9 格，覆盖 41/41。再往下放宽（0.35~0.2）
  // 结果完全一样，所以 0.4 是拐点，不是越松越好。
  // 防"摊出来 9 张一模一样"的任务交给上面那两条
  // （cutScore + minShots）。
  //
  // **长格子不受这条管**（2026-10-30 补）：24 秒 8 个镜头算出来是 0.33 刀/秒，
  // 被当成"镜头稀"而整格只给 1 帧 —— 可它一秒都没浪费，只是镜头长。
  // 12 秒以上一律放行，由后面的像素下限决定能摊几×几。
  if (dur > 0 && dur < 12 && shots / dur < minRate) return 1;
  // k 上限默认 4（3×3 是"变化快"的地方的主力档位，别动它）。
  let k = Math.min(maxK, Math.max(2, Math.ceil(Math.sqrt(shots))));
  // **画面不够热闹就停在 2×2，不摊 3×3**。两条理由：
  //   - 9 个位置要把格子切成 110×61，只在"每张都不一样"时才划算；
  //     安静的段落里 9 张本来就有几张是同一个画面，切小了反而看不清。
  //   - 全片一律同一种粒度看着死板：快的地方 9 张小图、平稳的地方 4 张大图，
  //     这张图本身就读得出"哪里快哪里慢"。
  // meanMotion 是段内逐帧分数的均值（静止 ~0.2、摇镜 1.5~3、快剪 5~14）。
  // 实测正式 PV 九格是 1.62 / 4.04 / 11.06 / 13.61 / 4.87 / 10.90 / 7.72 —— 差 8 倍，
  // 足够把 2×2 和 3×3 拉开；阈值 8 让最热闹的三格用 3×3。
  if (meanMotion < busyMotion && k > 2) k = 2;
  // **格子数不该明显多过镜头数**：9 个位置去覆盖 5 个镜头，必然有 4 个位置是同一镜头的
  // 不同时刻 —— 看着就是"重复帧"。宁可 2×2 少看一个，也别在 3×3 里塞四张一样的。
  // 1.5 是实测取的：6 个镜头（9 帧）仍然留 3×3，5 个镜头 → 2×2（不然 4 张是同一镜头）。
  // 快的地方镜头多，自然还是 3×3 —— 这条不影响"变化快就细看"。
  while (k > 2 && k * k > shots * 1.5) k -= 1;
  while (k > 1 && (cellW / k < minSubW || cellH / k < minSubH)) k -= 1;
  return k > 1 ? k : 1;
}

/**
 * 把 n 帧分给 segs 段：**每段保底 1 帧**，剩下的按 weights 加权。
 *
 * 保底这条是硬约束，不能交给"按积分分配"自然得出：一段几乎静止的镜头积分接近 0，
 * 纯按积分分就一帧都分不到 —— 而观众要看的就是"这个镜头长什么样"。
 * weights 是每段的累积变化量（今由 density.integralMarks 提前算成采样点，这里一般传 null）。
 */
export function splitByWeight(n, segs, weights = null) {
  const per = new Array(segs).fill(0);
  if (n <= segs) {
    // 帧比镜头还少（预算被 subBudget 砍过就会这样）时，给前 n 个镜头各 1 帧。
    // 试过两种"更聪明"的挑法，实测都更差：
    //  - 按时间均匀挑：每次都挑中一格的第 1 个镜头，而那几个镜头积分是 0（暗场）→ 黑格；
    //  - 按积分挑：缓慢叠化/淡入的镜头积分又长又均匀，会稳定压过真内容 → 挑出糊画面。
    // 所以这里**故意保守**。真要让这 n 帧挑得更好，得先解决"格内有没有黑场镜头"这个分格问题。
    for (let i = 0; i < Math.min(n, segs); i++) per[i] = 1;
    return per;
  }
  if (!Array.isArray(weights) || weights.length !== segs) {
    const base = Math.floor(n / segs);
    const extra = n % segs;
    for (let i = 0; i < segs; i++) per[i] = base + (i < extra ? 1 : 0);
    return per;
  }
  const rest = n - segs;
  const totalW = weights.reduce((x, y) => x + y, 0);
  if (!(totalW > 0)) {
    for (let i = 0; i < segs; i++) per[i] = 1 + Math.floor(rest / segs) + (i < rest % segs ? 1 : 0);
    return per;
  }
  const raw = weights.map((w) => (w / totalW) * rest);
  const fl = raw.map(Math.floor);
  const left = rest - fl.reduce((x, y) => x + y, 0);
  // 余数按小数部分从大到小补，保证总数刚好等于 n
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((x, y) => y.frac - x.frac);
  for (let j = 0; j < left; j++) fl[order[j % segs].i] += 1;
  for (let i = 0; i < segs; i++) per[i] = 1 + fl[i];
  return per;
}

/**
 * 一格里 k² 个子帧各取哪个时刻（**均匀版**）。
 *
 * 按镜头段分帧数（每段保底 1 帧），段内则**均匀**取点。
 * 积分触发不在这里做：它的产物是**额外的分段边界**（density.integralMarks），
 * 先并进 shots 再调这个函数，于是变化多的地方自然多分几段、多取几帧。
 */
export function subTileTimes(a, b, n, shots = [], weights = null) {
  const marks = Array.isArray(shots) && shots.length > 0
    ? [a, ...shots.filter((t) => t > a && t < b).sort((x, y) => x - y), b]
    : null;
  const segs = marks ? marks.length - 1 : 0;

  // 没有切点信息：整格就是一个镜头，均匀取 n 个点
  if (!marks || segs < 1) {
    return Array.from({ length: n }, (_, i) => a + (b - a) * ((i + 0.5) / n));
  }

  const per = splitByWeight(n, segs, weights);
  const out = [];
  for (let i = 0; i < segs; i++) {
    const s = marks[i];
    const e = marks[i + 1];
    if (per[i] === 0) continue;           // 段数 > 子帧数时才会出现，跳过
    for (let j = 0; j < per[i]; j++) out.push(s + (e - s) * ((j + 0.5) / per[i]));
  }
  return out;
}


/**
 * 把一格摊成 k×k：取 k² 个子帧，拼回一张 cellW×cellH 的图。
 * 子帧用 `mode:'mid'`（不做 3 候选锐度挑选）—— 一格里要取 9~16 张，再挑三倍会让这一步变成瓶颈。
 *
 * `shots` 里除了真正的切点，还可能带着**积分采样点**（见 density.integralMarks）：
 * 变化攒够的地方会被当成额外的分段边界，于是那一段自然多分到几帧。
 * 这一层不知道两者的区别，也不需要知道。
 */
export async function extractSubTile({
  input, remote, a, b, k, cellW, cellH, ffmpegPath, shots = [],
}) {
  const tileW = Math.floor(cellW / k);
  const tileH = Math.floor(cellH / k);
  const n = k * k;

  const times = subTileTimes(a, b, n, shots);
  const tiles = [];
  let fellBack = 0;
  for (let i = 0; i < n; i++) {
    const at = times[i];
    // `remoteFrame` 的字段是 {uri, http:{userAgent, referer}} —— 之前这里读的是 url/headers，
    // 两个都不存在，于是子帧静默退回本地低清副本、HTTP 头也丢了（issue #9）。
    let tile = null;
    if (remote?.uri) {
      try {
        tile = await extractFrameRaw({
          input: remote.uri, at, dur: 0, cellW: tileW, cellH: tileH, ffmpegPath, http: remote.http, mode: 'mid',
        });
      } catch {
        tile = null;      // 远程失败就回落本地，并记一笔，清单里会报 frameFallbacks
      }
    }
    if (!tile) {
      tile = await extractFrameRaw({
        input, at, dur: 0, cellW: tileW, cellH: tileH, ffmpegPath, mode: 'mid',
      });
      if (remote?.uri) fellBack += 1;
    }
    tiles.push(tile.buffer);
  }
  return {
    buffer: tileSubFrames(tiles, k, cellW, cellH),
    t: a + (b - a) / 2,
    via: fellBack > 0 ? 'local-fallback' : 'ok',
  };
}
