// 语料吸收 v1 的模块级回归测试：词的三态、冷却、判错退役、锚点每周轮换。
// saveCorpus 会落盘，所以先把 DATA_DIR 指到临时目录再动态 import，跑完删掉——不动真实 data/。
// 用法：node scripts/test-corpus.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-character-corpus-'))
process.env.DSH_CHARACTER_DATA = sandbox

const {
  addAnchor,
  addCandidate,
  ingestCorpus,
  loadCorpus,
  markWordsUsed,
  normalizeTerm,
  parseExtraction,
  penalizeWords,
  pickAnchor,
  renderCorpusHint,
  selectWords,
} = await import('../lib/corpus.js')

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

const fakeLlm = (text) => ({
  stream: async function* () {
    yield { type: 'text-delta', text }
  },
})

console.log('[词形]')
ok('正常口语词收下', normalizeTerm('绷不住') === '绷不住')
ok('去掉引号', normalizeTerm('「绷不住」') === '绷不住')
ok('英文不收', normalizeTerm('lol') === '')
ok('带书名号收不了（专名）', normalizeTerm('《三体》') === '')
ok('太长不收', normalizeTerm('这是一个很长的口语词汇了') === '')
ok('停用词不收', normalizeTerm('这个') === '')

console.log('[观察池与升级]')
let corpus = loadCorpus()
const first = addCandidate(corpus, { term: '绷不住', meaning: '忍不住笑', when: '有点好笑的时候' })
ok('新词进观察池', first.tier === 'watch' && first.hits === 1)
const second = addCandidate(corpus, { term: '绷不住' })
ok('第二次抓到就转在用', second.tier === 'active' && second.hits === 2)
ok('意思保留', second.meaning === '忍不住笑')

console.log('[挑选：冷却与最近说过]')
const picked = selectWords(corpus, { now: Date.parse('2026-11-01T00:00:00Z') })
ok('在用且冷却够了能挑到', picked.length === 1 && picked[0].term === '绷不住')
markWordsUsed(corpus, ['绷不住'], Date.parse('2026-11-01T00:00:00Z'))
ok('刚用过就冷却', selectWords(corpus, { now: Date.parse('2026-11-01T01:00:00Z') }).length === 0)
ok('冷却过了又能挑', selectWords(corpus, { now: Date.parse('2026-11-01T07:00:00Z') }).length === 1)
ok('最近两轮说过的跳过', selectWords(corpus, { now: Date.parse('2026-11-01T07:00:00Z'), recentTerms: ['绷不住'] }).length === 0)

console.log('[判错退役]')
penalizeWords(corpus, ['绷不住'])
ok('错一次还在用', corpus.words['绷不住'].tier === 'active' && corpus.words['绷不住'].flags === 1)
penalizeWords(corpus, ['绷不住'])
ok('错两次退役', corpus.words['绷不住'].tier === 'retired')
ok('退役后挑不到', selectWords(corpus, { now: Date.parse('2026-12-01T00:00:00Z') }).length === 0)

console.log('[语气锚点]')
ok('锚点只收中文语气', addAnchor(corpus, '这什么玩意啊') !== null)
ok('锚点拒英文', addAnchor(corpus, 'wtf') === null)
const anchor1 = pickAnchor(corpus, Date.parse('2026-11-03T00:00:00Z'))
const anchor2 = pickAnchor(corpus, Date.parse('2026-11-04T00:00:00Z'))
ok('同一周是同一个锚点', anchor1 && anchor2 && anchor1.pattern === anchor2.pattern)

console.log('[渲染]')
ok('没词没锚点就不带', renderCorpusHint({}) === '')
const hint = renderCorpusHint({ words: [{ term: '绷不住', when: '好笑的时候' }], anchor: { pattern: '这什么玩意啊' } })
ok('有词有锚点', hint.includes('[说话用词]') && hint.includes('绷不住') && hint.includes('这什么玩意啊'))
ok('带克制提醒', hint.includes('一轮最多带一个'))

console.log('[抽取]')
const parsed = parseExtraction('```json\n{"words":[{"term":"上头","meaning":"停不下来","when":"上瘾时"}],"anchors":["这什么玩意啊"]}\n```')
ok('解析出词', parsed.words.length === 1 && parsed.words[0].term === '上头')
ok('解析出锚点', parsed.anchors.length === 1)
const rejected = parseExtraction('{"words":[{"term":"lol"},{"term":"《三体》"}],"anchors":["ok"]}')
ok('英文/专名被丢', rejected.words.length === 0 && rejected.anchors.length === 0)

console.log('[吸收一轮]')
const ingested = await ingestCorpus(fakeLlm('{"words":[{"term":"裂开","meaning":"崩溃了","when":"倒霉的时候"}],"anchors":["这什么玩意啊"]}'), {}, ['这操作直接裂开', '绷不住了'])
ok('抽到词', ingested && ingested.extracted.words[0].term === '裂开')
const saved = JSON.parse(readFileSync(join(sandbox, 'corpus.json'), 'utf8'))
ok('落盘了', Boolean(saved.words['裂开']))
ok('统计累加', saved.stats.comments === 2 && saved.stats.accepted >= 1)

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${pass} 过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
