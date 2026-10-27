import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  BACKGROUND, BADGE_FG, DIGITS, DIGIT_H, DIGIT_W, PAD_FILL,
  badgeScale, composeSheet, drawBadge, drawGlyphs, encodeRaw, extractFrameRaw,
  extractSharpest, fillRect, formatBadgeTime, layoutCanvas, sharpness,
  sharpSearchWindow, thinCutTicks,
} from '../src/sheet.js';
import { DEFAULT_FFMPEG, probeVideo } from '../src/probe.js';

const run = promisify(execFile);
const px = (buf, width, x, y) => {
  const i = (y * width + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
};
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/* ---------------------------------------------------------------- 字形 */

test('DIGITS: 0-9 齐全，且每个都是 7×5 的点阵', () => {
  assert.equal(Object.keys(DIGITS).length, 10);
  for (const [d, rows] of Object.entries(DIGITS)) {
    assert.equal(rows.length, DIGIT_H, `${d} 行数`);
    for (const row of rows) assert.equal(row.length, DIGIT_W, `${d} 列数`);
    assert.ok(rows.join('').includes('1'), `${d} 是空字形`);
  }
});

test('badgeScale: 随格高增长，且至少 2 倍（否则数字会碎）', () => {
  assert.ok(badgeScale(50) >= 2);
  assert.ok(badgeScale(194) > badgeScale(120));
  assert.equal(badgeScale(0), 2);
});

test('badgeScale: 两位编号会被格宽限制，避免吃掉 1/3 画面', () => {
  const one = badgeScale(145, 261, 1);
  const two = badgeScale(145, 261, 2);
  assert.ok(two <= one, '两位编号不应比一位更大');
  const badgeW = 2 * (DIGIT_W + 1) * two;
  assert.ok(badgeW <= 261 * 0.4, `两位编号宽度 ${badgeW} 超过格宽 40%`);
  // 一位编号在 350 宽的格子里仍按格高走（默认 15%）
  assert.equal(badgeScale(194, 350, 1), Math.floor((194 * 0.15) / DIGIT_H));
  // 缩小比例后更小，但仍有下限 2 倍
  assert.ok(badgeScale(194, 350, 1, 0.11) < badgeScale(194, 350, 1, 0.22));
  assert.equal(badgeScale(20, 40, 1, 0.05), 2);
});

test('drawGlyphs: 画出非零像素，且 "-" 是横条', () => {
  const w = 60;
  const h = 30;
  const buf = Buffer.alloc(w * h * 3);
  const size = drawGlyphs(buf, w, h, '7', 1, 1, 3, [255, 255, 255]);
  assert.ok(size.width > 0 && size.height === DIGIT_H * 3);
  assert.ok(buf.some((v) => v > 0), '应有白色像素');

  const bar = Buffer.alloc(w * h * 3);
  drawGlyphs(bar, w, h, '-', 1, 1, 3, [255, 255, 255]);
  const lit = [];
  for (let y = 0; y < h; y++) if (px(bar, w, 4, y).some((v) => v > 0)) lit.push(y);
  assert.ok(lit.length <= 4, `横杠应只有 1~3 行高，实得 ${lit.length}`);
});

/* ---------------------------------------------------------------- 画布 */

test('layoutCanvas: 总像素不超预算，格比例偏差 <3%（由 cover 裁切吸收）', () => {
  for (const [cols, rows] of [[1, 1], [2, 2], [3, 3], [3, 4], [4, 4]]) {
    const { width, height, cellW, cellH } = layoutCanvas(cols, rows, 16 / 9);
    assert.ok(width * height <= 640_000, `${cols}x${rows} 超预算：${width * height}`);
    assert.ok(width * height > 560_000, `${cols}x${rows} 浪费太多：${width * height}`);
    // 整数取整带来的比例误差由 cover 裁切吸收，肉眼不可见
    assert.ok(Math.abs(cellW / cellH - 16 / 9) < 0.03, `${cols}x${rows} 格比例 ${cellW}x${cellH}`);
  }
});

test('fillRect: 不透明直接覆盖，半透明按 alpha 混合，越界自动裁剪', () => {
  const w = 4;
  const h = 1;
  const buf = Buffer.alloc(w * h * 3, 100);
  fillRect(buf, w, h, 0, 0, 2, 1, [0, 0, 0]);
  assert.deepEqual(px(buf, w, 0, 0), [0, 0, 0]);
  assert.deepEqual(px(buf, w, 2, 0), [100, 100, 100]);

  fillRect(buf, w, h, 2, 0, 10, 1, [0, 0, 0], 0.5);
  assert.ok(Math.abs(px(buf, w, 2, 0)[0] - 50) <= 1);
  assert.doesNotThrow(() => fillRect(buf, w, h, -5, -5, 3, 3, [1, 2, 3]));
});

test('drawBadge: 左上角出现深色底 + 黄色字形', () => {
  const w = 120;
  const h = 80;
  const buf = Buffer.alloc(w * h * 3, 200);
  drawBadge(buf, w, h, 2, 2, w, h, 3);
  const corner = px(buf, w, w - 2, h - 2);
  assert.ok(near(corner, [200, 200, 200]), '右下角不该被污染');
  let yellow = 0;
  let dark = 0;
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      const [r, g, b] = px(buf, w, x, y);
      if (r > 200 && g > 180 && b < 120) yellow++;
      if (r < 120 && g < 120 && b < 120) dark++;
    }
  }
  assert.ok(yellow > 10, `应有黄色字形像素，实得 ${yellow}`);
  assert.ok(dark > 100, `应有黑底像素，实得 ${dark}`);
});

