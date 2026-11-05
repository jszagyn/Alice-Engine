import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const EXEMPLAR_FILE = join(DATA_DIR, 'exemplars.json')
const TMP_FILE = join(DATA_DIR, '.exemplars.tmp.json')
const CAP = 300

export function loadExemplars() {
  try {
    if (!existsSync(EXEMPLAR_FILE)) return { good: [], bad: [] }
    const value = JSON.parse(readFileSync(EXEMPLAR_FILE, 'utf8'))
    if (value && Array.isArray(value.good) && Array.isArray(value.bad)) return value
  } catch {
    // 文件损坏时从空库开始，不阻塞聊天。
  }
  return { good: [], bad: [] }
}

export function saveExemplars(store) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(store, null, 2), 'utf8')
  renameSync(TMP_FILE, EXEMPLAR_FILE)
}

/**
 * 示例库：好/坏都存，坏例带 reasons。自判标签 source:auto，confidence 打折；
 * 之后你亲手标的会覆盖权重。容量各 300，去重靠 reply 文本。
 */
export function recordExemplar(store, entry) {
  const pool = entry.verdict === 'bad' ? store.bad : store.good
  if (pool.some((existing) => existing.reply === entry.reply)) return store
  pool.unshift(entry)
  if (pool.length > CAP) pool.length = CAP
  saveExemplars(store)
  return store
}
