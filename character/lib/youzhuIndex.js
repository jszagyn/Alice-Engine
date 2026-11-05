import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR } from './state.js'

// 概括性记忆：把 alice/ 的目录结构压成「文件路径：概括」的内容索引。
// 默认只概括前两级（整个文件夹是什么 + 一层子文件夹是什么），不再往下；
// 具体怎么概括交给模型，只框定「概括哪几个层级」。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'alice')
const INDEX_FILE = join(DATA_DIR, 'alice-index.json')
const TMP = join(DATA_DIR, '.alice-index.tmp.json')
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 80,
  temperature: 0.3,
  timeoutMs: 12000,
}

const empty = () => ({ items: [] })

export function loadIndex() {
  try {
    if (existsSync(INDEX_FILE)) {
      const value = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
      if (value && Array.isArray(value.items)) return value
    }
  } catch {
    // 坏了重来。
  }
  return empty()
}

export function saveIndex(index) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(TMP, JSON.stringify(index, null, 2), 'utf8')
  renameSync(TMP, INDEX_FILE)
}

/** 记一条概括；按 path 去重/更新。返回是否变了。 */
export function rememberSummary(index, { path, summary, signature }, now = Date.now()) {
  const clean = String(summary ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length < 2) return false
  const existing = (index.items ?? []).find((item) => item.path === path)
  const at = new Date(now).toISOString()
  if (existing) {
    if (existing.summary === clean && existing.signature === signature) return false
    existing.summary = clean
    existing.signature = signature
    existing.at = at
    return true
  }
  index.items = [...(index.items ?? []), { path, summary: clean, signature, at }]
  return true
}

/** 渲染成 [我读过的稿子]，格式「路径：概括」。 */
export function renderIndex(index, limit = 8) {
  const items = (index.items ?? []).slice(-limit)
  if (!items.length) return ''
  return `[我读过的稿子]\n${items.map((item) => `- ${item.path}：${item.summary}`).join('\n')}`
}

/** 扫 alice/ 前两级目录，返回要概括的文件夹列表 [{path, names, signature}]。 */
function scanFolders() {
  const result = []
  const visit = (dir, rel, level) => {
    if (level > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const filtered = entries.filter((entry) => !entry.name.startsWith('.') && !SKIP.has(entry.name))
    const names = filtered.map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
    if (level >= 1) result.push({ path: rel, names, signature: names.join('|') })
    for (const entry of filtered) {
      if (entry.isDirectory()) visit(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, level + 1)
    }
  }
  visit(ROOT, '', 0)
  return result
}

/** 用一次 flash 把某个文件夹概括成一句。 */
async function summarizeFolder(llm, character, folder) {
  const config = { ...DEFAULTS, ...(character.aliceIndex ?? {}) }
  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      system: '你是资料整理员。把文件夹概括成一句「这是什么」，像给人看目录标签。',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `文件夹：${folder.path}\n里面：${folder.names.join('、') || '（空）'}\n\n用一句话概括这个文件夹是什么（如「文学创作文件夹」「偏西幻的异世界短篇集」），不超过 25 字，只输出这一句。`,
            },
          ],
        },
      ],
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return ''
  }
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)
}

/** 即刻查看：master 指定看某篇 → 读完把这一篇概括进索引（单篇，不走分级）。 */
export async function summarizeFile(llm, character, index, { path, text }) {
  const config = { ...DEFAULTS, ...(character.aliceIndex ?? {}) }
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length < 10) return false
  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      system: '你是资料整理员。把一篇文章概括成一句「这是什么」，像给人看目录标签。',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `文件：${path}\n内容：${clean.slice(0, 2000)}\n\n用一句话概括这个文件是什么/讲了什么（如「希娅的日记」「偏西幻的异世界短篇」），不超过 25 字，只输出这一句。`,
            },
          ],
        },
      ],
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return false
  }
  const summary = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)
  if (summary.length < 2) return false
  const changed = rememberSummary(index, { path, summary, signature: `file:${clean.slice(0, 80)}` })
  if (changed) saveIndex(index)
  return changed
}

/** 扫两级目录，把每个文件夹概括进索引；目录没变就跳过。返回是否变了。 */
export async function summarizealice(llm, character, index) {
  const folders = scanFolders()
  let changed = false
  for (const folder of folders) {
    const existing = (index.items ?? []).find((item) => item.path === folder.path)
    if (existing && existing.signature === folder.signature) continue // 目录没变，跳过
    const summary = await summarizeFolder(llm, character, folder)
    if (summary && rememberSummary(index, { path: folder.path, summary, signature: folder.signature })) changed = true
  }
  // 删掉已经不在的文件夹
  const alive = new Set(folders.map((folder) => folder.path))
  const before = (index.items ?? []).length
  index.items = (index.items ?? []).filter((item) => alive.has(item.path))
  if (index.items.length !== before) changed = true
  if (changed) saveIndex(index)
  return changed
}
