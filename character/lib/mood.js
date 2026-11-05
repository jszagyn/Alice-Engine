import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const MOOD_FILE = join(DATA_DIR, 'mood.json')
const MOOD_LOG = join(DATA_DIR, 'mood.jsonl')

export const MOOD_SENTINEL = '[心情刚变]'

const AXES = ['valence', 'arousal', 'energy', 'trust']
const AXIS_LIMIT = 0.25
const ANNOUNCE_THRESHOLD = 0.18
const ANNOUNCE_CONFIDENCE = 0.6
const LOW_CONFIDENCE = 0.5
const REPEAT_QUIET_MS = 6 * 3_600_000
// 小于这个幅度就算「没怎么动」，不写状态、不写日志、更不会让她开口说。
const MIN_APPLY = 0.03

// 固定标签：只有这几个，才有得统计、才谈得上「同一件事只说一次」。
export const MOOD_LABELS = ['高兴', '有点低落', '被夸得受用', '被逗乐', '被惹到', '好奇', '无聊', '不安', '安心', '累了', '兴奋', '没什么变化']

const LABEL_HINTS = [
  [/没什么|没动|无变化/, '没什么变化'],
  [/夸|受用|被认可|被看重/, '被夸得受用'],
  [/逗|好笑|玩笑|乐|笑场/, '被逗乐'],
  [/惹|生气|恼|不爽|顶撞/, '被惹到'],
  [/好奇|想知道|感兴趣|勾起/, '好奇'],
  [/无聊|没劲|提不起/, '无聊'],
  [/不安|担心|忐忑|慌/, '不安'],
  [/安心|踏实|放心|被当自己人/, '安心'],
  [/累|困|疲|没力气|熬/, '累了'],
  [/兴奋|上头|来劲|跃跃欲试/, '兴奋'],
  [/低落|难过|失落|闷|遗憾|意犹未尽/, '有点低落'],
  [/高兴|开心|愉快|美滋滋|受鼓舞/, '高兴'],
]

// 正向、负向标签：判断器的数值跟标签方向相反时，宁可这次不采纳。
const POSITIVE = new Set(['高兴', '被夸得受用', '被逗乐', '好奇', '安心', '兴奋'])
const NEGATIVE = new Set(['有点低落', '被惹到', '不安', '累了'])

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value) => Math.round(value * 1000) / 1000

export function loadMood() {
  let stored = null
  try {
    if (existsSync(MOOD_FILE)) stored = JSON.parse(readFileSync(MOOD_FILE, 'utf8'))
  } catch {
    stored = null
  }
  const fresh = { lastLabel: '', lastAnnouncedAt: '', announce: null, history: [], updatedAt: '' }
  if (!stored || typeof stored !== 'object') return fresh
  return {
    ...fresh,
    ...stored,
    history: Array.isArray(stored.history) ? stored.history.slice(-80) : [],
    announce: stored.announce && typeof stored.announce === 'object' ? stored.announce : null,
  }
}

export function saveMood(mood) {
  mkdirSync(DATA_DIR, { recursive: true })
  mood.updatedAt = new Date().toISOString()
  writeFileSync(MOOD_FILE, `${JSON.stringify(mood, null, 2)}\n`, 'utf8')
}

/** 只留她真会用的四种情绪信号，判断器写歪了也不能把状态顶飞。 */
export function normalizeMood(raw) {
  if (!raw || typeof raw !== 'object') return null
  const deltas = {}
  for (const axis of AXES) {
    const value = Number(raw[axis])
    deltas[axis] = Number.isFinite(value) ? round(clamp(value, -AXIS_LIMIT, AXIS_LIMIT)) : 0
  }
  const rawLabel = String(raw.label ?? '').trim()
  const label = MOOD_LABELS.includes(rawLabel) ? rawLabel : LABEL_HINTS.find(([pattern]) => pattern.test(rawLabel))?.[1] ?? ''
  const why = String(raw.why ?? '').trim().slice(0, 60)
  const confidence = clamp(Number(raw.confidence) || 0, 0, 1)
  const object = String(raw.object ?? '').trim().slice(0, 20)
  const magnitude = Math.abs(deltas.valence) + Math.abs(deltas.arousal) * 0.5 + Math.abs(deltas.energy) * 0.5 + Math.abs(deltas.trust) * 0.3
  const nothing = raw.nothing === true || label === '没什么变化' || magnitude < MIN_APPLY
  if (!label && !nothing) return null
  // 标签和数值打架：这次宁可不用，交给规则版兜底。
  if (POSITIVE.has(label) && deltas.valence < -0.02) return null
  if (NEGATIVE.has(label) && deltas.valence > 0.02) return null
  return { deltas, label: nothing ? '没什么变化' : label, why, confidence, object, nothing }
}

