import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR } from './state.js'

// 表情包：颜文字（text）+ 自定义表情图（image）。
// 情绪档位 = 低 / 中 / 高 / 仅；颜文字从 kaomoji.json 挑，表情图从 stickers.json 挑。

const HERE = dirname(fileURLToPath(import.meta.url))
const STICKERS_DIR = join(dirname(HERE), 'stickers') // character/stickers

export function loadKaomoji() {
  try {
    const file = join(STICKERS_DIR, 'kaomoji.json')
    if (!existsSync(file)) return {}
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** 按情绪挑一个颜文字；没有对应档就回退「中」，再没有就空字符串。 */
export function pickKaomoji(emotion, kaomoji) {
  const table = kaomoji ?? {}
  const list = Array.isArray(table[emotion]) ? table[emotion]
    : Array.isArray(table.中) ? table.中
    : []
  if (!list.length) return ''
  return list[Math.floor(Math.random() * list.length)]
}

/** 读 stickers.json，把相对路径解析成绝对路径。 */
export function loadStickers() {
  try {
    const file = join(STICKERS_DIR, 'stickers.json')
    if (!existsSync(file)) return []
    const value = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(value?.stickers) ? value.stickers : []
    return list.map((s) => ({ ...s, file: join(STICKERS_DIR, s.file) }))
  } catch {
    return []
  }
}

/** 按情绪挑一个表情图；没有对应档就全局随机挑，一个都没有返回 null。 */
export function pickSticker(emotion, stickers) {
  const list = stickers.filter((s) => s?.emotion === emotion)
  const pool = list.length ? list : stickers
  if (!pool.length) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 记录表情包使用次数（只给你回看，不进记忆、不给爱丽丝）。 */
export function logStickerUsage(sticker) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(
      join(DATA_DIR, 'sticker-usage.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), n: sticker?.n, meaning: sticker?.meaning, file: sticker?.file })}\n`,
      'utf8',
    )
  } catch {
    // 日志失败不影响回复。
  }
}
