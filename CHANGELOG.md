# Changelog

## [Unreleased]

### Fixed

- **`bin/asr-check.mjs` 不认「本机地址免 key」，也不拉起 `manage.start` 的托管服务**（#41）。
  它自己拿 `ASR_DEFAULTS.fileKey || process.env[keyEnv]` 判"能不能转写"，而工具走的是
  `canTranscribe()` —— 同一个环境，脚本说"没配 key"、`video_storyboard` 却能跑；
  再加上脚本从不 import `asr-lifecycle`，配了 `manage.start` 也不会拉起服务，
  于是按 `doctor.mjs` 第 5 步排障的人会连着撞两次（"没有 key"和 `ECONNREFUSED`）。
  修：判据换成 `canTranscribe()`（本机不需要 key 时照常发请求、不发 Authorization），
  转写前 `ensureAsr()` 按需拉起（拉起的按 `idleMs` 退出），连接失败给人话而不是抛栈。

- **音轨"丢了"和"本来没有"分不开**（#43）。判据原来只看 `-J` 的 `formats` 里有没有 `acodec`，
  而且**缓存命中直接信 `meta.json`** —— 老版本写的 meta 没有 `audioMissing` 这一项，
  于是"yt-dlp 没合流"被报成 `no audio track: grid is visual only`；坏缓存又因为
  `staleMerge` 只在 ffmpeg 解析到绝对路径时才失效，可以一直命中有声无影的那份。
  修：改由**磁盘证据**判定（旁边还留着 `video.<id>.m4a` 就是合流没跑，与 formats 无关），
  缓存命中也重判一次；拿不到绝对路径时用 `resolveMediaBinary()` 再解析一次 ffmpeg，
  而不是一直用模块加载那一刻的快照。

- **`docs/CONFIG.zh.md` 把 `server-sherpa.py` 当成读者已有的文件**（#42）。仓库里没有这份实现，
  也没给出处，照着配的人会卡在"文件不存在"上；顺带补了两个坑：sherpa-onnx **2.x** 把
  `add_punct()` 改名为 `add_punctuation()`，以及"标点失败要退回无标点文本并照常 200"
  （否则一个装饰性环节能把整条台词链带崩）。§1 现在明说**本插件不带服务端**，新增 §7.1 三选一。

- **硬字幕校正（`detail: high`）从发布起就没有真正跑起来过**（#39）。
  `src/storyboard/ocr.js` 把桥接脚本拼成 `src/storyboard/ocr_bridge.py`，而它在 `src/ocr_bridge.py` ——
  全仓唯一的引用点，于是每次调用都是 `ENOENT`。更糟的是 `runBridge` 把 **ENOENT、超时、Python 崩溃**
  一起 `resolve(null)`，上层一律报 `detect-failed`，所以"脚本根本没被打开"看起来像"检测不到字幕带"。
  修：路径上溯一层；失败返回结构化原因（`bridge-missing` / `interpreter-missing` / `bridge-timeout` /
  `bridge-crashed` / `bridge-bad-json` / `bridge-error` / `no-band`），清单里直接写出来，
  `DSH_OCR_DEBUG=1` 时把 stderr 也打出来。
  `video_subtitles` 的 `bandSource` 因此也会真的出现 `detected`（以前永远是 `default-bottom`）。

- **字幕带检测会把画面顶部的横幅当字幕**。判据只有"宽 > 35% + 置信度 > 0.55"，
  平台推广横幅同样满足，band 于是被拉成 `[0, 1]` —— 整帧，crop 等于没裁（实测 1280×720 上
  横幅 y≈77、真字幕 y≈654）。现在**优先只收画面下半部分（中心 y > 0.5）的候选**，
  下半屏一个都没有才退回全帧 —— 顶部字幕的片子（日式竖排、顶部提示条）不受影响。

- **判据本身也校准错了**：`宽 ≥ 35%` 是照着"平台横幅"定的，而真字幕实测只有 **26%–30%**
  （1280×720 的双语字幕帧：中文 w=26.4% h=7.6%、英文 w=30.4% h=6.2%），于是一帧里两条真字幕
  全被砍掉、band 永远落回兜底。改成 `宽 ≥ 18%` **+ 高 ≤ 15%** ——
  高度才是可靠的区分器：同一支片里画面大字/海报字的框高 31%–83%，字幕只有 6%–8%。

### Added

- **支持 `rapidocr` 3.x**（现在 PyPI 上的主线）。旧包 `rapidocr_onnxruntime` 把
  `requires-python` 写死在 `<3.13`，Python 3.13 上**根本装不上**；新包改成构造只收
  `config_path`/`params`、`use_det=False` 走 per-call 参数、返回 `RapidOCROutput` 对象
  （`.txts`/`.scores`/`.boxes`）。桥接脚本两个包都认，返回形状统一成 `[(box, text, conf)]`。

- **`~/.dsh/video.json` 的 `ocr.python`**：指定用哪个解释器跑 OCR。
  桌面版宿主读不到 `setx` 设的环境变量，没有这个入口就只能装进 `asr.json` 那个 venv
  —— 而那会把两个模型的依赖混在一起。不配则回落到 `DSH_OCR_PYTHON` → `asr.json` → PATH。

### Changed

- **"找不到能 import rapidocr 的 Python" 不再永久缓存**：改成失败缓存 60 秒。
  以前装完 `rapidocr-onnxruntime` 必须**重启整个 DSH 宿主**，否则永远 `no-python-with-rapidocr`，
  而且从报错看不出是这个原因。现在装完最多等一分钟自动生效。

## [0.5.4] - 2026-10-31

这一版只解决一件事：**参数不再让人用"更小的格子"去换"更大的封面面积"**。
起因是一份真实反馈：看一部电影时按 `cells:16` 总览，每格 286×118，模型只能看见色块，
然后照着色块编剧情 —— 而清单对此一声不吭。

### Changed

- **`size` 拆开，不再是一个旋钮绑三个量。** 现在：
  - `budget` 只管"一张图多少像素"（默认 **1.2M**，≈700 vision token；640k ≈390，1.65M ≈990）；
  - `need` 管"要看多清"（`shot` 160×90 / `scene` 320×180 / `text` 480×270）；
  - `maxPerSheet` 由前两者推出，也可显式覆盖；`quality`/`scanHeight` 仍单独覆盖下载清晰度。
  `size` 保留为 `budget` 的别名（small 640k / medium 1.2M / large 1.65M），不再影响格数和下载档位。
- **默认预算 640k → 1.2M。** 9 格从 331×184 变成 456×254。代价是每张图约 390 → 700 token；
  要省钱显式传 `size:"small"` 或 `budget:640000`，清单会把可读性和代价都写出来。
- **`cells` 不再被静默改写**：补满布局、并尾段、黑场让格，都会写进清单的 `adjusted=`。
- **`from` > 0 且没给 `to` 时不再扫到片尾**：默认按 300 秒推一段（可用 `segment` 改）。

### Added

- **`segment`（SEQUENCE 自动推段）**：`video_storyboard({ input, from: 0, segment: 300 })`
  只管第一段，结果末尾回显 `segment 5/22 · 22% watched · 82 min left · next: from=1500`，
  下一段把那个 `from` 传回来就行。调用方不用自己记时间，也不容易停在中途就忘。
- **清单新增三行**：
  - `cell=421x237 (scene)` —— 每格实际多大、能读到哪一档；
  - `cost: 2 image(s) × ~737 = ~1474 vision tokens · ASR 192 s` —— 成本按"图数×token + ASR 秒数"报，
    不再报 CPU 秒；
  - `!! cells are 286x118 — below what you asked for (text: 480x270…)` —— **看不清时主动报警**，
    并给三条可执行改法（减格数 / 加预算 / 用 zoom）。
- **ASR 按片落盘复用**：转写结果以**绝对时间**存到 `<cache>/transcripts/<file>.json`，
  只要已有一段完整覆盖本次窗口，就直接切出来用 —— zoom 回看已转写段里的 20 秒不再重跑 ASR，
  也不会为了它临时拉起本地模型。后端（模型/切片长度/热词）变了就不复用。
- `transcript:"off"` 现在有独立标签，清单会说明"这是主动关掉，不是这片子没人说话"。
- 一次出超过 8 张图时，清单提示"这是 wide pass，叙事内容用 SEQUENCE 更便宜也不剧透"。

### Fixed

- **`cells:1` 真的只给一帧**：旧版格内摊开会把它拼成 2×2（一格 4 个瞬间），
  清单仍写 "1 cell" —— 模型以为看到的是一帧。
- **`maxPerSheet` 以前只影响"建议格数"**：真正切张仍写死 16，参数看着生效了其实没有。现在两处同一个值。
- **token 不再写死 384**：按宿主 42px 网格、用实际出图尺寸算（1.2M 的图约 700）。
  旧口径只对 640k 成立，会让模型以为"多要几张不贵"。
- **#37：cell 表不再重复加窗口起点。** `t_start` 本来就是绝对时间（`planRanges()` 两条路都加过
  `winStart`），`saveCells()` 又加了一次 → `from>0` 或 zoom 之后 `video_zoom({cellId})` 会跳到
  2× 位置。顺手把"t_start 是窗口相对值"那句错误注释改掉，并给 `cells.json` 记录加 `v: 2`：
  `lookupCell()` 不认旧表，用户机器上已被污染的记录自动失效。
- **#38：热词/语言进了缓存键。** 旧键用入参 `hotwords ?? ''`，实际没传时用的是 `asr.json` 的值 ——
  改热词仍命中旧缓存，而且新的按片复用会把它放大成"换任何窗口都命旧缓存"。现在统一走
  `asrBackendId()`（`asr2|baseUrl|model|language|maxChunk|transcript|hotwords`），
  键和 `transcribeLong()` 的实参用同一个解析值；`asr2|` 前缀让旧缓存自然作废。`terms` 仍不进键。

### Docs

- `video_probe` 的读法建议改写：**叙事内容默认 SEQUENCE**（`from` + `segment`），
  STRUCTURE 明确标成"只用于辨认这是什么片 / 已有剧透许可时"，并删掉原来的
  `cells:16, sheets:4` 配方 —— 那正是 286×118 的来源。

## [0.5.3] - 2026-10-31

### Added

