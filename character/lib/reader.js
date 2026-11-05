/**
 * 资料员（reader）：她去逛逛的时候，先由这一层把"看"做完。
 *
 * 分工是硬边界：
 *   reader   —— 抓候选、读原文、写一份极短的事实报告（可以含 1 个链接）
 *   她（voice）—— 只看报告，说自己在意的那一点，永远不接触原文
 *
 * 这样她的上下文里只有"被消化过的内容"，不会出现"贴链接 + 复述剧情"的
 * 书报腔，也不会被原文的措辞带跑。原文只留在 reader.jsonl 里供事后核对。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { biasCandidates, renderInterest } from './interest.js'
import { DATA_DIR } from './state.js'

const READER_LOG = join(DATA_DIR, 'reader.jsonl')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const DEFAULTS = {
  maxCandidates: 14,
  maxFacts: 2,
  // 思考 token 也算 max_tokens：给少了正文会被吃空，见 PLAN §7.2
  maxTokens: 1200,
  temperature: 0.6,
  timeoutMs: 25_000,
  fetchTimeoutMs: 8_000,
  // 从这两个源里挑：排行更"值得看"，热门更"当下在发生"
  sources: ['ranking', 'popular'],
}

function clip(text, max) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length <= max) return value
  // 尽量在分句处截断，别留半句话
  const head = value.slice(0, max)
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('。'))
  return cut >= max * 0.5 ? `${head.slice(0, cut)}` : `${head}…`
}

const BOILERPLATE_RE = /(素材来自|素材来源于|侵删|仅供|版权归|转载请注明|禁止转载|如有侵权|本视频为|网络素材)/

/** 简介大多是版权声明和素材说明，那种不算内容——别让资料员拿它当事实。 */
function cleanDesc(desc) {
  const value = String(desc ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  if (BOILERPLATE_RE.test(value) && value.length < 120) return ''
  const kept = value
    .split(/[。；;\n]/)
    .map((part) => part.trim())
    .filter((part) => part && !BOILERPLATE_RE.test(part))
    .join('。')
  return kept.length >= 8 ? kept : ''
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}

function toCandidate(item, source) {
  const bvid = String(item.bvid ?? '')
  if (!bvid) return null
  const title = clip(item.title, 80)
  if (!title) return null
  return {
    source,
    bvid,
    topic: title,
    desc: clip(cleanDesc(item.desc), 140),
    owner: clip(item.owner?.name, 20),
    tag: clip(item.tname, 12),
    views: Number(item.stat?.view ?? 0),
    url: `https://www.bilibili.com/video/${bvid}`,
  }
}

export async function collectCandidates(config = {}, exclude = []) {
  const settings = { ...DEFAULTS, ...config }
  // 判重表：刷过的视频不再进候选，否则热度榜天天第一名会被她反复讲。
  const excludeSet = new Set(
    exclude
      .map((value) => String(value ?? ''))
      .map((value) => value.match(/BV[0-9A-Za-z]+/)?.[0] ?? value)
      .filter(Boolean),
  )
  const fetchers = {
    ranking: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    popular: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
  }
  const seen = new Set()
  const items = []

  for (const source of settings.sources) {
    const url = fetchers[source]
    if (!url) continue
    try {
      const data = await fetchJson(url, settings.fetchTimeoutMs)
      for (const raw of data?.data?.list ?? []) {
        const candidate = toCandidate(raw, source)
        if (!candidate) continue
        if (seen.has(candidate.bvid)) continue
        if (excludeSet.has(candidate.bvid) || excludeSet.has(candidate.url)) continue
        seen.add(candidate.bvid)
        items.push(candidate)
      }
    } catch {
      // 一个源挂了不影响另一个；全部挂了由调用方决定怎么退。
    }
  }

  return items.slice(0, settings.maxCandidates)
}

function buildSystem(character, interest = null) {
  const core = character?.layers?.core ?? ''
  const hint = renderInterest(interest)
  return `你是爱丽丝的资料员。你只负责看，不负责说。

${core ? `关于她（只用来判断什么值得看，不要模仿她说话）：\n${core}\n` : ''}${hint ? `${hint}\n` : ''}
你的活：
- 从候选里挑一条她真的会感兴趣的（她的性格：好奇心重、喜欢具体的细节、对"人怎么过日子"比对热度榜感兴趣）。
- 写出她需要知道的事实：这件事/这个东西到底是什么，发生了什么，具体的数字、时间、地点能带就带。
- 事实里不写元信息：播放量、UP 主名字、素材来源、"本视频"这类都不算内容。
- 简介是空的就只看标题，标题里能确定多少写多少；不确定的别编。
- 不复制原文的句子，只写你自己的话，尽量短。
- angle 直接说事，别用「她喜欢…」「她是那种…」这种评语开头；不超过 25 字。
- 判断错方向也没关系，但要给一个真实的理由。

只输出 JSON，不要别的：
{"pick":候选编号,"topic":"一句话说清是什么","facts":["事实一","事实二"],"angle":"她会在意的那一点，一句话","url":"链接"}`
}

function buildUser(candidates) {
  const lines = candidates.map(
    (item, index) =>
      `${index + 1}. [${item.source}/${item.tag}] ${item.topic}——${item.desc || '（简介没内容）'}（播放 ${item.views}）`,
  )
  return `候选：\n${lines.join('\n')}\n\n挑一条，写报告。`
}

function parseJsonLoose(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeReport(value, candidates) {
  if (!value || typeof value !== 'object') return null
  const pick = Number(value.pick)
  const picked = Number.isInteger(pick) ? candidates[pick - 1] : null
  const topic = clip(value.topic, 80) || picked?.topic || ''
  if (!topic) return null
  const facts = (Array.isArray(value.facts) ? value.facts : [])
    .map((fact) => clip(fact, 50))
    .filter((fact) => fact.length >= 4)
    .slice(0, DEFAULTS.maxFacts)
  if (!facts.length) return null
  return {
    topic,
    facts,
    angle: clip(value.angle, 32),
    url: picked?.url ?? clip(value.url, 200),
    source: picked?.source ?? '',
    bvid: picked?.bvid ?? '',
    tag: picked?.tag ?? '',
  }
}

export function renderReport(report) {
  if (!report) return ''
  const lines = [`看到的事：${report.topic}`, `事实：${report.facts.join('；')}`]
  if (report.angle) lines.push(`你可能在意的是：${report.angle}`)
  return lines.join('\n')
}

export function logReader(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(READER_LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 日志不能影响漫游
  }
}

/**
 * 读一遍，写报告。任何一步失败都返回 null——调用方据此跳过这次漫游，
 * 而不是让她退回去自己上网。
 */
export async function readReport(llm, character, config = {}, signal = null, interest = null, exclude = []) {
  const settings = { ...DEFAULTS, ...(character?.reader ?? {}), ...config }
  const started = Date.now()
  let error = null
  let candidates = []

  try {
    candidates = await collectCandidates(settings, exclude)
    if (!candidates.length) {
      logReader({ at: new Date().toISOString(), result: 'no-candidates', ms: Date.now() - started })
      return null
    }
    // 兴趣画像：偏好高的标签往前排；两成概率不看权重，留点新鲜感。
    candidates = biasCandidates(candidates, interest)

    const timeout = AbortSignal.timeout(settings.timeoutMs)
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout
    let raw = ''
    const stream = llm.stream({
      provider: settings.provider ?? character?.planner?.provider ?? 'deepseek-official',
      model: settings.model ?? character?.planner?.model ?? 'deepseek-flash',
      system: buildSystem(character, interest),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUser(candidates) }] }],
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      signal: merged,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }

    const report = normalizeReport(parseJsonLoose(raw), candidates)
    if (!report) {
      logReader({
        at: new Date().toISOString(),
        result: 'unparsed',
        ms: Date.now() - started,
        raw: clip(raw, 400),
      })
      return null
    }

    logReader({
      at: new Date().toISOString(),
      result: 'ok',
      ms: Date.now() - started,
      report,
      // 原文只留在这里，用于事后核对"她有没有照抄"，不会进她的上下文
      candidates: candidates.map((item) => ({ topic: item.topic, desc: item.desc })),
    })
    // 候选带回去：语料吸收要拿 bvid 去抓评论，她自己的上下文里不出现。
    return { ...report, candidates }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
    logReader({
      at: new Date().toISOString(),
      result: 'error',
      ms: Date.now() - started,
      error: error.slice(0, 200),
    })
    return null
  }
}

/** 她这一轮能看到的全部材料：报告 + 一句提醒。 */
export function renderRoamBrief(report) {
  if (!report) return ''
  const lines = [
    '[自由活动时间]',
    '你刚才随手翻到一点东西（资料员整理好的，你没读过原文）：',
    renderReport(report),
    `链接：${report.url}`,
    '',
    '说两句你自己的话就行：你在意的是哪一点、你怎么想。别复述人家怎么写的，别介绍背景，别把链接当结论。',
    '不想说也没关系，那就只说一句今天没看到什么。',
  ]
  return lines.join('\n')
}
