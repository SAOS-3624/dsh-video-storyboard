/**
 * 设置页 token：**跨进程重启保持稳定**。
 *
 * 旧实现每次 createSettingsPage() 都 randomBytes(32)。宿主重启后 token 变了，
 * 而浏览器里已经打开的那一页仍拿着旧的注入 token，设置表单就会显示“token 无效”。
 * 把 token 落到 $DSH_HOME 下一次启动继续用，旧页面不用刷新也能继续保存。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_NAME = 'video-settings-token';

export function settingsTokenPath(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  return join(home, TOKEN_NAME);
}

export function settingsToken(env = process.env) {
  const path = settingsTokenPath(env);
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(raw)) return raw;
  } catch { /* 没建过或读不了，下面生成 */ }
  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token + '\n', { mode: 0o600 });
  } catch { /* 写不进去就用这次进程内的 token */ }
  return token;
}
