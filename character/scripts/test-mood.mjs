// 情绪口径 v2 的模块级回归：固定标签、净变化、没动就不写、标量一致。
// 用法：node scripts/test-mood.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-character-mood-'))
process.env.DSH_CHARACTER_DATA = sandbox

const { MOOD_LABELS, applyMood, normalizeMood, pickAnnounce, rememberShift, renderMoodShift } = await import('../lib/mood.js')

let pass = 0
let fail = 0
const ok = (name, condition, extra = '') => {
  if (condition) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

const makeState = () => ({ mood: { valence: 0.1, arousal: 0.5 }, energy: 0.7, trust: 0.4, updatedAt: '' })
const character = { dynamics: { valenceDecay: 1, arousalDecay: 1, quietBaseline: 0.45 } }

console.log('[标签归一]')
ok('固定清单含常见项', MOOD_LABELS.includes('被夸得受用') && MOOD_LABELS.includes('没什么变化'))
const mapped = normalizeMood({ valence: 0.1, label: '被夸得挺受用', why: '他说我靠谱', confidence: 0.7 })
ok('同义标签被映射', mapped?.label === '被夸得受用', JSON.stringify(mapped))
ok('自造标签且无关键词 → 不采纳', normalizeMood({ valence: 0.1, label: '有点莫名其妙', why: '', confidence: 0.6 }) === null)
ok('nothing 走「没什么变化」', normalizeMood({ nothing: true })?.label === '没什么变化')
ok('幅度过小自动算没动', normalizeMood({ valence: 0.01, label: '高兴', confidence: 0.6 })?.nothing === true)

console.log('[方向一致]')
ok('正向标签配负 valence → 丢弃', normalizeMood({ valence: -0.1, label: '被夸得受用', confidence: 0.8 }) === null)
ok('负向标签配正 valence → 丢弃', normalizeMood({ valence: 0.1, label: '有点低落', confidence: 0.8 }) === null)

console.log('[夹紧与补偿]')
const clamped = normalizeMood({ valence: 0.9, label: '兴奋', confidence: 0.7 })
ok('单轴夹到 0.25', clamped.deltas.valence === 0.25)

const state = makeState()
const applied = applyMood(state, { deltas: { valence: 0.1, arousal: 0.05, energy: 0, trust: 0.02 }, label: '被夸得受用', why: '', confidence: 0.8, nothing: false }, character, { valence: 0.14 })
ok('规则版已加的会被扣掉', Math.abs(applied.applied.valence - -0.04) < 1e-9, JSON.stringify(applied))
ok('状态按净变化更新', Math.abs(state.mood.valence - 0.06) < 1e-9, String(state.mood.valence))
ok('写进 lastAppraisal', state.lastAppraisal?.source === 'mood-llm')

console.log('[没动就不写]')
const quiet = makeState()
const skipped = applyMood(quiet, { deltas: { valence: 0.01, arousal: 0, energy: 0, trust: 0 }, label: '没什么变化', why: '', confidence: 0.5, nothing: true }, character)
ok('返回 skipped', skipped.skipped === true)
ok('状态不动', quiet.mood.valence === 0.1 && quiet.lastAppraisal === undefined)

console.log('[低置信减半]')
const weak = makeState()
const half = applyMood(weak, { deltas: { valence: 0.2, arousal: 0, energy: 0, trust: 0 }, label: '高兴', why: '', confidence: 0.3, nothing: false }, character)
ok('权重 0.5', half.weight === 0.5)
ok('只加一半', Math.abs(weak.mood.valence - 0.2) < 1e-9, String(weak.mood.valence))

console.log('[要不要说]')
const mood = { lastLabel: '', lastAnnouncedAt: '', announce: null, history: [] }
const strong = { deltas: { valence: 0.2, arousal: 0, energy: 0, trust: 0 }, label: '被夸得受用', why: '他说我靠谱', confidence: 0.8, nothing: false }
ok('幅度够才说', pickAnnounce(strong, strong.deltas, 0.2, mood)?.label === '被夸得受用')
ok('幅度不够不说', pickAnnounce(strong, strong.deltas, 0.1, mood) === null)
ok('没什么变化不说', pickAnnounce({ ...strong, label: '没什么变化' }, strong.deltas, 0.2, mood) === null)
const announcedMood = { ...mood, lastLabel: '被夸得受用', lastAnnouncedAt: new Date().toISOString() }
ok('同一件事 6 小时内不重复说', pickAnnounce(strong, strong.deltas, 0.2, announcedMood) === null)

console.log('[渲染与存档]')
const text = renderMoodShift({ label: '被夸得受用', why: '他说我靠谱' })
ok('带哨兵和标签', text.includes('[心情刚变]') && text.includes('被夸得受用'))
for (let i = 0; i < 100; i += 1) rememberShift(mood, strong, strong.deltas, 0.2, false)
ok('历史最多 80 条', mood.history.length === 80)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} 过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
