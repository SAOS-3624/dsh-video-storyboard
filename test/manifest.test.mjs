/**
 * manifest.test.mjs — 文本侧的分页与预算。
 *
 * 起因（真实事故）：一部 2 小时 35 分的电影，64 个 cell 的清单约 75KB，宿主把 44% 折进磁盘溢出文件，
 * 模型没去读，等于中段 44 分钟的台词完全没给到。所以清单必须自己带预算、自己会分页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DETAIL_CHARS, PROBE_DUAL_MODE_MINUTES, formatManifest, formatProbe, truncateAtSentence,
} from '../src/pipeline.js';

/** 造一个 64 格的 result（每格 300 字），不跑 ffmpeg */
function makeResult({ cells = 64, textLen = 300 } = {}) {
  const sheets = [1, 2, 3, 4].map((sheet) => {
    const cols = 4;
    const rows = 4;
    return {
      sheet, cols, rows, width: 1064, height: 600, stripH: 56,
      cells: Array.from({ length: 16 }, (_, k) => {
        const i = (sheet - 1) * 16 + k + 1;
        return {
          i, sheet,
          t_start: (i - 1) * 145,
          t_end: i * 145,
          t_frame: (i - 1) * 145 + 70,
          sharp: 1200,
          text: '这是一句很长的台词'.repeat(Math.ceil(textLen / 8)).slice(0, textLen),
        };
      }),
    };
  });
  return {
    info: { path: 'film.mkv', duration: 9300, fps: 23.976, aspect: 16 / 9 },
    window: { from: 0, to: 9300, duration: 9300 },
    cuts: [], summary: { frames: 0, p90: 0 }, threshold: 40, cached: false,
    audio: null,
    transcript: { source: 'subtitle', model: 'embedded', segments: 1782 },
    plan: { cells: 16, sheets: 4, adaptive: true, pick: 'sharp', burn: 'index', minGap: 120, reason: 'auto', bursts: [] },
    sheets: cells === 64 ? sheets : sheets.slice(0, Math.ceil(cells / 16)),
    totalDuration: 9300,
  };
}

test('默认预算：超长清单在 cell 边界截断，并给出续读指令', () => {
  const text = formatManifest(makeResult(), { maxChars: 4000 });
  assert.ok(text.length < 5000, `应被压在预算附近，实得 ${text.length}`);
  assert.match(text, /text stopped at cell \d+ of 64/);
  assert.match(text, /cellRange: \[\d+, 64\] and textOnly: true/);
  // 截断必须落在整格之间：最后一行要么是某格的头，要么是它的台词
  const body = text.split('\n').filter((l) => l.startsWith('cell '));
  assert.ok(body.length > 0);
  assert.ok(body.length < 64, '不该把 64 格全塞进去');
});

test('默认不截断时能把 64 格全列出来（预算足够）', () => {
  const text = formatManifest(makeResult(), { maxChars: 200_000 });
  assert.equal(text.split('\n').filter((l) => l.startsWith('cell ')).length, 64);
  assert.ok(!/text stopped/.test(text));
});

test('每格台词有字符上限，超出用省略号', () => {
  const text = formatManifest(makeResult({ textLen: 500 }), { maxChars: 200_000, maxCellChars: 40 });
  const quoted = text.split('\n').filter((l) => l.trim().startsWith('"'));
  assert.ok(quoted.length > 0);
  for (const line of quoted) {
    assert.ok(line.trim().length <= 44, `单格台词应 ≤ ~40 字符，实得 ${line.trim().length}`);
    assert.ok(line.trimEnd().endsWith('…"'), '超长时应带省略号');
  }
});

test('cellRange 只取一段，表头写明范围', () => {
  const text = formatManifest(makeResult(), { cellRange: [14, 42], maxChars: 200_000 });
  assert.match(text, /cells="14-42 of 64"/);
  const nums = text.split('\n').filter((l) => l.startsWith('cell '))
    .map((l) => Number(l.match(/^cell (\d+)/)[1]));
  assert.equal(nums[0], 14);
  assert.equal(nums.at(-1), 42);
  assert.equal(nums.length, 29);
});

test('cellRange 越界时被夹到有效范围', () => {
  const text = formatManifest(makeResult(), { cellRange: [60, 999], maxChars: 200_000 });
  assert.match(text, /cells="60-64 of 64"/);
});

test('textOnly 结果：没有图，但格与台词齐全', () => {
  const base = makeResult();
  const textOnly = {
    ...base, sheets: [], textOnly: true, audio: null,
    cells: base.sheets.flatMap((s) => s.cells.map((c) => ({
      i: c.i, t_start: c.t_start, t_end: c.t_end, text: c.text,
    }))),
  };
  const text = formatManifest(textOnly, { maxChars: 200_000 });
  assert.match(text, /image="none \(text only\)"/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('cell ')).length, 64);
  // 没有行列信息时不应编造 r/c
  assert.ok(!/\(r\d+c\d+, image/.test(text));
});

/* ---------------------------------------------------------------- 句末截断 */

test('truncateAtSentence: 不超限时原样返回', () => {
  assert.equal(truncateAtSentence('短句。', 60), '短句。');
});

