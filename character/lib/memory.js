import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DATA_DIR = join(PACKAGE_ROOT, 'data')
const MEMORY_FILE = join(DATA_DIR, 'memory.json')
const TMP_FILE = join(DATA_DIR, '.memory.tmp.json')

const NOW = () => new Date().toISOString()
const todayKey = () => NOW().slice(0, 10)

const DAILY_QUOTA = 8 // 防鸡毛蒜皮塞满：每天最多记这么多条新记忆

// 高精度、低召回：宁可不记，也不记错。v2 再换 LLM 抽取。
const EXTRACTORS = [
  { re: /(我在写|我在做|我在学|我在搞|我在玩|我最近在)/, kind: 'fact', tier: 'event', salience: 0.8 },
  { re: /(我喜欢|我讨厌|我不喜欢|我特别|我超|我最(?!近))/, kind: 'preference', tier: 'fact', salience: 0.8 },
  { re: /(我是说|我的意思是|我不是)/, kind: null, salience: 0 }, // 排除，不是自述
  { re: /(我叫|我是)/, kind: 'fact', tier: 'fact', salience: 0.9 },
  { re: /(我住在|我从事|我专业|我学校|我公司在)/, kind: 'fact', tier: 'fact', salience: 0.8 },
  { re: /(我明天|我下周|我打算|我准备|我计划|我想.*做)/, kind: 'plan', tier: 'event', salience: 0.7 },
  { re: /(答应|约定|说好了|记住|别忘了|下次.*一定)/, kind: 'promise', tier: 'fact', salience: 0.9 },
]

// 用户在翻旧账：这是回忆请求，不是新记忆
const RECALL_RE = /(我上次|我之前|我原来|我以前|还记得|你记得|你还记|上次说的|之前聊过)/

// 口头确认：用户明确要求记的东西，无条件收为正式记忆
const EXPLICIT_RE = /(记一下|帮我记|记住[，:：]|别忘了)/

// 会过期的说法：只在「今天/刚才」成立的话，不能当永久事实存下来
const TRANSIENT_RE = /(今天|今晚|昨天|今早|刚才|这会儿|这两天|这几天|马上|待会|一会儿)/

/**
 * 入库前的清洗。四件事，缺一件记忆就会变味：
 * 1. 剥掉口头确认的壳（「对了，记一下，」不是记忆的一部分）
 * 2. 「我」换成「master」——不是「你」。换成「你」等于在她自己的提示里写
 *    「你最近在写小说」，她会当成自己的经历（2026-10-30：她就这么说了
 *    「我这边也卡着，小说写到一段上」）。写成人名才不会认错主语。
 * 3. 「我们」换成「master 和你」
 * 4. 砍掉会过期的尾巴（「今天没什么思路」明天就是错的）
 */
/**
 * 长度上限要砍在分句边界上：「…而且你的承受能力还挺强」能读，
 * 「…没什么让我觉得很重口，不」不能——一句话半截进库，她每轮都念那半截。
 */
function clipToClause(text, max = 40) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const breaks = ['，', '、', '；', ',', ';']
  const lastBreak = Math.max(...breaks.map((mark) => cut.lastIndexOf(mark)))
  let out = lastBreak > 8 ? cut.slice(0, lastBreak) : cut
  out = out.replace(/[，,、；;：:\s]+$/, '')
  out = out.replace(/(?:而且|但是|不过|还有|以及|或者|因为|所以|就是|并且|然后)$/, '')
  return out.trim()
}

// 名字插入后会留下多余空格：「让 master 觉得」而不是「让master 觉得」。
function tidySpaces(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([，,。！？!?、；;：:）】」』])/g, '$1')
    .trim()
}

export function distil(raw, maxLength = 40) {
  let text = String(raw).trim()
  text = text.replace(/^(?:对了|嗯|那个|诶|哦)[，,：:]\s*/, '')
  text = text.replace(/^(?:记一下|帮我记一下|帮我记|记住|别忘了)[，,：:]?\s*/, '')
  text = text.replace(/我们/g, 'master 和你')
  text = text.replace(/我(?!们)/g, ' master ')
  text = tidySpaces(text).replace(/master\s*$/g, 'master')
  const clauses = text.split(/[，,]/)
  for (let index = 1; index < clauses.length; index += 1) {
    const clause = clauses[index]
    if (TRANSIENT_RE.test(clause) || /^(?:可惜|不过|但是|就是|反正)/.test(clause)) {
      text = clauses.slice(0, index).join('，')
      break
    }
  }
  // 结尾挂着 1–2 个字的碎句（「…很重口，不」）等于没说完，整段砍掉。
  const pieces = text.split(/[，,]/)
  if (pieces.length > 1) {
    const lastPiece = pieces[pieces.length - 1].replace(/[。！？!?…\s]/g, '')
    if (lastPiece.length > 0 && lastPiece.length < 3) {
      text = pieces.slice(0, -1).join('，')
    }
  }
  return clipToClause(text, maxLength)
}

