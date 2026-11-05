// QQ 桥的模块测试：解析、白名单、拆条、签名、出站、限流、宿主路由。
// 不连网、不连 NapCat：fetch 全部用假的。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'

import {
  createRateLimiter, parseEvent, qqConfig, renderSegments, sendInParts, sendPrivate, shouldAccept, splitForQq, verifySignature, QQ_DEFAULTS, trimForQq } from '../lib/qq.js'
import { dispatchInbound, qqStatus, setInboundHandler } from '../lib/qqBus.js'

let pass = 0
let fail = 0
function check(name, value) {
  if (value) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.error(`FAIL ${name}`)
  }
}

const config = { ...QQ_DEFAULTS, enabled: true, allowUsers: ['10001'], allowGroups: ['20002'], selfId: '999' }

// ---- 解析 ----
const privateEvent = {
  post_type: 'message',
  message_type: 'private',
  self_id: 999,
  user_id: 10001,
  message_id: 7,
  message: [
    { type: 'text', data: { text: '在吗' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ],
}
const parsedPrivate = parseEvent(privateEvent)
check('私聊解析出文字', parsedPrivate.text === '在吗[图片]')
check('私聊不是 @', parsedPrivate.atMe === false)
check('私聊 kind', parsedPrivate.kind === 'private')

const groupEvent = {
  post_type: 'message',
  message_type: 'group',
  self_id: 999,
  user_id: 10001,
  group_id: 20002,
  message: [
    { type: 'at', data: { qq: '999' } },
    { type: 'text', data: { text: ' 今天吃什么' } },
  ],
}
const parsedGroup = parseEvent(groupEvent)
check('群聊认出 @ 她', parsedGroup.atMe === true)
check('群聊带群号', parsedGroup.groupId === '20002')

const stringEvent = {
  post_type: 'message',
  message_type: 'private',
  self_id: 999,
  user_id: 10001,
  raw_message: '[CQ:at,qq=999] 早',
  message: '[CQ:at,qq=999] 早',
}
const parsedString = parseEvent(stringEvent)
check('CQ 码字符串也能解析', parsedString.text === '@某人 早')
check('CQ 码里认 @ 她', parsedString.atMe === true)
check('心跳类事件返回 null', parseEvent({ post_type: 'meta_event' }) === null)
check('非消息事件返回 null', parseEvent({ post_type: 'notice' }) === null)

// ---- 白名单 ----
check('关掉就全拒', shouldAccept(parsedPrivate, { ...config, enabled: false }).reason === 'disabled')
check('陌生人私聊被拒', shouldAccept(parsedPrivate, { ...config, allowUsers: ['1'] }).reason === 'not-allowed-user')
check('白名单私聊放行', shouldAccept(parsedPrivate, config).ok === true)
check('没 @ 的群聊被拒', shouldAccept({ ...parsedGroup, atMe: false }, config).reason === 'not-at-me')
check('不在群白名单被拒', shouldAccept(parsedGroup, { ...config, allowGroups: [] }).reason === 'not-allowed-group')
check('白名单群 + @ 放行', shouldAccept(parsedGroup, config).ok === true)
check('空文本被拒', shouldAccept({ ...parsedPrivate, text: '' }, config).reason === 'empty')

// ---- 拆条 ----
check('短句原样', splitForQq('在的', 120).length === 1)
const longText = '今天翻到一条讲白蚁丘的。大象把蚁丘当痒痒挠，蹭塌了以后雨水积进去，小东西们就有了新家。我觉得这事儿挺有意思的。'.repeat(3)
const parts = splitForQq(longText, 40)
check('长句拆成多条', parts.length > 1)
check('每条不超长', parts.every((part) => part.length <= 41))
check('拆完不丢字', parts.join('').replace(/[，。！？\s]/g, '') === longText.replace(/[，。！？\s]/g, ''))

// ---- 签名 ----
check('没配 secret 不校验', verifySignature('', 'body', '') === true)
const sig = 'sha1=' + createHmac('sha1', 's3cret').update('{"a":1}').digest('hex')
check('正确签名通过', verifySignature('s3cret', '{"a":1}', sig) === true)
check('错误签名拒绝', verifySignature('s3cret', '{"a":1}', 'sha1=deadbeef') === false)
check('缺签名拒绝', verifySignature('s3cret', '{"a":1}', '') === false)

// ---- 出站 ----
const calls = []
const fakeFetch = async (url, init) => {
  calls.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}
await sendPrivate(config, '10001', '在的', { fetchImpl: fakeFetch })
check('sendPrivate 打对地址', calls[0].url === 'http://127.0.0.1:3000/send_private_msg')
check('sendPrivate 带 user_id', JSON.parse(calls[0].init.body).user_id === 10001)
check('sendPrivate 用 auto_escape', JSON.parse(calls[0].init.body).auto_escape === true)

const failFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200 }) })
let thrown = ''
try {
  await sendPrivate(config, '10001', '在的', { fetchImpl: failFetch })
} catch (error) {
  thrown = String(error?.message)
}
check('retcode 非 0 抛错', thrown.includes('send_private_msg failed'))

