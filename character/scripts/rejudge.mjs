// 用现行口径重判历史判别与示例库。
// 用途：critic 规则改了以后，把旧口径留下的假坏例（句号太多/以问号结尾的误判）清掉，
// 免得示例库和统计一直拿着旧尺子量。
// 用法：node scripts/rejudge.mjs [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'

import { criticize } from '../lib/critic.js'
import { loadExemplars, saveExemplars } from '../lib/exemplars.js'

const dryRun = process.argv.includes('--dry-run')
const CRITIC_LOG = new URL('../data/critic.jsonl', import.meta.url)

// ---- critic.jsonl ----
const rows = readFileSync(CRITIC_LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const now = new Date().toISOString()
let previousEndedWithQuestion = false
let changed = 0
for (const row of rows) {
  const result = criticize(row.reply ?? '', null, { previousEndedWithQuestion })
  previousEndedWithQuestion = result.endsWithQuestion
  if (row.verdict !== result.verdict || (row.reasons ?? []).join('+') !== result.reasons.join('+')) changed += 1
  row.verdict = result.verdict
  row.reasons = result.reasons
  row.endsWithQuestion = result.endsWithQuestion
  row.rejudgedAt = now
}

console.log(`critic.jsonl：${rows.length} 条，判定变化 ${changed} 条`)
console.log(`  新坏例 ${rows.filter((r) => r.verdict === 'bad').length} 条`)

// ---- exemplars.json ----
const exemplars = loadExemplars()
const kept = []
const promoted = []
for (const entry of exemplars.bad ?? []) {
  const result = criticize(entry.reply ?? '', null, { previousEndedWithQuestion: false })
  if (result.verdict === 'good') {
    promoted.push({ ...entry, verdict: 'good', reasons: result.reasons, rejudgedAt: now })
  } else {
    kept.push({ ...entry, verdict: 'bad', reasons: result.reasons, rejudgedAt: now })
  }
}
const good = [...(exemplars.good ?? []), ...promoted].slice(-300)

console.log(`示例库：bad ${(exemplars.bad ?? []).length} 条 → 保留 ${kept.length}，改判为 good ${promoted.length}`)

if (dryRun) {
  console.log('\n[dry-run] 未写入')
} else {
  writeFileSync(
    CRITIC_LOG,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
    'utf8',
  )
  saveExemplars({ ...exemplars, good, bad: kept })
  console.log('已写回 data/critic.jsonl 与 data/exemplars.json')
}