// 事实键：同一件事只留最新。规则版只覆盖两个最稳的键。
// 注意要用 cleaned（原文，含「我」）调用，所以两个称呼都得认。
function factKeyOf(text) {
  const name = text.match(/(?:master|[我你])叫([\u4e00-\u9fa5A-Za-z0-9]{1,8})/)
  if (name) return 'name'
  const home = text.match(/(?:master|[我你])住在(.{1,12})/)
  if (home) return 'home'
  return null
}

export function loadMemory() {
  let raw = null
  try {
    if (existsSync(MEMORY_FILE)) raw = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'))
  } catch {
    raw = null
  }
  const entries = Array.isArray(raw) ? raw : []
  // 兼容旧数据：没有 tier 的条目按 kind 推断（plan → event，其余 → fact）
  for (const entry of entries) {
    if (!entry.tier) entry.tier = entry.kind === 'plan' ? 'event' : 'fact'
  }
  return forget(entries)
}

export function saveMemory(entries) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(entries, null, 2), 'utf8')
  renameSync(TMP_FILE, MEMORY_FILE)
}

/** 记忆文件的修改时间：外部改过（手工修数据、修脚本）就能被发现并热加载。 */
export function memoryFileStamp() {
  try {
    return statSync(MEMORY_FILE).mtimeMs
  } catch {
    return 0
  }
}

// 字符级重叠：去掉虚词，把「不X」当成一个带极性的单位。
const STOP = new Set('的了是我你这那他她它个还就都也很在有又和与及吗呢么什么怎么因为所以如果但是那')
const NEGATED = ['喜欢', '讨厌', '信', '靠谱', '行', '对', '太']

function tokens(text) {
  const clean = String(text).replace(/[\s，。！？、,.!?「」【】:：]/g, '')
  const set = new Set()
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]
    if (STOP.has(char)) continue
    if (char === '不' && index + 1 < clean.length && !STOP.has(clean[index + 1])) {
      set.add(`不${clean[index + 1]}`)
      index += 1
    } else {
      set.add(char)
    }
  }
  return set
}

export const overlap = (a, b) => {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  if (shared < 2) return 0
  let score = shared / Math.min(left.size, right.size)

  // 极性冲突：「不喜欢 X」不能和「喜欢 X」互相巩固
  for (const word of NEGATED) {
    const negA = a.includes(`不${word}`)
    const posA = a.includes(word) && !negA
    const negB = b.includes(`不${word}`)
    const posB = b.includes(word) && !negB
    if ((negA && posB) || (negB && posA)) score *= 0.25
  }
  return score
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const days = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000

/** 事件记忆：30 天没被想起 → 强度衰减；又弱又旧 → 休眠。长期事实不受此规则影响。 */
function forget(entries) {
  let changed = false
  for (const entry of entries) {
    if (entry.status !== 'active' || entry.tier === 'fact') continue
    if (days(entry.lastRecalled) > 30) {
      entry.strength = Math.round(entry.strength * 0.7 * 100) / 100
      entry.lastRecalled = NOW()
      changed = true
    }
    if (entry.strength < 0.5 && entry.salience < 0.8) {
      entry.status = 'dormant'
      changed = true
    }
  }
  if (changed) saveMemory(entries)
  return entries
}

/** 从用户消息里抽值得记的事；返回变更后的记忆数组。 */
export function extractFromUser(entries, userText) {
  const cleaned = String(userText).trim()
  if (cleaned.length < 4 || cleaned.length > 120) return entries

  // 口头确认：「记一下 / 帮我记 / 记住」→ 无条件收为正式记忆（confirmed）
  const explicit = EXPLICIT_RE.test(cleaned)

  let matched = null
  for (const rule of EXTRACTORS) {
    if (rule.kind && rule.re.test(cleaned)) {
      matched = { kind: rule.kind, tier: rule.tier, salience: rule.salience }
      break
    }
  }
  if (!matched && !explicit) return entries

  const text = distil(cleaned)
  if (text.length < 3) return entries
  const similar = entries.find((entry) => entry.status === 'active' && overlap(entry.text, text) > 0.55)
  if (similar) {
    // 再次提到 ≈ 巩固 + 一次回忆；口头确认过就把候选升级为正式
    similar.strength = clamp(similar.strength + 1, 1, 10)
    similar.lastRecalled = NOW()
    if (explicit) similar.confirmed = true
    // 只有新的说法更干净（更短）才覆盖，别让带口头语的原句盖掉规范文本
    if (text.length < similar.text.length) similar.text = text
    return entries
  }

  // 事实键：同一件事只留最新，旧的标「已被取代」（保留可追溯）
  const tier = matched?.tier ?? 'fact'
  const key = tier === 'fact' ? factKeyOf(cleaned) : null
  if (key) {
    for (const entry of entries) {
      if (entry.status === 'active' && entry.factKey === key) entry.status = 'superseded'
    }
  }

  // 每天配额：防鸡毛蒜皮把记忆库塞满
  const createdToday = entries.filter((entry) => entry.at?.slice(0, 10) === todayKey()).length
  if (createdToday >= DAILY_QUOTA) return entries

  entries.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: NOW(),
    kind: matched?.kind ?? 'fact',
    tier: matched?.tier ?? 'fact',
    factKey: key,
    text,
    salience: matched?.salience ?? 0.9,
    strength: 1,
    confirmed: explicit,
    firstAt: NOW(),
    lastRecalled: NOW(),
    status: 'active',
  })
  return entries
}

