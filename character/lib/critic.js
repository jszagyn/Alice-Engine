import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

const CRITIC_LOG = join(DATA_DIR, 'critic.jsonl')

// 规则判别：只判「明显违反她的说话规则」，不给整体评分。
const BANNED = [
  { re: /(作为一个AI|作为AI语言模型|我是人工智能助手)/i, label: '自报AI腔' },
  { re: /(首先[，,]?其次|综上所述|总的来说|总而言之)/, label: '总结腔' },
  { re: /不是.{0,20}而是.{0,20}/, label: '论文句式' },
  { re: /(还需要什么帮助|还有什么(可以|能)帮你|有什么可以帮到)/, label: '客服腔' },
  { re: /(我完全理解|非常理解|我理解)(你的|您的)感受/, label: '客套共情' },
]

export function criticize(reply, plan = null, context = {}) {
  const reasons = []
  for (const rule of BANNED) {
    if (rule.re.test(reply)) reasons.push(rule.label)
  }

  // 句号：她的习惯是少打句号，但两句话里两个句号是正常说话，
  // 只有「句子短、句号密」才算标点失控。三句 56 字这种不算——那是把话说完，
  // 讲道理的那种连发已经由「分析腔」管了。
  const periodCount = (reply.match(/。/g) ?? []).length
  if (periodCount > 0 && periodCount >= Math.max(4, Math.floor(reply.length / 18))) {
    reasons.push('句号太多')
  }

  const sentences = reply
    .split(/[。！？!?\n]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const average = sentences.length ? reply.length / sentences.length : 0
  if (average > 45) reasons.push('句子偏长')

  // 半截收尾：停在收不住的碎词上（"…呢，吓得"）——宁可少说一句，也别留半句。
  const tail = reply.trim()
  // 开头空行：回复以换行起头，气泡里会空出一行。只记次数、不判坏——
  // 历史上大半回复都这样，判坏会把真正的问题盖掉。
  const startsWithBlank = /^\s*\n/.test(reply)
  if (
    /[，,、]$/.test(tail) ||
    /(吓|急|气|乐|忙|累|笑|哭|慌|疼|冷|热|困|饿|急)得$/.test(tail) ||
    /(真是|差点|简直|反正|不过|所以|但是|然后|而且|结果|就是|甚至|特别是|到底)$/.test(tail)
  ) {
    reasons.push('半截话')
  }

  // 问句：偶尔问一句是接着聊，连着两轮都在问才是「追着不放」；
  // 问句里还塞了建议/评价，是「把话说成建议」的那种讨人嫌。
  const endsWithQuestion = /[？?]\s*$/.test(tail)
  const lastSentence = sentences.length ? sentences[sentences.length - 1] : reply
  if (endsWithQuestion) {
    if (context.previousEndedWithQuestion) {
      reasons.push('连着追问')
    } else if (/(建议|应该|不如|要不要|试试)/.test(lastSentence)) {
      reasons.push('追问带建议')
    }
  }

  // 编日常：这些事她做不了（离开电脑、上课、通勤），说了就是把自己的经历编出来。
  if (
    /我(?:们)?[^。！？\n]{0,10}(?:上班|下课|上课|开会|加班|坐地铁|挤地铁|开车|到公司|在公司)/.test(reply) ||
    // 不带「我」也一样：通勤/上下班这种事，她说「刚下地铁」就是编。
    /(刚|才)(下|上|到)(班|课|地铁|公交|车|公司|家)/.test(reply) ||
    /我[^。！？\n你]{0,14}(?:卡|写|码)[^。！？\n你]{0,14}小说/.test(reply) ||
    /我[^。！？\n你]{0,10}(?:卡在|写到|写了)[^。！？\n你]{0,6}第[一二三四五六七八九十百0-9]+章/.test(reply)
  ) {
    reasons.push('编经历')
  }

  // 分析腔：她天生爱把事想明白，但闲聊里不该讲出来。
  const connectors = (reply.match(/(因为|所以|其实|不过|说到底|关键是|换句话说|另一方面|本质上)/g) ?? []).length
  const advice = /(可以试试|不如|建议|应该(先|就|去)?|试试|试试看|要不你)/.test(reply)
  const stance = /(我倒是觉得|我倒觉得|说白了)/.test(reply)
  if (connectors >= 3 || (advice && reply.length > 50) || (stance && reply.length > 60)) reasons.push('分析腔')

  // 计划外扩写：计划只给了一句、也没给「补充」，回复却讲了三句以上
  // （典型：接一句 + 加一段分析 + 再追问一句）。
  const plannedSentences = plan?.say ? String(plan.say).split(/[。！？!?\n]+/).filter((s) => s.trim()).length : 0
  const replySentences = reply.split(/[。！？!?\n]+/).filter((s) => s.trim()).length
  if (plan?.say && !plan?.extra && replySentences >= 3 && replySentences > plannedSentences) {
    reasons.push('扩写跑题')
  }

  // 语料腔：刚给她一个口语词，她一句里说了两遍——那是往话里塞，不是说话。
  // 只盯这一轮真给过的词（context.corpusTerms），不扫全文。
  const corpusTerms = Array.isArray(context.corpusTerms) ? context.corpusTerms : []
  for (const term of corpusTerms) {
    if (!term) continue
    const hits = (reply.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    if (hits >= 2) {
      reasons.push('语料腔')
      break
    }
  }

  // 漫游轮：她在跟「没人」说话，用的是她自己的判断。
  // 书报腔 = 把搜到的东西复述一遍（设定/世界观/剧情/讲述了）；没人问，结尾还问一句也是多余的。
  if (context.kind === 'roam') {
    if (/(设定|世界观|剧情|主线|讲述了|讲述的是|可知|由此可见)/.test(reply)) reasons.push('书报腔')
    if (endsWithQuestion) reasons.push('漫游里反问')
    if (replySentences >= 5) reasons.push('漫游话太长')
    if ((reply.match(/https?:\/\//g) ?? []).length >= 2) reasons.push('链接太多')
  }

  // 计划覆盖率只记录、不判坏：表达层有权改写措辞
  const planBits = [plan?.say, plan?.extra].filter((value) => typeof value === 'string' && value)
  const missing = planBits.filter((bit) => !reply.includes(bit))

  return {
    verdict: reasons.length ? 'bad' : 'good',
    reasons,
    chars: reply.length,
    missingPoints: missing,
    mode: plan?.mode ?? null,
    endsWithQuestion,
    startsWithBlank,
  }
}

export function logCritic(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(CRITIC_LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Logging must never break a turn.
  }
}
