import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { forgetSegments, formatMatches, matchSegments, recallSegments, rememberSegments } from '../src/storyboard/locate.js';

const segs = [
  { from: 0, to: 2, text: '所以你连他也要忘记吗' },
  { from: 2, to: 4, text: '记忆管理局的人来了' },
  { from: 84.75, to: 86.2, text: '记忆管理局' },
];

test('matchSegments: 完全包含的排最前，并带时间码', () => {
  const m = matchSegments(segs, '记忆管理局');
  assert.equal(m.length, 2, '第一句没有这几个字，不该命中');
  assert.equal(m[0].from, 84.75, '短句完全匹配应该排第一');
  assert.ok(m[0].text.length <= m[1].text.length, '同分时短句在前');
});

test('matchSegments: 标点与空格不影响匹配', () => {
  const m = matchSegments(segs, '记忆管理局。');
  assert.ok(m.length >= 1);
  assert.equal(m[0].from, 84.75);
});

test('matchSegments: 完全不沾边的查询返回空', () => {
  assert.deepEqual(matchSegments(segs, '如何在三天内学会画画'), []);
});

test('matchSegments: max 生效', () => {
  assert.equal(matchSegments(segs, '记', { max: 1 }).length, 1);
});

test('formatMatches: 没有命中时说清下一步，而不是假装知道', () => {
  const text = formatMatches('不存在的台词', [], { total: 3 });
  assert.match(text, /no line matched/);
  assert.match(text, /shorter keywords/);
});

test('rememberSegments: 同路径覆盖、可跨调用复用', () => {
  forgetSegments();
  rememberSegments('/v/a.mp4', segs);
  assert.equal(recallSegments('/v/a.mp4').length, 3);
  rememberSegments('/v/a.mp4', [segs[0]]);
  assert.equal(recallSegments('/v/a.mp4').length, 1);
  assert.equal(recallSegments('/v/b.mp4'), null);
});

/**
 * #94 的全部内容：`rememberSegments` 定义得好好的，**pipeline 一次都没调用**。
 *
 * 所以上面那条往返测试一直是绿的，而 `video_locate` 每次都在报
 * "no transcript available"。这里守的是**调用点存在**，不是缓存本身 ——
 * 写缓存的地方必须在 `runStoryboard()` 里（跑 `tools/locate.js` 那条补跑路径时，
 * 跑完要靠它把结果塞回缓存），参数写成 `rememberSegments(input, …)`。
 */
test('pipeline 真的把转写写进 locate 的缓存（#94）', () => {
  const src = readFileSync(new URL('../src/storyboard/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /rememberSegments\(\s*input\s*,/,
    'pipeline.js 必须在转写确定之后写缓存，否则 video_locate 永远拿不到台词');
});
