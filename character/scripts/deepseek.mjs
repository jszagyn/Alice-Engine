#!/usr/bin/env node
/**
 * 直接调 DeepSeek API 的小工具（给评测脚本用，不经过 DSH 宿主）。
 * key 从环境变量 DEEPSEEK_API_KEY 或 G:\DSH\data\.credentials.yaml 读，不打印。
 */
import { readFileSync, existsSync } from 'node:fs'

const CRED = 'G:\\DSH\\data\\.credentials.yaml'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_MODEL = 'deepseek-flash'

export function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  if (!existsSync(CRED)) throw new Error(`找不到 key：${CRED}`)
  const text = readFileSync(CRED, 'utf8')
  const match = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!match) throw new Error('credentials.yaml 里没有 DEEPSEEK_API_KEY')
  return match[1]
}

export async function chat({ system, user, model = DEFAULT_MODEL, maxTokens = 200, temperature = 0.2, timeoutMs = 30000 }) {
  const key = readKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    const data = JSON.parse(text)
    return data.choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

export function parseJsonLoose(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
