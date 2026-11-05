import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 短期记忆：三天里发生的事。不常驻——只在话题挨得上时带 1–2 条；
// 三天后过期，交给 digest 压成一行概括（见 lib/digest.js）。
const EPISODIC_FILE = join(DATA_DIR, 'episodic.json')
const TMP_FILE = join(DATA_DIR, '.episodic.tmp.json')

export const DEFAULT_TTL_HOURS = 72
const HOUR = 60 * 60 * 1000

const empty = () => ({ entries: [] })

export function loadEpisodic() {
  try {
    if (existsSync(EPISODIC_FILE)) {
      const value = JSON.parse(readFileSync(EPISODIC_FILE, 'utf8'))
      if (value && Array.isArray(value.entries)) return value
    }
  } catch {
    // 坏了就重来。
  }
  return empty()
}

export function saveEpisodic(episodic) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(episodic, null, 2), 'utf8')
  renameSync(TMP_FILE, EPISODIC_FILE)
}

const overlap = (a, b) => {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (!left || !right) return 0
  const bigrams = new Set()
  for (let i = 0; i + 2 <= left.length; i += 1) bigrams.add(left.slice(i, i + 2))
  let hits = 0
  for (let i = 0; i + 2 <= right.length; i += 1) {
    if (bigrams.has(right.slice(i, i + 2))) hits += 1
  }
  return hits / Math.max(1, right.length - 1)
}

const SHELL_RE = /^(?:对了|嗯|那个|诶|欸|哦|啊)[，,：:]\s*/
const RECALL_RE = /^(?:记一下|帮我记一下|帮我记|记住|别忘了)[，,：:]?\s*/
const ACK_RE = /^(?:好|好的|好呀|行|嗯|嗯嗯|哦|对|是|在|可以|没问题|收到|ok|OK|哈|哈哈|确实|真的|当然|谢谢)[啊呀呢吧哦噢诶欸，,。！？!?~…\s]*$/

/**
 * 短期记忆里该存什么：他说的那句话本身，不是洗过主语、读起来别扭的转述。
 * 「我」保持「我」——短期条目渲染时会带「他说：」的引号，主语不会认错。
 * 纯应答（「当然在」「没问题的」）和信息量太少的短句不记。
 */
export function utterance(text, max = 90) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim()
  // 口头壳可能叠两层（「嗯，对了，我……」），反复剥。
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(SHELL_RE, '').replace(RECALL_RE, '').trim()
    if (next === value) break
    value = next
  }
  if (ACK_RE.test(value)) return ''
  if (value.length < 6) return ''
  if (value.length > max) {
    const window = value.slice(0, max)
    const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf('；'))
    value = cut >= Math.floor(max * 0.6) ? value.slice(0, cut + 1) : `${window}…`
  }
  return value
}

/** 记一条短期的事；同义重复只加 mentions，不再堆一条。 */
export function rememberEpisode(episodic, text, { kind = 'chat', saidBy = 'master', certainty = 'fact', now = Date.now(), ttlHours = DEFAULT_TTL_HOURS } = {}) {
  const clean = String(text ?? '').trim()
  if (clean.length < 3) return null
  const duplicate = (episodic.entries ?? []).find((entry) => overlap(entry.text, clean) > 0.7)
  if (duplicate) {
    duplicate.mentions = (duplicate.mentions ?? 1) + 1
    duplicate.lastAt = new Date(now).toISOString()
    duplicate.expiresAt = new Date(now + ttlHours * HOUR).toISOString()
    return duplicate
  }
  const entry = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date(now).toISOString(),
    lastAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlHours * HOUR).toISOString(),
    kind,
    saidBy,
    certainty,
    text: clean.slice(0, 90),
    mentions: 1,
  }
  episodic.entries = [...(episodic.entries ?? []), entry].slice(-60)
  return entry
}

const isActive = (entry, now) => Date.parse(entry.expiresAt ?? 0) > now

/** 过期的取出来（交给 digest 压一行），返回剩下还在的。 */
export function pruneEpisodic(episodic, now = Date.now()) {
  const entries = episodic.entries ?? []
  const expired = entries.filter((entry) => !isActive(entry, now))
  episodic.entries = entries.filter((entry) => isActive(entry, now))
  return expired
}

const CERTAINTY_WEIGHT = { fact: 1, inference: 0.7, assumption: 0.4 }

/**
 * 检索评分 S = 0.5·相关 + 0.2·时间 + 0.15·重要 + 0.15·可信。
 * 相关是硬门槛（bigram 重叠 > 0.12 才进候选），其余三项只影响排序——
 * 「今天刚说、提过多次、又是事实」的条目，会压过「三天前、只提一次、还是推断」的。
 */
export function relevantEpisodes(episodic, text, limit = 2, now = Date.now()) {
  const entries = (episodic.entries ?? []).filter((entry) => isActive(entry, now))
  if (!entries.length) return []
  const scored = entries
    .map((entry) => {
      const relevance = overlap(entry.text, text)
      if (relevance <= 0.12) return null
      const ageHours = Math.max(0, (now - Date.parse(entry.at ?? entry.lastAt ?? 0)) / 3_600_000)
      const recency = Math.exp(-ageHours / 24)
      const importance = Math.min(1, (entry.mentions ?? 1) / 3)
      const credibility = CERTAINTY_WEIGHT[entry.certainty] ?? 1
      const score = 0.5 * relevance + 0.2 * recency + 0.15 * importance + 0.15 * credibility
      return { entry, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ entry }) => entry)
}

const timeWord = (iso, now = Date.now()) => {
  const delta = now - Date.parse(iso ?? 0)
  const days = Math.floor(delta / (24 * HOUR))
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days}天前`
}

export function renderEpisodes(entries, now = Date.now()) {
  if (!entries?.length) return ''
  return entries
    .map((entry) => {
      // summarized 条目已是第三人称（LLM 记忆总结写的），不再套「他说：」引号。
      const mark = entry.certainty === 'assumption' ? '·假设' : entry.certainty === 'inference' ? '·推断' : ''
      const body = entry.summarized
        ? entry.text
        : entry.saidBy === 'self' ? entry.text : `他说：「${entry.text}」`
      return `- ${body}（${timeWord(entry.at, now)}${mark}）`
    })
    .join('\n')
}

/** 过期批次 → 一行概括的原料（给 digest 的提示词用）。 */
export function renderExpired(entries) {
  return entries.map((entry) => `- ${entry.text}（${timeWord(entry.at)}，提过 ${entry.mentions ?? 1} 次）`).join('\n')
}
