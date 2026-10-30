# 安装与使用（详细版）

> 面向第一次用的人。所有命令都能直接复制执行；括号里是"为什么"。
> English version: [USAGE.md](./USAGE.md)

---

## 0. 它是什么，一句话

把一段视频压成**一张带编号的宫格图**，每格配时间码和那一段说过的台词，底部还有一条同轴的音频条带。
模型因此能「看」视频、能引用「第 5 格」、能要求「再放大看这 3 秒」。

一张图 384 token，9–16 帧共用一张。

---

## 1. 前置条件

| 需要 | 检查 | 说明 |
|---|---|---|
| Node ≥ 20 | `node --version` | 用到内置 `fetch`、`node --test` |
| ffmpeg + ffprobe | `ffmpeg -version` | 唯一的外部依赖，不随插件分发 |
| DSH（桌面版或普通 profile） | — | 插件跑在它的工具层上 |

ffmpeg 不在 PATH 时，用环境变量指定：

```bash
DSH_FFMPEG_PATH=D:/ffmpeg/bin/ffmpeg.exe
DSH_FFPROBE_PATH=D:/ffmpeg/bin/ffprobe.exe
```

---

## 2. 安装

### 2.1 桌面版（多数人）

桌面版的 profile **由 Electron 独占管理**，`dsh plugin` 会拒绝，必须用仓库自带的脚本：

```bash
git clone https://github.com/SAOS-3624/dsh-video-storyboard.git
cd dsh-video-storyboard
node scripts/install-dev.mjs            # 复制到 profile 并注册
```

然后 **重启 DSH**（插件树只在进程启动时组装）。

- 查状态：`node scripts/install-dev.mjs --check`
- 卸载：`node scripts/install-dev.mjs --remove`
- 改完代码：**重跑脚本 + 重启**（复制的是快照，不是软链）

> 为什么不用软链：Node 解析裸模块名（`@deepseek-ai/dsh-tools`）会顺着**真实路径**往上找，
> 软链会让它从仓库目录往外爬，永远找不到宿主包。

### 2.2 普通 profile

```bash
dsh plugin --profile web add dsh-video-storyboard
```

### 2.3 只想在命令行用（不装插件）

```bash
node bin/storyboard.mjs your-video.mp4 --cells 9 --text
```
`bin/*.mjs` 全部独立可用，不需要 DSH。

---

## 3. 第一次跑通（3 分钟）

```bash
# ① 先看容器信息，不花钱、不出图
node bin/storyboard.mjs your-video.mp4 --plan 30

# ② 出一张图 + 清单
node bin/storyboard.mjs your-video.mp4 --cells 9 --out sheet.png --text

# ③ 只看某一段（不扫全片）
node bin/storyboard.mjs your-video.mp4 --from 120 --to 180 --cells 6 --text
```

第 ② 步应该看到类似：

```
[probe] 1920x1080 24.00fps 299.41s audio
[scan] 7186 帧 → 141 个切点（阈值 16，自适应 28 个密集段）
[audio] mean -23.0 LUFS, peak -13.4 LUFS, 1 silence gaps (1.9s of 299s)
[transcript] asr (paraformer-zh)，136 段
[sheet] sheet.png  1009x623  3x3  cell≈331x184  strip=55px

<storyboard ... grid="9 cells x 1 image(s)" ... cuts="141 (avg 2.1s)">
cell 1 (r1c1) = 00:00.00-00:33.10  cuts 9
    "评价一个镜头的好坏，先说它的评价标准……"
```

---

## 4. 两个工具，怎么选

| 你想干什么 | 用哪个 |
|---|---|
| 这段视频大概是什么、结构如何 | `video_storyboard`（默认 3×3，一张图） |
| 第 3 分钟那个镜头到底写了什么字 | `video_zoom({ from, to, cells: 4 })` |
| 还不知道多长、有没有音轨 | `video_probe`（0 token） |
| 两小时的电影整体过一遍 | 先 probe，再决定"结构读"还是"顺序读" |

