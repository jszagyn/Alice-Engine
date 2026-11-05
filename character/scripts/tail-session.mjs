import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
const text = zstdDecompressSync(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).toString('utf8')
const rows = text.split('\n').filter(Boolean).map((line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const texts = (content) =>
  (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')

const last = rows.slice(-40)
for (const event of last) {
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const value = texts(data.content)
    if (value && !value.includes('Time sampled')) console.log(`\n[唤醒/${data.source?.kind}] ${value.slice(0, 120)}`)
  }
  if (event.type === 'assistant/message') {
    const value = texts(data.message?.content)
    if (value) console.log(`\n[alice] ${value.slice(0, 500)}\n`)
  }
}
