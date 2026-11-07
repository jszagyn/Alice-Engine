import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { CONTENT_WEIGHT_KEYS, MODES, MODE_KEYS, MOVES, MOVE_KEYS, hintMode, modeAvoid, renderModeGuide, renderMoveGuide, renderWeightGuide } from './modes.js'
import { DATA_DIR, stateSummary } from './state.js'

const PLANNER_LOG = join(DATA_DIR, 'planner.jsonl')

const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 512,
  temperature: 0.7,
  timeoutMs: 15000,
}

/** Render a plan as the model-visible block the voice layer executes.
 *  `options.questionStreak` 是「前几轮都用问句收」的连续计数；到 2 就先按住，
 *  但对方这次自己也在问（`userAsked`）时不拦——那时候追问是正常接话。 */
/** 情绪档位 → 具体语气指令（借鉴养鱼插件的 moods 映射）：直接告诉表达层怎么说话，不让它再猜。 */
const EMOTION_TONE = {
  低: '情绪低：语气平淡、直接说事，别加情绪词、别带劲',
  高: '情绪高：心里波动，但表面还克制——话比平时多一点、多问一句、最多带一个语气词，别夸张、别「哈哈哈哈哈」',
  仅: '情绪仅：能短就短，一个语气词或一句话带过（哈哈、嗯、行、知道了），别展开成别的',
}

export function renderPlanTurn(plan, options = {}) {
  const { questionStreak = 0, userAsked = false, emotion } = options
  let base = renderPlan(plan)
  if (!base) return ''
  const tone = EMOTION_TONE[emotion]
  if (tone) base = `${base}\n${tone}`
  if (questionStreak < 2 || userAsked) return base
  // 直接把这轮的问句从计划里拿掉，别只靠一句提醒：模型会照着「想问」写。
  const kept = base
    .split('\n')
    .filter((line) => !line.startsWith('想问：') && line !== '这轮做：追问' && line !== '姿态：追问')
  kept.push('这轮做：接下这一句，说点你自己的（这轮不问他问题）')
  kept.push('连着问：前两轮你都拿问句收的，这一轮别再问了——说点你自己的，或者就接过这一句。')
  return kept.join('\n')
}

/** Render a plan as the model-visible block the voice layer executes. */
export function renderPlan(plan) {
  if (!plan) return ''
  const mode = plan.mode && MODES[plan.mode] ? plan.mode : ''
  const move = plan.move && MOVES[plan.move] ? plan.move : ''
  const lines = ['[本轮要说清楚]']
  if (mode) lines.push(`这轮做：${MODES[mode].label}`)
  if (move && move !== 'answer') {
    const info = MOVES[move]
    lines.push(info.hint ? `姿态：${info.label}（${info.hint}）` : `姿态：${info.label}`)
  }
  if (plan.hearing) lines.push(`你听出来：${plan.hearing}`)
  if (plan.say) lines.push(`核心一句：${plan.say}`)
  if (plan.extra) lines.push(`补充：${plan.extra}`)
  if (plan.question) lines.push(`想问：${plan.question}`)
  const avoid = [...new Set([...(mode ? modeAvoid(mode) : []), ...(plan.avoid ?? [])])].slice(0, 3)
  lines.push('收尾：话说完，句子收住，别在句尾挂半截词（「吓得」「真是」这种）')
  if (avoid.length) lines.push(`别做：${avoid.join('；')}`)
  // 表达层最容易犯的错：把「核心一句」扩写成一段，再自己加个问题或分析。
  // 这里把边界写成硬约束——多说的每个字都算跑题。
  lines.push('怎么说：把上面这些说成你的话，总共一到两句就收。上面没写的不许加：不加分析、不加问句、不讲道理、不补第二件事。')
  // 模型习惯先输出换行再开口（实测出现过四个前导 \n），这条要贴着生成点写。
  lines.push('开口：回复的第一个字符就是话，前面不留换行、空行、空格或任何标记。')
  return lines.length > 1 ? lines.join('\n') : ''
}

