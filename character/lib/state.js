import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// 测试可以把它指到临时目录，免得写坏真实 data/
export const DATA_DIR = process.env.DSH_CHARACTER_DATA ?? join(PACKAGE_ROOT, 'data')
const STATE_FILE = join(DATA_DIR, 'state.json')
const TMP_FILE = join(DATA_DIR, '.state.tmp.json')

export const STATE_SENTINEL = '[现在的状态]'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value) => Math.round(value * 1000) / 1000

export function loadState(initial) {
  let stored = null
  try {
    if (existsSync(STATE_FILE)) stored = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    stored = null
  }

  const fresh = {
    mood: { valence: initial.valence, arousal: initial.arousal },
    energy: initial.energy,
    trust: initial.trust,
    frustration: initial.frustration ?? 0.2,
    curiosity: initial.curiosity ?? 0.5,
    affinity: initial.affinity ?? 0.5,
    pressure: 0,
    conflict: null,
    turns: 0,
    updatedAt: new Date().toISOString(),
    lastAppraisal: null,
  }

  if (!stored || typeof stored !== 'object' || !stored.mood) return decay(fresh)

  return decay({
    ...fresh,
    ...stored,
    mood: { ...fresh.mood, ...stored.mood },
  })
}

export function decay(state) {
  const stamp = Date.parse(state.updatedAt ?? '')
  if (!Number.isFinite(stamp)) return state
  const hours = (Date.now() - stamp) / 3_600_000
  if (hours <= 0) return state

  const halfLife = Math.pow(0.5, hours / 8)
  state.mood.valence = clamp(state.mood.valence * halfLife, -1, 1)
  state.mood.arousal = clamp(0.35 + (state.mood.arousal - 0.35) * halfLife, 0, 1)
  state.energy = clamp(state.energy + hours * 0.04, 0, 1)
  state.pressure = clamp((state.pressure ?? 0) * Math.pow(0.5, hours / 12), 0, 1)
  state.frustration = clamp((state.frustration ?? 0.2) * Math.pow(0.5, hours / 3), 0, 1)
  state.curiosity = clamp(0.5 + ((state.curiosity ?? 0.5) - 0.5) * Math.pow(0.5, hours / 8), 0, 1)
  state.affinity = clamp(0.5 + ((state.affinity ?? 0.5) - 0.5) * Math.pow(0.5, hours / 12), 0, 1)
  state.updatedAt = new Date().toISOString()
  return state
}

export function applyAppraisal(state, appraisal, character) {
  const d = character.dynamics
  const next = appraisal.deltas ?? {}

  // R1 扰动 + R2 交叉耦合：先按维度连锁放大（方向不变），再整体随机缩放 0.85–1.15。
  const frustration = state.frustration ?? 0.2
  const curiosityNow = state.curiosity ?? 0.5
  const affinityNow = state.affinity ?? 0.5
  const jitter = 1 + (Math.random() - 0.5) * 0.3
  const adjust = (key, value) => {
    let v = value ?? 0
    if (!v) return 0
    // R2 交叉耦合：挫败高→负面放大；好奇高→新鲜放大；亲和低→被冷落更难受。
    if (key === 'valence' && v < 0 && frustration >= 0.5) v *= 1.3
    if (key === 'curiosity' && v > 0 && curiosityNow >= 0.7) v *= 1.3
    if (key === 'affinity' && v < 0 && affinityNow < 0.3) v *= 1.3
    return v * jitter
  }

  state.mood.valence = clamp((state.mood.valence + adjust('valence', next.valence)) * d.valenceDecay, -1, 1)
  state.mood.arousal = clamp(
    d.quietBaseline + (state.mood.arousal + adjust('arousal', next.arousal) - d.quietBaseline) * d.arousalDecay,
    0,
    1,
  )
  state.energy = clamp(state.energy + (d.energyPerTurn ?? 0) + (next.energy ?? 0), 0, 1)
  state.trust = clamp(state.trust + (next.trust ?? 0), 0, 1)
  state.pressure = clamp((state.pressure ?? 0) + (next.pressure ?? 0), 0, 1)
  state.frustration = clamp(frustration + adjust('frustration', next.frustration), 0, 1)
  state.curiosity = clamp(curiosityNow + adjust('curiosity', next.curiosity), 0, 1)
  state.affinity = clamp(affinityNow + adjust('affinity', next.affinity), 0, 1)
  state.turns += 1
  state.updatedAt = new Date().toISOString()
  state.lastAppraisal = { at: state.updatedAt, ...appraisal }
  return state
}

