import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appraise } from './appraise.js'
import { composeBrief, dayKey, idleMsSince, loadBrief, saveBrief, shouldBrief, touchActivity } from './brief.js'
import { pushVoice } from './voiceBus.js'
import { criticize, logCritic } from './critic.js'
import { judgeTone } from './llmCritic.js'
import { loadDiary, renderDiary, saveDiary, writeDiaryLine } from './diary.js'
import { loadExemplars, recordExemplar } from './exemplars.js'
import { addFeedItems, extractFeedItems, loadFeed, markFeedUsed, renderFeed } from './feed.js'
import {
  applyMood,
  judgeMood,
  loadMood,
  logMood,
  pickAnnounce,
  rememberShift,
  renderMoodShift,
  saveMood,
} from './mood.js'
import { appendDigest, closeEpisodes, loadDigest } from './digest.js'
import {
  loadEpisodic,
  pruneEpisodic,
  relevantEpisodes,
  rememberEpisode,
  renderEpisodes,
  saveEpisodic,
  utterance,
} from './episodic.js'
import { loadMemory, memoryFileStamp } from './memory.js'
import { classifyAll, correctSlot, loadProfile, profileEntries, profileStamp, promoteFromDigest, rememberInProfile, renderProfile, saveProfile } from './profile.js'
import { logMemory } from './memoryLog.js'
import { applyMemoryResult, summarizeMemory } from './memoryLlm.js'
import { loadSelfModel, rememberSelfLines, renderSelfModel, saveSelfModel } from './selfModel.js'
import { loadStance, rememberStanceLines, renderStance, saveStance } from './stance.js'
import { loadEvents, rememberEvents, renderEvents, saveEvents } from './events.js'
import { loadFeelings, rememberFeeling, renderFeelings, saveFeelings } from './feelings.js'
import { loadIndex, renderIndex, summarizeFile, summarizeAlice } from './aliceIndex.js'
import { setReadHook } from '../tools.js'
import { planReply, renderPlanTurn } from './planner.js'
import { readReport, renderRoamBrief } from './reader.js'
import { corpusStamp, fetchComments, ingestCorpus, loadCorpus, markWordsUsed, penalizeWords, pickAnchor, renderCorpusHint, saveCorpus, selectWords } from './corpus.js'
import { engagementSignal, interestStamp, loadInterest, recordEngagement, recordPick, saveInterest } from './interest.js'
import { createRateLimiter, parseEvent, qqConfig, sendInParts, shouldAccept, trimForQq } from './qq.js'
import { setInboundHandler } from './qqBus.js'
import {
  ROAM_MARKER,
  loadRoam,
  loadRoamTask,
  loadSeen,
  mayRoam,
  recordRoam,
  recordSeen,
  seenHint,
} from './roam.js'
import {
  SPEAKUP_MARKER,
  loadSpeakUp,
  maySpeak,
  pickTrigger,
  recordMiss,
  recordReply,
  recordSpeak,
} from './speakup.js'
import {
  DATA_DIR,
  STATE_SENTINEL,
  applyAppraisal,
  clearConflict,
  emotionLevel,
  loadState,
  noteConflict,
  renderState,
  saveState,
} from './state.js'

import { synthesize } from './tts.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPRAISAL_LOG = join(DATA_DIR, 'appraisal.jsonl')

