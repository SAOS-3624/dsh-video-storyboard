/**
 * sheet.test.mjs — 拼图与点阵字。
 *
 * 2026-11-01：统一网格（layoutCanvas / composeSheet）被可变矩形（pack.toRects / composePacked）
 * 取代。这一层测的是几何本身的正确性：顺序、缝、编号位置、源宽不匹配时不错行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';
import {
  BACKGROUND, BADGE_FG, PAD_FILL, SEAM, addSheetHeader, badgeScale, blit, composePacked, drawBadgePlain,
  drawGlyphs, encodeRaw, extractFrameRaw, extractSharpest, fillRect, sharpness,
} from '../src/storyboard/sheet.js';

const run = promisify(execFile);
const px = (buf, width, x, y) => {
  const i = (y * width + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
};

/* ---------------------------------------------------------------- 编号 */

test('badgeScale: 保底 3（盲测：scale 2 会把 86 读成 88）', () => {
  assert.equal(badgeScale(200), 3);
  assert.equal(badgeScale(800), 3);
  assert.equal(badgeScale(1600), 5, '宽画布才放大，上限 5');
});

test('drawBadgePlain: 只画描边数字，不铺黑底', () => {
  const w = 40;
  const h = 20;
  const buf = Buffer.alloc(w * h * 3, 200);
  drawBadgePlain(buf, w, h, 2, 2, 7, 3);
  let yellow = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i] === BADGE_FG[0] && buf[i + 1] === BADGE_FG[1]) yellow += 1;
  }
  assert.ok(yellow > 10, `应当有黄色字形像素，实得 ${yellow}`);
  // 右下角仍是背景色（没有黑底框；左上角可能被描边覆盖，属正常）
  assert.deepEqual(px(buf, w, w - 1, h - 1), [200, 200, 200]);
});

test('drawGlyphs: 空格只走位，不画像素', () => {
  const w = 60;
  const h = 12;
  const buf = Buffer.alloc(w * h * 3, 0);
  const box = drawGlyphs(buf, w, h, ' ', 0, 0, 2, [255, 255, 255]);
  assert.ok(box.width > 0);
  assert.equal(buf.reduce((n, v) => n + v, 0), 0);
});

/* ---------------------------------------------------------------- 拼图 */

test('composePacked: 顺序与 1px 缝都对（第 i 个 rect 放第 i 帧）', () => {
  const width = 24;
  const height = 12;
  const rects = [
    { px: 0, py: 0, pw: 12, ph: 12, index: 1 },
    { px: 12, py: 0, pw: 12, ph: 12, index: 2 },
  ];
  const frames = [
    { buffer: Buffer.alloc(12 * 12 * 3, 0).fill(0).map((_, i) => (i % 3 === 0 ? 200 : 0)), w: 12, h: 12 },
    { buffer: Buffer.alloc(12 * 12 * 3, 0).fill(0).map((_, i) => (i % 3 === 1 ? 200 : 0)), w: 12, h: 12 },
  ];
  const sheet = composePacked({ frames, rects, width, height, burn: 'none' });
  assert.equal(sheet.width, width);
  assert.equal(sheet.height, height);
  // 第一格红、第二格绿
  assert.deepEqual(px(sheet.buffer, width, 2, 2), [200, 0, 0]);
  assert.deepEqual(px(sheet.buffer, width, 14, 2), [0, 200, 0]);
  // 缝（第 11 列）是画布底色
  assert.deepEqual(px(sheet.buffer, width, 11, 2), [...BACKGROUND]);
  assert.equal(SEAM, 1);
});

test('composePacked: null 帧画灰条（空位不是纯黑）', () => {
  const width = 10;
  const height = 10;
  const sheet = composePacked({
    frames: [null], rects: [{ px: 0, py: 0, pw: 10, ph: 10, index: 1 }], width, height, burn: 'none',
  });
  // 取角落：中心被"横杠"占着（画的是空位标记，不是纯色块）
  const [r, g, b] = px(sheet.buffer, width, 1, 1);
  assert.deepEqual([r, g, b], [...PAD_FILL], '空位必须是灰底，不是纯黑');
});

