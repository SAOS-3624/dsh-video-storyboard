/**
 * video-danmaku.test.mjs — `video_danmaku`（#98）。
 *
 * 这里测的全部是"会不会把观众说的话读错"，不是"能不能跑通"：
 * 归一化少做一次 NFKC → 同一句被拆成两组、高频反而降级；
 * 判型判错 → 把粉丝口号当成"舆论"读；广告过滤用单级判据 → 把正常弹幕误杀。
 * 三条都是实测里真踩过的，所以每条都有对应用例。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchDanmaku, formatDanmaku, isAd, normalizeDanmaku, parseDanmakuXml, summarizeDanmaku,
} from '../src/storyboard/danmaku.js';

// ---------------------------------------------------------------- 解析

test('parseDanmakuXml：按位置取 p 字段，并还原 XML 实体', () => {
  const xml = '<i><d p="12.5,1,25,16777215,1700000000,0,abc,123,10">666</d>'
    + '<d p="30,5,25,0,1700000000,0,def,124,10">a &amp; b &lt;3</d>'
    + '<d p="bad,1,25,0,0,0,x,y,10">坏时间戳</d>'
    + '<d p="40,1,25,0,0,0,x,y,10">   </d></i>';
  const rows = parseDanmakuXml(xml);
  assert.equal(rows.length, 2, '坏时间戳与空正文要丢掉，不能生成 NaN 的时间');
  assert.deepEqual(rows[0], { t: 12.5, mode: 1, pool: 0, text: '666' });
  assert.equal(rows[1].text, 'a & b <3');
  assert.equal(rows[1].mode, 5);
});

test('normalizeDanmaku：NFKC 必须做（全角问号与半角问号是同一句话）', () => {
  assert.equal(normalizeDanmaku('？'), normalizeDanmaku('?'));
  assert.equal(normalizeDanmaku('ＭＡＮ！'), normalizeDanmaku('man!'));
  // 去空白 + 小写
  assert.equal(normalizeDanmaku(' Man ！ '), 'man!');
  // 中日文不能被折坏
  assert.equal(normalizeDanmaku('吓哭了'), '吓哭了');
});

// ---------------------------------------------------------------- 判型

const rows = (text, n, t0 = 0) => Array.from({ length: n }, (_, i) => ({
  t: t0 + i, mode: 1, pool: 0, text,
}));

test('分散型（知识/评测）：高频是噪声，长句才是正文，中间层不列但报数', () => {
  const list = [
    ...rows('吓哭了', 27, 10),
    ...rows('？', 10, 100),      // 全角
    ...rows('?', 5, 200),        // 半角 —— NFKC 之后必须并进上面那组
    ...Array.from({ length: 60 }, (_, i) => ({ t: 300 + i, mode: 1, pool: 0,
      text: `第${i}条认真说的长句子，讨论的是模型能力和价格差` })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: 400 + i, mode: 1, pool: 0, text: `短句${i}` })),
    ...rows('借过一下', 4, 500),
  ];
  const r = summarizeDanmaku(list);
  assert.equal(r.concentrated, false, 'Top10 覆盖只有个位数百分比，必须判分散型');
  assert.ok(r.coverage < 0.5);

  // 「？」+「?」归一后 15 次 —— 不做 NFKC 的话是 10 和 5 两组，两个都进不了前排
  const question = r.shortGroups.find((g) => g.text === '？');
  assert.equal(question?.count, 15, '全角与半角问号必须并成一组');
  // 最高频是「吓哭了」27 次（噪声），第二才是问号组
  assert.equal(r.shortGroups[0].count, 27);

  // 长句：只出现一次也全留（这才是"那条认真说的话"）
  assert.equal(r.longTail.length, 60);
  // 单次短句只报条数，不列内容
  assert.equal(r.onceShort.groups, 20);
  // 2–5 次那一层单独报数，不当正文
  assert.equal(r.mid.groups, 1);
  assert.equal(r.mid.rows, 4);
});

test('集中型（打榜/应援）：高频就是内容本身，长尾当补充', () => {
  const list = [
    ...rows('阳之力鸣人', 300, 0),
    ...rows('火影11周年', 200, 0),
    ...Array.from({ length: 100 }, (_, i) => ({ t: 50 + i, mode: 1, pool: 0,
      text: `零散的一句比较长的观后感第${i}条在这里` })),
  ];
  const r = summarizeDanmaku(list);
  assert.equal(r.concentrated, true);
  assert.ok(r.coverage > 0.5);
  const text = formatDanmaku(r, { stats: { danmaku: 600 } });
  // 集中型的正文顺序：先高频表，再长句
  const hi = text.indexOf('## 高频');
  const lo = text.indexOf('## 长句');
  assert.ok(hi > 0 && lo > hi, '集中型必须先给高频表 —— 那才是这部片子的内容');
});

test('minChars / topShort 是真参数：调它们正文会变短', () => {
  const list = Array.from({ length: 50 }, (_, i) => ({ t: i, mode: 1, pool: 0,
    text: `${i}号路过说一句比较长的话在这里` }));
  const loose = summarizeDanmaku(list, { minChars: 1 });
  const strict = summarizeDanmaku(list, { minChars: 30 });
  assert.equal(loose.longTail.length, 50);
  assert.equal(strict.longTail.length, 0);
  assert.equal(summarizeDanmaku(list, { topShort: 0 }).shortGroups.length, 0);
});

// ---------------------------------------------------------------- 广告

test('isAd：强特征直接剔；弱特征单独命中**不许**误杀', () => {
  assert.equal(isAd('gpt直充你号, codex/claude安装、模型接入、验证, 绿泡可帮: seven9485777'), true);
  assert.equal(isAd('接单代刷，需要的私信我 13800138000'), true);

  // 实测误伤：「主页」是弱特征，这句是正常弹幕，不能判成广告
  assert.equal(isAd('我去居然是重返未来1999的主页背景音乐'), false);
  // 弱特征 + 号码形状才算
  assert.equal(isAd('关注我主页有惊喜 12345678901'), true);
  // 普通弹幕一律不动
  assert.equal(isAd('这段真的绝了'), false);
});

test('广告剔除的条数要报出来（不然用户不知道少的是什么）', () => {
  const list = [
    ...rows('正常的一句', 3),
    { t: 9, mode: 1, pool: 0, text: '代充点卡 微信 abc12345' },
  ];
  const withFilter = summarizeDanmaku(list, { filterAds: true });
  const without = summarizeDanmaku(list, { filterAds: false });
  assert.equal(withFilter.ads.rows, 1);
  assert.equal(without.ads.rows, 0);
  assert.equal(withFilter.rawTotal, 4);
  assert.equal(withFilter.total, 3, '剔掉之后参与统计的是 3 条');
  assert.match(formatDanmaku(withFilter), /已剔除疑似引流 1 条/);
});

// ---------------------------------------------------------------- 整条路（假接口）

test('fetchDanmaku：抽样比例要写进正文（122k 条只给 9.6k 是实测过的）', async () => {
  const xml = '<i>' + rows('阳之力鸣人', 8).map((r, i) => `<d p="${r.t},1,25,0,0,0,a,${i},10">${r.text}</d>`).join('') + '</i>';
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/pagelist')) return { ok: true, json: async () => ({ code: 0, data: [{ cid: 5, page: 1, part: 'p', duration: 60 }] }) };
    if (u.includes('comment.bilibili.com')) return { ok: true, text: async () => xml };
    if (u.includes('/x/web-interface/view')) return { ok: true, json: async () => ({ code: 0, data: { title: 't', stat: { danmaku: 122756 }, pages: [{ page: 1, danmaku: 122756 }] } }) };
    throw new Error(`unexpected ${u}`);
  };
  const got = await fetchDanmaku({ input: 'BV19UySzZEc8', fetchImpl });
  assert.equal(got.part.cid, 5);
  assert.equal(got.rows.length, 8);
  assert.equal(got.stats.danmaku, 122756);

  const text = formatDanmaku(summarizeDanmaku(got.rows), { stats: got.stats });
  assert.match(text, /接口抽样/);
  assert.match(text, /站上 122756 条只取到 8 条/);
});

test('fetchDanmaku：多 P 只取指定那一集，越界要说清范围', async () => {
  const xml = '<i><d p="1,1,25,0,0,0,a,1,10">x</d></i>';
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/pagelist')) return { ok: true, json: async () => ({ code: 0, data: [
      { cid: 11, page: 1, part: 'A', duration: 10 }, { cid: 22, page: 2, part: 'B', duration: 10 },
    ] }) };
    if (u.endsWith('/22.xml')) return { ok: true, text: async () => xml };
    if (u.endsWith('/11.xml')) return { ok: true, text: async () => '<i></i>' };
    if (u.includes('/x/web-interface/view')) return { ok: true, json: async () => ({ code: 0, data: { stat: { danmaku: 1 } } }) };
    throw new Error(`unexpected ${u}`);
  };
  const got = await fetchDanmaku({ input: 'BV1ris26hEa2', page: 2, fetchImpl });
  assert.equal(got.part.cid, 22);
  await assert.rejects(
    () => fetchDanmaku({ input: 'BV1ris26hEa2', page: 9, fetchImpl }),
    /page 9 does not exist/,
  );
});
