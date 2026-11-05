import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 大事记：master 提到的重要、长期的事（换工作/结婚/搬家/毕业/项目完结等）。
// 不像 episodic 72 小时过期——这些是会一直记得的大事，最多 12 条，注入成 [大事记]。

const EVENT_FILE = join(DATA_DIR, 'events.json')
const TMP_FILE = join(DATA_DIR, '.events.tmp.json')
const MAX_EVENTS = 12

const empty = () => ({ events: [] })

export function loadEvents() {
  try {
    if (existsSync(EVENT_FILE)) {
      const value = JSON.parse(readFileSync(EVENT_FILE, 'utf8'))
      if (value && Array.isArray(value.events)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveEvents(events) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(events, null, 2), 'utf8')
  renameSync(TMP_FILE, EVENT_FILE)
}

/** 记下 master 的大事；同文本去重，最多 MAX_EVENTS 条。返回是否写了东西。 */
export function rememberEvents(events, lines, now = Date.now()) {
  let changed = false
  for (const line of lines ?? []) {
    const text = String(line?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)
    if (text.length < 3) continue
    if ((events.events ?? []).some((existing) => existing.text === text)) continue
    events.events = [...(events.events ?? []), { text, at: new Date(now).toISOString() }].slice(-MAX_EVENTS)
    changed = true
  }
  return changed
}

/** 渲染成 [大事记]，只带最近的几条。 */
export function renderEvents(events, limit = 6) {
  const list = (events.events ?? []).slice(-limit)
  if (!list.length) return ''
  return `[大事记]\n${list.map((entry) => `- ${entry.text}`).join('\n')}`
}
