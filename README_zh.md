# Alice Engine

**造一个"像人"的 AI，而不是又一个聊天机器人。**

> 本文是中文版。English version: [README.md](./README.md)。完整设计思路见 [docs/DESIGN_zh.md](docs/DESIGN_zh.md)。

Alice Engine 是一个轻量、开源、人格驱动的 AI 生命框架。它不靠一长串提示词加聊天记录，而是把人格、情绪、记忆、行为、表达拆成**彼此独立又互相牵动的系统**，让 AI 长期保持同一个"自我"。

> 仓库自带示例角色 Alice：外表安静克制，内里好奇，带一点少女心。她的情绪是她自己的，不会照着你的情绪做镜子。

## ✨ 为什么不是又一个人设提示词

大多数"AI 角色"就是一大段人设提示词。Alice Engine 把关注点拆开，让人格不会随着上下文变长而垮掉：

| 系统 | 做什么 |
|---|---|
| **人格** | 稳定的人格与嗓音，存在结构化的 `character.json` 里，改它不用碰代码 |
| **情绪** | 活的五维状态（愉悦/激活/挫败/好奇/社交亲和），会衰减、耦合、带指向 |
| **评价** | 规则 + LLM 判断每一轮"意味着什么"，推动情绪变化 |
| **记忆** | 多层：短期事件、长期槽位、自我模型、立场、大事、情感记忆、兴趣 |
| **行为** | 先决定意图（回答/追问/探索/拒绝/换话题），再让模型写 |
| **表达** | 三层正交：内容（说多少）· 情绪（带多少）· 语气（怎么说话） |
| **自改进** | 回复自动打分，沉淀成样例，塑造之后的回复 |

## 🧠 架构

```
┌─ 表达：内容 · 情绪 · 语气（三层正交）
├─ 行为：意图 → 模式/姿态/计划
├─ 记忆：事件 · 槽位 · 自我 · 立场 · 大事 · 情感
├─ 情绪：五维，衰减/耦合/对象标签
└─ 评价：规则 + LLM → 情绪增量
```

设计目标是**人格连续性不依赖超长上下文**——承载"自我"的是状态和记忆，不是提示词。

## 🚀 快速开始

**前提**：[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) + 一个 LLM 服务（DeepSeek API 或任意 OpenAI 兼容接口）。

```powershell
# Windows
.\scripts\install.ps1
```
```bash
# macOS / Linux
./scripts/install.sh
```

脚本会把插件链进 DSH profile。然后在 DSH 里配好 LLM → 加载 **Alice** 伴生 preset → 开始聊天。

**配置**：LLM 的 provider + API key 在 DSH 设置里配；模型参数（`provider`/`model`/`temperature`）在 `character/data/character.json`。

## 📁 目录

- `character/` — 插件本体（人格、引擎、记忆、行为、工具）
- `docs/` — [设计思路](docs/DESIGN_zh.md)、[架构](docs/架构.md)、[计划](docs/计划.md)
- `scripts/` — 一键安装脚本
- `samples/` — 示例 TTS 音色（CC0）

## 🔊 语音（可选）

Alice 支持本地 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 语音，**可选**：

- 默认关闭（`character.json` → `tts.enabled: false`），不接也完全正常（回退到浏览器朗读）；
- 启用：跑一个 GPT-SoVITS `api_v2` 服务 → 设 `tts.enabled: true` + 填 `tts.refAudio`/`tts.promptText` → 重启 DSH。

**示例音色（CC0）**：`samples/example-voice.mp3` 用 [Piper](https://github.com/rhasspy/piper) 的 `zh_CN-chaowen-medium` 生成，**CC0 公共领域**，可随便用；或自备参考音频（3–10 秒）+ 对应文字。

## 🚧 计划

详见 [docs/计划.md](docs/计划.md)，摘要：

- ✅ 人格 / 情绪 / 评价 / 多层记忆 / 行为 / 表达
- ✅ 自改进闭环、漫游、主动搭话、投喂区
- ✅ 语音（可选 GPT-SoVITS，音色自备）
- 🚧 Live2D / VRM 形象
- 🚧 更多通道（语音输入、QQ 扩展）

## 🤝 参与

欢迎来聊、提想法、做实验——AI 架构、情绪建模、记忆设计、TTS、形象、评测都行。

## 📜 许可

双许可：

- **代码**（`lib/`、`tools.js`、`scripts/` 等）：[Apache License 2.0](LICENSE)
- **人格与文档**（`character.json`、`docs/`）：[CC BY 4.0](LICENSE-PERSONA) —— 需署名

## 🙏 致谢

概念借鉴（无代码复制）：[dsh-fish](https://github.com/ssamurias/dsh-fish)、[dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul)、[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)、[EchoBot](https://github.com/KdaiP/EchoBot)、[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)。

---

**Alice Engine — 造有连续性的 AI 生命。**
