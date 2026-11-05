// 宿主路由（NapCat → 我们）与引擎（我们 → 她）之间的传话处。
// 职责只做登记与计数：谁收到事件、有没有人处理、最近一次错误是什么。
let handler = null
const state = { lastEventAt: '', total: 0, accepted: 0, rejected: 0, lastError: '', lastReason: '' }

export function setInboundHandler(fn) {
  handler = typeof fn === 'function' ? fn : null
}

export function hasInboundHandler() {
  return Boolean(handler)
}

export function qqStatus() {
  return { ...state, hasHandler: Boolean(handler) }
}

export async function dispatchInbound(event) {
  state.total += 1
  state.lastEventAt = new Date().toISOString()
  if (!handler) {
    state.rejected += 1
    state.lastReason = 'no-handler'
    return { ok: false, reason: 'no-handler' }
  }
  try {
    const result = (await handler(event)) ?? { ok: false, reason: 'no-result' }
    if (result.ok) state.accepted += 1
    else {
      state.rejected += 1
      state.lastReason = String(result.reason ?? 'rejected')
    }
    return result
  } catch (error) {
    state.rejected += 1
    state.lastError = String(error?.message ?? error).slice(0, 200)
    state.lastReason = 'error'
    return { ok: false, reason: 'error' }
  }
}