**两段式是核心用法**：先用 384 token 看结构，再花 384 看细节。不要一上来就要高清。

---

## 5. 参数速查

### video_probe

| 参数 | 默认 | 说明 |
|---|---|---|
| `input` | 必填 | 视频绝对路径 |

返回：时长/分辨率/fps/旋转/音轨/字幕轨 + **两种读法**（结构读＝会剧透，顺序读＝不剧透）。

### video_storyboard

| 参数 | 默认 | 什么时候改 |
|---|---|---|
| `input` | 必填 | — |
| `from` / `to` | 全片 | 长片按窗口读；追剧情时用它避免剧透 |
| `cells` | 自动 | 1–16。想更细 → 12/16；想更清楚 → 4/6 |
| `sheets` | 自动 | 1–4。每张图 384 token，多张 = 多花钱 |
| `pick` | `sharp` | 只有想要"段中点"或"直方图代表帧"时才改 |
| `burn` | `index` | `none` 关掉格号。时间码从不烧进画面——清单里本来就是 0.01 秒精度 |
| `minGap` | 1.2 | 快闪段落可降到 0.4，让短镜头各得一格 |
| `transcript` | `auto` | `off` 关闭台词层（纯画面分析时省 token） |
| `detail` | `med` | `low` 60 字 / `med` 120 / `high` 400（按句末截断） |
| `cellRange` | — | `[14, 42]` 只取这一段文本 |
| `textOnly` | `false` | 只出文本、不出图（翻页神器，约 0.8 秒/页） |

### video_zoom

| 参数 | 默认 | 说明 |
|---|---|---|
| `input` / `from` / `to` | 必填 | 窗口越短，每格越清楚 |
| `cells` | 6 | 1–9。3–4 格适合读字幕/人脸 |
| `minGap` | 1.2 | 0.3–0.4 让快闪镜头不被合并 |

---

## 6. 常见工作流

### A. 短视频看结构（< 2 分钟）

```js
video_storyboard({ input, cells: 9 })          // 一张图
video_zoom({ input, from: 12, to: 18 })        // 觉得某段有意思再放大
```

### B. 长片顺序读（追剧情、怕剧透）

```js
video_probe({ input })                          // 先知道多长
video_storyboard({ input, from: 0,    to: 300 })
video_storyboard({ input, from: 300,  to: 600 })
// …一次 5 分钟，永远不往后看
```

每段的扫描结果会缓存，回头重看某段是免费的。

### C. 长片结构读（做索引、判断值不值得看）

```js
video_storyboard({ input, cells: 16, sheets: 4 })   // 4 张图盖全片
video_storyboard({ input, from: 600, to: 900 })     // 只打开可疑的段落
```

### D. 快闪蒙太奇

```js
video_storyboard({ input, from: 42, to: 50, cells: 12 })    // 先看密度（每格 cuts N）
video_zoom({ input, from: 43, to: 46, cells: 6, minGap: 0.4 })  // 再按真实镜头切
```

### E. 大段台词（想引用原话）

```js
video_storyboard({ input, cells: 9, detail: 'low' })          // 总览，便宜
video_storyboard({ input, cells: 9, textOnly: true, cellRange: [4, 6], detail: 'high' })
```

### G. 贴一条 B 站链接

```js
// ① 先探长度和"能拿到多高"，不下载（约 2.4 s）
video_probe({ input: "https://example.com/some-video" })

// ② 出总览；首次会下一份 360P（5 分钟约 7 MB），之后命中缓存
video_storyboard({ input: "https://example.com/some-video", cells: 9 })

// ③ 某一段看不清 → 回到原始流取 1080P，不落盘
video_zoom({ input: "https://example.com/some-video", from: 42, to: 58 })
```

**如果站点本来就有字幕，别让它再跑一遍 ASR**：把字幕存成 SRT 或 JSON，用 `transcriptFile` 传进去。
同一条 90 秒片子，带 ASR 16.9 秒、带字幕文件 **5.1 秒**。

