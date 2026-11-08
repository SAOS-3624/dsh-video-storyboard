# Changelog

## [0.7.1] - 2026-11-08

> 这一版全是社区反馈的修复，没有新参数。三件事：**字幕抓取失败不再冒充「没配 ASR」**、
> 设置页的 token 不再一重启就失效、`tierMap` 不再把 `NaN` 写进配置。

### Fixed — 站点字幕抓取失败被静默降级成 `transcript="no-key"`（#86，PR #84 之后的实报）

`no-key` 的含义是「**没尝试**转写」（没配 ASR）；而 `no-ytdlp` / `failed` 是「尝试了、但抓字幕
这一步坏了」。两者以前在清单里长得一模一样，用户看到 `no-key` 就去配 ASR，实际该修的是 yt-dlp。

- 新增 `transcript="subtitle-failed"`，带 `reason`（`no-ytdlp` / `failed`）和 `detail`；
  只在「抓字幕自己坏了 + 没有内嵌字幕 + 又不会跑 ASR」时出现。`no-subs` 仍是 `no-key`
  —— 那确实是「这条片子没有站点字幕」；
- 清单里对应一段 `site subtitles FAILED (…)`，按 reason 给动作（装 yt-dlp / 读 detail 原文）；
- 字幕 memo **只缓存成功和 `no-subs`**：`no-ytdlp` / `failed` / `needs-login` 不再缓存，
  否则用户装好 yt-dlp 之后同一 URL 在本进程里永远不重试（「改了也没用」）；
- 清单新增 `transcript-model="site-cc:ai-zh"` / `"embedded"`，站点 CC 和容器内嵌分得开。

### Fixed — `tierMap` 接受非整数键值，把 `NaN` 写进 video.json（#83，PR #84）

旧代码 `Math.round(Number(k))`：`foo` 变 `NaN`、`3.4` 悄悄四舍五入成 3。`NaN` 键写进去之后
档位映射整段失效，而且没有任何提示。现在只收 1–8 的整数，非法值直接抛错、由设置页回显。

### Fixed — 设置页 token 一重启就失效（PR #85）

token 以前每次 `createSettingsPage()` 都新生成。宿主一重启，浏览器里已经打开的那个设置页
就带着旧 token，保存全部报「token 无效」。现在落到 `$DSH_HOME/video-settings-token`
（0600），跨进程稳定。

### Added — 插件市场的本地化元数据与详情页（PR #85）

`locale/{zh,en}.json` + `docs/plugin*.md`：详情页不再直接把 README 铺出来。
`exports` 补 `./package.json` 与 `./locale/*.json`，`files` 加 `locale`。

## [0.7.0] - 2026-11-07

> 这一版只有一件「新功能」，其余全是补课：**七道阈值多了一套按人眼感知定标的表**；
> 另外修了长片 720p 副本下完就被自己删掉的问题，以及 Windows 上子进程闪黑框。

### Added — 第二套档位阈值 `tierCurve: 'perceptual'`（可选，默认不变）

档位阈值原来只有一套 —— 照抄 docx 的七道「每帧切点概率」。这次把 see-now 0.2.0 里按
**人眼瞬时记忆**重标的那套同步过来，做成可选项：

| 曲线 | 七道阈值（每帧概率） | 一格代表 |
|---|---|---|
| `docx`（默认） | 0.0085 / 0.02 / 0.03 / 0.04 / 0.06 / 0.08 / 0.1 | 3.9 → 0.33 s |
| `perceptual` | 0.0111 / 0.0163 / 0.0239 / 0.0351 / 0.0516 / 0.0757 / 0.1111 | 3.0 → 0.30 s |

**单位换算是关键**：see-now 那边用「刀/秒」，这边用「每帧概率」，差一个 fps。
新表 = see-now 的表 ÷ 30，和 docx 那套的换算关系完全一致（0.26/30 ≈ 0.0085、3.0/30 = 0.1）——
形状没变，只是端点内收。

两个端点有实验依据：**下界 3 s**（Pöppel 的「主观现在」2~3 s、电影镜头时长本身就有 ~3 s 的偏好）、
**上界 0.3 s**（注意眨眼 200~500 ms、图标记忆的部分报告优势在 250~500 ms 内消失）。中间六道等比
（公比 1.4678，时长辨别服从 Weber 律）。

配置走 `~/.dsh/video.json` 的 `storyboard.tierCurve`，认不出来的名字一律退回 `docx`（不抛）。
**默认仍是 `docx`** —— 这边没有做端到端 A/B（要真跑 SHOT/BBC 才知道），所以先只作为可选项。


### Fixed — 长片的 720p 副本下完就被自己的清理逻辑删掉（#81）

`pruneMedia()` 按 mtime 从旧到新删整个 `<key>/`，而刚下好的那个目录同时是"最旧的"
也是"最新的"。缓存里只有它、且它本身超过上限时（实测 72 分钟的片 720p 副本 544 MB >
300 MB），下载完成的下一行就把自己删掉，后面 `ffprobe/ffmpeg` 报 `No such file`。

- `fetch.js` 把刚下载的目录作为 `exclude` 传进去；
- `pruneMedia()` 没拿到 `exclude` 时也保"最新的那个"（`pipeline.js` 的
  `pruneStorage()` 走这条，同样安全）；
- 测试 +2：单目录超限不自删、exclude 的目录连统计都不算。

### Changed — 子进程统一 `windowsHide`（#37）

`spawn` 控制台程序在 Windows 上会新建一个黑框，看视频时每隔几秒闪一下。
`audio.js` / `scan.js` / `sheet.js` / `subtitle-strip.js` / `ytdlp.js` 全部补上
`windowsHide: true`（非 Windows 平台该键被忽略）。

### Docs — 原理图解（合 PR #82）

用一支 MV 把链路拆成 7 步，每步配真实中间图。图不在仓库里（`NOTICE` 不放第三方画面），
文档外链引用。顺手修掉两处和源码对不上的说明：README 的"格子尺寸全都一样"（0.6 起按
切点密度分档）、注释里的"假切点 +2 档"（常量是 `MARK_BOOST = 3`）。

## [0.6.9] - 2026-11-06

### Fixed — 有些机器上装完一个工具都不出现（社区实报）

`import('@deepseek-ai/dsh-tools')` 拿 `defineTool`，而宿主的这份**被打进 `app.asar`**，
插件从自己的 `node_modules` 往上解析不到 → 抛 → `apply()` 的 catch 吞掉 →
**整个插件静默不注册任何工具**（日志里只留一行 `failed to load`）。

- 新增 `src/define-tool.js`：内置一份 `defineTool` 兼容实现（author spec → JSON Schema，
  规则照抄宿主 `runSchemaCompiler` 的语义；只少了运行时参数校验）。
- `loadDefineTool()` 改成三跳：`import` → `DSH_TOOLS_PATH`（包了 try，路径写错也不会崩）→ 内置兜底。
- 走兜底的情况下工具照常注册，`schema-audit` 那套静态审计仍然是第一道防线。
- 测试 +6：`type:'json'` 退化成注解、`required:true` 提升到父级、真实 spec 全部能编译出来。

### Added — 会话里的分镜图不再无限累积

一张图进了会话历史就跟着每一轮请求走、宿主也不回收。现在涨到 `imageTrigger`（默认 300 张）
就把更早的一次性省到 `imageKeep`（默认 100 张）：走宿主的 `image/offload`，
那些图从此不进请求，磁盘上那份也能删（`tools/attachments-gc.mjs`）。
两个数都能在设置页或 `~/.dsh/video.json` 里改，`0` = 关掉。

**注意它们不是"一到就省"**：涨到触发线才动手，一次省到留底 —— 否则每出一张图都要改一次历史，
前缀缓存每轮全废，比不省还贵。

## [0.6.8] - 2026-11-06

### Changed — 工具契约瘦身：长说明搬进 `video_help`

五个工具的 description 和参数说明是**每一轮请求都要重发**的常驻文案。这次把"为什么 /
多少 token / 实测数字"搬进新工具 `video_help`（零图片 token、不需要有片子），契约里只留
"什么时候调、默认值是多少、价钱警告"。

- 常驻 JSON（`defineTool` 编译出来的那份）11069 → 10527 字符，**已含新增的 `video_help`**；
- 干跑印的说明书改成读 `src/storyboard/help.js` —— 以前这里另抄了一份，改档位只改一处就会
  开始说不同的话；顺手补上它本来就缺的 tiers / tierMap 两节；
- `tierMap` 不再声明 8 个子属性（两个工具省 ~480 字符）：键和值的 1..8 仍由 `validateToolArgs`
  兜，报错反而更具体（会说哪个键错）；
- 设置页「档位策略」下拉补上 `native`（原样）—— 它一直是「自定义」的底座，但之前选不到。

### Fixed — CI 的 ffmpeg 安装不再一次超时整步失败

2026-11-05 那次 node20 的 job 在 `apt-get install ffmpeg` 上下 62.8MB 包超时，整步
`exit 124`，同一份代码的 node22 是绿的。现在改成**短超时多次重试**（apt 会复用已下好的
`.deb`），job 预算从 12 分钟提到 15 分钟。

### Added — 档位策略与逐档映射进设置页

`video.json` 的 `storyboard` 段多了两项，设置页「视频与浏览器」里能改：

