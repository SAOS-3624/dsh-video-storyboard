/**
 * ocr.test.mjs — 硬字幕校正的判定规则。
 *
 * 这些断言来自实测：ASR 出「他也忘记。」，画面字幕是「你连，也要忘记吗」。
 * 规则必须**接受**这一条，同时**拒绝**幻灯片文字、低置信度、长度差太多的那些。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  OCR_BRIDGE, OCR_MAX_ITEMS, detectSubtitleBand, ocrPython, readBand, shouldReplace, similarity,
} from '../src/storyboard/ocr.js';

test('similarity: 忽略标点，按字符算', () => {
  assert.equal(similarity('你好，世界', '你好世界'), 1);
  assert.ok(similarity('他也忘记', '你连也要忘记吗') > 0.3);
  assert.equal(similarity('', 'abc'), 0);
});

test('shouldReplace: 接受"ASR 漏字、OCR 完整"的那一类', () => {
  const v = shouldReplace({ asr: '他也忘记。', ocr: '你连，也要忘记吗', conf: 0.72 });
  assert.equal(v.replace, true, JSON.stringify(v));
  assert.ok(v.cover >= 0.6);
});

test('shouldReplace: 字幕带上夹着上一句时，只取对得上的那一块', () => {
  const v = shouldReplace({ asr: '他也忘记。', ocr: '你连，也要忘记吗所以', conf: 0.72 });
  assert.equal(v.replace, true);
  assert.match(v.text, /也要忘记/);
  assert.doesNotMatch(v.text, /所以/, '不该把下一句的尾巴带进来');
});

test('shouldReplace: 幻灯片/UI 文字不认', () => {
  const v = shouldReplace({ asr: '这个插件会先把整段视频扫一遍', ocr: '第二步拼接图板', conf: 0.8 });
  assert.equal(v.replace, false);
  assert.equal(v.reason, 'unrelated');
});

test('shouldReplace: 低置信度不认（宁可留 ASR 的已知错字）', () => {
  assert.equal(shouldReplace({ asr: '他也忘记', ocr: '也要忘记吗', conf: 0.4 }).reason, 'low-conf');
});

test('shouldReplace: 两边本来就一致就不动', () => {
  assert.equal(shouldReplace({ asr: '他说我们要走了', ocr: '他说我们要走了', conf: 0.9 }).reason, 'agree');
});

test('shouldReplace: 空 OCR 不动', () => {
  assert.equal(shouldReplace({ asr: '随便一句', ocr: '', conf: 0.9 }).reason, 'empty-ocr');
});

test('预算与解释器发现是显式常量，不靠猜', async () => {
  assert.ok(OCR_MAX_ITEMS > 0 && OCR_MAX_ITEMS <= 32);
  // 现在是异步的：要真去试 `import rapidocr_onnxruntime`，不能靠路径猜
  const py = await ocrPython({ env: {} });
  assert.ok(py === null || typeof py === 'string', `unexpected: ${JSON.stringify(py)}`);
});

/**
 * #39 的护栏：桥接脚本的路径少上溯一层时，从装上到现在每一次调用都是 ENOENT，
 * 而调用方把它报成 `detect-failed`，谁也看不出来。这条断言让那种回归当场变红。
 */
test('ocr_bridge.py 的路径是真的存在的（#39 的回归护栏）', () => {
  assert.ok(existsSync(OCR_BRIDGE), `ocr_bridge.py not found: ${OCR_BRIDGE}`);
  assert.match(OCR_BRIDGE.replace(/\\/g, '/'), /\/src\/ocr_bridge\.py$/,
    '桥接脚本必须在 src/ 下，不是 src/storyboard/ 下');
});

test('失败必须说出原因，不能一律 null（#39）', async () => {
  const noPy = await detectSubtitleBand({ python: null, frames: ['x.jpg'] });
  assert.deepEqual(noPy.ok, false);
  assert.equal(noPy.kind, 'no-python');

  const noFrames = await detectSubtitleBand({ python: 'python', frames: [] });
  assert.equal(noFrames.kind, 'no-frames');

  const noItems = await readBand({ python: null, images: ['x.jpg'] });
  assert.equal(noItems.kind, 'no-python');
});

test('解释器不存在 → interpreter-missing，而不是"检测失败"', async () => {
  const r = await detectSubtitleBand({
    python: 'definitely-not-a-python-interpreter-xyz', frames: ['x.jpg'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'interpreter-missing', JSON.stringify(r));
  assert.ok(r.message, '要带上原因');
});
