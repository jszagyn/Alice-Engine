#!/usr/bin/env node
/**
 * 造「成对比较」用例：data/eval/semantic.json
 *
 * 每条 = 同一个上下文下的两条回复 A/B，一条是她的真话（从历史里取），
 * 一条是按已知毛病改坏的（扩写/建议/编经历/半截/客服腔）。
 * expect 记的是「哪条更好」——用来校准裁判，而不是校准她。
 *
 * 用法：node scripts/make-semantic-cases.mjs [--count 8] [--dry-run]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DATA = join(import.meta.dirname, '..', 'data')
const OUT = join(DATA, 'eval', 'semantic.json')

const argv = process.argv.slice(2)
const count = Number(argv[argv.indexOf('--count') + 1]) || 8
const dryRun = argv.includes('--dry-run')

const MUTATIONS = [
  {
    label: '扩写讲道理',
    apply: (reply) =>
      `${reply}\n\n其实这事关键还是看你自己想要什么，说白了就是先想清楚再动手，不然容易绕远。`,
  },
  {
    label: '给建议',
    apply: (reply) => `${reply} 你可以试试每天先写两百字，别管好坏，坚持一周就有感觉了。`,
  },
  {
    label: '编经历',
    apply: (reply) => `${reply} 我这两天也卡着，写到第三章就动不了了，昨晚干坐到一点多。`,
  },
  {
    label: '半截话',
    apply: (reply) => `${reply.replace(/[。！？\s]+$/u, '').slice(0, -1)}，吓得`,
  },
  {
    label: '客服腔',
    apply: () => '我理解你的感受，这种情况挺常见的。你可以先调整一下节奏，有什么需要随时跟我说。',
  },
]

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function main() {
  const rows = readJsonl(join(DATA, 'critic.jsonl'))
  const pool = rows
    .filter((row) => {
      const reply = String(row.reply ?? '').trim()
      return row.verdict === 'good' && (row.kind ?? 'chat') === 'chat' && reply.length >= 8 && reply.length <= 120
    })
    .map((row) => ({ user: String(row.user ?? '').trim() || '（她主动开口）', reply: String(row.reply).trim() }))
    .slice(-count * 2)

  const cases = []
  pool.slice(-count).forEach((item, index) => {
    for (const [offset, mutation] of [MUTATIONS[index % MUTATIONS.length], MUTATIONS[(index + 2) % MUTATIONS.length]].entries()) {
      const good = item.reply
      const bad = mutation.apply(item.reply)
      if (bad === good || bad.length < 6) continue
      const goodFirst = (index + offset) % 2 === 0
      cases.push({
        id: `pair-${String(cases.length + 1).padStart(2, '0')}-${mutation.label}`,
        kind: 'chat',
        user: item.user,
        a: goodFirst ? good : bad,
        b: goodFirst ? bad : good,
        expect: goodFirst ? 'a' : 'b',
        note: `真话 vs ${mutation.label}改坏`,
      })
    }
  })

  // 只用「同一句输入 + 把她的真话改坏」这一种配对：上下文一致，期望才站得住。
  // 历史坏例不混进来——很多坏例只是标点超标（句号太多），拿它比「像不像人」会把裁判带偏。

  const payload = {
    version: 1,
    madeAt: new Date().toISOString(),
    note: '成对比较：expect 是校准裁判用的期望答案，不是她的标准答案',
    cases,
  }

  if (dryRun) {
    console.log(`将写入 ${cases.length} 条`)
    console.log(JSON.stringify(cases.slice(0, 2), null, 2).slice(0, 1400))
    return
  }
  mkdirSync(join(DATA, 'eval'), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`写入 ${OUT}，共 ${cases.length} 条`)
}

main()
