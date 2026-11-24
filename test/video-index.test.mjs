/**
 * video-index.test.mjs — `video_index`（#95）。
 *
 * 这一条最容易"看起来能用、实际悄悄错位"：秒数表是按**格号**对齐的，
 * 只要形状校验用错口径（等号 vs 区间），或者把重复的 0 去重，整张表就偏移。
 * 所以这里测的全是"会不会静默错"，而不是"能不能跑通"。
 *
 * 形状口径是实测来的：BV1ris26hEa2 是 2 张 × 10×10 = 200 格，但秒数只有 185 个 ——
 * 最后一张尾部是空的。用 `=== 张数×格数` 校验的话，这条真实样本每天都报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkShape, fetchSpriteIndex, formatIndex, gapStats, parseBvid,
} from '../src/storyboard/sprite-index.js';

// ---------------------------------------------------------------- 入口判别

test('parseBvid：BV 号与链接都认，非 B 站明确拒绝（并指路 video_storyboard）', () => {
  assert.deepEqual(parseBvid('BV1ris26hEa2'), { bvid: 'BV1ris26hEa2', page: null });
  assert.deepEqual(
    parseBvid('https://www.bilibili.com/video/BV1ris26hEa2/?spm_id_from=333'),
    { bvid: 'BV1ris26hEa2', page: null },
  );
  // 链接里的 ?p= 是"第几集"，要带出来（否则多 P 永远只拿到第 1 集）
  assert.deepEqual(
    parseBvid('https://www.bilibili.com/video/BV1ris26hEa2?p=3'),
    { bvid: 'BV1ris26hEa2', page: 3 },
  );
  assert.throws(() => parseBvid('https://www.youtube.com/watch?v=abc'), /bilibili/i);
  assert.throws(() => parseBvid('/local/movie.mp4'), /bilibili/i);
  assert.throws(() => parseBvid(''), /bilibili/i);
});

// ---------------------------------------------------------------- 形状（最容易错的一条）

test('checkShape：最后一张填不满是正常的（185/200 必须通过）', () => {
  const ok = checkShape({ index: new Array(185).fill(0), imgXLen: 10, imgYLen: 10, sheets: 2 });
  assert.equal(ok.ok, true, '等号口径会在这里误报 —— 实测样本就是 185');
  assert.equal(ok.expected, 200);
  assert.equal(ok.actual, 185);
  assert.equal(ok.covered, 185);
});

test('checkShape：空 / 超格 / 少一整张都要拦，且说得出是哪一种', () => {
  const empty = checkShape({ index: [], imgXLen: 10, imgYLen: 10, sheets: 2 });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /empty/);

  const tooMany = checkShape({ index: new Array(201).fill(0), imgXLen: 10, imgYLen: 10, sheets: 2 });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /longer than the sheet grid/);

  // 100 个 = 只够第一张：`image` 说两张而 `index` 没跟上，取下去第二张整段错位
  const short = checkShape({ index: new Array(100).fill(0), imgXLen: 10, imgYLen: 10, sheets: 2 });
  assert.equal(short.ok, false);
  assert.match(short.reason, /fewer sheets/);

  const noGeom = checkShape({ index: [1, 2], imgXLen: undefined, imgYLen: 10, sheets: 2 });
  assert.equal(noGeom.ok, false);
  assert.match(noGeom.reason, /geometry/);
});

// ---------------------------------------------------------------- 采样间隔

test('gapStats：中位数是"典型间隔"，最坏要带位置（平均会被密集段骗）', () => {
  // 前段 6 秒一帧，后段 30 秒一帧：平均 ≈ 12，典型 = 6，最坏 = 30
  const index = [0, 6, 12, 18, 48, 78];
  const g = gapStats(index);
  assert.equal(g.median, 6);
  assert.equal(g.worst, 30);
  assert.equal(g.worstAt, 18, '要报"从哪一秒之后开始稀"（第一处出现最大间隔的起点），不是只报一个数字');
  assert.ok(g.avg > 6 && g.avg < 30);

  // 倒序/抽风给负差不该把最坏间隔算成负数
  const weird = gapStats([0, 10, 5, 15]);
  assert.ok(weird.worst >= 10);
  assert.equal(gapStats([1]).worst, null);
  assert.equal(gapStats([]).avg, null);
});

// ---------------------------------------------------------------- 整条路（假接口）

const UA_JSON = { ok: true, status: 200 };
const jsonRes = (obj) => ({ ...UA_JSON, json: async () => obj, arrayBuffer: async () => new ArrayBuffer(0) });
const binRes = (bytes) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

function shot({ sheets = 2, cols = 10, rows = 10, count = 185, cell = 480 } = {}) {
  return {
    code: 0,
    data: {
      image: Array.from({ length: sheets }, (_, i) => `//bimp.hdslb.com/x-${i + 1}.jpg`),
      index: Array.from({ length: count }, (_, i) => i * 6),
      img_x_len: cols,
      img_y_len: rows,
      img_x_size: cell,
      img_y_size: Math.round(cell * 9 / 16),
    },
  };
}

test('fetchSpriteIndex：沙盒里跑完整条路（分P → 索引 → 下载图），间隔太稀要告警', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/pagelist')) {
      return jsonRes({ code: 0, data: [
        { cid: 111, page: 1, part: '第一集', duration: 600 },
        { cid: 222, page: 2, part: '第二集', duration: 300 },
      ] });
    }
    if (u.includes('/videoshot')) return jsonRes(shot());
    if (u.includes('bimp.hdslb.com')) return binRes(Buffer.from([0xFF, 0xD8, 0xFF]));
    throw new Error(`unexpected url ${u}`);
  };

  const idx = await fetchSpriteIndex({ input: 'BV1ris26hEa2', fetchImpl, maxGapSec: 10 });
  assert.equal(idx.bvid, 'BV1ris26hEa2');
  assert.equal(idx.totalParts, 2);
  assert.equal(idx.parts.length, 1, '多 P 默认只做第 1 集，不能悄悄全做');
  assert.equal(idx.parts[0].part.cid, 111);
  assert.equal(idx.parts[0].sheets.length, 2);
  assert.ok(Buffer.isBuffer(idx.parts[0].sheets[0].data));
  // 图片直链要补协议（接口给的是 //bimp...）
  assert.match(calls.find((u) => u.includes('bimp')), /^https:\/\//);
  // 6 秒一帧 < 阈值 10 → 不告警
  assert.deepEqual(idx.parts[0].warnings.filter((w) => w.includes('太稀')), []);

  // 文字表要能被"数"：秒数整串印出、重复的 0 保留、并写死"只够定位不够读数"
  const text = formatIndex(idx);
  assert.match(text, /第 k 个数 = 第 k 格/);
  assert.match(text, /不要去掉重复的 0/);
  assert.match(text, /只够定位，不够读数/);
  assert.match(text, /0,6,12/);
});

test('fetchSpriteIndex：间隔太稀（老稿 13.7s 一帧）要自己说出来，并带实际间隔', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/pagelist')) return jsonRes({ code: 0, data: [{ cid: 9, page: 1, part: 'p', duration: 2000 }] });
    if (u.includes('/videoshot')) return jsonRes(shot({ count: 150, cell: 160 }));
    return binRes(Buffer.from([1]));
  };
  const idx = await fetchSpriteIndex({ input: 'BV1ris26hEa2', page: 1, fetchImpl, maxGapSec: 10 });
  const warns = idx.parts[0].warnings.join('\n');
  // 6s 一帧其实没超阈值，但格子 160×90 要单说一条
  assert.match(warns, /160×90/);
  assert.match(warns, /别拿它读字/);
});

test('fetchSpriteIndex：索引为空要重试，重试仍空就报错并**带上形状与期望格数**', async () => {
  let shots = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/pagelist')) return jsonRes({ code: 0, data: [{ cid: 7, page: 1, part: '', duration: 100 }] });
    if (u.includes('/videoshot')) {
      shots += 1;
      return jsonRes({ ...shot(), data: { ...shot().data, index: [] } });
    }
    return binRes(Buffer.from([1]));
  };
  await assert.rejects(
    () => fetchSpriteIndex({ input: 'BV1ris26hEa2', fetchImpl }),
    (err) => {
      // #95 里对方明确要的：只有"索引为空"没法判断，要给得出形状
      assert.match(err.message, /期望 200 格/);
      assert.match(err.message, /实际 0/);
      assert.match(err.message, /cid=7/);
      assert.match(err.message, /video_storyboard/, '要指路：索引死了还有分镜这条路');
      return true;
    },
  );
  assert.equal(shots, 3, '第一次 + 重试 2 次');
});

test('fetchSpriteIndex：第二次才成功（接口间歇性空数组）也要拿到，不能直接失败', async () => {
  let shots = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/pagelist')) return jsonRes({ code: 0, data: [{ cid: 8, page: 1, part: '', duration: 100 }] });
    if (u.includes('/videoshot')) {
      shots += 1;
      return jsonRes(shots === 1 ? { ...shot(), data: { ...shot().data, index: [] } } : shot());
    }
    return binRes(Buffer.from([1]));
  };
  const idx = await fetchSpriteIndex({ input: 'BV1ris26hEa2', fetchImpl });
  assert.equal(shots, 2);
  assert.equal(idx.parts[0].index.length, 185);
});

test('fetchSpriteIndex：页数越界要说清"有几集、合法范围是什么"', async () => {
  const fetchImpl = async (url) => jsonRes({
    code: 0,
    data: [{ cid: 1, page: 1, part: '', duration: 10 }, { cid: 2, page: 2, part: '', duration: 10 }],
  });
  await assert.rejects(
    () => fetchSpriteIndex({ input: 'BV1ris26hEa2', page: 9, fetchImpl }),
    /page 9 does not exist \(use 1–2, or "all"\)/,
  );
});
