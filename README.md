# 爱丽丝（Alice）

一个"安静克制、内心少女心"的 AI 伴侣，基于 DeepSeek Harness（DSH）的角色插件。

> 表层话不多、不过度热情、有分寸；内心好奇、被夸会嘴硬、偶尔漏一句软话。情绪不跟着你走，有她自己的立场。

## 作者

© 2026 jszagyn

如果你喜欢爱丽丝，欢迎在衍生作品或宣传中提及原作者。

## 特性

- **人格源文件驱动**：改 `character.json` 就能改人格，不碰代码；
- **四层架构**：内容层（说什么）+ 情绪层（带多少情绪）+ 语气层（怎么说）三层正交，语气是始终在线的底子；
- **五维情绪**：愉悦/激活 + 挫败/好奇/社交亲和，有衰减、有惯性；
- **记忆**：短期对话 + 长期槽位 + 情感记忆 + 自我模型 + 立场；
- **优化闭环**：回复自动打分、沉淀好/坏样例，越用越像她；
- **主动**：漫游（网上看新鲜事）、主动搭话；
- **投喂区**：把你写的稿子放进 `alice/` 文件夹，她能翻看、概括、引用。

## 快速开始（一键安装）

### 前提

1. 装好 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)（本项目的运行时）；
2. 一个 LLM 服务（DeepSeek API，或其他 OpenAI 兼容接口）。

### 安装（Windows）

```powershell
# 在仓库根目录运行
.\scripts\install.ps1
```

脚本会：检测 DSH → 复制插件 → 引导填 LLM key → （可选）配 QQ → 启动验证。

macOS / Linux 用 `scripts/install.sh`（待补）。

### 手动安装

把 `character/` 目录复制（或软链）到 DSH 的插件目录，然后在 `character/data/` 下放好 `character.json`（已含默认人格），并配置 LLM。

## 配置

把 `.env.example` 复制成 `.env` 并填：

```env
# LLM 服务（OpenAI 兼容）
LLM_PROVIDER=deepseek-official
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=你的key
LLM_MODEL=deepseek-chat

# QQ（可选，NapCat OneBot11）
QQ_ENABLED=false
QQ_HTTP=http://127.0.0.1:3000
```

## TTS（可选，需自备）

爱丽丝支持本地 GPT-SoVITS 语音（默认关闭）。引擎代码开源（MIT），但**预训练模型与参考音频需自备**——不随本仓库分发。

## 许可（双许可）

- **代码**：Apache License 2.0（见 [LICENSE](LICENSE)）；
- **人格设定 + 文档**：CC BY 4.0（见 [LICENSE-PERSONA](LICENSE-PERSONA)）——用这部分**必须署名原作者**。

## 致谢 / 参考

概念借鉴（无代码复制）：

- [dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）——拒绝与拒绝后悔；
- [dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul)（MIT）——情绪→说话行为映射、情感记忆；
- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) / [EchoBot](https://github.com/KdaiP/EchoBot)——全链路与模块化架构思路；
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT）——TTS 引擎（需自备）；

## 文档

- `docs/人格设计.md` —— 人格定性与语气；
- `docs/架构.md` —— 四层架构与模块说明；
- `docs/计划.md` —— 设计与迭代计划。