- **`quality`（`low` / `medium` / `high`，CLI `--quality`）** —— 直达"看不清"这个反馈。
  URL 模式下宫格图是用**下载的那份文件**拼的，原来写死 360p：4K 源缩到 360 再摊 2×2（123×68），
  字和细节全糊。现在 `low`=360p / **`medium`=720p（默认）** / `high`=1080p。
  本地文件不受影响（永远读原片）。`scanHeight` 保留为精确覆盖。
- FAQ 新增「关于钱和清晰度」两张表：**价位表**（一张图 384 token ≈ 0.011 元，
  格数不影响价格）和**清晰度表**（体积/耗时/什么时候选哪档），让人自己权衡。

### Changed

- **`video_storyboard` 默认下载清晰度 360p → 720p。** 代价是链接下载体积约 ×3，
  换来的是"字能认出来"。嫌慢显式传 `quality: "low"`。
- `quality` **只对 board 生效**：zoom 有 1080 高清直链，它的 `scanHeight` 只是本地兜底，
  抬高只会让每次 zoom 多下一份没人用的 720p。
- README 工具表从 4 个更新到 5 个（补 `video_subtitles`）。

### Docs

- **把"没配转写 = 只能看图说话"写到了显眼处。** FAQ Q1 和 README 都加了对照表：
  没配时问"她说了什么"只能答"画面里没有文字"；配了才能给原话和秒数。
  本机 ASR 免费、不联网、装一次十几分钟 —— 一次配好每部片子都受益。

## [0.5.2] - 2026-10-31

### Added

- **`video_subtitles`（第五个工具）** —— 把画面里的硬字幕一条条裁下来、纵向拼成一张长图，
  附每一条的时间码。补的是原来四个工具都不覆盖的一块：它们全是"按**时间**取帧"，
  没有"跨时间裁同一区域再拼接"。
  真实场景：没有字幕轨、ASR 也转不出来的片子（PV / 唱歌 / 双语艺术字）。实测那支 92 秒 PV
  只转出 4 段 35 字，而画面有十几句 —— 那种片子只能看。
  - 字幕带：`band` 显式 > OCR 检测 > 默认底部 16%（0.82–0.98）
  - `times` 只接受**可靠**时间码（字幕轨 / `video_locate`），绝不用 ASR 时间码去对齐
  - **串行**裁剪（一次一个 ffmpeg）—— 并行会撞 `0xC000012D`（提交内存超限）
  - 输出 JPEG q=4：同一张图 PNG 1804KB → **182KB**，字幕照样认得出

### Changed

- 默认字幕带 26%（0.72–0.98）→ **16%（0.82–0.98）**：实测字在 87%（中）/ 92%（英），
  原来的带子一多半是空画面。
- `band` 的说明补上了实测参考值（单行 0.86–0.98 / 双语 0.82–0.98 / 顶部 0.02–0.14 /
  居中歌词 0.40–0.60），并明确"按你看到的图自己调"。

### Verified（不是代码改动，是澄清）

- **ASR 没有坏。** 同一套 paraformer-zh：沧野（有口播）60 秒 → 10 段 / 280 字 / 4.67 字每秒；
  正式 PV（唱歌）92 秒 → 4 段 / 35 字 / 0.38 字每秒。差别只在素材，不在代码。
  唱歌 + 纯音乐 + 多语言艺术字本来就是语音模型的盲区（与"说话人分离不做"同源）。

## [0.5.1] - 2026-10-30

### Fixed

- **Windows 上 pip 装的 yt-dlp 一律找不到。** `findPipScript()` 里用了 `readdir()`，但文件顶部
  只 import 了 `readFile` —— `readdir` 是 `undefined`，抛 ReferenceError 后被
  `catch { continue }` 吞掉，函数**静默返回 null**。于是 `discoverYtdlp()` 的三个候选
  （`DSH_YTDLP_PATH` / PATH / pip Scripts）里第三条永远失效，报 `yt-dlp not found`。
  PATH 和 `DSH_YTDLP_PATH` 两条路都能用，所以这个 bug 一直没被认成"代码问题"，
  而被当成"用户没配环境变量"。修好之后实测能扫到
  `%APPDATA%\Python\Python313\Scripts\yt-dlp.exe`。
- 补 `test/ytdlp-discovery.test.mjs`：目录不存在时返回 null、能扫到 `Python3xx/Scripts`、
  有目录无程序时返回 null —— 锁住"找不到"必须是返回值而不是静默崩掉。

## [0.5.0] - 2026-10-30

### License

- **MIT → Apache-2.0。** 目的是更好地保护代码版权（要求保留署名），同时依旧允许大家自由使用、
  修改，甚至商用。此前基于 MIT 发布的版本仍然是 MIT，已经产生的衍生版本不受影响。
  新增 `NOTICE` 写明边界：不托管/不分发内容、缓存仅本地临时、不做付费内容与 DRM 绕过、不做批量抓取。

### Added

- **`video_storyboard` 的 `tileFirst`（CLI `--tile-first`）**：拿格数换分辨率。
  4×4 布局单格 247×137、摊 2×2 只剩 123×68，快剪素材在这个尺寸上出不了二宫格；
  降到 9 格（3×3 布局）单格 331×184，摊 2×2 / 3×3 都成立。**是取舍不是优化**：
  记管 MAD02 用它画面从 113 掉到 51，默认关。
- **`audio.rhythmProfile()`**：从能量包络的主导调制频率判"说话还是配乐"（见下）。
- 清单与 manifest 现在带 `audioClass` / `musicBasis` / `musicDetail` / `cell.meanMotion` ——
  **判定依据一起交出去**，模型看到"因为包络主导 4 Hz"才可能推翻它。

### Changed

- **音乐驱动的判据从"响度"换成"节奏"。** 原来 `meanLufs > -18 && speechRate < 1` 把两个
  不同维度的量"与"在一起，母带低一点的纯音乐片会被当成"有字"（正式 PV −18.4 差 0.4 就中招）。
  现在三档取证：有台词 → 只看台词密度；没台词 → 听 25 Hz 能量包络的主导频率
  （说话 1–2 Hz、配乐 3–4 Hz）；都没有才退回响度兜底。
- **子帧下限逐格判，不再由整片类型一刀切。** `meanMotion ≥ 3` 允许二重细分（下限 110×56），
  `≥ 8` 升到 3×3，更低保持整帧。记管 MAD02 曾被整片判成"说话型"，32 个画面一格不摊。
- **2×2 与 3×3 混着用**（`busyMotion`）：一格之内画面越热闹越值得摊细，安静的段落留大图。
  一张图因此读得出"哪里快哪里慢"。
- **积分采样点不再"音乐片更密"**：`equivSeconds` 音乐驱动 4 → 8。3 秒一格里塞 9 段是重复帧的来源。
- **长格子不受"刀/秒"密度门槛管**（`dur ≥ 12` 放行）：24 秒 8 个镜头算出来 0.33 刀/秒，
  曾被当成"镜头稀"而只给 1 帧。

### Fixed

- 一格 24 秒 8 个镜头只给 4 帧 —— 下限 / 预算 / 切张三处耦合，单独改任何一个都会被另一个抵消。
  `frameBudget` 64 → 96（帧数不等于 token）、`subBudgetFor()` 按镜头数算、下限放开到 110×56。
- **`Referer` 不再写死某个站点**：改用 URL 自己的 origin（防盗链检查的本来就是"是不是从本站点
  的页面点进来的"）。风控重试也从只看 412/567 扩到 429。

### Security / Compliance

- 文档与 `package.json` 去掉全部站点品牌词，URL 能力表述为"任意 yt-dlp 支持的站点（需自行确认授权）"。
- 代码审计：无去水印、无 DRM 绕过、无批量抓取/爬虫。唯一出现 `decrypt` 的地方是**错误提示**
  （告诉用户 Chromium 的 cookie 解不开，请导出文件），属于拒绝而非绕过。


### Changed

- **子帧下限按内容分流**：`200×112` 是为"看重字"定的（口播/字幕/讲义），但它一刀切也把快剪素材的
  二重细分全关了 —— 90 秒 PV 从 41 个画面塌到 9 个，盲评"覆盖"直接掉分。现在音乐驱动
  （响度高 + 几乎不说话）单独用 `160×90`：3×3 的 331×184 摊 2×2 得 165×92 刚好过线，
  4×4 的 247×137 仍然摊不动。**不全局降回 100×56**，那会让字幕素材重新变糊。PV 9 → 30 个画面。
- **补满空格不得新增 sheet**：多一张图就是多 384 图像 token，那不是"同 token 优化"。
  讲座 `48 格 3 张 → 64 格 4 张` 就是这种，现在会被拒（`skip-fill-would-add-sheet`），
  保持 48 格 3 张，**省 384 token**。黑场格顶过 16 的边界时同理：宁可把内容让出一格。
- **切张与渲染共用同一份"帧数测量"**（`measure.js` 的 `measureGroup()`）。
  此前切张用硬编码 `250×140` 估算每格摊几帧，渲染时又用 `layoutCanvas()` 的真实尺寸再算一遍。
  子帧下限提到 200×112 之后两者必然打架：`250×140 → k=1`（1 帧）而 `505×312 → k=2`（4 帧）——
  `planSheetsByFrames()` 名义上按帧数切张，实际按一套**错的帧数**在切。
  现在布局、每格 k、总帧数只有一个答案，渲染直接消费测量结果，不再自己重新决定。
- **黑场格封顶 25%**（至少 1 格、最多 4 格）。一格纯黑几乎不带信息，却和真帧同价：
  实测 90 秒概念 PV 有 6 段 ≥2 秒黑场，不封顶就要拿 6 格画黑屏，整张图一半是黑的。
  超出的黑场并入相邻内容格。PV 暗格 4/9 → 1/9。
- **子帧下限 100×56 → 200×112**：摊开的判据从"能分辨不同镜头"改成"能认出内容"。
  实测（640×360 扫描源、640k 画布）：4×4 摊 2×2 得 123×68、3×3 摊 2×2 得 165×92，
  字幕和 UI 标签都认不出（盲评可读 1~2 分）。改完 3×3 / 3×4 / 4×4 一律不摊，
  只有 2×2 的 505×312 还摊（得 252×156）。**同 token 下帧数变少、每帧变清楚**。
