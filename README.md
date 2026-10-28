# dsh-video-storyboard

> 让 AI 真正"看过"一段视频：**一张分镜图 + 一份带时间码的文本清单**，模型据此回答"第 3 分钟发生了什么""这句话对应哪一格"。
>
> English: [README.en.md](README.en.md)

---

## 它解决什么问题

多模态模型看视频有两种笨办法：

- **逐帧抽图** —— 10 分钟片子按 1 fps 抽就是 600 张图，token 直接爆。
- **只喂字幕** —— 画面里的信息（构图、动作、场景变化）全丢。

本插件走第三条：**把画面压成一张宫格图**（384 token 封顶），旁边配一份**按时间对齐的文本清单**（每格起止时间 + 这一格里的台词 + 切了几刀）。

模型得到的是"这 90 秒里发生了什么、大概在第几秒"，需要细节时再用 `video_zoom` 放大某一段。

## 四个工具

| 工具 | 干什么 | 何时用 |
|---|---|---|
| `video_probe` | 只读容器头：多长、分辨率、帧率、有没有音轨/字幕、已分析过没有 | **第一次接触一部片子时先调它**，不花图片 token |
| `video_storyboard` | 出宫格图 + 文本清单 | 主体功能 |
| `video_zoom` | 只看某一段（更小的时间窗、更密的格） | 清单看完觉得某段重要，再放大 |
| `video_locate` | **纯文本**：一句话 → 时间码 | 知道说了什么、不知道在第几分钟 |

## 安装

**从零开始的完整步骤（含依赖、自检、排错）见 [docs/INSTALL.zh.md](docs/INSTALL.zh.md)。**

三句话版本：

```bash
winget install Gyan.FFmpeg          # 必须：ffmpeg + ffprobe
pip install --user -U yt-dlp        # 只有贴 B 站/YouTube 链接才需要
node scripts/install-dev.mjs        # 装插件，然后重启 DSH
```

| 依赖 | 必须吗 | 不装会怎样 |
|---|---|---|
| ffmpeg + ffprobe | **必须** | 第一步就报错 |
| yt-dlp | 可选 | 本地文件照常能用，贴链接不行 |
| ASR 服务 | 可选 | 能出图，但清单里没有台词 |

插件**不打包** ffmpeg 和 yt-dlp，只调用你自己装的那份。找不到时会给出安装指引，不会静默失败。

## 怎么用

### 贴一个链接

```
https://www.bilibili.com/video/BV1xx411c7mD
```

插件会自己下载、缓存，然后用本地文件的那套流程跑。竖屏、DASH、多分P 都处理了。

### 本地文件

```bash
node bin/storyboard.mjs film.mp4 --cells 9 --out film.png
node bin/storyboard.mjs film.mp4 --batch 300 --out film.png   # 长片按 5 分钟切窗
node bin/asr-check.mjs film.mp4 --from 100 --seconds 12        # 只测 ASR
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `input` | — | 本地路径或 http(s) 链接 |
| `from` / `to` | 全片 | 只看这一段 |
| `cells` | 自动 | 格数；不给就按 motion / 字每秒 / 响度 推 |
| `sheets` | 1 | 切成几张图（长片用） |
| `scanGap` | 0.35 | 粗扫时两刀最短间隔（秒）。快闪素材调小 |
| `pick` | `sharp` | 取帧策略：`sharp` 3 候选选最锐 / `mid` 段中点 / `thumb` 段内最典型 |
| `burn` | `index` | 烧格号；`none` 关掉 |
| `minGap` | 1.2 | 格子合并的最小间隔 |
| `transcript` | `auto` | `auto` / `off` |
| `transcriptFile` | — | 直接喂已有的 SRT/JSON，跳过 ASR |
| `detail` | `med` | 每格台词预算：`low` 60 / `med` 120 / `high` 400 字 |
| `cellRange` | — | 分页看文本清单 |

## 输出长什么样

一张图 + 一段文本：

```
<storyboard path="film.png" grid="3x3" size="1920x1080" fps="24.00" duration="90.09s"
            footer="teal bars = loudness, grey blocks = silence, yellow ticks = cut points"
            transcript="asr" cuts="44 (avg 2.0s)">

audio events (7): 00:00.50 +30dB, 00:12.80 -30dB, …
fast cuts: 00:42.80-01:04.80 (22 shots) — video_zoom({ from, to, cells: 6, minGap: 0.4 }) splits these
re-read at one-frame granularity: 00:47.10-01:03.70 18 shots (coarse saw 4)

