/**
 * resume.js — 断点续传下载器，以及"直链拼装"需要的两条小工具。
 *
 * 为什么需要它（不是洁癖，是一次实测）：
 * B 站 CDN 会在传输末尾**不给响应就直接断开**（`Remote end closed connection without
 * response`）。yt-dlp 带着 `--continue --retries 30` 确实每次都从 .part 接着来，但连续
 * 三十轮都停在同一处，最后整包失败。同一条直链换成 `curl -C -` 循环几次，几分钟就下完。
 * 差别不在协议，在请求形态 —— 所以这条路不能指望 yt-dlp 自己走出来。
 *
 * 这里只做一件事：**用 Range 把剩下的字节一轮轮续上来**，并且在"这一轮完全没有进展"
 * 时停下来报错，而不是把超时预算耗在无限重试上。
 */

import { spawn } from 'node:child_process';
import { open, stat, truncate } from 'node:fs/promises';

import { DEFAULT_FFMPEG } from './probe.js';

/** 从 yt-dlp 的 formats 里挑一条最省事的声音轨（只有声音、码率最高） */
export function pickAudioFormat(formats) {
  const audio = (formats ?? []).filter(
    (f) => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'),
  );
  if (audio.length === 0) return null;
  const bitrate = (f) => Number(f.abr ?? f.tbr ?? 0) || 0;
  return [...audio].sort((a, b) => bitrate(b) - bitrate(a))[0];
}

/** 格式对象里声明的文件大小，拿不到返回 null（给它，是为了下完能验长度） */
export function declaredBytes(format) {
  for (const key of ['filesize', 'filesize_approx']) {
    const n = Number(format?.[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function sizeOf(path) {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function rangeHeaders(headers, offset) {
  return offset > 0 ? { ...headers, Range: `bytes=${offset}-` } : { ...headers };
}

/** 把 reteres 包一层：调用方的 signal 与本次超时都能终止请求 */
function linkedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`stalled for ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

const FATAL_STATUS = new Set([401, 403, 404, 410]);

/**
 * 把 `url` 下到 `dest`，支持从已有的半成品继续。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.dest               半成品就写在这里；已存在则从它的大小续传
 * @param {Record<string,string>} [opts.headers]  UA / Referer 之类
 * @param {number|null} [opts.expectedBytes]      期望总长度；给了就在结尾验长度
 * @param {number} [opts.rounds=6]          最多几轮"断了接着来"
 * @param {number} [opts.timeoutMs=120000]  单轮总超时
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.onProgress]      ({ have, total, round })
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{bytes:number, total:number|null, rounds:number}>}
 */
export async function downloadResumable({
  url,
  dest,
  headers = {},
  expectedBytes = null,
  rounds = 6,
  timeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
  onProgress,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('downloadResumable needs a fetch implementation');
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`downloadResumable: not an http(s) url: ${url}`);
  }

  let have = await sizeOf(dest);
  let total = Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : null;
  let stalls = 0;
  let lastError = null;
  let used = 0;

  for (let round = 1; round <= rounds; round += 1) {
    used = round;
    if (total !== null && have >= total) break;
    const before = have;
    const link = linkedSignal(signal, timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: rangeHeaders(headers, have),
        redirect: 'follow',
        signal: link.signal,
      });

      if (res.status === 416) {
        // 服务器说"这个区间没有内容"：要么已经下完，要么 .part 比资源还大。
        const cr = res.headers.get('content-range');
        const size = Number(String(cr ?? '').split('/')[1]);
        if (Number.isFinite(size) && size > 0) total = size;
        if (total === null || have >= total) break;
        // .part 比资源大：只能从头来
        await truncate(dest, 0);
        have = 0;
        continue;
      }
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} while downloading ${new URL(url).host}`);
        error.status = res.status;
        throw error;
      }

      const ranged = res.status === 206;
      const length = Number(res.headers.get('content-length'));
      if (ranged) {
        // content-range 里的总长是服务器的原话，比 formats 里那个 filesize 更可信：
        // B 站的 filesize 和实际字节数差几十上百字节是常态，拿它当校验会误判"没下完"。
        const cr = res.headers.get('content-range');
        const size = Number(String(cr ?? '').split('/')[1]);
        if (Number.isFinite(size) && size > 0) total = size;
      } else {
        // 服务器不认 Range，只能整份重来（前面的字节作废）
        if (have > 0) await truncate(dest, 0);
        have = 0;
        if (Number.isFinite(length) && length > 0) total = length;
      }

      const handle = await open(dest, ranged ? 'a' : 'w');
      try {
        if (!res.body) throw new Error('response has no body');
        for await (const chunk of res.body) {
          await handle.write(chunk);
          have += chunk.length;
          onProgress?.({ have, total, round });
        }
      } finally {
        await handle.close();
      }
      if (total !== null && have >= total) break;
    } catch (error) {
      if (error?.status && FATAL_STATUS.has(error.status)) throw error;
      lastError = error;
    } finally {
      link.dispose();
    }

    if (have > before) {
      stalls = 0;       // 这一轮有进账，网络只是爱断，不是被封了
    } else {
      stalls += 1;
      if (stalls >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * stalls));
    }
  }

  const bytes = await sizeOf(dest);
  if (total !== null && bytes < total) {
    const why = lastError?.message ? `: ${lastError.message}` : '';
    throw new Error(
      `incomplete download after ${used} rounds: ${bytes}/${total} bytes${why}` +
      ' (the CDN keeps closing the connection; try again later, or download it yourself)',
    );
  }
  if (total === null && bytes === 0) {
    throw new Error(`nothing was downloaded from ${new URL(url).host}${lastError ? `: ${lastError.message}` : ''}`);
  }
  return { bytes, total, rounds: used };
}

/**
 * 把画面轨和声音轨合成一个 mp4（`-c copy`，不解码）。
 * 声音缺失时只封装画面 —— 宁可少一条音频包络，也别整条链接作废。
 */
export function muxStreams({
  video,
  audio = null,
  out,
  ffmpegPath = DEFAULT_FFMPEG,
  timeoutMs = 180_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [ffmpegPath, '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', video];
    if (audio) args.push('-i', audio);
    args.push('-c', 'copy', '-movflags', '+faststart', out);
    let child;
    try {
      child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new Error(`failed to spawn ${ffmpegPath}: ${error.message}`));
      return;
    }
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const tail = err.trim().split('\n').slice(-2).join(' | ');
      reject(new Error(`ffmpeg mux exited ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}
