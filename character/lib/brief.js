// 每日简报：每天第一次开口，先让她知道「昨天到今天」自己这边发生了什么。
// 不是给她编一段故事，而是把已有的东西（日记、见闻、记忆、关系）整理成三行提示，
// 让她有东西可说——否则「晚上好」之后只能靠记忆里那两句旧事拼。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR, stateSummary } from './state.js'
import { renderProfile } from './profile.js'

const BRIEF_FILE = join(DATA_DIR, 'brief.json')

export const BRIEF_SENTINEL = '[今天第一次说话]'

// 隔了不到这么久就又开口，不算「新的一天」——避免半夜跨零点时突然来一段总结。
const MIN_IDLE_MS = 45 * 60_000

export function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function loadBrief() {
  const fresh = { lastDate: '', lastText: '', lastAt: '', lastActiveAt: '' }
  try {
    if (!existsSync(BRIEF_FILE)) return fresh
    const stored = JSON.parse(readFileSync(BRIEF_FILE, 'utf8'))
    return { ...fresh, ...(stored && typeof stored === 'object' ? stored : {}) }
  } catch {
    return fresh
  }
}

export function saveBrief(brief) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(BRIEF_FILE, `${JSON.stringify(brief, null, 2)}\n`, 'utf8')
}

/**
 * 距上一次说话过了多久。用 brief.json 自己记的 lastActiveAt，而不是
 * state.updatedAt——后者在 loadState/decay 时会被刷新成「现在」，
 * 拿它算永远是零（这就让简报一直不触发）。
 */
export function idleMsSince(brief, now = Date.now()) {
  const at = Date.parse(brief?.lastActiveAt ?? '')
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return Math.max(0, now - at)
}

/** 这一轮说过话：记下活动时间，简报的「隔了多久」靠它算。 */
export function touchActivity(brief, now = Date.now()) {
  brief.lastActiveAt = new Date(now).toISOString()
  return brief
}

/** 这一轮该不该给简报：今天是第一次跟她说话，而且中间真的断过一阵。 */
export function shouldBrief(brief, { kind, idleMs, now = Date.now() }) {
  if (kind !== 'chat') return false
  if (brief.lastDate === dayKey(now)) return false
  if (Number(idleMs) < MIN_IDLE_MS) return false
  return true
}

const feedLine = (items) =>
  items
    .slice(0, 3)
    .map((item, i) => `${i + 1}) ${item.topic}${item.take ? `（${item.take}）` : ''}`)
    .join('；')

/**
 * 拼简报：只从她自己的数据里取，不调用模型。
 * 返回空串表示没什么好说的（那就别给，别硬凑）。
 */
export function composeBrief({ diary, feed, profile, memory, state, now = Date.now() }) {
  const lines = []
  const yesterday = dayKey(now - 86_400_000)

  const diaryLine = (diary?.lines ?? []).filter((line) => line?.text).slice(-1)[0]
  if (diaryLine) lines.push(`昨天你留给自己的日记：${diaryLine.date === yesterday ? '' : `${diaryLine.date} `}${diaryLine.text}`)

  const days = feed?.days ?? {}
  const yItems = days[yesterday] ?? []
  const todayItems = days[dayKey(now)] ?? []
  const items = yItems.length ? yItems : todayItems
  if (items.length) lines.push(`你${yItems.length ? '昨天' : '今天'}在关注的：${feedLine(items)}`)

  // 长期槽位优先；旧记忆库只在还没有槽位时兜底（记忆 3.0 之后它不再增长）。
  const slotLines = renderProfile(profile ?? {})
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^-\s*/, ''))
    .filter(Boolean)
  const facts = (memory ?? []).filter((entry) => entry.status === 'active').slice(0, 2)
  if (slotLines.length) lines.push(`你记得的：${slotLines.join('；')}`)
  else if (facts.length) lines.push(`你还记得的：${facts.map((entry) => entry.text).join('；')}`)

  if (!lines.length) return ''
  lines.push(
    `你们现在：${state ? stateSummary(state) : '刚认识'}`,
    '这一轮是今天第一次跟他说话：先用一两句说说你这边昨天到今天的事（挑一件就行，不用全讲），再接他这句。',
  )
  return [BRIEF_SENTINEL, ...lines].join('\n')
}
