// 兴趣画像的模块级回归：加权排序、20% 探索、滑动平均、偏好渲染。
// 用法：node scripts/test-interest.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-character-interest-'))
process.env.DSH_CHARACTER_DATA = sandbox

const {
  biasCandidates,
  engagementSignal,
  loadInterest,
  recordEngagement,
  recordPick,
  renderInterest,
  saveInterest,
  topTags,
} = await import('../lib/interest.js')

let pass = 0
let fail = 0
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name} ${extra}`)
  }
}

const candidates = [
  { topic: '科技新闻', tag: '科技' },
  { topic: '军事观察', tag: '军事' },
  { topic: '美食探店', tag: '美食' },
]

console.log('[加权排序]')
let interest = loadInterest()
recordEngagement(interest, { tag: '科技', signal: 1 })
recordEngagement(interest, { tag: '科技', signal: 1 })
recordEngagement(interest, { tag: '美食', signal: -0.6 })
const ordered = biasCandidates(candidates, interest, { random: () => 0.5 })
ok('喜欢的标签排前面', ordered[0].tag === '科技', JSON.stringify(ordered.map((c) => c.tag)))
ok('不喜欢的排后面', ordered[ordered.length - 1].tag === '美食')

console.log('[探索轮]')
const explored = biasCandidates(candidates, interest, { random: () => 0.1 })
ok('探索轮按原顺序（给新话题留门）', explored.map((c) => c.tag).join(',') === '科技,军事,美食')

console.log('[挑选计数]')
const before = (interest.tags['军事']?.picks ?? 0)
recordPick(interest, { tag: '军事', topic: '四川舰' })
ok('挑一次加一次', (interest.tags['军事']?.picks ?? 0) === before + 1)
ok('记下最近一条', interest.tags['军事'].lastTopic === '四川舰')
ok('全局计数', interest.picks >= 1)

console.log('[信号]')
ok('说得好且讲了内容 → 1', engagementSignal({ verdict: 'good', overlap: 10 }) === 1)
ok('说得好但泛泛 → 0.4', engagementSignal({ verdict: 'good', overlap: 2 }) === 0.4)
ok('书报腔 → -0.6', engagementSignal({ verdict: 'bad', reasons: ['书报腔'] }) === -0.6)
ok('其他坏 → -0.3', engagementSignal({ verdict: 'bad', reasons: ['半截话'] }) === -0.3)

console.log('[滑动平均]')
interest = loadInterest()
recordEngagement(interest, { tag: '科技', signal: 1 })
ok('一次 +1 → 0.2', Math.abs(interest.tags['科技'].score - 0.2) < 1e-9, String(interest.tags['科技'].score))
recordEngagement(interest, { tag: '科技', signal: 1 })
ok('再来一次 → 0.36', Math.abs(interest.tags['科技'].score - 0.36) < 1e-9, String(interest.tags['科技'].score))
recordEngagement(interest, { tag: '科技', signal: -0.6 })
ok('回落 → 0.168', Math.abs(interest.tags['科技'].score - 0.168) < 1e-9, String(interest.tags['科技'].score))
for (let i = 0; i < 20; i += 1) recordEngagement(interest, { tag: '科技', signal: -0.6 })
ok('下限 -1', interest.tags['科技'].score >= -1)

console.log('[渲染]')
recordEngagement(interest, { tag: '军事', signal: 1 })
recordEngagement(interest, { tag: '军事', signal: 1 })
const text = renderInterest(interest)
ok('有偏好就渲染', text.includes('更愿意看') && text.includes('军事'))
const emptyText = renderInterest(loadInterest())
ok('没偏好不渲染', emptyText === '')
const tags = topTags(interest, 3)
ok('排序：分高的在前', tags[0].tag === '军事' && tags[0].score > tags[tags.length - 1].score)

saveInterest(interest)
ok('落盘可读回', loadInterest().tags['军事'].score > 0)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} 过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
