// 记忆 3.0 迁移：把旧的 memory.json（长期碎片）搬进 profile 槽位。
// 旧库不删——它现在是归档，面板还能看；以后不再往里写。
import { loadMemory } from '../lib/memory.js'
import { loadProfile, rememberInProfile, renderProfile, saveProfile } from '../lib/profile.js'

const entries = loadMemory().filter((entry) => entry.status === 'active')
const profile = loadProfile()
let changed = 0
for (const entry of entries) {
  const wrote = rememberInProfile(profile, entry.text, {
    source: entry.confirmed ? 'master' : 'self',
    note: '旧记忆库',
  })
  if (wrote.length) {
    changed += wrote.length
    console.log(`  ${entry.text} → ${wrote.join(', ')}`)
  } else {
    console.log(`  （归不进槽位，留在旧库）${entry.text}`)
  }
}
if (changed) saveProfile(profile)
console.log(`\n迁移完成：${changed} 个槽位`)
console.log(renderProfile(profile) || '（还是空的）')
