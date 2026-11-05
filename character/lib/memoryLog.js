import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 记忆写入的流水账：什么时候、谁说的、把哪个槽位从什么改成什么。
// 只追加不修改，给「她说错了，我纠正」留证据链。
const LOG_FILE = join(DATA_DIR, 'memory-log.jsonl')

export function logMemory(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    // 日志失败不能影响对话。
  }
}

export function readMemoryLog(limit = 20) {
  try {
    if (!existsSync(LOG_FILE)) return []
    return readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
