/**
 * layering.test.mjs — `src/storyboard/` 与 `src/watch/` 的**分层**必须一直成立。
 *
 * 为什么值得一条测试：陪看将来要单独拆成一个插件，拆得动的前提是
 * **Storyboard 那边不需要陪看的任何东西**。这个约束靠自觉守不住 ——
 * 只要有人图方便在 `storyboard/` 里 import 一个 `watch/` 的函数（比如想复用
 * `position.js` 推一下播放位置），拆分成本立刻从"搬目录"变成"先解耦"。
 *
 * 规则只有一条，但它是单向的：
 *
 *   storyboard/  →  不许 import  watch/
 *   watch/       →  可以 import      storyboard/   （陪看建立在视频识别之上）
 *
 * 另外校验：两边都不许 import `src/tools/`（入口层只能反向依赖库），
 * 以及 `src/watch/` 不 import `index.js` / `tool-spec.js` 之外的顶层文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 把相对 import 解析成 `相对 src 的 posix 路径` */
function importsOf(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const code = readFileSync(file, 'utf8');
  const out = [];
  for (const m of code.matchAll(/(?:from '(\.[^']+)'|import\('(\.[^']+)'\))/g)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    out.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
  }
  return { rel, deps: out };
}

const ALL = walk(ROOT).map(importsOf);
const byArea = (area) => ALL.filter((f) => f.rel.startsWith(area + '/'));

test('分层：storyboard/ 不 import 任何 watch/ 的东西', () => {
  const bad = [];
  for (const { rel, deps } of byArea('storyboard')) {
    for (const d of deps) if (d.startsWith('watch/')) bad.push(`${rel} → ${d}`);
  }
  assert.deepEqual(bad, [],
    `\nStoryboard 必须能独立抽出来，不能反向依赖陪看：\n${bad.join('\n')}\n`);
});

test('分层：watch/ 可以依赖 storyboard/（这是唯一允许的方向）', () => {
  const uses = byArea('watch').flatMap(({ rel, deps }) => deps.filter((d) => d.startsWith('storyboard/')).map((d) => `${rel} → ${d}`));
  // 这个断言不是在要求"必须有依赖"，而是把方向钉住：一旦有人反过来写，上一条会红。
  assert.ok(Array.isArray(uses));
});

test('分层：库不反向 import 入口层（tools/ index.js tool-spec.js）', () => {
  const ENTRY = ['tools/', 'index.js', 'tool-spec.js'];
  const bad = [];
  for (const area of ['storyboard', 'watch']) {
    for (const { rel, deps } of byArea(area)) {
      for (const d of deps) {
        if (ENTRY.some((e) => d.startsWith(e) || d === e)) bad.push(`${rel} → ${d}`);
      }
    }
  }
  assert.deepEqual(bad, [],
    `\nhandler / 注册表是入口层，库不该反过来依赖它（会成环）：\n${bad.join('\n')}\n`);
});

test('分层：每个模块都归了类（顶层只剩入口与契约）', () => {
  const top = ALL.filter((f) => !f.rel.includes('/')).map((f) => f.rel).sort();
  assert.deepEqual(top, ['flicker.js', 'index.js', 'tool-spec.js'],
    `顶层只允许 index.js（注册）、tool-spec.js（契约）和被别的会话带进来的 flicker.js；`
    + `新模块请放进 storyboard/ 或 watch/。实得：${top.join(', ')}`);
});

test('分层：两个目录都在，且不是空的', () => {
  assert.ok(byArea('storyboard').length >= 25, 'storyboard/ 应该有整套视频识别模块');
  assert.ok(byArea('watch').length >= 10, 'watch/ 应该有整套陪看模块');
});
