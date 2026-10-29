/**
 * probe-host.js — 一次性摸清宿主给了我们什么。
 *
 * 背景：陪看要"到点叫醒会话"，唯一已知可行的调用是
 * `ctx.sessionController.prompt({ sessionId, mode: 'queue', content })`（dsh-fish 用的就是它）。
 * 但 `sessionId` 从哪来、当前会话怎么找，宿主没有公开类型文档。
 *
 * 与其凭猜写一堆代码，不如先把 `ctx` 的真实形状落盘看一眼：
 *   ~/.dsh/watch-probe.json
 * 拿到之后删掉这个探测即可。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const seen = new Set();

const describe = (obj, depth = 1) => {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return typeof obj;
  const keys = Object.keys(obj);
  if (depth <= 0) return keys;
  const out = {};
  for (const k of keys.slice(0, 40)) {
    const v = obj[k];
    out[k] = typeof v === 'function' ? 'fn' : (v && typeof v === 'object' ? Object.keys(v).slice(0, 12) : typeof v);
  }
  return out;
};

export async function probeHost(ctx, { env = process.env, tag = 'apply' } = {}) {
  if (seen.has(tag)) return null;
  seen.add(tag);
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const file = join(home, 'watch-probe.json');
  const report = {
    at: new Date().toISOString(),
    tag,
    ctxKeys: Object.keys(ctx ?? {}).slice(0, 80),
    sessionController: ctx?.sessionController ? describe(ctx.sessionController, 2) : null,
    // 有没有"当前会话"这类字段：不同宿主叫法不一样，全都抓一遍
    sessionish: Object.keys(ctx ?? {}).filter((k) => /session|conversation|chat|thread/i.test(k)),
    toolCallish: Object.keys(ctx ?? {}).filter((k) => /call|invoke|tool/i.test(k)),
  };
  try {
    await mkdir(home, { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}