- **档位策略**：不指定（默认，自动选档）/ 全尺寸 / 标准 / 紧凑 / 速览 / 一图 / **自定义**；
- **逐档映射**：选「自定义」才展开，八行"算出来的 i 档 → 落到哪一档"。

三层优先序和 `cutFloor` 一致：**本次调用显式传的 > `video.json` 里的 > 内核默认**。
所以设置页设的是默认值，某一次调用显式传 `strategy` 仍然优先。

几个实现上的取舍：

- 新增 `native` 策略（bump 0、无 floor）。它只给「自定义」当底座 ——
  映射表接在策略**之后**，底座必须是"按密度原样"，否则用户设的 `1→3` 是在一个
  已经被 bump 过的档位上再挪。`standard` 不能用：它把 1 档压成 1/2。
- 恒等项（`3: 3`）**不写进文件**。写了没用，只会让下次打开看不懂上次改了什么。
- 空值（`strategy: ''` / `tierMap: {}`）是**真的删掉那一项**，不留空壳。
- 越界档位直接报错（400），不默默吞掉 —— 用户以为设上了、结果没生效最难查。
- 自定义下面有「一键填满」：八项一起改成同一个档。**这就是"每帧固定多大"的做法** ——
  整表吃掉切点密度算出来的档位，`cutFloor` 怎么调都不影响尺寸。没做成独立的"锁定"选项：
  它在数学上和全映射到同一档逐字节相同，多一个概念只会让人以为还有别的东西。

## [0.6.7] - 2026-11-04

### Fixed

- **auto 在"大格子多"的片子上会开出一帧一张图**。BBC《Mountains》49 分钟、316 刀，
  其中 305 帧是 1 档（一帧占满整张画布），不封顶要 **344 张图 ≈ 8 万 token**。
  旧逻辑遇到"压进预算就认不出镜头"时会退回不封顶，于是把 344 张原样交出去。
  现在超过 `max(64, 8×时长预算)` 就认定为失控，强制兑现压到 4× 预算的那一版
  （同片 39 张、114×74 的格子），并在清单里写明 `uncapped … 344 images … capped to 39`。
  阈值收在 `tiers.shouldForceSheetCap()`（纯函数，带单测）；正常片子（5 分钟 PV 要
  60 张那种）不受影响。

- **`ffmpeg` 明明在、却报"不存在"**：`binaries.js` 用 `existsSync`，把权限错误一起吞成 `false`，
  沙箱里文件就在那儿也报 not found。改用 `statSync` 保留 errno，报错区分 `ENOENT` / `EACCES`，
  候选里补上会话工作区的 `tools/ffmpeg/bin`（#76）。
  顺手把 ASR 免费路线的说法统一了：`INSTALL.zh.md` 第 3 步写清两条路（sherpa-onnx 体积小、
  FunASR 生态成熟）和 cookie 读 CC 字幕的完整步骤（#77），设置页依赖区也给免费路线入口，
  不再只显示"未配置"。

- **dry-run 在"失控被压过"时仍推荐 `full`**：344 张被护栏压到 39 张之后，dry-run 还按
  "最省的可读档"推荐 full —— 用户照着调一次又回到 344 张。现在只要发生过 `overBudget`
  就推荐 `auto`，并在推荐行里写明"别传 full，那就是不封顶的那一版"。

- **清单把"没有台词"说清楚**：交付文案前置「画面正常，只是没有台词」，
  cookie 落到 `video.json`，不再让人以为整次提取失败了（#77）。

## [0.6.6] - 2026-11-04

### Added

- **`cutFloor` 参数**（`video_storyboard` / `video_zoom`）：切点判定下限，0–255，不传沿用口径默认
  （mc: 80 / abs: 12）。这是"这段素材该怎么切"的入口——80 适合纪录片/电影（长镜头、剪辑稀疏），
  60 适合短视频/快剪（中位镜头 < 3 秒）。
  实测 SHOT 27 段：60 比 80 召回 **+10 个点**、刀数 +13%；BBC 11 集反过来，60 比 80 掉 3.2 个点。
  **没有一个常数能两头讨好**，所以交给调用方按素材类型选，而不是继续在算法里猜
  （按分数分位数、按高分帧占比两个自适应判据都实测无效）。
  `cutFloor` 已进 `cacheKey` —— 漏了就会出现"改了参数却拿到上一次结果的缓存"，`minGap` 踩过同一个坑。

- **逐格部分拉伸**。同一行里宽度不等的格子，每格拉高到 `min(行高, s×(1+τ))`，拉不满的部分
  才留空。以前只有"整行拉平 / 整行不拉"两档，宽度比超过 (1+τ)² 的行一点空隙都收不回来 ——
  混合档位里那种行才是空隙的大头。纯后处理，不改行划分和箱数，fill +1.8pt。
- 三条排布测试（`test/pack.test.mjs`）。**做变异测试时发现的**：把上面三处逐个改回旧行为，
  原 517 条测试一条都不红。补完再验，三个改坏各红一条。

### Changed

- **切点链路的编排收口到新文件 `src/storyboard/cuts.js`**。原先 5 个阶段平铺在 `runStoryboard` 里，
  每步都读 `cuts.length` 做准入判断，顺序是隐式的：
  极静素材补刀（`perSec < 0.1`）→ 爆点细扫（`fine > coarse`）→ 丐中丐合并（`+1 > 56`）→ 打标签。
  现在阶段表写在文件头，并明确"新增加刀/删刀的阶段只能排在 3 之后、4 之前"。
  `shouldTakeSpikes` 一起搬过去，`pipeline.js` 原路径 re-export，外部 import 不变。
  **行为零改变**：6 段真实素材重构前后 cuts 逐刀一致（含 type 标签）。

- **画布宽高都对齐到 42px 计费格，高度把页眉也算进去**。
  宽度：800×450 会被算成 812（20 列），798 只要 19 列，每行少 1 个分隔 token。
  高度：出图时顶上要叠一条 19px 的时间抬头，449+19 = 468 正好越过 462（11 行的上界），
  白多一整行 —— 所以把格子区压到 443，总高 462。
  **实际出图 800×469 = 254 → 798×462 = 222（-12.6%）**，格子区面积少 1.5%。
  两条对齐都只在"真降价"时生效（地板区原样返回），页眉高度的公式收口到 `tiers.headerHeight`
  —— 以前 `fitCanvas` 看不到它，只对齐格子区，等于把页眉的成本漏算了。
- **`DEFAULT_STRETCH` 0.2 → 0.3**。一行里最宽的格压到 1/1.3、最窄格拉到 1.3，更多行能
  "拉平填满"。150 组混合档位（5025 帧）实测：张数 578 → 550（-4.7%），fill 81.2% → 88.8%。
  配合画布对齐，**同素材总 token -9.3%**。
- `pipeline.js` 里散着的 8 处 `stretch: 0.2` 收敛成一个 `PACK_STRETCH`。

### Fixed

- **`flat` 的可行性判据比它自己宣称的松**。原来写 `(1+τ)/(1−τ)`，τ=0.3 时最窄格实际会被
  拉到 1.43（+43%），而文档说的是"最多 30%"。改成 `(1+τ)²`。400 组随机档位压测（1362 张图）
  量到旧判据的最大宽高比偏差 33.6%，改完理论值正好 30%。

## [0.6.5] - 2026-11-03

> 主题：**三个社区报的坑，加一条从来没通过的路**。`toRects` 最后一行会越界 1px、
> 媒体目录换到别的盘后空间检查还盯着 C 盘、以及 `~/.dsh/video.json` 里写 `mediaDir`
> 从来没生效过 —— 桌面版读不到 `setx` 设的环境变量，所谓"换盘"其实是个死开关。

### Added

- **设置页补 `cookies` 与 `storyboard.auto`**（@ggfgfgf-on，PR #73）。cookies 只写路径、
  不读文件内容；`storyboard.auto` 关掉只影响自动生成分镜，显式调用工具照常。
  对应环境变量存在时，页面明说"环境变量优先"。
- **设置页改自动保存**（同 PR）。600ms debounce、保存串行化（不会两次并发写）、
  首渲染不触发、密钥框走 `onBlur` 而不是逐字存；端口不在 1-65535 就不落盘。
- **`mediaDir` / `cacheDir` / `mediaMaxBytes` 改读 `~/.dsh/video.json`**，优先序
  `env > video.json > 默认`。桌面版读不到 `setx` 环境变量，配置只能走 json ——
  补上之后"把媒体目录换到 D 盘"才真的能换。新增 `user-config.js`：只读路径类字段，
  坏文件/非对象按空配置处理，核心不因为一个配置文件坏了就拒绝干活。

### Fixed

- **`toRects()` 最后一行可能越过画布 1px**（#71，@ggfgfgf-on，PR #72）。行高/水平取整
  修正后统一把矩形钳回画布、保留至少 1px 宽高；水平修正处补 `Math.max(1, ...)`，
  避免宽度变 0 或负数。**3000 组随机档位 × 画布 × gutter 双跑：越界 802 例 / 4691 px → 0，
  而原本不越界的 2198 例输出逐字节一致**（没有误伤），相邻格重叠数与修前完全相同。