export function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true })
  const payload = JSON.stringify(
    {
      ...state,
      mood: { valence: round(state.mood.valence), arousal: round(state.mood.arousal) },
      energy: round(state.energy),
      trust: round(state.trust),
      pressure: round(state.pressure ?? 0),
      frustration: round(state.frustration ?? 0.2),
      curiosity: round(state.curiosity ?? 0.5),
      affinity: round(state.affinity ?? 0.5),
    },
    null,
    2,
  )
  writeFileSync(TMP_FILE, payload, 'utf8')
  renameSync(TMP_FILE, STATE_FILE)
}

const moodWord = (valence) => {
  if (valence < -0.35) return '低落'
  if (valence < -0.1) return '有点闷'
  if (valence < 0.18) return '平稳'
  if (valence < 0.45) return '不错'
  return '高兴'
}

const arousalWord = (arousal) => {
  if (arousal < 0.3) return '懒懒的'
  if (arousal < 0.5) return '平常'
  if (arousal < 0.72) return '来劲'
  return '很兴奋'
}

const energyWord = (energy) => {
  if (energy < 0.3) return '低'
  if (energy < 0.6) return '中'
  return '足'
}

const trustWord = (trust) => {
  if (trust < 0.22) return '刚认识，聊天没问题'
  if (trust < 0.4) return '有点熟了'
  if (trust < 0.6) return '愿意说真话'
  return '很信任，可以示弱'
}

/** One line the content layer can read without the full block. */
export function stateSummary(state) {
  const base = `心情${moodWord(state.mood.valence)}（${arousalWord(state.mood.arousal)}），精力${energyWord(state.energy)}，对 master ${trustWord(state.trust)}`
  const bits = []
  if ((state.pressure ?? 0) >= 0.4) bits.push('被连着要求有点烦')
  if ((state.frustration ?? 0.2) >= 0.55) bits.push('有点挫败')
  if ((state.curiosity ?? 0.5) >= 0.7) bits.push('很好奇')
  if ((state.affinity ?? 0.5) < 0.3) bits.push('不太想理人')
  return bits.length ? `${base}，${bits.join('、')}` : base
}

function tendency(state) {
  const { valence, arousal } = state.mood
  const pressure = state.pressure ?? 0
  const frustration = state.frustration ?? 0.2
  const curiosity = state.curiosity ?? 0.5
  const affinity = state.affinity ?? 0.5
  if (pressure >= 0.45) return '被连着要求，有点烦，可以顶一句、岔开或拒绝，别一味顺从'
  if (frustration >= 0.55) return '有点挫败，话会少，容易不耐烦'
  if (valence < -0.3) return '懒得接，句子短一点'
  if (arousal >= 0.5) return '来劲了，话会多，容易跑题'
  if (curiosity >= 0.7) return '很好奇，想多问几句，别憋着'
  if (affinity < 0.3) return '不太想理人，话收着点'
  if (state.trust > 0.55) return '可以损他两句，也可以示弱'
  if (state.trust < 0.22) return '想到什么说什么，私事先不提'
  return '想到什么说什么，别等着被问'
}

const ECHO = {
  '被否定': '被泼了冷水，还没缓过来',
  '被敷衍': '被敷衍了，有点没劲',
  '被肯定': '被夸了一句，受用',
  '他道歉了': '他把刚才的话收回去了一点',
  '说了自己': '他刚说了点自己的事',
  '问回你': '他反过来问你了',
  '被强令': '刚被使唤了，有点不情愿',
  '有新鲜事': '刚聊到新鲜事，还有点上头',
  '有来有回': '刚才聊得有来有回',
  '工具出错': '刚才没办成，有点懊恼',
}

const ECHO_ORDER = [
  '被否定',
  '被敷衍',
  '被肯定',
  '他道歉了',
  '说了自己',
  '问回你',
  '被强令',
  '有新鲜事',
  '有来有回',
  '工具出错',
]