cell 1 (r1c1) = 00:00.00-00:09.33  cuts 1
    "所以你连他也要忘记吗"
cell 3 (r1c3) = 00:33.29-00:47.08  cuts 10  16 frames (4×4)
    "…"
```

几条设计原则：

- **清单只给原材料，不下结论。** 不说"这是高潮""这里是角色 A"，只给时间、刀数、台词 —— 判断是模型的事。
- **每加一行都要能说出它挡掉了什么误判。** 说不出来就不加。
- **数字不可信时要说出来。** 例如连续运镜被逐帧切碎时，清单会写 `cut count unreliable here`，而不是让模型拿 `cuts=N` 当节奏依据。

## 算法要点

1. **画面差异**：缩到 64×36，逐帧比 HSV，色相按**环形**距离且**按饱和度降权**（灰色的色相没有意义），得到 0–255 的变化分。
2. **切点**：分数超过阈值即一刀。阈值不是固定的 —— 按本片自己的分数分布和时长推。
3. **爆点重判**：对每个 2 秒窗口，用**一帧**的间隔重新判一次。粗扫看不见 0.35 秒以下的刀，而快闪全在那一档。
4. **格位分配**：按"密度积分"等分 —— 每一格承载的信息量相同，快的地方自动分到更短时段。
5. **快闪摊开**：某一格平均镜头短于 1.4 秒（≥0.7 刀/秒）且刀本身够硬时，摊成 k×k 子格（最多 4×4）。

## 实测数字

| 项目 | 数字 |
|---|---|
| 单图 token | 384（9 格，1009×620） |
| 一次调用总量 | 384 + 约 1,000 字 ≈ **1,900 token** |
| 文本清单 | 约 1,500–2,200 字符（`detail` 可调） |
| 90 秒片子端到端 | 约 10 秒（含解码、扫描、取帧、拼图） |
| 快闪重判 | 零额外解码（复用逐帧分数） |
| 切点召回 | 概念 PV 44 刀 / 混剪 178 刀（151 秒）/ 口播 125 刀 |

## 需要登录的视频（B 站 1080P+ / HTTP 567）

**先说结论**：普通视频匿名就能看 360p；**要高清、会员、或遇到 567，才需要 cookies**。

### 什么时候需要

| 现象 | 需要 cookies |
|---|---|
| 提示 `HTTP Error 567` | ✅ 这是 B 站风控，多半是"该视频要登录" |
| `Sign in to confirm` / 需要登录 | ✅ |
| 想要 1080P 以上的清晰度 | ✅（B 站高清要登录态） |
| 普通视频、360p、匿名 | ❌ 不需要 |

### 三步导出（Chrome / Edge）

1. 装扩展 **Cookie-Editor**（作者 cgagnier）
2. 打开 bilibili.com 并登录 → 点扩展 → **Export** → 选 **Netscape** 格式 → 存成 `bili-cookies.txt`
3. 告诉插件它在哪：

```json
// ~/.dsh/video.json
{ "cookies": "D:/cookies/bili-cookies.txt" }
```

或者每次调用时传：

```js
video_storyboard({ input: "https://www.bilibili.com/video/BV...", cookies: "D:/cookies/bili-cookies.txt" })
```

也可以设环境变量 `DSH_VIDEO_COOKIES`（桌面版读不到 `setx` 的变量，优先用配置文件）。

> **为什么不能用 `--cookies-from-browser`**：Chromium 127+ 的 App-Bound Encryption 让 `SESSDATA` 只能由浏览器进程解密，
> 普通进程读出来是 `v20` 密文。所以必须**导出文件**，这是机制问题，不是你配错了。

### 不想配 cookies？

**直接把视频下载下来，喂本地路径**——插件对本地文件一视同仁，还更快：

```js
video_storyboard({ input: "D:/video/xxx.mp4" })
```

### 隐私提醒

`cookies.txt` 里的 `SESSDATA` **等同于你的登录凭证**。别提交到仓库、别发群里、别贴到 issue 里。
用完可以退出登录让它失效。

> 完整步骤（含格式示例、验证顺序、故障对照）见 **[docs/SETUP.zh.md §3](docs/SETUP.zh.md)**。

## 字幕与 ASR（怎么让它"听懂"）

转写是**可选**的：不配也能出图，只是清单里没有台词。

### 优先级（第一个能用的赢）

1. **视频自带字幕轨** → 直接读，不跑 ASR
2. **`transcriptFile`** → 喂已有的 SRT/JSON，完全不碰 ASR
3. **ASR 服务** → 上面两个都没有时才用

### 我们用的是哪个模型

| 后端 | 模型 | 冷启动 | 体积 | 标点 | 热词 |
|---|---|---|---|---|---|
| **sherpa（默认）** | `paraformer-zh-2024-03-09`（int8）+ `ct-transformer` 标点 + `silero-vad` | **约 5 秒** | 500 MB | 另加载 onnx 模型 | ❌ 无接口 |
| **funasr（可选）** | `seaco_paraformer_large` + `fsmn-vad` + `ct-punc` | 约 30 秒 | 2.1 GB | 内置 | ✅ |
| 云端 | `FunAudioLLM/SenseVoiceSmall` / `whisper-1` … | 0（联网） | — | 视服务而定 | 视服务而定 |

**为什么默认是 sherpa**：2024 版 paraformer 比旧版准（实测「像差」不加热词就对），而且冷启动 30 秒 → 5 秒、
内存 6.8 GB → 不到 1 GB。代价是它在 sherpa 运行时里**没有热词接口**，同音字只能靠 `terms` 表后处理。

**什么时候切回 funasr**：你的片子里专有名词多、热词列表很长（比如人名一堆），热词的收益大过 30 秒启动成本时。

```json
// ~/.dsh/asr.json 里加一行即可切后端（重启服务生效）
{ "model": "paraformer-zh-2024-03-09" }   // 在 start-asr.cmd 里设 ASR_BACKEND=funasr 则走另一套
```

### 配置 A：本机服务（免费、不联网）

`~/.dsh/asr.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "paraformer-zh-2024-03-09",
  "language": "zh",
  "hotwords": "像差 焦段 光圈",
  "manage": {
    "start": "D:/asr-local/start-asr.cmd",
    "idleMs": 5000,
    "waitMs": 60000
  }
}
```

- **本机地址不需要 `key`**（`127.0.0.1` / `localhost` / `[::1]`）。自己跑的服务一般不校验 Authorization，插件不会再逼你填一个假 key。
- `manage` 是生命周期托管：调用时端点不通就拉起；**最后一次运行结束后 `idleMs` 内没有新运行**，就请它自己退出（走服务的 `POST /shutdown`）。

**`idleMs` 要按后端设，两者差 100 倍**：

| 后端 | 建议 `idleMs` | 理由 |
|---|---|---|
| sherpa | **5000**（5 秒） | 冷启动只要 5 秒，随用随关，内存立刻还回去 |
| funasr | **600000**（10 分钟） | 冷启动 30 秒，关太早等于每次重付；关太晚又占着 6.8 GB |

  `hotwords` 只对 funasr 后端有效 —— sherpa 的 paraformer 没有热词接口，同音字请写进 `terms`。

服务端要满足两个约定：

```
GET  /health        → 200 即可（拿不到就读 /v1/models）
POST /shutdown      → 返回后退出（不支持也行，插件会退回杀进程）
POST /v1/audio/transcriptions   → OpenAI 兼容，返回 verbose_json
```

### 配置 B：云端服务（有 key 就行，任何 OpenAI 兼容）

```json
{
  "baseUrl": "https://api.siliconflow.cn/v1",
  "key": "sk-...",
  "model": "FunAudioLLM/SenseVoiceSmall",
  "language": "zh"
}
```

换成 OpenAI：

```json
{ "baseUrl": "https://api.openai.com/v1", "key": "sk-...", "model": "whisper-1" }
```

便宜的选择（自己按需改）：

| 服务 | baseUrl | model 示例 |
|---|---|---|
| SiliconFlow | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `paraformer-v2` |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` |