test('formatBadgeTime: m:ss 整数秒', () => {
  assert.equal(formatBadgeTime(0), '0:00');
  assert.equal(formatBadgeTime(77.2), '1:17');
  assert.equal(formatBadgeTime(3661), '61:01');
});

test('drawGlyphs: 冒号是上下两点', () => {
  const w = 40;
  const h = 30;
  const buf = Buffer.alloc(w * h * 3);
  drawGlyphs(buf, w, h, ':', 2, 2, 3, [255, 255, 255]);
  const lit = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px(buf, w, x, y).some((v) => v > 0)) lit.push(y);
    }
  }
  const uniq = [...new Set(lit)].sort((a, b) => a - b);
  assert.ok(uniq.length >= 2, `冒号应至少两行有像素，实得 ${uniq}`);
  assert.ok(uniq.at(-1) - uniq[0] >= 3, '上下两点应有间距');
});

test('composeSheet: burn=index+time 比 index 多一行徽标', () => {
  const { cellW, cellH } = layoutCanvas(1, 1, 16 / 9, 80_000);
  const solid = Buffer.alloc(cellW * cellH * 3, 180);
  const frames = [{ buffer: solid, index: 1, t: 77.2 }];
  const only = composeSheet({
    frames, cols: 1, rows: 1, cellAspect: 16 / 9, budget: 80_000, burn: 'index',
  });
  const both = composeSheet({
    frames, cols: 1, rows: 1, cellAspect: 16 / 9, budget: 80_000, burn: 'index+time',
  });
  const countDark = (buf, width) => {
    let n = 0;
    for (let y = 0; y < Math.min(80, Math.floor(width / 4)); y++) {
      for (let x = 0; x < Math.min(120, Math.floor(width / 3)); x++) {
        const [r, g, b] = px(buf, width, x, y);
        if (r < 40 && g < 40 && b < 40) n++;
      }
    }
    return n;
  };
  assert.ok(
    countDark(both.buffer, both.width) > countDark(only.buffer, only.width) * 1.3,
    '带时间码的徽标底应明显更高',
  );
});

/* ---------------------------------------------------------------- 锐度 */

const solidBuf = (w, h, v) => Buffer.alloc(w * h * 3, v);
function checkerBuf(w, h, cell = 2) {
  const b = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 255 : 0;
      const i = (y * w + x) * 3;
      b[i] = b[i + 1] = b[i + 2] = v;
    }
  }
  return b;
}
/** 3×3 均值模糊，用来模拟"高斯模糊帧" */
function blurBuf(buf, w, h) {
  const out = Buffer.alloc(buf.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 3;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
        }
      }
      const i = (y * w + x) * 3;
      out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n;
    }
  }
  return out;
}

