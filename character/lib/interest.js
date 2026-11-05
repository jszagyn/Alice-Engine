import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 兴趣画像 v1：漫游选题不再完全靠资料员即兴判断，
// 而是记住「她真的愿意看什么」——按标签慢慢加权，但留 20% 随机，
// 免得她越看越窄、最后只剩一个话题。
const INTEREST_FILE = join(DATA_DIR, 'interest.json')
const TMP_FILE = join(DATA_DIR, '.interest.tmp.json')

// 探索率：两成概率不看权重、按原顺序挑，给新话题留门。
export const EXPLORE_RATE = 0.2
// 分数范围 [-1, 1]：正数是愿意看，负数是看完就不想再碰。
const MIN_SCORE = -1
const MAX_SCORE = 1

const empty = () => ({ tags: {}, picks: 0, updatedAt: '' })

export function loadInterest() {
  try {
    if (existsSync(INTEREST_FILE)) {
      const value = JSON.parse(readFileSync(INTEREST_FILE, 'utf8'))
      if (value && typeof value.tags === 'object') return { picks: 0, ...value }
    }
  } catch {
    // 坏了就从空白开始，别让漫游停。
  }
  return empty()
}

export function saveInterest(interest) {
  mkdirSync(DATA_DIR, { recursive: true })
  interest.updatedAt = new Date().toISOString()
  writeFileSync(TMP_FILE, JSON.stringify(interest, null, 2), 'utf8')
  renameSync(TMP_FILE, INTEREST_FILE)
}

export function interestStamp() {
  try {
    return statSync(INTEREST_FILE).mtimeMs
  } catch {
    return 0
  }
}

export function tagScore(interest, tag) {
  if (!tag) return 0
  return Number(interest?.tags?.[tag]?.score ?? 0)
}

/**
 * 按标签分给候选排序：分高的往前放，再抖一点避免每次都一样。
 * 抽到探索轮就原样返回（资料员按原始热度挑，能碰到新东西）。
 */
export function biasCandidates(candidates, interest, { random = Math.random } = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates ?? []
  if (!interest || random() < EXPLORE_RATE) return candidates
  return candidates
    .map((item, index) => ({
      item,
      index,
      weight: tagScore(interest, item?.tag) + (random() - 0.5) * 0.3,
    }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.item)
}

export function recordPick(interest, { tag = '', topic = '', now = Date.now() } = {}) {
  interest.picks = (interest.picks ?? 0) + 1
  if (!tag) return interest
  const entry = (interest.tags[tag] ??= { score: 0, picks: 0, engaged: 0, lastAt: '' })
  entry.picks = (entry.picks ?? 0) + 1
  entry.lastAt = new Date(now).toISOString()
  if (topic) entry.lastTopic = String(topic).slice(0, 60)
  return interest
}

/**
 * 一轮漫游之后回填信号：
 * - 看完愿意说、还说了具体内容 → +1
 * - 愿意说但只是泛泛接一句 → +0.4
 * - 判坏（尤其书报腔）→ 扣分，说明这类她接不住
 * 用滑动平均，单轮不决定生死。
 */
export function engagementSignal({ verdict = 'good', reasons = [], overlap = 0 } = {}) {
  if (verdict === 'bad') {
    return reasons.includes('书报腔') ? -0.6 : -0.3
  }
  return overlap >= 8 ? 1 : 0.4
}

export function recordEngagement(interest, { tag = '', signal = 0, now = Date.now() } = {}) {
  if (!tag) return interest
  const entry = (interest.tags[tag] ??= { score: 0, picks: 0, engaged: 0, lastAt: '' })
  const current = Number(entry.score ?? 0)
  entry.score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, current * 0.8 + signal * 0.2))
  entry.lastAt = new Date(now).toISOString()
  if (signal > 0) entry.engaged = (entry.engaged ?? 0) + 1
  return interest
}

export function topTags(interest, limit = 4) {
  return Object.entries(interest?.tags ?? {})
    .map(([tag, entry]) => ({ tag, ...entry }))
    // 有过挑选或回填过信号的都算，不能只看 picks——榜单类标签可能先有反馈再有挑选记录。
    .filter((entry) => (entry.picks ?? 0) > 0 || (entry.engaged ?? 0) > 0 || Math.abs(entry.score ?? 0) > 0.01)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
}

/** 给资料员看的一行偏好（只是参考，不替它做决定）。 */
export function renderInterest(interest, { limit = 4 } = {}) {
  const tags = topTags(interest, 12)
  if (!tags.length) return ''
  const liked = tags.filter((entry) => entry.score >= 0.15).slice(0, limit)
  const disliked = tags.filter((entry) => entry.score <= -0.15).slice(-limit)
  if (!liked.length && !disliked.length) return ''
  const format = (entry) => `${entry.tag}（${entry.score >= 0 ? '+' : ''}${entry.score.toFixed(2)}，看了 ${entry.picks} 次）`
  const lines = ['她最近的偏好（参考，不是命令）：']
  if (liked.length) lines.push(`- 更愿意看：${liked.map(format).join('、')}`)
  if (disliked.length) lines.push(`- 不太想看：${disliked.map(format).join('、')}`)
  return lines.join('\n')
}