- **近乎静止的素材不再按变化量分格**：`p90 < 1`（讲义、监控、固定机位口播）时退回按时间等分。
  密度驱动的前提是"变化多的地方更值得看"，而这类素材的切点全集中在几页翻页动画上，
  实测 66 分钟讲座 16 格里 6 格是同一页的不同配色。

### Fixed

- **空格位不再浪费**：13 格排 4×4 会空 3 个黑位，黑位和真帧同画布、同 token —— 空着是纯损失。
  现在按布局容量向上补满（13→16、10→12），一张图里不再出现黑块。
  黑场格先记账再分格（原来 `contentTotal` 没扣黑场，总数必然溢出容量）。
- **清单与 evidence 标出黑场格**：`cell.dark` 以前写进了结果却没人读。现在清单里那一行带
  `dark/transition — this stretch of the source is black or a transition, not a capture failure;
  titles or text may still be visible`，`evidence.json` 里也有 `dark: true`。
  措辞不用"无内容"：实测 PV 的暗格里还有 logo 和演职员表。
- **黑场之间的内容配额改为精确分配**（`plan.allocateIntegerBudget`，最大余额法）。
  原来每段各自 `Math.max(1, Math.round(份额))`，一段一段往上报，总和会超出总格数
  （实测 24 格算出 25 段），多出来的格只能靠下游"补满"或"按容量砍"兜住。
  现在段数恒等于总格数，"补满"不会再被这个偏差触发成越补越多。
- `planInfo` 新增 `requested` / `trace` / `frames`：分别记录"用户要的格数张数"、
  "中途被谁改过（补满 / 黑场额外占格 / 切张重排）"、"planner 认为会画多少帧"。
  `frames` 是可验收量：清单里 Σ(cell.sub²) 必须正好等于它（有 e2e 测试盯着）。
- `planInfo.cells / planInfo.sheets` 是分格**之前**的快照，之后"黑场占格 / 补满 / 按帧切张"
  改了实际值却不回写 —— 清单报 12 格 1 张、实际出 25 格 2 张。现在写最终生效值。
- **清单头一行写实际格数**：以前写 `plan.cells`，多张时那只是"每张多少格"
  （64 格 4 张写成 `grid="16 cells x 4 image(s)"`），单张时被最小间隔卡住又会虚报
  （用户实测：要 16 格只出 8 格，头一行仍写 16）。现在写实际值，被卡时追加 `(asked 16)`。
- **`asr.json` 改完不必重启宿主**：`ASR_DEFAULTS` 原来是模块加载时的快照，改配置必须重启整个 DSH
  （用户实测反馈）。现在按文件 mtime 记忆、`ASR_DEFAULTS` 改成活视图，改完下一次调用即生效。
- **probe 改用回调式 `execFile`**：某些宿主的 `promisify` 会丢掉 execFile 的 custom symbol，
  只返回 stdout 字符串，取 `stderr.length` 直接 TypeError —— 报出来却像是 ffprobe 坏了。

### Added

- **`node bin/doctor.mjs`（`npm run doctor`）**：一条命令查完 ffmpeg / ffprobe / yt-dlp /
  ASR / 缓存目录，每条后面直接跟"缺什么、怎么补"。用户反馈里过半不是 bug 而是配置。
- **`docs/入门-五分钟.zh.md`**：手把手教程，每步都写"你应该看到什么"。
- **`docs/FAQ.zh.md`**：17 条，全部来自真实反馈（"听不见声音""卡在 ffprobe""下载越下越慢"
  "minGap 不生效"…），每条给症状原话 / 真因 / 处置。

### Added

- **积分采样点（假切点）**：扫描之后沿时间累加画面变化率，累够阈值就记一个采样点并清零。
  这些点作为**额外的分段边界**并进每一格的 `shots`，于是"变化攒得多的地方自然多分几段、
  多取几帧"，而静止的段落一个点都不加、仍然是整帧一张。
  阈值 = 全片平均每秒变化量 × `equivSeconds`（默认 6 秒；音乐驱动 4 秒）——
  这是音频驱动唯一该动的数，格数与张数都不受影响。
  采样点**不进 `cuts`**：清单里"切点 N 个"必须是真切点，否则等于告诉模型"这里有一刀"。
- **黑场段独占一格**：亮度连续低于 12 且 ≥2 秒的黑场单独成格（`cell.dark`），
  不再和后面的 logo/正片挤在一起、结果取到一张纯黑。
- **rodt 分格**：每格长度 ∝ 1 / 该处切点密度（累积切点等分实现），
  实测最密与最疏能拉开 4.6~5.5 倍，取代按密度积分/按镜头数均分。
- **按累计帧数切 sheet**：先排好画面，再沿时间累加每格贡献的 `k²`，累到预算切一张。

### Fixed

- `sheets` 的参数上限是 4，而自动档按帧数能算出 5、8 张 —— **自动能做的事，手动反而做不到**。
  上限放开到 1..16（与 `cells` 对称）；自动档不受这个数约束，仍由帧预算决定。
- `pipeline` 里 `spawnImpl: spawn` —— 0.4.4 里这个 import 是有的（`import { execFile, spawn } from 'node:child_process'`），
  拆成 `src/storyboard/` 时丢了。之后每次运行都 `ReferenceError`，被外层 catch 吞成
  `asr-failed · spawn is not defined`，转写因此一直是空的。
- `plan.pick()` 只有四个形参，调用处传的第五个 `musicDriven` 被丢掉 → 返回值里恒为
  `undefined` → "音乐片取帧更密"（`minMotion` 1.5→0.7）写了却从没生效过。
- 扫描缓存不保存 `darkRuns` → 命中缓存时黑场并回内容格，同一支片子第一次跑和第二次出图不一样。
  （`CACHE_VERSION` 3 → 4，旧条目自动失效。）
- `planSheetsByFrames` 是贪心的，最后一张常常只剩一两格：实测 18 格切成 16+2，
  2 格按 `bestLayout` 排成 1×2（715×843 的竖长条），两个格子各占 707×396。
  改成先算张数再均摊，18 格 → 9+9。
- **长而静的素材被严重欠采样**：格数只按"每格 8 个镜头"算，于是 66 分钟讲座
  （150 刀）算出 19 格 → 口播降档 → **12 格看 66 分钟**（每格 5.5 分钟）。
  加一条「单格不超过 90 秒」的兜底（且不超过镜头数），口播降档也不能低于这个兜底：
  同一支片子变成 16 格 × 3 张（每格 82 秒）。快剪素材不受影响（它们的镜头数口径本来就更大）。

## [0.5.0] — 2026-10-30

### BREAKING — co-watching is now a separate package

`video_watch` / `watch_together` **is no longer in this plugin**. It is its own package,
**`dsh-watch-together`**, starting at `0.1.0`:

```bash
npm i dsh-watch-together        # this also installs dsh-video-storyboard
```

Why: the two are different products. One turns a video into a citable grid; the other follows the
user's playback position and keeps talking. Bundling them meant `dsh-video-storyboard` carried a
Windows SMTC probe, a chat server, an HTTP page and a speech seam that had nothing to do with
video recognition — and anyone who only wanted a storyboard got all of it.

This package now ships **four** tools: `video_storyboard`, `video_zoom`, `video_probe`,
`video_locate`. It has **zero** imports from co-watching, and never will — the dependency is
one-way (`watch → storyboard`).

Migration:

- **You used `video_watch` / `watch_together`** → `npm i dsh-watch-together`, then keep calling the
  same tool. The parameters are unchanged; only the package that provides it moved.
- **You only used the storyboard tools** → nothing to do. `dsh-video-storyboard@0.5.0` drops code
  you were not calling, and its four tools are untouched.

Everything that was in the `[Unreleased]` section before this release — the speech seam, the
path-loaded voice adapters, `examples/voice-edge-tts`, `examples/floating-chat`, the single text
stream, the `video_watch → watch_together` rename — moved with the feature and is documented in
`dsh-watch-together`'s CHANGELOG under `0.1.0`.

### Added

- **Seven more public subpaths**, because `dsh-watch-together` needs them to build a segment:
  `./board`, `./cache`, `./storage`, `./locate`, `./subtitles`, `./ytdlp`, `./python`,
  `./browser-time`. They were always there as files; now they are a stated contract.
- **`test/schema-audit.test.mjs` now audits this package only.** The same audit exists in
  `dsh-watch-together` for `watch_together`, including a check that the entry point never
  registers a `video_*` tool.

### Kept on purpose

- `boardOptions()` still accepts `kind: 'watch'` (5 cells, `minGap: 0.5`, `adaptive: false`) —
  `dsh-watch-together` calls it for those numbers instead of keeping a second copy.
  `test/board.test.mjs` pins the values.
- `cache.js` `PROTECTED_FILES` still protects `watch.json` / `latency.json` / `seen.jsonl` /
  `cells.json`. Both packages share one cache directory, so pruning from this side must not delete
  the other side's data.

### Removed

- `src/watch/` (27 modules), `src/watch_smtc.py`, `test/layering.test.mjs` (the import rule it
  enforced is now a package boundary), 22 test files, `examples/`, `scripts/watch-sim.mjs`,
  `scripts/watch-e2e.mjs`, `docs/WATCH.zh.md`.
- `scripts/start-edge-debug.cmd` moved to `dsh-watch-together/scripts/` — it exists to read
  `video.currentTime`, which only co-watching needs.

## [0.4.5] - 2026-10-30

### Fixed

- **The cell map was never written (video_zoom `cellId` never resolved).** `runStoryboard` ended with
  a bare `return {` instead of `const result = {`, so `saveCells()` and the final `return result` were
  unreachable dead code. It now assigns, awaits `saveCells`, and returns the result. `cellId` lookups
  were broken for every storyboard since 0.4.4.
- **Cell lookup by URL.** A remote video is addressed by URL but downloaded to a temp path; only one
  of the two was stored, so the other always returned NOT FOUND. `saveCells` now takes aliases and
  writes the same record under each.
- **`spikeCuts` local-window median used the wrong indices** when `lo > 0`
  (`slice(i - lo + 1, hi - lo)` indexes the whole array, not the neighbours), so a real cut could be
  dropped.
