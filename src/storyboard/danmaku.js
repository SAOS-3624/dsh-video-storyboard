/**
 * danmaku.js — `video_danmaku`：把上千条弹幕**整理成可读的一张表**（issue #98）。
 *
 * ## 为什么不是"只留出现 ≥2 次的"
 *
 * 提议者给的默认策略是「≥2 次的组进正文，单次出现的只挑几条」。在三种片子上实测之后，
 * 这条策略只对**一类**片子成立：
 *
 * | 片子 | 条数 | 组数 | Top10 组覆盖率 | ≥6 次组平均字数 |
 * |---|---|---|---|---|
 * | 知识/评测 | 733 | 579 | **16%** | 3.7 字 |
 * | 应援 PV | 1200 | 171 | **80%** | 9.9 字 |
 * | 饭圈纪录片 | 9600 | 3561 | 16% | 61.2 字 |
 *
 * - **知识/评测（分散型）**：高频全是「？」「吓哭了」「借过一下」这种零信息噪声，
 *   真正的信息在长尾 —— 几十字的真实讨论，每条只出现一次；
 * - **应援/打榜（集中型）**：高频就是正文本体（「阳之力鸣人」×395），长尾反而是复读残渣。
 *
 * 所以排序键不能是单一的。这里先算 **Top10 组覆盖率**（一次 Counter 就有），
 * >50% 判集中型、否则判分散型，两种形态给不同的正文。
 *
 * ## 「出现 2–5 次」这一层为什么要单独说出来
 *
 * 它在三种片子上都只是中间地带（占 8%–18% 条数、4.5–47 字）：既不是「大家都在喊」，
 * 也不是「有个人认真说了一句」。留它只会把一句 4.5 字的「哈哈」请进正文 ——
 * 所以默认不列，但**报出条数**，别让它悄悄消失。
 *
 * ## 和 `video_index` 一样，这是"不解码的旁路数据"
 *
 * 走 `comment.bilibili.com/<cid>.xml`（十几年的老接口，免登录），不需要下载视频。
 * ⚠️ 它**不是全量**：122,756 条弹幕的视频只给到 9,600 条（7.8%）。所以返回里必须
 * 报「站上 N 条 / 取到 M 条」，M/N 太小时提示这是抽样 —— 否则会被当成"这部片子没人聊"。
 */

import { parseBvid } from './sprite-index.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const TIMEOUT_MS = 30_000;

/** 集中型 / 分散型的分界：Top10 组占了全片多少条。实测 16% / 80% 分得很开。 */
export const CONCENTRATED_AT = 0.5;

/** XML 实体。弹幕正文里 `&lt;` `&amp;` 很常见（表情、颜文字），不还原会原样显示成 `&lt;`。 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * 解析 B 站弹幕 XML。
 *
 * `p` 字段是逗号分隔的一串，位置**不能按名字取**（接口不给字段名）：
 * `[0]=秒 [1]=模式 [2]=字号 [3]=色 [4]=时间戳 [5]=池 [6]=用户hash [7]=dmid [8]=权重`。
 *
 * @returns {{t:number, mode:number, pool:number, text:string}[]}
 */
export function parseDanmakuXml(xml) {
  const out = [];
  const re = /<d\s+p="([^"]*)"\s*>([\s\S]*?)<\/d>/g;
  let m = re.exec(xml);
  while (m) {
    const f = m[1].split(',');
    const t = Number(f[0]);
    const text = decodeXml(m[2]).trim();
    if (Number.isFinite(t) && text) {
      out.push({ t, mode: Number(f[1]) || 0, pool: Number(f[5]) || 0, text });
    }
    m = re.exec(xml);
  }
  return out;
}

/**
 * 归一化：**NFKC → 去空白 → 小写**。
 *
 * 顺序和"必须做 NFKC"这两点都是实测来的：`？`(17 次) 与 `?`(7 次) 不做 NFKC 就是两个组，
 * 各进各的档，两个都进不了高频榜；做了 NFKC 合并成 24 次直接进第一。
 * `man！` / `man` / `man?` 同理。
 */
