/**
 * voice.test.mjs — 声音接口的契约：**核心只发事件，不发声**。
 *
 * 这一层的意义不是"能念出来"，而是"谁都可以不念"：
 * 没有订阅者时 `emitSpeech` 必须什么都不做（零引擎、零副作用），
 * 有订阅者时到点的台词必须原样交出去，而且**不能再叫醒模型**（否则同一句会被说两遍）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetSpeech, emitSpeech, lastSpeech, onSpeech, speechEvents, speechSubscribers,
} from '../src/voice.js';

test('没有订阅者：emitSpeech 是空操作（这是零依赖路径）', () => {
  __resetSpeech();
  assert.equal(speechSubscribers(), 0);
  assert.equal(emitSpeech({ at: 10, text: 'x' }), 0);
  assert.equal(lastSpeech(), null, '没人接就不该留下事件');
});

test('订阅后按顺序收到事件，退订后不再收', () => {
  __resetSpeech();
  const got = [];
  const off = onSpeech((e) => got.push(e));
  assert.equal(speechSubscribers(), 1);

  assert.equal(emitSpeech({ at: 12.5, text: '第一句' }), 1);
  assert.equal(emitSpeech({ at: 30, text: '第二句', input: 'a.mp4', segment: 0 }), 1);

  assert.equal(got.length, 2);
  assert.equal(got[0].at, 12.5);
  assert.equal(got[0].text, '第一句');
  assert.equal(got[0].state, 'due');
  assert.equal(got[0].seq, 1);
  assert.equal(got[1].seq, 2);
  assert.equal(got[1].input, 'a.mp4');

  assert.equal(off(), true);
  assert.equal(speechSubscribers(), 0);
  assert.equal(emitSpeech({ at: 40, text: '第三句' }), 0);
  assert.equal(got.length, 2);
});

test('一个订阅者抛错不影响其他人，也不打断陪看', () => {
  __resetSpeech();
  const ok = [];
  const offBad = onSpeech(() => { throw new Error('engine exploded'); });
  const offGood = onSpeech((e) => ok.push(e.text));
  // 返回值是"**成功**送达几个"，抛错的那个不算 —— 循环正是靠它判断"有没有人接"
  assert.equal(emitSpeech({ at: 1, text: '还在' }), 1, '坏的那个抛错，不该算送达');
  assert.deepEqual(ok, ['还在']);
  offBad();
  offGood();
});

test('事件是冻结的：订阅者改不动它，也就污染不了别人', () => {
  __resetSpeech();
  let seen = null;
  const off = onSpeech((e) => { seen = e; try { e.text = 'hacked'; } catch { /* strict mode */ } });
  emitSpeech({ at: 3, text: '原话' });
  assert.equal(seen.text, '原话');
  off();
});

test('speechEvents：把台词槽转成带 at 的事件，没写 at 的落在段首', () => {
  const out = speechEvents([
    { text: '有 at', at: 191 },
    { text: '没 at', at: null },
    { text: '   ', at: 5 },
    null,
  ], { fallbackAt: 180, segment: 180 });
  assert.equal(out.length, 2, '空文本不该产生事件');
  assert.deepEqual(out[0], { at: 191, text: '有 at', state: 'scheduled', segment: 180 });
  assert.equal(out[1].at, 180, '没写 at 的按段首算');
  assert.equal(out[1].state, 'scheduled');
});

test('speechEvents：输入不是数组时给空数组，不抛', () => {
  assert.deepEqual(speechEvents(null), []);
  assert.deepEqual(speechEvents(undefined, { fallbackAt: 0 }), []);
});

test('onSpeech 传非函数要立刻报错（否则问题会拖到很久以后）', () => {
  assert.throws(() => onSpeech(null), TypeError);
  assert.throws(() => onSpeech('speak'), TypeError);
});

test('__resetSpeech 清干净订阅者，用例之间不互相污染', () => {
  __resetSpeech();
  onSpeech(() => {});
  assert.equal(speechSubscribers(), 1);
  __resetSpeech();
  assert.equal(speechSubscribers(), 0);
  assert.equal(lastSpeech(), null);
});

/* ------------------------------------------------------------ 外部适配器 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attachConfiguredVoice, attachedAdapters, configuredVoiceAdapter, detachAdapters, loadVoiceAdapter,
} from '../src/voice.js';

test('configuredVoiceAdapter：环境变量优先，其次 ~/.dsh/voice.json，都没有就 null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-cfg-'));
  try {
    assert.equal(configuredVoiceAdapter({ DSH_HOME: home }), null, '没配就是 null，不是抛错');

    // DSH_HOME 本身就是配置目录（和其它配置一致，不再拼一层 .dsh）
    await writeFile(join(home, 'voice.json'), JSON.stringify({ adapter: 'D:/a.mjs' }), 'utf8');
    assert.equal(configuredVoiceAdapter({ DSH_HOME: home }), 'D:/a.mjs');

    // 环境变量压过文件
    assert.equal(
      configuredVoiceAdapter({ DSH_HOME: home, DSH_VOICE_ADAPTER: './b.mjs' }),
      './b.mjs',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadVoiceAdapter：挂上之后订阅者 +1，退订后 -1', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'voice-adapter-'));
  const file = join(dir, 'fixture.mjs');
  await writeFile(file, 'export function attach(api) { return api.onSpeech(() => {}); }\n', 'utf8');
  try {
    const r = await loadVoiceAdapter(file);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(speechSubscribers(), 1);
    assert.deepEqual(attachedAdapters(), [file]);

    // 重复挂载是幂等的（不会出现两份订阅）
    const again = await loadVoiceAdapter(file);
    assert.equal(again.cached, true);
    assert.equal(speechSubscribers(), 1);

    await detachAdapters();
    assert.equal(speechSubscribers(), 0);
    assert.deepEqual(attachedAdapters(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadVoiceAdapter：路径不存在 / 没导出 attach —— 返回原因，不抛', async () => {
  __resetSpeech();
  const bad = await loadVoiceAdapter(join(tmpdir(), 'definitely-not-here-12345.mjs'));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /import failed/);

  const dir = await mkdtemp(join(tmpdir(), 'voice-bad-'));
  const file = join(dir, 'no-attach.mjs');
  await writeFile(file, 'export const nope = 1;\n', 'utf8');
  try {
    const r = await loadVoiceAdapter(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /attach/);
    assert.equal(speechSubscribers(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('attach：适配器自己抛错也只是没声音，不算挂上', async () => {
  __resetSpeech();
  const dir = await mkdtemp(join(tmpdir(), 'voice-throw-'));
  const file = join(dir, 'boom.mjs');
  await writeFile(file, 'export function attach() { throw new Error("no engine"); }\n', 'utf8');
  try {
    const r = await loadVoiceAdapter(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /attach failed: no engine/);
    assert.deepEqual(attachedAdapters(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('attachConfiguredVoice：没配置时是 no-op（不会去 import 任何东西）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-none-'));
  try {
    const r = await attachConfiguredVoice({ env: { DSH_HOME: home } });
    assert.deepEqual(r, { ok: false, reason: 'not-configured' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