- **媒体目录换到别的盘后，下载前的空间检查仍看系统临时盘**（#74，@ggfgfgf-on，PR #75）。
  `freeBytes(dir)` 改为按目标目录所在卷 `statfs`，目录还没建时沿父目录找最近的已存在祖先。
  实测本机 C: 13.8G / D: 98.2G：`freeBytes('D:/videos')` → 98.2G、
  `freeBytes('D:/videos/不存在的/x')` → 98.2G（退到已存在祖先，没掉回 C:）。
- **空环境变量提示不占位**（PR #73）：`DSH_*` 设成空串时不再显示成"环境变量优先"。

### 说明

- 设置页**没有**加 `cacheDir` / `mediaDir` / `mediaMaxMb` 的输入框。路径填错（不存在的盘、
  没权限的目录）最后表现成"下载失败"或"缓存不知道跑哪去了"，用户读不出因果。核心层已经
  能读 json，能手改配置的人现在就能用；等想清楚怎么提示再加 UI。

## [0.6.4] - 2026-11-02

> 主题：**再把"每轮重发"的钱刮一遍**。0.6.1 把 schema 从 22.8k 压到 11.8k，
> 但还有三处漏网：清单头部每次调用都重印的散文、设置页工具（它也是 schema，
> 守门却只称五个工具）、以及"六工具合计"从来没被断言过。

### Changed

- **清单头部的说明性散文压短**（4 段，句子结构不动、事实一个不删）：
  `badges:` 从三句变一句（仍是"为什么跳号 / 它们是真帧 / 按格号引用"），
  多张图那条改成 `${n} sheets = n separate windows, not one strip`，
  `footer strip shares the timeline:` → `footer:`（图例含义不变），
  档位对照从 `same window under the other policies:` 改 `other policies:`，
  并保留 `**"full" is the expensive one, not the fuller one**` —— 这句是防"选 full"的唯一提示。
  实测（沧野 5 分钟窗 / 18 格 / 2 张 / 真字幕）：**5,592 → 5,275 字符**，头部 2,080 → 1,763。
  剩下的 33% 头部全是事实（路径、档位分布、最小格、fill、单价），不再动。
- **设置页工具的描述**删掉"Web GUI 里也有一份同样的设置页"这类**给人看**的话，
  648 → **456 字符**。契约抽成 `settingsToolSpec()`（`src/settings/server.js` 导出），
  只为让测试称得出它 —— 建工具对象要 webServer，测试里造不出来。

### Fixed

- **体积守门漏了第六个工具**：断言只加五个视频工具（<13,500），
  而桌面版（有 webServer）每轮实际发六个。现在五工具 <12,500、**六工具 <13,000** 都锁住，
  当前实测 **11,777 / 12,233**。

## [0.6.3] - 2026-11-02

> 主题：**把"能用但用不了"的三处修掉** —— 宿主 ASR 拒收音频、zoom 不接宿主 ASR、zoom 为一个
> 兜底文件重下整片。顺手把 0.6.2 之后只落在 main 上的 CLI 与文档改动一起发出去。
> **基线一处没动**：`strategy:"auto"` 的默认代价、`pack.solve` 的排布口径、图片 token 换算
> 都还是 0.6.2 的，接着提的 PR 可以照旧直接落。

### Fixed

- **宿主 `speechToText` 交出去的音频不是宿主认的 WAV**（@大肥鱼 2026-11-02 实报，macOS 26 / Apple
  Silicon）—— 启用 Voice Input（SenseVoice）后，任何带人声的视频都得到
  `transcript="asr-failed"`，理由只有一句 `ASR call failed`。真因是 `-f wav -` 走管道：
  `RIFF size` / `data size` 回填不了（`0xFFFFFFFF`），ffmpeg 还默认塞一个 `LIST/INFO` 把 `data`
  从偏移 36 顶到 70。宿主的 `validateWave()` 逐字节认死「`RIFF size === len-8`、`data` 在
  **36**、`data size === len-44`」，三条全灭。
  **不是 macOS 专有**：同一份代码也在 Windows 包里，只是用 asr.json/HTTP 端点时走不到这条路。
  修法是在内存里重写头（`canonicalizeWav()`：按 chunk 走一遍、只留 `fmt ` + `data`、重算长度），
  **不写临时文件**——管道拿不到的长度我们自己会算，win/mac 同一套、零额外 I/O。
  结构认不出来就明确抛错，不再静默跳过一整段台词。
  `test/host-asr.test.mjs` 把宿主的 `validateWave()` 逐条复刻成断言，这个坑不会再回来。
- **`video_zoom` 不接宿主 ASR** —— 它自己直调 `runStoryboard()`，绕过了 `shared.js` 的
  `runWithHost()`，于是同一个文件「分镜能转写、放大变 `no-key`」。两个入口现在共用
  `runWithHost()`，以后再有第三个入口也接同一个口子。
- **`video_zoom` 读链接时会为一个"只用来兜底"的本地文件重新下载** —— 缓存键是
  `mediaKey(url, height)`，而分镜落盘用 720/480、zoom 和陪看用 360，于是「先分镜再 zoom」
  必然 miss 一次：整片就在隔壁目录里，却要重新解析（2.4 s）+ 重新下载，而这条重下对匿名高清源
  就是 `HTTP Error 503`（同一位用户实报，从 macOS 跟到 Windows 都会）。现在 `fetchMedia` 支持
  `reuseCached`：键 miss 时找同一链接**已经落过盘的别的清晰度副本**（优先"不比要的更低"里最矮的
  那份），直接当本地副本用，**根本不去碰网络**。只给 zoom / 陪看开——分镜的本地副本就是产出源，
  清晰度必须严格照参数走，**不许被复用悄悄换掉**。清单照实报 `scanned at 720p`。
  另外 `explainYtdlpError` 补了 `HTTP Error 503` 的结论（签名直链过期 / 匿名高清被限流），
  以前它只落到"最后三行原文"。
  高清直链取帧失败回落本地副本本来就有一套（`frames.js` 的 `local-fallback`，
  清单里有 "N cell(s) fell back to the low-resolution copy"），这次没动它。

### Added

- **CLI 遇到不认识的开关会当场说出来**（0.6 删了 `--cells` / `--sheets` / `--need`，外面的教程和
  脚本还是老写法）。以前静默忽略，用户以为"参数生效了、只是效果不明显"；现在 stderr 会点名
  `--cells`，并直接给出新写法（`--frames N` / `--strategy …` / 先 `--dry-run` 看代价）。
  `bin/_args.mjs` 把未知项收进 `$unknown`，`bin/storyboard.mjs` 负责打印；`test/cli-args.test.mjs` 守着。

### Changed

- **安装文档规范化**（closes #68）：以 `dsh plugin --profile web add` 为主路径，桌面版单独说明
  `install-dev`；`README` / `README.en` / `docs/INSTALL.zh.md` / `docs/USAGE*` 里 0.6 已删掉的
  `--cells` 写法一并清掉，不再让新用户照着老命令试。
- **清单措辞两处**（@大肥鱼 提，纯文本、无逻辑变化）：`→ L2` 这个标记现在写明「**这格有台词**，
  就是上面列出的那句」，只有引号里空着才是真没声音——原来 legend 只说「读一次」，用户会以为
  这些格子静音；格子太小时不再鼓励硬看，改成「**别从这种尺寸的格子描述人脸/道具/画面文字，
  这个尺寸你是在猜**」，并按代价给出修法顺序（zoom → compact/standard → full）。

### Docs

- **FAQ 记下一条已知限制**（#70）：字幕轨本身可能是错的（平台 ASR 自动生成的经常错到离谱），
  我们**不会**把它和画面硬字幕做交叉校验。`detail:"high"` 的 OCR 只校正命中的那一句、不并列两版；
  真要核对就自己看一眼画面。交叉校验缺"什么算不一致"的判据与样本集，先不做。

## [0.6.2] - 2026-11-01

> 主题：**把社区提的 6 个 PR 收进来**（4 修 bug + 2 加功能），每个都先单独 rebase 到 0.6.1
> 跑一遍、再合到一个集成分支上跑全量 494 条测试，最后才落到 main。
> **基线一处没动**：`strategy:"auto"` 的默认代价、`pack.solve` 的排布口径、图片 token 换算
> 都还是 0.6.1 的，接着提的 PR 可以照旧直接落。

### Added

- **插件设置页**（#60 / closes #59）—— DSH 设置页里直接渲染 ASR（baseUrl / model / language /
  key / 开关）、浏览器端口与启动开关、依赖自检；同一套 API 也支撑一份独立 HTML 页
  （`src/settings/server.js` 注册在宿主 `webServer` 上，页面 URL 带 32 字节随机 token）。
  **key 只写不读**：`GET /state` 只回 `hasKey`，写入时空串表示保持原值。没有 `webServer` 的
  CLI 宿主 `createSettingsPage()` 返回 `null`，工具数仍是 5 个、行为不变。
  顺带把 `DSH_ASR_ENABLED=0` / `asr.json {"enabled":false}` 接进 `canTranscribe()` —— 以前这个
  开关只影响解析、不影响实际门，关掉 ASR 得靠"没配 key"。
- **宿主 `speechToText` 优先**（#58 / closes #57）—— 桌面版自带 SenseVoice 时，按窗口切 16k
  单声道 WAV 直接交给宿主，不再要求 `asr.json` / 云端 key。宿主 provider 没有词级时间戳，
  所以一块音频一条台词（`from`/`to` = 窗口边界）。缓存身份写 `asr2|host:speechToText|…`，
  和云端 HTTP 的不串用。CLI / 其他宿主没有这个服务时**原样走旧路径**。
