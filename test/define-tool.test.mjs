/**
 * define-tool.test.mjs — 内置 `defineTool` 兜底（storyboard 版）。
 *
 * 宿主的 `@deepseek-ai/dsh-tools` 在 `app.asar` 里，插件常常 import 不到（社区实报）。
 * 兜底版转错 schema 的表现是"参数被宿主吞掉"，不报错 —— 所以这里既要测转换规则，
 * 也要**真跑一遍六个工具的定义**，确认它们都能编译出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineToolCompat } from '../src/define-tool.js';
import { storyboardTools } from '../src/storyboard/register.js';

test('type:"json" 退化成注解，不产生 type:"json"', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: {},
    output: { schema: { type: 'object', properties: { meta: { type: 'json', description: '任意' } } }, render: () => '' },
    execute: () => ({}),
  });
  assert.equal(JSON.stringify(tool.output.schema).includes('"json"'), false);
  assert.equal(tool.output.schema.properties.meta.description, '任意');
});

test('required:true 提升到父级 required，并从属性里删掉', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: { a: { type: 'string', required: true }, b: { type: 'string' } },
    output: { schema: {}, render: () => '' }, execute: () => ({}),
  });
  assert.deepEqual(tool.parameters.required, ['a']);
  assert.equal(tool.parameters.properties.a.required, undefined);
});

test('没写 required:true 的参数一律可选', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: { a: { type: 'string' }, b: { type: 'number' } },
    output: { schema: {}, render: () => '' }, execute: () => ({}),
  });
  assert.equal(tool.parameters.required, undefined);
});

test('缺 output.render / execute 要立刻抛', () => {
  assert.throws(() => defineToolCompat({ name: 't', description: 'd', parameters: {}, output: {}, execute: () => ({}) }), /output\.render/);
  assert.throws(() => defineToolCompat({ name: 't', description: 'd', parameters: {}, output: { render: () => '' } }), /execute/);
});

test('execute 原样转发', async () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: {},
    output: { schema: {}, render: () => '' }, execute: async (args) => ({ got: args }),
  });
  assert.deepEqual(await tool.execute({ x: 1 }, {}), { got: { x: 1 } });
});

test('兜底 defineTool 下，全部工具都能编译出来（社区那个"装完没工具"的复现点）', () => {
  const tools = storyboardTools(defineToolCompat, {});
  assert.ok(tools.length >= 5, `至少 5 个工具，实际 ${tools.length}`);
  for (const t of tools) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0);
    assert.equal(t.parameters.type, 'object', `${t.name} 的 parameters 必须是 object`);
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 render`);
    assert.equal(typeof t.output.schema, 'object', `${t.name} 缺 output.schema`);
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
  }
});
