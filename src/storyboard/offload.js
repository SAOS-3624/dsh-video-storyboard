/**
 * offload.js — 把会话历史里较早的图"省略"掉，让它们不再被发出去。
 *
 * **和 `dsh-see-now/src/offload.js` 是同一份逻辑**（2026-11-06 起两边都有这张图）。
 * 两个包独立发版、不能互相 import，所以只能各存一份；改这里时**记得同步另一边**，
 * 尤其是 surface 重放的规则和 `image/offload` 的校验口径。
 *
 * ## 为什么需要它
 *
 * 分镜图进了会话历史就跟着每一轮请求走，直到会话结束。宿主不回收 ——
 * **但宿主有一个正规机制叫 `image/offload`**：往会话日志里追加一条事件，
 * 声明"这几张图以后换成一段占位文本"，之后 `projectOffloadedImages` 会把它们
 * 替换成 `offloadedImageText`，图就不再进请求、也不会被读盘。
 *
 * 于是图文件可以安全删掉（磁盘下来），会话还能继续聊（占位文本顶上）。
 *
 * ## 为什么不用"把文件换成一张小图"
 *
 * `dsh-attachment-local` 读盘时三重校验（内容 sha256、bytes、width/height），
 * 换内容直接 `ATTACHMENT_CORRUPT` —— 比删掉更糟（删掉是 `ATTACHMENT_NOT_FOUND`，
 * 至少能看出是"文件没了"）。
 *
 * ## 代价
 *
 * 追加事件会改历史 → 前缀缓存从第一条被省略的消息起失效 → **一次性全量重算**。
 * 所以别频繁调；攒够一批再一次做完。
 */

/**
 * 「刚交出去图」的回调。`attachSheetImages` 是模块级函数，够不到插件作用域里的
 * 配置和会话 id，所以走这条钩子：`apply` 时挂上，交付后触发自动省略。
 */
let afterDelivery = null;

/** 挂上交付后的钩子（插件加载时调一次）。 */
export function setDeliveryHook(fn) {
  afterDelivery = typeof fn === 'function' ? fn : null;
}

/** 交付完图之后调一下；**任何异常都不能影响这张图的交付**。 */
export function notifyDelivery() {
  try { afterDelivery?.(); } catch { /* 省略绝不能影响这一轮的结果 */ }
}


/** 能承载图片的 surface 事件类型（宿主 `image/offload` 校验就认这两种）。 */
const IMAGE_CARRYING = new Set(['user/message', 'tool/result']);

/**
 * 把一条消息里的图按 depth-first 顺序摊平（宿主就是这么编号的）。
 *
 * 顺带取 `bytes` —— 那是**附件原始字节**，和 `objects/<hash>` 里的文件大小逐字节一致
 * （2026-11-06 对 70 张图核过，70/70 相同）。所以体积门槛可以用它精确算。
 * @param {unknown} content - 消息的 content 数组
 * @returns {Array<{index:number, bytes:number}>}
 */
function imagesIn(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  const visit = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'image') {
        const b = block?.attachment?.bytes;
        out.push({ index: out.length, bytes: Number.isFinite(b) && b > 0 ? b : 0 });
      } else if (Array.isArray(block.content)) {
        visit(block.content);
      }
    }
  };
  visit(content);
  return out;
}

/**
 * 重放 surface，得到"当前还在模型可见历史里"的节点，按出现顺序。
 *
 * 和 `attachments-gc.mjs` 用的是同一套规则：`append` 追加，
 * `{op:'replace',startSeq,endSeq}` 遮蔽区间后把自己追加进来。
 * @param {Array} events - 会话事件（按 seq 升序）
 * @returns {Array<{seq:number, event:object}>}
 */
function replaySurface(events) {
  const nodes = [];
  for (const e of events) {
    const op = e?.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push({ seq: e.seq, event: e });
      continue;
    }
    if (op && op.op === 'replace') {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].seq >= op.startSeq && nodes[i].seq <= op.endSeq) nodes.splice(i, 1);
      }
      nodes.push({ seq: e.seq, event: e });
    }
  }
  return nodes;
}

/**
 * 已经被省略过的 (seq, index)，避免重复标记 —— 宿主会拒绝重复 target。
 * @param {Array} events
 * @returns {Set<string>} `"seq:index"`
 */
function alreadyOffloaded(events) {
  const done = new Set();
  for (const e of events) {
    if (e?.type !== 'image/offload') continue;
    const targets = e?.data?.targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (!t || !Array.isArray(t.imageIndexes)) continue;
      for (const i of t.imageIndexes) done.add(`${t.seq}:${i}`);
    }
  }
  return done;
}