- **`scripts/reference-server-sherpa.py`**（#62）—— 本机 ASR 服务端的最小参考实现（sherpa-onnx 2.x +
  paraformer / ct-transformer / silero VAD，只依赖标准库 + numpy）。补上 `docs/CONFIG.zh.md` §7.1
  「自己写」那条路缺的那份可对照代码：`--models` 目录内按已知文件名自动发现，也可逐个覆盖路径，
  `--check` 只验模型能否加载。两条降级边界按文档口径实现 —— 标点加载或调用失败照常 200 + 不带标点的
  文本，VAD 缺失或运行期出错退回整段一次识别。**`scripts/` 在 `files` 白名单里**，所以这个脚本
  会跟着 npm 包一起发出（21 kB，实测 `npm pack` 里有它）—— 装完直接
  `python scripts/reference-server-sherpa.py --check` 就能自检。
  （初稿这里写成"不进 npm 包"，是照着 PR 描述抄的，@aizhimoran 核对后指正。）

### Fixed

- **混合档位同一行的 1px 重叠**（#67 / closes #66）—— `toRects()` 的水平取整修正按 `y + h`
  给行分组，混合档位的一行里 0 档补位格和 1 档格高度不同会被拆成两组，左右边缘差 1px 就修不掉。
  改成只按**取整后的上边缘**分组（和下面垂直那趟同一个口径），回归测试用 `[2,0,1,0,0,0]`。
- **prefetch 不读内嵌字幕**（#56 / closes #55）—— `prefetchTranscript()` 在"没有站点 CC"之后
  直接跳到 `canTranscribe()`，本地片明明带字幕轨、只要没配 ASR key 就报 `no-key`。
  现在和 `resolveTranscript()` 同一级：站点 CC → **内嵌字幕** → 缓存 → ASR。
  同时把 `cookies` 传给下载（以前只给站点 CC 用，登录片在 prefetch 里退成匿名请求）。

### Closed without merge

- **#54 / #63**（`saveImage` 丢 receiver）—— 0.6.0 已用 `saveImage.call(attachments, …)` 修好，
  0.6.1 也在跑；两个 PR 的思路（`inject: { required, optional }`）等价，但会和 0.5.9 那次
  "硬 inject 导致装插件卡死"的教训撞车，main 走的是 `ctx.get()` 探测 + `.call` 绑定。
- **#65**（`rowOptions` 缓存键）—— 0.6.1 已经把键换成
  `` `${tiers}|${grow}|${stretch}|${fillRows}` `` 字符串（#64），数值累乘会越界的问题一并解决。

## [0.6.1] - 2026-11-01

> 主题：**把"贵"这件事收回来**。起因是一次真实账单 —— 新会话看到一个 B 站视频，直接在
> `strategy` 里选了 `full`（枚举第一个名字），90 秒的 PV 花了 6912 vision token，是 `compact` 的 6 倍；
> 同一次会话里，`video_storyboard` 的**文字索引**还占掉了约四分之一，因为 21 个格子把同一句歌词
> 各印了一遍。两处都不是模型犯傻，是工具没把代价说清楚。

### 图片按像素计价：`800²/384` 换成宿主的 patch 网格（真值 233，不是 384，也不是 218）

官方《图像理解 · Token 用量》改了口径：小于约 **544×544** 的图会被放大、更大的缩到总像素约相当于
**1300×1300**、单张封顶 **1024**。我们一直用的 `800×800 = 640k = 384` 是**上一版**文档的数。

**换算公式不是字节级公开的**，所以直接抄了宿主的实现（`@deepseek-ai/dsh-llm-deepseek` 的
image-tokens 模块，服务端 v41 配置）：

```
14px patch 对齐（向上取整）→ 每轴 3:1 降采样 → 42px 一格
tokens = rows × (cols + 1) + 2        # 每行一个分隔 token，外加 2 个框架 token
```

对出来的真值（`scripts/verify-image-tokens.mjs` 与宿主逐值对拍，23 组全一致）：

| 尺寸 | 旧报数 | 「像素÷1650」估算 | **真值** |
|---|---|---|---|
| 800×450（默认画布） | 384 | 218 | **233** |
| 1066×600（640k） | 384 | 388 | **407** |
| 1280×720 | 384 | 559 | **578** |
| 320×180…733×412（地板区间） | 384 | 179 | **192 一律** |
| 1300×1300（上限） | 384 | 1024 | **994** |

- 新增 `tiers.imageTokens(w, h)` —— **全仓库唯一一处**把尺寸换成钱的地方；清单的
  `tokens=` / `cost:` / auto 对照 / `wide pass` / 预演 / `--plan` 全部改走它，按**每张图自己的尺寸**算。
- 新增 `scripts/verify-image-tokens.mjs`：拿宿主的实现给我方打分（宿主升级后重跑就知道要不要跟）。
- `MAX_CANVAS_SIDE` 800 → **1300**、`MAX_BUDGET` 640k → **1.69M**；`DEFAULT_BUDGET` 640k → **360k**
  （16:9 仍是 800×450）。**默认输出与 0.6.0 逐像素相同**（同一素材 4 个策略对跑 PNG sha256 全 SAME），
  变的只有账：以前"说要 640k、实际被单边 800 卡成 360k"，现在参数和结果对得上。
- **地板抬升（P1）**：小于 544² 的预算一律抬到地板（16:9 → 725×408），因为计费按 544² 收 ——
  画得更小一分钱不省、只会更糊。实测同一素材：`budget:120000` 出图从 462×274（182 tok）变成
  725×419（192 tok），**+5% 的钱换 +140% 像素**；`budget:230000` 是 +5% 换 +28%。
  抬过的预算会在清单里写明原值（`budget: you asked for 120000 px … ran at 295936 px`），不偷偷改。
  地板档的抓帧高度也跟着给到 720p（否则抬了画布却拿 480p，等于白抬）。
- `scanHeight` 阈值 400k → 300k，保证默认预算下仍是 720p 抓帧（否则换口径会把画质偷偷降到 480p）。
- 分档算法（`levelCurve` 卷积）与升降档表（`STRATEGIES` / `applyStrategy`）**一行没动**。

### `strategy: 'auto'` 成为默认（可关）

- 新增 `autoSheetCap(duration)`：**张数只按时长算**，默认 240 s/张（`DSH_STORYBOARD_SECONDS_PER_IMAGE`
  可调）。5 分钟 → 1~2 张，30 分钟 → 8 张，2.5 小时 → 39 张。同一时长的片子，钱是可预期的，
  切点密度（3 刀 vs 300 刀）不再能让账单差一个数量级。
- 新增 `pickAutoStrategy(variants)`：在 `compact / standard / full` 里挑"最小格 ≥ `shot`、张数又最少"
  的那档；全都认不出时取最小格最大的。压缩到色块就翻倍张数重试（最多三轮）—— 预算让位于可读性。
- 清单新增 `size policy: auto chose …` + 同一批帧在另外两档的真实张数，模型下一轮才有依据覆盖。
- 关掉：`DSH_STORYBOARD_AUTO=0` 或 `~/.dsh/video.json` 的 `{"storyboard": {"auto": false}}` → 退回 `compact`。
- `zoom` / 陪看不受影响（它们的默认仍是 `full` / `compact`，窗口本来就短）。

### `dryRun: true`：先给切点数，再让模型选档

只扫描（有缓存）+ 排布，**不出图、不取帧、不转写**，回报切点数、帧数、每个档位的张数与最小格
尺寸，并给出推荐。这让"先看刀数再选档"变成一次几乎免费的文本调用，而不是靠猜。

### 文本索引瘦身（同一句话不再印第二遍）

- **跨格重复只印一次**：一句词横跨 21 格时，抽到 `shared speech` 段印一次，格子留 `→ L1` 引用。
  实测同一份结果 5263 → 2010 字符（−62%，≈3680 → 1400 token）。
- 一格内相邻重复的句子折叠成 `×n`（副歌循环不是三条信息）。
- `lines` 路径原来**完全不受** `maxCellChars` 约束（一格 5 句就印 5 条完整台词），现在按整格预算收尾。
- 整窗档位一致时用一行说明代替逐格的 `k=`（省 11 字符/格）。
- 默认 `maxChars` 24k → 12k：64 格 `detail:"med"` 的完整清单正好装得下，超了才分页。

### 修掉文案与实现不一致（这是选错档的直接原因）

- `strategy` 的枚举是 `full/standard/compact/skim/brief`，描述却写着 `quality | balanced（默认）| saver |
  frugal` —— 模型按描述找不到 `balanced`，就照着枚举第一个 `full` 填。现在描述与枚举一致，`auto` 排第一。
- `maxSheets` 描述写"默认 8"，代码是 **0 = 不限**，已改正。
- `validateZoomArgs` 只认旧名，**传 `full` 会被判非法参数**（schema 里给的正是新名），已修。
- `probe` 文案里残留的 `cells:16` 改成 `maxFrames: 96`。

### 积分取帧的阈值改成**绝对值**（原来等于等间隔抽样）

