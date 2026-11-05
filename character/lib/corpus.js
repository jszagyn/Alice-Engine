import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// 语料吸收 v1：从真人的评论里学「语感」和「口语词」，严格控量。
// 梗是调味料不是主食：新词先进观察池，反复出现（不同次抓取）才转在用，
// 用错被 critic 抓到两次就退役；一轮最多带一个词，冷却 6 小时。
const CORPUS_FILE = join(DATA_DIR, 'corpus.json')
const TMP_FILE = join(DATA_DIR, '.corpus.tmp.json')
const CORPUS_LOG = join(DATA_DIR, 'corpus.jsonl')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }

export const MAX_WORDS_ACTIVE = 12
export const MAX_ANCHORS = 20
export const COOLDOWN_HOURS = 6

// 太常见的词学不到东西，还容易让句子变得没信息量。
const STOP_TERMS = new Set(['这个', '那个', '什么', '怎么', '为什么', '就是', '但是', '然后', '所以', '因为', '可以', '没有', '一个', '我们', '你们', '他们', '自己', '现在', '时候', '觉得', '知道', '真的', '不是', '还是', '已经', '应该', '可能', '一直', '有点', '其实', '反正', '而且', '不过'])

const empty = () => ({ words: {}, anchors: [], stats: { extracted: 0, accepted: 0, lastExtractAt: '' }, updatedAt: '' })

export function loadCorpus() {
  try {
    if (existsSync(CORPUS_FILE)) {
      const value = JSON.parse(readFileSync(CORPUS_FILE, 'utf8'))
      if (value && value.words && typeof value.words === 'object') {
        value.anchors ??= []
        value.stats ??= { extracted: 0, accepted: 0, lastExtractAt: '' }
        return value
      }
    }
  } catch {
    // 坏了就空着重来。
  }
  return empty()
}

export function saveCorpus(corpus) {
  mkdirSync(DATA_DIR, { recursive: true })
  corpus.updatedAt = new Date().toISOString()
  writeFileSync(TMP_FILE, JSON.stringify(corpus, null, 2), 'utf8')
  renameSync(TMP_FILE, CORPUS_FILE)
}

export function corpusStamp() {
  try {
    return statSync(CORPUS_FILE).mtimeMs
  } catch {
    return 0
  }
}

export function logCorpus(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(CORPUS_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    // 日志失败不影响对话。
  }
}

/** 只收纯中文的 2–8 字词：英文、数字、书名号、专有名词一律不进。 */
export function normalizeTerm(raw) {
  const term = String(raw ?? '').trim().replace(/^[「『"']+|[」』"']+$/g, '')
  if (!/^[\u4e00-\u9fa5]{2,8}$/.test(term)) return ''
  if (STOP_TERMS.has(term)) return ''
  return term
}

/** 新词进观察池；同一个词再次被抓到就 hits+1（hits ≥ 2 转在用）。 */
export function addCandidate(corpus, { term, meaning = '', when = '', source = 'bilibili-reply', now = Date.now() }) {
  const word = normalizeTerm(term)
  if (!word) return null
  const at = new Date(now).toISOString()
  const current = corpus.words[word]
  if (current) {
    current.hits = (current.hits ?? 1) + 1
    if (!current.meaning && meaning) current.meaning = String(meaning).slice(0, 40)
    if (!current.when && when) current.when = String(when).slice(0, 30)
    if (current.tier === 'watch' && current.hits >= 2) current.tier = 'active'
    return current
  }
  const active = Object.values(corpus.words).filter((item) => item.tier === 'active').length
  corpus.words[word] = {
    term: word,
    tier: active < MAX_WORDS_ACTIVE ? 'watch' : 'retired',
    hits: 1,
    uses: 0,
    flags: 0,
    meaning: String(meaning ?? '').slice(0, 40),
    when: String(when ?? '').slice(0, 30),
    source,
    addedAt: at,
    lastUsedAt: '',
  }
  return corpus.words[word]
}

/** 当前能用的词：在用、冷却够了、最近两轮没说过、没被反复判错。 */
export function selectWords(corpus, { now = Date.now(), recentTerms = [], limit = 1 } = {}) {
  const cooldownMs = COOLDOWN_HOURS * 3600_000
  const usable = Object.values(corpus.words ?? {}).filter((word) => {
    if (word.tier !== 'active') return false
    if ((word.flags ?? 0) >= 2) return false
    if (recentTerms.includes(word.term)) return false
    if (word.lastUsedAt && now - Date.parse(word.lastUsedAt) < cooldownMs) return false
    return true
  })
  // 用得少的优先，避免同一个词反复登场。
  return usable
    .sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0) || String(a.addedAt).localeCompare(String(b.addedAt)))
    .slice(0, limit)
}

