/**
 * settings/page.js — 读取同目录的 page.html。
 *
 * 单独放 HTML 是为了避免在 JS 里塞一大段带脚本的模板：模板里的反引号和美元花括号
 * 很容易和插件源码自己的字符串打架。页面运行时从 /state 取路径，不预埋数据。
 */

import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

export function settingsPage() {
  return PAGE;
}
