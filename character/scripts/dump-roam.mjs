import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
const text = zstdDecompressSync(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).toString('utf8')

const texts = (content) =>
  (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')

let toolCalls = 0
for (const line of text.split('\n').filter(Boolean)) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const value = texts(data.content)
    if (value) console.log(`[USER/${data.source?.kind}] ${value.slice(0, 160)}`)
  }
  if (event.type === 'tool/call') {
    toolCalls += 1
    console.log(`[TOOL] ${data.name} ${data.arguments.slice(0, 200)}`)
  }
  if (event.type === 'tool/result') {
    const value = texts(data.message?.content)
    console.log(`[RESULT] ok=${!data.message?.isError} ${value.slice(0, 160).replace(/\n/g, ' ')}`)
  }
  if (event.type === 'assistant/message') {
    const value = texts(data.message?.content)
    if (value) console.log(`\n[alice] ${value}\n`)
  }
}
console.log(`\ntool calls total: ${toolCalls}`)