test('composePacked: 排布留白铺灰条（纯黑会被读成渲染失败）', () => {
  const width = 40;
  const height = 20;
  const frames = [{ buffer: Buffer.alloc(20 * 20 * 3, 200), w: 20, h: 20 }];
  const rects = [{ px: 0, py: 0, pw: 20, ph: 20, index: 1 }];
  const sheet = composePacked({ frames, rects, width, height, burn: 'none' });
  // 右半边是留白：必须是灰底（PAD_FILL），不是画布底色
  assert.deepEqual(px(sheet.buffer, width, 35, 2), [...PAD_FILL]);
});

test('composePacked: burn="none" 不画编号，默认画', () => {
  const width = 40;
  const height = 20;
  const frames = [{ buffer: Buffer.alloc(40 * 20 * 3, 90), w: 40, h: 20 }];
  const rects = [{ px: 0, py: 0, pw: 40, ph: 20, index: 12 }];
  const plain = composePacked({ frames, rects, width, height, burn: 'none' });
  const burned = composePacked({ frames, rects, width, height });
  const diff = plain.buffer.compare(burned.buffer) !== 0;
  assert.ok(diff, '烧了编号的图必须与不烧的不同');
});

test('blit: 源行宽与目标格宽不同时不错行', () => {
  const dst = Buffer.alloc(40 * 10 * 3, 0);
  // 源 20 宽、目标只贴 10 宽：每行应只取源的前 10 个像素
  const src = Buffer.alloc(20 * 10 * 3, 0);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const i = (y * 20 + x) * 3;
      src[i] = x < 10 ? 255 : 1;
    }
  }
  blit(dst, 40, 10, 0, 0, 10, 10, src, 20);
  for (let y = 0; y < 10; y += 1) {
    assert.equal(px(dst, 40, 0, y)[0], 255, `第 ${y} 行首像素错位`);
    assert.equal(px(dst, 40, 9, y)[0], 255);
    assert.equal(px(dst, 40, 10, y)[0], 0, `第 ${y} 行不该写到 x=10`);
  }
});

test('addSheetHeader: 加一条抬头，原图内容整体下移', () => {
  const width = 120;
  const height = 40;
  const base = { buffer: Buffer.alloc(width * height * 3, 0), width, height };
  fillRect(base.buffer, width, height, 0, 0, width, 4, [200, 0, 0]);
  const out = addSheetHeader(base, { text: '0:00-1:00 1/2' });
  assert.ok(out.height > height);
  assert.equal(out.buffer.length, width * out.height * 3);
  // 原图顶部那 4 行红色现在位于抬头之后
  assert.deepEqual(px(out.buffer, width, 2, out.headerH + 1), [200, 0, 0]);
});

/* ---------------------------------------------------------------- e2e（真 ffmpeg） */

async function hasFfmpeg() {
  try {
    await run(DEFAULT_FFMPEG, ['-version']);
    return true;
  } catch {
    return false;
  }
}

test('e2e: 抽帧 → 拼图 → 编码 PNG，像素与尺寸都对', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sheet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'clip.mp4');
  await run(DEFAULT_FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);

  const cellW = 160;
  const cellH = 90;
  const f = await extractFrameRaw({ input: file, at: 0, dur: 1, cellW, cellH });
  assert.equal(f.buffer.length, cellW * cellH * 3, '必须是正好一格大小');
  assert.ok(f.t >= 0.4 && f.t <= 0.6, `中点应在 0.5s 附近，实得 ${f.t}`);

  const sheet = composePacked({
    frames: [{ buffer: f.buffer, w: cellW, h: cellH }],
    rects: [{ px: 0, py: 0, pw: cellW, ph: cellH, index: 1 }],
    width: cellW, height: cellH,
  });
  const out = join(dir, 'sheet.png');
  await encodeRaw(sheet.buffer, sheet.width, sheet.height, out);
  const { size } = await stat(out);
  assert.ok(size > 200, `PNG 太小，可能是空图：${size}B`); // 纯色图压缩后本来就小

  const [r, g, b] = px(sheet.buffer, sheet.width, 40, 40);
  assert.ok(r > 150 && g < 90 && b < 90, `红片应抽出红帧，实得 rgb(${r},${g},${b})`);
});

test('e2e: extractSharpest 会躲开模糊帧', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not on PATH');
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
  const midSharp = sharpness(midPick.buffer, 320, 180);
  assert.ok(sharpPick.sharp >= midSharp, `sharp=${sharpPick.sharp} mid=${midSharp}`);
});
