import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const FEED_FILE = join(DATA_DIR, 'feed.json')
const TMP_FILE = join(DATA_DIR, '.feed.tmp.json')

const dayKey = () => new Date().toISOString().slice(0, 10)

export function loadFeed() {
  try {
    if (existsSync(FEED_FILE)) {
      const value = JSON.parse(readFileSync(FEED_FILE, 'utf8'))
      if (value && value.days && typeof value.days === 'object') return value
    }
  } catch {
    // 文件坏了就重新开始。
  }
  return { days: {} }
}

export function saveFeed(feed) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP_FILE, JSON.stringify(feed, null, 2), 'utf8')
  renameSync(TMP_FILE, FEED_FILE)
}

export function addFeedItems(feed, items, date = dayKey()) {
  feed.days[date] = (feed.days[date] ?? []).concat(items).slice(0, 4)
  const keys = Object.keys(feed.days).sort()
  while (keys.length > 3) delete feed.days[keys.shift()]
  saveFeed(feed)
  return feed
}

/**
 * 「今天在关注」：所有角色会话共享。
 * 今天已经讲过的那条不再进上下文——同一件事一天只主动提一次，
 * 不然她会一遍遍拿同一条见闻开头（实测：四川舰连着三轮）。
 */
export function renderFeed(feed, now = Date.now()) {
  const date = dayKeyOf(now)
  const items = (feed.days?.[date] ?? []).filter((item) => !usedToday(item, date))
  if (!items.length) return ''
  const lines = items.map((item, index) => `${index + 1}) ${item.topic}（${item.take}）`)
  return `[今天在关注]\n${lines.join('\n')}`
}

const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10)

const usedToday = (item, date) => typeof item.usedAt === 'string' && item.usedAt.slice(0, 10) === date

/** 从一件见闻里取能在她话里认出来的词：中文按 2 字、英文/数字按 3 字起。 */
function keywordsOf(topic) {
  const words = String(topic ?? '').match(/[\u4e00-\u9fa5]+|[A-Za-z0-9-]{3,}/g) ?? []
  const picked = []
  for (const word of words) {
    if (/^[\u4e00-\u9fa5]+$/.test(word)) {
      for (let i = 0; i + 2 <= word.length; i += 1) picked.push(word.slice(i, i + 2))
    } else {
      picked.push(word)
    }
  }
  return picked
}

/**
 * 她说出来的话如果命中某条见闻的词，就把这条标记成「今天讲过了」。
 * 返回被标记的条数（0 = 没提）。
 */
export function markFeedUsed(feed, text, now = Date.now()) {
  const date = dayKeyOf(now)
  const items = feed.days?.[date] ?? []
  let marked = 0
  for (const item of items) {
    if (usedToday(item, date)) continue
    if (!keywordsOf(item.topic).some((word) => text.includes(word))) continue
    item.usedAt = new Date(now).toISOString()
    marked += 1
  }
  if (marked) saveFeed(feed)
  return marked
}

/** 漫游结束后：把她的见闻抽成结构化条目。失败返回 []，绝不影响聊天。 */
export async function extractFeedItems(llm, reply, character) {
  const config = character.planner ?? {}
  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider ?? 'deepseek-official',
      model: config.model ?? 'deepseek-flash',
      system:
        '从这段话里抽出她分享给对方的见闻。只输出 JSON 数组，不要别的。每条：{"topic":"一句话说清是什么事","take":"她自己的看法，不超过 20 字","url":"原文链接，没有就空字符串"}。最多 2 条；没有实质见闻就输出 []。',
      messages: [{ role: 'user', content: [{ type: 'text', text: reply.slice(0, 1500) }] }],
      maxTokens: 300,
      temperature: 0.3,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return []
  }

  const cleaned = raw.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return (Array.isArray(parsed) ? parsed : [])
      .slice(0, 2)
      .map((item) => ({
        topic: String(item.topic ?? '').slice(0, 60),
        take: String(item.take ?? '').slice(0, 40),
        url: String(item.url ?? '').slice(0, 200),
      }))
      .filter((item) => item.topic)
  } catch {
    return []
  }
}
