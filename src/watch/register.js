/**
 * watch/register.js — 陪看这一个工具的**注册入口**。
 *
 * 存在的理由很实际：陪看要单独成一个插件，拆的时候应该是"把 `src/watch/` 整个搬走"，
 * 而不是"去 `index.js` 里把五行抠出来、再去 `tools/` 里捡一个 handler"。
 * 所以 schema（`tool-spec.js`）、handler（`handler.js`）、注册（这里）三样都在同一个目录里。
 *
 * 这个文件**只依赖 `./` 和 `../storyboard/`**，不碰 `index.js`、不碰 `tool-spec.js`
 * （那是另外四个工具的契约）。`test/layering.test.mjs` 会盯着这条。
 */

import * as handler from './handler.js';
import { watchToolSpec } from './tool-spec.js';

/**
 * @param {(spec: object) => object} defineTool  宿主的 defineTool
 * @param {object} ctx  宿主上下文（存图用）
 * @param {{ getSessionId?: () => (string|null), cache?: Map }} [deps]
 *   `getSessionId` 用**函数**而不是值：会话 id 由 session/event 钩子随时更新，
 *   闭包里拿快照会让第一次之后的所有调用都用旧 id。
 * @returns {object[]} 已经 `defineTool()` 好的工具，调用方负责 register + 收集 disposer
 */
export function watchTools(defineTool, ctx, { getSessionId = () => null, cache = new Map() } = {}) {
  return [
    defineTool({
      ...watchToolSpec(),
      execute: (args) => handler.execute(ctx, args, { sessionId: getSessionId(), cache }),
    }),
  ];
}