/** 面板用：master 亲手补一条记忆（直接算确认过；近似条目只加固，不重复建）。 */
export function addManualMemory(entries, rawText, options = {}) {
  const text = distil(String(rawText ?? ''), options.maxLength ?? 60)
  if (text.length < 2) return null
  const tier = options.tier === 'event' ? 'event' : 'fact'
  const key = tier === 'fact' ? factKeyOf(text) : null

  const similar = entries.find((entry) => entry.status === 'active' && overlap(entry.text, text) > 0.6)
  if (similar) {
    similar.strength = clamp(similar.strength + 1, 1, 10)
    similar.confirmed = true
    similar.lastRecalled = NOW()
    return similar
  }

  if (key) {
    for (const entry of entries) {
      if (entry.status === 'active' && entry.factKey === key) entry.status = 'superseded'
    }
  }

  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: NOW(),
    kind: tier,
    tier,
    factKey: key,
    text,
    salience: 0.95,
    strength: 1,
    confirmed: true,
    firstAt: NOW(),
    lastRecalled: NOW(),
    status: 'active',
    source: 'master',
  }
  entries.push(entry)
  return entry
}

/** 面板用：确认 / 取消确认。 */
export function setConfirmed(entries, id, confirmed) {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return null
  entry.confirmed = Boolean(confirmed)
  return entry
}

/** 面板用：软删除——留痕，不真删（她的记忆可追溯）。 */
export function markDeleted(entries, id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return null
  entry.status = 'deleted'
  entry.deletedAt = NOW()
  return entry
}

/** 按 相关 × 新近 × 强度 检索 top-k；被选中的条目获得回忆强化。 */
export function retrieveMemories(entries, userText, limit = 2) {
  const scored = []
  for (const entry of entries) {
    if (entry.status !== 'active') continue
    const similarity = overlap(userText, entry.text)
    if (similarity < 0.25) continue
    const recency = Math.pow(0.5, days(entry.lastRecalled) / 7)
    const score = similarity * (1 + 0.15 * Math.log(entry.strength + 1)) * recency
    scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)

  let reinforced = false
  const picked = scored.slice(0, limit).map(({ entry }) => {
    entry.strength = clamp(entry.strength + 0.3, 1, 10)
    entry.lastRecalled = NOW()
    reinforced = true
    return entry
  })
  if (reinforced) saveMemory(entries)
  return picked
}

/**
 * 长期事实：每轮固定带前几条（不看这句话问了什么），不占事件检索的位置。
 * offset 让它们轮着出现——否则永远只有同一条被反复提起，像复读机。
 */
export function alwaysFacts(entries, limit = 2, offset = 0) {
  const pool = entries
    .filter((entry) => entry.status === 'active' && entry.tier === 'fact')
    .sort((a, b) => b.salience * b.strength - a.salience * a.strength)
  if (pool.length <= limit) return pool
  const start = ((offset % pool.length) + pool.length) % pool.length
  return Array.from({ length: limit }, (_unused, index) => pool[(start + index) % pool.length])
}

/** 用户主动翻旧账时，把最相关的旧事拉出来（给表达层用）。 */
export function recallFor(entries, userText) {
  if (!RECALL_RE.test(userText)) return []
  const candidates = entries
    .filter((entry) => entry.status === 'active')
    .map((entry) => ({ entry, score: overlap(userText, entry.text) * entry.salience }))
    .filter(({ score }) => score > 0.2)
    .sort((a, b) => b.score - a.score)
  return candidates.slice(0, 2).map(({ entry }) => entry)
}

function timeWord(iso) {
  const diff = days(iso)
  if (diff < 1) return '今天'
  if (diff < 2) return '昨天'
  if (diff < 7) return `${Math.floor(diff)}天前`
  if (diff < 365) return `${Math.max(2, Math.floor(diff / 30))}个月前`
  return '很久以前'
}

export function renderMemories(entries) {
  if (!entries.length) return ''
  const lines = entries.map((entry) => {
    // 条目已经带主语（master …），不再叠「他说过」——那会读成他的原话，主语反而糊掉。
    const kindWord = entry.text.startsWith('master')
      ? ''
      : ({ preference: '他喜欢/不喜欢', fact: '他说过', plan: '他打算', promise: '他答应过', self: '他说过' }[entry.kind] ?? '记得') + '：'
    return `- ${kindWord}${entry.text}（${timeWord(entry.at)}）`
  })
  return lines.join('\n')
}