`integralMarks` 的阈值原先是 `T = 全片平均每秒变化量 × equivSeconds`。画面动得越厉害，平均分越高，
阈值跟着一起涨，两者抵消 —— 不管素材多快多慢，都是固定 `equivSeconds` 秒一个采样点。
实测变化率从 2/s 到 64/s（差 32 倍），输出**恒为 19 个点、间隔恒为 6.0 秒**：
积分就此退化成等间隔抽样，"动的快的地方多取帧"这个能力完全消失。段内的相对快慢当时是保留的
（慢段 1 点 / 快段 18 点），丢的是**整段素材的快慢**。

改成 `T = INTEGRAL_REF_SCORE(4) × fps × equivSeconds`，参考分标定自真实素材剔除真切点后的均分
（慢动画 0.79 / 实拍 2.92 / 连续运动 3.37 / 快剪 4.75 / 缓慢渐变 7.33）：

| 素材 | clean 均分 | 修复前 | 修复后 |
|---|---|---|---|
| demo（慢节奏动画） | 0.79 | 9 帧（假切点 4） | **8 帧（假切点 0）** |
| hue40（缓慢渐变） | 7.33 | 4 帧（假切点 6） | **9 帧（假切点 12）** |
| motion（连续运动） | 3.37 | 15 帧（假切点 3） | 14 帧（假切点 2） |

参照：参考强度画面仍是 `equivSeconds` 秒一个点（语义没变），慢素材攒得更久、快素材攒得更快；
静止画面永远攒不出来（0 个点）。**缓存不用清** —— 存的是扫描结果，积分点每次重算。

同一条链路上其余阈值**已复核，没有这个问题**：`levelCurve` 用绝对密度阈值数组；
`autoThreshold` 是分位数 + `floor 12` 兜底的预算制；`refineCutsByWindow` 的采纳门槛是绝对的 25；
`spikeCuts` 用相对基线但**故意如此**（它找的就是"相对本片常态的尖峰"，另有 `minAbs` 兜底，
且只在每秒不到 0.25 刀的极静素材上启用）。

### 短视频不再比长片贵（`Math.max(2, …)` 拿掉）

auto 压张数时写了 `const limit = Math.max(2, autoTargetCap)`，于是 25 秒的素材被硬抬成 2 张，
2 张塞不下就按 `×2 / ×4` 逐级放宽，最后出了 4 张 —— **比 5 分钟的片子还贵**。
按时长算出来是几张就是几张。同时修掉清单里的假话：90 秒以内的窗口原来无条件写
`duration budget: … → **1 image**`，即使实际给了 4 张；现在 `relaxed` 存在时如实说明原因。

### 假切点的格子再小一档（`MARK_BOOST` 2 → 3）

假切点是"画面一直在变、攒够了才切"补出来的帧，没有硬边界，一帧代表不了多久。原来是 +2 档
（1 档 → 1/3），按"尺寸再小一级"的要求提到 **+3**（1 档 → 1/4）。

实测（40 秒纯渐变、0 真切点、一张图）：格子 **267×150 → 200×113**，同一张图从 9 帧变 **16 帧**，
**张数与价格都不变**；有真切点的素材只影响假切点那几格（motion：1/5 → 1/6，fill 97.2% → 93.4%）。
注意 boost 放大后一张图能装更多格，`fillGaps` 会顺带切几刀补满 —— 这是同一笔钱多看到几个瞬间，
不是多花了钱。

### 三个把画面吞掉的 bug（拿一条真实 36 分钟 B 站视频抓出来的）

一条 5 分钟窗口、191 刀的素材，`--dry-run` 报"三档都是 1 张"，实跑只出 **1 帧**；
而按不封顶真实代价是 full **59 张**。三个问题叠在一起：

1. **`dryRun` 的代价全是假的**：`variants` 用 `built.raw` 算，而那份档位已经被张数预算压过，
   于是 compact/standard/full 报同一个数（`1 image`）。模型拿它选档等于闭眼开车。
   改成用**不封顶**的帧与档位重算：现在如实报 `compact 8 / standard 10 / full 57 / skim 3`。
2. **auto 在"三档都认不出"时选了最贵的那档**：原来按"最小格面积最大"退，
   等于永远选 full —— full 保留 1 档帧（一帧独占整张画布），格子在数字上最大，一张图却只装得下一帧。
   改成**按张数退，再比格子**：59 张 → 8 张（省 86%），反正都要糊。
3. **压张数只会减帧，不会压档位**：161 帧压进 1 张，一路二分减到 **1 帧**，等于什么都没看。
   新增 `squeezeTiers`：先把全部帧逐档加粗（保留时间覆盖），实在装不下才动帧数。
   实测同一条素材 `--max-sheets 1`：**1 帧 → 72 帧**（1/7×27 + 1/8×45，fill 97.9%）。

顺带：`maxSheets` 在 auto 路径下被完全忽略（auto 只用 `autoSheetCap`）。现在显式给了就只试那个值、
不放宽，并标 `forced`。**这里自己绊了一跤**：`capSheets` 在"没给"时兜底是 `Infinity`（不是 0），
而判据写成了 `capSheets > 0` —— `Infinity > 0` 是 true，于是 `limit = Infinity`、整段压张数被跳过，
"5 分钟 1 张"从来没生效过（显式传值时才生效）。改成 `Number.isFinite(capSheets)`。

### 压不进预算时，把 skim 的价码摆出来

`relaxed` 时清单多一句：`If you only need the gist, strategy:"skim" is ≤N image(s) (1/8 cells).`
只报数、不替调用方决定要不要更糊。实测那条 5 分钟窗口：auto 目标 1 张、压到 4 张仍认不出 → 给 8 张，
**skim 是 3 张**。skim 不进 `AUTO_CANDIDATES`：那个列表按"张数最少优先"排，加进去它会永远胜出。

全片 36.9 分钟实测（844 刀）：`compact 56 / standard 79 / **full 441** / skim 13` 张 ——
auto 选 compact，874 帧进 53 张、fill 95.1%。**full 是 441 张**，那是旧 fallback 会选中的档。

### 工具 schema 瘦身（它每轮都要重发，不进对话历史也照样收费）

五个工具序列化后 **22,855 字符 ≈ 14.9k token**，其中参数说明 12,647（是顶层描述的 3 倍）。
这笔钱**跟看不看视频无关**：schema 不在对话历史里，但每次 API 请求都在，20 轮就是 30 万 token。

**做法：把说明书从 schema 搬到干跑结果里。**
schema 只留"调用前必须知道"的（类型、默认值、枚举），每条参数描述压到 ≤60 字符；
完整手册（2,553 字符 ≈ 1.7k token）在 `dryRun` **且扫描新鲜时**印一次，之后不再重复。

| | 之前 | 现在 |
|---|---|---|
| 五工具合计 | 22,855 字符 ≈ 14.9k token/轮 | **11,777 字符 ≈ 7.7k token/轮** |
| 参数说明 | 12,647 | **2,961** |
| 一次性手册 | — | 2,553 字符（只在首次干跑） |

按轮数算净收益：1 轮 -37%、5 轮 -46%、10 轮 -47%、**20 轮 -48%**（旧 297k token → 新 155k）。

历史曲线（供对照，说明"新版本才贵"是错觉）：v0.5.0 就是 9,448/轮；**v0.5.4 的参数重设计
（need/budget/maxPerSheet/segment）把它抬到 14,216**；0.6.0 只多 4.5%。

两条新测试守着：schema 合计 < 13,500、storyboard < 6,000；说明书必须"首次出现、命中缓存不再印"。

## [0.6.0] - 2026-11-01

> **破坏性重构**：`cells` / `sheets` / `need` / `maxPerSheet` / `adaptive` / `tileFirst` /
> `planThresholds` / `size` 全部删除；切点扫描之后的那一整条链路重写。

### 新架构：档位 + 可变网格

扫描出切点之后，旧版是：`suggest()` 猜格数 → `rodt` 按密度挪格 → 格内摊开 k×k 子帧 →
`measure` 量帧数 → 按帧数切张 → 补满布局 → 裁暗场 → 并尾 → 音乐驱动判定。
每一层都在给上一层的历史问题打补丁，最后"要 5 格给 6 格"这种事说不清。

现在三步，一条直线：

1. **帧 = 镜头**。真切点切段；积分采样点在真切点之间补（画面变化率累够阈值就记一个假切点、
   然后清零，往复）。一段一帧，时间轴永远被完整覆盖。
2. **档位 = 切点密度**（`tiers.js`，照用户给的 `取帧分档算法.docx`）：100 帧卷积窗 →
   "每帧切点概率" → 50 帧平滑 → 7 阈值 + 5% 滞回的 8 档状态机。档位 k 的格子边长 = **1/k**。
3. **排布 = 按行打包**（`pack.js`）：档位序列喂进 DP，按行精确最优地填满方形画布，
   装不下才开下一张。

删掉的模块：`layout.js`(310) / `measure.js`(279) / `density.js` 的密度分配（积分采样点搬进
tiers.js）/ `plan.js` 的布局·suggest·音乐驱动（只剩窗口规划）；`frames.js` 砍掉
`chooseSubGrid` / `subTileTimes` / `splitByWeight` / `extractSubTile`。净减约 1900 行。

### 参数：从"几格"改成"几帧 / 多大 / 几张"

| 删 | 加 |
|---|---|
| cells · sheets · need · maxPerSheet · adaptive · tileFirst · planThresholds · size | maxFrames · strategy · maxSheets |