export function normalizeDanmaku(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 强特征：出现就该剔（联系方式 / 引流业务词）。 */
const AD_STRONG = /1[3-9]\d{9}|(绿泡|微信|vx|v信|企鹅|qq)\s*[:：]?\s*[0-9a-z_-]{5,}|直充|代充|接单|代刷|包过|代练|接单群/i;
/**
 * 弱特征：**单独命中不算**。实测教训：裸匹配「主页」会把
 * 「我去居然是重返未来1999的**主页**背景音乐」判成广告。
 * 只有同一句里还有长数字串/联系方式形状时才算。
 */
const AD_WEAK = /私信|加我|加微|看我主页|主页有|关注我/;

/** 这一条算不算引流。两级判据，弱特征必须有"号码形状"陪跑。 */
export function isAd(text) {
  const s = String(text ?? '');
  if (AD_STRONG.test(s)) return true;
  return AD_WEAK.test(s) && /\d{5,}|[a-z]{4,}\d{4,}/i.test(s);
}

const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

/**
 * 合并 + 判型 + 挑正文。**纯函数**（输入已经解析好的弹幕，不碰网络），好测。
 *
 * @param {{t:number,mode:number,pool:number,text:string}[]} rows
 * @param {{topShort?:number, minChars?:number, maxLong?:number, filterAds?:boolean}} [o]
 */
export function summarizeDanmaku(rows, { topShort = 20, minChars = 10, maxLong = 60, filterAds = true } = {}) {
  const all = rows ?? [];
  const ads = [];
  const kept = [];
  for (const r of all) {
    if (filterAds && isAd(r.text)) ads.push(r);
    else kept.push(r);
  }

  /** key = 归一化后的文本；值带上首末时间与代表文本（取最长的那条，它最完整） */
  const groups = new Map();
  for (const r of kept) {
    const key = normalizeDanmaku(r.text);
    if (!key) continue;
    const hit = groups.get(key);
    if (hit) {
      hit.count += 1;
      hit.first = Math.min(hit.first, r.t);
      hit.last = Math.max(hit.last, r.t);
      if (r.text.length > hit.text.length) hit.text = r.text;
    } else {
      groups.set(key, { key, text: r.text, count: 1, first: r.t, last: r.t, mode: r.mode });
    }
  }

  const list = [...groups.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  const total = kept.length;
  const top10 = list.slice(0, 10).reduce((n, g) => n + g.count, 0);
  const coverage = total > 0 ? top10 / total : 0;

  // 集中型：高频就是正文（应援/打榜）；分散型：长尾长句才是正文（知识/评测）
  const concentrated = coverage > CONCENTRATED_AT;
  const shortGroups = list.filter((g) => g.count >= 2).slice(0, Math.max(0, topShort));
  // 长句：**只出现一次也留** —— 这正是"那条认真说的话"
  const longAll = [...groups.values()]
    .filter((g) => g.count === 1 && [...g.key].length >= minChars)
    .sort((a, b) => a.first - b.first);

  /**
   * 长句**必须封顶**：实测一条饭圈纪录片（9600 条样本）有 1173 条长句，
   * 全列出来是 5.2 万字 —— 一次工具调用就把上下文干掉一半，而且后半段没人会读。
   *
   * 超出时**按时间等间隔抽**，不是取前 N 条：取前 N 只能看到开头那几分钟，
   * 对"这片子后面在聊什么"一无所知。抽样要说出来，别让人以为那就是全部。
   */
  const capped = Math.max(0, Math.min(Number(maxLong) || 0, longAll.length));
  const longTail = capped === longAll.length
    ? longAll
    : Array.from({ length: capped }, (_, i) => longAll[Math.floor(i * longAll.length / capped)]);

  const midGroups = list.filter((g) => g.count >= 2 && g.count <= 5);
  const onceShort = list.filter((g) => g.count === 1 && [...g.key].length < minChars);

  return {
    total,
    rawTotal: all.length,
    groupCount: list.length,
    coverage,
    concentrated,
    top10Count: top10,
    shortGroups,
    longTail,
    longAllCount: longAll.length,
    mid: { groups: midGroups.length, rows: midGroups.reduce((n, g) => n + g.count, 0) },
    onceShort: { groups: onceShort.length, rows: onceShort.reduce((n, g) => n + g.count, 0) },
    ads: { rows: ads.length, samples: ads.slice(0, 3).map((a) => a.text) },
    params: { topShort, minChars, maxLong, filterAds },
  };
}

/**
 * 印成给模型看的文本。
 *
 * 不同形态**正文顺序不同**：集中型先说高频（那是内容），分散型先说长句（那是信息）。
 * 硬套一个顺序等于每次都让模型读一半噪声。
 */
export function formatDanmaku(report, meta = {}) {
  const lines = [];
  const { stats = null } = meta;
  /**
   * 抽样比例只在**真的少了**的时候报。
   *
   * 实测有个反例：站上 `stat.danmaku` 是 730，XML 取到 733（100.4%）—— 那个字段
   * 不是"总条数"，是"当前可见/过审的条数"。所以比例 ≥ 98% 时不提这件事，
   * 免得输出一个"102%"让人以为算错了。
   */
  const sampling = stats && stats.danmaku > 0 ? report.rawTotal / stats.danmaku : null;
  const sampled = sampling !== null && sampling < 0.98;

  lines.push(`弹幕：取到 ${report.rawTotal} 条`
    + (sampled ? `（站上 ${stats.danmaku} 条，本次 ${(sampling * 100).toFixed(1)}%）` : '')
    + `，去重后 ${report.groupCount} 组。`);
  lines.push(`Top10 组覆盖 ${(report.coverage * 100).toFixed(0)}% 的条数 → `
    + (report.concentrated
      ? '**集中型**（打榜/应援/刷屏）：高频就是内容本身。'
      : '**分散型**（知识/评测/讨论）：高频多是情绪噪声，长句才是信息。'));

  /**
   * 抽样提示：122,756 条只给到 9,600 条（7.8%）是实测过的。
   * 不说这句，模型会把"取到的这些"当成"全部观众在说什么"。
   */
  if (sampling !== null && sampled) {
    lines.push(`⚠ 这是**接口抽样**，不是全量：站上 ${stats.danmaku} 条只取到 ${report.rawTotal} 条`
      + `（${(sampling * 100).toFixed(1)}%）。别拿它做"多少人在说 X"这类统计。`);
  }

  const table = (groups, title) => {
    if (groups.length === 0) return;
    lines.push('');
    lines.push(`## ${title}`);
    lines.push('| 次数 | 内容 | 时间 |');
    lines.push('|---|---|---|');
    for (const g of groups) {
      const span = g.count > 1 ? `${fmtTime(g.first)}–${fmtTime(g.last)}` : fmtTime(g.first);
      // 表格里的竖线会把列撑歪，换成全角
      lines.push(`| ${g.count} | ${g.text.replace(/\|/g, '｜')} | ${span} |`);
    }
  };

  const longSection = () => {
    if (report.longTail.length === 0) return;
    const capped = report.longTail.length < report.longAllCount;
    lines.push('');
    lines.push(`## 长句（≥${report.params.minChars} 字，只出现 1 次也留）`);
    if (capped) {
      // 抽样要自报，否则"只有 60 条长句"会被当成事实
      lines.push(`共 ${report.longAllCount} 条，这里按**时间均匀抽了 ${report.longTail.length} 条**`
        + `（全列会把上下文占满）。要看更多就调 \`maxLong\`，或把 \`minChars\` 调高些挑重点。`);
    }
    for (const g of report.longTail) lines.push(`- ${fmtTime(g.first)}　${g.text}`);
  };

  if (report.concentrated) {
    table(report.shortGroups, `高频（前 ${report.shortGroups.length} 组，占 ${(report.coverage * 100).toFixed(0)}% 条数）`);
    longSection();
  } else {
    longSection();
    table(report.shortGroups, `高频（前 ${report.shortGroups.length} 组，多半是情绪噪声，当"气氛"看）`);
  }

  lines.push('');
  lines.push('## 没列的');
  lines.push(`- 出现 2–5 次的 ${report.mid.groups} 组（${report.mid.rows} 条）：`
    + '这一层三种片子上实测都没有独立价值，中间地带。');
  lines.push(`- 单次短句 ${report.onceShort.groups} 组 / ${report.onceShort.rows} 条（"哈哈""+1"这类）。`);
  if (report.ads.rows > 0) {
    lines.push(`- 已剔除疑似引流 ${report.ads.rows} 条`
      + `（例：${report.ads.samples.map((s) => s.slice(0, 24)).join(' / ')}）。`);
  }

  lines.push('');
  lines.push('**这只是弹幕本身**：它反映的是"观众在敲什么"，不是片子讲了什么。'
    + '要画面用 `video_storyboard` / `video_index`，要台词用 `video_locate`。');
  return lines.join('\n');
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: REFERER, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

async function getText(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: REFERER },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading danmaku`);
  return res.text();
}

/**
 * 取一集的弹幕（XML 是十几年的老接口，比 videoshot 稳；但**不是全量**）。
 *
 * 站上总数从 `x/web-interface/view` 的 `stat.danmaku` 拿 —— 多一个很便宜的请求，
 * 换"这次是不是抽样"这个必须说清楚的判断。
 */
export async function fetchDanmaku({ input, page = 1, fetchImpl = globalThis.fetch }) {
  const { bvid, page: pageFromUrl } = parseBvid(input, 'video_danmaku');
  const want = Number(page) || pageFromUrl || 1;

  const list = await getJson(fetchImpl, `${API}/x/player/pagelist?bvid=${bvid}`);
  if (list?.code !== 0) {
    throw new Error(`pagelist failed (code=${list?.code ?? '?'} ${list?.message ?? ''}) for ${bvid}`);
  }
  const parts = (list.data ?? []).map((p) => ({
    cid: p.cid, page: p.page, part: p.part ?? '', duration: p.duration ?? null,
  }));
  const part = parts.find((p) => p.page === want);
  if (!part) {
    throw new Error(`${bvid} has ${parts.length} part(s); page ${want} does not exist.`);
  }

  const xml = await getText(fetchImpl, `https://comment.bilibili.com/${part.cid}.xml`);
  const rows = parseDanmakuXml(xml);

  // 站上总数：拿不到不影响主流程（只是少一句"这是抽样"的提示）
  let stats = null;
  try {
    const view = await getJson(fetchImpl, `${API}/x/web-interface/view?bvid=${bvid}`);
    const d = view?.data;
    if (view?.code === 0 && d) {
      // 多 P 时 `stat` 是整稿合计，`pages[].danmaku` 才是单集
      const byPage = Array.isArray(d.pages) ? d.pages.find((p) => p.page === want) : null;
      stats = { danmaku: byPage?.danmaku ?? d.stat?.danmaku ?? null, title: d.title ?? null };
    }
  } catch { /* 拿不到就算了 */ }

  return { bvid, part, totalParts: parts.length, rows, stats };
}
