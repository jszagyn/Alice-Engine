import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 长期槽位：关于 master 的稳定信息，不是「某天发生了什么」。
// 短期的事进 episodic（72 小时自动过期），同一件事在概括里出现三天以上
// 才会被归纳成槽位写到这里——或者 master 亲口说，那是一次就够。
const PROFILE_FILE = join(DATA_DIR, 'profile.json')
const TMP_FILE = join(DATA_DIR, '.profile.tmp.json')

export const PROFILE_SLOTS = [
  {
    key: 'identity.name',
    label: '名字',
    priority: 10,
    re: /(?:master|我|你)\s*叫([\u4e00-\u9fa5A-Za-z0-9]{1,8})/,
    value: (match) => match[1],
  },
  {
    key: 'identity.city',
    label: '住的地方',
    priority: 9,
    re: /(?:master|我|你)\s*住在?(.{2,12}?)(?:[，。！？]|$|那边|附近)/,
    value: (match) => match[1],
  },
  {
    key: 'habit.sleep',
    label: '作息',
    priority: 8,
    re: /(?:master|我|你)\s*(?:平常|一般|通常|每天|平时)?(.{0,4}点(?:多|半)?(?:才|就)?(?:睡|起))/,
    value: (match) => match[1],
  },
  {
    key: 'taste.like',
    label: '喜欢',
    priority: 7,
    list: true,
    re: /(?:master|我|你)\s*(?:挺喜欢|喜欢|爱看|爱玩|爱吃|爱听|对)(.{1,14}?)(?:[，。！？]|$|挺|很|的)/,
    value: (match) => match[1],
  },
  {
    key: 'taste.dislike',
    label: '不喜欢',
    priority: 6,
    list: true,
    re: /(?:master|我|你)\s*(?:不喜欢|讨厌|受不了|不爱)(.{1,14}?)(?:[，。！？]|$|的)/,
    value: (match) => match[1],
  },
  {
    key: 'story.open',
    label: '在做的事',
    priority: 5,
    ttlDays: 30,
    re: /(?:master\s*)?(?:最近在|正在|在)(写|做|学|搞|玩|练|读)(.{1,12}?)(?:[，。！？]|$)/,
    value: (match) => `${match[1]}${match[2]}`,
  },
  {
    key: 'health.state',
    label: '身体',
    priority: 4,
    re: /(?:master|我)\s*(?:最近)?(?:有点)?(失眠|睡不好|睡不着|过敏|头疼|头痛|感冒|生病|不舒服|颈椎|胃不舒服|鼻炎)/,
    value: (match) => match[1],
  },
  {
    key: 'relation.family',
    label: '家人',
    priority: 3,
    list: true,
    re: /(?:master|我)(?:的)?(妹妹|姐姐|哥哥|弟弟|妈妈|爸|妈|女儿|儿子|老婆|女朋友|男朋友|对象|闺女)/,
    value: (match) => match[1],
  },
  {
    key: 'relation.social',
    label: '身边人',
    priority: 2,
    list: true,
    re: /(?:master|我)(?:的)?(朋友|同事|同学|老师|老板|室友|队友)/,
    value: (match) => match[1],
  },
]

// 高的一层压住低的一层：他自己说的 > 她听出来的 > 从概括里归纳的。
// 同一层里新的压旧的（时间在下文 upsertSlot 里比）。
const SOURCE_RANK = { master: 3, self: 2, inferred: 1 }

export const sourceRank = (source) => SOURCE_RANK[source] ?? 0

// 事实/推断/假设三分：事实最高、推断次之、假设最低。
// 推断被反复引用也不自动升级成事实（防记忆污染）。
export const CERTAINTY = ['fact', 'inference', 'assumption']
export const certaintyRank = (value) => ({ fact: 3, inference: 2, assumption: 1 })[value] ?? 0
export const normalizeCertainty = (value, fallback = 'fact') => (CERTAINTY.includes(value) ? value : fallback)

const certaintyMark = (slot) => {
  if (slot.certainty === 'assumption') return '·假设'
  if (slot.certainty === 'inference' && slot.source === 'self') return '·推断'
  return ''
}

const sourceLabel = (slot) => {
  const mark = certaintyMark(slot)
  if (slot.source === 'master') return `他说的${mark}`
  if (slot.source === 'inferred') return `归纳的，${slot.days ?? 0} 天${mark}`
  return `她自己记的${mark}`
}

const emptyProfile = () => ({ slots: {}, updatedAt: new Date().toISOString() })

/** 带 ttlDays 的槽位（如 story.open「在做的事」）超期就清掉——过了 30 天就不再是「正在做」。 */
export function pruneProfile(profile, now = Date.now()) {
  for (const slot of PROFILE_SLOTS) {
    if (!slot.ttlDays) continue
    const current = profile.slots?.[slot.key]
    if (!current) continue
    const lastAt = Date.parse(current.lastAt ?? current.firstAt ?? 0)
    if (Number.isFinite(lastAt) && now - lastAt > slot.ttlDays * 24 * 3600 * 1000) {
      delete profile.slots[slot.key]
    }
  }
  return profile
}