`strategy`：`quality` 每帧升一档（1 档不再升）/ `balanced`（默认，只把 1 档压成 1/2）/
`saver` 降一档 / `frugal` 降三档。**张数不再是输入**，是排布的结果。

### 画布 800×800 / 384 token

DS 的视觉上限就是 800×800（384 token）。旧版按 42px 网格算到 990 token 并允许 budget 1.2M ——
清单里的 `cell=` 是假数（模型实际拿到的是被缩回 400×225 那一档）。现在：

- `budget` 夹在 64k..640k，`fitCanvas()` 保证任一边 ≤ 800
- 清单与成本行一律按 **384/图**
- 每档抓帧分辨率 = 该档格子像素（2 档 400×225、4 档 200×113、8 档 100×56）——
  两档以上再抓 720p 已经没有意义

### 排布细节

- `bounds(1) = [1/2, 1]`：1 档可缩到半格（四个 1 档正好 2×2 占满一张）
- DP 目标加**箱子代价**（`tiers.BIN_COST`）：balanced 1.02 / quality 0.55 / saver 1.5 / frugal 2.5。
  没有它 `[1,1]` 会被排成两张各 100%；没有分策略则 quality 也舍不得多开一张图
- `toRects()` 补上垂直方向 1px 对齐（原来只修水平，相邻行会重叠 1px）
- `composePacked()` 给排布留白（行内右侧 + 画布底部）铺灰条：纯黑会被读成"渲染失败"
- **补位 fillGaps**：排布后某张图填充率 < 68% 时，把这张图里**最长的几段切开**（多取几帧）再重排。
  关键是**帧数要凑成完全平方数**：正方形只能铺到 n/k²，6 个 1/3 格 = 2 行 × 3 个 = 67%，
  补到 9 个才是 3×3 = 100%。切点取段起点的哈希（0.35~0.65），同一部片可复现。
  判据是"欠满总量" `Σ max(0, 0.68 − 每张fill)` 下降（用 min / 平均值 / 欠满张数都看不出进展）。
  **允许为此多开一张图**：半张灰条也是 384 token，满的图每 token 有效画面更高。
  另外支持**自由尺寸帧**（`tier = 0`，边长由排布器按剩余空间定，下限 1/24）：平方数已凑齐但还有缝时用它填。
  实测概念 PV 5 张 79.6%（最低 50%）→ 6 张 83.3%（最低 71%）。
  显式传了 `maxFrames` 就不补位（说 4 帧就是 4 帧）。
- **编号规则**：6 档及以上（1/6…1/8，格子只有 ~100px 宽）用 scale 2，不再占 1/3 格宽；
  **积分假切点的格子不烧编号**（它不是"换镜头"），图上因此会跳号，清单里用 `[integral]` 标出来。
- **画布裁到内容**（`composePacked` 之前先量内容的外接矩形）：底部/右侧的灰条不是"没内容"，
  是"这张图就排到这"。裁掉之后每张图的高度由它自己的行数决定（800×450 / 800×343 / 800×275…），
  内容一点不少、token 还更省，**抓帧尺寸完全不变**（rect 仍按理想画布算）。
  正式 PV 5 张从「67/99/90/77/67% 铺在 800×450 里」变成「每张都贴合内容」。
  清单头部列出各张真实尺寸（`image="800x343 / 800x489 / …"`），`fill=` 标注为"裁之前"。
- `pack.solve({ fillRows: false })` 也实现了（格子按档位尺寸放、不强行凑满一行）：
  填充率更高但**张数会涨**（正式 PV 5 → 7 张），舍本逐末，所以 pipeline 默认仍用 `true`。

### 档位改名（六个玩笑名 → 五个按尺寸排的词）

原来叫 `quality` / `balanced` / `saver` / `frugal` / `thrifty` / `ultra`，中文是"高性能 / 均衡 / 节省 /
乞丐 / 恭喜发财 / 丐中丐"。一半是玩笑，跟"每帧多大"没有语义关系，模型看名字猜不出行为。

| 旧 | 新 | 行为 |
|---|---|---|
| `quality` | **`full`** | 每帧升一档（1 档不再升） |
| `balanced` | **`standard`** | 只把 1 档压成 1/2 |
| `saver` / `frugal` | **`compact`** | 每帧降一档 |
| `thrifty` | **`skim`** | 全 1/8、无假切点、切点按 0.35s 合并 |
| `ultra` | **`brief`** | 全 1/8、切点间隔自适应到整段装进一张图 |

**默认从 `standard` 改成 `compact`**：同一份切点，概念 PV 从 5 张 79.3% 变成 **3 张 98.4%** ——
少开两张图、填充率还更高（降一档之后格子更接近方形，铺得更满）。5 分钟素材 19 张 → 10 张。

旧名全部保留为别名（`STRATEGY_ALIASES`，内部 `resolveStrategy()` 归一化），一年内不报错。

### 三个调试旋钮也暴露给模型了

之前 `scanGap` / `integral` / `integralSeconds` 只存在于代码里，schema 没声明 —— 模型想调也调不到。

| 参数 | 默认 | 作用 |
|---|---|---|
| `scanGap` | `0` | 两个切点之间至少隔几秒（0 = 不合并）。调大能把连闪镜头并成一个边界 |
| `integral` | `true` | 是否在长镜头里按画面变化积分补帧。关掉只留真切点 |
| `integralSeconds` | `6` | 一个采样帧代表多少秒累积变化（1–30）。越小 = 长镜头里补得越密 |

实测（概念 PV）：`integral:false` → 74 帧降到 61 帧、积分点 13 → 0；`scanGap:1` → 59 刀降到 51 刀。

### 档位 ↔ 假切点 / 切点合并 一览

| 档 | 档位 | 假切点 | 切点合并 | 概念 PV 实测 |
|---|---|---|---|---|
| `full` | 每帧升一档 | 保留 | — | 18 张 / 6912 token |
| `standard` | 1 档压成 1/2 | 保留 | — | 5 张 / 1920 |
| **`compact`（默认）** | 每帧降一档 | 保留 | — | **3 张 / 1152** |
| `skim` | **全部 1/8** | **关** | **0.35s** | **1 张 / 384** |
| `brief` | **全部 1/8** | **关** | **自适应到装进一张** | **1 张 / 384** |

`skim` 是新增的：不看原来算出来几档，全部压到 1/8；关掉积分假切点；扫描期按 0.35s
合并近邻切点（59 刀 → 52 刀）。一支 90 秒 PV 用 **384 token 一张图看完 53 个镜头**，
能认出「这是什么画面、换没换镜头」，认不出字幕和脸。

`brief`：间隔**自适应加大**（×1.3 一轮）直到整段能装进一张 1/8 档图（≤56 格）。
沧野 5 分钟：150 刀 → **50 刀（gap 3.6s）→ 51 帧 → 1 张 384 token**。

### 档位映射表 `tierMap`（给模型自己调）

`strategy` 是六个预设，`tierMap` 是**任意映射**：

```js
video_storyboard({ input, tierMap: { 5: 4, 6: 4, 7: 4, 8: 4 } })
```

接在 `strategy` 之后（最后一道闸门），键和值都是档位 1..8：

- **没写的档位原样保留**（不是"删掉"）
- 多档映射到同一档 = 合并视觉尺寸（`{5:4,6:4,7:4,8:4}` 把快剪全部按 1/4 算）
- 补位帧（`tier 0`）不参与映射；越界的键值直接忽略
- 清单里会回显 `tierMap=1->1,2->1,...`，改没改生效一眼能看出来

概念 PV 实测同一份切点：默认 5 张 79.4%（档位 1/2~1/8）；映射成 1/1~1/4 后**还是 5 张，填充 99.7%**（每张 98-100%）。

### zoom 也修了

`minFrames: 4` + `uniformTier: 'auto'`：一个 23 秒长镜头窗口里可能一个切点都没有，
以前会只返回 1 张满格图；现在保证至少 4 帧，且档位统一成 `ceil(√n)`（n 帧铺 √n×√n 一张图）。
实测：23 秒窗口 → 5 帧一张图，每格 267×150（shot 级能分辨镜头），填充 83%。
- 编号**跨张连续**（`seq + 1`），每格清单写 `k=` 档位

### 其它

- **积分假切点的帧 +2 档**（`tiers.MARK_BOOST`）：真切点是"换镜头"，假切点是"一直在变、攒够了才切"，
  后者没有硬边界，一帧代表不了多久，所以给更小的格子。加在 `applyStrategy` 之前。
- **帧数 / 张数默认不封顶**：`maxFrames` 与 `maxSheets` 默认 0 = 不限。
  一部长片几千刀就是几千帧、几十张图，代价（解码时间 + token）由调用方自己承担；
  填空数才按"合并最短的段"收缩。实测 120 刀素材 → 121 帧 → 2 张图，不再被 96 截断。
- `scanGap` 默认 **0**（关闭扫描期最短间隔）：快剪不该在扫描阶段就被合并
- `pick` 默认 **`mid`**：每格只有 100~800 px，锐度三选一换不来可见收益
- zoom 固定 `strategy:"quality"` + `maxSheets:1` —— 它就是"看清楚"的那个工具
- 清单新增：最小格尺寸与可读性、档位直方图、占用率、积分采样点数
- 测试 287 → 444，新增 `tiers.test.mjs`(17) 与 `pack.test.mjs`(10)