**云端不填 key 会直接跳过 ASR**（不会报错，清单写 `transcript: none`）。

### 配置 C：直接用现成字幕

```js
video_storyboard({ input: "film.mp4", transcriptFile: "film.srt" })
```

支持 SRT / VTT / JSON（`[{ "start": 1.2, "end": 3.4, "text": "..." }]`）。这条路**零 ASR 成本**，也最准——
平台自带的字幕比任何识别都可靠。

### 环境变量（优先级高于文件）

```
DSH_ASR_BASE_URL   DSH_ASR_MODEL   DSH_ASR_LANG
DSH_ASR_KEY        DSH_ASR_KEY_ENV
```

> 桌面版 DSH 的进程环境由启动器决定，`setx` 设的变量宿主读不到 —— **优先用 `asr.json`**。

### 热词（比换模型更有效）

识别错同音字时，**不要先想着换模型** —— 通用模型不知道你片子在讲什么。

```json
"hotwords": "像差 焦段 光圈 沧野 玄学"
```

空格分隔，交给 paraformer 解码时做偏置。实测（镜头评测视频）：

```
加之前：也就是所谓的相差。
加之后：也就是所谓的像差。
```

只加了一个词，别的一个没动。专有名词、人名、领域术语都该放这里。

> 需要服务端支持：`seaco_paraformer` 原生支持；自己搭服务时认 `hotword` 表单字段即可
> （不认这个字段的服务会忽略它，不会报错）。

