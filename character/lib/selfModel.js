import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 自我模型：她自己的台词——观点、承诺、关于她自己的陈述。
// 稳定保存（不像 episodic 72 小时过期），注入成 [关于自己]，让她记得自己说过什么。

const SELF_FILE = join(DATA_DIR, 'self.json')
const TMP_FILE = join(DATA_DIR, '.self.tmp.json')
const MAX_LINES = 24

const empty = () => ({ lines: [] })

export function loadSelfModel() {
  try {
    if (existsSync(SELF_FILE)) {
      const value = JSON.parse(readFileSync(SELF_FILE, 'utf8'))
      if (value && Array.isArray(value.lines)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveSelfModel(self) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(self, null, 2), 'utf8')
  renameSync(TMP_FILE, SELF_FILE)
}

/** 记下她自己说的话；同文本去重，最多保留 MAX_LINES 条。返回是否写了东西。 */
export function rememberSelfLines(self, lines, now = Date.now()) {
  let changed = false
  for (const line of lines ?? []) {
    const text = String(line?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (text.length < 3) continue
    if ((self.lines ?? []).some((existing) => existing.text === text)) continue
    self.lines = [...(self.lines ?? []), { text, at: new Date(now).toISOString(), kind: String(line?.kind ?? 'self').slice(0, 20), certainty: line?.certainty === 'inference' || line?.certainty === 'assumption' ? line.certainty : 'fact' }].slice(-MAX_LINES)
    changed = true
  }
  return changed
}

/** 渲染成 [关于自己]，只带最近、最有把握的几条。 */
export function renderSelfModel(self, limit = 6) {
  const lines = (self.lines ?? []).slice(-limit)
  if (!lines.length) return ''
  return `[关于自己]\n${lines.map((line) => {
    const mark = line.certainty === 'assumption' ? '·假设' : line.certainty === 'inference' ? '·推断' : ''
    return `- ${line.text}${mark}`
  }).join('\n')}`
}
