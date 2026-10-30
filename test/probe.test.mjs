import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayAspect, endEdge, normalizeRotation, parseRational, parseSar, uprightSize,
} from '../src/storyboard/probe.js';

test('parseRational: 常见帧率字符串', () => {
  assert.equal(parseRational('25/1'), 25);
  assert.ok(Math.abs(parseRational('30000/1001') - 29.97) < 0.01);
  assert.equal(parseRational('60'), 60);
  assert.equal(parseRational('0/1'), null);
  assert.equal(parseRational(''), null);
  assert.equal(parseRational(undefined), null);
});

test('normalizeRotation: 归一化到 (-180, 180]', () => {
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), -90);
  assert.equal(normalizeRotation(270), -90);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(-180), 180);
  assert.equal(normalizeRotation(undefined), 0);
});

test('uprightSize: 旋转 90/270 时交换宽高', () => {
  assert.deepEqual(uprightSize(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(uprightSize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, -90), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, 180), { width: 1920, height: 1080 });
});

test('endEdge: 帧率越高避让越小，且永远大于 0', () => {
  assert.ok(endEdge(25) > 0 && endEdge(25) < 0.05);
  assert.ok(endEdge(60) < endEdge(25));
  assert.ok(endEdge(0) > 0, 'fps 缺失时也要有兜底');
});

/* ---------------------------------------------------------------- 像素宽高比 */

test('displayAspect: 方像素时等于编码比例', () => {
  assert.ok(Math.abs(displayAspect(1920, 1080, 1) - 16 / 9) < 1e-9);
});

test('displayAspect: 非方像素按 SAR 折算（1440×1080 + 4:3 = 16:9 显示）', () => {
  assert.ok(Math.abs(displayAspect(1440, 1080, 4 / 3) - 16 / 9) < 1e-3);
});

test('displayAspect: 转 90° 后取倒数（竖拍不该被当成横的）', () => {
  assert.ok(Math.abs(displayAspect(1920, 1080, 1, 90) - 9 / 16) < 1e-9);
  assert.ok(Math.abs(displayAspect(1920, 1080, 1, 270) - 9 / 16) < 1e-9);
});

test('parseSar: 0:1 与缺失都按方像素处理', () => {
  assert.equal(parseSar('0:1'), 1);
  assert.equal(parseSar(undefined), 1);
  assert.equal(parseSar('4:3'), 4 / 3);
});
