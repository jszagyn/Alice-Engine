import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'
import { normalizeCertainty, PROFILE_SLOTS, upsertSlot } from './profile.js'
import { rememberEpisode } from './episodic.js'

// 计划 §12：回合后让模型总结记忆，替掉规则转录（classifyAll / utterance）。
// 规则版「高精度、低召回」——很多随口一提的事没记下；这里用一次 flash 调用，
// 把这一轮他说的整理成第三人称的短期条目 + 长期槽位。失败退回规则，不整段丢掉。

const MEMORY_LOG = join(DATA_DIR, 'memory-llm.jsonl')

const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 400,
  temperature: 0.3,
  timeoutMs: 15000,
}

const SLOT_KEYS = PROFILE_SLOTS.map((slot) => slot.key)

const SYSTEM = [
  '你是记忆整理器。把这一轮对话里值得记的事，转述成简短的记忆。',
  '',
  '只转述、不推断：',
  '- 不写「他答应每晚陪我」这类承诺升级；',
  '- 不写「他最近压力大」这类心理归因；',
  '- 只写 master 自己说了、或明确表达过的事实（原话里有依据的）。',
  '',
  '输出 JSON（不要代码块、不要解释）：',
  '{"episodes":[{"text":"关于 master 的第三人称一句话，≤40字","about":"relation","certainty":"fact|inference|assumption"}],"slots":[{"key":"槽位键","value":"槽位值","evidence":"他原话里的依据","certainty":"fact|inference|assumption"}],"self":[{"text":"她自己这句回复里值得记住的话（观点/承诺/关于她自己的陈述），≤40字","kind":"opinion|commitment|self","certainty":"fact|inference|assumption"}],"stance":[{"text":"她这句里明确划的线/站的位置（拒绝什么、坚持什么、反对什么），≤40字","kind":"boundary|value|oppose"}],"events":[{"text":"master 这轮提到的大事（换工作/结婚/搬家/毕业/项目完结等长期重要的事），一句话，≤50字"}],"nothing":false}',
  '',
  `槽位键只能从这些里选：${SLOT_KEYS.join(' / ')}`,
  '',
  'episodes 最多 2 条，slots 最多 2 条，self 最多 2 条，stance 最多 1 条，events 最多 1 条；没有可记的就输出 {"nothing":true}。certainty 取 fact（他明确说了/她直接观察到）/ inference（从多轮归纳出来的）/ assumption（她猜的、不确定），拿不准就标 inference 或 assumption，别硬标 fact。self 用她自己的口吻写（第一人称「我」），不要写「她说」；只挑她本人（不是 master）明确表达的观点、承诺或自我陈述。stance 只在她明确拒绝/坚持/反对了某件事时才写，别把普通观点当立场。events 只在 master 明确提到重要大事时才写（换工作/结婚/搬家/毕业/项目完结等），别把日常小事当大事。',
].join('\n')

function logMemoryLlm(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(MEMORY_LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 日志失败不影响记忆。
  }
}

/** 从可能被截断的 JSON 文本里抠一个字符串字段。 */
function grabString(text, key) {
  const start = text.indexOf(`"${key}"`)
  if (start < 0) return ''
  const colon = text.indexOf(':', start)
  if (colon < 0) return ''
  const open = text.indexOf('"', colon)
  if (open < 0) return ''
  let out = ''
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') {
      out += text[i + 1] ?? ''
      i += 1
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

/**
 * 落地校验（防编）：值里的数字/日期若原话里没有，整条丢弃。
 * 承诺升级、心理归因这类软性编造靠提示词 + 人工查看 memory-llm.jsonl 兜底。
 */
function cleanValue(value, userText) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const digits = text.match(/\d+/g) ?? []
  for (const digit of digits) {
    if (!String(userText ?? '').includes(digit)) return ''
  }
  return text.slice(0, 40)
}

