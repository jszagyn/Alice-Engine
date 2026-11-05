// 只看「投喂区」的两个工具。
//
// 她原来只有 web + read_image，看不了磁盘。现在给两个窄口工具：
//
//   alice_list  列 alice/ 下的稿子（相对路径、最多 N 条）
//   alice_read  读 alice/ 下的某一个文本文件（带行号、有字节上限）
//
// 边界是硬编码的：所有路径都 resolve 到插件包旁边的 alice/ 目录，出了这个目录一律拒绝
// （`..`、绝对路径、软链都要过 realpath 复查）。这样她能看 master 放进去的东西，
// 但看不到 character/data 里的记忆、nap 里的 QQ token，也改不了任何文件。
//
// 注：这里不用 @deepseek-ai/dsh-tools 的 defineTool——插件目录不在 DSH 安装目录里，
// 解析不到那个包（和当初 import dsh-llm 踩的是同一个坑）。ctx.tools.register 接受
// 手写的 JSON Schema 定义，够用。

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'character-tools'
export const inject = ['tools']

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'alice')

const MAX_LIST = 300
const MAX_DEPTH = 5
const READ_MAX_BYTES = 60 * 1024
const READ_MAX_LINES = 400
const READ_MAX_LINE_LENGTH = 1500
const MAX_FILE_BYTES = 4 * 1024 * 1024
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function insideRoot(target) {
  return target === ROOT || target.startsWith(ROOT + sep)
}

/** 把模型给的相对路径变成 alice 里面的绝对路径；越界一律拒绝。 */
async function safePath(input) {
  const raw = String(input ?? '').trim()
  if (raw.includes('\0')) throw new Error('路径里有非法字符')
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(ROOT, raw)
  if (!insideRoot(candidate)) throw new Error(`只能看 alice/ 里的东西（拒绝：${raw || '根目录'}）`)
  let real = candidate
  try {
    real = await realpath(candidate)
  } catch {
    real = candidate
  }
  if (!insideRoot(real)) throw new Error('路径解析到了 alice/ 外面，拒绝')
  return real
}

function display(target) {
  const rel = relative(ROOT, target).split(sep).join('/')
  return rel ? `alice/${rel}` : 'alice'
}

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_LIST) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  for (const entry of entries) {
    if (out.length >= MAX_LIST) return
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    const rel = display(full)
    if (entry.isDirectory()) {
      out.push({ path: `${rel}/`, kind: 'dir', size: 0 })
      await walk(full, depth + 1, out)
      continue
    }
    let size = 0
    try {
      size = (await stat(full)).size
    } catch {
      size = 0
    }
    out.push({ path: rel, kind: 'file', size })
  }
}

function renderList(value) {
  if (!value.entries.length) return '（alice/ 里还是空的）'
  const lines = value.entries.map((entry) =>
    entry.kind === 'dir' ? `- ${entry.path}` : `- ${entry.path}（${entry.size} 字节）`,
  )
  const tail = value.truncated ? '\n（条目太多，只列了前 300 条；可以直接读具体文件）' : ''
  return `${lines.join('\n')}${tail}`
}

function renderRead(value) {
  const header = `《${value.path}》共 ${value.totalLines} 行${value.truncated ? '，这里是一部分' : ''}：`
  const body = value.lines.map((line) => `${String(line.number).padStart(4, ' ')}  ${line.text}`).join('\n')
  return `${header}\n${body}`
}

const listDefinition = {
  name: 'alice_list',
  description:
    '列出 master 放进 alice/ 文件夹里的稿子（作品设定、故事、角色等）。只看这一个目录，别的目录看不到。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dir: {
        type: 'string',
        description: '要列的子目录，相对 alice/（例如 "writings/创作1/角色"）；不填就列整个 alice/。',
      },
    },
  },
  output: {
    // 注意：DSH 的 schema 子集只认 object 上的 required 数组，
    // 不支持在 array/string/number/boolean 上写 required —— 写了会让整个
    // preset 的工具注册失败，进而 resume/新建会话都报 unsupported JSON schema。
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['entries', 'truncated'],
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'kind', 'size'],
            properties: {
              path: { type: 'string' },
              kind: { type: 'string' },
              size: { type: 'number' },
            },
          },
        },
        truncated: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderList(value) }],
  },
  timeoutMs: 20_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const dir = await safePath(args?.dir ?? '')
    const entries = []
    await walk(dir, 0, entries)
    return { entries: entries.slice(0, MAX_LIST), truncated: entries.length >= MAX_LIST }
  },
}

const readDefinition = {
  name: 'alice_read',
  description:
    '读 alice/ 文件夹里的一个文本文件（.md/.txt 之类），带行号。只能读 alice/ 里的东西，不能写、不能改。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description: '相对 alice/ 的文件路径，例如 "writings/创作1/故事/商队故事.md"。',
      },
      offset: { type: 'number', description: '从第几行开始（1 起），不填从头开始。' },
      limit: { type: 'number', description: `最多返回多少行，默认 ${READ_MAX_LINES}。` },
    },
    required: ['path'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'totalLines', 'truncated', 'lines'],
      properties: {
        path: { type: 'string' },
        totalLines: { type: 'number' },
        truncated: { type: 'boolean' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['number', 'text'],
            properties: {
              number: { type: 'number' },
              text: { type: 'string' },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
  },
  timeoutMs: 20_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const target = await safePath(args?.path)
    let info
    try {
      info = await stat(target)
    } catch {
      throw new Error(`alice/ 里没有这个文件：${args?.path}`)
    }
    if (!info.isFile()) throw new Error(`这不是文件：${args?.path}（用 alice_list 看看目录）`)
    if (info.size > MAX_FILE_BYTES) throw new Error(`文件太大（${info.size} 字节），一次读不动`)
    const raw = await readFile(target, { encoding: 'utf8', flag: 'r' })
    if (raw.includes('\0')) throw new Error('这看起来是二进制文件，读不了')
    const all = raw.split(/\r?\n/)
    const offset = Math.max(1, Math.floor(Number(args?.offset) || 1))
    const limit = Math.max(1, Math.min(READ_MAX_LINES, Math.floor(Number(args?.limit) || READ_MAX_LINES)))
    const selected = []
    let bytes = 0
    for (let i = offset - 1; i < all.length && selected.length < limit; i += 1) {
      const text = all[i].length > READ_MAX_LINE_LENGTH ? `${all[i].slice(0, READ_MAX_LINE_LENGTH)}…` : all[i]
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > READ_MAX_BYTES) break
      selected.push({ number: i + 1, text })
    }
    const text = selected.map((line) => line.text).join('\n')
    if (readHook) {
      try {
        readHook({ path: display(target), text })
      } catch {
        // 概括失败不影响读文件。
      }
    }
    return {
      path: display(target),
      totalLines: all.length,
      truncated: selected.length + offset - 1 < all.length,
      lines: selected,
    }
  },
}

let readHook = null
export function setReadHook(fn) {
  readHook = typeof fn === 'function' ? fn : null
}

export function apply(ctx) {
  ctx.tools.register(listDefinition)
  ctx.tools.register(readDefinition)
}