function buildSystem(character) {
  return [
    character.layers?.core ?? '',
    '---',
    '你在当「爱丽丝」的状态评估器：看这一轮发生了什么事，判断她的情绪往哪动。只看事，不评价她说得好不好。',
    '',
    '怎么算幅度（大多数轮次应该是 0，没动就写 nothing）：',
    '- 小 0.05：一句话带过的小高兴、小别扭；',
    '- 中 0.1：明显被戳到（被认真夸、被冷落、聊到心头事）；',
    '- 大 0.2：很少见，真的被狠狠说到了才用。单轴最多 0.25。',
    '',
    '情绪归属（这条最容易判错）：',
    '- 只有冲她来的话，才动她的 valence。夸奖、逗她、嫌她、敷衍她——算；',
    '- master 讲他自己的事（工作、身体、朋友、烦心事），只动 arousal（听进去了）和 trust（被当树洞），不动 valence；',
    '- 她自己的事（漫游看到什么、自己先开口）才由她自己的经历决定 valence。',
    '',
    'label 必须从这张表里选，原样写，不许自创：',
    '- 高兴 / 兴奋：好事、跃跃欲试；',
    '- 被夸得受用 / 被逗乐：被夸、被逗、被戳中笑点；',
    '- 好奇 / 安心：想知道更多、被当自己人；',
    '- 有点低落 / 被惹到 / 不安 / 累了；',
    '- 无聊：提不起劲；',
    '- 没什么变化：这一轮没怎么动（此时可以只写 nothing）。',
    '',
    'deltas 是这四个量的「净变化」，符号必须跟 label 一致：被夸得受用是正的 valence，不是负的。',
    'why 一句话讲清她为什么这么动，不要解释机制。',
    'confidence 是把握：看不清、语气中性就给 0.3 以下。',
    'object 是这情绪指向谁/什么（比如「油冷这件事」「master」「那条视频」），没有就写空字符串。',
    '',
    '没怎么动就只输出：{"nothing":true,"label":"没什么变化","why":"","confidence":0.4,"object":""}',
    '动了就只输出一个 JSON，不要别的：',
    '{"valence":0.1,"arousal":0.05,"energy":0,"trust":0.02,"label":"被夸得受用","why":"","confidence":0.7,"object":"master"}',
  ].join('\n')
}

function kindWord(kind) {
  if (kind === 'roam') return '她自己出门转了一圈，看了一堆东西回来（没有跟人说话）'
  if (kind === 'speakup') return '她自己先开口找 master 说话'
  return 'master 跟她说话'
}

/**
 * 情绪 2.0：一次小调用，判断这一轮让她怎么动。
 * 拿不到就返回 null，规则版 appraisal 继续兜底。
 */
export async function judgeMood(llm, character, state, exchange, signal) {
  const config = {
    provider: character.planner?.provider ?? 'deepseek-official',
    model: character.planner?.model ?? 'deepseek-flash',
    maxTokens: 240,
    temperature: 0.3,
    timeoutMs: 9000,
    ...(character.mood ?? {}),
  }
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout

  const lines = [
    `她现在的状态：心情 ${round(state.mood.valence)}（-1 到 1），来劲 ${round(state.mood.arousal)}，精力 ${round(state.energy)}，信任 ${round(state.trust)}`,
    `这一轮：${kindWord(exchange.kind)}`,
  ]
  if (exchange.user) lines.push(`master 说：「${String(exchange.user).slice(0, 300)}」`)
  lines.push(`她说：「${String(exchange.reply ?? '').slice(0, 400)}」`)

  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      system: buildSystem(character),
      messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }],
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: merged,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return null
  }

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return normalizeMood(JSON.parse(raw.slice(start, end + 1)))
  } catch {
    return null
  }
}