```js
video_storyboard({ input: url, transcriptFile: "D:/subs/ep04.srt" })
```

支持三种格式：SRT、`[{start,end,text}]`、B 站字幕 JSON（`{body:[{from,to,content}]}`），自动识别。

**取流失败时先看这三条**：`yt-dlp not found` → 设 `DSH_YTDLP_PATH`；`Failed to decrypt with DPAPI`
→ 你用了 `--cookies-from-browser`（Chromium 127+ 的 v20 加密解不开），改成导出 cookies.txt；
`Source limit ...` → 这条视频本身最高就到那个档，换账号也没用。

### F. 命令行批处理（整片）

```bash
node bin/storyboard.mjs film.mp4 --batch 300 --out film.png
# → film-w01.png … film-w24.png + film-timeline.md
```

窗口边界会**吸附到真实剪辑点**（先全片扫一遍），不会切在一句话中间。

---

## 7. 台词层配置（可选）

没有 DSH 时用环境变量，桌面版建议写文件（宿主未必继承 env）：

```json
// C:\Users\<你>\.dsh\asr.json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "key": "local",
  "language": "zh",
  "terms": { "绘插": "彗差", "巴与怪": "八羽怪" }
}
```

优先级：**环境变量 > `$DSH_HOME/asr.json` > 内置默认**。

`terms` 是术语校正表（错误写法 → 正确写法），单遍替换、长词优先，替换次数会写进清单。

不配也能用：有内嵌字幕轨就用字幕轨，两者都没有就跳过台词层（分镜照出）。

---

## 8. 缓存与磁盘

- 位置：`%LOCALAPPDATA%\dsh-video-storyboard\cache`（Windows）/ `~/.cache/...`
- 键：`(路径, 大小, mtime, 窗口, 阈值)`，**不含文件内容**（2GB 读一遍比重新扫还慢）
- 上限 50MB，LRU 淘汰
- 换盘：`DSH_VIDEO_CACHE_DIR=D:/dsh-cache`
- 关掉：工具参数 `cache: false`

---

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `ffmpeg exited ...` | ffmpeg 不在 PATH | 设 `DSH_FFMPEG_PATH` |
| `transcript="asr-failed"` | 端点不通/401/服务没起 | 看清单里那行错误，它会带上 `ECONNREFUSED` / `401` |
| 台词全挤在一格 | 后端不返回 `segments` | 服务端要开 VAD 分段（见 docs/asr-contract.md） |
| 图糊成一团 | 格数太多 / 片子是 4K | 降 `cells`，或对某段用 `video_zoom` |
| 清单末尾说 `text stopped at cell N` | 超出单次结果预算 | 按提示用 `cellRange` 续读 |
| 时间码整体偏了几秒 | 后端单次请求过长 | 客户端已按 ≤45s 切片；若仍偏，检查服务端是否二次合并 |
| 条带灰块很少 | 阈值 −40dB / 0.6s（绝对判定） | 底噪高的素材会漏判，属已知限制 |

---

## 10. 成本估算

| 项 | 量 |
|---|---|
| 一张图（9–16 格） | **384 token** |
| 文本清单（9 格，med） | ~250 token |
| 文本清单（64 格，med） | ~3,800 token |
| 5 分钟片首次扫描 | 6–13 秒 |
| 同一文件第二次 | 3.6 秒（缓存） |
| `textOnly` 翻页 | 0.8 秒/页 |

**记住**：中文台词往往比图贵。`detail` 和 `cellRange` 是真正的省钱开关。

---

## 11. 不用 DSH 也能用

```bash
node bin/scan-video.mjs film.mp4 9        # 调阈值：切点/分数/段长/峰值
node bin/scan-stats.mjs film.mp4          # 分数分布（选阈值前先看这个）
node bin/asr-check.mjs film.mp4 --from 100 --seconds 12   # 单独验证 ASR 链路
```
