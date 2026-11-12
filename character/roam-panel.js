// 漫游开关（宿主作用域）：右下角「漫」按钮，开关她的漫游。
//
//   GET  /dsh-character/roam/state    → { toggle, cost, budget }
//   POST /dsh-character/roam/toggle   → body {on:true/false}，或空（翻转）；返回 { toggle, cost, budget }
//   GET  /dsh-character/roam-client.js → 浏览器脚本
//   index.html 里注入 <script defer src="/dsh-character/roam-client.js">

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { loadRoam, toggleRoam } from './lib/roam.js'

export const name = 'character-roam-panel'
export const inject = ['webServer']

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = '/dsh-character/roam-client.js'
const BUDGET = 5

function readClient() {
  return readFileSync(join(ROOT, 'assets', 'roam-client.js'), 'utf8')
}

function stateOf(roam) {
  return { toggle: Boolean(roam.toggle), cost: roam.cost ?? 0, budget: BUDGET }
}

function json(res, value) {
  const body = JSON.stringify(value)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-character/roam/state',
      handler: (req, res) => json(res, stateOf(loadRoam())),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-character/roam/toggle',
      handler: (req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
        })
        req.on('end', () => {
          let on
          try {
            const parsed = JSON.parse(raw || '{}')
            on = typeof parsed.on === 'boolean' ? parsed.on : !loadRoam().toggle
          } catch {
            on = !loadRoam().toggle
          }
          const roam = loadRoam()
          toggleRoam(roam, on)
          json(res, stateOf(roam))
        })
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
