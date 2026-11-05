import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from './state.js'

// LLM 判别二分项：规则判别器（critic.js）抓「明显违规」，这里用一次 flash
// 抓软性问题——说教、讨好、跑题、分析腔。只判「是/否」，不写评语。
// 结果写进 llm-critic.jsonl，供复盘和后续调优；不阻塞回复。

const LLM_CRITIC_LOG = join(DATA_DIR, 'llm-critic.jsonl')

const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 120,
  temperature: 0,
  timeoutMs: 9000,
}

const LABELS = { preach: '说教', please: '讨好', offtopic: '跑题', analyze: '分析腔' }
const KEYS = Object.keys(LABELS)

const SYSTEM = [
  '你是回复质检员。只看她这一轮回的这句话，判四个二分项（是 true / 否 false）。',
  '',
  '{"preach":false,"please":false,"offtopic":false,"analyze":false}',
  '',
  '判据：',
  '- preach（说教）：她在讲道理、劝人、下结论，而不是接话聊天。',
  '- please（讨好）：她为了顺着对方而软话/附和，自己的立场跟着跑。',
  '- offtopic（跑题）：她没接住对方说的，扯到别的事上。',
  '- analyze（分析腔）：她在分析原因、解释为什么，而不是在聊天。',
  '拿不准就 false。只输出 JSON，不要解释、不要代码块。',
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
 * 异步判一次软性二分项。绝不抛错：调用失败返回 { flags: [], error }。
 */
export async function judgeReplyBinary(llm, character, { user, reply }) {
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

  const flags = []
  if (!error) {
    try {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start >= 0 && end > start) {
        const value = JSON.parse(raw.slice(start, end + 1))
        for (const key of KEYS) {
          if (value[key] === true) flags.push(key)
        }
      }
    } catch {
      // 解析失败就当没有 flags，别误伤。
    }
  }

  logLlmCritic({
    at: new Date().toISOString(),
    ms: Date.now() - started,
    error,
    flags: flags.map((key) => LABELS[key]),
    raw: String(raw).slice(0, 200),
  })
  return { flags, error }
}
