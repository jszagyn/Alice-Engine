import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = 'G:/DSH/data/sessions'
const rows = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.jsonl.zstd')) rows.push(full)
  }
}

walk(root)

for (const file of rows.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
  let text = ''
  try {
    text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  } catch {
    continue
  }
  const lines = text.split('\n').filter(Boolean)
  let turns = 0
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn/end') turns += 1
    } catch {}
  }
  const persona = text.includes('爱丽丝')
  const state = text.includes('[现在的状态]')
  if (!persona && turns === 0) continue
  console.log(
    [
      statSync(file).mtime.toISOString().slice(0, 19),
      `events=${lines.length}`,
      `turns=${turns}`,
      `persona=${persona}`,
      `state=${state}`,
      file.replace(root + '/', ''),
    ].join('  '),
  )
}
