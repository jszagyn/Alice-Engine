import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node dump-session.mjs <session-directory>')
  process.exit(1)
}

const text = zstdDecompressSync(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).toString('utf8')
const blocks = []
const transcript = []
let system = ''

const blockRe = /\[现在的状态\](?:\\n[^"\\]*)+/g
const texts = (content) =>
  (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')

for (const line of text.split('\n').filter(Boolean)) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }

  for (const match of line.matchAll(blockRe)) {
    blocks.push(match[0].replace(/\\n/g, '\n'))
  }

  const data = event.data ?? {}
  if (event.type === 'system/message' && !system) system = texts(data.message?.content)
  if (event.type === 'user/message') {
    const value = texts(data.content)
    if (value && !value.includes('[现在的状态]')) transcript.push(['USER', value])
  }
  if (event.type === 'assistant/message') {
    const value = texts(data.message?.content)
    if (value) transcript.push(['alice', value])
  }
}

console.log(`system chars=${system.length}  has-examples=${system.includes('你说话大概是这样')}`)
const unique = [...new Set(blocks)]
console.log(`state blocks=${blocks.length}  unique=${unique.length}`)
for (const block of unique) console.log('\n' + block)
console.log('\n=== transcript ===')
for (const [who, value] of transcript) console.log(`\n[${who}] ${value}`)
