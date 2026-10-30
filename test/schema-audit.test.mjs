/**
 * schema-audit.test.mjs — **宿主按 schema 过滤参数**：handler 读了、schema 没声明的参数，
 * 永远到不了 handler，而且**不报错、不告警**，只是安静地退回默认值。
 *
 * 这一类 bug 在这个仓库反复出现：zoom 的 `transcriptFile`/`detail`、watch 的 `browserPort`、
 * locate 的 `cookies`/`allowAnonymous` —— 四个独立 PR 修的是同一件事。
 * 靠人眼对两张表是挡不住的，所以这里做静态审计：
 *
 *   1. 扫每个工具 handler 模块里的 `args.X` → "它到底读哪些参数"；
 *   2. 断言这些名字都在该工具的 `parameters` 里（否则宿主会吞掉）；
 *   3. 断言 schema 里没有重复键（对象字面量的重复 key，后一个会静默覆盖前一个）；
 *   4. 断言 `dsh.plugin.json` 的版本和 `package.json` 一致。
 *
 * 不需要宿主、不需要网络，纯文本审计 —— 所以它在 CI 里一定跑得起来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  locateToolSpec, probeToolSpec, storyboardToolSpec, zoomToolSpec,
} from '../src/tool-spec.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// 读进来先归一换行：这个测试做的是**文本切分**，CRLF 会让所有 `\n` 匹配失效
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = (name) => read(join(ROOT, 'src', name));

/**
 * 每个工具的 handler 由哪些模块组成。
 *
 * **必须精确到工具**：一个模块里塞两个 handler，扫出来的就是并集，
 * 审计立刻失效。`storyboard/board.js` 是 storyboard / zoom 共用的参数归一化层，所以两边都算。
 *
 * 路径相对 `src/`；`src/storyboard/` 的划分见 README 的模块表。
 * 陪看的 handler 不在这里 —— 它随 `dsh-watch-together` 走了，那边有同样的审计。
 */
const HANDLER_MODULES = {
  video_storyboard: ['tools/storyboard.js', 'tools/shared.js', 'storyboard/board.js'],
  video_zoom: ['tools/zoom.js', 'tools/shared.js', 'storyboard/board.js'],
  video_probe: ['tools/probe.js'],
  video_locate: ['tools/locate.js'],
};

/**
 * `board.js` 按 kind 分支读参数，静态扫描分不出分支，于是会给另一侧带上几个名字。
 * 这里逐个说明**为什么这个工具确实不需要它** —— 加新条目必须给出理由，
 * 否则就把这条审计变成了走过场。
 */
const SHARED_NOISE = {
  video_storyboard: [
    'zoomHeight', // fetchOptionsFor 里只有 kind === 'zoom' 才读
  ],
  video_zoom: [
    'sheets', 'hotwords', 'textOnly', 'planThresholds', 'adaptive', // boardOptions 的 kind==='board' 分支
  ],
};

/** 扫一个模块里所有 `args.X` / `args?.X` —— 这就是 handler 真正会读的参数名 */
function readArgNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bargs\??\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

const SPECS = {
  video_storyboard: storyboardToolSpec,
  video_zoom: zoomToolSpec,
  video_probe: probeToolSpec,
  video_locate: locateToolSpec,
};

test('schema 审计：每个工具 handler 读的 args 都在它的 schema 里', () => {
  const problems = [];
  for (const [tool, modules] of Object.entries(HANDLER_MODULES)) {
    const declared = new Set(Object.keys(SPECS[tool]().parameters ?? {}));
    const read = new Set();
    for (const mod of modules) {
      for (const name of readArgNames(src(mod))) {
        if (declared.has(name)) continue;
        if ((SHARED_NOISE[tool] ?? []).includes(name)) continue;
        read.add(name);
      }
    }
    if (read.size > 0) {
      problems.push(`${tool}: handler 读了但 schema 没声明 [${[...read].sort().join(', ')}] `
        + `（宿主会静默丢掉它们，见 ${modules.join(' / ')}）`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('schema 审计：parameters 里没有重复键（后者会静默覆盖前者）', () => {
  // 从 `parameters:` 到 `output:` 之间的 `^      name: ` 就是参数表的直接子键
  const regions = {
    video_storyboard: storyboardToolSpec, video_zoom: zoomToolSpec, video_probe: probeToolSpec,
    video_locate: locateToolSpec,
  };
  // 每个工具读它那个 spec 文件；切片口径对不上时会切到空字符串，所以下面断言 keys 非空。
  const FILES = {
    video_storyboard: 'src/storyboard/tool-spec.js', video_zoom: 'src/storyboard/tool-spec.js',
    video_probe: 'src/storyboard/tool-spec.js', video_locate: 'src/storyboard/tool-spec.js',
  };
  const problems = [];
  for (const tool of Object.keys(regions)) {
    // 每个 spec 函数体单独切：一个文件里几个函数，不能整体扫
    const all = read(join(ROOT, FILES[tool]));
    const fn = all.slice(all.indexOf(`export function ${regions[tool].name}(`) === -1
      ? 0 : all.indexOf(`export function ${regions[tool].name}(`));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    const from = body.indexOf('parameters: {');
    const to = body.indexOf('\n    output: {');
    assert.ok(from > 0 && to > from, `${tool}: 找不到 parameters → output 区间`);
    const keys = [...body.slice(from, to).matchAll(/\n {6}([A-Za-z_$][\w$]*): /g)].map((m) => m[1]);
    assert.ok(keys.length > 0, `${tool}: parameters 一个键都没切到 —— 切片口径已经和代码对不上了`);
    const seen = new Set();
    for (const k of keys) {
      if (seen.has(k)) problems.push(`${tool}: 参数 ${k} 定义了两次`);
      seen.add(k);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('schema 审计：dsh.plugin.json 的版本和 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version,
    'dsh.plugin.json 的 version 落后会让人装到"看起来是旧版"的插件');
});

test('schema 审计：四个工具的 name 和注册入口的一致', () => {
  // storyboard 的注册在 storyboard/register.js，index.js 只做编排 —— 所以看那个文件。
  const sb = src('storyboard/register.js');
  for (const [tool, makeSpec] of Object.entries(SPECS)) {
    assert.equal(makeSpec().name, tool);
    assert.ok(sb.includes('ToolSpec()'),
      `${tool} 的注册应该在自己的 register.js 里（用 ...xxxToolSpec() 展开）`);
  }
});

