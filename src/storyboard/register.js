/**
 * storyboard/register.js — 视频识别那七个工具的注册入口
 * （storyboard / zoom / probe / locate / subtitles / index / danmaku / help）。
 *
 * 七个工具都在这一个目录里：schema 在 `./tool-spec.js`，handler 在 `../tools/`，注册在这里。
 * `video_help` 是唯一不出图的：它只印 `./help.js` 那份手册，替 schema 里那些"一辈子问不到
 * 两次"的调优说明省常驻 token。
 * `video_index` / `video_danmaku` 是唯一**不解码**的：都走 B 站公开接口
 * （`./sprite-index.js` / `./danmaku.js`），和另外五个"本地取帧"的工具是两条资源路径，
 * 所以它们是并列的工具而不是某个工具的模式。
 * 陪看（`watch_together`）曾经和这里对称，现在是另一个包 `dsh-watch-together`。
 *
 * 为什么 handler 没跟着搬进 `storyboard/`：那四个 handler 加起来 154 行，且都被
 * `test/schema-audit.test.mjs` 按 `src/tools/*.js` 扫；搬家的收益只是好看，
 * 而陪看的 handler 必须搬是因为它要跟插件一起走。**该拆的拆，不该拆的不动。**
 */

import {
  danmakuToolSpec, helpToolSpec, indexToolSpec, locateToolSpec, probeToolSpec, storyboardToolSpec,
  subtitlesToolSpec, zoomToolSpec,
} from './tool-spec.js';
import * as danmaku from '../tools/video-danmaku.js';
import * as help from '../tools/help.js';
import * as locate from '../tools/locate.js';
import * as probe from '../tools/probe.js';
import * as storyboard from '../tools/storyboard.js';
import * as subtitles from '../tools/subtitles.js';
import * as videoIndex from '../tools/video-index.js';
import * as zoom from '../tools/zoom.js';

/**
 * @param {(spec: object) => object} defineTool  宿主的 defineTool
 * @param {object} ctx  宿主上下文（存图用）
 * @returns {object[]} 已经 `defineTool()` 好的工具
 */
export function storyboardTools(defineTool, ctx) {
  return [
    defineTool({ ...storyboardToolSpec(), execute: (args) => storyboard.execute(ctx, args) }),
    defineTool({ ...zoomToolSpec(), execute: (args) => zoom.execute(ctx, args) }),
    defineTool({ ...probeToolSpec(), execute: (args) => probe.execute(ctx, args) }),
    defineTool({ ...locateToolSpec(), execute: (args) => locate.execute(ctx, args) }),
    defineTool({ ...subtitlesToolSpec(), execute: (args) => subtitles.execute(ctx, args) }),
    // 索引排在取图工具之后：它是"先看一眼全片有什么"的便宜入口，但主力仍是 storyboard/zoom
    defineTool({ ...indexToolSpec(), execute: (args) => videoIndex.execute(ctx, args) }),
    // 弹幕是纯文本旁路数据，和索引同一条路（pagelist → 公开接口），也不解码
    defineTool({ ...danmakuToolSpec(), execute: (args) => danmaku.execute(ctx, args) }),
    // 手册放在最后：它不该排在四个能干活的工具前面抢注意力。
    defineTool({ ...helpToolSpec(), execute: (args) => help.execute(ctx, args) }),
  ];
}
