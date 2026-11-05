import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const DIARY_FILE = join(DATA_DIR, 'diary.json')
const TMP_FILE = join(DATA_DIR, '.diary.tmp.json')

const dayKey = () => new Date().toISOString().slice(0, 10)
const yesterdayKey = () => {
  const date = new Date(Date.now() - 86_400_000)
  return date.toISOString().slice(0, 10)
}

export function loadDiary() {
  try {
    if (existsSync(DIARY_FILE)) {
      const value = JSON.parse(readFileSync(DIARY_FILE, 'utf8'))
      if (value && Array.isArray(value.lines)) return value
    }
  } catch {
    // 坏了就重建。
  }
  return { lastDate: null, lastTurns: 0, lines: [] }
}

export function saveDiary(diary) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(diary, null, 2), 'utf8')
  renameSync(TMP_FILE, DIARY_FILE)
}

/**
 * 每天第一次被搭话时，用她自己的口吻给昨天写一句话（自传原料）。
 * 昨天没有任何动静（turns 没涨）就不写。失败静默，绝不影响聊天。
 */
export async function writeDiaryLine(llm, character, diary, state, feed, turnsNow) {
  if (diary.lastDate === dayKey()) return diary
  if (turnsNow <= diary.lastTurns) return diary

  const yesterday = feed.days?.[yesterdayKey()] ?? []
  const topics = yesterday.map((item) => item.topic).join('、')

  const config = character.planner ?? {}
  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider ?? 'deepseek-official',
      model: config.model ?? 'deepseek-flash',
      system: `${character.layers.core}\n\n——\n现在用「爱丽丝」自己的口吻，写一句关于昨天的话。10-30 字，第一人称，可以提昨天逛到的事，也可以只写心情。只输出这一句话，不要别的。`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `昨天她关注过：${topics || '没什么特别的事'}\n昨天和 master 聊过 ${turnsNow - diary.lastTurns} 轮`,
            },
          ],
        },
      ],
      maxTokens: 80,
      temperature: 0.8,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return diary
  }

  const line = raw.trim().replace(/^["「]|["」]$/g, '').slice(0, 40)
  if (!line) return diary

  diary.lines.push({ date: yesterdayKey(), text: line })
  if (diary.lines.length > 90) diary.lines = diary.lines.slice(-90)
  diary.lastDate = dayKey()
  diary.lastTurns = turnsNow
  saveDiary(diary)
  return diary
}

/** 最近一条“她的昨天”——写于今天早上，描述的是昨天。 */
export function renderDiary(diary) {
  const last = diary.lines?.[diary.lines.length - 1]
  if (!last || last.date !== yesterdayKey()) return ''
  return `[她的昨天] ${last.text}`
}
