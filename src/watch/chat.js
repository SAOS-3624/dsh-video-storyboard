/**
 * chat.js — 聊天框的对外门面。
 *
 * 这里**不放实现**，只转发三件本来就不相干的事：
 *
 *   chat-store.js   流里有什么 —— jsonl 读写、台词落盘、用户消息增量
 *   chat-view.js    页面长什么样 —— 两个 HTML 模板（纯字符串）
 *   chat-server.js  谁来应答 —— localhost 四条路由 + 生命周期
 *
 * 为什么保留这个文件：CLI、`watch_together` 和一批测试都从 `./chat.js` 取东西，
 * 门面留着就不用把一次结构调整扩散成一圈 import 改动。
 *
 * 为什么要有它（设计动机）见 `chat-store.js` 的文件头。
 */

export {
  appendAssistantSay,
  appendChat,
  attachSpeechToChat,
  chatFile,
  makeChatWatcher,
  readChat,
} from './chat-store.js';

export { CHAT_PAGE, WIDGET_PAGE, renderPage } from './chat-view.js';

export {
  DEFAULT_CHAT_PORT,
  chatAlive,
  closeChatSession,
  ensureChatSession,
  startChatServer,
} from './chat-server.js';
