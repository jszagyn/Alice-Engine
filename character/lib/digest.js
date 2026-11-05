import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 短短期记忆过期后压成一行。三十行封顶，更早的整段并进日记。
const DIGEST_FILE = join(DATA_DIR, 'digest.json')
const TMP_FILE = join(DATA_DIR, '.digest.tmp.json')

export const DIGEST_KEEP = 30

const empty = () => ({ lines: [] })

export function loadDigest() {
  try {
    if (existsSync(DIGEST_FILE)) {
      const value = JSON.parse(readFileSync(DIGEST_FILE, 'utf8'))
      if (value && Array.isArray(value.lines)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveDigest(digest) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(digest, null, 2), 'utf8')
  renameSync(TMP_FILE, DIGEST_FILE)
}

/** 追加一行概括；超过 30 行时把最老的一行挤出去（返回它，由调用方并进日记）。 */
export function appendDigest(digest, { date, text }, keep = DIGEST_KEEP) {
  const line = { date, text: String(text ?? '').slice(0, 80) }
  if (!line.text) return null
  digest.lines = [...(digest.lines ?? []), line]
  const overflow = []
  while (digest.lines.length > keep) overflow.push(digest.lines.shift())
  saveDigest(digest)
  return overflow.length ? overflow[0] : null
}

export function renderDigest(digest, limit = 3) {
  const lines = (digest.lines ?? []).slice(-limit)
  if (!lines.length) return ''
  return `[以前的概括]\n${lines.map((line) => `- ${line.date} ${line.text}`).join('\n')}`
}

const localDate = (now) => {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 把一批过期条目压成一行。一次小调用，失败就写个兜底摘要，不让记忆断档。
 */
export async function closeEpisodes(llm, character, expired, { now = Date.now() } = {}) {
  if (!expired?.length) return null
  const config = character.planner ?? {}
  const material = expired.map((entry) => `- ${entry.text}（提过 ${entry.mentions ?? 1} 次）`).join('\n')
  const fallback = expired[0].text.slice(0, 40)
  if (!llm) return { date: localDate(now), text: fallback }

  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider ?? 'deepseek-official',
      model: config.model ?? 'deepseek-flash',
      system:
        '把这几天的琐事压成一行概括，给以后回忆用。只输出那一行，不要引号、不要解释。写成「谁对谁，发生了什么」这种第三人称：她记的是关于 master 的事，不是她自己的经历。挑最有信息量的一两件，其余的可以合并。不超过 40 字。',
      messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
      maxTokens: 400,
      temperature: 0.3,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    raw = ''
  }
  const text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0]
  return { date: localDate(now), text: (text || fallback).slice(0, 80) }
}
