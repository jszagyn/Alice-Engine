# Alice Engine

**Build an AI Being, Not Just a Chatbot.**

Alice Engine is an open-source, lightweight framework for building personality-driven AI beings. Instead of a wall of prompt text plus a long conversation history, it splits personality, emotion, memory, behavior, and expression into **independent, interconnected systems** — so an AI keeps a consistent self over time.

> A companion named Alice ships as the reference implementation: outwardly quiet and restrained, inwardly curious with a girlish heart — her emotions are her own, and she doesn't mirror yours.

## ✨ Why not just a character prompt?

Most "AI characters" are one long system prompt. Alice Engine separates the concerns so personality doesn't collapse as the context grows:

| System | What it does |
|---|---|
| **Personality** | Stable traits and voice, stored as a structured source file (`character.json`) — change it without touching code |
| **Emotion** | A live 5-axis state (pleasure / arousal / frustration / curiosity / affinity) that decays, couples, and points at things |
| **Appraisal** | Rule + LLM evaluation of what each turn *meant*, driving emotion deltas |
| **Memory** | Multi-layered: short-term episodes, long-term slots, self-model, stances, events, feelings, interests |
| **Behavior** | Decides *intent* — answer / ask / explore / refuse / change topic — before the model writes |
| **Expression** | Three orthogonal layers: **content** (how much to say) · **emotion** (how much feeling) · **tone** (always-on voice) |
| **Self-improvement** | Replies are self-scored and distilled into examples that shape future replies |

## 🧠 Architecture

```
┌─ Expression: content · emotion · tone (three orthogonal layers)
├─ Behavior: intent → mode / move / plan
├─ Memory: episodic · slots · self · stance · events · feelings
├─ Emotion: 5-axis state with decay, coupling, object tags
└─ Appraisal: rules + LLM → emotional deltas
```

The design goal is **personality continuity that doesn't depend on a giant conversation history** — state and memory carry the self, not the prompt.

## 🚀 Quick Start

**Prerequisite:** [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) + an LLM service (DeepSeek API or any OpenAI-compatible endpoint).

```powershell
# Windows
.\scripts\install.ps1
```
```bash
# macOS / Linux
./scripts/install.sh
```

The script links the plugin into your DSH profile. Then: configure your LLM inside DSH → load the **Alice** companion preset → start talking.

**Configuration:** LLM provider + API key live in DSH's settings. Model parameters (`provider`, `model`, `temperature`) live in `character/data/character.json`.

## 📁 Repository

- `character/` — the plugin (personality, engine, memory, behavior, tools)
- `docs/` — personality design, architecture, roadmap
- `scripts/` — one-click installers
- `samples/` — example TTS voice (CC0)

## 🔊 TTS (optional)

Alice supports local TTS via [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — **optional**:

- Disabled by default (`character.json` → `tts.enabled: false`); the plugin works normally without it (falls back to browser text-to-speech).
- To enable: run a GPT-SoVITS `api_v2` server → set `tts.enabled: true` + fill `tts.refAudio` + `tts.promptText` → restart DSH.

**Example voice (CC0):** `samples/example-voice.mp3` is a demo generated with [Piper](https://github.com/rhasspy/piper) using the `zh_CN-chaowen-medium` voice, licensed **CC0** (public domain). Use it freely, or bring your own reference audio (3–10s) + matching text.

## 🚧 Roadmap

See [docs/计划.md](docs/计划.md) for the detailed plan. Summary:

- ✅ Personality / emotion / appraisal / multi-layer memory / behavior / expression
- ✅ Self-improvement loop, roaming, proactive speaking, a personal feed folder she can read and summarize
- ✅ Text-to-Speech (optional GPT-SoVITS, bring your own model & voice)
- 🚧 Live2D / VRM avatar
- 🚧 More channels (voice input, richer QQ features)

## 🤝 Contributing

Ideas, experiments, and feedback are welcome — AI architecture, emotional modeling, memory, TTS, avatars, or evaluation.

## 📜 License

Dual-licensed:

- **Code** (`lib/`, `tools.js`, `scripts/`, etc.): [Apache License 2.0](LICENSE)
- **Personality & docs** (`character.json`, `docs/`): [CC BY 4.0](LICENSE-PERSONA) — **attribution required**

## 🙏 Acknowledgements

Conceptual inspiration (no code copied): [dsh-fish](https://github.com/ssamurias/dsh-fish), [dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul), [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber), [EchoBot](https://github.com/KdaiP/EchoBot), [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS).

---

**Alice Engine — Building AI beings with continuity.**