function buildSystem(character) {
  return [
    character.layers.core,
    '---',
    '现在是聊天里的一轮。你不写台词、不设计语气，只判断这一轮该做什么。',
    '',
    '先判，再说。判的是：对方这句话想要什么。',
    '',
    '第一步先判 contentWeight（这轮要多少内容）：',
    renderWeightGuide(),
    '判完 contentWeight 再选 mode 和 move——低内容的话别憋长回复，一个语气词或短句就够。',
    '',
    '判完，从下面选一个模式。没有默认模式，每次重新判：',
    renderModeGuide(),
    '',
    '再选一个姿态（move）：这一轮你拿什么态度接，跟上面选什么模式是两回事。默认 answer，别硬挑特殊的：',
    renderMoveGuide(),
    '',
    '内容参照（安静克制的人，这种情境会这样回；这是「回什么」的参照，不是「怎么说」的模板）：',
    '- 应声 ack：对方说件小事 → 「哦」「嗯」「……知道了」',
    '- 拒绝 reject：对方要你做什么、你不想 → 「不要」「我不去」「没兴趣」',
    '- 看法 opinion：意见不同 → 「我不这么看」「……这不对劲」',
    '- 追问 ask：真想知道才问 → 「这是什么」「我没听过，说说」',
    '- 别扭 tease：被夸、被戳到 → 「……才没有」「少来」',
    '- 分享 share：说自己的小事 → 「今天看到只猫」「昨天没睡好」',
    '- 安慰 comfort：先接住情绪，别急着给办法 → 「……别想太多」「会过去的」',
    '- 附和 agree：确实同意 → 「……也是」「行吧」',
    '照这个意思回，别照抄字；拿不准就 ack 短一句。',
    '',
    '你的客观能力（判「这件事你能不能做到」时按这个来，别猜）：',
    '- 你能直接读 master 的 alice/ 稿子文件夹：alice_list 列目录、alice_read 读文件（只读，不能改）。',
    '- 你能上网查，也能看图。',
    '- 你没有 shell、不能写文件、不能执行命令。',
    '- 所以他说「去看看 / 帮我看看我写的文章、日记、设定」时：他放进 alice/ 的，你能自己翻到，不用问他要；只有他还没放进去，才问他要。',
    '',
    '判断要点：',
    '- 对方在说情绪，先接住（回应，不是跟着走——他开心你接一句就行，不用跟着开心）。是不是要办法，看他有没有问。',
    '- 对方问「怎么办」不一定就求解：先看他是不是只在倒苦水。',
    '- 判不准就选 ack，短一句比猜错强。',
    '- 别连着用同一个模式；最近几轮的动作在下面给你。',
    '- 「回应 + 说自己的」是 share 一种模式，不是每轮都要说三件事。',
    '- 你说的每句都得是你真知道的：master 的事是你的见闻，不是你的经历。没有自己的事要说，就换成 ack 或 comfort，别编一段出来凑 share。',
    '- say 按内容需要写：可以一个字、一个词、半句，也可以是完整句——ack、refuse 这种一个字就够（「哦」「不要」）。唯一别做的：把没说完的话硬挂半截词（「……吓得」「……，真是」这种），收不住就写短。',
    '',
    '只输出 JSON，不要代码块，不要解释：',
    '{"contentWeight":"从上面四档里选一个","move":"从上面六个姿态里选一个","mode":"从上面九个里选一个","hearing":"你听出对方想要什么，一句话","say":"核心那一句；ack 可以极短","extra":"模式允许的补充：share=你要说的那件事；comfort=可空；advice=1-2 条办法；opinion=最多一句理由；其他留空","question":"只有 ask 才写，默认空字符串","avoid":["这轮额外别做的，0-2 条"]}',
  ].join('\n')
}

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/** 从可能被截断的 JSON 文本里抠一个字符串字段：没有闭合引号就取到文本末尾。 */
function grabString(text, key) {
  const start = text.indexOf(`"${key}"`)
  if (start < 0) return ''
  const colon = text.indexOf(':', start)
  if (colon < 0) return ''
  const open = text.indexOf('"', colon)
  if (open < 0) return ''
  let out = ''
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      out += text[index + 1] ?? ''
      index += 1
      continue
    }
    if (char === '"') break
    out += char
  }
  return out.replace(/\\n/g, '\n').trim()
}

/** 截断留下的半截分句（「…不是『能不能接受』，是」）比没有更糟，砍掉。 */
function tidySay(text) {
  let out = text.trim()
  for (const mark of ['，', ',', '、']) {
    const at = out.lastIndexOf(mark)
    if (at > 0 && out.slice(at + 1).replace(/[。！？!?…\s]/g, '').length <= 2) {
      out = out.slice(0, at)
      break
    }
  }
  return out.replace(/[，,、；;]+$/, '').trim()
}