- **Bilibili DASH audio (PR #19, issue #18).** `formatSelector` now requires `[acodec!=none]` on the
  progressive branch, and `fetchMedia` hands yt-dlp our ffmpeg so video+audio actually merge. The
  manifest now separates "unmerged-dash" from "silent source" — cookies do not fix the former.
- **`paused` false positives.** It was read straight from the DOM, and reported paused while the video
  was playing (observed: 8.6 s of progress over 66 s of wall clock, then a jump to 01:24). Now three
  signals must agree: `video.paused`, whether `currentTime` actually advanced, and a `staleMs` marker
  so "really paused" is distinguishable from "cannot read". `rawPaused` keeps the DOM value.
- **`waitForVideo` only waited when the source was unknown.** A video page being open is not the same
  as a readable position; the wait loop was skipped in exactly the most common case (page open, play
  not pressed). It now waits for `pos > 0.5 || playing` and reports `waitedSec`.
- **Enabling `tts` mid-loop had no effect.** `samePlan` compared input/sessionId/segment/ramp but not
  `tts`, and `loop.tts` was only assigned when creating a loop — so `speakNow` followed by
  `lines + tts:true` resumed forever with `tts = null`. The loop never ran in TTS mode. Same for
  `wakeOnLinesEmpty`.
- **The same video opened twice on every cold start.** `ensureBrowser` checked `sameTarget()` right
  after `launchBrowser` had already been handed the URL, while the tab was still `about:blank`, and
  opened a second one. It now waits up to 4 s for the tab to load.
- **Scheduled task name embedded the port**, so every port change left another task behind (two were
  found on disk). The name is fixed; port-suffixed leftovers are cleaned on each launch.
- **Edge path was hardcoded to the x86 location**, which does not exist on this machine and kills
  auto-launch on Chrome-only setups. Both Edge locations plus both Chrome ones are now tried.

### Added

- **`chat.js` — a localhost chat box shared by the CLI and the plugin.** Host input boxes do not reach
  disk while a tool call is blocking (measured: a message sent at 03:05:35 landed after the 03:05:52
  turn), so this is the only channel that can be heard mid-wait. The wait loop polls it every 500 ms.
- **`attachOnly`** — never launches a browser; returns an error if no position is readable. For users
  who do not want the plugin touching their browser.
- **`wakeOnLinesEmpty`** — with TTS on, a finished line used to mean silence until the user spoke;
  this wakes once when the current segment runs out of pre-written lines.
- **`at` accepts a transcript substring** instead of a number: the anchor is looked up, not guessed.
  Hand-written seconds put one batch 58 s early, and the user saw words describing a shot that had
  not happened yet.
- **edge-tts neural voices with SAPI fallback.** `speak()` now tries edge-tts first
  (`zh-CN-XiaoxuanNeural` and friends) and only falls back to SAPI when synthesis or playback fails.
  `edgeVoiceFor()` maps `"Huihui"` / `"zh-CN-XiaoxuanNeural"` / nothing to a real neural name — before,
  a neural name matched no SAPI voice and silently fell back to the system default, which is why
  passing a voice changed nothing.

### Changed

- **Late tolerance 6 s → 3 s.** A dense batch at 7 s spacing drifted 9 s and never caught up; a line
  is now dropped rather than pushed later, because a late line describes a shot that has moved on.
- **`tts` and `spokenAloud` are reported in `loopStatus()`**, so "is the voice actually on" is
  answerable instead of guesswork.


### Added

- **`video_watch` — the model watches and writes, the script speaks on cue.** Lines are a queue the
  script fires from (`lines: [...]`), so the model never waits for a clock and never re-reads its own
  line at the moment of speaking. `src/tts.js` voices them through the OS voice (SAPI via COM):
  0 tokens, 0 seconds of model time. There is deliberately **no default cadence** — `speakEvery`,
  how many lines per segment, and whether to speak at all are the caller's decision, and silence
  is a valid one.
- **Blocking waits that are conditions, not timers**: `waitUntil` (block until playback reaches a
  position) and `waitForRefill` (block until the line stock drops below `refillBelow`, which stays
  off by default).
- **`nextLine`** returns one line at a time, so a delivered line reads as a message instead of a dump.

### Changed

- **Everything gives up when the playhead stops moving.** A blocking wait, the background loop and the
  speaking script all had open-ended lifetimes: a backgrounded tab, a stalled buffer or a user who simply
  walked away left them polling forever, holding the session. The idle limit is twice the longest batch
  (a 5-minute batch means 10 minutes), overridable with `idleTimeoutSec`; the wait returns
  `reason: "idle"` with where it stopped, the loop stops with `idle`, and the script exits.
  The loop only counts it when the position is being read *freshly* and simply not moving — a timeline
  that cannot be read at all is a different case (ask once, then stop), and must not be masked by this.
  The loop only counts it when the position is being read *freshly* and simply not moving — a timeline
  that cannot be read at all is a different case (ask once, then stop), and must not be masked by this.

- **Finding the video is polled fast, and probing SMTC is not on the same clock.** The wait loop used to
  sleep two seconds and *then* spawn the SMTC python probe, so one check could cost 2 s + the probe's own
  latency — the user could already be 30 s into the video while it still insisted nothing was playing.
  The browser (CDP, milliseconds) is now polled every 300 ms; SMTC every 2 s with a 1.5 s timeout. The
  delivery wait and the speaking script dropped from 2 s / 1.2 s to 500 ms, so a line or an image lands
  within half a second of its cue. Waiting time is now measured from the clock instead of counted in ticks.

- **The look-ahead is measured from the playhead, not from the segment start** (`windowFor()`). Counting
  segments only guarantees five minutes when the user is at a boundary; a 60 s batch plus a 120 s batch
  is three minutes of coverage no matter how it is counted. The window now extends until
  `pos + lookahead`, and both the loop and the one-shot path use the same function.

- **The loop contract is in the tool description, not in someone's head.** Five rules — one batch per
  call, write the lines for the named window immediately, anchor `at` on `frame@`, then block like an npm
  publish (no timers, no background jobs, do not end the turn), repeat. Plus the speaking side: a line is
  read only while playback and `at` agree within six seconds, late lines are dropped rather than read out,
  consumed lines are deleted so a rewind cannot replay them, and two utterances are at least six seconds apart.

- **`wait: true` now builds the look-ahead window before it blocks.** The buffer used to be one
  background segment, kicked off after the current one and (by default) not at all — so the picture
  the user needed at the end of the next batch was still being built when they got there, and there was
  no moment at which lines could be written for it. Blocking now presupposes the future is ready: every
  segment inside `lookahead` is built first (capped at four per call), and the reply names the window
  (`[buffer] … 词就写这个区间`), so the lines cover exactly the same span the pictures do. When the call
  is already due, prefetch moves back to the background so delivery stays fast; `prefetch: false` still
  turns it off.

- **One place decides what a storyboard run is** (`src/board.js`). `video_storyboard`, `video_zoom` and the
  co-watch path each hand-wrote the `runStoryboard` defaults, and the copies had already drifted: only the
  storyboard tool had `detail`, so co-watch was stuck at a hard-coded 80 characters per cell; the
  "ocr when detail=high" rule existed in one of the three; zoom pinned `scanHeight` while the storyboard
  tool let you pass it. The defaults live in one function now, which is why `detail` / `ocr` reached
  `video_watch` without a second copy of anything. What stays per-kind is deliberate: the batch table
  (minutes) is not the frame plan (density), and only co-watch has delivery timing.

- **`mm:ss` had two implementations that disagreed at the boundary**: 59.6 s was `01:00` in one and
  `00:60` in the other. One implementation, with a carry (`src/time.js`), plus a test for it.

### Fixed

- **Lines are pinned to a moment (`at`), and fired by playback position.** The script used to speak
  one line every `speakEvery` *wall-clock* seconds, with lines keyed to a 60-second batch: four lines
  written for 02:00–03:00 were all spent by 02:36, so the voice ran half a minute ahead of the picture
  and the last line of the batch was never reached at all (observed in a real run: 02:26 / 02:38 /
  02:50 / 03:03 …). Each line can now carry `at`, the second it describes; the loop asks "what is due
  at *this position*" instead of "has N seconds passed". Pausing pauses the script, seeking moves it.
  A line that is more than 10 seconds late is discarded rather than spoken over the wrong shot.

- **`speakEvery` no longer doubles as the TTS cadence**, and a TTS loop no longer wakes the model at
  batch boundaries: if nothing is due, the script stays quiet — deciding that there should be more words
  is the model's job, not the clock's.

- **The look-ahead is a duration now, not a segment count.** "Keep two batches ready" means two minutes
  at the start of the ramp, where batches are 1/2/3 minutes — shorter than one slow build, so the buffer
  was effectively nothing right when it mattered. `lookahead` (default 300 s) states how much *ready video*
  must sit ahead of the playhead; short batches are compensated automatically (60+120+180 at the start,
  300+300 once steady). `depth` still works when passed explicitly, for tests and for callers who really
  want a segment count. `lookahead` had been declared in the tool spec for a while but never wired into the
  loop — declared, documented, ignored; it is connected now.

- **A grid never leaves a blank slot when the layout is what created it.** Asking for 5 cells picks a
  2×3 layout, which left the bottom-right slot painted as padding — the same canvas, the same token,
  one frame thrown away. Cell counts are now rounded *up* to the layout capacity (5 → 6, 7 → 9,
  10 → 12) and the manifest says so (`6 cells (filled from 5 — …)`). Padding that comes from `minGap`
  or a too-short window is left alone: that one is a fact about the material, not a rounding error.

- **`wait: true` no longer loses a segment.** `lastDelivered` was written *before* the "not due yet"
  return, so every silent call marked the current segment as delivered; the next call that reached
  the due point inside its wait loop had its delivery suppressed and hung until the cap — the segment
  arrived one call late. The bookkeeping now happens only on the delivery path, and a wait that
  hits an already-delivered segment returns immediately instead of hanging.

- **`src/index.js` unregistered its own session listener.** `disposers.push(off)` ran before
  `const disposers` was declared, so it threw a TDZ ReferenceError that the surrounding `catch`
  swallowed: the listener was registered, its disposer never was. The array is declared first now,
  and a failure to hook `session/event` is logged instead of disappearing.

- **`docs/WATCH.zh.md` repeated the Bilibili-subtitle section twice.**

## [0.4.4] — 2026-10-29

### Fixed

- **`video_zoom` swallowed `minGap`, so every zoom ran at 1.2 s.** The parameter is in the tool spec and in
  the validator, but `src/index.js` builds the storyboard options field by field and that list never included
  it — declared, validated, never wired. Short-form editing is exactly where a small gap matters: asking for
  4 cells across 1.6 s returned 2.

  Reported with a reproduction (`video_zoom({ from: 12, to: 15, cells: 6, minGap: 0.4 })` → 2 cells instead
  of 4). Now passed through, and the same call returns the cells the geometry allows.

- **When `minGap` does trim the count, the plan line says so.** It printed the requested number at the top
  (`16 cells`) and the real one at the bottom (`total 8 of 8`), which reads like a bug. It now prints
  `4/6 cells (minGap-limited)`.

### Added

- **`video_zoom({ cellId })`** — reference a cell by number instead of copying timestamps. The last storyboard
  writes `{cell: absolute from/to}` to the cache, so a zoom resolves `cellId: 3` to the cell labelled 3 even
  after parameters change; it errors clearly (rather than guessing a window) when no map exists. Suggested in
  issue #4: timestamps drift once you change the window or the file, and a reference that cannot be replayed
  is not a reference.

- **`planThresholds` is now configurable** (`musicLufs` / `musicSpeechRate` / `speechRateCut`), from issue #4.
  The defaults (−18 LUFS / 1 char·s⁻¹ / 3 char·s⁻¹) were tuned on one master, and loudness spans 9 LU across
  material — a constant that misfires on the next batch is worse than no constant. The values that actually
  applied were already printed; now they can be overridden per call.

- **Hard-coded subtitles now correct the transcript** when `detail: high`. ASR mishears names and particles
  (「他也忘记。」 for a line that actually reads 「你连，也要忘记吗」); the burned-in text is the authority.
  The pass is deliberately cheap: one detection pass over three full-resolution frames locates the subtitle
  band (~3 s), then each sampled line is OCR'd as a band crop **without detection** — 0.26 s instead of 3.1 s.

  It replaces text only when the OCR covers ≥60% of the ASR characters in order, and it trims the matched span
  so the neighbouring line does not leak in. Measured on a music-video sample: 1 of 3 lines fixed, the rest
  left alone. Runs locally, so **no extra tokens** — versus ~34,500 tokens if the model read the subtitles
  frame by frame. Silently skipped when rapidocr is not installed, and it says so rather than pretending.

### Docs

- The `tokens=` figure now states its basis: `384 (est@384/img, DSH host billing; an API host bills by
  pixels)`. Issue #4 was right that "384 token" is unreadable without saying who charges that — the real
  pixel dimensions were already next to it.

- Sponsor entry: `.github/FUNDING.yml` (custom link to the WeChat reward code) and a README section, so the
  repo shows a Sponsor button without requiring GitHub Sponsors, which is impractical from mainland China.

### Changed

- **The OCR line says "spot-checked", not "verified".** It is 16 sampled lines, so the manifest now reads
  `on-screen subs: spot-checked 16 lines, corrected 1: …` — anything that could be read as "the whole
  transcript was checked" is wrong, and a test asserts it.

- **URL sources say the correction ran on the low-res copy.** With a Bilibili link the OCR runs against the
  downloaded 360p scan, where hardcoded subtitles are already blurry and `scale=1280` invents no detail. The
  line now carries `[from the 360p scan copy]` instead of implying source-quality evidence.

- Nothing is printed when the pass changed nothing — that is the expected default and only costs tokens.

- Segments dropped as non-speech now say what they most likely are ("singing or music, NOT dialogue") and
  that they are **excluded rather than guessed**.

### Fixed

- **No-key runs no longer claim ASR listened and found no speech** (contributed by @ggfgfgf-on, PR #16). When the cloud backend had no key, the
  cache wrapper turned the `null` "not attempted" result into a truthy empty object, so the manifest said
  `asr-empty` — "ASR ran and found no speech" — even though no request was sent. `withCache` now preserves
  `null`/`undefined` and does not cache it; the key/local gate is shared by `transcribe()` and the manifest,
  and a new `no-key` source says explicitly that transcription was **not attempted**. This is separate from
  `asr-empty` (it really ran and returned zero segments), which still means "ran, heard nothing".



## [0.4.3] — 2026-10-29

### Headline: the ASR path was the weak spot

Three failures, all reported by users within a day, all the same shape — **something we could have known was
treated as something we could not**:

1. **A local service was gated on a key it never checks.** `if (!key) return null` skipped transcription for
   anyone running FunASR on their own machine, where `Authorization` is not even looked at.
2. **The service started and was never stopped.** It sat at ~6.8 GB of commit charge and took the host down
   three times during a video edit. It is now started on demand and asked to leave when the run ends.
3. **A long scan could kill it mid-run.** The idle timer was armed at the *end* of a run, so a run that spent
   longer than the window scanning found the endpoint gone.

The runtime also moved from FunASR to **sherpa-onnx** (cold start 30 s → 5 s, 2.1 GB → 500 MB), and the model
got newer — `paraformer-zh-2024-03-09` fixes homophones that previously needed a hotword.

### Added

- **Hotwords: a word list that biases decoding, so homophones stop winning.** `"hotwords": "像差 焦段 光圈"`
  in `asr.json`, sent as a `hotword` form field. seaco_paraformer supports it natively. Measured on a lens
  review: *"也就是所谓的**相差**"* → *"也就是所谓的**像差**"* with one word added, no other change.

  This matters more than swapping models: the transcription was already fluent, the misses were homophones
  (像差/相差) that no general model resolves without knowing the subject.

  Server-side: `start-asr.cmd` now takes `ASR_BACKEND=sherpa|funasr`; `sherpa` is the default.

### Changed

- **The local ASR service now runs on sherpa-onnx by default.** Same HTTP contract, different runtime:
  **cold start 30 s → 5 s** (measured through the plugin, model load alone 1.9 s), models **2.1 GB → 500 MB**,
  no torch. The model also got newer: `paraformer-zh-2024-03-09` gets 「像差」 right without any hotword,
  where the old one needed one.

  What it costs: sherpa's paraformer has **no timestamp output and no hotword interface**. Timestamps are
  rebuilt by running VAD (silero) over the audio and recognizing each speech run, then splitting sentences by
  punctuation and distributing the run's duration by character count — honest to about a second, and the
  first version (hard-cutting every 15 s) **dropped words at the seams**, so the runs are no longer cut.

  Hotwords still work on the `funasr` backend (`ASR_BACKEND=funasr` in `start-asr.cmd`); on sherpa they are
  ignored and the `terms` table is the fallback.
- **The idle window is now 10 minutes, and the backstop moved to 30.** Cold start costs 30 s, so a 2-minute
  window meant re-paying it constantly. The rule is now literally "10 minutes after the last run, with no new
  run in between, stop it". `manage.idleMs` still overrides per machine. The server's own `ASR_IDLE_EXIT_S`
  went from 600 s to 1800 s — a backstop must be *longer* than the caller's timer, otherwise it closes an
  instance that is still in use.

### Fixed

- **`manage.start` pointing at a `.py` file silently did nothing.** Spawning a script on Windows is not a
  command, so the service never came up and every run reported `asr-failed · ECONNREFUSED` — looking like
  "auto-start is broken". `start` is now normalised: a `.py` path is wrapped with the interpreter from the
  sibling `.venv` (falling back to `python`), so both `"D:/asr-local/server-sherpa.py"` and
  `[python.exe, server-sherpa.py]` work.
- **Hotwords were global, which makes them a negative bias on the wrong subject.** A list tuned for a lens
  review (像差 焦段 光圈) was still being applied to a materials-science lecture. `video_storyboard` now takes
  a per-call `hotwords` that overrides `asr.json`, the cache key includes it, and the README says plainly that
  the global list is a default, not a policy.
- **A login-gated video was read anyway, and the result was presented as if complete.** When Bilibili hides
  the subtitle list from anonymous requests (`need_login_subtitle: true`), the pipeline used to report
  "no subtitle" and move on — so the model ended up reading burned-in text off the pixels and calling it a
  transcript.

  Now the site's own flags (`need_login_subtitle`, `is_upower_*`) are carried through as `needLogin`, and both
  the probe output and the storyboard manifest say so plainly:

  ```
  !! NEEDS LOGIN — this site hides subtitles from anonymous requests (auth=anonymous).
     Do NOT guess the dialogue from burned-in text or scenes.
     Ask the user for cookies before trusting any transcript…
  ```

  The point is to stop and ask, not to produce a confident answer from a source we never had.
- **A console window popped up on every conversation, spewing `'wo' is not recognized`.** Two causes:
  the ASR service was launched through `start-asr.cmd`, which allocates a console when the spawner is a GUI
  app, and that `.cmd` had been rewritten with **LF line endings** (plus Chinese comments) — cmd.exe then
  executed fragments of the `REM` lines as commands.

  `manage.start` now accepts an array (`[exe, ...args]`) and the default config uses it, spawning
  `python.exe server-sherpa.py` directly with `windowsHide` — no console, no batch parsing. `start-asr.cmd`
  was rewritten with CRLF and ASCII-only text for the cases where a human runs it by hand.
- **Stale cookies silently capped quality at 480p.** Reported against BV1HHns6oE4G: the manifest said the source
  had no 1080p, while the browser clearly did. Measured with the user's own `bili-cookies.txt`:

  ```
  with cookies:      [480, 360]
  without cookies:   [1080, 720, 480, 360]
  ```

  An expired or low-privilege `SESSDATA` makes Bilibili hand back a *shorter* format list — the plugin then
  believed it and reported "no 1080p source", which was true of the request and false about the video.

  Both the probe and the download path now go through one `probeSummary()`: when cookies are configured and
  the result caps at ≤720p, it probes once more anonymously and keeps whichever list is taller, recording
  why (`cookies 只允许 480p，匿名反而能拿到 1080p —— SESSDATA 可能过期…`). Verified: that URL now reports
  max 1080, `zoomTarget` 1080 and a 1080p direct link.
- **Bilibili's HTTP 567 now says what it is and tries once more.** 567 is their risk control, not a format
  problem — most often a video that needs a signed-in session (1080P+, 会员/付费) or a rate-limit. Before, the
  message was yt-dlp's raw text, which reads like a plugin bug.

  **Docs gap this exposed**: `docs/SETUP.md` had a full cookies walkthrough all along, but the README — the
  page people actually land on — never mentioned cookies at all. There is now a "needs a signed-in video"
  section there: when it is needed, the three steps with Cookie-Editor, both config paths, the local-file
  alternative, and the reminder that `SESSDATA` is a login credential.

  Now: one automatic retry with a browser User-Agent, `Referer: https://www.bilibili.com/`, and
  `--sleep-requests 1` (the retry only fires on 567/412, never on permanent errors); if it still fails, the
  error names both ways out — a cookies.txt, or download the file and pass a local path. `--retries 3
  --fragment-retries 5` also went into the base args, since CDN hiccups are routine.
- **A partial download was wiped on failure, so every retry started from zero.** On a flaky connection the
  media directory was removed (`rm -rf`) whenever yt-dlp exited non-zero — including the `.part` file that is
  the whole point of resuming. Reported as "下到一半直接清零重新开始，而且下得更慢". Now the directory is
  kept and `--continue` is explicit; stale parts are pruned by age instead.
- **Progressive streams were never tried, so every Bilibili download was a DASH pair plus a merge.** The
  selector jumped straight to `bv*+ba`. It now tries `b[height<=N]` (one file, no merge) first and falls back
  to DASH — the scan copy only needs 360p, and a single stream is both faster and less to write.
- **A slide deck that "looks the same on every page" produced no cuts at all.** With an absolute threshold,
  a page turn that only changes a few characters scores 3–8 and disappears under any sane floor, so the
  result fell back to equal intervals. Very static films (median score < 3 **and** fewer than 0.1 cuts/s) now
  re-read with the relative-baseline detector (`spikeCuts`), which compares each frame with its local
  neighbourhood instead of a global number. Measured: a slide where a small block appears went 0 → 1 cut;
  the concept PV stayed at 44 (the guard is what keeps it from doubling — without the rate condition it went
  44 → 88).

  The absolute floor is 4, measured: on a 320×180 capture, changing ~3.5 % of the frame peaks at **5.7** and
  ~8 % at **11.8** — both under any sane threshold (12–15), while a still frame's noise floor is 0.0–1.5.
  Below ~1.5 % area the change is 1.6 and nothing can call that a cut; that limit is documented rather than
  papered over.

  An e2e test builds exactly that fixture (a block appearing at t=2 on an otherwise still frame) and asserts
  the cut is found — the guard for "the function exists, the unit test is green, and nothing calls it".
- **A long scan could let the idle timer shut the service down mid-run.** The timer is set when a run ends,
  so a *new* run that spends more than `idleMs` scanning (before it ever asks for a transcript) would find the
  endpoint dead and pay the 30 s cold start again. Any new run now renews the lease at entry, and the timer is
  re-armed on exit even when that run never touched ASR.

  The failure mode was a wasted restart, never a wrong result: the endpoint is probed before transcribing, and
  a dead one is started before the request goes out.

### Performance

- **Transcription now runs while the scan runs.** It only needs the silence positions (from the 1–3 s audio
  pass), not the cut points, so it was always safe to start early — it just never was. A 21-minute screen
  recording went **202 s → 89 s** (scan 82 s, transcription finished inside it, frames 3.4 s). A 5-minute
  window: 31.7 s with `transcript` at 0.03 s, i.e. fully overlapped.

  Two things broke on the way and are fixed: the transcript block moved ahead of a `let asrLife` declaration
  (`Cannot access before initialization`, which silently turned the first measurement into `asr-failed` while
  still showing a fast time), and the block's `textInSilence` had to be returned rather than captured.
- **Frame extraction runs in parallel.** Nine cells used to be nine sequential ffmpeg calls (each one seeks
  and decodes a single frame). The loop is now plan → concurrent extract → assemble in order, at
  `frameConcurrency` (default half the cores, capped at 8). Measured on a 90 s clip with 9 cells: **13.3 s at
  1, 8.0 at 3, 6.5 at 5, 4.0 at 8**; whole run 18.0 → 12.2 s with transcription on. Cell order and the
  sub-tiled fast-cut cells are unchanged (verified visually).

  `result.timing` now carries per-phase seconds (`audio`/`scan`/`transcript`/`frames`) so the next slow
  report can start from numbers instead of guesses. Caveat: part of the 202 → 89 s is the OS file cache
  warming between the two runs — the honest structural gain is the ~58 s of transcription, not 113 s.

### 为什么"相对基线"之前没生效

## [0.4.2] — 2026-10-28

0.4.1 shipped a broken tool and a key requirement nobody could justify. Both reported within an hour.

### Fixed

- **`video_locate` crashed on every call** in 0.4.1: `src/index.js` used `recallSegments` / `matchSegments` /
  `formatMatches` without importing `./locate.js`, so the tool threw `ReferenceError` the moment it ran.
  The registration test exercised storyboard and zoom but never locate — it does now, and that is the guard
  for this exact class of mistake. Reported by @盲目吃鱼豹豹 with the one-line patch.

- **A local ASR service no longer needs a `key`.** Any transcription without a key was skipped outright, so
  self-hosted FunASR users were told "configure a key to actually listen" while their service was running fine
  two ports away. Loopback base URLs (`127.0.0.1` / `localhost` / `[::1]`) now send no `Authorization` header
  and are not gated on a key. Cloud endpoints still require one — without it we skip rather than 401.
  Reported by @小观棋.

### Docs

- New README section on subtitles and ASR: which models we actually use (`paraformer-zh` + `fsmn-vad` +
  `ct-punc` locally, `FunAudioLLM/SenseVoiceSmall` by default in the cloud), three ways to configure it
  (local service / any OpenAI-compatible cloud / a finished SRT), the `/health` + `/shutdown` contract a
  self-hosted server must honour, and the env vars.

## [0.4.1] — 2026-10-28

### Added

- **The local ASR service can now be started on demand and stopped when the run ends.** Three hosts crashed
  on 2026-10-28 because that service sat resident at ~6.8 GB of commit charge while Premiere was open.

  Opt-in via `~/.dsh/asr.json`:

  ```json
  "manage": { "start": "D:/asr-local/start-asr.cmd", "idleMs": 120000, "waitMs": 180000 }
  ```

  With `manage.start` set: if the endpoint is down when a transcript is needed, it is started and awaited;
  when the run finishes the plugin stops **the instance it started** after `idleMs` of quiet. An instance
  someone else started is never touched — killing that would break whatever is using it.

  The server also grew its own backstop: `ASR_IDLE_EXIT_S` (default 600 s, `start-asr.cmd` sets it) makes it
  exit on its own when nothing calls it, so even a manually launched copy cannot sit there forever.

  Measured end to end with the service down: one storyboard call took 42.2 s and came back with
  `transcript: asr` instead of `asr-failed`. Cold start alone is **30.3 s** (spawn → `/health` ok); a warm
  call adds nothing.

  Stopping through a pid was the wrong idea: `start /b` returns a shell that exits immediately, so the pid we
  held was already dead while python kept the memory. The service now exposes `POST /shutdown` and the plugin
  asks it to exit — verified: request returns `true`, endpoint is gone 1.5 s later, and the idle timer stops it
  on schedule (alive at 2 s, dead at 5 s with `idleMs: 3000`).

## [0.4.1] — 2026-10-28

Same story as 0.4.0, one level down: a broken thing that was invisible because it failed quietly.

### Fixed

- **A downloaded copy with no audio track said "no audio in the source".** On an anonymous Bilibili URL the
  lowest track is video-only, so the whole audio path went silent — `transcript=no-audio`, empty envelope,
  `meanLufs=null` — and the manifest implied the video itself had no sound. It now probes the downloaded file,
  compares it with the formats the source advertised, and says which of the two it is:
  *"no audio in this copy: the downloaded track is silent while the source has audio. Pass cookies, or download
  locally"*. Reported by @xingyueDanYang with a reproduction.

### Added

- **`video_locate` — a phrase to a timestamp, with no frame decode.** It matches against the transcript
  already produced by `video_storyboard` (or runs ASR once if there is none) and returns timestamped lines
  best-first, ready to feed into `video_zoom`. Matching ignores punctuation, scores by longest common
  substring, and prefers the shorter line on a tie ("记忆管理局" beats "记忆管理局的人来了"). Measured
  **1 ms** on a 90 s clip. Note: needs speech — a music-only film has one empty segment and matches nothing.

- **`<name>.evidence.json` next to every sheet.** Per cell: from/to, the frame timestamp, cut count, chars,
  text. The manifest is prose for the model; this is for whoever has to verify it later without re-running.

- **Manifest says the sheet is already in context** (one line, ~100 chars). Re-reading the same film used to
  cost another 384 tokens per question; now the model is told to cite cells by number instead.
  Net: +138 characters always, −384 per avoided re-read.

### Fixed

- **Vertical `video_zoom` picked the wrong track** (issue #9). `pickVideoFormat` filtered on `height`, which
  on a 9:16 video is the *long* edge, so 1080x1920 was excluded and it fell back to 480x852 — while the
  manifest claimed 1080p. It now compares the short edge.

- **Tiled sub-frames bypassed the high-resolution direct link** (issue #9). `extractSubTile` read
  `remote.url` / `remote.headers`, but the object carries `{uri, http:{userAgent, referer}}`, so every tile
  silently fell back to the local 360p copy without counting a `frameFallback`. Now it uses the real fields,
  falls back per tile on failure, and reports the fallback.

- **Tiled cells no longer emit `frame@`.** A k×k cell contains k² moments; the old midpoint timestamp was
  not the moment its picture was taken. The evidence sidecar records `frame_at: null` for those cells.

## [0.4.0] — 2026-10-28

The release where fast cuts finally count. Three things were true before this version and are not any more:

1. **A shot shorter than 0.35 s could not be seen at all** — the scanner merged it away. Montage lives
   entirely below that line, so every count on a fast-cut film was a floor, not a count.
2. **A cell covering a montage showed exactly one frame.** The number "22 shots" was in the text and
   nowhere in the picture.
3. **Vertical video could not be downloaded.** Every portrait URL from Bilibili died on the format selector.

Measured across ten content types (slide recording, surveillance, 2D animation, 3D short, studio news,
handheld vlog, mobile-game ad, anime mashup, concept PV, 51-minute documentary), the per-second cut count
went from a suspiciously uniform 0.22–0.27 to the range the content actually has: 0.08 for a slide deck,
1.18 for a mashup.

### Fixed

- **Vertical Bilibili videos could not be downloaded at all.** yt-dlp reports a 9:16 video's formats as
  360x640 / 480x852 / 720x1280, so `height` is the *long* edge and `bv*[height<=480]+ba/b[height<=480]`
  matched nothing: every request ended in `Requested format is not available`. The selector now ends with an
  unfiltered fallback (`.../bv*+ba/b`) and sorts by `res:` (yt-dlp's short-edge metric), so a portrait video
  picks 480x852 instead of failing. Found by running the cross-domain test set (BV1BjxM69EHh).

- **A cut-on-every-frame edit was counted as 9 shots when there were 23 — and could be dismissed as camera
  motion.** Two causes: the one-frame gap was `1.02 / fps`, i.e. *longer* than a frame, so adjacent frames
  merged; and `degraded: 'motion'` fired on any window with a short median shot and many high-scoring frames,
  which is exactly what a per-frame flash looks like.

  The gap is now chosen per window: `1.02 / fps` normally, `0.9 / fps` when the window's mean score says
  nearly every frame changed. And `motion` now also requires a *smooth* score series (`cv < 0.4`) — a steady
  pan varies a little every frame, a flash alternates wildly. Measured: per-frame clip 9 → **21** (true 23),
  concept PV unchanged at 48, talking head 122 → 124.

- The target-count cap added in 0.2.2 was applied even when the caller passed an explicit `threshold`.
  The cap exists to stop tied frames from dragging in a cluster; applying it to an explicit threshold
  overrode the caller's decision, so fast material could not be counted at all. Measured on a synthetic
  3 s / 18-shot clip: `threshold: 5` returned 4 cuts instead of 16.

### Changed

- Sub-dividing a cell now also requires the cuts inside it to be *strong* (mean score ≥ 30), not just
  frequent. A 2D line-art animation hits 0.7 shots/s with cuts that are almost invisible frame to frame,
  so tiling produced nine nearly identical sub-frames — measured on a RETAS demo and on a mobile-game ad.
  Real montages are unaffected (concept PV still tiles 4×4, the 108-anime mashup tiles four cells).

### Added

- **Fast cells are tiled into k×k sub-frames.** A cell covering a montage used to show one representative
  frame, so "this stretch flashed nine times" was a number in the text and nothing else. When a cell's shot
  density is high (≥ 0.7 shots/s, i.e. average shot ≤ 1.4 s) it is now rendered as a k×k contact sheet —
  k = ceil(√shots), capped at 4 and by k×k sub-frame size ≥ 100×56 px. **Token cost is unchanged**: it is
  still one image.

  Measured on the concept PV at `cells: 6`: the three montage cells became 4×4 (16 frames each) while the
  slow cells stayed full size, and the credits frame stayed readable. The talking-head clip's cells sit at
  0.4–0.6 shots/s, so nothing is tiled there — the density gate is what keeps this from shredding ordinary
  narrative pacing.

  Two guards from measurement: sub-frames below 100×56 stop being distinguishable (110×61 was the floor in
  the tiling experiment), and tiling costs k²−1 extra frame extractions, so each sheet has a budget of 32
  extra frames and steps down k rather than blowing up render time.

- **Cuts are now re-read per 2-second window instead of per "burst".** The earlier version only refined
  windows that `findBursts` flagged, which fails exactly where it is needed most: when the whole film is
  fast there is no burst, so nothing is refined at all (a 3 s / 18-shot clip returned 4 cuts). The window
  test asks a local question instead — *can the coarse gap see what is in this window* — so it does not
  depend on the film's average.

  Both decisions run on the same per-frame scores, so this costs no extra decode (1.4 s vs 5 s when it was a
  second ffmpeg pass). Adopt the fine reading only when it finds more cuts, is not classified `motion`, and
  its cuts average ≥ 25 in score (real cuts average 59, a slow pan 18).

  Measured: the all-fast synthetic clip **4 → 16 cuts** (true 17); the 12 s / 3 s / 10 s mix refines only the
  flash; the concept PV goes 40 → 48 and the talking head 121 → 122, i.e. it now also catches real cuts the
  0.35 s gap was merging (spot-checked one: 84.75 s really is a hard cut from the title card to the credits).

- `video_storyboard({ scanGap })` — the minimum spacing between detected cuts, default 0.35 s. It is a
  different knob from `minGap` (which merges cells). Fast material needs it: the same 3 s / 18-shot clip
  yields **3 cuts at the default** and **16 cuts at `scanGap: 0.12`**. Until this, the scanner had no way
  to observe anything under ~0.35 s per shot, which is exactly the range montage lives in.

## [0.3.2] — 2026-10-28

### Fixed

- URL input now accepts yt-dlp's DASH output names such as `video.f100022.mp4`. The downloader
  previously required the exact name `video.mp4` and failed with
  `unexpected container: ... (expected mp4)` even though the file was a valid video. The file
  is now renamed to the stable `video.mp4` before probing, so the cache and pipeline keep one
  path contract. (Reported by @xingyueDanYang on `BV16VxM6dEeb`; fix from PR #8 by
  @ggfgfgf-on.)
- A download that produced **audio only** (`video.f30280.m4a`) is now rejected with an explicit
  message instead of being renamed to `video.mp4`. The rename-by-file-name step above made this
  failure mode possible: a valid file name is not a valid video stream.

### Security

- Transcript text is treated as untrusted data. Segments that look like instructions addressed
  to the agent (for example "ignore previous instructions" or "stop the run / do not call tools")
  are reported in `manifest.transcript.suspectInjection` with source, timestamp and a bounded
  quote. The run continues; the manifest line explicitly says this is data, not a command.
  This is evidence, not a content filter: false negatives are preferable to flagging ordinary
  dialogue. (Reported by @xingyueDanYang.)
- The video **title** is scanned too — it is external text that lands in the manifest, and it has
  no timecode, so its `from`/`to` stay `null` instead of collapsing to second 0.

## [0.3.1] — 2026-10-28

### Host ffmpeg discovery

`ffmpeg` / `ffprobe` are now resolved in this order: explicit `DSH_FFMPEG_PATH` /
`DSH_FFPROBE_PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), then `$DSH_HOME/tools/ffmpeg/bin`,
`$DSH_HOME/bin`, the install-root `tools/ffmpeg/bin`, and finally `PATH`. A DSH install can
therefore carry its own ffmpeg without every plugin re-implementing the lookup. Missing binaries
still fail with a message that lists every path that was tried.

### Manifest provenance

The text manifest now records what produced the image, not just the timing:

- `cell="WxH"` — the actual cell size, so a reader can tell whether subtitles were legible.
- `tokens="N (DSH estimate)"` — explicitly an estimate; the host owns the real token count.
- `ffmpeg="..."` — the ffmpeg build that decoded the frames.
- `sha256="..."` — optional source hash, only with `sourceHash: true` / `--source-hash`; it reads
  the whole file, so it is off by default. For a URL input it hashes the downloaded scan copy,
  not the remote stream; the `source:` line still identifies the URL.
- one `plan:` line with the measured inputs (`duration`, `scanThreshold`, `meanLufs`,
  `speechRate`, `motion`, `cuts`, `hasSubtitle`) and the effective thresholds from
  `PLAN_THRESHOLDS`. This is diagnostic output, not a new set of knobs.

The JSON manifest (CLI `--manifest`) carries the same `provenance` and full `plan` object.

### Fixes

- Window-scoped transcript stats now count only the segments inside the window. A whole-film
  `transcriptFile` previously divided the full character count by the window duration, which made
  `charsPerSec` and the auto-plan's speech-rate classification wrong for every clipped window.
- `video_zoom` now forwards `transcript` (and `sourceHash`) instead of silently falling back to
  the pipeline defaults.

## [0.3.0] — 2026-10-28

**A URL is now a valid input.** Paste a Bilibili link (or anything yt-dlp supports) instead of a local
path. Two decisions make this different from "download the video, then analyse it".

### Two-tier fetching

Scanning only needs structure — it gets downscaled to 64x36 — so it reads a 360p copy of the whole file
(~7 MB per 5 min). Close-ups go back to the original stream, one frame at a time, and never touch disk.

Why the low-res copy is downloaded at all instead of streamed: `pick:"sharp"` needs 3 candidate frames
per segment, 27 random seeks for a 9-cell grid. Local: 9.6 s. Over HTTP: 51.8 s. Seven megabytes buys
the right to jump around. Pure streaming would have been ~3.5x slower end to end.

### `transcriptFile` — skip ASR when the source already has captions

Accepts SRT, a plain `[{start,end,text}]` array, or Bilibili's `{body:[{from,to,content}]}`, detected
automatically. On a 90 s clip this took a run from 16.9 s to **5.1 s**. It also works on files with no
audio track, where the old logic fell through to `no-audio`.

### Auth: probe first, complain only when it actually matters

The first cut of this release hard-failed when no cookies were configured. Real use proved that wrong:
`BV1BK411Q7ys` lists 360/480/720/1080 even anonymously, while `BV1fq4y1u7nC` tops out at 480p. Per-video
and unpredictable, so refusing outright just made the agent hunt for a cookie it did not need.

Now the plugin probes first and proceeds if the source already offers the target tier; only when it
cannot does it record `degraded` plus a one-line note. The result always carries `auth`,
`maxAvailable` and `availableHeights`, so nothing is hidden.

Reading the browser's cookie jar is still not an option: Chromium 127+ stores `SESSDATA` with App-Bound
Encryption (`v20`), which no external process can decrypt. `docs/SETUP.md` documents the file export.

### Config moves to `~/.dsh/video.json`

DSH Desktop cannot read environment variables set with `setx` — the ASR side already learned this the
hard way. Precedence is now **tool argument > env var > `~/.dsh/video.json`**.

```json
{ "cookies": "D:/path/to/bili-cookies.txt", "scanHeight": 360, "zoomHeight": 1080 }
```

### Source capability, measured once

A single `yt-dlp -J` (2.4 s, same cost as `-g`) returns every format, so `maxAvailable` /
`availableHeights` are known before anything is downloaded and the zoom target is clamped to what the
source actually has. Degradation is reported as `source-max-Np` (the video's own ceiling),
`auth-limit` (a tier exists but this identity cannot reach it) or `fetch-degraded-Np` (the fetch
succeeded but returned less) — three different situations that used to collapse into one vague field.

### Manifest fixes for a real misread

A model read a cell whose picture came from the cell's *end* as if it belonged to the cell's *start*,
and shifted a whole segment 30 seconds early. Both causes were ours:

- `alignCells` joined every ASR line with a space, discarding each line's own `from`. A cell spanning
  09:38.9–10:20.5 that contained a real break at 10:09.4 looked like one continuous sentence. A
  `[10:09.4]` marker is now inserted **at breaks only** (gap >= 1 s); stamping every line would eat a
  quarter of the 120-character budget for nothing. Cells also carry `lines` and a `broken` flag.
- The per-cell line never said when the frame was taken. `t_frame` was already in the data — it is now
  rendered as `frame@01:13.59`, **only for `pick:"sharp"`** (mid is derivable; sharp's 3-candidate pick
  is not). One line above the cells states that `frame@` is not the cell start.

### Not done, deliberately

Title-card detection. Probed with `blackdetect` on two real files: 8 minutes of an anime feature
contains 10 black spans, 9 of them 0.3–1.7 s transitions. Without footage that actually has
chapter cards there is no way to validate a detector, and a list of 10 mostly-wrong markers costs
characters while teaching the model to distrust the index.

### New parameters

`transcriptFile`, `scanHeight` (360), `zoomHeight` (1080), `cookies`, `allowAnonymous` (now: suppress
the warning, does not gate the fetch) — on the relevant tools.

### Numbers

| What | Time |
|---|---|
| `yt-dlp -J` (formats + metadata) | 2.4 s |
| Download 360p, 4.5 MB | 4.5 s |
| Scan + 9 cells (90 s clip) | 9.1 s |
| Full run with ASR | 16.9 s |
| Full run with `transcriptFile` | **5.1 s** |
| 6-cell zoom re-read at 1080p | 5.3 s, 0 fallbacks |

Tests 216 -> **273**. CI needs no network, no yt-dlp binary and no real cookies (a fake yt-dlp script
covers the fetch path).

### Also

`docs/SETUP.md` + `SETUP.zh.md`: yt-dlp install, cookie export, environment variables, five-step
verification, failure table. `bin/storyboard.mjs` accepts a URL plus `--cookies` / `--scan-height` /
`--transcript-file`.


## [0.2.2] — 2026-10-27

Three things, all of them about *not* wasting the reader's attention.

**`layout: 'strip'` is gone.** It was never worth its surface area: at equal cell count a grid canvas keeps
a normal aspect ratio, so the cells are actually **bigger**, and the burned-in indices already settle the
reading order. Removed the parameter, the 8:1 aspect guard and every doc mention.
*Breaking for anyone who passed it — hence the version note below.*

**Transcript vs silence consistency.** A line that sits >60 % inside a detected silence is counted and
reported: either the speech is under the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call, one line in the text block when non-zero.

**A real manual.** `docs/USAGE.md` + `docs/USAGE.zh.md`: three install paths, a 3-minute first run, every
parameter of all three tools, six workflows, transcript backend config, cache, a troubleshooting table built
from failures we actually hit, and a cost table.

> Versioning note: removing a parameter is technically a breaking change (0.3.0). It is released as 0.2.2
> because the parameter had existed for under an hour and nobody could have depended on it.

## [0.2.1] — 2026-10-27

Everything since 0.2.0, as one patch release (the whole set is polish and a few parameters, no
architectural change).

**"How fast is this cut?" is now a number in the text, not something the model has to count.**

- Every cell line carries `cuts N` when that cell contains shot changes, and the header carries
  `cuts="141 (avg 2.1s)"`. The yellow ticks on the footer strip already show *where*; this says *how many*.
- `video_zoom` accepts `minGap` — re-read a fast-cut montage with `minGap: 0.4` and 0.3 s shots get their
  own cell instead of being merged into a neighbour.
- `video_zoom` accepts `layout: 'strip'` — one row of cells for a short window of continuous motion.
  Falls back to a grid if the strip would exceed 12:1 (vision encoders resize by the long edge, so an
  18:1 strip leaves every cell ~100 px wide).
- `--batch` now scans once for cut points and **snaps window boundaries to real cuts** (`--no-snap` to
  disable). A 92 s clip at 30 s windows lands on 0–30.88 / 30.88–59.88 / 59.88–92 instead of the clock.
- Audio strip height is capped by cell height, so a 2476 px-wide strip layout no longer gets a 136 px
  footer eating 37 % of the image.

**Text index diet.** Measured on a 9-cell run: 2,892 → **2,171 characters (-25 %)**, with no
information lost that the model can actually use.

- per-cell transcript cap 180 → 120 chars (page with `cellRange` if you need the rest)
- `sharp 479.7` removed from the text index — a bare number the model cannot interpret; still in the JSON
  manifest
- `image 1` dropped when there is only one sheet (it is pure redundancy); kept for multi-sheet

**`detail: low | med | high`** — transcript budget per cell, and truncation now lands on a
sentence boundary instead of cutting mid-word.

Measured on a 9-cell run: `low` 1,521 chars · `med` 1,915 · `high` 3,031. Note that med is *cheaper*
than the old hard-cut 120 (2,171) even though the budget is the same, because stopping at the last
sentence end usually costs fewer characters than filling the quota.

**`detail: low|med|high`** — transcript budget per cell (60/120/400), and truncation lands on a
sentence boundary. Measured on 9 cells: 1,521 / 1,915 / 3,031 characters — `med` is 12 % cheaper than
the old hard cut at the same budget.

**Read order is explicit.** `video_probe` offers STRUCTURE (overview, spoils the ending) and SEQUENCE
(window by window, never looks ahead) and refuses to choose.

**Speed.** `--batch` reuses one full scan across windows (17.0 s → 9.0 s on a 92 s clip); `video_zoom`
takes `minGap` and `layout: 'strip'`; audio strip height is capped by cell height.

**Removed `layout: 'strip'`.** It was never worth its surface area: at equal cell count a grid canvas has a
normal aspect ratio, so the cells are *bigger*, and the burned indices already settle the reading order. One
fewer parameter to explain.

**Transcript vs silence consistency.** A line that sits (>60 %) inside a detected silence is counted and
reported: either the speech is below the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call.

**Cut points are listed when they fit.** A window with ≤ 24 cuts now prints
`cut points (3): 00:12.75, 00:16.13, 00:44.50` — exact times, because the strip can only be read to
±2–4 s. Busy windows still get counts only, so an overview does not pay for a 141-entry list.

**Silence blocks stay a backdrop.** Tried drawing them as an occluder (bars skipped inside silence); it
looked like the waveform was chopped into solid grey bars, so it was reverted — grey is a backdrop *behind*
the bars. The wording now says what a short bar actually means: "quiet for this film", not "silent".

Tests 174 → **186**.

## [0.2.0] — 2026-10-27

**Text side now has a budget and paging.** A 2 h 35 min film produced a 75 KB index; the host folded 44 %
of it into a disk overflow file that the model never read, so 44 minutes of dialogue were effectively lost.

- `cellRange: [first, last]` — render only that slice of the index.
- `textOnly: true` — return the index with **no image and no frame decode**; combined with the scan cache
  it is ~0.8 s per page after the first call.
- Per-cell transcript is capped at 180 chars by default (an overview needs "what is this stretch about";
  ask for the cell range if you need the full text).
- When the index exceeds its budget it now stops **on a cell boundary** and says which `cellRange` to
  request next, instead of being silently folded into a file.
- ASR results are cached by (file, window, endpoint, chunk size) — paging no longer re-runs recognition.

**New: `video_probe`.** Container metadata in milliseconds — duration, resolution, rotation, audio and
subtitle tracks — plus a suggested reading plan. Costs no image tokens, so the model can decide *how* to
read a file before spending its first 384.

**Content-type routing.** `suggest()` now sees speech rate and loudness, not just duration and motion:
`meanLufs > −18 && charsPerSec < 1` marks a music-driven clip, which keeps the cell floor at 9 instead of
letting the "dialogue carries the info" rule shrink it. Measured: concept PV 0.16 chars/s @ −14.2 LUFS
fires; the tutorial at 5.59 chars/s and the narrative film at 2.05 do not.

**Term dictionary.** `~/.dsh/asr.json` accepts `"terms": {"绘插": "彗差"}` — deterministic replacement over
ASR output, single-pass (longest match first, no substring re-entry), with the replacement count reported.

**Baseline.** `docs/BASELINE.md`: four clips measured end to end, plus the finding that loudness and speech
rate move in opposite directions.

## [0.1.0] — 2026-10-27

First working release.

**Tools**
- `video_storyboard` — one addressable grid per clip: burned-in indices, per-cell timestamp ranges,
  per-cell transcript, footer audio strip.
- `video_zoom` — re-read a short window with fewer, larger cells.

**Sampling**
- HSV-weighted shot detection with a rate-based adaptive threshold (`3×p95` produced zero cuts on
  fast-cut anime; targeting ≈1 cut per 1.5 s fixed it).
- Cell placement follows local cut density; the timeline stays fully covered at a fixed token cost.
- `--pick sharp` selects the frame with the highest Laplacian variance.
- Segment merging honours a minimum gap that never exceeds the material's own granularity.

**Audio**
- EBU R128 loudness + silence detection, drawn as a strip on the same time axis as the cells.
- Transcript: embedded subtitle track → OpenAI-compatible ASR → skip. Long windows are chunked
  client-side (cut points snapped to silence) after a 299 s request was found to shift every
  timestamp 13 s early.
- Non-speech segments (ASR inventing words over music) are filtered and reported, never silently dropped.

**Engineering**
- Zero image library, zero font dependency; PNG is produced through ffmpeg's `image2pipe`.
- Scan cache keyed by file + window + threshold (5-min clip: 13.4 s → 3.6 s on the second call).
- Tool schema is verified against the host's real `defineTool` / `validateArgs`.
- 154 tests: unit + ffmpeg end-to-end + host contract.

[0.1.0]: https://github.com/SAOS-3624/dsh-video-storyboard/releases/tag/v0.1.0
