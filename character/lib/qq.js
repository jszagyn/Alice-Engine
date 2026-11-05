import { createHmac, timingSafeEqual } from 'node:crypto'

// QQ 桥（OneBot11 / NapCat，HTTP 模式）：
// 入站 = NapCat 把事件 POST 到 DSH 的路由；出站 = 我们反过来调 NapCat 的 HTTP API。
// 不走 WebSocket：少一个常驻连接，出问题好查，DSH 这边也不用新依赖。

export const QQ_DEFAULTS = {
  enabled: false,
  apiBase: 'http://127.0.0.1:3000',
  token: '',
  secret: '',
  selfId: '',
  allowUsers: [], // 只回这些 QQ 号；空数组 = 谁都不回
  allowGroups: [], // 群里只接 @ 她的；空数组 = 群聊全不理
  replyDelayMs: 1500,
  maxChunk: 120,
  maxPerHour: 40,
}

export function qqConfig(character) {
  return { ...QQ_DEFAULTS, ...(character?.qq ?? {}) }
}

const asList = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : [])

/** 把 OneBot 的 message 段（数组）或 CQ 码（字符串）压成一句人话。 */
export function renderSegments(message) {
  const parts = []
  if (Array.isArray(message)) {
    for (const segment of message) {
      const type = segment?.type
      const data = segment?.data ?? {}
      if (type === 'text') parts.push(String(data.text ?? ''))
      else if (type === 'at') parts.push(data.qq === 'all' ? '@全体' : '@某人')
      else if (type === 'image') parts.push('[图片]')
      else if (type === 'face') parts.push('[表情]')
      else if (type === 'record') parts.push('[语音]')
      else if (type === 'reply') continue
      else parts.push(`[${type}]`)
    }
    return parts.join('').trim()
  }
  // 字符串格式：去掉 CQ 码，保留文字。
  const text = String(message ?? '')
    .replace(/\[CQ:at,qq=(\d+)\]/g, '@某人')
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:[^\]]*\]/g, '')
  return text.trim()
}

/**
 * 解析一条 OneBot11 事件。
 * 只认 message（私聊/群聊），其他（心跳、通知）返回 null，由调用方忽略。
 */
export function parseEvent(event) {
  if (!event || event.post_type !== 'message') return null
  const type = event.message_type
  if (type !== 'private' && type !== 'group') return null
  const selfId = String(event.self_id ?? '')
  const userId = String(event.user_id ?? '')
  if (!userId) return null
  const segments = Array.isArray(event.message) ? event.message : null
  const atMe = segments
    ? segments.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === selfId)
    : new RegExp(`\\[CQ:at,qq=${selfId}\\]`).test(String(event.raw_message ?? event.message ?? ''))
  const text = renderSegments(event.message ?? event.raw_message ?? '')
  return {
    kind: type,
    selfId,
    userId,
    groupId: type === 'group' ? String(event.group_id ?? '') : '',
    messageId: String(event.message_id ?? ''),
    text,
    atMe,
  }
}

/** 白名单 + @ 判定。返回 {ok, reason}，reason 只用于日志。 */
export function shouldAccept(parsed, config) {
  if (!config.enabled) return { ok: false, reason: 'disabled' }
  if (!parsed || !parsed.text) return { ok: false, reason: 'empty' }
  const users = asList(config.allowUsers)
  const groups = asList(config.allowGroups)
  if (parsed.kind === 'private') {
    if (!users.includes(parsed.userId)) return { ok: false, reason: 'not-allowed-user' }
    return { ok: true, reason: 'private' }
  }
  if (!groups.includes(parsed.groupId)) return { ok: false, reason: 'not-allowed-group' }
  if (!parsed.atMe) return { ok: false, reason: 'not-at-me' }
  return { ok: true, reason: 'group-at' }
}

/** 长回复拆成几条发：按句末/逗号切，单条不超过 maxChunk。 */
export function trimForQq(text) {
  return String(text ?? '').replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '')
}

export function splitForQq(text, maxChunk = 120) {
  const clean = String(text ?? '').replace(/\*\*|^#+\s*/gm, '').trim()
  if (!clean) return []
  if (clean.length <= maxChunk) return [clean]
  const parts = []
  let rest = clean
  while (rest.length > maxChunk) {
    const window = rest.slice(0, maxChunk)
    let cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('\n'))
    if (cut < maxChunk * 0.4) cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('；'))
    if (cut < maxChunk * 0.4) cut = maxChunk
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

async function callApi(config, action, payload, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = String(config.apiBase ?? '').replace(/\/+$/, '')
  if (!base) throw new Error('qq apiBase 没配')
  const response = await fetchImpl(`${base}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const value = await response.json().catch(() => null)
  const retcode = value?.retcode ?? value?.data?.retcode
  if (!response.ok || (retcode !== undefined && retcode !== 0)) {
    throw new Error(`qq ${action} failed: ${response.status} ${JSON.stringify(value).slice(0, 200)}`)
  }
  return value
}

export function sendPrivate(config, userId, text, deps) {
  return callApi(config, 'send_private_msg', { user_id: Number(userId), message: text, auto_escape: true }, deps)
}

export function sendGroup(config, groupId, text, deps) {
  return callApi(config, 'send_group_msg', { group_id: Number(groupId), message: text, auto_escape: true }, deps)
}

/** 按段发，中间留间隔（像人打字，不像机器轰炸）。 */
export async function sendInParts(config, target, text, deps = {}) {
  const parts = splitForQq(text, config.maxChunk ?? QQ_DEFAULTS.maxChunk)
  const sent = []
  for (const part of parts) {
    try {
      if (target.kind === 'group') await sendGroup(config, target.groupId, part, deps)
      else await sendPrivate(config, target.userId, part, deps)
      sent.push(part)
    } catch (error) {
      if (!sent.length) throw error
      break
    }
    if (config.replyDelayMs) await new Promise((resolve) => setTimeout(resolve, config.replyDelayMs))
  }
  return sent
}

/**
 * NapCat 的 HTTP 上报签名：配置了 secret 时，它发 X-Signature: sha1=<hmac-sha1-hex>。
 * 没配 secret 就不校验（本地回环场景）。
 */
export function verifySignature(secret, body, header) {
  if (!secret) return true
  const given = String(header ?? '').trim().replace(/^sha1=/, '').toLowerCase()
  if (!given) return false
  const expected = createHmac('sha1', secret).update(body).digest('hex')
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 简单的每小时限流：给 inbound 用，避免她被刷屏或自己刷屏。 */
export function createRateLimiter(maxPerHour = 40, now = Date.now) {
  const stamps = []
  return {
    allow() {
      const cutoff = now() - 3_600_000
      while (stamps.length && stamps[0] < cutoff) stamps.shift()
      if (stamps.length >= maxPerHour) return false
      stamps.push(now())
      return true
    },
    count: () => stamps.length,
  }
}
