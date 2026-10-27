# CREDITS.md（零代码复制版）

> 学术引用与"我们站在谁的肩膀上"的完整列表见 [docs/REFERENCES.md](docs/REFERENCES.md)。本文件只负责合规声明。

本仓库**不包含任何来自第三方的源代码**。下列项目仅作为设计参考或在运行时被调用，其代码未以任何形式复制、修改或再分发到本仓库。

> 如果你的实现里不小心粘贴了上游代码，请改用下面第 5 节的模板补声明；在此之前，本文件就是完整的合规文件。

---

## 1. 设计灵感（仅参考接口形状与策略，未复制代码）

| 项目 | 许可 | 我们参考了什么 |
|---|---|---|
| [dsh-video-see](https://github.com/HongtaoWang75/dsh-video-see) | MIT | 工具注册与宿主契约的形状；"先检查模型模态再解码"的顺序；旋转/竖屏/末尾边界的处理**问题清单**（实现为独立编写） |
| [dsh-video-lens](https://github.com/dundunhan/dsh-video-lens) | MIT | "ASR 失败不阻塞主流程"的降级策略；按时间窗重采样的问答思路 |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3-Clause | ContentDetector 的**加权打分思想**（HSV 三通道差异），`scan.js` 为独立实现，未参考其代码 |
| [TransNet V2](https://github.com/soCzech/TransNetV2) | MIT | 可选后端的选型依据；本仓库不分发其代码与权重；由 `extras/dsh-video-enrichment` 在用户本机按需加载 |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | MIT | 可选说话人分离后端；需用户自备 `HF_TOKEN` 与模型许可 |

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

## 4. 如果将来真的要复制代码

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