export function markWordsUsed(corpus, terms, now = Date.now()) {
  const at = new Date(now).toISOString()
  let touched = false
  for (const term of terms ?? []) {
    const word = corpus.words?.[term]
    if (!word) continue
    word.uses = (word.uses ?? 0) + 1
    word.lastUsedAt = at
    touched = true
  }
  return touched
}

/** 被 critic 判「语料腔」：记一次，两次就退役。 */
export function penalizeWords(corpus, terms, now = Date.now()) {
  let touched = false
  for (const term of terms ?? []) {
    const word = corpus.words?.[term]
    if (!word) continue
    word.flags = (word.flags ?? 0) + 1
    word.lastUsedAt = new Date(now).toISOString()
    if (word.flags >= 2) word.tier = 'retired'
    touched = true
  }
  return touched
}

const isoWeek = (now) => {
  const date = new Date(now)
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const day = Math.floor((date - start) / 86400000)
  return `${date.getUTCFullYear()}-W${String(Math.floor(day / 7) + 1).padStart(2, '0')}`
}

export function addAnchor(corpus, pattern, now = Date.now()) {
  const text = String(pattern ?? '').trim()
  if (!/^[\u4e00-\u9fa5，。！？、…~～]{2,16}$/.test(text)) return null
  if ((corpus.anchors ?? []).some((anchor) => anchor.pattern === text)) return null
  const anchor = { pattern: text, week: '', addedAt: new Date(now).toISOString() }
  corpus.anchors = [...(corpus.anchors ?? []), anchor].slice(-MAX_ANCHORS)
  return anchor
}

/** 每周锚点：同一周固定一个，下周换，避免她固化。 */
export function pickAnchor(corpus, now = Date.now()) {
  const anchors = corpus.anchors ?? []
  if (!anchors.length) return null
  const week = isoWeek(now)
  const current = anchors.find((anchor) => anchor.week === week)
  if (current) return current
  const fresh = anchors.filter((anchor) => anchor.week !== week).sort((a, b) => String(a.week).localeCompare(String(b.week)))[0]
  if (!fresh) return null
  fresh.week = week
  return fresh
}

export function renderCorpusHint({ words = [], anchor = null } = {}) {
  const terms = words.map((word) => word.term).filter(Boolean)
  if (!terms.length && !anchor) return ''
  const lines = []
  if (terms.length) {
    const detail = words
      .map((word) => (word.when ? `${word.term}（${word.when}）` : word.term))
      .join('、')
    lines.push(`最近真人是这么说的：${detail}`)
  }
  if (anchor) lines.push(`一种语气，可以顺着用：${anchor.pattern}`)
  lines.push('能用就用，一轮最多带一个，别硬塞；正常说话永远是第一位的。')
  return `[说话用词]\n${lines.join('\n')}`
}

