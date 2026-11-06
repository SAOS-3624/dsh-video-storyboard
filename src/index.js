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
import { serviceOf } from './tools/shared.js';
import { readVideoFile } from './storyboard/user-config.js';
import { setDeliveryHook, planOffloadWithTrigger, applyOffload } from './storyboard/offload.js';
import { defineToolCompat } from './define-tool.js';
import { createSettingsPage } from './settings/server.js';

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
  /**
   * 第二跳：`DSH_TOOLS_PATH` 指向磁盘上的那份（本地开发时用）。
   * **包一层 try**：路径写错不该让插件整个废掉。
   */
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (mod?.defineTool) return mod.defineTool;
    } catch { /* 路径不对，继续落到兜底 */ }
  }
  /**
   * 最后一跳：内置兼容实现。**不能再抛** ——
   * 宿主的包在 `app.asar` 里，插件侧经常解析不到（社区实报），
   * 抛出去会被 apply 的 catch 吞掉，结果是**整个插件静默不注册任何工具**。
   * 内置版只少了运行时参数校验，工具照常能用（详见 define-tool.js）。
   */
  return defineToolCompat;
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

  // 会话图片省略（见 src/storyboard/offload.js）：出图后按 video.json 的上限自动跑
  wireImageOffload(ctx, disposers);

  // 设置页是可选能力：没有本机 webServer 的 CLI 宿主照常只注册五个工具。
  const attachSettings = (settingsCtx) => {
    try {
      const settings = createSettingsPage({ ctx: settingsCtx, env: process.env, log: (message) => settingsCtx?.logger?.warn?.(message) });
      if (settings) {
        disposers.push(settings.dispose);
        disposers.push(settingsCtx.tools.register(defineTool(settings.tool)));
      }
    } catch (e) {
      try { settingsCtx?.logger?.warn?.('[dsh-video-storyboard] settings page failed: ' + String(e?.message ?? e)); } catch { /* ignore */ }
    }
  };
  // webServer 可能晚于插件就绪；动态 inject 比 apply 时硬探测更可靠。
  if (typeof ctx.inject === 'function') {
    try {
      const off = ctx.inject(['webServer'], (webCtx) => attachSettings(webCtx));
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      try { ctx?.logger?.warn?.('[dsh-video-storyboard] settings injection failed: ' + String(e?.message ?? e)); } catch { /* ignore */ }
    }
  } else {
    attachSettings(ctx);
  }

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

// ------------------------------------------------------------------ 会话图片省略

/** 出厂：涨到 300 张就动手，一次省到只剩 100 张（≈2.2 万 token）。 */
const IMAGE_TRIGGER_DEFAULT = 300;
const IMAGE_KEEP_DEFAULT = 100;

/**
 * 会话里的图会跟着每一轮请求走，宿主不回收、删会话也不会连带删图。
 * 这里按 `~/.dsh/video.json` 的 `imageKeep` / `imageKeepMB` 自动把**更早的**省略掉：
 * 往会话日志追加一条 `image/offload`，宿主投影把它们换成一段占位文本 ——
 * 之后既不发出去、磁盘上那份也能删（`tools/attachments-gc.mjs`）。
 *
 * 三个必须说清楚的点：
 * 1. **不要为了省 token 而调小**：被省掉的那些本来走缓存命中（约 1/10 价），
 *    而每次省略都要**一次性全量重算**。它省的是带宽和磁盘。
 * 2. **节流 30 秒**：重放整份会话日志要几十到几百毫秒，不能每出一张图就跑。
 * 3. **拿不到会话就静默跳过**：宁可这轮不省，也不能影响出图。
 *
 * @param {object} ctx - 插件上下文
 * @param {Array} disposers - 插件卸载时要跑的清理函数
 */
function wireImageOffload(ctx, disposers) {
  let lastSessionId = null;
  try {
    if (typeof ctx.on === 'function') {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
      });
      if (typeof off === 'function') disposers.push(off);
    }
  } catch (e) {
    // 拿不到就退化成"这一轮不省"，一定要说出来 —— 静默失败是这类 bug 的温床
    try { ctx?.logger?.warn?.(`[dsh-video-storyboard] session/event 钩子失败：${e?.message ?? e}`); } catch { /* ignore */ }
  }

  const readLimits = () => {
    const cfg = readVideoFile();
    const trigger = Number(cfg?.imageTrigger);
    const keep = Number(cfg?.imageKeep);
    return {
      trigger: Number.isFinite(trigger) && trigger >= 0 ? Math.floor(trigger) : IMAGE_TRIGGER_DEFAULT,
      keep: Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : IMAGE_KEEP_DEFAULT,
    };
  };

  /** @returns {Promise<{ok:boolean, reason?:string, plan?:object}>} */
  async function runOffload({ trigger, keep }) {
    const sc = serviceOf(ctx, 'sessionController');
    if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
    if (!lastSessionId) return { ok: false, reason: 'no-session' };

    let resolved;
    try {
      resolved = await sc.resolveAgent(lastSessionId);
    } catch (e) {
      resolved = { error: e };
    }
    const session = resolved?.agent?.session;
    if (!session) return { ok: false, reason: String(resolved?.error?.message ?? resolved?.error ?? 'resolve-failed').slice(0, 160) };

    // snapshotEvents() 在宿主里标了 deprecated，但它是唯一能同步读到当前日志的公开口子
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null;
    if (!Array.isArray(events)) return { ok: false, reason: 'no-events' };

    if (trigger === 0) return { ok: true, plan: null, disabled: true };
    // 涨到触发线才动手，一次省到只剩 keep 张（否则每出一张图就改历史，缓存每轮全废）
    const { triggered, plan } = planOffloadWithTrigger(events, { trigger, keep });
    if (!triggered || plan.offloading === 0) return { ok: true, plan, belowTrigger: true };

    const r = await applyOffload(session, plan.targets, serviceOf(ctx, 'sessions'));
    if (!r.ok) return { ok: false, reason: r.reason, plan };
    return { ok: true, plan };
  }

  let lastCheck = 0;
  setDeliveryHook(() => {
    const limits = readLimits();
    if (!limits.trigger) return;
    const now = Date.now();
    if (now - lastCheck < 30_000) return;
    lastCheck = now;
    setTimeout(() => {
      void runOffload(limits).then((r) => {
        if (!r.ok) {
          try { ctx?.logger?.warn?.(`[dsh-video-storyboard] 自动省略跳过：${r.reason}`); } catch { /* ignore */ }
        } else if (r.plan?.offloading) {
          try {
            ctx?.logger?.info?.(`[dsh-video-storyboard] 省略了 ${r.plan.offloading} 张图（保留 ${r.plan.kept}）`);
          } catch { /* ignore */ }
        }
      });
    }, 0);
  });
}