function echoLine(state) {
  const tags = state.lastAppraisal?.tags ?? []
  for (const tag of ECHO_ORDER) {
    if (tags.includes(tag)) return ECHO[tag]
  }
  return ''
}

/** 作息：一天里的时段，影响她此刻的说话状态。 */
function dayPhase() {
  const hour = new Date().getHours()
  if (hour < 5) return '深夜，有点困，话会少'
  if (hour < 9) return '早晨，刚醒，话不多'
  if (hour < 12) return '上午，慢慢来劲了'
  if (hour < 15) return '下午，精神最好的时候'
  if (hour < 19) return '傍晚，有点累但还能聊'
  if (hour < 23) return '晚上，放松下来了'
  return '深夜，有点困，话会少'
}

/** 两难留痕：她上一轮做了个难的选择（拒绝/顶回去），这一轮留个回声。 */
export function noteConflict(state, conflict) {
  state.conflict = { ...conflict, at: new Date().toISOString() }
}

export function clearConflict(state) {
  state.conflict = null
}

function conflictLine(state) {
  const conflict = state.conflict
  if (!conflict) return ''
  let feel
  if (conflict.reaction === 'accepted') feel = '他好像接受了，松了口气'
  else if (conflict.reaction === 'pushed') feel = '他好像不太高兴，是不是我太硬了'
  else feel = (state.mood.valence ?? 0) < -0.1 ? '还有点过意不去' : '反而松了口气'
  return `上轮${conflict.chosen}，没${conflict.abandoned}——${feel}`
}

/**
 * 情绪层：算这轮要带多少情绪（低/中/高/仅）。
 * 情绪基数 = 他的情绪（E_master）+ 她的兴趣调节（I_self，curiosity 联动）。
 * 话题需求由 contentWeight 映射；需求 > 基数时上浮 + 随机下移 0-2 档（有时够着、有时差一点）。
 */
export function emotionLevel(hisEmotion, curiosity, contentWeight, rand = Math.random) {
  const em = { high: 2, mid: 1, low: 0 }[hisEmotion] ?? 1
  const interest = curiosity >= 0.7 ? 1 : curiosity < 0.4 ? -1 : 0
  const base = clamp(em + interest, 0, 2) // 0=低 1=中 2=高

  if (contentWeight === 'minimal') {
    // 仅情绪低占比：短打趣偶尔才「只回一个语气词」，多数时候「应一声」（低情绪）。
    return rand() < 0.3 ? '仅' : '低'
  }
  const demand = { simple: 0, discuss: 1, expert: 2 }[contentWeight] ?? 1

  let level = base
  if (demand === 0 && base > 0) {
    // 功能查询（simple）：她再兴奋也不硬 high，降一档（查天气就平淡）
    level = Math.max(0, base - 1)
  } else if (demand > base) {
    // 需求 > 供给：上浮一档去够需求，再随机下移 0-2（有时够得着、有时差一点）
    level = Math.min(demand, base + 1)
    level = Math.max(0, level - Math.floor(rand() * 3))
  }
  return ['低', '中', '高'][level]
}

const emotionLabel = (level) => ({ 低: '低（平淡）', 中: '中', 高: '高（带劲）', 仅: '仅（一个语气词就够）' })[level] ?? ''

export function renderState(state) {
  const lines = [
    STATE_SENTINEL,
    `时候：${dayPhase()}`,
    `心情：${moodWord(state.mood.valence)}（${arousalWord(state.mood.arousal)}）`,
    `精力：${energyWord(state.energy)}`,
    `对 master：${trustWord(state.trust)}`,
    `此刻：${tendency(state)}`,
  ]
  const echo = echoLine(state)
  if (echo) lines.push(`刚才：${echo}`)
  const conflict = conflictLine(state)
  if (conflict) lines.push(`挂心：${conflict}`)
  const emotion = emotionLabel(state.emotionLevel)
  if (emotion) lines.push(`情绪：${emotion}`)
  const object = state.lastAppraisal?.object
  if (object) lines.push(`指向：${object}`)
  return lines.join('\n')
}
