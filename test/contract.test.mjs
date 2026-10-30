/**
 * contract.test.mjs — 用**宿主真实的** defineTool / validateArgs 校验工具定义。
 *
 * 为什么要这一步：单测里的桩件永远可能"复刻错"。而 schema 用了宿主不认的
 * 关键字时，不是"工具不好用"，而是 `ctx.tools.register()` 在 apply() 期间抛错
 * —— 整棵插件树连带应用一起起不来（dsh-video-lens 0.3.1 就这么崩过）。
 *
 * 找不到宿主包时自动 skip（CI 里没有本地 DSH 安装是正常的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  probeToolSpec, storyboardToolSpec, validateToolArgs, validateWatchArgs, validateZoomArgs,
  watchToolSpec, zoomToolSpec,
} from '../src/tool-spec.js';

const HOST_TOOLS = join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const CANDIDATES = [
  process.env.DSH_TOOLS_PATH,
  HOST_TOOLS,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter(Boolean);

let host;
let hostPath;
for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue;
  try {
    host = await import(pathToFileURL(candidate).href);
    hostPath = candidate;
    break;
  } catch {
    /* 换个候选 */
  }
}

test('contract: 宿主 defineTool 接受本工具的 schema', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  t.diagnostic(`host: ${hostPath}`);

  const spec = storyboardToolSpec();
  const tool = host.defineTool({ ...spec, execute: async () => ({ images: [], text: '' }) });

  assert.equal(tool.name, 'video_storyboard');
  assert.equal(tool.description.length > 100, true, 'description 应给模型足够上下文');
  assert.ok(tool.parameters?.properties?.input, '编译后的 JSON Schema 必须有 input 属性');
  assert.equal(tool.parameters.properties.input.type, 'string');
  assert.deepEqual(tool.parameters.required, ['input']);
  assert.ok(tool.output?.schema, '输出 schema 必须存在');
});

test('contract: 宿主 validateArgs 认这份参数（合法通过、缺参报错）', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  const spec = storyboardToolSpec();

  assert.deepEqual(host.validateArgs(spec.parameters, { input: 'D:/a.mp4' }), []);
  assert.deepEqual(
    host.validateArgs(spec.parameters, { input: 'D:/a.mp4', from: 10, to: 20, cells: 9 }),
    [],
  );
  assert.ok(host.validateArgs(spec.parameters, {}).length > 0, '缺 input 应报错');
  assert.ok(host.validateArgs(spec.parameters, { input: 123 }).length > 0, '类型错应报错');
  assert.ok(
    host.validateArgs(spec.parameters, { input: 'a', pick: 'blurry' }).length > 0,
    'enum 外的值应报错',
  );
});

test('contract: 渲染产出 image + text 两种内容块', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  const spec = storyboardToolSpec();
  const blocks = spec.output.render({ input: 'x' }, { images: [{ attachmentId: 'a' }], text: 'hi' });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].text, 'hi');
});

test('contract: video_zoom 的 schema 同样过宿主 defineTool', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  const spec = zoomToolSpec();
  const tool = host.defineTool({ ...spec, execute: async () => ({ images: [], text: '' }) });
  assert.equal(tool.name, 'video_zoom');
  assert.deepEqual(tool.parameters.required.sort(), ['from', 'input', 'to']);
  assert.deepEqual(host.validateArgs(spec.parameters, { input: 'a.mp4', from: 10, to: 20 }), []);
  assert.ok(host.validateArgs(spec.parameters, { input: 'a.mp4' }).length > 0, '缺 from/to 应报错');
  // 宿主 schema 没有数值上限，cells:20 会被放行 —— 这正是本地校验必须存在的理由
  assert.deepEqual(host.validateArgs(spec.parameters, { input: 'a', from: 1, to: 2, cells: 20 }), []);
  assert.ok(validateZoomArgs({ input: 'a', from: 1, to: 2, cells: 20 }).length > 0, '本地必须挡住');
});

test('contract: video_probe 的 schema 同样过宿主 defineTool', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  const spec = probeToolSpec();
  const tool = host.defineTool({ ...spec, execute: async () => ({ text: '' }) });
  assert.equal(tool.name, 'video_probe');
  assert.deepEqual(tool.parameters.required, ['input']);
  assert.deepEqual(host.validateArgs(spec.parameters, { input: 'a.mp4' }), []);
  assert.ok(host.validateArgs(spec.parameters, {}).length > 0);
  // 只返回文本，不该有 image 块
  const blocks = spec.output.render({ input: 'a' }, { text: 'hi' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
});

test('contract: video_watch schema exposes the documented browserPort', async (t) => {
  if (!host) return t.skip('host @deepseek-ai/dsh-tools not found');
  const spec = watchToolSpec();
  const tool = host.defineTool({ ...spec, execute: async () => ({ images: [], text: '' }) });
  assert.equal(tool.name, 'video_watch');
  assert.equal(spec.parameters.browserPort.type, 'integer');
  assert.deepEqual(host.validateArgs(spec.parameters, { browserPort: 9333, statusOnly: true }), []);
  assert.deepEqual(validateWatchArgs({ browserPort: 9333, statusOnly: true }), []);
  assert.ok(validateWatchArgs({ browserPort: 0 }).length > 0);
  assert.ok(validateWatchArgs({ browserPort: 1.5 }).length > 0);
  assert.ok(validateWatchArgs({ browserPort: 65536 }).length > 0);
});

test('本地兜底校验：越界参数被自己挡住（schema 子集不支持 min/max）', () => {
  assert.deepEqual(validateToolArgs({ input: 'a.mp4' }), []);
  assert.ok(validateToolArgs({}).length > 0);
  assert.ok(validateToolArgs({ input: 'a', cells: 20 }).length > 0);
  assert.ok(validateToolArgs({ input: 'a', sheets: 0 }).length > 0);
  assert.ok(validateToolArgs({ input: 'a', from: 10, to: 5 }).length > 0);
  assert.ok(validateToolArgs({ input: 'a', minGap: -1 }).length > 0);
});

test('本地兜底校验：zoom 要求 from/to 且区间有效', () => {
  assert.deepEqual(validateZoomArgs({ input: 'a', from: 0, to: 5 }), []);
  assert.ok(validateZoomArgs({ input: 'a' }).length > 0);
  assert.ok(validateZoomArgs({ input: 'a', from: 5, to: 5 }).length > 0);
  assert.ok(validateZoomArgs({ input: 'a', from: -1, to: 5 }).length > 0);
  assert.ok(validateZoomArgs({ input: 'a', from: 0, to: 5, cells: 12 }).length > 0);
});
