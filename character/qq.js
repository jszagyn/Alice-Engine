// QQ 桥（宿主作用域，OneBot11 / NapCat，HTTP 模式）。
//
//   POST /dsh-character/qq/event   ← NapCat 的「HTTP 上报」把事件推到这里
//   GET  /dsh-character/qq/status  → 最近有没有收到、收了几条、有没有人处理
//
// 入站在这里收，交给引擎（lib/qqBus.js 的 handler）；出站在引擎里直接调
// NapCat 的 HTTP API（lib/qq.js 的 sendPrivate/sendInParts）。
// 安全：本地回环 + 白名单；配了 secret 就校验 X-Signature，配了 token 就校验 Bearer。

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatchInbound, qqStatus } from './lib/qqBus.js'
import { qqConfig, verifySignature } from './lib/qq.js'

export const name = 'character-qq'
export const inject = ['webServer']

const ROOT = dirname(fileURLToPath(import.meta.url))
const EVENT_PATH = '/dsh-character/qq/event'
const STATUS_PATH = '/dsh-character/qq/status'
const MAX_BODY = 1024 * 1024

function loadConfig() {
  try {
    const character = JSON.parse(readFileSync(join(ROOT, 'data', 'character.json'), 'utf8'))
    return qqConfig(character)
  } catch {
    return qqConfig(null)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: EVENT_PATH,
      handler: async (req, res) => {
        const config = loadConfig()
        const body = await readBody(req).catch(() => '')
        // 空体 / 非 JSON 一律回 204：NapCat 的心跳、输入状态等通知事件
        // 有时就是空的，回 4xx 会被它当成「投递失败」反复重试、把日志刷满。
        if (!body) {
          res.writeHead(204)
          res.end()
          return
        }
        // 鉴权：NapCat 配了 secret 会带 X-Signature；没配就只靠回环地址。
        const signature = req.headers['x-signature']
        if (config.secret && !verifySignature(config.secret, body, signature)) {
          sendJson(res, 401, { ok: false, reason: 'bad-signature' })
          return
        }
        if (config.token) {
          const rawAuth = String(req.headers.authorization ?? '').trim()
          // 本机回环来的请求直接放行：这个路由只绑 127.0.0.1，真正的门是
          // allowUsers 白名单；NapCat 各版本的头格式（Bearer / token / 裸值）
          // 不一样，拿它当安全边界只会换来一堆 401。
          const remote = String(req.socket?.remoteAddress ?? '')
          const loopback = !remote || /^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/.test(remote)
          if (!loopback && !rawAuth.includes(config.token)) {
            appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'roam-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), result: 'qq-bad-token', auth: rawAuth.slice(0, 40), remote }) + '\n', 'utf8')
            sendJson(res, 401, { ok: false, reason: 'bad-token' })
            return
          }
        }
        let event = null
        try {
          event = JSON.parse(body)
        } catch {
          appendFileSync(join(ROOT, 'data', 'roam-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), result: 'qq-bad-json', bytes: body.length }) + '\n', 'utf8')
          res.writeHead(204)
          res.end()
          return
        }
        // NapCat 的心跳/元事件很多，直接回 204，不进她那边。
        if (event?.post_type !== 'message') {
          res.writeHead(204)
          res.end()
          return
        }
        const result = await dispatchInbound(event)
        sendJson(res, 200, { ok: Boolean(result?.ok), reason: result?.reason ?? '' })
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        const config = loadConfig()
        sendJson(res, 200, {
          ...qqStatus(),
          enabled: Boolean(config.enabled),
          selfId: config.selfId || '',
          allowUsers: config.allowUsers?.length ?? 0,
          allowGroups: config.allowGroups?.length ?? 0,
          apiBase: config.apiBase,
        })
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载失败不影响宿主关闭。
      }
    }
  })
}
