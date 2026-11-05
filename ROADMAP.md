# Roadmap

This file distinguishes what is **implemented**, what is **in progress**, and what is **planned** — so nobody mistakes planned features (TTS, Live2D) for finished ones.

## ✅ Implemented

**Personality**
- Structured personality source (`character.json`): core / voice / prose, no code changes needed
- Three-layer expression: content · emotion · tone (orthogonal, tone always-on)

**Emotion**
- 5-axis state: pleasure / arousal / frustration / curiosity / affinity
- Decay toward baseline, cross-axis coupling, object tags ("curious about X")
- Emotion randomness (perturbation + coupling)
- Independent emotion — she doesn't mirror the user

**Appraisal**
- Rule-based emotional appraisal (keywords → deltas)
- LLM mood judge (async calibration, labels, attribution)

**Memory**
- Short-term episodes (retrieval-scored)
- Long-term profile slots (structured facts)
- Self-model, stances, events, feelings (praise/criticism memory), interests

**Behavior**
- Intent planning: 9 modes + 6 moves + content weight
- Refuse + refuse-regret, dilemma tracking, pressure dynamics
- Roaming (web exploration), proactive speaking

**Feedback / Evaluation**
- Self-criticism + exemplar collection (good/bad reply memory)
- Evaluation suite: regression, semantic calibration, scenario tests, decision log

**Extras**
- A personal feed folder she can read, summarize (hierarchical + on-demand), and reference

## 🚧 In Development

- Text-to-Speech integration (local GPT-SoVITS as primary, edge-tts as fallback — bring your own model & voice)

## 📅 Planned

- Live2D / VRM avatar
- Voice input (ASR)
- Richer QQ features (images/emoji, group chat, multi-user)
- Personality evolution with a human gate (long-term)

## Non-goals

- Not a prompt-wrapper: personality continuity comes from state + memory, not a giant history
- No bundled TTS models / voice clones (licensing & voice-rights — users provide their own)