test('truncateAtSentence: 在句末截断，不切半句', () => {
  const text = '第一句话在这里结束。第二句话稍微长一点也结束了。第三句话会被截掉。';
  // 上限 30：第二个句号在索引 23，落在 [15,29] 窗口内，应该正好在那里截
  const out = truncateAtSentence(text, 30);
  assert.ok(out.endsWith('…'), `应带省略号，实得 ${out}`);
  // 截断点必须在句号之后
  assert.match(out, /。…$/);
  assert.ok(out.length <= 30, `不该超过上限，实得 ${out.length}`);
});

test('truncateAtSentence: 没有标点时退回硬切', () => {
  const out = truncateAtSentence('一二三四五六七八九十一二三四五六七八九十', 10);
  assert.equal(out, '一二三四五六七八九…');
  assert.ok(out.length <= 10, '总长不该超过上限（省略号占一格）');
});

test('truncateAtSentence: 英文句号也认（但不能被小数点骗）', () => {
  assert.ok(truncateAtSentence('First sentence here. Second one follows and is long.', 24).endsWith('.…'));
  const out = truncateAtSentence('value 3.14 is pi and more text follows', 20);
  assert.ok(!/3\.…$/.test(out), `不该在小数点后截断：${out}`);
});

test('detail 三档：越小越省，且都从格边界截', () => {
  const variants = Object.entries(DETAIL_CHARS).map(([k, v]) => {
    const text = formatManifest(makeResult(), { maxChars: 200_000, maxCellChars: v });
    return { k, v, len: text.length };
  });
  assert.ok(variants[0].len < variants[1].len, 'low 应比 med 短');
  assert.ok(variants[1].len < variants[2].len, 'med 应比 high 短');
  for (const { k, len } of variants) assert.ok(len > 0, `${k} 不该为空`);
});

test('degraded 抽样扫描：清单必须警告 coverage / unscanned', () => {
  const base = makeResult();
  const text = formatManifest({
    ...base,
    degraded: true,
    status_shots: 'degraded',
    sample: {
      coverage_ratio: 0.1,
      unscanned_gap_count: 11,
      unscanned_gaps: [{ from: 30, to: 300 }, { from: 330, to: 600 }],
    },
    plan: { ...base.plan, strategy: 'coverage', minGap: 0.8, bursts: [] },
  }, { maxChars: 200_000 });
  assert.match(text, /shots="sampled-degraded"/);
  assert.match(text, /WARNING: shot scan is SAMPLED\/DEGRADED/);
  assert.match(text, /coverage≈10%/);
  assert.match(text, /unscanned examples/);
  assert.match(text, /strategy="coverage"/);
});

test('effectiveMinGap / cutsUncertain 写进清单顶栏', () => {
  const base = makeResult();
  const text = formatManifest({
    ...base,
    plan: {
      ...base.plan,
      minGap: 2.0,
      effective_min_gap: 0.54,
      cuts_uncertain: true,
      bursts: [],
    },
  }, { maxChars: 200_000 });
  assert.match(text, /minGap="2"/);
  assert.match(text, /effectiveMinGap="0\.54"/);
  assert.match(text, /cutsUncertain="true"/);
  assert.match(text, /requested minGap=2s was clamped to effectiveMinGap=0\.54s/);
  assert.match(text, /cut list may be UNRELIABLE/);
});

test('degraded: motion 单独警告切点不可信', () => {
  const base = makeResult();
  const text = formatManifest({
    ...base,
    degraded: true,
    degraded_kind: 'motion',
    status_shots: 'degraded-motion',
    motion: { median_shot_sec: 0.32, high_score_ratio: 0.22, p90: 38 },
    plan: { ...base.plan, minGap: 1.2, effective_min_gap: 1.2, cuts_uncertain: true, bursts: [] },
  }, { maxChars: 200_000 });
  assert.match(text, /shots="degraded-motion"/);
  assert.match(text, /degraded: motion/);
  assert.match(text, /median shot ≈0\.32s/);
  assert.doesNotMatch(text, /shots="sampled-degraded"/);
});

test('burst 清单提示 zoom / minGap', () => {
  const base = makeResult();
  const text = formatManifest({
    ...base,
    transcript: { source: 'subtitle', model: 'embedded', segments: 10 },
    plan: {
      ...base.plan,
      bursts: [
        { from: 10, to: 14, density: 2.2, shots: 9 },
        { from: 80, to: 85, density: 1.8, shots: 6 },
      ],
    },
  }, { maxChars: 200_000 });
  assert.match(text, /cut bursts \(fast montage\)/);
  assert.match(text, /video_zoom/);
  assert.match(text, /minGap: 0\.4/);
});

test('formatProbe: ≥8 分钟给出 STRUCTURE/SEQUENCE', () => {
  assert.equal(PROBE_DUAL_MODE_MINUTES, 8);
  const long = formatProbe({
    path: 'a.mp4', duration: 9 * 60, width: 1920, height: 1080, fps: 24,
    aspect: 16 / 9, rotation: 0, videoCodec: 'h264', container: 'mp4',
    hasAudio: true, audioCodec: 'aac', hasSubtitle: false,
  });
  assert.match(long, /STRUCTURE/);
  assert.match(long, /SEQUENCE/);
  assert.match(long, /visual-only/);
  const short = formatProbe({
    path: 'b.mp4', duration: 120, width: 1280, height: 720, fps: 25,
    aspect: 16 / 9, rotation: 0, videoCodec: 'h264', container: 'mp4',
    hasAudio: true, audioCodec: 'aac', hasSubtitle: true,
  });
  assert.ok(!/STRUCTURE \(spoils/.test(short));
});