/**
 * 把判断落到状态上。`ruleDelta` 是这一轮规则版已经加过的量：
 * 判断器成功时按差值补偿，避免同一次反应被记两遍。
 */
export function applyMood(state, judged, character, ruleDelta = null) {
  const d = judged.deltas
  const applied = {}
  for (const axis of AXES) {
    const already = Number(ruleDelta?.[axis]) || 0
    const target = d[axis]
    applied[axis] = round(clamp(target - already, -0.3, 0.3))
  }

  const magnitude = round(
    Math.abs(applied.valence) + Math.abs(applied.arousal) * 0.5 + Math.abs(applied.energy) * 0.5 + Math.abs(applied.trust) * 0.3,
  )
  // 没怎么动就别写状态：微小抖动累积起来会让状态飘，也会让日志失真。
  if (judged.nothing || magnitude < MIN_APPLY) {
    return { applied: { valence: 0, arousal: 0, energy: 0, trust: 0 }, magnitude, weight: 0, skipped: true }
  }

  // 低置信：只减半记后台，不让她「说出来」。
  const weight = judged.confidence < LOW_CONFIDENCE ? 0.5 : 1
  const dyn = character.dynamics ?? {}
  state.mood.valence = clamp((state.mood.valence + applied.valence * weight) * (dyn.valenceDecay ?? 0.94), -1, 1)
  state.mood.arousal = clamp(
    (dyn.quietBaseline ?? 0.45) + (state.mood.arousal + applied.arousal * weight - (dyn.quietBaseline ?? 0.45)) * (dyn.arousalDecay ?? 0.92),
    0,
    1,
  )
  state.energy = clamp(state.energy + applied.energy * weight, 0, 1)
  state.trust = clamp(state.trust + applied.trust * weight, 0, 1)
  state.updatedAt = new Date().toISOString()
  state.lastAppraisal = {
    at: state.updatedAt,
    source: 'mood-llm',
    deltas: applied,
    reason: `${judged.label}：${judged.why}`,
    tags: [judged.label].filter(Boolean),
    confidence: judged.confidence,
    object: judged.object ?? '',
  }

  return { applied, magnitude, weight, skipped: false }
}

/** 够不够格让她自己提一句：幅度够、判得准、不是刚说过的同一件事。 */
export function pickAnnounce(judged, applied, magnitude, mood) {
  if (!judged.label || judged.label === '没什么变化') return null
  if (judged.nothing) return null
  if (magnitude < ANNOUNCE_THRESHOLD) return null
  if (judged.confidence < ANNOUNCE_CONFIDENCE) return null
  const lastAt = Date.parse(mood.lastAnnouncedAt ?? '')
  const fresh = Number.isFinite(lastAt) && Date.now() - lastAt < REPEAT_QUIET_MS
  if (fresh && mood.lastLabel === judged.label) return null
  return { label: judged.label, why: judged.why, magnitude, at: new Date().toISOString() }
}

export function renderMoodShift(shift) {
  if (!shift?.label) return ''
  return [
    MOOD_SENTINEL,
    `刚才那件事让她「${shift.label}」${shift.why ? `：${shift.why}` : ''}`,
    '这一轮可以带到话里，也可以不提；要提就一句，别反复讲同一件事。',
  ].join('\n')
}

/** 留一条痕：她最近的情绪波动，观测与自查用。 */
export function rememberShift(mood, judged, applied, magnitude, announced) {
  const entry = {
    at: new Date().toISOString(),
    label: judged.label,
    why: judged.why,
    applied,
    magnitude,
    announced,
  }
  mood.history = [...(mood.history ?? []), entry].slice(-80)
  return entry
}

export function logMood(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(MOOD_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    // 记录不能影响聊天本身
  }
}
