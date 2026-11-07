import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// LLM 判定语气层：两维强制判——① 是否太 AI，② 是否符合人格。
// 规则判别器（critic.js）抓硬违规（自报AI/客服腔/编经历…），这里用一次 flash
// 抓"软"问题：AI 味 + 人设跑偏。结果决定好/坏例子进不进 exemplars。

const LLM_CRITIC_LOG = join(DATA_DIR, 'llm-critic.jsonl')

const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 120,
  temperature: 0,
  timeoutMs: 9000,
}

// 她的人设底色，供「是否符合人格」判据用（和 voice/core 一致，但这里只放判据最需要的部分）。
const PERSONA = [
  '她的底色：安静克制，不是活泼。',
  '- 话少、不抢话、不谄媚、不过度热情；情绪收着，不跟着对方兴奋到顶。',
  '- 有少女心但藏得深：被夸会别扭、嘴硬（「才没有」「少来」「就那样吧」）。',
  '- 有立场：不同意直说「我不这么看」「我觉得不太对」，会拒绝「不要」「不行」，不为让对话顺而附和。',
  '- 口语短句，句末不加句号；能一个字就一个字（「哦」「嗯」「行」），不把每轮都填满。',
].join('\n')

const SYSTEM = [
  '你是「爱丽丝」的回复质检员。只看她这一轮的这一句话，判两个二分项（是 true / 否 false）。',
  '',
  '判据：',
  '- tooAi（太 AI）：这句话有 AI 味——太完整、太书面、太客套、太通用、太热情，或像客服/总结/论文/模板。',
  '- fitsPersona（符合人格）：这句话符合下面她的人设；跑偏（太活泼、太谄媚、太软、没立场、强行卖萌、太长太满）就 false。',
  '',
  PERSONA,
  '',
  '{"tooAi":false,"fitsPersona":true}',
  '',
  '拿不准就按"是不是她会说的话"来。只输出 JSON，不要解释、不要代码块。',
].join('\n')

function logLlmCritic(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LLM_CRITIC_LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 日志失败不影响回复。
  }
}

/**
 * 异步判一次语气两维。绝不抛错：调用失败返回 { tooAi:null, fitsPersona:null, error }，
 * 让上层用规则判定兜底。
 */
export async function judgeTone(llm, character, { user, reply }) {
  const config = { ...DEFAULTS, ...(character.llmCritic ?? {}) }
  const started = Date.now()
  let raw = ''
  let error = null
  try {
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `对方说：「${String(user ?? '').slice(0, 120)}」\n她回：「${String(reply ?? '').slice(0, 200)}」` },
          ],
        },
      ],
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  let tooAi = null
  let fitsPersona = null
  if (!error) {
    try {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start >= 0 && end > start) {
        const value = JSON.parse(raw.slice(start, end + 1))
        if (typeof value.tooAi === 'boolean') tooAi = value.tooAi
        if (typeof value.fitsPersona === 'boolean') fitsPersona = value.fitsPersona
      }
    } catch {
      // 解析失败就留 null，上层兜底。
    }
  }

  logLlmCritic({
    at: new Date().toISOString(),
    ms: Date.now() - started,
    error,
    tooAi,
    fitsPersona,
    raw: String(raw).slice(0, 200),
  })
  return { tooAi, fitsPersona, error }
}
