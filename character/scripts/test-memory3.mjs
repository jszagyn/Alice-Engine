// 记忆 3.0 的模块级回归测试：槽位 / 短期三天 / 概括。
// appendDigest 这类函数会落盘，所以先把 DATA_DIR 指到临时目录再动态 import，
// 跑完删掉临时目录——绝不动真实 data/。
// 用法：node scripts/test-memory3.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-character-test-'))
process.env.DSH_CHARACTER_DATA = sandbox

const { classifyAll, classifySlot, correctSlot, profileEntries, promoteFromDigest, renderProfile, upsertSlot } = await import('../lib/profile.js')
const { pruneEpisodic, relevantEpisodes, rememberEpisode, renderEpisodes, utterance } = await import('../lib/episodic.js')
const { appendDigest, closeEpisodes } = await import('../lib/digest.js')
const { logMemory, readMemoryLog } = await import('../lib/memoryLog.js')

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

console.log('[槽位识别]')
const samples = [
  ['我叫小林', 'identity.name', '小林'],
  ['我住在杭州西湖区', 'identity.city', '杭州西湖区'],
  ['我平常两点多才睡', 'habit.sleep', '两点多才睡'],
  ['我挺喜欢吃辣的', 'taste.like', '吃辣'],
  ['我不喜欢下雨天', 'taste.dislike', '下雨天'],
  ['我最近在写小说', 'story.open', '写小说'],
  ['master 对动漫挺感兴趣', 'taste.like', '动漫'],
  ['今天好困', null, ''],
]
for (const [text, key, value] of samples) {
  const hit = classifySlot(text)
  const good = key === null ? hit === null : hit?.key === key && String(hit.value).includes(value)
  ok(`「${text}」→ ${key ?? '不归类'}`, good, JSON.stringify(hit))
}
ok('一句话两个槽位都收下', classifyAll('我住在杭州，最近在写小说').length === 2, JSON.stringify(classifyAll('我住在杭州，最近在写小说')))
ok('「你叫我什么」不算名字', classifySlot('你叫我什么') === null, JSON.stringify(classifySlot('你叫我什么')))
ok('「他叫我小林」不算名字', classifySlot('他叫我小林') === null, JSON.stringify(classifySlot('他叫我小林')))
ok('「我叫小林」还是名字', classifySlot('我叫小林')?.value === '小林', JSON.stringify(classifySlot('我叫小林')))

console.log('[槽位写入]')
const profile = { slots: {} }
upsertSlot(profile, { key: 'identity.city', value: '杭州', source: 'self', now: 1000 })
upsertSlot(profile, { key: 'identity.city', value: '杭州', source: 'master', now: 2000 })
ok('同值只加次数，source 升到 master', profile.slots['identity.city'].mentions === 2 && profile.slots['identity.city'].source === 'master')
upsertSlot(profile, { key: 'identity.city', value: '上海', source: 'self', now: 3000 })
ok('单值槽位换值，旧值进 superseded', profile.slots['identity.city'].value === '上海' && profile.slots['identity.city'].superseded.at(-1).value === '杭州')
upsertSlot(profile, { key: 'taste.like', value: '动漫', source: 'master', now: 4000 })
upsertSlot(profile, { key: 'taste.like', value: '军事', source: 'self', now: 5000 })
ok('列表槽位保留多个值', JSON.stringify(profile.slots['taste.like'].values) === JSON.stringify(['军事', '动漫']))
const rendered = renderProfile(profile)
ok('渲染多个喜欢', rendered.includes('军事、动漫'), rendered)
ok('渲染标出他说的', rendered.includes('（他说的）'), rendered)
ok('profileEntries 去掉标题行', profileEntries(profile).every((entry) => !entry.text.startsWith('[')))

console.log('[短期记忆]')
const episodic = { entries: [] }
const now = Date.parse('2026-11-01T00:00:00Z')
rememberEpisode(episodic, 'master 说今天加班到十点', { now })
rememberEpisode(episodic, 'master 说今天加班到十点', { now: now + 1000 })
ok('同义重复只加 mentions', episodic.entries.length === 1 && episodic.entries[0].mentions === 2)
rememberEpisode(episodic, 'master 喜欢喝美式', { now: now + 2000 })
rememberEpisode(episodic, 'master 明天要早起', { now: now + 3000 })
ok('三条都在', episodic.entries.length === 3)
const expired = pruneEpisodic(episodic, now + 73 * 3600 * 1000)
ok('超过 72 小时过期', expired.length === 3 && episodic.entries.length === 0)
const episodic2 = { entries: [] }
rememberEpisode(episodic2, 'master 在写小说，写到第三章卡住了', { now })
rememberEpisode(episodic2, 'master 中午吃了牛肉面', { now })
const relevant = relevantEpisodes(episodic2, '小说写得怎么样了', 2, now + 1000)
ok('相关性只挑小说那条', relevant.length === 1 && relevant[0].text.includes('小说'), JSON.stringify(relevant.map((entry) => entry.text)))
rememberEpisode(episodic2, 'master 说小说卡在第三章', { now: now + 500 })
ok('渲染带时间词', /（今天）/.test(renderEpisodes(episodic2.entries, now + 1000)))

