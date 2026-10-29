/**
 * tts.test.mjs — 脚本念台词。
 *
 * 这一层的意义：台词早就写好了，让模型"等到点再输出一遍"是浪费。
 * 交给系统 TTS 之后，时间点和说话都不花 token，模型只管看画面和想说什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PREFERRED_VOICES, buildSpeakCommand, psLiteral, speak } from '../src/tts.js';

test('单引号字面量：引号要写两遍，其他字符都是字面量', () => {
  assert.equal(psLiteral("他不'小心'"), "'他不''小心'''", '输入本身以引号结尾，所以结尾是三个引号');
  assert.equal(psLiteral('a$b`c\n"d"'), "'a$b`c\n\"d\"'", '美元符号/反引号/双引号在单引号里无需转义');
});

test('命令里包含速率、音量和要念的内容', () => {
  const cmd = buildSpeakCommand({ text: '这块料是师傅传的', voice: 'Huihui', rate: 2, volume: 80 });
  assert.match(cmd, /SAPI\.SpVoice/);
  assert.match(cmd, /\$v\.Rate = 2/);
  assert.match(cmd, /\$v\.Volume = 80/);
  assert.match(cmd, /Huihui/);
  assert.match(cmd, /这块料是师傅传的/);
});

test('速率被夹在 -10..10（SAPI 的合法范围）', () => {
  assert.match(buildSpeakCommand({ text: 'x', rate: 99 }), /\$v\.Rate = 10/);
  assert.match(buildSpeakCommand({ text: 'x', rate: -99 }), /\$v\.Rate = -10/);
});

test('dryRun 只生成命令，不真去发声（测试环境里不该出声）', async () => {
  const r = await speak('测试', { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.match(r.command, /Speak/);
});

test('默认声音是中文的（本机装的是 Huihui）', () => {
  assert.match(PREFERRED_VOICES[0], /Huihui/);
});