/**
 * 算出该省略哪些图：**保留最新的 `keep` 张，更早的全部标记**。
 *
 * `keep` 是**省完之后停在哪**，不是"一到就省" —— 什么时候动手由
 * `planOffloadWithTrigger()` 决定（那边有独立的触发阈值）。
 *
 * @param {Array} events - `session.snapshotEvents()` 的结果
 * @param {{keep?:number}} limits - 保留多少张（0 = 全不留）
 * @returns {{targets: Array<{seq:number,imageIndexes:number[]}>, total:number, offloading:number,
 *            kept:number, keptBytes:number, offloadingBytes:number, totalBytes:number}}
 */
export function planOffload(events, limits = {}) {
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const done = alreadyOffloaded(events);
  const nodes = replaySurface(events);

  // 按模型可见顺序把 (seq, index, bytes) 拉平
  const occurrences = [];
  let totalBytes = 0;
  for (const node of nodes) {
    if (!IMAGE_CARRYING.has(node.event?.type)) continue;
    const content = node.event?.data?.message?.content ?? node.event?.data?.content;
    for (const img of imagesIn(content)) {
      if (done.has(`${node.seq}:${img.index}`)) continue;
      occurrences.push({ seq: node.seq, index: img.index, bytes: img.bytes });
      totalBytes += img.bytes;
    }
  }

  const total = occurrences.length;
  const cut = Math.max(0, total - keep);
  const picked = occurrences.slice(0, cut);
  const kept = occurrences.slice(cut);
  const offloadingBytes = picked.reduce((a, o) => a + o.bytes, 0);
  const keptBytes = kept.reduce((a, o) => a + o.bytes, 0);

  // 按 seq 分组（宿主要求同一 seq 的 index 严格递增、且每个 seq 只出现一次）
  const bySeq = new Map();
  for (const { seq, index } of picked) {
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push(index);
  }
  const targets = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, imageIndexes]) => ({ seq, imageIndexes: imageIndexes.sort((a, b) => a - b) }));

  return { targets, total, offloading: picked.length, kept: kept.length, keptBytes, offloadingBytes, totalBytes };
}

/**
 * 带「触发阈值」的计划：**涨到 `trigger` 张才动手，一次省到只剩 `keep` 张**。
 *
 * ## 为什么要分成两个数
 *
 * 只用 `keep`（一超就省）的话：留 200 张，第 201 张进来省 1 张、第 202 张再省 1 张 ——
 * **每出一张图就改一次历史，前缀缓存每轮全量失效**。省下的那点命中 token
 * 远不够付重算的钱，比不省还贵（2026-11-06 用户指出）。
 *
 * 所以拆成「触发线」和「留底」：涨到 300 才动，一次省到 100 —— 攒 200 张才重算一次。
 * 两个数都进设置，用户自己权衡「会话里最多容忍多少张」和「每次重算要省多少」。
 *
 * @param {Array} events - `session.snapshotEvents()` 的结果
 * @param {{trigger?:number, keep?:number}} limits
 *   - `trigger`: 涨到多少张才动手（**0 = 关闭**）；必须大于 `keep`
 *   - `keep`: 省完保留几张
 * @returns {{triggered:boolean, plan:object}}
 */
export function planOffloadWithTrigger(events, limits = {}) {
  const trigger = Math.max(0, Math.floor(Number(limits?.trigger) || 0));
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const plan = planOffload(events, { keep });
  // trigger=0 是"关掉"；keep >= trigger 的配置在写入时就被夹住了，这里再兜一次
  const triggered = trigger > 0 && trigger > keep && plan.total >= trigger && plan.offloading > 0;
  return { triggered, plan };
}

/**
 * 把计划写进会话，并确认落盘。
 *
 * `session.append` 的校验很严（seq 必须是当前 surface 节点、index 严格递增、
 * 不能重复省略），所以**算完立刻写**，中间别 await 别的事情 —— 否则 surface 变了会被拒。
 *
 * @param {object} session - `agent.session`
 * @param {Array<{seq:number,imageIndexes:number[]}>} targets
 * @param {object|null} sessions - 用来 flush 的 sessions 服务（可空）
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function applyOffload(session, targets, sessions = null) {
  if (!session?.append) return { ok: false, reason: 'no-session' };
  if (!Array.isArray(targets) || targets.length === 0) return { ok: true, reason: 'nothing-to-do' };
  try {
    session.append('image/offload', { targets });
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    if (sessions?.flush) await sessions.flush(session);
  } catch {
    /* flush 失败不算失败：事件已经 append 进内存，下一次成功 flush 会带上 */
  }
  return { ok: true };
}