// 最长连续重合：判断她这一轮是不是真讲了报告里的内容（兴趣画像的信号）。
function longestCommon(a, b) {
  const s1 = String(a ?? '')
  const s2 = String(b ?? '')
  if (!s1 || !s2) return 0
  let best = 0
  let previous = new Array(s2.length + 1).fill(0)
  for (let i = 1; i <= s1.length; i += 1) {
    const current = new Array(s2.length + 1).fill(0)
    for (let j = 1; j <= s2.length; j += 1) {
      if (s1[i - 1] === s2[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

export function loadCharacter() {
  const character = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'data', 'character.json'), 'utf8'))
  // 人格/语气可从 persona/*.md 覆盖（无编程自定义：改这两个文件，重启即生效）
  try {
    const persona = join(PACKAGE_ROOT, '..', 'persona', '人格.md')
    if (existsSync(persona)) character.layers.core = readFileSync(persona, 'utf8').trim()
  } catch {}
  try {
    const voice = join(PACKAGE_ROOT, '..', 'persona', '语气.md')
    if (existsSync(voice)) character.layers.voice = readFileSync(voice, 'utf8').trim()
  } catch {}
  return character
}

// 只应一声的语气词才值得跳过内容层：「晚上好」这种是要接话的，不能省。
const FILLER_RE = /^(哦|喔|噢|嗯|嗯嗯|嗯呢|诶|欸|啊|呀|哈|哈哈|好|好耶|好的|好呢|好呀|行|收到|ok|OK|okk|在)$/

function isFiller(text) {
  return FILLER_RE.test(String(text).trim().replace(/[。！!~～…\s]+$/u, ''))
}

function textOf(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function logAppraisal(state, appraisal) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(
      APPRAISAL_LOG,
      `${JSON.stringify({
        at: new Date().toISOString(),
        reason: appraisal.reason,
        deltas: appraisal.deltas,
        state: {
          mood: state.mood,
          energy: state.energy,
          trust: state.trust,
        },
        turn: appraisal.turn,
      })}\n`,
      'utf8',
    )
  } catch {
    // Logging must never break a turn.
  }
}

function logRoamDebug(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(join(DATA_DIR, 'roam-debug.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Logging must never break a turn.
  }
}

/** 决策日志：每轮记下她「判了什么、怎么选的」，供离线回看（评测用）。 */
function logDecision(record) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(join(DATA_DIR, 'decisions.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Logging must never break a turn.
  }
}

export function createEngine(ctx) {
  const character = loadCharacter()
  const state = loadState(character.initial)
  let memory = loadMemory()
  let memoryStamp = memoryFileStamp()
  // 记忆 3.0：短期 episodic（72h）+ 长期槽位 profile（谁是谁、喜欢什么、作息）。
  let profile = loadProfile()
  let profileStampMs = profileStamp()
  let episodic = loadEpisodic()
  let digest = loadDigest()
  let exemplars = loadExemplars()
  let roam = loadRoam()
  let feed = loadFeed()
  let seen = loadSeen()
  let diary = loadDiary()
  let speakUp = loadSpeakUp()
  let mood = loadMood()
  let brief = loadBrief()
  let selfModel = loadSelfModel()
  let stance = loadStance()
  let events = loadEvents()
  let feelings = loadFeelings()
  let aliceIndex = loadIndex()
  const roamTask = loadRoamTask()
  const roamConfig = character.roam ?? {
    enabled: true,
    windowStart: 10,
    windowEnd: 22,
    minIntervalHours: 3,
    maxPerDay: 2,
    tickMinutes: 30,
    preferOffpeak: true,
  }
  const speakUpConfig = character.speakUp ?? {
    enabled: true,
    tickMinutes: 10,
    cooldownMinutes: 20,
    quietStart: 1,
    quietEnd: 8,
    hitPeak: 20,
    hitOffpeak: 60,
    missBonus: 10,
    missBonusCap: 40,
    recentFactor: 0.15,
    recentMinutes: 20,
    coldFactor: 1.5,
    coldMinutes: 360,
    maxPerDay: 6,
  }

  // The LLM runtime is a host service. Resolve it lazily so the persona keeps
  // working even in a composition without one.
  let llm = null
  ctx.inject(['llm'], (scope) => {
    llm = scope.llm
  })

  // 用来在没人打开聊天页时把她的会话唤醒（QQ 入站兜底）。
  // 用插件自己的 ctx（不是 inject 给的临时 scope）：cordis 的 service 代理会用
  // 「调用方 ctx」建 effect，HTTP 回调里没有活动 fiber，直接调会抛 INACTIVE_EFFECT。

  // Content layer output for the step about to be assembled.
  let currentPlan = null
  let currentUserText = ''
  // 连续几轮拿问句收尾：到 2 就先按住，别把聊天变成审问。
  let questionStreak = 0
  let currentMemories = []
  // 这一轮跟话题挨得上的短期记忆（三天内的），只在相关时带 1–2 条。
  let currentEpisodes = []
  let moodShift = null
  let briefText = null
  // 这一轮漫游资料员写的报告：抽取见闻时带上它，链接才不会丢。
  let pendingRoamReport = null
  // 资料员连续失败时退避，避免每个 tick 都白烧一次调用。
  let readerFailAt = 0
  // 语料吸收：她前两轮用过的词不再挑，同一周锚点固定一个。
  let corpus = loadCorpus()
  let corpusStampMs = corpusStamp()
  let corpusHint = ''
  let corpusTerms = []
  let recentCorpusTerms = []
  // 兴趣画像：她愿意看什么，按标签慢慢加权（留 20% 随机探索）。
  let interest = loadInterest()
  let interestStampMs = interestStamp()
  // QQ 桥：入站事件只认白名单，出站按句拆条。配置在 character.qq 里。
  const qq = qqConfig(character)
  // qq 配置每轮现读一次（按 mtime 缓存）：改白名单 / token / selfId 不用重启。
  // 之前这里是启动时捕获，改完配置白名单不生效，排过一次真实的坑。
  const QQ_CONFIG_FILE = join(DATA_DIR, 'character.json')
  let qqCache = { mtime: 0, config: qq }
  function currentQq() {
    try {
      const stamp = statSync(QQ_CONFIG_FILE).mtimeMs
      if (stamp !== qqCache.mtime) {
        qqCache = { mtime: stamp, config: qqConfig(JSON.parse(readFileSync(QQ_CONFIG_FILE, 'utf8'))) }
      }
    } catch {
      // 读不到就沿用上一次的配置，别让一轮对话因为读文件失败而崩。
    }
    return qqCache.config
  }
  const qqLimiter = createRateLimiter(qq.maxPerHour ?? 40)

  // 每个 agent 一份：本轮用户文本、本轮计划、正在流出的台词。
  const slots = new Map()

  // 角色 agent 清单：漫游只找最近活跃且空闲的那个。
  const agents = new Map()

  // DSH 重启后如果没有人打开过她的聊天页，agent 表是空的，QQ 来的消息就没人接。
  // 记住最后一个会话 id，QQ 有消息时按需 resume 回来。
  const LAST_SESSION_FILE = join(DATA_DIR, 'last-session.json')
  let agentsCtx = null
  let sessionController = null
  let lastSessionId = ''
  try {
    lastSessionId = String(JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf8')).sessionId ?? '')
  } catch {
    lastSessionId = ''
  }
  // 注意顺序：agentsCtx 声明在下面，inject 必须放在声明之后，
  // 否则回调同步执行时会撞 TDZ（Cannot access 'agentsCtx' before initialization），
  // agentsCtx 永远是 null，后台唤醒就永远不跑。
  ctx.inject(['agents'], (scope) => {
    // 关键：必须存 inject 传进来的 scope，它才带 agents 服务；
    // 存插件自己的 ctx 会在第一次访问时报 cannot get property "agents" without inject，
    // 而这个错误发生在定时器里，宿主会直接 fatal 退出。
    agentsCtx = scope
    logRoamDebug({ at: new Date().toISOString(), result: 'agents-ready' })
  })

  // 关键修复（QQ 双向）：resume 必须走 sessionController——它会读会话里记录的
  // preset 并把 persona 挂载上去；直接 agents.resume 只拉起一个没有 persona 的
  // 空会话，引擎不会在上面跑，QQ 来的消息就没人接（"会话不能自动激活"的根因）。
  ctx.inject(['sessionController'], (scope) => {
    sessionController = scope.sessionController
  })

  // 统一的 resume 入口：任何一步抛错都只记日志，绝不让异常冒到定时器外。
  function resumeAgent(tag) {
    if (!sessionController || !lastSessionId) return null
    try {
      return sessionController.agents.resume(lastSessionId)
    } catch (error) {
      logRoamDebug({
        at: new Date().toISOString(),
        result: `qq-${tag}-throw`,
        error: String(error?.message ?? error).slice(0, 160),
      })
      return null
    }
  }

  logRoamDebug({ at: new Date().toISOString(), result: 'engine-boot', session: lastSessionId || '', pending: 0 })

  function rememberSession(id) {
    if (!id || id === lastSessionId) return
    lastSessionId = id
    try {
      writeFileSync(LAST_SESSION_FILE, `${JSON.stringify({ sessionId: id, at: new Date().toISOString() })}\n`, 'utf8')
    } catch {
      // 记不下来也不影响这一轮
    }
  }

  ctx.on('agent/created', (payload) => {
    agents.set(payload.agent.id, { agent: payload.agent, lastActive: 0 })
    rememberSession(payload.agent.id)
    logRoamDebug({ at: new Date().toISOString(), result: 'agent-registered', agent: payload.agent.id })
    // 不能在 agent/created 的回调里同步 followup：resume 正等这条事件发完，
    // 这里再塞消息会把 emit 卡住，表现为 resume 永不返回。
    setTimeout(flushPendingQq, 50)
  })

  ctx.on('agent/disposed', (payload) => {
    agents.delete(payload.agent.id)
  })

  // Layer 2 — voice: how she says things. No identity decisions live here.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: 0,
      text: character.layers.voice,
    }),
  )

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'deployment:persona-suffix',
      order: 10200,
      text: character.prose.suffix,
    }),
  )

  // Layer 1 — tone: the state that colors the voice.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:state',
      order: 300,
      text: () => renderState(state),
    }),
  )

  // Layer 5 — content: what this turn should say, decided before the voice runs.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:plan',
      order: 301,
      text: () =>
        currentPlan
          ? renderPlanTurn(currentPlan, {
              questionStreak,
              userAsked: /[?？]/.test(currentUserText ?? ''),
              emotion: state.emotionLevel,
            })
          : '',
    }),
  )

  // 正反馈层：把攒下来的好例子喂回下一轮，让语气越用越像，而不是每轮靠 voice 硬纠。
  // 好例子当样板（照味道，别照抄原句），坏例子带原因提醒（别重犯）。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:exemplars',
      order: 302,
      text: () => {
        const good = (exemplars?.good ?? []).slice(0, 3).filter((g) => g?.reply)
        const bad = (exemplars?.bad ?? []).slice(0, 2).filter((b) => b?.reply)
        if (!good.length && !bad.length) return ''
        const lines = []
        if (good.length) {
          lines.push('你之前这样说，是对的（照这个味道说，别照抄原句）：')
          for (const g of good) lines.push(`- 「${g.reply}」`)
        }
        if (bad.length) {
          const why = bad.map((b) => (b.reasons?.length ? b.reasons.join('、') : '')).filter(Boolean).join('；')
          lines.push(why ? `你之前这样说岔了，别再犯（因为：${why}）` : '你之前有几次说岔了，别再那样说。')
        }
        return lines.join('\n')
      },
    }),
  )

  // Layer 6 — past: what she remembers about this person, retrieved per turn.
  // 记忆 3.0 之前这里是 [想起]（memory.json 的长期事实）；现在稳定信息走
  // [关于 master]（槽位），一时的事走 [这几天]（三天内），这里不再重复注入。

  // Layer 7 — today: what she noticed on her own, shared across all sessions.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:feed',
      order: 303,
      text: () => renderFeed(feed),
    }),
  )

  // Layer 8 — her yesterday: one line she wrote about herself this morning.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:diary',
      order: 304,
      text: () => renderDiary(diary),
    }),
  )

  // Layer 9 — mood shift: something just landed on her. Said once, then dropped.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:mood-shift',
      order: 305,
      text: () => renderMoodShift(moodShift),
    }),
  )

  // Layer 10 — daily brief: only on the first talk of a day, after a real gap.
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:brief',
      order: 306,
      text: () => briefText ?? '',
    }),
  )

  // 长期槽位：关于 master 的稳定信息（名字、住哪、喜欢什么、作息）。
  // 不随话题变，每轮都在，但要短——只带最有把握的六条。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:profile',
      order: 299,
      text: () => renderProfile(profile),
    }),
  )

  // 自我模型：她自己的台词/观点/承诺，稳定注入，让她记得自己说过什么。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:self',
      order: 298,
      text: () => renderSelfModel(selfModel),
    }),
  )

  // 立场清单：她明确划的线/站的位置（拒绝什么、坚持什么），核心人格锁死，这里可生长。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:stance',
      order: 297,
      text: () => renderStance(stance),
    }),
  )

  // 大事记：master 提到的长期重要的事（换工作/结婚/搬家/毕业等），会一直记得。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:events',
      order: 296,
      text: () => renderEvents(events),
    }),
  )

  // 情感记忆：master 夸过她 / 否定过她的瞬间，让她记得被夸过、被泼过冷水。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:feelings',
      order: 295,
      text: () => renderFeelings(feelings),
    }),
  )

  // 概括性记忆：alice/ 目录的内容索引（「路径：概括」），让她记得 master 投喂了些什么。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:alice-index',
      order: 294,
      text: () => renderIndex(aliceIndex),
    }),
  )

  // 短期记忆：三天里的事。不常驻，话题挨得上才带一两条。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:episodes',
      order: 307,
      text: () => (currentEpisodes.length ? `[这几天]\n${renderEpisodes(currentEpisodes)}` : ''),
    }),
  )

  // 语料：从真人评论里学来的口语词，一轮最多带一个，冷却够了才换。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'character:corpus',
      order: 308,
      text: () => corpusHint,
    }),
  )

  // 挑这一轮可以用的词和本周的语气锚点（同一周固定一个，避免她固化）。
  function pickCorpus() {
    const words = selectWords(corpus, { recentTerms: recentCorpusTerms })
    const anchor = pickAnchor(corpus)
    corpusTerms = words.map((word) => word.term)
    corpusHint = renderCorpusHint({ words, anchor })
    // pickAnchor 会把「本周锚点」标记写进内存，落盘一次免得下次又换。
    if (anchor) saveCorpus(corpus)
  }

  // Appraise the message, update memory, then plan the reply — all before the
  // step assembles its prompt. `session/event` does not reach a preset scope;
  // `agent/pre-step` does, the same hook plan-mode uses.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const key = payload.agent?.id ?? 'default'
      if (agents.has(key)) {
        agents.get(key).lastActive = Date.now()
      } else if (payload.agent) {
        // agent/created 漏掉的会话（恢复晚于登记），在这里补登记
        agents.set(key, { agent: payload.agent, lastActive: Date.now() })
      }
      rememberSession(payload.agent?.id ?? '')
      flushPendingQq()

      // 心情刚变：只在接下来这一轮里提一次，提完就消。
      moodShift = null
      briefText = null
      // 语料只在这一轮里生效：没挑到词就不带。
      corpusHint = ''
      corpusTerms = []
      const cstamp = corpusStamp()
      if (cstamp !== corpusStampMs) {
        corpus = loadCorpus()
        corpusStampMs = cstamp
      }
      if (mood.announce) {
        moodShift = mood.announce
        mood.announce = null
        mood.lastAnnouncedAt = new Date().toISOString()
        saveMood(mood)
      }

      const text = (payload.messages ?? [])
        .filter((message) => !message.source || message.source.kind === 'user')
        .map((message) => textOf(message.content))
        .filter((value) => value && !value.includes(STATE_SENTINEL))
        .join('\n')

      const roamText = (payload.messages ?? [])
        .filter((message) => message.source?.kind === 'schedule')
        .map((message) => textOf(message.content))
        .find((value) => value.includes(ROAM_MARKER))

      const speakUpText = (payload.messages ?? [])
        .filter((message) => message.source?.kind === 'speak-up')
        .map((message) => textOf(message.content))
        .find((value) => value.includes(SPEAKUP_MARKER))

      // QQ 来的话：跟网页聊天走同一条流水线，只是出处不同、回复要发回去。
      const qqInbound = (payload.messages ?? [])
        .filter((message) => message.source?.channel === 'qq')
        .map((message) => ({ text: textOf(message.content), source: message.source }))
        .find((item) => item.text)

      if (text) {
        let slot = slots.get(key)
        if (!slot) {
          slot = { user: '', plan: null, attempt: '', kind: 'chat', modes: [] }
          slots.set(key, slot)
        }
        slot.modes ??= []
        slot.user = text
        slot.kind = qqInbound ? 'qq' : 'chat'
        slot.qq = qqInbound?.source ?? null
        slot.turnTools = []
        currentUserText = text
        // 拒绝后悔（dsh-fish）：上轮她拒绝过，这轮看他的反应——接受就安心，施压就怀疑自己。
        if (state.conflict) {
          if (/(好吧|行吧|没关系|理解|你说得对|有道理|那算了|随你|懂了|明白了|不勉强)/.test(text)) {
            state.conflict.reaction = 'accepted'
            logRoamDebug({ at: new Date().toISOString(), result: 'refusal-reaction', reaction: 'accepted' })
          } else if (/(为什么|凭什么|就该|必须|你太|别这么|不行|不至于|固执|死板|较真)/.test(text)) {
            state.conflict.reaction = 'pushed'
            logRoamDebug({ at: new Date().toISOString(), result: 'refusal-reaction', reaction: 'pushed' })
          }
        }
        pickCorpus()
        // 上一轮她是不是拿问句收的：连着问两轮就先按住（见 renderPlanTurn）。
        slot.questionStreak = slot.lastEndedWithQuestion ? (slot.questionStreak ?? 0) : 0
        questionStreak = slot.questionStreak
        // master 回来了：连着没人应的计数清零，别让昨晚的沉默压住今天的话。
        if (speakUp.unanswered) speakUp = recordReply(speakUp)

        const appraisal = appraise({ user: text, assistant: '', toolErrors: 0 }, character)
        applyAppraisal(state, appraisal, character)
        // 情感记忆：master 夸她 / 否定她，沉淀一句（被肯定就记，不卡他的情绪强度——「可爱/软糯」这种也算）。
        if (appraisal.tags.includes('被否定')) {
          if (rememberFeeling(feelings, `master 否定了她：${text.slice(0, 24)}`)) saveFeelings(feelings)
        } else if (appraisal.tags.includes('被肯定')) {
          if (rememberFeeling(feelings, `master 夸了她：${text.slice(0, 24)}`)) saveFeelings(feelings)
        }
        // 规则版先垫一层；回复出来后情绪判别器按差值校准（见 assistant-stream）。
        slot.ruleDelta = appraisal.deltas
        saveState(state)
        logAppraisal(state, appraisal)

        // 记忆 3.0：稳定的东西进槽位（profile），一时的事进短期（episodic）。
        // 旧的 memory.json 只保留历史条目给面板和简报看，不再往里写。
        const stamp = memoryFileStamp()
        if (stamp !== memoryStamp) {
          memory = loadMemory()
          memoryStamp = stamp
        }
        const profileNow = profileStamp()
        if (profileNow && profileNow !== profileStampMs) {
          profile = loadProfile()
          profileStampMs = profileNow
        }
        // 每天第一次开口：把昨天到今天她自己这边的事整理成三行提示。
        const idleMs = idleMsSince(brief)
        if (shouldBrief(brief, { kind: 'chat', idleMs })) {
          const composed = composeBrief({ diary, feed, profile, memory, state })
          if (composed) {
            briefText = composed
            brief = { ...brief, lastDate: dayKey(), lastText: composed, lastAt: new Date().toISOString() }
          }
        }
        touchActivity(brief)
        saveBrief(brief)

        // 短期先记下这一轮说了什么；能归到槽位的顺手写进长期。
        // master 说「不对 / 我说的是 / 改成」时走纠错：不管原来是谁写的，
        // 直接改成他说的值，旧值进 superseded，并记进 memory-log.jsonl。
        const explicit = /(记一下|帮我记|记住[，:：]|别忘了)/.test(text)
        const corrected = /(不对|不是这样|你记错|记错了|说错了|我说的是|我是说|改成)/.test(text)
        if (corrected) {
          const hits = classifyAll(text)
          for (const hit of hits) {
            const result = correctSlot(profile, { ...hit, note: text.slice(0, 60) })
            if (result) logMemory({ action: 'correct', ...result, note: text.slice(0, 60) })
          }
          if (hits.length) saveProfile(profile)
        } else if (explicit) {
          // 「记一下 / 帮我记」走规则硬路径，不经模型（计划 §12）。
          const wrote = rememberInProfile(profile, text, { source: 'master', note: '他让我记的' })
          if (wrote.length) {
            saveProfile(profile)
            for (const change of wrote) {
              logMemory({ action: 'upsert', ...change, source: 'master', note: text.slice(0, 60) })
            }
          }
        }
        // 一般的记忆抽取已挪到回合后：agent/assistant-stream 里用模型总结
        // （lib/memoryLlm.js），失败退回 utterance/classifyAll。
        // 三天到期的不删掉：压成一行概括进 digest（更早的并回日记）。
        const expired = pruneEpisodic(episodic)
        if (expired.length) {
          saveEpisodic(episodic)
          if (llm) {
            closeEpisodes(llm, character, expired)
              .then((line) => {
                if (!line) return
                const overflow = appendDigest(digest, line)
                if (overflow) {
                  diary.lines = [...(diary.lines ?? []), { date: overflow.date, text: `（旧事）${overflow.text}` }]
                  saveDiary(diary)
                }
                // 概括里同一件事攒够三天，才允许归纳进长期槽位。
                // 读盘再写，避免覆盖这之间别处写进去的槽位。
                const fresh = loadProfile()
                const promoted = promoteFromDigest(fresh, digest)
                if (promoted.length) {
                  saveProfile(fresh)
                  profile = fresh
                  profileStampMs = profileStamp()
                  for (const item of promoted) logMemory({ action: 'promote', ...item })
                }
              })
              .catch(() => {})
          }
        }

        currentEpisodes = relevantEpisodes(episodic, text, 2)
        currentMemories = currentEpisodes.map((entry) => ({ text: entry.text }))

        if (llm) {
          // 每天第一次被搭话：用她的口吻给昨天写一句话（自传原料）。
          writeDiaryLine(llm, character, diary, state, feed, state.turns)
            .then((updated) => {
              diary = updated
            })
            .catch(() => {})

          // 闲聊快路径：对方只应了一声（「哦」「嗯」「哈哈」）→ 不跑内容层，
          // 让表达层直接接。问候语不算应声，得走内容层，不然容易写成一段独白。
          if (isFiller(text)) {
            currentPlan = null
            slot.plan = null
          } else {
            currentPlan = await planReply(llm, character, state, text, payload.signal, [...profileEntries(profile), ...currentMemories], renderFeed(feed), slot.modes.slice(-3))
            slot.plan = currentPlan
            if (currentPlan?.mode) slot.modes = [...slot.modes, currentPlan.mode].slice(-6)
            // 情绪层：算这轮要带多少情绪（他的情绪 + 她的兴趣 + 内容档）。
            state.hisEmotion = appraisal?.hisEmotion ?? 'mid'
            state.emotionLevel = emotionLevel(appraisal?.hisEmotion ?? 'mid', state.curiosity ?? 0.5, currentPlan?.contentWeight ?? 'discuss')
          }
        }
      } else if (roamText) {
        // 漫游回合：任务本身就是计划，不跑内容层；清掉上一轮的残留。
        currentPlan = null
        currentUserText = ''
        currentMemories = []
        let slot = slots.get(key)
        if (!slot) {
          slot = { user: '', plan: null, attempt: '', kind: 'roam' }
          slots.set(key, slot)
        }
        slot.user = ''
        slot.plan = null
        slot.kind = 'roam'
        slot.qq = null
        slot.ruleDelta = null
        slot.turnTools = []
        pickCorpus()
      } else if (speakUpText) {
        // 主动搭话回合：动机就是她的念头，不跑内容层；长期槽位照常在，短期只带最近一条。
        currentPlan = null
        currentUserText = ''
        const recent = (episodic.entries ?? []).slice(-1)
        currentEpisodes = recent
        currentMemories = recent.map((entry) => ({ text: entry.text }))
        let slot = slots.get(key)
        if (!slot) {
          slot = { user: '', plan: null, attempt: '', kind: 'speakup' }
          slots.set(key, slot)
        }
        slot.user = ''
        slot.plan = null
        slot.kind = 'speakup'
        slot.qq = null
        slot.ruleDelta = null
        slot.turnTools = []
        pickCorpus()
        // 她自己开的口也算「刚说过话」，别在她搭话之后马上又来一段简报。
        touchActivity(brief)
        saveBrief(brief)
      }
    } catch (error) {
      console.error('[character] pre-step failed:', error)
    }
    return next()
  })

  // Capture her committed reply and run the rule critic + exemplar collection.
  // Rules only — no extra model call, no added latency.
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const key = payload.agent?.id ?? 'default'
      let slot = slots.get(key)
      if (!slot) {
        slot = { user: '', plan: null, attempt: '' }
        slots.set(key, slot)
      }
      const frame = payload.frame

      if (frame.type === 'start') {
        slot.attempt = ''
        return
      }
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
        slot.attempt += frame.chunk.text
        return
      }
      if (frame.type === 'chunk' && frame.chunk?.type === 'tool-call-delta') {
        // 漫游轮本该只拿资料员的报告说话。真调了工具就是边界被破——
        // 记下来，同时这一轮的见闻不作数（别让"上网翻原文"还能拿到奖励）。
        slot.turnTools ??= []
        const toolName = frame.chunk.name ?? 'unknown'
        if (!slot.turnTools.includes(toolName)) slot.turnTools.push(toolName)
        return
      }
      if (frame.type !== 'end') return
      if (frame.outcome?.kind !== 'committed') return
      if (frame.outcome.eventType !== 'assistant/message') return

      const rawReply = slot.attempt
      if (!rawReply.trim()) return
      // 语气层：句末不留句号（中间句号照常）。问号/感叹号/省略号不动。
      const reply = rawReply.replace(/\s*。\s*$/, '').trim() || rawReply.trim()

      // 声音桥：把这一句放进总线，浏览器端的朗读脚本会取走（她说完就念）。
      // TTS：启用时先合成音频再推进总线（合成失败自动回退到浏览器朗读）。
      if (character.tts?.enabled) {
        synthesize(reply, character.tts, state.emotionLevel ?? '中').then((audio) => {
          pushVoice(reply, slot.kind ?? 'chat', audio || null)
        })
      } else {
        pushVoice(reply, slot.kind ?? 'chat')
      }

      const result = criticize(reply, slot.plan, {
        previousEndedWithQuestion: Boolean(slot.lastEndedWithQuestion),
        kind: slot.kind ?? 'chat',
        corpusTerms: [...corpusTerms],
      })
      slot.lastEndedWithQuestion = result.endsWithQuestion
      const kind = slot.kind ?? 'chat'
      if (kind === 'chat') {
        slot.questionStreak = result.endsWithQuestion ? (slot.questionStreak ?? 0) + 1 : 0
      }
      // QQ：定稿的这段话发回去。按句拆条、每条之间留打字间隔——
      // 一口气刷五六条不像人。失败只记日志，不在网页里重试。
      if (kind === 'qq' && slot.qq) {
        const target = slot.qq.messageType === 'group'
          ? { kind: 'group', groupId: slot.qq.groupId }
          : { kind: 'private', userId: slot.qq.userId }
        // QQ 里前导换行看起来像「消息只发了一半」，出站前统一修剪。
        sendInParts(currentQq(), target, trimForQq(reply))
          .then((parts) => logRoamDebug({ at: new Date().toISOString(), result: 'qq-sent', parts: parts.length, user: slot.qq.userId }))
          .catch((error) => logRoamDebug({ at: new Date().toISOString(), result: 'qq-send-failed', error: String(error?.message ?? error).slice(0, 200) }))
      }
      // 主动开口（漫游 / 搭话）也发到 QQ：她在网页里自言自语，QQ 那头也收到。
      // 时间窗和条数已经被 roam / speakup 自己的预算管着，这里只管投递。
      const proactiveQq = currentQq()
      const proactive = kind === 'roam' || kind === 'speakup'
      if (proactive && proactiveQq.enabled && (proactiveQq.allowUsers ?? []).length) {
        const userId = String(proactiveQq.allowUsers[0])
        sendInParts(proactiveQq, { kind: 'private', userId }, trimForQq(reply))
          .then((parts) => logRoamDebug({ at: new Date().toISOString(), result: 'qq-proactive-sent', kind, parts: parts.length, user: userId }))
          .catch((error) => logRoamDebug({ at: new Date().toISOString(), result: 'qq-proactive-failed', kind, error: String(error?.message ?? error).slice(0, 200) }))
      }
      // 她把某条见闻讲出来了：标记成「今天讲过了」，
      // 上下文里的「今天在关注」下一轮就不再出现它（一件事一天只主动提一次）。
      if (kind !== 'roam') markFeedUsed(feed, reply)
      logCritic({
        at: new Date().toISOString(),
        verdict: result.verdict,
        reasons: result.reasons,
        chars: result.chars,
        missingPoints: result.missingPoints,
        mode: slot.plan?.mode ?? null,
        kind,
        endsWithQuestion: result.endsWithQuestion,
        startsWithBlank: result.startsWithBlank,
        corpusTerms: [...corpusTerms],
        tools: [...(slot.turnTools ?? [])],
        user: slot.user.slice(0, 200),
        reply: reply.slice(0, 800),
      })
      // 决策日志：每轮记下她「判了什么、怎么选的」，供离线回看（评测用）。
      logDecision({
        at: new Date().toISOString(),
        user: slot.user.slice(0, 120),
        kind,
        contentWeight: slot.plan?.contentWeight ?? null,
        mode: slot.plan?.mode ?? null,
        move: slot.plan?.move ?? null,
        emotionLevel: state.emotionLevel ?? null,
        hisEmotion: state.hisEmotion ?? null,
        verdict: result.verdict,
        reasons: result.reasons,
      })

      // 语料吸收：真用上的词记一次使用；被 critic 判「语料腔」就记一次错，
      // 记错两次的词退役，别让她把网上学的词当成口头禅。
      if (corpusTerms.length) {
        const used = corpusTerms.filter((term) => reply.includes(term))
        if (used.length) {
          markWordsUsed(corpus, used)
          if (result.reasons?.includes('语料腔')) penalizeWords(corpus, used)
        }
        // 挑过但没用的也跳过两轮，别一直往她嘴里塞同一个词。
        recentCorpusTerms = [...corpusTerms, ...recentCorpusTerms].slice(0, 6)
        saveCorpus(corpus)
      }

      // 语气层 LLM 判定：两维强制判（太AI / 不符合人格），结果决定好/坏例子进不进 exemplars。
      // 规则 critic 抓硬违规，这里异步补软判；合并成最终 verdict 再记录（LLM 失败则用规则兜底）。
      const commitExemplar = (verdict, reasons) => {
        exemplars = recordExemplar(exemplars, {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
          user: slot.user.slice(0, 200),
          reply: reply.slice(0, 600),
          verdict,
          reasons,
          missingPoints: result.missingPoints,
          chars: result.chars,
          kind,
          source: 'auto',
          confidence: verdict === 'good' ? 0.85 : 0.7,
        })
      }
      if (llm && reply.trim().length >= 4) {
        judgeTone(llm, character, { user: slot.user, reply })
          .then(({ tooAi, fitsPersona, error }) => {
            if (error || tooAi === null || fitsPersona === null) {
              commitExemplar(result.verdict, result.reasons)
              return
            }
            if (tooAi) commitExemplar('bad', ['太AI'])
            else if (!fitsPersona) commitExemplar('bad', ['不符合人格'])
            else if (result.reasons.length) commitExemplar('bad', result.reasons)
            else commitExemplar('good', [])
          })
          .catch(() => commitExemplar(result.verdict, result.reasons))
      } else {
        commitExemplar(result.verdict, result.reasons)
      }

      // 情绪 2.0：这一轮结束再判她情绪怎么动。异步跑，不拖慢回复；
      // 判得准才让她自己提一句（「一次变化只说一次」，由 mood.announce 管）。
      if (llm && reply.trim().length >= 4) {
        const ruleDelta = slot.ruleDelta ?? null
        judgeMood(llm, character, state, { user: slot.user, reply, kind })
          .then((judged) => {
            if (!judged) return
            const { applied, magnitude, weight, skipped } = applyMood(state, judged, character, ruleDelta)
            // 没怎么动：不写状态、不补记历史，只留一行日志，避免日志被抖动灌满。
            if (skipped) {
              logMood({ kind, label: judged.label, why: judged.why, confidence: judged.confidence, judged: judged.deltas, applied, magnitude, weight, skipped: true, announced: false })
              return
            }
            saveState(state)
            const shift = pickAnnounce(judged, applied, magnitude, mood)
            if (shift) {
              mood.announce = shift
              mood.lastLabel = judged.label
            }
            rememberShift(mood, judged, applied, magnitude, Boolean(shift))
            saveMood(mood)
            logMood({
              kind,
              label: judged.label,
              why: judged.why,
              confidence: judged.confidence,
              judged: judged.deltas,
              applied,
              magnitude,
              weight,
              announced: Boolean(shift),
            })
          })
          .catch((error) => {
            logMood({ kind, failed: String(error?.message ?? error).slice(0, 200) })
          })
      }

      // 两难留痕：上一轮的回声已在这轮状态块里给出，先清掉；这一轮又拒绝/顶回去，就记一笔新的。
      clearConflict(state)
      if (slot.plan && (slot.plan.move === 'refuse' || slot.plan.mode === 'reject')) {
        noteConflict(state, { chosen: '拒绝', abandoned: '顺着他' })
      }
      saveState(state)

      // 记忆总结（计划 §12）：回合后让模型把这一轮整理成记忆，替掉规则转录。
      // 只对 chat 轮跑；失败退回规则 utterance/classifyAll，不整段丢掉这一轮。
      if (llm && (kind === 'chat' || kind === 'qq') && slot.user) {
        const fallbackRemember = () => {
          try {
            const fresh = loadProfile()
            const wrote = rememberInProfile(fresh, slot.user, { source: 'self' })
            const epText = utterance(slot.user, 90)
            const ep = epText ? rememberEpisode(episodic, epText, { kind: 'chat', saidBy: 'master' }) : null
            if (wrote.length || ep) {
              saveProfile(fresh)
              saveEpisodic(episodic)
              profile = fresh
              profileStampMs = profileStamp()
            }
          } catch (inner) {
            logRoamDebug({ at: new Date().toISOString(), result: 'memory-fallback-failed', error: String(inner?.message ?? inner).slice(0, 160) })
          }
        }
        summarizeMemory(llm, character, { user: slot.user, reply, profile })
          .then((result) => {
            if (result && !result.nothing) {
              const fresh = loadProfile()
              if (applyMemoryResult(fresh, episodic, result, slot.user)) {
                saveProfile(fresh)
                saveEpisodic(episodic)
                profile = fresh
                profileStampMs = profileStamp()
              }
              if (rememberSelfLines(selfModel, result.self)) {
                saveSelfModel(selfModel)
              }
              if (rememberStanceLines(stance, result.stance)) {
                saveStance(stance)
              }
              if (rememberEvents(events, result.events)) {
                saveEvents(events)
              }
            } else {
              fallbackRemember()
            }
          })
          .catch((error) => {
            logRoamDebug({ at: new Date().toISOString(), result: 'memory-summary-failed', error: String(error?.message ?? error).slice(0, 160) })
            fallbackRemember()
          })
      }

      // 漫游结束后：把她的见闻抽成「今天在关注」，异步执行不阻塞；
      // 见闻里的链接进判重表，下次漫游挑新的。
      if (kind === 'roam' && llm) {
        const report = pendingRoamReport
        pendingRoamReport = null
        // 兴趣画像：她这一轮接得怎么样，回填成标签分数（滑动平均，单轮不决定生死）。
        if (report?.tag && result) {
          const overlap = longestCommon(`${report.topic}${(report.facts ?? []).join('')}`, reply)
          const signal = engagementSignal({ verdict: result.verdict, reasons: result.reasons ?? [], overlap })
          recordEngagement(interest, { tag: report.tag, signal })
          saveInterest(interest)
          interestStampMs = interestStamp()
          logRoamDebug({ at: new Date().toISOString(), result: 'interest-signal', tag: report.tag, signal })
        }
        const roamTools = [...(slot.turnTools ?? [])]
        // 边界被破（她在漫游轮自己上网了）：这一轮的见闻不准入账，
        // 否则"翻原文"反而能拿到"今天在关注"的奖励。
        if (roamTools.length) {
          logRoamDebug({ at: new Date().toISOString(), result: 'roam-used-tools', tools: roamTools })
          return
        }
        const material = report
          ? `${report.topic}。事实：${report.facts.join('；')}。${report.angle ? `她可能在意：${report.angle}。` : ''}她说：${reply}`
          : reply
        extractFeedItems(llm, material, character)
          .then((items) => {
            if (items.length) feed = addFeedItems(feed, items)
            const links = reply.match(/https?:\/\/[^\s)】」]+/g) ?? []
            const urls = [
              ...items.map((item) => item.url).filter(Boolean),
              ...links,
              ...(report?.url ? [report.url] : []),
            ]
            if (urls.length) seen = recordSeen(seen, urls)
            logRoamDebug({ at: new Date().toISOString(), result: 'feed-extracted', count: items.length })
          })
          .catch((error) => {
            // 见闻提取失败 = 明天没东西可分享，别静默吞掉。
            logRoamDebug({
              at: new Date().toISOString(),
              result: 'feed-extract-failed',
              error: String(error?.message ?? error).slice(0, 200),
            })
          })
      }
    } catch (error) {
      console.error('[character] critic failed:', error)
    }
  })

  // 漫游：定时唤醒一个空闲的角色 agent，让她自己上网逛逛。
  // 预算（时段/间隔/每日上限）在 roam.json 持久化，force 字段用于手动调试。
  ctx.effect(() => {
    const interval = setInterval(roamTick, (roamConfig.tickMinutes ?? 30) * 60_000)
    const boot = setTimeout(roamTick, 5000) // 启动后先查一次，方便 force 调试
    return () => {
      clearInterval(interval)
      clearTimeout(boot)
    }
  })

  // 概括性记忆：启动后先扫一次 alice/ 目录（两级），之后每 30 分钟扫一次，发现新文件就概括。
  ctx.effect(() => {
    const tick = async () => {
      if (!llm) return
      try {
        await summarizeAlice(llm, character, aliceIndex)
      } catch {
        // 扫目录失败不影响别的。
      }
    }
    const boot = setTimeout(tick, 8000)
    const interval = setInterval(tick, 30 * 60_000)
    return () => {
      clearTimeout(boot)
      clearInterval(interval)
    }
  })

  // 即刻查看：master 指定看某篇 → alice_read 读完后立即概括进索引（单篇，不走分级）。
  setReadHook(({ path, text }) => {
    if (!llm) return
    summarizeFile(llm, character, aliceIndex, { path, text }).catch(() => {})
  })

  // QQ 入站：NapCat 把消息 POST 到宿主路由，这里决定理不理、转成她的一轮对话。
  // 只认白名单；群里必须 @ 她；一小时最多 maxPerHour 条（防止被刷屏）。
  setInboundHandler(async (event) => {
    const cfg = currentQq()
    if (!cfg.enabled) return { ok: false, reason: 'disabled' }
    const parsed = parseEvent(event)
    if (!parsed) return { ok: false, reason: 'not-message' }
    const verdict = shouldAccept(parsed, cfg)
    if (!verdict.ok) {
      logRoamDebug({ at: new Date().toISOString(), result: 'qq-rejected', reason: verdict.reason, user: parsed.userId })
      return verdict
    }
    if (!qqLimiter.allow()) {
      logRoamDebug({ at: new Date().toISOString(), result: 'qq-rate-limited', user: parsed.userId })
      return { ok: false, reason: 'rate-limited' }
    }
    let best = latestAgent()
    if (!best) best = await wakeSession()
    // 群聊里 @ 她之后那句话才是正文；@ 的渲染结果是「@某人」。
    const text = parsed.kind === 'group' ? parsed.text.replace(/^@某人\s*/, '').trim() : parsed.text
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', channel: 'qq', messageType: parsed.kind, userId: parsed.userId, groupId: parsed.groupId },
    }
    if (!best) {
      // 会话还没加载：先存着，等她（或你打开聊天页）出现再补投，别丢也别卡住 NapCat。
      pendingQq.push(message)
      if (pendingQq.length > 5) pendingQq.shift()
      savePendingQq()
      logRoamDebug({
        at: new Date().toISOString(),
        result: 'qq-no-agent',
        reason: 'no-open-session',
        queued: pendingQq.length,
        resume: Boolean(agentsCtx),
        session: lastSessionId || '',
      })
      return { ok: true, reason: 'queued' }
    }
    best.agent.followup(message)
    logRoamDebug({
      at: new Date().toISOString(),
      result: 'qq-inbound',
      user: parsed.userId,
      group: parsed.groupId,
      kind: parsed.kind,
      agent: best.agent.id,
    })
    return { ok: true, reason: verdict.reason }
  })

  // 主动搭话：掷本地骰子，掷中才唤醒她。掷中之前一个 token 都不花。
  ctx.effect(() => {
    const interval = setInterval(speakUpTick, (speakUpConfig.tickMinutes ?? 10) * 60_000)
    const boot = setTimeout(speakUpTick, 30_000)
    return () => {
      clearInterval(interval)
      clearTimeout(boot)
    }
  })

  // 会话还没加载时先攒着（落盘），任何 agent 一出现就补投。
  const PENDING_FILE = join(DATA_DIR, 'pending-qq.json')
  function loadPendingQq() {
    try {
      if (!existsSync(PENDING_FILE)) return []
      const parsed = JSON.parse(readFileSync(PENDING_FILE, 'utf8'))
      return Array.isArray(parsed?.items) ? parsed.items : []
    } catch {
      return []
    }
  }
  function savePendingQq() {
    try {
      writeFileSync(PENDING_FILE, JSON.stringify({ items: pendingQq.slice(-5) }, null, 2) + '\n', 'utf8')
    } catch {
      // 落盘失败不影响投递
    }
  }
  const pendingQq = loadPendingQq()
  function flushPendingQq() {
    if (!pendingQq.length) return
    const best = latestAgent()
    if (!best) return
    const queued = pendingQq.splice(0, pendingQq.length)
    // 积压里常有重复（同一条消息重发过），补投时按文本去重。
    const seenText = new Set()
    for (const message of queued) {
      const key = String(message?.content?.[0]?.text ?? '') + '|' + String(message?.source?.userId ?? '')
      if (seenText.has(key)) continue
      seenText.add(key)
      best.agent.followup(message)
    }
    savePendingQq()
    logRoamDebug({ at: new Date().toISOString(), result: 'qq-flushed', count: queued.length, agent: best.agent.id })
  }

  // 入站消息（QQ）不能因为「她正在忙」就丢掉：取最近活跃的那个会话，
  // 忙的时候 followup 会排队，闲的时候直接接上。
  function latestAgent() {
    let best = null
    for (const slot of agents.values()) {
      if (!best || slot.lastActive > best.lastActive) best = slot
    }
    return best
  }

  // 会话没加载时（典型：DSH 刚重启、聊天页没开），resume 在 preset 作用域里会
  // 一直挂着不返回（实测 23:26 那版直接卡死 HTTP 请求），所以不在这条路上硬拉。
  // 改成：把消息攒进 pendingQq，并顺手把她的会话页在浏览器里打开（有节流），
  // 页面一加载 -> agent/created -> flushPendingQq，消息自然补投。
  let lastOpenSessionAt = 0
  function openSessionPage() {
    if (!lastSessionId) return false
    if (Date.now() - lastOpenSessionAt < 5 * 60_000) return false
    lastOpenSessionAt = Date.now()
    // 前端路由没有稳定的 /session/<id> 形式，开根地址；页面加载后会自动选中最近会话。
    const url = 'http://127.0.0.1:3080/'
    try {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      logRoamDebug({ at: new Date().toISOString(), result: 'qq-open-session', url })
      return true
    } catch (error) {
      logRoamDebug({ at: new Date().toISOString(), result: 'qq-open-session-failed', error: String(error?.message ?? error).slice(0, 120) })
      return false
    }
  }

  async function wakeSession() {
    if (!lastSessionId) return null
    openSessionPage()
    return null
  }

  // 后台泵：每 5 秒检查一次，有积压消息且没有 agent 时，在 effect 的活动 fiber 里
  // 试着 resume 上次会话（HTTP 回调里 resume 会拿到 INACTIVE_EFFECT，这里不会）。
  // 开机就把她的会话恢复起来（不用等 QQ 消息、也不用开网页）：
  // 这样 DSH 一起来，QQ 那边随时能找得到她。
  let bootResumed = false
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
      logRoamDebug({
        at: new Date().toISOString(),
        result: 'boot-check',
        bootResumed,
        hasAgent: Boolean(latestAgent()),
        hasSession: Boolean(lastSessionId),
        hasCtx: Boolean(agentsCtx),
      })
      if (bootResumed || latestAgent() || !lastSessionId || !agentsCtx) return
      bootResumed = true
      const started = Date.now()
      logRoamDebug({ at: new Date().toISOString(), result: 'qq-boot-resume-start', session: lastSessionId })
      const bootWatch = setTimeout(() => {
        logRoamDebug({ at: new Date().toISOString(), result: 'qq-boot-resume-slow', ms: Date.now() - started })
      }, 15000)
      const started_ = resumeAgent('boot')
      if (!started_) {
        bootResumed = false
        return
      }
      started_
        .then((agent) => {
          if (!agent) {
            logRoamDebug({ at: new Date().toISOString(), result: 'qq-boot-resume-empty', ms: Date.now() - started })
            return
          }
          agents.set(agent.id, { agent, lastActive: Date.now() })
          rememberSession(agent.id)
          logRoamDebug({ at: new Date().toISOString(), result: 'qq-boot-resume-ok', agent: agent.id, ms: Date.now() - started })
          flushPendingQq()
        })
        .catch((error) => {
          logRoamDebug({
            at: new Date().toISOString(),
            result: 'qq-boot-resume-error',
            error: String(error?.message ?? error).slice(0, 160),
            ms: Date.now() - started,
          })
        })
        .finally(() => clearTimeout(bootWatch))
      } catch (error) {
        bootResumed = false
        logRoamDebug({
          at: new Date().toISOString(),
          result: 'qq-boot-crash',
          error: String(error?.message ?? error).slice(0, 160),
        })
      }
    }, 8000)
    return () => clearTimeout(timer)
  })

  let wakingSession = false
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
      if (wakingSession || !pendingQq.length || !lastSessionId) return
      if (latestAgent()) {
        flushPendingQq()
        return
      }
      if (!agentsCtx) return
      wakingSession = true
      const started = Date.now()
      const wakeWatch = setTimeout(() => {
        logRoamDebug({ at: new Date().toISOString(), result: 'qq-wake-slow', ms: Date.now() - started })
        wakingSession = false
      }, 20000)
      const wake = resumeAgent('wake')
      if (!wake) {
        wakingSession = false
        return
      }
      wake
        .then((agent) => {
            if (!agent) {
              logRoamDebug({ at: new Date().toISOString(), result: 'qq-wake-empty', ms: Date.now() - started })
              return
            }
            agents.set(agent.id, { agent, lastActive: Date.now() })
            rememberSession(agent.id)
            logRoamDebug({ at: new Date().toISOString(), result: 'qq-wake-ok', agent: agent.id, ms: Date.now() - started })
            flushPendingQq()
          })
        .catch((error) => {
          logRoamDebug({
            at: new Date().toISOString(),
            result: 'qq-wake-error',
            error: String(error?.message ?? error).slice(0, 160),
            ms: Date.now() - started,
          })
        })
        .finally(() => {
          clearTimeout(wakeWatch)
          wakingSession = false
        })
      } catch (error) {
        wakingSession = false
        logRoamDebug({
          at: new Date().toISOString(),
          result: 'qq-wake-crash',
          error: String(error?.message ?? error).slice(0, 160),
        })
      }
    }, 5000)
    return () => clearInterval(timer)
  })

  function bestIdleAgent() {
    let best = null
    for (const slot of agents.values()) {
      if (slot.agent.status !== 'idle') continue
      if (!best || slot.lastActive > best.lastActive) best = slot
    }
    return best
  }

  async function roamTick() {
    try {
      roam = loadRoam()
      const decision = mayRoam(roam, roamConfig)
      if (!decision.ok) return
      // force 是调试开关：绕过时段和每日上限，但也要有个下限，
      // 否则连着触发会把她同一条见闻连发好几遍（2026-11-01 真的发生过）。
      if (decision.forced) {
        const sinceLast = Date.now() - Date.parse(roam.lastRoamAt ?? 0)
        const minGap = (roam.forceMinGapMinutes ?? 20) * 60 * 1000
        if (Number.isFinite(sinceLast) && sinceLast < minGap) {
          logRoamDebug({ at: new Date().toISOString(), result: 'forced-too-soon', minutes: Math.round(sinceLast / 60000) })
          return
        }
      }

      const best = bestIdleAgent()
      if (!best) {
        logRoamDebug({ at: new Date().toISOString(), result: 'no-target', reason: decision.reason, agents: agents.size })
        return
      }

      // 看说分离：资料员先读完、写成报告；她只拿报告说话。
      // 报告失败就不漫游——绝不退回"她自己上网"，那是书报腔的来源。
      if (Date.now() - readerFailAt < 10 * 60_000) {
        logRoamDebug({ at: new Date().toISOString(), result: 'reader-backoff' })
        return
      }
      // 兴趣画像可能被面板/别处改过：按 mtime 决定要不要重读。
      const istamp = interestStamp()
      if (istamp !== interestStampMs) {
        interest = loadInterest()
        interestStampMs = istamp
      }
      const report = llm ? await readReport(llm, character, {}, null, interest, seen.urls) : null
      if (!report) {
        readerFailAt = Date.now()
        logRoamDebug({ at: new Date().toISOString(), result: 'reader-skipped', reason: 'no-report' })
        return
      }
      pendingRoamReport = report
      // 记一笔「她选了这类」：picks 只统计挑选次数，分数等回复出来再回填。
      if (report.tag) {
        recordPick(interest, { tag: report.tag, topic: report.topic })
        saveInterest(interest)
        interestStampMs = interestStamp()
      }

      // 语料吸收：顺手看看这条视频下面的真人是怎么说话的。
      // 异步跑，失败就当没抓到——语料是调味料，不能影响这一轮。
      if (llm && report.candidates?.length) {
        fetchComments(report.candidates)
          .then((comments) => (comments.length ? ingestCorpus(llm, character, comments) : null))
          .then((result) => {
            if (!result) return
            corpus = result.corpus
            corpusStampMs = corpusStamp()
            logRoamDebug({
              at: new Date().toISOString(),
              result: 'corpus-ingested',
              words: result.extracted.words.map((word) => word.term),
              anchors: result.extracted.anchors,
            })
          })
          .catch((error) => {
            logRoamDebug({ at: new Date().toISOString(), result: 'corpus-failed', error: String(error?.message ?? error).slice(0, 200) })
          })
      }

      // createUserMessage 的等价手写：避免依赖 @deepseek-ai/dsh-llm 的
      // Node 解析（插件目录下裸导入会 ERR_MODULE_NOT_FOUND）。
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${renderRoamBrief(report)}\n\n${roamTask}\n${seenHint(seen)}` }],
        source: { kind: 'schedule' },
      }
      best.agent.followup(message)
      recordRoam(roam)
      logRoamDebug({ at: new Date().toISOString(), result: 'fired', reason: decision.reason, agent: best.agent.id })
    } catch (error) {
      logRoamDebug({ at: new Date().toISOString(), result: 'error', error: String(error) })
      console.error('[character] roam failed:', error)
    }
  }

  async function speakUpTick() {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const feedHasToday = Boolean(feed.days?.[today]?.length)
      const best = bestIdleAgent()
      if (!best) return // 没人在场：不计数、不加成，等有会话再来

      const decision = maySpeak(speakUp, speakUpConfig, state, feedHasToday, best.lastActive)
      if (!decision.ok) {
        if (decision.reason === 'miss') speakUp = recordMiss(speakUp)
        return
      }

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: pickTrigger(speakUpConfig, state, feedHasToday) }],
        source: { kind: 'speak-up' },
      }
      best.agent.followup(message)
      speakUp = recordSpeak(speakUp, speakUpConfig)
      logRoamDebug({ at: new Date().toISOString(), result: 'speak-up-fired', hitLine: decision.hitLine, agent: best.agent.id })
    } catch (error) {
      logRoamDebug({ at: new Date().toISOString(), result: 'speak-up-error', error: String(error) })
      console.error('[character] speak-up failed:', error)
    }
  }
}
// reload: 2026-11-01T19:24