export function loadProfile() {
  try {
    if (existsSync(PROFILE_FILE)) {
      const value = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'))
      if (value && value.slots && typeof value.slots === 'object') return pruneProfile(value)
    }
  } catch {
    // 文件坏了就当空的重来。
  }
  return pruneProfile(emptyProfile())
}

export function saveProfile(profile) {
  mkdirSync(DATA_DIR, { recursive: true })
  profile.updatedAt = new Date().toISOString()
  writeFileSync(TMP_FILE, JSON.stringify(profile, null, 2), 'utf8')
  renameSync(TMP_FILE, PROFILE_FILE)
}

export function profileStamp() {
  try {
    return statSync(PROFILE_FILE).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 命中的值里有一类是不该收的：代词和虚词。
 * 「你叫我」会被名字槽位认成「你叫」+「我」——那是问句里的代词，不是名字。
 */
const STOP_VALUES = new Set(['我', '你', '他', '她', '它', '咱', '我们', '你们', '他们', '自己', '什么', '啥', '谁', '哪', '这个', '那个', '这', '那', '一个', '一点'])
const STOP_PREFIX = /^(我|你|他|她|它|咱|什么|啥|谁|哪|这个|那个)/

const badValue = (value) => STOP_VALUES.has(value) || STOP_PREFIX.test(value)

/** 这句话里有没有能归到槽位的信息？命中就返回第一个 {key, value}。 */
export function classifySlot(text) {
  return classifyAll(text)[0] ?? null
}

/**
 * 一句话里可能同时说了好几件事（「我住在杭州，最近在写小说」），
 * 所以这里把能认出来的槽位都收下，最多三条，同一个槽位只取第一次命中。
 */
export function classifyAll(text) {
  const source = String(text ?? '')
  const hits = []
  const seen = new Set()
  for (const slot of PROFILE_SLOTS) {
    if (seen.has(slot.key)) continue
    const match = source.match(slot.re)
    if (!match) continue
    const value = String(slot.value(match) ?? '').trim()
    if (value.length < 1 || value.length > 20) continue
    if (badValue(value)) continue
    seen.add(slot.key)
    hits.push({ key: slot.key, value })
    if (hits.length >= 3) break
  }
  return hits
}

const pushEvidence = (slot, { text, date, source }) => {
  if (!text) return
  const entry = { text: String(text).slice(0, 40), date, source }
  const list = [...(slot.evidence ?? [])]
  if (list.some((item) => item.text === entry.text)) return
  slot.evidence = [...list, entry].slice(-3)
}

/**
 * 写槽位。source：master 亲口说 > self 她自己听出来的 > inferred 归纳。
 * 列表槽位（喜好）保留多个值；单值槽位换值时旧值进 superseded。
 * 返回 true 表示值真的变了（被低优先级盖住时返回 false）。
 */
export function upsertSlot(profile, { key, value, source = 'self', certainty, note = '', evidence = '', now = Date.now() }) {
  const slot = PROFILE_SLOTS.find((candidate) => candidate.key === key)
  if (!slot || !value) return false
  const at = new Date(now).toISOString()
  const date = at.slice(0, 10)
  const current = profile.slots[key]
  const incoming = sourceRank(source)
  const existing = sourceRank(current?.source)
  const cert = normalizeCertainty(certainty, { master: 'fact', self: 'fact', inferred: 'inference' }[source] ?? 'fact')

  if (slot.list) {
    const values = [...(current?.values ?? [])].filter((item) => item !== value)
    if (source === 'inferred' && existing >= SOURCE_RANK.self && !values.includes(value)) {
      // 归纳出来的喜好不能压掉他说过的，只记一笔。
      current.lastAt = at
      return false
    }
    values.unshift(value)
    const changed = !current || !(current.values ?? []).includes(value)
    profile.slots[key] = {
      values: values.slice(0, 6),
      value: values[0],
      label: slot.label,
      source: incoming > existing || existing === 0 ? source : current?.source ?? source,
      certainty: cert,
      note: String(note ?? current?.note ?? '').slice(0, 60),
      firstAt: current?.firstAt ?? at,
      lastAt: at,
      days: current?.days ?? 0,
      mentions: (current?.mentions ?? 0) + 1,
      evidence: current?.evidence ?? [],
    }
    pushEvidence(profile.slots[key], { text: evidence, date, source })
    return changed
  }

  if (current && current.value === value) {
    current.lastAt = at
    current.mentions = (current.mentions ?? 1) + 1
    if (incoming > existing) current.source = source
    if (source === 'master' && note) current.note = String(note).slice(0, 60)
    pushEvidence(current, { text: evidence, date, source })
    return false
  }

  // 归纳出来的新值盖不动他说的/她自己听出来的结论。
  if (current && source === 'inferred' && existing >= SOURCE_RANK.self) {
    current.lastAt = at
    return false
  }

  // 同源里，低 certainty（推断/假设）盖不动高 certainty（事实）。
  if (current && current.value !== value && incoming === existing && certaintyRank(cert) < certaintyRank(normalizeCertainty(current.certainty, 'fact'))) {
    current.lastAt = at
    return false
  }

  const superseded = current
    ? [...(current.superseded ?? []), { value: current.value, at, source: current.source }].slice(-5)
    : []
  profile.slots[key] = {
    value,
    label: slot.label,
    source: incoming >= existing ? source : current?.source ?? source,
    certainty: cert,
    note: String(note ?? '').slice(0, 60),
    firstAt: current?.value === value ? current.firstAt : at,
    lastAt: at,
    days: current?.days ?? 0,
    mentions: (current?.mentions ?? 0) + 1,
    superseded,
    evidence: current?.evidence ?? [],
  }
  pushEvidence(profile.slots[key], { text: evidence, date, source })
  return true
}

/**
 * 从一句话里认出槽位并写进去；返回写了哪些（带旧值，给日志用）。
 */
export function rememberInProfile(profile, text, { source = 'self', note = '', now = Date.now() } = {}) {
  const hits = classifyAll(text)
  const changed = []
  for (const hit of hits) {
    const previous = profile.slots[hit.key]?.value ?? null
    if (upsertSlot(profile, { ...hit, source, note, evidence: text, now })) {
      changed.push({ key: hit.key, value: hit.value, previous })
    }
  }
  return changed
}

/**
 * master 纠正：不管原来是什么、谁写的，直接改成他说的值，旧值进 superseded。
 * 只处理单值槽位——「我不喜欢辣」这类列表槽位由 upsertSlot 的自然流程走。
 */
export function correctSlot(profile, { key, value, note = '他纠正的', now = Date.now() }) {
  const slot = PROFILE_SLOTS.find((candidate) => candidate.key === key)
  if (!slot || !value) return null
  const current = profile.slots[key]
  const previous = slot.list ? (current?.values ?? []) : current?.value ?? null
  if (!slot.list) {
    const at = new Date(now).toISOString()
    profile.slots[key] = {
      value,
      label: slot.label,
      source: 'master',
      note: String(note).slice(0, 60),
      firstAt: current?.firstAt ?? at,
      lastAt: at,
      days: 0,
      mentions: (current?.mentions ?? 0) + 1,
      superseded: current ? [...(current.superseded ?? []), { value: current.value, at, source: current.source }].slice(-5) : [],
      evidence: current?.evidence ?? [],
    }
    pushEvidence(profile.slots[key], { text: note, date: at.slice(0, 10), source: 'master' })
  } else {
    upsertSlot(profile, { key, value, source: 'master', note, evidence: note, now })
  }
  return { key, value, previous }
}

/**
 * 归纳升级：同一件事在不同日期的概括里出现 minDays 次以上，才写进长期。
 * 已经是他说的/她自己记的槽位不覆盖——归纳只补空白，不改高优先级的结论。
 */
export function promoteFromDigest(profile, digest, { minDays = 3, now = Date.now() } = {}) {
  const seen = new Map()
  for (const line of digest?.lines ?? []) {
    for (const hit of classifyAll(line.text)) {
      const id = `${hit.key}|${hit.value}`
      const entry = seen.get(id) ?? { key: hit.key, value: hit.value, dates: new Set() }
      entry.dates.add(String(line.date ?? '').slice(0, 10))
      seen.set(id, entry)
    }
  }
  const promoted = []
  for (const entry of seen.values()) {
    const days = entry.dates.size
    if (days < minDays) continue
    const current = profile.slots[entry.key]
    if (current && sourceRank(current.source) >= sourceRank('self')) continue
    const at = new Date(now).toISOString()
    upsertSlot(profile, {
      key: entry.key,
      value: entry.value,
      source: 'inferred',
      note: `概括里出现 ${days} 天`,
      evidence: [...entry.dates].sort().join('、'),
      now,
    })
    if (profile.slots[entry.key]) profile.slots[entry.key].days = days
    promoted.push({ key: entry.key, value: entry.value, days, at })
  }
  return promoted
}

/** 按优先级渲染，默认只带最有把握的 6 条。 */
export function renderProfile(profile, limit = 6) {
  const order = new Map(PROFILE_SLOTS.map((slot) => [slot.key, slot.priority]))
  const entries = Object.entries(profile.slots ?? {})
    .sort((a, b) => (order.get(b[0]) ?? 0) - (order.get(a[0]) ?? 0) || String(b[1].lastAt).localeCompare(String(a[1].lastAt)))
    .slice(0, limit)
  if (!entries.length) return ''
  const lines = entries.map(([key, slot]) => {
    const slotDef = PROFILE_SLOTS.find((candidate) => candidate.key === key)
    const shown = slotDef?.list ? (slot.values ?? [slot.value]).join('、') : slot.value
    return `- ${slot.label}：${shown}（${sourceLabel(slot)}）`
  })
  return `[关于 master]\n${lines.join('\n')}`
}

/** 给内容层用的扁平条目（它只认识 {text}）。 */
export function profileEntries(profile, limit = 6) {
  return renderProfile(profile, limit)
    .split('\n')
    .slice(1)
    .map((line) => ({ text: line.replace(/^-\s*/, '') }))
    .filter((entry) => entry.text)
}
