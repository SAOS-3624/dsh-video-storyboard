/**
 * tool-spec.js — **公开入口**：把四个视频识别工具的契约再导出成一份。
 *
 * 真正的定义在 `storyboard/tool-spec.js`（video_storyboard / zoom / probe / locate）。
 *
 * 为什么保留这个文件：`dsh-video-storyboard/tool-spec` 是 package.json 里的公开子路径，
 * 外部（CLI、测试、可能的第三方）一直从这里拿 spec。**搬家不能断入口**。
 *
 * 陪看的契约（`watch_together`）**不在这里** —— 它属于 `dsh-watch-together` 那个包，
 * 从 `dsh-watch-together/tool-spec` 取。
 */

export {
  LOCATE_TOOL_NAME, PROBE_TOOL_NAME, TOOL_NAME, ZOOM_TOOL_NAME,
  locateToolSpec, probeToolSpec, storyboardToolSpec, validateToolArgs, validateZoomArgs,
  zoomToolSpec,
} from './storyboard/tool-spec.js';
