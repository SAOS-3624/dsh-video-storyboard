# CREDITS.md（零代码复制版）

> 学术引用与"我们站在谁的肩膀上"的完整列表见 [docs/REFERENCES.md](docs/REFERENCES.md)。本文件只负责合规声明。

本仓库**不包含任何来自第三方的源代码**。下列项目仅作为设计参考或在运行时被调用，其代码未以任何形式复制、修改或再分发到本仓库。

> 如果你的实现里不小心粘贴了上游代码，请改用下面第 5 节的模板补声明；在此之前，本文件就是完整的合规文件。

---

## 1. 设计灵感（仅参考接口形状与策略，未复制代码）

| 项目 | 许可 | 我们参考了什么 |
|---|---|---|
| [dsh-video-see](https://github.com/HongtaoWang75/dsh-video-see) | MIT | 工具注册与宿主契约的形状；"先检查模型模态再解码"的顺序；旋转/竖屏/末尾边界的处理**问题清单**（实现为独立编写）。它反过来主张"别为了省帧数牺牲清晰度"，README 的对比段直接引用了它自己算的 20 帧 ≈ 7,680 token |
| [dsh-video-lens](https://github.com/dundunhan/dsh-video-lens) | MIT | "ASR 失败不阻塞主流程"的降级策略；`video_ask` 的**时间锚定问答**思路（我们落成了纯文本的 `video_locate`，不调外部 VLM） |
| [watch-skill / DeepWatch](https://github.com/oxbshw/watch-skill) | MIT | "**索引一次、追问免费**"的产品形态；"答案要能被另一个东西复核"这条（我们落成了 `.evidence.json` 的雏形） |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3-Clause | ContentDetector 的**加权打分思想**（HSV 三通道差异），`scan.js` 为独立实现，未参考其代码 |
| [TransNet V2](https://github.com/soCzech/TransNetV2) | MIT | 可选后端的选型依据；本仓库不分发其代码与权重 |

> 以上四家的想法我们都只**取判断、不取代码**（MIT 允许复制，但这个项目不这么做）。README 里有和它们的逐项对比，包括我们明确输在哪。

感谢以上作者。以上致谢不构成任何形式的背书，也未暗示原作者对本项目的认可。

---

## 2. 运行时外部依赖（**不随本仓库分发**）

| 组件 | 许可 | 分发方式 |
|---|---|---|
| FFmpeg / ffprobe | LGPL-2.1-or-later（用户自选构建，可能是 GPL） | 由用户自行安装，本仓库通过 `PATH` 以独立进程调用（argv，不经 shell），**不打包、不链接** |
| yt-dlp（可选适配器） | Unlicense | 由用户自行安装；本仓库不内置下载能力 |
| faster-whisper / whisper.cpp（可选） | MIT | 由用户自行安装 |

---

## 3. 模型权重（**不随本仓库分发**）

| 模型 | 许可 | 说明 |
|---|---|---|
| SenseVoiceSmall | **FunASR Model Open Source License Agreement v1.1**（© 2023-2028 Alibaba Group） | 由用户在运行时从 ModelScope `iic/SenseVoiceSmall` 或 HuggingFace `FunAudioLLM/SenseVoiceSmall` 获取。按协议 §2.2，使用者须**注明出处与作者并保留模型名称**——本项目的做法见下。 |

**本项目履行 §2.2 的方式**（README 与 manifest 两处）：

- README 致谢段：
  > Speech recognition powered by **SenseVoiceSmall**, developed by the **FunAudioLLM team at Alibaba**, used under the FunASR Model License v1.1. This project does not redistribute the model weights.
- `manifest.audio.model` 字段保留原始模型名，不改写、不缩写。

另注：该协议 §4.2 禁止对上游进行无端诋毁或恶意抹黑，违反将自动终止全部授权。因此本项目的对比文档只描述**取舍与适用场景**，不作贬损性评价。

---

## 4. 社区报告与修复（按时间）

| 贡献者 | 内容 | 落地 |
|---|---|---|
| [@dugu951](https://github.com/dugu951) | 指出"没配 ASR 后端时长视频仍自称 `transcript=\"asr\"`"，并给出修复 | PR #3，合并于 `22546db`；合并后补了单窗口分支与"没跑"vs"跑了没结果"的区分 |
| [@ggfgfgf-on](https://github.com/ggfgfgf-on) | [issue #1](https://github.com/SAOS-3624/dsh-video-storyboard/issues/1) 的 10 条诊断（色相非环形、低饱和假切点、<0.4s 崩溃、`index+time` 未实现、VFR/SAR 等）；[PR #7](https://github.com/SAOS-3624/dsh-video-storyboard/pull/7) 的 ffmpeg/ffprobe 宿主目录发现、manifest provenance（`cell`/`tokens`/`ffmpeg`/可选 `sha256`）、以及 `transcriptFile` + `from/to` 时 chars 窗口口径的修复；[PR #8](https://github.com/SAOS-3624/dsh-video-storyboard/pull/8) 的 DASH 文件名收敛与 `suspectInjection` 扫描 | issue #1 中 4 条以重写形式落地（`819b8d2`、`04d318a`、`018b7ea`、`38df7a0`）；PR #7 **完整合入**（`0a0e96f`），代码由他编写；PR #8 **完整合入**（0.3.2），并补了"只有音频轨"的拒绝与标题扫描 |
| [@canyueY](https://github.com/canyueY) | 结构调整方向（analyze/plan/render 拆分）、可选富化侧车（说话人分离、远程镜头检测）、`video_zoom.mode`、抽样扫描（`scan-sampled`）与感知哈希（`fingerprints`）的提出 | 已吸收 `fast cuts`（爆点与镜头数）与 `seen before`（`src/memory.js`）。[PR #6](https://github.com/SAOS-3624/dsh-video-storyboard/pull/6) 未整体合入——实测拆分为三个模块会让清单 +49%、热路径慢 2.3×，收益是结构好看，对"模型能不能看懂"没有帮助。其中的 `extras/dsh-video-enrichment/` 是独立 Python 侧车，不污染主包，欢迎单独提 PR |
| [@xingyueDanYang](https://github.com/xingyueDanYang) | [issue #4](https://github.com/SAOS-3624/dsh-video-storyboard/issues/4) 的 5 条接入建议（转写层接受已有 JSON/SRT、ffmpeg 宿主发现、阈值可配置化、成本口径显式、cell 引用契约）；同 thread 后续的**提示词注入**预警（外部文本伪装成命令，附四步处置法）与 **C站 URL 直读失败**的完整复现（`unexpected container: video.f100022.mp4`） | 第 1 条 `transcriptFile` 已在 0.3.0 独立实现；第 2 条与第 3 条的"记录本次生效阈值"已在 0.3.1 通过 PR #7 落地；第 4 条的 `cell="WxH"` + `tokens="… (DSH estimate)"` 已落地；第 5 条的 `ffmpeg` 版本与可选 `sha256` 已落地，`cellId` 暂不做；注入预警落成 `manifest.transcript.suspectInjection`（0.3.2），C站 那条由 PR #8 修复并有真实链接回归验证 |

> 这份表只记"提出并推动了什么"，不区分代码是否被逐行采用——诊断、复现和反例同样计入。

## 4.5 测试素材的作者

跨类型调参用了十支公开视频，全部是 C站创作者的公开作品。**只用来看、没有分发**，但素材就是他们的劳动成果，
该写名字：

| 用途 | 创作者 | 视频 |
|---|---|---|
| PPT 录屏 | 诺贝尔可爱讲 | [BV1y7411p7Ho](https://www.bilibili.com/video/BV1y7411p7Ho) |
| 监控合集 | 人类爆笑行为图鉴 | [BV1zAx36cEdU](https://www.bilibili.com/video/BV1zAx36cEdU) |
| 二维动画 | 大锐吉吉吉 | [BV1W5no6QEe2](https://www.bilibili.com/video/BV1W5no6QEe2) |
| 三维动画 | 搬运的贝塔（Blender《春》） | [BV1Yb411g7VV](https://www.bilibili.com/video/BV1Yb411g7VV) |
| 演播室口播 | 视听科技新视角 | [BV1R44y1G7eZ](https://www.bilibili.com/video/BV1R44y1G7eZ) |
| 手持 vlog | 风光喵 | [BV11L4y1a7QB](https://www.bilibili.com/video/BV11L4y1a7QB) |
| 竖屏短视频 | ding-hiro | [BV1BjxM69EHh](https://www.bilibili.com/video/BV1BjxM69EHh) |
| 游戏录屏 | 你搜搜导航Dios | [BV1SmqpBuEzG](https://www.bilibili.com/video/BV1SmqpBuEzG) |
| 动画混剪 | 崩铁代肝原神代肝糖糖 | [BV1nV411a7jr](https://www.bilibili.com/video/BV1nV411a7jr) |
| 41 分钟纪录片 | 不会飞章鱼 | [BV1yJ411m7GP](https://www.bilibili.com/video/BV1yJ411m7GP) |

> 这些名字不是背书，只是"我们拿谁的作品验证过自己"。如果某位作者不希望被列在这里，说一声就删。

## 4.6 使用者

这个项目的大部分改动不是想出来的，是**被用出来**的：

- 提 issue 说"这里不对"的人 —— 你们比任何基准测试都有用。
- 拿自己的片子试、然后说"这段还是糊"的人 —— 那通常意味着一整类内容没被覆盖。
- 把插件装到奇奇怪怪的环境里（无 ffmpeg、只有音频流、竖屏、超长片）然后报错的人 —— 这些边界我们自己也想不到。

**特别感谢每一位愿意把"不行"说出来的人。** 一个只说"挺好"的反馈，什么都改不动。

## 5. 如果将来真的要复制代码

复制 MIT / BSD 代码是完全合法的，但要**随分发附带原版权声明与许可全文**。做法：

1. 在被复制的文件头保留原始版权行；
2. 在本文件新增一节，格式如下；
3. 把该组件的 LICENSE 全文贴在该节末尾（MIT 要求"shall be included in all copies"）。

```md
## N. <项目名>

- 来源：<仓库 URL>
- 许可：MIT License
- 版权：Copyright (c) <年份> <作者>            ← 必须与上游 LICENSE 逐字一致
- 使用方式：<哪些文件、复制了什么、改了什么>
- 许可全文：<粘贴原文>
```

---

> 本文件不是法律意见；它只是把"该做的事"写成了清单。
