import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const ROAM_FILE = join(DATA_DIR, 'roam.json')
const TMP_FILE = join(DATA_DIR, '.roam.tmp.json')
const TASK_FILE = join(DATA_DIR, 'roam-task.md')
const SEEN_FILE = join(DATA_DIR, 'seen.json')
const SEEN_TMP = join(DATA_DIR, '.seen.tmp.json')

export const ROAM_MARKER = '[自由活动时间]'

/** 漫游章程的出厂默认值；首次运行时落盘，之后以文件为准（你改过就不会被覆盖）。 */
const DEFAULT_TASK = `${ROAM_MARKER}
现在没有 master 的消息，你自己去网上逛逛：
- 挑一件你感兴趣的事：B站热榜、最近的新闻、或者你惦记的话题
- 用 web_search / web_fetch 了解，最多用 3 次工具
- 最后用自己的话给 master 发一条消息：你看到了什么、你怎么看
- 可以转述，禁止整段复制原文；没找到有意思的，就直说今天没什么可逛的`

/** 读漫游章程：文件不存在就播种默认值；之后永远以文件为准。 */
export function loadRoamTask() {
  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(TASK_FILE)) writeFileSync(TASK_FILE, DEFAULT_TASK, 'utf8')
  return readFileSync(TASK_FILE, 'utf8').trim()
}

export function loadRoam() {
  try {
    if (existsSync(ROAM_FILE)) {
      const value = JSON.parse(readFileSync(ROAM_FILE, 'utf8'))
      if (value && typeof value === 'object') return value
    }
  } catch {
    // 文件坏了就从零开始。
  }
  return { lastRoamAt: null, counts: {} }
}

export function saveRoam(roam) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(roam, null, 2), 'utf8')
  renameSync(TMP_FILE, ROAM_FILE)
}

const dayKey = () => new Date().toISOString().slice(0, 10)

/** DeepSeek 高峰时段：工作日 9–12、14–18（北京时间）。 */
function isPeakHour(date) {
  const day = date.getDay()
  const hour = date.getHours()
  if (day === 0 || day === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 预算闸门：时段窗口 / 高峰避让 / 最小间隔 / 每日上限 / force 调试开关。 */
export function mayRoam(roam, config) {
  if (!config?.enabled) return { ok: false, reason: 'disabled' }
  if (roam.force) return { ok: true, reason: 'forced', forced: true }

  const now = new Date()
  const hour = now.getHours()
  if (hour < config.windowStart || hour >= config.windowEnd) return { ok: false, reason: 'outside-window' }
  if (config.preferOffpeak && isPeakHour(now)) return { ok: false, reason: 'peak-hours' }

  const since = roam.lastRoamAt ? Date.now() - Date.parse(roam.lastRoamAt) : Number.POSITIVE_INFINITY
  if (Number.isFinite(since) && since < config.minIntervalHours * 3_600_000) {
    return { ok: false, reason: 'too-soon' }
  }

  const today = roam.counts?.[dayKey()] ?? 0
  if (today >= config.maxPerDay) return { ok: false, reason: 'daily-limit' }

  return { ok: true, reason: 'schedule' }
}

/** 记一次漫游：更新时刻与当日计数，并清掉 force。 */
export function recordRoam(roam) {
  const key = dayKey()
  roam.lastRoamAt = new Date().toISOString()
  roam.counts = { ...(roam.counts ?? {}) }
  roam.counts[key] = (roam.counts[key] ?? 0) + 1
  roam.force = false
  saveRoam(roam)
}

// —— 判重表：刷过的 URL/BV 不再逛第二次 ——

export function loadSeen() {
  try {
    if (existsSync(SEEN_FILE)) {
      const value = JSON.parse(readFileSync(SEEN_FILE, 'utf8'))
      if (value && Array.isArray(value.urls)) return value
    }
  } catch {
    // 坏了就重建。
  }
  return { urls: [] }
}

export function saveSeen(seen) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SEEN_TMP, JSON.stringify(seen, null, 2), 'utf8')
  renameSync(SEEN_TMP, SEEN_FILE)
}

/** 把她的见闻链接记进判重表（最多保留 200 条）。 */
export function recordSeen(seen, urls) {
  // 同一轮里可能抓到多条相同链接；先按 URL 去重，别让判重表被同一条塞满。
  const clean = [...new Set(urls.filter((url) => typeof url === 'string' && url.startsWith('http')))]
  if (!clean.length) return seen
  seen.urls = [...clean, ...seen.urls.filter((url) => !clean.includes(url))].slice(0, 200)
  saveSeen(seen)
  return seen
}

/** 唤醒消息末尾附一句：最近逛过的，挑新的。 */
export function seenHint(seen, limit = 6) {
  const recent = seen.urls.slice(0, limit)
  if (!recent.length) return ''
  return `\n\n最近逛过的（挑新的，别重复）：\n${recent.map((url) => `- ${url}`).join('\n')}`
}