/** 抓几条真人评论：热门视频 → 热门评论（不需要 key）。 */
export async function fetchComments(candidates, { maxVideos = 2, perVideo = 8, timeoutMs = 8000 } = {}) {
  const picked = (candidates ?? []).filter((item) => item?.bvid).slice(0, maxVideos)
  const comments = []
  for (const item of picked) {
    try {
      const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`, timeoutMs)
      const aid = view?.data?.aid
      if (!aid) continue
      const reply = await fetchJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${perVideo}&pn=1`, timeoutMs)
      for (const entry of reply?.data?.replies ?? []) {
        const message = String(entry?.content?.message ?? '')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/@\S+/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        if (message.length < 4 || message.length > 80) continue
        if (/^\d+$/.test(message)) continue
        if (comments.includes(message)) continue
        comments.push(message)
        if (comments.length >= perVideo * maxVideos) break
      }
    } catch {
      // 单个视频失败就跳过，语料是锦上添花。
    }
  }
  return comments.slice(0, 20)
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  const data = await response.json().catch(() => null)
  if (data?.code && data.code !== 0) throw new Error(`bilibili ${data.code}`)
  return data?.data ? data : data
}

const EXTRACT_SYSTEM = `你在给一个固定人格收集「说话的样子」，不是收集内容。

只挑**口头语感**：语气词、口语起头、重复强调、半截话、把话说得很短的节奏。
不收：专有名词（人名、作品名、地名、队伍名、比赛名）、数字、英文、脏话、政治、广告、括号注释、成句的评论原话。

输出 JSON：
{"words":[{"term":"2–6 个字的纯中文口语词","meaning":"一句话解释","when":"什么时候能说"}],
 "anchors":["≤12 个字的语气样板，比如「这什么玩意啊」，只存语气不存内容"]}

最多 3 个词、2 个锚点；宁可少给。一个词都挑不出来就输出 {"words":[],"anchors":[]}。`

/** 一次小调用从评论里抽词和语气锚点。 */
export async function extractCandidates(llm, character, comments, { signal = null } = {}) {
  if (!llm || !comments?.length) return { words: [], anchors: [] }
  const config = character?.corpus ?? {}
  const material = comments.map((text, index) => `${index + 1}. ${text}`).join('\n')
  let raw = ''
  try {
    const stream = llm.stream({
      provider: config.provider ?? character?.planner?.provider ?? 'deepseek-official',
      model: config.model ?? character?.planner?.model ?? 'deepseek-flash',
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
      maxTokens: 600,
      temperature: 0.4,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 20000)].filter(Boolean)),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch {
    return { words: [], anchors: [] }
  }
  return parseExtraction(raw)
}

export function parseExtraction(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { words: [], anchors: [] }
  let value = null
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { words: [], anchors: [] }
  }
  const words = (Array.isArray(value?.words) ? value.words : [])
    .map((item) => ({ term: normalizeTerm(item?.term), meaning: String(item?.meaning ?? ''), when: String(item?.when ?? '') }))
    .filter((item) => item.term)
    .slice(0, 3)
  const anchors = (Array.isArray(value?.anchors) ? value.anchors : [])
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^[\u4e00-\u9fa5，。！？、…~～]{2,16}$/.test(item))
    .slice(0, 2)
  return { words, anchors }
}

/** 完整一轮吸收：抓评论 → 抽词 → 写进语料库；失败静默。 */
export async function ingestCorpus(llm, character, comments, { now = Date.now() } = {}) {
  if (!comments?.length) return null
  const corpus = loadCorpus()
  const extracted = await extractCandidates(llm, character, comments)
  let accepted = 0
  for (const word of extracted.words) {
    if (addCandidate(corpus, { ...word, now })) accepted += 1
  }
  for (const anchor of extracted.anchors) addAnchor(corpus, anchor, now)
  corpus.stats = {
    ...(corpus.stats ?? {}),
    extracted: (corpus.stats?.extracted ?? 0) + extracted.words.length + extracted.anchors.length,
    accepted: (corpus.stats?.accepted ?? 0) + accepted,
    lastExtractAt: new Date(now).toISOString(),
    comments: comments.length,
  }
  saveCorpus(corpus)
  logCorpus({ action: 'ingest', comments: comments.length, words: extracted.words.map((word) => word.term), anchors: extracted.anchors, accepted })
  return { corpus, extracted }
}