console.log('[短期原话]')
ok('纯应答不记', utterance('当然在') === '' && utterance('没问题的') === '' && utterance('行') === '')
ok('剥掉叠两层的口头壳', utterance('嗯，对了，我住在杭州，离西湖很近') === '我住在杭州，离西湖很近', utterance('嗯，对了，我住在杭州，离西湖很近'))
ok('长句按分句截断', utterance('我最近在写小说，今天卡在第三章，改了两遍都不满意，晚上想再试一次', 20).endsWith('，'), utterance('我最近在写小说，今天卡在第三章，改了两遍都不满意，晚上想再试一次', 20))
ok('渲染带「他说」', renderEpisodes([{ text: '我在写小说', at: now, saidBy: 'master' }], now + 1000).includes('他说：「我在写小说」'))

console.log('[概括]')
const digest = { lines: [] }
appendDigest(digest, { date: '2026-10-01', text: 'master 在赶一个项目' })
ok('追加一行', digest.lines.length === 1)
let overflow = null
for (let i = 0; i < 30; i += 1) {
  overflow = appendDigest(digest, { date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, text: `第 ${i} 条` })
}
ok('超过 30 行挤掉最老的', overflow !== null && digest.lines.length === 30 && !digest.lines.some((line) => line.text === 'master 在赶一个项目'))

const fakeLlm = {
  stream() {
    return (async function* generate() {
      yield { type: 'text-delta', text: '"master 连着几天加班到很晚，还在写小说。"' }
    })()
  },
}
const line = await closeEpisodes(fakeLlm, { planner: {} }, expired)
ok('过期批次压成一行', Boolean(line?.text) && !line.text.startsWith('"'), JSON.stringify(line))
const noLlm = await closeEpisodes(null, { planner: {} }, expired)
ok('没有模型也有兜底', Boolean(noLlm?.text))

console.log('[纠错]')
const fixed = correctSlot(profile, { key: 'identity.city', value: '苏州', now: 6000 })
ok('纠正换掉旧值', profile.slots['identity.city'].value === '苏州' && fixed.previous === '上海', JSON.stringify(fixed))
ok('纠正记为他说过的', profile.slots['identity.city'].source === 'master')
ok('旧值进 superseded', profile.slots['identity.city'].superseded.at(-1).value === '上海')
upsertSlot(profile, { key: 'identity.city', value: '北京', source: 'inferred', now: 7000 })
ok('归纳盖不动他说过的', profile.slots['identity.city'].value === '苏州')
upsertSlot(profile, { key: 'identity.city', value: '北京', source: 'self', now: 8000 })
ok('她自己听出来的新话可以更新', profile.slots['identity.city'].value === '北京' && profile.slots['identity.city'].source === 'master')

console.log('[归纳升级]')
const growing = {
  lines: [
    { date: '2026-10-01', text: 'master 两点多才睡' },
    { date: '2026-10-02', text: 'master 两点多才睡，还在写东西' },
    { date: '2026-10-03', text: 'master 两点多才睡' },
  ],
}
const promoted = promoteFromDigest(profile, growing, { now: 9000 })
ok('同件事三天出现才升级', promoted.some((item) => item.key === 'habit.sleep' && item.days === 3), JSON.stringify(promoted))
ok('升级的标成归纳', profile.slots['habit.sleep']?.source === 'inferred' && profile.slots['habit.sleep'].days === 3)
const fresh = { slots: {} }
ok('两天不够', promoteFromDigest(fresh, { lines: growing.lines.slice(0, 2) }).length === 0 && !fresh.slots['habit.sleep'])

console.log('[记忆日志]')
logMemory({ action: 'correct', key: 'identity.city', value: '苏州', previous: '上海' })
const logRows = readMemoryLog(5)
ok('日志能读回来', logRows.length >= 1 && logRows.at(-1).value === '苏州', JSON.stringify(logRows.at(-1)))

console.log(`\n结果：${pass} 过 / ${fail} 失败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