## [0.5.11] - 2026-11-01

> `0.5.10` 已废弃（deprecated）：它带着下面第一条那个崩溃，别装。内容全部并进本版。

### Fixed — `cannot get property "attachments" without inject`

用户实报（Win10 / DSH 0.2.1-rc.3 / Node 24.21）：0.5.9 之后分镜工具直接报这句，退回 0.5.3 才好。

根因是 0.5.9 修"装插件卡死"时**只改了一半**：`inject` 里去掉了 `attachments`（cordis 的
`inject` 是硬依赖，服务缺失会让 `apply` 永不执行），但访问点只是加了个 `?.`：

```js
const saveImage = ctx?.attachments?.saveImage;   // 看着像运行期探测，其实照样炸
```

cordis 的 `ctx` 是 Proxy：服务没在 `inject` 里声明时，`get` 陷阱**直接抛**
`cannot get property "xxx" without inject`。`?.` 只挡 `null` / `undefined`，**挡不住异常**。

现在统一走 `serviceOf(ctx, name)`：优先 `ctx.get(name)`（cordis 给可选依赖的正规取法，
没注册返回 `undefined`），老宿主才退回属性访问且整段包在 `try` 里。

- `src/tools/shared.js`、`src/tools/subtitles.js` 两处访问点改用 `serviceOf`
- `test/service-optional.test.mjs` 用一个"像 cordis 那样抛"的 Proxy 钉住：`serviceOf` 收得住，
  工具给的是可读错误（`no \`attachments\` service`）而不是宿主内部原话

### Transcript as a separate pass (`./transcript-pass`)

The four-level transcript decision (`transcriptFile` → site CC → embedded track → local ASR) used to
be inlined in `pipeline.js`, so anything that wanted *only* the text had to run the whole scan.
It is now its own module and the pipeline calls into it — same judgement, one implementation.

- **`resolveTranscript()`** — the inlined block, extracted verbatim. `pipeline.js` lost ~130 lines and
  keeps only its accounting (`asrLife` / `asrSeconds` / `asrCached`).
- **`prefetchTranscript({ input, from, to })`** — the text for an arbitrary window, no pictures.
  Resolves the input to local media (sharing the download cache with the picture pass), probes audio,
  then: site CC → per-film cache → ASR. A window that is already covered by the cache returns in
  milliseconds and never wakes the ASR backend.
- **`formatManifest(..., { omitTranscript: true })`** — cells keep their times but drop their
  sentences, and a single line says where the text went. For callers that already sent the words
  separately; repeating them costs ~50% more tokens (17k vs 26k over 2 hours).
- **Per-film transcript cache keeps the widest coverage** (`MAX_RANGES` 24 → 48). Segment-wise
  prefetch on a 3-hour film would otherwise evict the opening from the front.

## [0.5.9] - 2026-11-01

修一个**能让宿主卡死**的接线问题（用户反馈"装插件 / 装服务时 DSH 卡住"）。

### Fixed

- **`inject` 不再声明 `attachments`**。cordis 的 `inject` 是**硬依赖**：服务没就绪，`apply` 根本不会被调用，
  插件永远停在"加载中"——用户看到的就是装完插件后应用卡住，日志里什么都没有。
  `attachments` 只在两处用（提交分镜图 / 字幕长图），现在改成**运行期探测**：有就出图，
  没有就返回一句可读的说明，工具照常注册可用。
- **`apply` 加 15 秒看门狗**。宿主启动时会等所有插件的 `apply`；只要里面有一条 await 永不 resolve
  （典型：解析宿主包时撞上坏掉的路径/软链），整个应用就卡在启动屏。超时后放弃注册并交回空 disposer ——
  最坏是插件不能用，不是应用起不来。
- 陪看包（`dsh-watch-together`）是同一份接线，同步改了（未发版）。

### Tests

- 断言 `inject` 只有 `tools`；
- 新增"宿主没有 attachments 服务时 apply 仍然成功、5 个工具照常注册"的回归。

## [0.5.8] - 2026-11-01

### Fixed

- **缓存键漏了 `minGap`**（今晚排查切点参数时撞出来的）：`cacheKey` 只含 文件/窗口/阈值，
  不含 `minGap` —— 于是"把阈值下限从 12 调到 20，刀数反而变多"，因为拿回来的是旧配置的 cuts。
  现在 `minGap` 进键（另一处调用也补上 `scanGap`），并加了回归测试。`CACHE_VERSION` 22（升级后首跑会重扫一次）。
- 合并 5 个社区 PR：窗口内 OCR 的 `-ss` 不再叠加 `winStart`（#45）、缓存命中读回 `meta.json`（`readFile` 漏导入）、
  CLI `--detail high` 真正打开 OCR（#44）、`fixed=0` 不再在清单里静默（#46）、ASR/OCR 分句级对齐（#46）。

### Performance

- **扫描快 1.8×**（1080p / 5 分钟 / 7483 帧：6.0s → 3.3s）。两个开关：
  - `scale=…:flags=area`：1080p → 64×36 用默认 bicubic 缩放要 2.9s，占整个扫描近一半；
    area 是盒式平均，缩这么狠时低频行为与 bicubic 一致，判定结果不变（6 类伪切点仍全 0、召回不变）。
  - `-skip_loop_filter all`：扫描只要缩略帧，h264/hevc 的去块滤波细节在 1/30 缩放下看不见，
    却占约 17% 解码时间。对其它编码器是无害空操作。
  - 剩下的时间已经在**解码地板**上（纯 ffmpeg 跑同一条：3.27s）。再快只能改算法（跳帧/多进程），
    实测双进程并发只有 16% 收益（ffmpeg 已经吃满 ~5 线程），不值。
- `decideCuts` 里两处 O(n²) 去掉：邻域判据改成二分定位时间窗、最近邻只看左右相邻事件。
  微基准（60 分钟/9 万帧）：380ms → **45ms**，细扫档 473ms → **22ms**；判定结果逐条相同。
- **删掉 `spread`（改动面积）与 dHash 两套"诊断字段"**：它们是为了防伪切点加的，最后实测都没能当门槛用上，
  却要在逐帧热循环里多算一遍 16×9 累加和一次指纹。现在 `scorePairDetail` 整个删除，扫描循环直接回到
  `scorePair`（少一次全帧遍历、stats 对象少两个字段、缓存更小）。
- 删掉从未被引用的 `src/flicker.js`（104 行）与两个死导出（`__resetPythonCache`、`scanBandChanges`）。
  `checkBiliLogin` / `looksLikeVideoUrl` / `waitForPort` / `configuredLaunch` 看起来没人用，但**陪看包在用**，保留。

## [0.5.7] - 2026-10-31

这一版重做切点的**尺度一致性**，并补上"伪切点"这半边测试。

- **阈值改在原始刻度上算**。0.5.5 起分数按亮度归一化，但阈值仍是"对归一化后的分数取分位"——
  暗场分数被放大把分位阈值整个抬高了（记管概念 PV：47 → 79），于是**亮场里的真刀掉到门槛以下**。
  实测 22.25s 那一刀两个版本同帧同分（48），0.5.4 保留、0.5.5 之后丢掉。现在阈值用原始分算，
  比较仍用归一化分（`原分×增益 > 原阈值`）：亮场回到 0.5.4 的行为，暗场照旧被救。
  细扫的两道闸（`PER_FRAME_MEAN`、`minScore`）也全部改回原始刻度。
- **细扫的刀要够得着粗阈值的 3/4**。只按"本窗低分位"判会把 2–4 分的抖动当刀
  （PV 上 23.9/24.0/35.9/55.0 抽样确认是同一镜头里换张画）。
- **新增"邻域持续在动"护栏**：一次剪辑是"安静→一下→安静"，甩镜/匀速摇镜在切口前后同样吵。
  候选左右 0.06–0.15s 里，分数高过"本刀一半"的帧占比 ≥60% 就否决；密到每 2 帧一剪时跳过。
- **新增伪切点测试素材六类**（局部变化+一拍二、手持微抖、推镜、粒子、快速甩镜、匀速运镜），
  现在的检出是 0/0/0/0/1/0 刀；召回不变（硬切 9/9、暗场 7/7、遮幅 9/9、快剪 9/11、局部突变 1/1）。
- **与 0.5.4 逐刀对齐**（记管概念 PV，90s/24fps/1080p）：共同 39，我多 13（分数 43–139，抽检是真剪辑，
  0.5.4 漏的），我少 5（46.5 / 47.1 / 53.8 / 62.7 / 63.7，抽检全是真刀但都夹在密集段里被 0.35s 间隔合并）。
  共 52 刀。试过把护栏放到 75% 能找回 2 个，但会把极端甩镜的伪切点从 1 个带回到 2 个，所以没采用。
- `stats` 多两个诊断字段：`spread`（16×9 块的改动面积）与 `raw`（归一化前的分数）。
  `spread` **只做诊断不当门槛**：暗场真刀的 spread 只有 0.02–0.10，拿它硬挡会把暗场召回打到 0。

## [0.5.6] - 2026-10-31

0.5.5 上线几小时后被一支真实的动画 PV 打回来的补丁：**切点把"一拍二"当成了剪辑**。