function parseResult(raw, userText, replyText) {
  if (!raw) return null
  const cleaned = String(raw).replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) {
    // 输出被截断：能抠出 nothing 就认，抠不出就交给调用方回退规则。
    return null
  }
  let value
  try {
    value = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.nothing) return { episodes: [], slots: [], self: [], stance: [], events: [], nothing: true }

  const episodes = (Array.isArray(value.episodes) ? value.episodes : [])
    .map((entry) => ({ text: cleanValue(entry?.text, userText), about: String(entry?.about ?? 'other').slice(0, 20), certainty: normalizeCertainty(entry?.certainty, 'fact') }))
    .filter((entry) => entry.text.length >= 3)
    .slice(0, 2)
  const slots = (Array.isArray(value.slots) ? value.slots : [])
    .filter((entry) => SLOT_KEYS.includes(entry?.key))
    .map((entry) => ({ key: entry.key, value: cleanValue(entry?.value, userText), evidence: String(entry?.evidence ?? '').slice(0, 40), certainty: normalizeCertainty(entry?.certainty, 'fact') }))
    .filter((entry) => entry.value.length >= 1)
    .slice(0, 2)
  const self = (Array.isArray(value.self) ? value.self : [])
    .map((entry) => ({ text: cleanValue(entry?.text, replyText), kind: String(entry?.kind ?? 'self').slice(0, 20), certainty: normalizeCertainty(entry?.certainty, 'fact') }))
    .filter((entry) => entry.text.length >= 3)
    .slice(0, 2)
  const stance = (Array.isArray(value.stance) ? value.stance : [])
    .map((entry) => ({ text: cleanValue(entry?.text, replyText), kind: String(entry?.kind ?? 'stance').slice(0, 20) }))
    .filter((entry) => entry.text.length >= 3)
    .slice(0, 1)
  const events = (Array.isArray(value.events) ? value.events : [])
    .map((entry) => ({ text: cleanValue(entry?.text, userText) }))
    .filter((entry) => entry.text.length >= 3)
    .slice(0, 1)
  return { episodes, slots, self, stance, events, nothing: episodes.length === 0 && slots.length === 0 && self.length === 0 && stance.length === 0 && events.length === 0 }
}

/**
 * 回合后记忆整理：一次 flash 调用，返回结构化结果或 null。
 * 绝不抛错（调用失败返回 null，由引擎退回规则转录）。
 */
export async function summarizeMemory(llm, character, { user, reply, profile }) {
  const config = { ...DEFAULTS, ...(character.memory ?? {}) }
  const slotLines = Object.entries(profile?.slots ?? {})
    .slice(0, 12)
    .map(([key, slot]) => `${key}: ${slot.value}`)
    .join('；')
  const started = Date.now()
  let raw = ''
  let error = null
  try {
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `他说的：「${String(user ?? '').slice(0, 200)}」\n她回的：「${String(reply ?? '').slice(0, 200)}」\n现在已有的槽位：${slotLines || '（空）'}`,
            },
          ],
        },
      ],
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  const result = parseResult(raw, user, reply)
  logMemoryLlm({
    at: new Date().toISOString(),
    ms: Date.now() - started,
    ok: Boolean(result),
    error,
    nothing: result?.nothing ?? null,
    episodes: result?.episodes?.length ?? 0,
    slots: result?.slots?.length ?? 0,
    self: result?.self?.length ?? 0,
    stance: result?.stance?.length ?? 0,
    events: result?.events?.length ?? 0,
    raw: String(raw).slice(0, 400),
  })
  return result
}

/**
 * 把结构化结果写进 episodic + profile。返回是否真的写了东西。
 * episode 标 summarized=true（第三人称，渲染时不套「他说：」引号）。
 */
export function applyMemoryResult(profile, episodic, result, user, now = Date.now()) {
  if (!result) return false
  let changed = false
  for (const episode of result.episodes ?? []) {
    const entry = rememberEpisode(episodic, episode.text, { kind: 'chat', saidBy: 'master', certainty: episode.certainty, now })
    if (entry) {
      entry.summarized = true
      entry.about = episode.about
      changed = true
    }
  }
  for (const slot of result.slots ?? []) {
    if (upsertSlot(profile, { key: slot.key, value: slot.value, source: 'self', certainty: slot.certainty, evidence: slot.evidence || String(user ?? '').slice(0, 40), now })) {
      changed = true
    }
  }
  return changed
}
