// 声音桥的公共总线：主进程里的单例队列。
//
// 为什么需要它：角色内核挂在 agent preset 作用域里（每轮回复只有那里知道），
// 而 HTTP 路由只能挂在宿主作用域的 webServer 上。两边是同一个进程、同一个模块实例，
// 所以用一个模块级数组把「她刚说的话」接力过去，不必引入跨作用域服务。

const MAX_ITEMS = 200
const MAX_AGE_MS = 60 * 60_000

let seq = 0
/** @type {{ id: number, at: number, kind: string, text: string, audio: boolean }[]} */
const queue = []
/** @type {Map<number, Buffer>} 合成音频（id → wav 字节） */
const audioStore = new Map()

/** 去掉不该念出来的东西：代码块、行内代码、链接地址、markdown 记号。 */
export function speakable(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function pushVoice(text, kind = 'chat', audio = null) {
  const clean = speakable(text)
  if (clean.length < 2) return null
  seq += 1
  const item = { id: seq, at: Date.now(), kind, text: clean.slice(0, 600), audio: Boolean(audio) }
  if (audio) audioStore.set(seq, audio)
  queue.push(item)
  const cutoff = Date.now() - MAX_AGE_MS
  while (queue.length > MAX_ITEMS || (queue[0] && queue[0].at < cutoff)) {
    const dropped = queue.shift()
    if (dropped?.audio) audioStore.delete(dropped.id)
  }
  return item
}

/** 取一条的合成音频（Buffer），没有就返回 null。 */
export function getAudio(id) {
  return audioStore.get(id) ?? null
}

/** 浏览器端轮询：只要比 since 新的。 */
export function pendingSince(since = 0) {
  const from = Number.isFinite(since) ? since : 0
  const cutoff = Date.now() - MAX_AGE_MS
  return {
    now: seq,
    items: queue.filter((item) => item.id > from && item.at >= cutoff),
  }
}

/** 测试用：清空。 */
export function resetVoiceQueue() {
  queue.length = 0
  seq = 0
}
