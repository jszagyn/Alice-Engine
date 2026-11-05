import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// 允许指到临时目录（测试/沙箱用），默认仍是插件自己的 data/。
const DATA = process.env.DSH_CHARACTER_DATA ?? join(ROOT, 'data')

const read = (name) => {
  const path = join(DATA, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

const lines = (name) => {
  const raw = read(name)
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

const json = (name) => {
  const raw = read(name)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const tally = (records, keyOf) => {
  const counts = {}
  for (const record of records) {
    const key = keyOf(record)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

console.log('===== 爱丽丝 · 观察期统计 =====')

const appraisal = lines('appraisal.jsonl')
console.log(`\n[评价] ${appraisal.length} 轮`)
for (const [tag, count] of tally(appraisal, (r) => r.reason)) console.log(`  ${count.toString().padStart(4)}  ${tag}`)

const critic = lines('critic.jsonl')
console.log(`\n[判别] ${critic.length} 条`)
for (const [kind, count] of tally(critic, (r) => r.kind ?? 'chat')) console.log(`  ${count.toString().padStart(4)}  kind=${kind}`)
const bad = critic.filter((r) => r.verdict === 'bad')
console.log(`  坏例 ${bad.length} 条，原因分布：`)
for (const [reason, count] of tally(bad, (r) => (r.reasons ?? []).join('+'))) console.log(`  ${count.toString().padStart(4)}  ${reason}`)
const blankRows = critic.filter((r) => r.startsWithBlank === true)
if (blankRows.length) {
  const recent = critic.slice(-20).filter((r) => r.startsWithBlank === true).length
  console.log(`  开头空行 ${blankRows.length}/${critic.length} 条（最近 20 条里 ${recent} 条）——只计数，不判坏`)
}

const exemplars = json('exemplars.json')
if (exemplars) {
  console.log(`\n[示例库] good=${exemplars.good?.length ?? 0}  bad=${exemplars.bad?.length ?? 0}`)
  const badReasons = {}
  for (const entry of exemplars.bad ?? []) {
    for (const reason of entry.reasons ?? []) badReasons[reason] = (badReasons[reason] ?? 0) + 1
  }
  for (const [reason, count] of Object.entries(badReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${reason}`)
  }
}

const memory = json('memory.json')
if (memory) {
  const active = memory.filter((e) => e.status === 'active')
  const facts = active.filter((e) => e.tier === 'fact')
  const confirmed = active.filter((e) => e.confirmed)
  console.log(`\n[旧记忆库] 共 ${memory.length} 条：active=${active.length}（事实 ${facts.length}，已确认 ${confirmed.length}），superseded=${memory.filter((e) => e.status === 'superseded').length}，dormant=${memory.filter((e) => e.status === 'dormant').length}`)
  for (const entry of active.slice(0, 12)) {
    console.log(`  [${entry.tier}/${entry.kind}${entry.confirmed ? '/✓' : ''}] ${entry.text}`)
  }
}

// 记忆 3.0：长期槽位（稳定信息）+ 短期三天（一时的事）+ 概括（过期后压成一行）
const profile = json('profile.json')
if (profile?.slots) {
  const slots = Object.entries(profile.slots)
  console.log(`\n[长期] ${slots.length} 个槽位`)
  for (const [key, slot] of slots) {
    const marks = [slot.source === 'master' ? '他说的' : slot.source === 'inferred' ? `归纳的，${slot.days ?? 0} 天` : '她自己记的']
    if ((slot.mentions ?? 1) > 1) marks.push(`提过 ${slot.mentions} 次`)
    const shown = Array.isArray(slot.values) ? slot.values.join('、') : slot.value
    console.log(`  ${key.padEnd(14)} ${shown}（${marks.join('，')}）`)
  }
} else {
  console.log('\n[长期] 还没有槽位（profile.json 未生成）')
}

const episodic = json('episodic.json')
const episodes = episodic?.entries ?? []
if (episodes.length) {
  console.log(`\n[短期] ${episodes.length} 条（三天内，过期会压成一行概括）`)
  for (const entry of episodes.slice(-6)) {
    console.log(`  ${String(entry.at ?? '').slice(5, 16).replace('T', ' ')}  ${entry.text}`)
  }
} else {
  console.log('\n[短期] 空')
}

const digest = json('digest.json')
const digestLines = digest?.lines ?? []
if (digestLines.length) {
  console.log(`[概括] ${digestLines.length} 行（保留最近 30 行，更早的并进日记）`)
  for (const line of digestLines.slice(-3)) {
    console.log(`  ${line.date}  ${line.text}`)
  }
} else {
  console.log('[概括] 还没有（短期条目过期后才会压出来）')
}

// 记忆写入流水：谁在什么时候把槽位从什么改成什么（纠错证据）。
const memoryLogPath = join(DATA, 'memory-log.jsonl')
try {
  const rows = existsSync(memoryLogPath)
    ? readFileSync(memoryLogPath, 'utf8').split('\n').filter(Boolean).slice(-5).map((line) => JSON.parse(line))
    : []
  if (rows.length) {
    console.log(`[记忆日志] 最近 ${rows.length} 条（共 ${readFileSync(memoryLogPath, 'utf8').split('\n').filter(Boolean).length} 条）`)
    for (const row of rows) {
      const change = row.previous ? `${row.previous} → ${row.value}` : row.value
      console.log(`  ${String(row.at ?? '').slice(5, 16).replace('T', ' ')}  ${row.action}  ${row.key}  ${change ?? ''}`)
    }
  }
} catch {
  // 日志坏了不影响别的统计。
}

const roam = json('roam.json')
console.log(`\n[漫游] ${roam ? `今天 ${roam.counts?.[new Date().toISOString().slice(0, 10)] ?? 0} 次，上次 ${roam.lastRoamAt ?? '无'}` : '未开始'}`)

// 边界：漫游轮本该只说资料员的报告，不该自己上网。她真调了工具，说明
// 「你只负责说，不负责查」这条没兜住；这些轮次也不计入见闻（engine 里跳过）。
const roamRows = critic.filter((row) => row.kind === 'roam')
const roamToolRows = roamRows.filter((row) => (row.tools ?? []).length > 0)
console.log(`  边界：${roamRows.length} 条漫游回复里 ${roamToolRows.length} 条自己调了工具`)
for (const row of roamToolRows.slice(-5)) {
  console.log(`    ${String(row.at).slice(5, 16).replace('T', ' ')}  ${(row.tools ?? []).join(', ')}`)
}

const speakUp = json('speakup.json')
console.log(`[搭话] ${speakUp ? `今天 ${speakUp.counts?.[new Date().toISOString().slice(0, 10)] ?? 0} 次，连续没中 ${speakUp.misses ?? 0} 次` : '未开始'}`)

const feed = json('feed.json')
const today = new Date().toISOString().slice(0, 10)
console.log(`[见闻] 今天 ${feed?.days?.[today]?.length ?? 0} 条`)
for (const item of feed?.days?.[today] ?? []) console.log(`  - ${item.topic}（${item.take}）`)

// 看说分离：资料员读原文写报告，她只看报告。这里查两件事——
// 报告有没有产出、她的漫游回复是在用报告的话还是原文的话。
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

const readerLog = lines('reader.jsonl')
if (readerLog.length) {
  const ok = readerLog.filter((r) => r.result === 'ok')
  const failed = readerLog.filter((r) => r.result !== 'ok')
  const reasons = tally(failed, (r) => r.result)
  console.log(`\n[资料员] 报告 ${ok.length} 份，没出报告 ${failed.length} 次${reasons.length ? `（${reasons.map(([k, n]) => `${k}×${n}`).join('，')}）` : ''}`)
  for (const r of ok.slice(-3)) console.log(`  ${r.at.slice(5, 16)} ${r.report?.topic ?? ''}`)

  const roamReplies = critic.filter((r) => r.kind === 'roam' && r.reply)
  const rows = []
  for (const entry of roamReplies) {
    const at = Date.parse(entry.at ?? 0)
    const match = ok
      .map((r) => ({ r, delta: Math.abs(Date.parse(r.at) - at) }))
      .filter(({ delta }) => delta <= 15 * 60_000)
      .sort((a, b) => a.delta - b.delta)[0]
    if (!match) continue
    const rawText = (match.r.candidates ?? []).map((c) => `${c.topic} ${c.desc}`).join(' ')
    const reportText = [match.r.report?.topic, ...(match.r.report?.facts ?? []), match.r.report?.angle].join(' ')
    rows.push({
      at: entry.at,
      raw: longestCommon(entry.reply, rawText),
      report: longestCommon(entry.reply, reportText),
    })
  }
  if (rows.length) {
    const copied = rows.filter((row) => row.raw >= 8).length
    const avgRaw = (rows.reduce((sum, row) => sum + row.raw, 0) / rows.length).toFixed(1)
    const avgReport = (rows.reduce((sum, row) => sum + row.report, 0) / rows.length).toFixed(1)
    console.log(`  照搬原文 ${copied}/${rows.length} 条（最长连续重合 ≥8 字），平均与原文重 ${avgRaw} 字 / 与报告重 ${avgReport} 字`)
  }
}

// 语料吸收：从真人评论里学的词有多少、在用的是哪几个、有没有被 critic 抓过。
const corpus = json('corpus.json')
const corpusWords = Object.values(corpus?.words ?? {})
if (corpusWords.length) {
  const label = { active: '在用', watch: '观察', retired: '退役' }
  const byTier = tally(corpusWords, (word) => word.tier)
  console.log(`\n[语料] ${corpusWords.length} 个词：${byTier.map(([k, n]) => `${label[k] ?? k} ${n}`).join('，')}；语气锚点 ${corpus?.anchors?.length ?? 0} 条`)
  const stats = corpus?.stats ?? {}
  console.log(`  上次吸收：${stats.lastExtractAt ? stats.lastExtractAt.slice(5, 16).replace('T', ' ') : '还没抓到'}（评论 ${stats.comments ?? 0} 条，抽 ${stats.extracted ?? 0} 收 ${stats.accepted ?? 0}）`)
  const active = corpusWords.filter((word) => word.tier === 'active').sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0)).slice(0, 6)
  if (active.length) console.log(`  在用：${active.map((word) => `${word.term}(${word.uses ?? 0}次${word.flags ? `/${word.flags}错` : ''})`).join('、')}`)
  const badCorpus = critic.filter((row) => (row.reasons ?? []).includes('语料腔')).length
  console.log(`  语料腔 ${badCorpus} 条`)
}

// 兴趣画像：她愿意看什么，标签分数怎么变。
const interest = json('interest.json')
const interestTags = Object.entries(interest?.tags ?? {})
  .map(([tag, entry]) => ({ tag, ...entry }))
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
if (interestTags.length) {
  console.log(`\n[兴趣] 挑过 ${interest?.picks ?? 0} 次，${interestTags.length} 个标签`)
  for (const entry of interestTags.slice(0, 6)) {
    const sign = (entry.score ?? 0) >= 0 ? '+' : ''
    console.log(`  ${entry.tag}  ${sign}${(entry.score ?? 0).toFixed(2)}  挑 ${entry.picks ?? 0} 次 / 接住 ${entry.engaged ?? 0} 次${entry.lastTopic ? `  最近：${entry.lastTopic}` : ''}`)
  }
} else {
  console.log('\n[兴趣] 还没有数据（漫游几次之后才会长出标签）')
}

const diary = json('diary.json')
console.log(`[日记] ${diary?.lines?.length ?? 0} 句`)
for (const line of (diary?.lines ?? []).slice(-5)) console.log(`  ${line.date} ${line.text}`)

const state = json('state.json')
if (state) console.log(`\n[状态] turns=${state.turns} valence=${state.mood.valence} arousal=${state.mood.arousal} energy=${state.energy} trust=${state.trust}`)

// 情绪 2.0：判别器判了几轮、动了多少、有几条真让她自己提了一句
const moodLog = lines('mood.jsonl')
if (moodLog.length) {
  const judged = moodLog.filter((r) => !r.failed)
  const failed = moodLog.filter((r) => r.failed)
  const skipped = judged.filter((r) => r.skipped)
  const moved = judged.filter((r) => !r.skipped)
  const announced = moved.filter((r) => r.announced)
  const weak = moved.filter((r) => (r.weight ?? 1) < 1)
  console.log(`\n[情绪] ${judged.length} 次判别（动了 ${moved.length}／没动 ${skipped.length}），失败 ${failed.length}，低置信 ${weak.length}，开口说过 ${announced.length} 次`)
  for (const [label, count] of tally(moved.filter((r) => r.label), (r) => r.label)) {
    console.log(`  ${count.toString().padStart(4)}  ${label}`)
  }
  const recent = moved.slice(-5)
  for (const r of recent) {
    console.log(`  ${r.at.slice(5, 16)} ${String(r.label).padEnd(6)} 幅度 ${r.magnitude} ${JSON.stringify(r.applied)}${r.announced ? ' · 说过' : ''}`)
  }
}

const brief = json('brief.json')
if (!brief) console.log('\n[简报] 还没触发过（brief.json 未生成）')
else {
  console.log(`\n[简报] 上次 ${brief.lastDate || '无'}${brief.lastAt ? `（${new Date(brief.lastAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}`)
  for (const line of String(brief.lastText ?? '').split('\n').filter(Boolean).slice(0, 6)) console.log(`  ${line}`)
}

// QQ 桥：她有没有在 QQ 里说话、发出去几条、有没有被拒。
const qqDebug = lines('roam-debug.jsonl').filter((r) => String(r.result ?? '').startsWith('qq-'))
const qqSettings = json('character.json')?.qq
if (qqSettings && (qqSettings.enabled || qqDebug.length)) {
  const inbound = qqDebug.filter((r) => r.result === 'qq-inbound')
  const sent = qqDebug.filter((r) => r.result === 'qq-sent')
  const failed = qqDebug.filter((r) => r.result === 'qq-send-failed')
  const rejected = qqDebug.filter((r) => r.result === 'qq-rejected')
  const limited = qqDebug.filter((r) => r.result === 'qq-rate-limited')
  console.log(`\n[QQ] ${qqSettings.enabled ? '已开启' : '未开启（qq.enabled=false）'}，白名单 ${qqSettings.allowUsers?.length ?? 0} 人 / ${qqSettings.allowGroups?.length ?? 0} 群`)
  console.log(`  收到 ${inbound.length} 条，回 ${sent.length} 条，发送失败 ${failed.length} 条，被拒 ${rejected.length} 条（限流 ${limited.length}）`)
  const proactive = qqDebug.filter((r) => r.result === 'qq-proactive-sent')
  const proactiveFailed = qqDebug.filter((r) => r.result === 'qq-proactive-failed')
  if (proactive.length || proactiveFailed.length) {
    const roamCount = proactive.filter((r) => r.kind === 'roam').length
    const speakCount = proactive.filter((r) => r.kind === 'speakup').length
    console.log(`  主动发到 QQ ${proactive.length} 次（漫游 ${roamCount} / 搭话 ${speakCount}），失败 ${proactiveFailed.length} 次`)
  }
  for (const r of qqDebug.slice(-5)) {
    console.log(`  ${String(r.at ?? '').slice(5, 16)} ${r.result}${r.user ? ` ${r.user}` : ''}${r.parts ? ` ${r.parts} 条` : ''}${r.reason ? `（${r.reason}）` : ''}`)
  }
}

const planner = lines('planner.jsonl')
if (planner.length) {
  const failed = planner.filter((p) => !p.ok)
  const times = planner.map((p) => p.ms ?? 0)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  console.log(`[内容层] ${planner.length} 次，失败 ${failed.length}，平均 ${avg.toFixed(0)} ms`)

  // 模式分布是「不模板化」的直接指标：一种模式占大多数 = 又在按模板走。
  const withMode = planner.filter((p) => p.mode)
  if (withMode.length) {
    const counts = tally(withMode, (p) => p.mode)
    const total = withMode.length
    console.log(`  模式分布（${total} 轮）：`)
    for (const [mode, count] of counts) {
      const share = ((count / total) * 100).toFixed(0)
      console.log(`  ${count.toString().padStart(4)}  ${mode.padEnd(8)} ${share}%`)
    }
    const top = counts[0]
    if (top && top[1] / total > 0.5 && total >= 10) console.log(`  ⚠ 最常用的是 ${top[0]}（${((top[1] / total) * 100).toFixed(0)}%）：模式又开始固化了`)

    // 连续重复：同一个模式连着出现，是「固定模板」最直接的证据。
    let streak = 1
    let worst = { mode: '', length: 1 }
    for (let i = 1; i < withMode.length; i += 1) {
      if (withMode[i].mode === withMode[i - 1].mode) {
        streak += 1
        if (streak > worst.length) worst = { mode: withMode[i].mode, length: streak }
      } else {
        streak = 1
      }
    }
    console.log(`  最长连续同一模式：${worst.mode} × ${worst.length}`)
  }
}
