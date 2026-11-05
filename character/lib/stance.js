import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 立场清单（人工门的安全口子）：
// 核心人格（character.json 的 layers.core / layers.voice / 底线）锁死，不自动改。
// 但她在聊天里明确划的线、站的位置，会沉淀到这里，注入成 [我的立场]。
// 这是「表层可生长」的部分——想改就改这个文件（人工确认），核心永远不动。

const STANCE_FILE = join(DATA_DIR, 'stance.json')
const TMP_FILE = join(DATA_DIR, '.stance.tmp.json')
const MAX_LINES = 12

const empty = () => ({ lines: [] })

export function loadStance() {
  try {
    if (existsSync(STANCE_FILE)) {
      const value = JSON.parse(readFileSync(STANCE_FILE, 'utf8'))
      if (value && Array.isArray(value.lines)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveStance(stance) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(stance, null, 2), 'utf8')
  renameSync(TMP_FILE, STANCE_FILE)
}

/** 记下她的立场/划的线；同文本去重，最多 MAX_LINES 条。返回是否写了东西。 */
export function rememberStanceLines(stance, lines, now = Date.now()) {
  let changed = false
  for (const line of lines ?? []) {
    const text = String(line?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (text.length < 3) continue
    if ((stance.lines ?? []).some((existing) => existing.text === text)) continue
    stance.lines = [...(stance.lines ?? []), { text, at: new Date(now).toISOString(), kind: String(line?.kind ?? 'stance').slice(0, 20) }].slice(-MAX_LINES)
    changed = true
  }
  return changed
}

/** 渲染成 [我的立场]，只带最近、最明确的几条。 */
export function renderStance(stance, limit = 6) {
  const lines = (stance.lines ?? []).slice(-limit)
  if (!lines.length) return ''
  return `[我的立场]\n${lines.map((line) => `- ${line.text}`).join('\n')}`
}