### 术语校正

识别结果里的固定错字可以确定性替换（不进模型）：

```json
"terms": { "绘插": "彗差", "星尘边境": "Stardust Frontier" }
```

替换次数会报在清单里（`termsFixed N`），不静默。

## 和同类插件比（诚实的版本）

生态里做这件事的有三种路线，我们只走其中一条：

| 插件 | 做法 | 一次 90 秒片子的成本 | 它更强的地方 |
|---|---|---|---|
| **dsh-video-see** | 抽帧作为**真图片**交回模型，每张带时间戳 | 20 帧 ≈ **7,680** token | 每一帧都是 ~1000px，小字、表情都清楚 |
| **dsh-video-lens** | 关键帧 → **外部 VLM** → 返回 evidence JSON | 帧数 × 384 **+ VLM 调用费** | 有 `video_ask` 时间锚定问答；结论结构化 |
| **watch-skill** | 帧 + 转写 + OCR **索引成库**，按需查询 | 建库贵，**追问几乎免费** | 答案带回执，可被另一个东西复核 |
| **我们** | 一张宫格图 + 文本清单，模型自己看 | **约 1,900** token | 单位 token 覆盖的时间最长（1 张图 = 90 秒） |

**同一部 90 秒片子，各种"按镜头取关键帧"的方案落在 3,900–8,500 token**（8 / 16 / 20 帧 + 字幕摘要），
**我们是它的 1/2 到 1/4.5**。不是 1/8 或 1/16 —— 那种数字是拿"每秒抽一帧"当对手，不诚实。

### 我们明确输的地方

| 输给谁 | 为什么 | 我们的补救 |
|---|---|---|
| dsh-video-see / lens | 单帧清晰度（每帧 ~1000px vs 我们的格 331×184） | `video_zoom` 再取一次，**但那是第二轮成本** |
| watch-skill | 多轮追问的边际成本（它索引一次就能反复查） | 清单里明说"图已在上下文"，追问不再重新出图 |
| watch-skill | 可验证性（答案能被第三方复核） | 每张图配一份 `.evidence.json`，时间码可回看 |
| lens | 结构化 evidence、时间锚定问答 | `video_locate` 做时间定位，`evidence.json` 给结构 |

**适合谁**：想先搞清"这部片子讲什么"的人。
**不适合谁**：逐帧辨字、要复核结论、对同一部片子问二十个问题 —— 那三种情况请用上面三家。

## 明确不做的

- **不烧时间码进画面** —— 占像素、压缩后先糊，时间在文本里有 0.01 秒精度。
- **不做说话人分离** —— 实测 cam++ 在 1.9 秒短句上把单人素材切成 6 个人。
- **不打包 ffmpeg / yt-dlp** —— 版本和安全都由用户掌握。
- **不把"结论"写进清单** —— 那是模型的工作。

## 已知限制

- 画面小于约 1% 的改动（PPT 上多一行字）在 64×36 上不可见，再聪明的阈值也救不回来。
- 连续运镜密集时，`cuts=N` 会失真（清单会标注）。
- 极暗素材的取帧锐度判断不稳。
- 分格摊开后子帧最小约 100×56，再小就只剩色块。

## 证据与复核

每次 `saveStoryboards` 会同时写一份 `<名字>.evidence.json`：每格的起止时间、取帧时刻、刀数、字数、原文。
清单是给模型读的散文，这份是给人和脚本复核的 —— 想知道"第 5 格真的是 3:29 吗"，对着时间码回看原片即可。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.zh.md](docs/INSTALL.zh.md) | 从零安装：依赖、自检、排错表 |
| [docs/USAGE.zh.md](docs/USAGE.zh.md) | 完整手册：三条安装路径、六个工作流、每个参数 |
| [docs/HISTORY.zh.md](docs/HISTORY.zh.md) | 从 v0.1 到现在，按"被什么打脸"组织 |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本变更 |
| [CREDITS.md](CREDITS.md) | 第三方致谢、社区贡献、测试素材作者 |
| [README.en.md](README.en.md) | English |

## 许可

见 [LICENSE](LICENSE)。
