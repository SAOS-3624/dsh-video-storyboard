#!/usr/bin/env node
/**
 * probe — 只读容器头，不出图、不扫描、不转写。
 *
 * 为什么单独一个 bin：这是**最便宜的一步**。本地文件几毫秒，链接只解析不下载。
 * 先 probe 再决定「要不要 9 格 / 要不要分段 / 有没有音轨」，能省掉一次盲试的全片扫描，
 * 也就省掉那几张图的 vision token（实测一张 ≈222 token，文字索引另算）。
 *
 *   node bin/probe.mjs <video-or-url> [--json] [--cookies <cookies.txt>] [--allow-anonymous]
 *
 * 对应工具层的 `video_probe`（src/tools/probe.js）。逻辑一行不抄，直接调同一批函数：
 * 本地走 probeVideo()，链接走 probeUrl()（**只解析直链，不下载**）。
 *
 * ⚠️ 这里**没有** `--quality`：probe 不下载，清晰度是下载时才要决定的事。
 * 工具层的 video_probe 也没有这个参数 —— 加了就是个静默无效的开关。
 */
import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/storyboard/probe.js';
import { probeUrl } from '../src/storyboard/fetch.js';
import { isHttpUrl } from '../src/storyboard/url.js';
import { formatProbe, formatRemoteProbe } from '../src/storyboard/format.js';

const opt = parse(process.argv.slice(2), {
  json: false, cookies: null, 'allow-anonymous': false,
});

if (opt.$unknown.length) {
  // 与 storyboard 的约定一致：不认识的开关要当场说出来，别静默忽略
  console.error(`[warn] 未识别的参数：${opt.$unknown.map((k) => '--' + k).join(' ')}（已忽略）`);
}

const input = opt._[0];
if (!input) {
  console.error('用法: node bin/probe.mjs <video-or-url> [--json] [--cookies <file>] [--allow-anonymous]');
  console.error('');
  console.error('  只读容器头：时长 / 分辨率 / 帧率 / 有无音轨 / 链接的标题与格式。不上传、不出图、不下载。');
  process.exit(1);
}

try {
  let info;
  let remote = false;
  if (isHttpUrl(input)) {
    remote = true;
    info = await probeUrl(input, {
      cookies: opt.cookies,
      allowAnonymous: opt['allow-anonymous'] === true,
    });
    info.path = input;
  } else {
    info = { ...(await probeVideo(input)), path: input };
  }

  if (opt.json) {
    // --json 给脚本/管道用：字段名与工具层返回的一致，方便对拍
    console.log(JSON.stringify({ ...info, remote }, null, 2));
  } else {
    // formatRemoteProbe 是同步函数，await 无害但也别让人以为它是异步的
    console.log(remote ? formatRemoteProbe(info) : await formatProbe(info));
  }
} catch (e) {
  // 报错只打一句人话 + 原始信息，不打整段栈（CLI 场景他自己会看命令行）
  console.error(`probe 失败：${e?.message || e}`);
  if (!isHttpUrl(input)) {
    console.error('  本地文件的话，先确认路径存在、并且 ffmpeg 能读（`ffmpeg -i <file>` 能看到时长）。');
  }
  process.exit(1);
}
