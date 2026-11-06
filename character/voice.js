// 声音桥（宿主作用域）：把她的回复喂给浏览器端的朗读脚本。
//
//   GET /dsh-character/voice/pending?since=<id>  → { now, items:[{id,kind,text,at}] }
//   GET /dsh-character/voice-client.js           → 浏览器脚本
//   index.html 里注入 <script defer src="/dsh-character/voice-client.js">
//
// 浏览器脚本用系统自带的 speechSynthesis 念，不联网、不花钱；
// 右下角的小圆点是开关（关掉后不再念，状态记在 localStorage）。

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { pendingSince, getAudio } from './lib/voiceBus.js'

export const name = 'character-voice'
export const inject = ['webServer']

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = '/dsh-character/voice-client.js'

function readClient() {
  return readFileSync(join(ROOT, 'assets', 'voice-client.js'), 'utf8')
}

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-character/voice/pending',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const since = Number(url.searchParams.get('since') ?? 0)
        const body = JSON.stringify(pendingSince(Number.isFinite(since) ? since : 0))
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(body)
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-character/voice/audio',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = Number(url.searchParams.get('id') ?? 0)
        const audio = getAudio(Number.isFinite(id) ? id : 0)
        if (!audio) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': audio.length,
          'Cache-Control': 'no-store',
        })
        res.end(audio)
      },
    }),
  )

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
