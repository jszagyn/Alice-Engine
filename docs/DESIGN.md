# Alice Engine · Design Philosophy

> This document explains *why* it's designed this way. For how to run it, see [README](../README.md). For full progress, see [计划](./计划.md). 中文版见 [DESIGN_zh.md](./DESIGN_zh.md)。

## In one line

Most AI characters are one long persona prompt plus a long chat history. By turn thirty, the persona has been diluted by context, and she is no longer herself.

Alice Engine asks a different question: **what if "feeling like a person" is an engineering problem, not a writing problem?**

So instead of writing a prettier personality, we split a *being* into systems that each run on their own yet pull on one another: appraisal, emotion, memory, behavior, expression, plus a set of instruments that measure whether she has drifted.

> The bundled reference character, Alice, is quiet and restrained on the outside, curious and a little girlish within. Her feelings are her own. She does not mirror yours.

## The core idea: the self lives in state, not in the prompt

Prompts get pushed out of the context window. State does not. Alice's continuity comes from an emotional state that decays and couples, and from layered memory, not from an ever-growing context. Swap the underlying model and her personality constants (one JSON file) are still there. Talk for hours and her current mood is still there.

## Expression in three orthogonal layers

This is the design we like best. Many projects blur "how much to say", "how much feeling to show", and "how to sound" into one knob, so the moment mood drops, the character turns into an information-spitting machine. We split them:

- **Content layer** — how much to say: expert, discuss, simple, minimal; it also picks the move: answer, ask, digress, or look something up first.
- **Emotion layer** — how much feeling, and only the intensity.
- **Voice layer** — how she sounds, always on: short sentences, colloquial, no trailing period; particles follow context naturally — no fixed list, never forced.

In one sentence: **emotion is a knob, voice is a timbre.** The knob can go all the way down and the timbre is still hers. Low emotion is therefore not robotic — she still sounds like she's talking to you, just with less color.

Emotion intensity is computed like this: first read the user's current emotion, then read how interested she is in the topic; the two combine into an "emotion base".

| User emotion | Her interest | Emotion base |
|---|---|---|
| high | interested | max |
| high | not interested | upper-mid |
| low | interested | upper-mid |
| low | not interested | low |

That base then intersects with "how much emotion does this topic call for": a function lookup needs no enthusiasm; a subjective chat must not be cold. Finally, a small touch: only when the topic's demand exceeds her current base do we roll dice to drop the emotion by 0–2 levels — like a person who wants to be warm, sometimes reaching it, sometimes falling short.

## She has emotions, and they're not fully predictable

Emotion is not a "happy/sad" label but five axes: pleasure, arousal, frustration, curiosity, social affinity. They:

- decay toward their own baselines over time;
- are pushed by each turn's appraisal events, with a bit of random perturbation — the same sentence won't get exactly the same reaction twice;
- couple with each other: high frustration amplifies negative events; high curiosity makes novelty land harder; low affinity makes being ignored hurt more;
- carry an object: not just "a bit annoyed" but "curious about this", "a little defiant toward him".

## She doesn't just comply

The most common failure of companion AIs is agreeing to everything. Alice has a behavior layer:

- **Pressure dynamics**: strong commands accumulate more pressure than soft requests; pressure decays over time. When pressure is high, she tends to push back, digress, or refuse.
- **Move orthogonal to content**: besides *what* to say, each turn has *what stance to take* — answer, ask, digress, refuse, look up first, say less.
- **Refusal leaves a trace**: after pushing back, she watches the other's reaction. Accepted? She breathes easy. Pressured further? She wonders "was I too harsh?" That lingering feeling carries into the next turn, then fades.
- **A stance list**: core personality is locked, never rewritten by chat; the lines she has drawn and positions she has taken settle into a human-editable stance list, keeping her consistent.

## Memory: knowing what she knows

Memory is not a vector store but several kinds of distinct things:

- short-term episodes (within days), long-term slots (work, health, family, people around…), and expired summaries;
- her own opinions and promises (a self-model) — what she said counts;
- the big events of the other's life;
- "feeling memories" left by being praised or denied — one sentence, shaping future tone.

Every memory is tagged with confidence: **fact, inference, hypothesis** — three levels, and same-source never upgrades. Only what the other person actually said can become fact; her guesses never quietly rise. Retrieval scores four factors (relevance 0.5 / recency 0.2 / importance 0.15 / confidence 0.15), and forgetting is part of the design.

## She does things on her own

She doesn't just wait for you to speak. She has scheduled "roaming": search, read, bring back findings — and **reading and speaking are separated**: a librarian reads first and writes a report, then she retells it in her own words, so she never recites material like a news anchor. She decides what to explore by an interest profile (with an exploration slot reserved, not just chasing old interests), rolls dice to decide whether to speak up, switches between bedtime greetings, sharing findings, and curious questions, and writes a one-line diary each night.

She can also browse manuscripts the user feeds her, compressing the directory into a "what I've read" summary memory. Reading files is deliberately restricted to **read-only**.

## Voice: optional, and it never takes over

Voice is an **optional peripheral**, off by default — skipping it changes nothing. With a local GPT-SoVITS server attached, she speaks in her own timbre; the emotion level drives speech rate, and failed synthesis falls back to browser reading. The reference voice is user-provided — the repo ships only a **CC0 public-domain** example (Piper `zh_CN-chaowen-medium`), free of any copyright baggage.

## How we know it actually works

"Feeling like a person" sounds subjective, so we built instruments:

- **Regression set**: 30 real conversations plus 13 adversarial samples, checked in three layers — assertions, invariants, drift.
- **Semantic judge**: calibrated by pairwise comparison, not by a model scoring on vibes.
- **Four scenario suites**: consistency, situation, memory continuity, evolution — all deterministic, no LLM calls.
- **Counterfactual check**: the same input answered by Alice and by a "generic assistant"; a judge measures distinguishability. Too similar means the persona has been diluted.
- **Decision log**: every turn's content level, move, emotion level, and judge verdict are recorded, so problems can be traced later.

## The detours we took

We think honesty is more useful than polish, so we write these down too:

- We once added a rule that "too flat a tone = fail", which in practice hurt a crisp speaking style and violated "particles are never mandatory". We removed it. Tone follows context, emotion follows level; no rule-based patches.
- Early on we conflated "low emotion" with "flat tone" and only later separated them: they are two independent dimensions. The three-layer split is the result of that correction.
- Summarizing manuscripts must not be "transcribe only, never infer" like chat memory; it must synthesize — but every point must be traceable to the source, no fabrication.
- Using a Japanese reference voice for cross-lingual synthesis makes the intonation "off"; it only sounds natural after using a Chinese voice-converted sample as a same-language reference — the reference language must match the target.

## Status and honesty

The core (personality, appraisal, emotion, memory, behavior, expression, self-improvement, roaming & proactivity, evaluation, optional TTS) has landed. Appraisal is still mostly rule/keyword-based, augmented by an LLM; single-user for now (state keys are multi-user ready); runs as a DeepSeek Harness plugin.

## How you can help

The core is stable, so the big extensions are independent — no need to understand the whole emotion and memory system to claim one:

- **Avatar**: Live2D / VRM
- **Channels**: QQ images/emoji, voice input (ASR), group chat, multi-user
- **Standalone entrypoint**: make the project run without DSH — that lets many more people run it
- **Evaluation**: an English example character and English eval set, using the semantic judge for prompt A/B
- **A human review gate for personality evolution**: keep "growth" controllable

If "AI self-continuity", emotion modeling, memory design, or evaluation methods interest you — issues, ideas, experiments all welcome.
