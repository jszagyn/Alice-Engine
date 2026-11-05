import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const FILE = join(DATA_DIR, 'speakup.json')
const TMP = join(DATA_DIR, '.speakup.tmp.json')

export const SPEAKUP_MARKER = '[主动搭话]'

/** 触发文案是「她自己的念头」，不是系统指令。 */
const DEFAULT_TRIGGER = `${SPEAKUP_MARKER}
（自己冒出来的念头）好一阵子没跟 master 说话了，想去找他说两句`

export function loadSpeakUp() {
  try {
    if (existsSync(FILE)) {
      const value = JSON.parse(readFileSync(FILE, 'utf8'))
      if (value && typeof value === 'object') return value
    }
  } catch {
    // 坏了就重建。
  }
  return { lastSpokeAt: null, misses: 0, counts: {} }
}

export function saveSpeakUp(speakUp) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP, JSON.stringify(speakUp, null, 2), 'utf8')
  renameSync(TMP, FILE)
}

export function triggerText(config) {
  return config?.triggerText?.trim() || DEFAULT_TRIGGER
}

// V3 事件流：主动搭话不再只有「闲聊」一种，按当下状态挑对应的念头。
// 每条有 cond（条件）和 text（她自己的念头）；命中多个就随机挑，让主动消息不总是一个样。
const TRIGGERS = [
  {
    id: 'goodnight',
    cond: ({ now }) => { const h = now.getHours(); return h >= 23 || h < 1 },
    text: `${SPEAKUP_MARKER}
（自己冒出来的念头）都这个点了，想跟 master 说声晚安`,
  },
  {
    id: 'share',
    cond: ({ feedHasToday }) => feedHasToday,
    text: `${SPEAKUP_MARKER}
（自己冒出来的念头）今天看到点东西，挺想跟 master 说说`,
  },
  {
    id: 'curious',
    cond: ({ characterState }) => (characterState.curiosity ?? 0.5) >= 0.7,
    text: `${SPEAKUP_MARKER}
（自己冒出来的念头）突然有个问题想问 master，憋着难受`,
  },
  {
    id: 'chat',
    cond: () => true,
    text: DEFAULT_TRIGGER,
  },
]

/** 按状态挑一个匹配的念头；命中多个就随机挑一个。 */
export function pickTrigger(config, characterState, feedHasToday, now = new Date()) {
  const list = config?.triggers ?? TRIGGERS
  const matching = list.filter((trigger) => trigger.cond({ characterState, feedHasToday, now }))
  if (!matching.length) return DEFAULT_TRIGGER
  const picked = matching[Math.floor(Math.random() * matching.length)]
  return typeof picked.text === 'string' ? picked.text.trim() : DEFAULT_TRIGGER
}

/** DeepSeek 高峰时段：工作日 9–12、14–18（北京时间）。 */
function isPeak(date) {
  const day = date.getDay()
  const hour = date.getHours()
  if (day === 0 || day === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

const dayKey = () => new Date().toISOString().slice(0, 10)

/**
 * 连着搭话都没人应的次数。只看最近的窗口：隔太久说明对方只是睡了，
 * 不该把昨天的沉默算到今天的头上。
 */
function unansweredStreak(speakUp, config, nowMs) {
  const last = speakUp.lastSpokeAt ? Date.parse(speakUp.lastSpokeAt) : 0
  const windowMs = (config?.unansweredWindowMinutes ?? 360) * 60_000
  if (!last || Number.isNaN(last) || nowMs - last > windowMs) return 0
  return speakUp.unanswered ?? 0
}

/**
 * 掷骰子：命中线 = 峰谷基数 × 时机因子 × 状态因子 + 没中加成。
 * 纯本地随机，掷中之前一个 token 都不花。
 */
export function maySpeak(speakUp, config, characterState, feedHasToday, lastActivityAt = 0) {
  if (!config?.enabled) return { ok: false, reason: 'disabled' }

  const now = new Date()
  const hour = now.getHours()
  const quietStart = config.quietStart ?? 1
  const quietEnd = config.quietEnd ?? 8
  if (quietStart < quietEnd && hour >= quietStart && hour < quietEnd) {
    return { ok: false, reason: 'quiet-hours' }
  }

  const today = speakUp.counts?.[dayKey()] ?? 0
  if (today >= (config.maxPerDay ?? 6)) return { ok: false, reason: 'daily-limit' }

  const streak = unansweredStreak(speakUp, config, now.getTime())
  if (streak >= (config.maxUnanswered ?? 2)) return { ok: false, reason: 'unanswered', streak }

  const since = speakUp.lastSpokeAt ? Date.now() - Date.parse(speakUp.lastSpokeAt) : Number.POSITIVE_INFINITY
  const cooldown = (config.cooldownMinutes ?? 20) * 60_000
  if (Number.isFinite(since) && since < cooldown) return { ok: false, reason: 'cooldown' }

  // 刚聊完也别插嘴：冷却和「刚聊过」都按「她上回露面」算，不是只按上次搭话算。
  const sinceActivity = lastActivityAt ? now.getTime() - lastActivityAt : Number.POSITIVE_INFINITY
  if (Number.isFinite(sinceActivity) && sinceActivity < cooldown) {
    return { ok: false, reason: 'cooldown', sinceActivity }
  }

  const base = isPeak(now) ? (config.hitPeak ?? 20) : (config.hitOffpeak ?? 60)

  let factor = 1
  const quietFor = Math.min(since, sinceActivity)
  if (Number.isFinite(quietFor)) {
    if (quietFor < (config.recentMinutes ?? 20) * 60_000) factor *= config.recentFactor ?? 0.15
    else if (quietFor > (config.coldMinutes ?? 360) * 60_000) factor *= config.coldFactor ?? 1.5
  }

  let stateFactor = 1
  if ((characterState.mood?.arousal ?? 0) >= 0.6) stateFactor *= 1.3
  if (feedHasToday) stateFactor *= 1.2

  const missBonus = Math.min(config.missBonusCap ?? 40, (speakUp.misses ?? 0) * (config.missBonus ?? 10))
  const hitLine = Math.min(100, base * factor * stateFactor + missBonus)

  const roll = Math.random() * 100
  const ok = roll < hitLine

  return { ok, reason: ok ? 'hit' : 'miss', hitLine, roll }
}

export function recordSpeak(speakUp, config) {
  const key = dayKey()
  speakUp.unanswered = unansweredStreak(speakUp, config, Date.now()) + 1
  speakUp.lastSpokeAt = new Date().toISOString()
  speakUp.misses = 0
  speakUp.counts = { ...(speakUp.counts ?? {}) }
  speakUp.counts[key] = (speakUp.counts[key] ?? 0) + 1
  saveSpeakUp(speakUp)
  return speakUp
}

/** master 回话了：连着没人应的计数清零。 */
export function recordReply(speakUp) {
  if (!speakUp.unanswered) return speakUp
  speakUp.unanswered = 0
  saveSpeakUp(speakUp)
  return speakUp
}

export function recordMiss(speakUp) {
  speakUp.misses = (speakUp.misses ?? 0) + 1
  saveSpeakUp(speakUp)
  return speakUp
}
