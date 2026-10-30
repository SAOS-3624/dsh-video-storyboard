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
 *  - 子帧不能小于 100×56：再小就只剩色块（实测 110×61 是"能分辨不同镜头"的下限）。
 */
export function chooseSubGrid({
  shots, cellW, cellH, dur, cutScore = Infinity,
  minShots = 4, minRate = 0.7, minSubScore = 30, minSubW = 100, minSubH = 56,
}) {
  // 那些"刀"本身要有分量。2D 线稿动画、游戏 UI 这类内容每帧都在变一点，
  // 刀数能到 0.7/s，但摊出来的 9 张几乎一模一样（实测 RETAS 演示片就是这样）——
  // 摊开只有在"刀是硬切"时才有意义。
  if (cutScore < minSubScore) return 1;
  if (!(shots >= minShots)) return 1;
  // **密度才是判据，不是镜头数**：15 秒里 5 个镜头是正常的叙事节奏，
  // 把这种格子摊成 9 张只会毁掉"这段整体长什么样"。只有平均镜头短于 ~1.4 秒（≥0.7 刀/秒）
  // 才算快闪，才值得摊。
  if (dur > 0 && shots / dur < minRate) return 1;
  let k = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(shots))));
  while (k > 1 && (cellW / k < minSubW || cellH / k < minSubH)) k -= 1;
  return k > 1 ? k : 1;
}

/**
 * 把一格摊成 k×k：取 k² 个等距子帧，拼回一张 cellW×cellH 的图。
 * 子帧用 `mode:'mid'`（不做 3 候选锐度挑选）—— 一格里要取 9~16 张，再挑三倍会让这一步变成瓶颈。
 */
export async function extractSubTile({ input, remote, a, b, k, cellW, cellH, ffmpegPath }) {
  const tileW = Math.floor(cellW / k);
  const tileH = Math.floor(cellH / k);
  const n = k * k;
  const tiles = [];
  let fellBack = 0;
  for (let i = 0; i < n; i++) {
    const at = a + (b - a) * ((i + 0.5) / n);
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