test('sharpness: 纯色为 0，细节越多越高，模糊后显著下降', () => {
  const [w, h] = [40, 24];
  const flat = solidBuf(w, h, 128);
  const sharp = checkerBuf(w, h, 2);
  const blurred = blurBuf(sharp, w, h);
  assert.equal(sharpness(flat, w, h), 0);
  assert.ok(sharpness(sharp, w, h) > 1000);
  assert.ok(sharpness(blurred, w, h) < sharpness(sharp, w, h) / 2,
    `模糊后应显著下降：${sharpness(blurred, w, h).toFixed(0)} vs ${sharpness(sharp, w, h).toFixed(0)}`);
});

test('sharpness: 尺寸太小不炸（没有内点）', () => {
  assert.equal(sharpness(Buffer.alloc(3 * 3), 2, 2), 0);
});

/* ---------------------------------------------------------------- 拼图 */

function solid(cellW, cellH, rgb) {
  const buf = Buffer.alloc(cellW * cellH * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
  }
  return buf;
}

test('composeSheet: 格位顺序、间隙、空位灰块都对', () => {
  const cols = 2;
  const rows = 2;
  const { cellW, cellH } = layoutCanvas(cols, rows, 16 / 9);
  const frames = [
    { buffer: solid(cellW, cellH, [200, 40, 40]), index: 1 },
    { buffer: solid(cellW, cellH, [40, 200, 40]), index: 2 },
    { buffer: solid(cellW, cellH, [40, 40, 200]), index: 3 },
  ];
  const out = composeSheet({ frames, cols, rows, cellAspect: 16 / 9 });

  assert.equal(out.buffer.length, out.width * out.height * 3);
  assert.ok(near(px(out.buffer, out.width, 1, 1), BACKGROUND), '间隙应是背景色');

  const centers = [[0, 0], [1, 0], [0, 1]];
  const expect = [[200, 40, 40], [40, 200, 40], [40, 40, 200]];
  centers.forEach(([c, r], i) => {
    const x = 4 + c * (cellW + 4) + Math.floor(cellW / 2);
    const y = 4 + r * (cellH + 4) + Math.floor(cellH / 2);
    assert.ok(near(px(out.buffer, out.width, x, y), expect[i]), `第 ${i + 1} 格颜色不对`);
  });

  // 第 4 格是空位：靠近角落应是灰块（中间被横杠占了）
  const padX = 4 + 1 * (cellW + 4) + 3;
  const padY = 4 + 1 * (cellH + 4) + 3;
  assert.ok(near(px(out.buffer, out.width, padX, padY), PAD_FILL), '空位应为中性灰');
});

test('composeSheet: burn="none" 时不画编号', () => {
  const { cellW, cellH } = layoutCanvas(1, 1, 16 / 9);
  const frame = { buffer: solid(cellW, cellH, [200, 40, 40]), index: 1 };
  const burned = composeSheet({ frames: [frame], cols: 1, rows: 1, cellAspect: 16 / 9 });
  const plain = composeSheet({ frames: [frame], cols: 1, rows: 1, cellAspect: 16 / 9, burn: 'none' });
  const p = [8, 8];
  assert.ok(!near(px(burned.buffer, burned.width, ...p), [200, 40, 40]), '开编号时左上角被覆盖');
  assert.ok(near(px(plain.buffer, plain.width, ...p), [200, 40, 40]), '关编号时应保持原样');
});

test('composeSheet: 帧数超过格位直接抛错', () => {
  const { cellW, cellH } = layoutCanvas(1, 1, 16 / 9);
  const f = { buffer: solid(cellW, cellH, [0, 0, 0]), index: 1 };
  assert.throws(() => composeSheet({ frames: [f, f], cols: 1, rows: 1, cellAspect: 16 / 9 }), RangeError);
});

test('blit: 缓冲区过小时抛错（避免读越界）', () => {
  assert.throws(() => composeSheet({
    frames: [{ buffer: Buffer.alloc(10), index: 1 }],
    cols: 1, rows: 1, cellAspect: 16 / 9,
  }), RangeError);
});

/* ---------------------------------------------------------------- e2e（真 ffmpeg） */

