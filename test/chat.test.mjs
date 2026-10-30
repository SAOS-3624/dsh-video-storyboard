/**
 * chat.test.mjs — 聊天框是**一条统一的文本流**：剧本台词、模型插话、用户自己说的话
 * 都写进同一个 jsonl，按顺序显示在同一个框里；`say: true` 的那几条才是"要念出来的"。
 *
 * 这一层最容易出的错是**重复**：台词既通过 `emitSpeech` 走了一遍，又被插话那条路写了一遍，
 * 框里就会出现同一句两遍。所以下面的用例把"谁写、谁不写"钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendAssistantSay, appendChat, attachSpeechToChat, chatFile, makeChatWatcher, readChat,
} from '../src/chat.js';
import { __resetSpeech, emitSpeech, onSpeech, speechObservers, speechSubscribers } from '../src/voice.js';

async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-test-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    return await fn(env, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('台词到点会写进流；scheduled 不写（那是清单，不是"现在说"）', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const off = attachSpeechToChat({ env });
    emitSpeech({ at: 191.4, text: '剧本台词', state: 'due' });
    emitSpeech({ at: 200, text: '只是清单', state: 'scheduled' });
    off();

    const rows = readChat(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'line');
    assert.equal(rows[0].text, '剧本台词');
    assert.equal(rows[0].t, 191.4, '`t` 是播放位置秒');
    assert.equal(rows[0].say, true, '台词要念');
    assert.ok(Number.isFinite(rows[0].at), '`at` 是墙钟毫秒，用来排序');
  });
});

test('插话那句只写一次：role=assistant，不会又被当成台词写一遍', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const off = attachSpeechToChat({ env });
    appendAssistantSay('你看这条鱼', { t: 193, env });
    off();

    const rows = readChat(env);
    assert.equal(rows.length, 1, `应该只有一条，实得 ${rows.length}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].role, 'assistant');
    assert.equal(rows[0].say, true);
  });
});

test('聊天框只是"看"：它不算"有人会念"，不该让循环停止叫醒模型', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const off = attachSpeechToChat({ env });
    assert.equal(speechObservers(), 1, '确实挂上了一个');
    assert.equal(speechSubscribers(), 0, '但它不出声');
    off();
    assert.equal(speechObservers(), 0);
  });
});

test('用户消息不带 say（不该被念出来）', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    appendChat('user', '我自己说的', {}, env);
    const rows = readChat(env);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].say, undefined);
    assert.equal(rows[0].t, undefined);
  });
});

test('插话会广播一条 due 事件（声音那一侧仍然收得到）', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const heard = [];
    const off = onSpeech((e) => heard.push(e));
    appendAssistantSay('说一句', { t: 12, env });
    off();
    assert.equal(heard.length, 1);
    assert.equal(heard[0].text, '说一句');
    assert.equal(heard[0].origin, 'chat', '带 origin 才算"已经写进流了"');
  });
});

test('统一流：三种角色按写入顺序排在一起', async () => {
  __resetSpeech();
  await withCache(async (env, dir) => {
    const off = attachSpeechToChat({ env });
    emitSpeech({ at: 10, text: '剧本一', state: 'due' });
    appendAssistantSay('插话一', { t: 11, env });
    appendChat('user', '用户一', {}, env);
    emitSpeech({ at: 20, text: '剧本二', state: 'due' });
    off();

    const roles = readChat(env).map((r) => r.role);
    assert.deepEqual(roles, ['line', 'assistant', 'user', 'line']);

    // 落到盘上的就是这几行，没有别的
    const raw = (await readFile(chatFile(env), 'utf8')).trim().split('\n');
    assert.equal(raw.length, 4);
  });
});

test('插话通道不受影响：makeChatWatcher 只认 role=user', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const poll = makeChatWatcher(env);          // 基线：现在是 0 条
    const off = attachSpeechToChat({ env });
    emitSpeech({ at: 10, text: '剧本不该被当成插话', state: 'due' });
    appendAssistantSay('插话也不该', { t: 11, env });
    off();
    assert.equal(poll(), null, '只有台词和插话时，不该报"用户说话了"');

    appendChat('user', '这才是我说的', {}, env);
    const hit = poll();
    assert.equal(hit?.text, '这才是我说的');
  });
});

test('空的插话不写、不广播', async () => {
  __resetSpeech();
  await withCache(async (env) => {
    const heard = [];
    const off = onSpeech((e) => heard.push(e));
    assert.equal(appendAssistantSay('   ', { env }), null);
    off();
    assert.equal(readChat(env).length, 0);
    assert.equal(heard.length, 0);
  });
});

