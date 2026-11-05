import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 情感记忆：master 明显夸过她 / 否定过她的瞬间，沉淀成一句话（借鉴养鱼插件的「拍马屁自动记录」）。
// 最多 12 条，注入成 [情感记忆]，让她记得被夸过、被泼过冷水。

const FILE = join(DATA_DIR, 'feelings.json')
const TMP = join(DATA_DIR, '.feelings.tmp.json')
const MAX = 12

const empty = () => ({ items: [] })

export function loadFeelings() {
  try {
    if (existsSync(FILE)) {
      const value = JSON.parse(readFileSync(FILE, 'utf8'))
      if (value && Array.isArray(value.items)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveFeelings(feelings) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP, JSON.stringify(feelings, null, 2), 'utf8')
  renameSync(TMP, FILE)
}

/** 记下一条情感事件；同文本去重，最多 MAX 条。返回是否写了东西。 */
export function rememberFeeling(feelings, text, now = Date.now()) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)
  if (clean.length < 4) return false
  if ((feelings.items ?? []).some((item) => item.text === clean)) return false
  feelings.items = [...(feelings.items ?? []), { text: clean, at: new Date(now).toISOString() }].slice(-MAX)
  return true
}

/** 渲染成 [情感记忆]，只带最近的几条。 */
export function renderFeelings(feelings, limit = 4) {
  const list = (feelings.items ?? []).slice(-limit)
  if (!list.length) return ''
  return `[情感记忆]\n${list.map((item) => `- ${item.text}`).join('\n')}`
}
