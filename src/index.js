/**
 * index.js — DSH 插件入口。**只做注册**，四个工具：
 *
 *   video_storyboard  全片（或一段）的概览宫格
 *   video_zoom        某一段的近距离重看（格少、每格大）
 *   video_probe       只读容器头，不花图片 token
 *   video_locate      纯文本定位：那句话在第几分钟
 *
 * 陪看（`watch_together`）不在这个包里 —— 它是 **`dsh-watch-together`**，一个单独的插件，
 * 单向依赖本包。本包不 import 它任何一行，所以这里也不注册它的工具。
 *
 * 每个工具的 execute 在 `src/tools/<name>.js` —— 拆开是有原因的：
 * 宿主管参数走的是 schema，**schema 没声明的参数会被直接丢掉**。
 * 所以"handler 读了哪些 args"必须能被静态扫出来，和"schema 声明了哪些"对上；
 * 一个文件里塞五个 handler 就扫不出边界了（见 test/schema-audit.test.mjs）。
 *
 * 契约要点（都是对着 @deepseek-ai/dsh-tools 的类型定义核对的）：
 *  - `apply` 返回 disposer（把所有 `ctx.tools.register()` 的返回值串起来）
 *  - `execute` 返回**规范值**（要过 output.schema）
 *  - `output.render(args, value)` 把规范值渲染成 ContentBlock[]，图片块是
 *    `{ type: 'image', attachment: ImageAttachmentRef }`，ref 必须由
 *    `ctx.attachments.saveImage()` 提交过后才能拿到（不能自己编）
 *  - saveImage 要的是**真正编码后的字节**（PNG/JPEG），不是裸 RGB —— 它会解码校验
 */

// 四个视频识别工具各自的注册入口：契约、handler、注册都在 src/storyboard/ 里。
import { storyboardTools } from './storyboard/register.js';

export const name = 'dsh-video-storyboard';
/**
 * **只声明 `tools`，不声明 `attachments`** —— 这一条是从"用户装插件时 DSH 卡死"来的教训。
 *
 * cordis 的 `inject` 是**硬前缀**：服务没就绪，apply 根本不会被调用，插件就永远停在"加载中"。
 * `attachments` 只在两个地方用（提交分镜图、字幕长图），而且都能**降级**成纯文本结果；
 * 可一旦某台机器上这个服务没注册（宿主版本偏旧、或该 bundle 没启用），整个插件就会挂在那里 ——
 * 表现就是启动/安装时卡住，而且日志里什么都没有。
 *
 * 所以：图片能力改成运行期探测（见 `src/tools/shared.js` 的 `attachSheetImages`），
 * 宿主没有 attachments 时工具照常注册，只是返回"这张图没法展示"的文本。
 * test/pipeline.test.mjs 里有断言守着这两件事：inject 只有 tools、apply 不抛。
 */
export const inject = ['tools'];

/**
 * 解析宿主的 dsh-tools。正常安装时裸包名就能解析；本地开发/测试时
 * 用 DSH_TOOLS_PATH 指向安装里的 lib/index.js。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    /* 落到环境变量 */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
}

/**
 * 注册的看门狗：宿主启动阶段会同步等待所有插件的 apply。
 * 只要这里有一条 await 永不 resolve（比如 import 宿主包时撞上坏掉的解析路径），
 * 整个 DSH 就卡在启动屏上 —— 用户看到的是"装这个插件把应用搞死"。
 * 超过 `APPLY_TIMEOUT_MS` 就放弃注册并交回空 disposer：插件不能用，但应用活着。
 */
const APPLY_TIMEOUT_MS = 15_000;

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    // **最坏的情况是插件不能用，不是应用起不来**。
    // 真实事故：我在 apply 里加了一次 ctx 探测，`Object.keys(ctx)` 在 cordis 上下文上抛错，
    // 整个 DSH 直接崩在启动阶段（"The application could not start"）。
    // 从那以后，apply 的异常一律吞掉并记录，交回一个空 disposer。
    try {
      ctx?.logger?.error?.(`[dsh-video-storyboard] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    // DSH_VIDEO_DEBUG=1 时把错误抛出去 —— 否则"插件静默不工作"很难查
    if (process.env.DSH_VIDEO_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();

  const tools = storyboardTools(defineTool, ctx);

  // **disposers 必须在最前面声明**：它曾经声明在别的钩子之后，于是 `disposers.push(off)`
  // 撞上 const 的暂时性死区，抛 ReferenceError，又被下面的 catch 静默吞掉 ——
  // 工具注册成功了，解绑函数却从来没登记过（插件卸载时不会解绑，而且没人知道出过错）。
  const disposers = [];
  disposers.push(...tools.map((tool) => ctx.tools.register(tool)));
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}

/** Promise 超时包装：超时后抛错（调用方会吞掉并交回空 disposer）。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // 别让这个定时器拖住进程退出
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