- **细扫（`refineCutsByWindow`）的采纳门槛退回绝对值 25**，不做"相对本窗基线"。
  0.5.5 里改成 `max(6, 3×窗内中位分)`，本意是救暗场快剪（刀均分 19.3、窗内常态 4.1），
  结果在逐帧动画上全线崩：记管概念 PV 从 44 刀涨到 122 刀，抽 8 个新增点逐个看前后帧，
  6 个是同一个镜头里换张画（硬币在手里转、白剪影摆姿势）。
  相邻帧差这个信号**分不开**"整帧换场"和"局部换画"，靠调门槛只会两头晃 ——
  要放宽必须先有空间证据（改了多少块/多少像素），留给下一版。
- **新增"逐帧动画"护栏**：非"每帧都在大改"的窗口，细判出的刀必须至少隔 3.5 帧，
  否则不采纳。2 帧一换是动画工艺，不是剪辑。
- `CACHE_VERSION` 9 → 10（判定变了，旧条目的 cuts 会散）。

实测（记管概念 PV，90s / 24fps / 1080p，CLI 同参数）：**0.5.4 = 44 刀 → 0.5.6 = 74 刀**（0.5.5 曾到 122）。
多出来的部分集中在两段快剪：52–58s 的 21 刀里有真换场的、也有同一镜头里换张画的，
抽检分不清；比 0.5.4 多、比 0.5.5 少。**还没有回到 0.5.4 的数字**，因为归一化把暗底片子的分数
放大了 1.6 倍，"每帧都在大改"（`PER_FRAME_MEAN=30`）与 `minScore=25` 这两道闸在放大后的刻度上
更容易被踩到。要真正分开"整帧换场"和"局部换画"，得加**空间证据**（一帧里改了多少块/多少像素），
这件事留给下一版，别再用门槛去凑。

## [0.5.5] - 2026-10-31

三条线并进：**切点判据换了口径**（暗场/遮幅/叠化/快剪不再系统性漏）、**排布决策收敛到
`planLayout()`**、以及一批"静默失效"的修复（台词没了、条带空着、几张图被读成一条时间轴）——
最后这一类每一件都不报错，全靠用户的截图才发现。

### Fixed

- **分离的视频/音频流现在由插件自己合流，不再依赖 yt-dlp 找到 ffmpeg**（#43 的真正根因）。
  yt-dlp 找不到 ffmpeg 时只打一行 warning 就**静默降级成只下视频**（退出码仍是 0），
  于是 26.5MB 的 `video.<id>.mp4` 只有画面、`video.f30280.m4a` 孤零零躺在旁边 ——
  清单却说"这条片子没声音"。现在：下载后发现成品没音轨、旁边有音轨文件，就用**自己的 ffmpeg**
  `-c copy` 合回来（几秒钟、不重编码），并把 `audioMerged` 写进清单；合不上才报错。
  另外去掉 `--no-warnings`（那行 warning 是唯一的现场证据），缺音时把 yt-dlp 的原话带进清单。

- **清单永远写明音轨在不在**：`<storyboard … audio="present|absent">`。
  以前 `transcript="no-key"` 很容易被读成"这视频没声音"，而它只表示"没配 key、根本没听"。

- **没有可画的响度时不画音频条带**。整段静音（或响度没测出来）时那条 20–70px 的带子是一块空白，
  白占画布 —— 现在跳过，并在 trace 里写 `strip:skipped`。判据是响度不是台词：
  没配 ASR 但有对白的片子，波形照样有用（`audio.js` 的 `hasAudibleSamples`）。

- **每张图顶部加一条时间抬头**（`0:00-4:35 1/3`）。多张图时模型很容易把它们串成一条时间轴 ——
  格子里只有全局递增的序号，反而更像"一张长图的第 12 格"。抬头用同一套点阵字形（不引入字体文件），
  高度在 `layoutCanvas` 里**预先扣掉**，所以"整图面积 <= budget"仍然成立。

- 文案：项目里对第三方站点的称呼统一为 **C站**（README/文档/清单/注释）。
  代码里保留 `bilibili.com` 只出现在"识别链接 / 调用站点接口 / cookie 域"这些**功能位置**。

### Changed

- **切点判据换了口径**（暗场 / 遮幅 / 叠化 / 快剪不再系统性漏）。`scorePair` 的输出没变，
  改的是判定前后两件事：扫描结束时按亮度归一（`gain = clamp(160/V均值, 1, 3)`）并按黑边占比补回
  （`/ (1-黑边占比)`）；抑制从"固定 0.35s 窗口"改成"先把连续帧聚成一刀，再按内容定半径"。
  新增 0.4s 长时差曲线做渐变转场（叠化/淡入淡出）。合成素材实测：暗场 0/7 → 7/7、
  2.39:1 遮幅 7/9 → 9/9、1s 叠化 0/3 → 3/3、0.32s 快剪 5/11 → 9/11（细扫 11/11），
  硬切与甩镜不变。代价是扫描 +7%。`CACHE_VERSION` 升到 6，旧缓存自动失效。

- **排布决策收敛到 `layout.planLayout()`**（`layout.js`，纯算术、零 IO、7 条不变量单测）。
  切格 / 放格 / 选格三层原来散在 pipeline 里，现在 pipeline 只剩编排与 IO（987 行）。
  行为变化集中在"张数由帧数决定"（不再是贪心切）与黑场单独占格。

- `refineCutsByWindow` 的采纳门槛从常数 25 改成"相对本窗基线"（`max(6, min(25, 3×窗内中位分))`）——
  暗场快剪的刀均分只有 19.3，而窗内常态 4.1，旧的常数门槛把细判结果全拒了。

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
- **C站 DASH audio (PR #19, issue #18).** `formatSelector` now requires `[acodec!=none]` on the
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

- **URL sources say the correction ran on the low-res copy.** With a C站 link the OCR runs against the
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
- **A login-gated video was read anyway, and the result was presented as if complete.** When C站 hides
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

  An expired or low-privilege `SESSDATA` makes C站 hand back a *shorter* format list — the plugin then
  believed it and reported "no 1080p source", which was true of the request and false about the video.

  Both the probe and the download path now go through one `probeSummary()`: when cookies are configured and
  the result caps at ≤720p, it probes once more anonymously and keeps whichever list is taller, recording
  why (`cookies 只允许 480p，匿名反而能拿到 1080p —— SESSDATA 可能过期…`). Verified: that URL now reports
  max 1080, `zoomTarget` 1080 and a 1080p direct link.
- **C站's HTTP 567 now says what it is and tries once more.** 567 is their risk control, not a format
  problem — most often a video that needs a signed-in session (1080P+, 会员/付费) or a rate-limit. Before, the
  message was yt-dlp's raw text, which reads like a plugin bug.

  **Docs gap this exposed**: `docs/SETUP.md` had a full cookies walkthrough all along, but the README — the
  page people actually land on — never mentioned cookies at all. There is now a "needs a signed-in video"
  section there: when it is needed, the three steps with Cookie-Editor, both config paths, the local-file
  alternative, and the reminder that `SESSDATA` is a login credential.

  Now: one automatic retry with a browser User-Agent, a `Referer` set to the page origin, and
  `--sleep-requests 1` (the retry only fires on 567/412, never on permanent errors); if it still fails, the
  error names both ways out — a cookies.txt, or download the file and pass a local path. `--retries 3
  --fragment-retries 5` also went into the base args, since CDN hiccups are routine.
- **A partial download was wiped on failure, so every retry started from zero.** On a flaky connection the
  media directory was removed (`rm -rf`) whenever yt-dlp exited non-zero — including the `.part` file that is
  the whole point of resuming. Reported as "下到一半直接清零重新开始，而且下得更慢". Now the directory is
  kept and `--continue` is explicit; stale parts are pruned by age instead.
- **Progressive streams were never tried, so every C站 download was a DASH pair plus a merge.** The
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

- **A downloaded copy with no audio track said "no audio in the source".** On an anonymous C站 URL the
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
3. **Vertical video could not be downloaded.** Every portrait URL from C站 died on the format selector.

Measured across ten content types (slide recording, surveillance, 2D animation, 3D short, studio news,
handheld vlog, mobile-game ad, anime mashup, concept PV, 51-minute documentary), the per-second cut count
went from a suspiciously uniform 0.22–0.27 to the range the content actually has: 0.08 for a slide deck,
1.18 for a mashup.

### Fixed

- **Vertical C站 videos could not be downloaded at all.** yt-dlp reports a 9:16 video's formats as
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

**A URL is now a valid input.** Paste a C站 link (or anything yt-dlp supports) instead of a local
path. Two decisions make this different from "download the video, then analyse it".

### Two-tier fetching

Scanning only needs structure — it gets downscaled to 64x36 — so it reads a 360p copy of the whole file
(~7 MB per 5 min). Close-ups go back to the original stream, one frame at a time, and never touch disk.

Why the low-res copy is downloaded at all instead of streamed: `pick:"sharp"` needs 3 candidate frames
per segment, 27 random seeks for a 9-cell grid. Local: 9.6 s. Over HTTP: 51.8 s. Seven megabytes buys
the right to jump around. Pure streaming would have been ~3.5x slower end to end.

### `transcriptFile` — skip ASR when the source already has captions

Accepts SRT, a plain `[{start,end,text}]` array, or C站's `{body:[{from,to,content}]}`, detected
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
