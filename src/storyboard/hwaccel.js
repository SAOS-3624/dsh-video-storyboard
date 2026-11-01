/**
 * hwaccel.js — 连续解码走**硬件解码器**（NVDEC / D3D11VA），逐帧 seek 不走。
 *
 * ## 为什么只给扫描用
 *
 * 扫描是"整片顺序解码一遍"，硬件解码的收益来自**每帧成本**：实测同一支 AV1 640×360
 * 212 秒的片子，软解 13.7s、`-hwaccel cuda` 3.9s（3.5×）。
 *
 * 取帧正好相反：单帧 `-ss` 每次都要新建一个 CUDA 上下文，实测 8 帧串行
 * 软解 3005ms / cuda 4212ms —— **硬件反而更慢**。所以 `extractFrameRaw` 完全不碰这里。
 *
 * ## 为什么要探测而不是直接加 `-hwaccel cuda`
 *
 * 三件事都可能不成立：没有 N 卡、卡不支持这个编码（AV1 比 H.264 晚两代）、
 * 驱动没装好。任何一条不成立时 ffmpeg 的行为是**直接失败退出**，而扫描一失败整张分镜就没了。
 * 所以先花一次 ~300ms 试解码 5 帧，成功才在正式扫描里用。
 *
 * `-hwaccel auto` 不能替代探测：实测在这台机器上它**什么都没选**（13.8s，和软解一样），
 * 因为 ffmpeg 的 auto 只在 `-hwaccel_device` 等条件都齐时才挑硬件。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 探测顺序：NVDEC 优先（AV1/HEVC 支持最全、实测最快），D3D11VA 兜底（Intel/AMD） */
export const HWACCELS = ['cuda', 'd3d11va'];

/** 进程内缓存：key 是 `ffmpegPath|input|mtime`。同一部片子反复扫描不要重复探测。 */
const probeCache = new Map();

function explicitChoice(env) {
  const raw = String(env.DSH_HWACCEL ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'none' || raw === 'off' || raw === '0' || raw === 'false') return { hwaccel: null, forced: true };
  if (HWACCELS.includes(raw)) return { hwaccel: raw, forced: true };
  // 写错的值不静默吞掉：退回自动，但留一句话，免得以为配上了
  return { hwaccel: undefined, forced: false, unknown: raw };
}

/**
 * 这个 ffmpeg + 这个片源能不能硬件解码。
 *
 * @param {{ffmpegPath:string, input:string, env?:NodeJS.ProcessEnv, timeoutMs?:number}} opts
 * @returns {Promise<'cuda'|'d3d11va'|null>}
 */
export async function resolveHwaccel({ ffmpegPath, input, env = process.env, timeoutMs = 8000 }) {
  const choice = explicitChoice(env);
  if (choice?.forced) return choice.hwaccel;
  if (env.DSH_HWACCEL_UNKNOWN && choice?.unknown) {
    process.stderr.write(`[hwaccel] unknown DSH_HWACCEL=${choice.unknown}，按自动探测处理\n`);
  }

  const key = `${ffmpegPath}|${input}`;
  if (probeCache.has(key)) return probeCache.get(key);

  // 只解前 5 帧：编码格式、硬件支持、驱动状态这三件事在头几帧就全部暴露了。
  // `-v error` + 检查 stderr 里的 "Failed"/"doesn't support"：ffmpeg 对不支持的 hwaccel
  // 有时 exit 0 但 stderr 报错（format 回退），只看退出码会误判成"可用"。
  for (const hw of HWACCELS) {
    try {
      const { stderr } = await run(ffmpegPath, [
        '-hide_banner', '-v', 'error', '-nostdin',
        '-hwaccel', hw, '-i', input, '-frames:v', '5', '-an', '-sn', '-f', 'null', '-',
      ], { timeout: timeoutMs, maxBuffer: 4 << 20 });
      if (!/Failed|doesn't support|not supported|No device/i.test(stderr)) {
        probeCache.set(key, hw);
        return hw;
      }
    } catch {
      /* 这一档不可用，试下一档 */
    }
  }
  probeCache.set(key, null);
  return null;
}
