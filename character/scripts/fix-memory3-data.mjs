// 一次性清洗记忆 3.0 的脏数据（2026-11-01）：
// 1) 槽位里被代词污染的值（「你叫我」→ identity.name=我）删掉；
// 2) 短期条目早先走 distil 存成了「你叫 master」这种转述，还原成他原话，纯应答丢掉。
// 用法：node scripts/fix-memory3-data.mjs [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DATA_DIR } from '../lib/state.js'
import { utterance } from '../lib/episodic.js'

const dryRun = process.argv.includes('--dry-run')
const STOP = new Set(['我', '你', '他', '她', '它', '咱', '我们', '你们', '他们', '自己', '什么', '啥', '谁', '哪', '这个', '那个', '这', '那', '一个', '一点'])

const tidy = (text) =>
  text
    .replace(/master\s*和你/g, '我们')
    .replace(/master\s*/g, '我')
    .replace(/\s+(?=[，。！？、；：）】」』])/g, '')
    .replace(/(?<=[\u4e00-\u9fa5，。！？]) {1,2}(?=[\u4e00-\u9fa5])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

const profilePath = join(DATA_DIR, 'profile.json')
const episodicPath = join(DATA_DIR, 'episodic.json')

const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
const removed = []
for (const [key, slot] of Object.entries(profile.slots ?? {})) {
  const value = String(slot?.value ?? '')
  if (STOP.has(value)) {
    removed.push(`${key}=${value}`)
    delete profile.slots[key]
  }
}

const episodic = JSON.parse(readFileSync(episodicPath, 'utf8'))
const kept = []
const restored = []
const dropped = []
for (const entry of episodic.entries ?? []) {
  const original = utterance(tidy(String(entry.text ?? '')), 90)
  if (!original) {
    dropped.push(String(entry.text ?? '').slice(0, 30))
    continue
  }
  restored.push(original)
  kept.push({ ...entry, saidBy: 'master', text: original })
}

console.log(`槽位删除：${removed.join('、') || '无'}`)
console.log(`短期条目：${(episodic.entries ?? []).length} → ${kept.length}`)
for (const line of restored) console.log(`  留下 ${line}`)
for (const line of dropped) console.log(`  丢掉 ${line}`)

if (dryRun) {
  console.log('（dry-run，没有写盘）')
  process.exit(0)
}

writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
writeFileSync(episodicPath, `${JSON.stringify({ ...episodic, entries: kept }, null, 2)}\n`, 'utf8')
console.log('已写回')
