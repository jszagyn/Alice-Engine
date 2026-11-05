import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appraise } from '../lib/appraise.js'
import { extractFromUser, renderMemories, retrieveMemories } from '../lib/memory.js'
import { renderPlan } from '../lib/planner.js'
import { applyAppraisal, renderState, stateSummary } from '../lib/state.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const character = JSON.parse(readFileSync(join(ROOT, 'data', 'character.json'), 'utf8'))

const state = {
  mood: { valence: character.initial.valence, arousal: character.initial.arousal },
  energy: character.initial.energy,
  trust: character.initial.trust,
  turns: 0,
  updatedAt: new Date().toISOString(),
}

console.log('===== LAYER: CORE (planner only) =====')
console.log(character.layers.core)
console.log('\n===== LAYER: VOICE (renderer system prompt) =====')
console.log(character.layers.voice)
console.log('\n===== LAYER: SUFFIX =====')
console.log(character.prose.suffix)
console.log('\n===== LAYER: STATE =====')
console.log(renderState(state))
console.log('\n  planner input summary:', stateSummary(state))

const demoPlan = {
  stance: '觉得挺离谱，但不讨厌',
  points: ['油冷商用维护很麻烦', '漏油换件得整柜停'],
  question: '你到底是想聊技术还是想听八卦',
  avoid: ['别下结论'],
}
console.log('\n===== LAYER: PLAN (example) =====')
console.log(renderPlan(demoPlan))

const script = [
  { user: '我今天看到个挺离谱的新闻，一个公司把服务器泡在油里散热' },
  { user: '你觉得这样靠谱吗' },
  { user: '谢谢，你懂得还挺多' },
  { user: '随便吧' },
  { user: '刚才是我语气不好，抱歉。你继续说，那个维护麻烦在哪' },
]

console.log('\n===== SIMULATION =====')
for (const [index, turn] of script.entries()) {
  const result = appraise({ ...turn, assistant: '', toolErrors: 0 }, character)
  applyAppraisal(state, result, character)
  console.log(`\n--- turn ${index + 1} | ${result.reason}`)
  console.log(renderState(state))
}

console.log('\n===== MEMORY DEMO =====')
const memoryChat = [
  '我叫阿明',
  '我喜欢油冷服务器，感觉短期靠谱',
  '我明天要出差',
  '你记得我说过油冷的事吗',
  '油冷那个还是不太靠谱，维护太麻烦',
]
let mem = []
for (const message of memoryChat) {
  mem = extractFromUser(mem, message)
  const hit = retrieveMemories(mem, message, 3)
  console.log(`\n「${message}」`)
  console.log('  想起:', hit.length ? renderMemories(hit) : '(无)')
}
console.log('\n最终记忆:')
for (const entry of mem) console.log(`  [${entry.kind}] x${entry.strength} ${entry.text}`)
