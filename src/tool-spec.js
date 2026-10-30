/**
 * tool-spec.js — **公开入口**：把两个领域各自的契约再导出成一份。
 *
 * 真正的定义在：
 *   - `storyboard/tool-spec.js` —— video_storyboard / zoom / probe / locate
 *   - `watch/tool-spec.js`      —— video_watch
 *
 * 为什么保留这个文件：`dsh-video-storyboard/tool-spec` 是 package.json 里的公开子路径，
 * 外部（CLI、测试、可能的第三方）一直从这里拿 spec。**搬家不能断入口**。
 *
 * 内核代码请直接从各自的目录引 —— 那样读代码的人一眼看得出边界在哪。
 */

export {
  LOCATE_TOOL_NAME, PROBE_TOOL_NAME, TOOL_NAME, ZOOM_TOOL_NAME,
  locateToolSpec, probeToolSpec, storyboardToolSpec, validateToolArgs, validateZoomArgs,
  zoomToolSpec,
} from './storyboard/tool-spec.js';

export {
  WATCH_TOOL_NAME, watchToolSpec, validateWatchArgs,
} from './watch/tool-spec.js';