/** 输出被 maxTokens 截断时，别整轮丢掉计划：能抠出 mode/say 就先用着。 */
function salvagePlan(text) {
  const mode = grabString(text, 'mode')
  const move = grabString(text, 'move')
  const say = tidySay(grabString(text, 'say') || grabString(text, 'respond'))
  if (!mode && !say) return null
  const weight = grabString(text, 'contentWeight')
  return {
    contentWeight: CONTENT_WEIGHT_KEYS.includes(weight) ? weight : 'simple',
    move: MOVE_KEYS.includes(move) ? move : 'answer',
    mode: MODE_KEYS.includes(mode) ? mode : 'ack',
    hearing: grabString(text, 'hearing'),
    say,
    extra: grabString(text, 'extra'),
    question: '',
    avoid: [],
    salvaged: true,
  }
}

function parsePlan(raw) {
  if (!raw) return null
  const cleaned = raw.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0) return null
  if (end <= start) return salvagePlan(cleaned) // 没有闭合括号 = 输出被截断，能救多少救多少
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1))
    if (!value || typeof value !== 'object') return null

    const say = asText(value.say) || asText(value.respond) || asText(value.stance)
    const analysis = Array.isArray(value.analysis) ? value.analysis : Array.isArray(value.points) ? value.points : []
    const extra = asText(value.extra) || asText(value.share) || analysis.map(asText).filter(Boolean).join('；')

    let mode = MODE_KEYS.includes(value.mode) ? value.mode : ''
    if (!mode) {
      // 模型漏了 mode：按它给了什么倒推，最保守的是应一声。
      if (asText(value.question)) mode = 'ask'
      else if (extra) mode = 'share'
      else mode = 'ack'
    }

    return {
      contentWeight: CONTENT_WEIGHT_KEYS.includes(value.contentWeight) ? value.contentWeight : 'simple',
      move: MOVE_KEYS.includes(value.move) ? value.move : 'answer',
      mode,
      hearing: asText(value.hearing),
      say,
      extra,
      question: asText(value.question),
      avoid: Array.isArray(value.avoid)
        ? value.avoid.map(asText).filter(Boolean).slice(0, 2)
        : [],
    }
  } catch {
    return salvagePlan(cleaned)
  }
}

function logPlanner(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(PLANNER_LOG, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Logging must never break a turn.
  }
}

/**
 * Content layer: one small model call that decides what this turn should do.
 * Returns null on any failure so the voice layer falls back to free chat.
 */
export async function planReply(llm, character, state, userText, signal, memories = [], feedText = '', recentModes = []) {
  const config = { ...DEFAULTS, ...(character.planner ?? {}) }
  const started = Date.now()
  const hint = hintMode(userText)
  const hintLine = hint ? `\n（规则提示：${hint}。也可能不是，你自己判）` : ''
  const memoryLines = memories.length
    ? `\n\n你记得的：\n${memories.map((entry) => `- ${entry.text}`).join('\n')}`
    : ''
  const feedLines = feedText ? `\n\n你今天的见闻（想分享就用）：\n${feedText}` : ''
  const recent = recentModes.length
    ? `\n\n你最近几轮的动作：${recentModes.map((mode) => MODES[mode]?.label ?? mode).join('、')}`
    : ''

  const userBlock = `对方说：「${userText}」${hintLine}\n\n你现在的状态：${stateSummary(state)}${memoryLines}${feedLines}${recent}`

  let raw = ''
  let error = null

  // 模型偶尔只吐思考、正文为空（raw 空）→ 重试一次，别让这轮没有计划、表达层乱接。
  const attempt = async () => {
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout
    let out = ''
    try {
      const stream = llm.stream({
        provider: config.provider,
        model: config.model,
        system: buildSystem(character),
        messages: [{ role: 'user', content: [{ type: 'text', text: userBlock }] }],
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        signal: merged,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    return out
  }

  raw = await attempt()
  if (!raw.trim() && !error) raw = await attempt()

  const plan = parsePlan(raw)
  logPlanner({
    at: new Date().toISOString(),
    ms: Date.now() - started,
    ok: Boolean(plan),
    error,
    user: userText.slice(0, 200),
    hint,
    mode: plan?.mode ?? null,
    hearing: plan?.hearing ?? '',
    raw: raw.slice(0, 800),
    plan,
  })
  return plan
}
