// 记忆面板（宿主作用域）：在网页里看她的记忆，确认、删掉、补一条。
//
//   GET  /dsh-character/memory            → { items, stats, slots }
//   POST /dsh-character/memory/confirm    → { id, confirmed }
//   POST /dsh-character/memory/delete     → { id }
//   POST /dsh-character/memory/add        → { text, tier? }
//   POST /dsh-character/memory/slot       → { key, value }（改长期槽位，当纠正用）
//   GET  /dsh-character/panel-client.js   → 浏览器脚本
//
// 写盘走 lib/memory.js 的同一套函数；引擎在 pre-step 用 memoryFileStamp()
// 发现文件变了会重新加载，所以面板改完下一轮她就知道（不用重启）。

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import {
  addManualMemory,
  loadMemory,
  markDeleted,
  saveMemory,
  setConfirmed,
} from './lib/memory.js'
import { PROFILE_SLOTS, correctSlot, loadProfile, saveProfile, sourceRank } from './lib/profile.js'
import { logMemory } from './lib/memoryLog.js'

export const name = 'character-panel'
export const inject = ['webServer']

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = '/dsh-character/panel-client.js'
const API = '/dsh-character/memory'
const BODY_LIMIT = 16 * 1024

function readClient() {
  return readFileSync(join(ROOT, 'assets', 'panel-client.js'), 'utf8')
}

const SOURCE_TEXT = { master: '他说的', self: '她自己记的', inferred: '归纳的' }

function slotList(profile) {
  const order = new Map(PROFILE_SLOTS.map((slot) => [slot.key, slot.priority]))
  return Object.entries(profile.slots ?? {})
    .sort((a, b) => (order.get(b[0]) ?? 0) - (order.get(a[0]) ?? 0))
    .map(([key, slot]) => {
      const def = PROFILE_SLOTS.find((candidate) => candidate.key === key)
      return {
        key,
        label: slot.label ?? def?.label ?? key,
        value: def?.list ? (slot.values ?? [slot.value]).join('、') : slot.value,
        source: slot.source ?? 'self',
        sourceText: SOURCE_TEXT[slot.source] ?? '她自己记的',
        days: slot.days ?? 0,
        mentions: slot.mentions ?? 1,
        lastAt: slot.lastAt ?? '',
        superseded: (slot.superseded ?? []).map((item) => String(item.value)),
      }
    })
}

function summary(entries, profile = loadProfile()) {
  const items = entries
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      tier: entry.tier === 'event' ? 'event' : 'fact',
      kind: entry.kind ?? entry.tier ?? 'fact',
      confirmed: Boolean(entry.confirmed),
      status: entry.status ?? 'active',
      at: entry.at ?? '',
      strength: Math.round((entry.strength ?? 1) * 10) / 10,
      salience: Math.round((entry.salience ?? 0) * 10) / 10,
    }))
    .filter((item) => item.status !== 'deleted')
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))

  return {
    items,
    slots: slotList(profile),
    stats: {
      total: items.length,
      fact: items.filter((item) => item.tier === 'fact').length,
      event: items.filter((item) => item.tier === 'event').length,
      confirmed: items.filter((item) => item.confirmed).length,
      auto: items.filter((item) => !item.confirmed).length,
      superseded: items.filter((item) => item.status === 'superseded').length,
      dormant: items.filter((item) => item.status === 'dormant').length,
    },
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const ACTIONS = {
  confirm: (body) => {
    const entries = loadMemory()
    const entry = setConfirmed(entries, String(body.id ?? ''), body.confirmed !== false)
    if (!entry) throw new Error('没有这条记忆')
    saveMemory(entries)
    return summary(entries)
  },
  delete: (body) => {
    const entries = loadMemory()
    const entry = markDeleted(entries, String(body.id ?? ''))
    if (!entry) throw new Error('没有这条记忆')
    saveMemory(entries)
    return summary(entries)
  },
  add: (body) => {
    const entries = loadMemory()
    const entry = addManualMemory(entries, body.text, { tier: body.tier })
    if (!entry) throw new Error('这句话太短，或者没东西可记')
    saveMemory(entries)
    return summary(entries)
  },
  slot: (body) => {
    const key = String(body.key ?? '')
    const value = String(body.value ?? '').trim().slice(0, 40)
    if (!PROFILE_SLOTS.some((slot) => slot.key === key)) throw new Error('没有这个槽位')
    if (!value) throw new Error('值不能是空的')
    const profile = loadProfile()
    const result = correctSlot(profile, { key, value, note: '面板里改的' })
    if (!result) throw new Error('没改成功')
    saveProfile(profile)
    logMemory({ action: 'correct', ...result, note: '面板里改的' })
    return summary(loadMemory(), profile)
  },
}

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: API,
      handler: (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'method' })
          sendJson(res, 200, summary(loadMemory()))
        } catch (error) {
          sendJson(res, 500, { error: String(error?.message ?? error).slice(0, 200) })
        }
      },
    }),
  )

  for (const [action, run] of Object.entries(ACTIONS)) {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/${action}`,
        handler: async (req, res) => {
          try {
            if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendJson(res, 405, { error: 'method' })
            const body = await readJson(req)
            sendJson(res, 200, run(body))
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error).slice(0, 200) })
          }
        },
      }),
    )
  }

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: CLIENT_PATH,
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(readClient())
      },
    }),
  )

  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (html.includes(CLIENT_PATH)) return html
      const tag = `<script defer src="${CLIENT_PATH}"></script>`
      return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Disposal must never break host shutdown.
      }
    }
  })
}
