/**
 * tools/probe.js — `video_probe` 的 execute。
 *
 * 只读容器头，**不下载**：probe 的全部价值就是"便宜"。链接走 probeUrl（只解析），
 * 本地走 probeVideo（几毫秒）。下载 7 MB 再读头，这个工具就没有意义了。
 */

import { probeVideo } from '../probe.js';
import { formatProbe, formatRemoteProbe } from '../format.js';
import { probeUrl } from '../fetch.js';
import { isHttpUrl } from '../url.js';

export async function execute(ctx, args) {
  if (!args?.input) throw new Error('input is required');
  const fetchOptions = { cookies: args.cookies, allowAnonymous: args.allowAnonymous === true };
  if (isHttpUrl(args.input)) {
    const remote = await probeUrl(args.input, fetchOptions);
    return { text: formatRemoteProbe(remote) };
  }
  const info = { ...(await probeVideo(args.input)), path: args.input };
  return { text: await formatProbe(info) };
}

