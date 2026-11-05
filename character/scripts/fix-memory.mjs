// 把记忆库里的旧条目过一遍 distil：去口头语、把「我」写成人名、砍掉过期尾巴。
// 旧条目（2026-10-30 之前）里装着被换成「你」的「我」，等于把 master 的事写成她的，
// 所以先按 master 迁移一次再清洗。
// 用法：node scripts/fix-memory.mjs [--dry-run]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distil } from '../lib/memory.js'

const DATA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data')
const BACKUPS = join(DATA, 'backups')
const FILE = join(DATA, 'memory.json')
const dryRun = process.argv.includes('--dry-run')

const entries = JSON.parse(readFileSync(FILE, 'utf8'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(BACKUPS, { recursive: true })
copyFileSync(FILE, join(BACKUPS, `memory.backup-${stamp}.json`))

const out = []
for (const entry of entries) {
  const legacy = !String(entry.text).includes('master') && String(entry.at ?? '') < '2026-10-30'
    ? String(entry.text).replace(/你(?!们)/g, ' master ')
    : entry.text
  const text = distil(legacy, 60)
  if (text.length < 3) {
    console.log(`丢弃（清洗后太短）: ${entry.text}`)
    continue
  }
  const dup = out.find((other) => other.status === 'active' && other.text === text)
  if (dup) {
    dup.strength = Math.max(dup.strength, entry.strength)
    dup.confirmed = Boolean(dup.confirmed || entry.confirmed)
    console.log(`合并: ${entry.text} → ${text}`)
    continue
  }
  if (text !== entry.text) console.log(`规范: ${entry.text} → ${text}`)
  out.push({ ...entry, text, tier: entry.tier ?? 'fact' })
}

console.log(`\n共 ${entries.length} 条 → ${out.length} 条${dryRun ? '（演练，未写入）' : ''}`)
for (const entry of out) console.log(`  [${entry.tier}] ${entry.text}${entry.confirmed ? '（已确认）' : ''}`)
if (!dryRun) writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