let hasFfmpeg = false;
try {
  await run(DEFAULT_FFMPEG, ['-version']);
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

async function makeFixture(dir) {
  const out = join(dir, 'fixture.mp4');
  const colors = ['0xff0000', '0x00ff00', '0x0000ff'];
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=1`);
  args.push('-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out);
  await run(DEFAULT_FFMPEG, args);
  return out;
}

test('e2e: 抽帧 → 拼图 → 编码 PNG，像素与尺寸都对', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sheet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const info = await probeVideo(file);
  const { cellW, cellH } = layoutCanvas(2, 2, info.aspect);

  const f1 = await extractFrameRaw({ input: file, at: 0, dur: 1, cellW, cellH });
  assert.equal(f1.buffer.length, cellW * cellH * 3, '必须是正好一格大小');
  assert.ok(f1.t >= 0.4 && f1.t <= 0.6, `中点应在 0.5s 附近，实得 ${f1.t}`);

  const sheet = composeSheet({
    frames: [{ buffer: f1.buffer, index: 1 }],
    cols: 2, rows: 2, cellAspect: info.aspect,
  });
  const out = join(dir, 'sheet.png');
  await encodeRaw(sheet.buffer, sheet.width, sheet.height, out);
  const { size } = await stat(out);
  assert.ok(size > 1000, `PNG 太小，可能是空图：${size}B`);

  const { stdout } = await run(DEFAULT_FFMPEG, [
    '-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const back = Buffer.from(stdout);
  assert.equal(back.length, sheet.width * sheet.height * 3, '读回的像素数应一致');

  // 第 1 格（红）中心应是红
  const cx = 4 + Math.floor(cellW / 2);
  const cy = 4 + Math.floor(cellH / 2);
  const [r, g, b] = px(back, sheet.width, cx, cy);
  assert.ok(r > 200 && g < 60 && b < 60, `第 1 格应为红色，实得 rgb(${r},${g},${b})`);
});

test('e2e: extractSharpest 会躲开模糊帧（前后各一半模糊的片子）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-blur-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'blur.mp4');
  await run(DEFAULT_FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
    '-vf', "boxblur=8:enable='lt(t,1.5)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);

  const opts = { input: file, at: 0, dur: 3, cellW: 320, cellH: 180 };
  const sharpPick = await extractSharpest(opts);
  const midPick = await extractFrameRaw({ input: file, at: 1.5, cellW: 320, cellH: 180 });
  assert.ok(sharpPick.t > 1.4, `应选到后半段清晰帧，实得 t=${sharpPick.t}`);
  assert.ok(sharpPick.sharp > 0);
  // 中点正好在模糊/清晰的交界，锐度不该高于选出来的那帧
  const midSharp = sharpness(midPick.buffer, 320, 180);
  assert.ok(sharpPick.sharp >= midSharp, `sharp=${sharpPick.sharp} mid=${midSharp}`);
});

test('e2e: thumb 模式返回段内的真实时刻，而不是段起点', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sheet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const { cellW, cellH } = layoutCanvas(2, 2, 16 / 9);
  const frame = await extractFrameRaw({
    input: file, at: 0.6, dur: 0.4, cellW, cellH, mode: 'thumb',
  });
  assert.equal(frame.buffer.length, cellW * cellH * 3);
  assert.ok(frame.t >= 0.6 && frame.t <= 1.0, `thumb 时刻应在段内，实得 ${frame.t}`);
});

test('thinCutTicks: 过密切点被抽稀且保序', () => {
  const cuts = Array.from({ length: 200 }, (_, i) => i * 0.1);
  const thinned = thinCutTicks(cuts, { from: 0, to: 20, maxTicks: 20 });
  assert.ok(thinned.length <= 20);
  assert.equal(thinned[0], 0);
  assert.ok(thinned.at(-1) <= 20);
  for (let i = 1; i < thinned.length; i++) assert.ok(thinned[i] >= thinned[i - 1]);
});

test('sharpSearchWindow: focusAt 收窄搜索并保留代表点', () => {
  const w = sharpSearchWindow({
    at: 10, dur: 20, focusAt: 18, candidates: 3, margin: 0.25,
  });
  assert.ok(w.at >= 10);
  assert.ok(w.at + w.dur <= 30.001);
  assert.ok(w.seedTimes.every((t) => t >= w.at - 0.001 && t <= w.at + w.dur + 0.001));
  assert.ok(w.seedTimes.some((t) => Math.abs(t - 18) < 0.05), `应含 focus: ${w.seedTimes}`);
  // 搜索窗应明显小于整段 20s
  assert.ok(w.dur < 10, `focus 窗应收窄，实得 ${w.dur}`);
});