const sent = []
const recordFetch = async (url, init) => {
  sent.push(JSON.parse(init.body).message)
  return { ok: true, status: 200, json: async () => ({ retcode: 0 }) }
}
await sendInParts({ ...config, replyDelayMs: 0, maxChunk: 10 }, { kind: 'private', userId: '10001' }, '一二三四五六七八九十十一十二', { fetchImpl: recordFetch })
check('sendInParts 分条发', sent.length >= 2)

// ---- 限流 ----
let now = 1000
const limiter = createRateLimiter(2, () => now)
check('限流第 1 条放行', limiter.allow() === true)
check('限流第 2 条放行', limiter.allow() === true)
check('限流第 3 条拒绝', limiter.allow() === false)
now += 3_700_000
check('一小时后恢复', limiter.allow() === true)

// ---- 总线 ----
setInboundHandler(async (event) => (event.user_id === 10001 ? { ok: true, reason: 'private' } : { ok: false, reason: 'no' }))
const accepted = await dispatchInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: 'hi' })
check('总线把事件交给 handler', accepted.ok === true)
check('总线记了收到', qqStatus().total > 0)
setInboundHandler(() => {
  throw new Error('boom')
})
const broken = await dispatchInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: 'hi' })
check('handler 抛错不外泄', broken.ok === false && broken.reason === 'error')
setInboundHandler(null)

// ---- 宿主路由（临时改 character.json 的 token，测完还原）----
const CHARACTER = join(import.meta.dirname, '..', 'data', 'character.json')
const original = readFileSync(CHARACTER, 'utf8')
const patched = JSON.parse(original)
patched.qq = { ...patched.qq, enabled: true, token: 't0ken', secret: '', allowUsers: ['10001'] }
writeFileSync(CHARACTER, JSON.stringify(patched, null, 2) + '\n', 'utf8')
try {
  const { apply } = await import('../qq.js')
  const routes = new Map()
  let disposed = 0
  const fakeCtx = {
    webServer: {
      register: (options) => {
        routes.set(options.path, options.handler)
        return () => {
          disposed += 1
        }
      },
      tapIndex: () => () => {},
    },
    effect: (fn) => {
      fn()
    },
  }
  apply(fakeCtx)
  check('注册了入站路由', typeof routes.get('/dsh-character/qq/event') === 'function')
  check('注册了状态路由', typeof routes.get('/dsh-character/qq/status') === 'function')

  const invoke = async (path, { body = '', headers = {}, socket = undefined } = {}) => {
    const listeners = {}
    const req = {
      url: path,
      headers,
      socket,
      on: (name, fn) => {
        listeners[name] = fn
      },
      destroy: () => {},
    }
    const done = new Promise((resolve) => {
      const res = {
        status: 0,
        payload: '',
        writeHead: (status) => {
          res.status = status
        },
        end: (value) => {
          res.payload = value ?? ''
          resolve(res)
        },
      }
      routes.get(path)(req, res)
    })
    if (body) {
      listeners.data?.(Buffer.from(body))
      listeners.end?.()
    }
    return done
  }

  // 本机回环来的请求不再要求 token（路由只绑 127.0.0.1，门是 allowUsers）；
  // 只有非回环来源才校验 token。
  const noAuth = await invoke('/dsh-character/qq/event', { body: JSON.stringify(privateEvent) })
  check('本机没带 token 也放行', noAuth.status === 200)
  const remoteNoAuth = await invoke('/dsh-character/qq/event', {
    body: JSON.stringify(privateEvent),
    socket: { remoteAddress: '10.1.2.3' },
  })
  check('非回环没带 token 被拒 401', remoteNoAuth.status === 401)
  const withAuth = await invoke('/dsh-character/qq/event', {
    body: JSON.stringify(privateEvent),
    headers: { authorization: 'Bearer t0ken' },
  })
  check('带 token 通过（没注册 handler 时回 no-handler）', withAuth.status === 200 && JSON.parse(withAuth.payload).reason === 'no-handler')
  const heartbeat = await invoke('/dsh-character/qq/event', {
    body: JSON.stringify({ post_type: 'meta_event' }),
    headers: { authorization: 'Bearer t0ken' },
  })
  check('出站修剪：前导空行去掉', trimForQq('\n\n  晚上好，你来啦。\n\n') === '晚上好，你来啦。')
check('出站修剪：纯空白变空串', trimForQq(' \n\u3000 ').length === 0)
check('心跳回 204', heartbeat.status === 204)
  const status = await invoke('/dsh-character/qq/status')
  const statusBody = JSON.parse(status.payload)
  check('状态里有 enabled/selfId', statusBody.enabled === true && typeof statusBody.selfId === 'string')
  check('状态里没泄露 token', !('token' in statusBody))
} finally {
  writeFileSync(CHARACTER, original, 'utf8')
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) process.exitCode = 1
