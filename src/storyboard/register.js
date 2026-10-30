/**
 * storyboard/register.js — 视频识别那四个工具的注册入口（storyboard / zoom / probe / locate）。
 *
 * 和 `watch/register.js` 对称：schema 在 `./tool-spec.js`，handler 在 `../tools/`，注册在这里。
 *
 * 为什么 handler 没跟着搬进 `storyboard/`：那四个 handler 加起来 154 行，且都被
 * `test/schema-audit.test.mjs` 按 `src/tools/*.js` 扫；搬家的收益只是好看，
 * 而陪看的 handler 必须搬是因为它要跟插件一起走。**该拆的拆，不该拆的不动。**
 */

import {
  locateToolSpec, probeToolSpec, storyboardToolSpec, zoomToolSpec,
} from './tool-spec.js';
import * as locate from '../tools/locate.js';
import * as probe from '../tools/probe.js';
import * as storyboard from '../tools/storyboard.js';
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
  ];
}
