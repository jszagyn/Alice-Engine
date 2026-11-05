// alice_list / alice_read 的边界测试。
//
// 重点不是「能读」，是「读不到别处」：`..`、绝对路径、软链、不存在、
// 目录当文件、非 alice 的路径，全部要被挡住。
//
//   node scripts/test-tools.mjs

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const alice = resolve(ROOT, '..', 'alice')

let pass = 0
let fail = 0
function check(label, ok) {
  if (ok) {
    pass += 1
    console.log(`ok   ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}`)
  }
}

// 注册一个假的 ctx.tools，把两个定义收起来。
const definitions = new Map()
const ctx = {
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  },
}

const { apply } = await import('../tools.js')
apply(ctx)
check('注册了 alice_list', definitions.has('alice_list'))
check('注册了 alice_read', definitions.has('alice_read'))

const list = definitions.get('alice_list')
const read = definitions.get('alice_read')

// 1. 列根目录
const rootList = await list.execute({})
const paths = rootList.entries.map((entry) => entry.path)
check('根目录能列出 writings/', paths.includes('alice/writings/'))
check('条目没超过上限', rootList.entries.length <= 300)
check('没有把 .obsidian 列出来', !paths.some((path) => path.includes('.obsidian')))

// 2. 读一个真实文件
const storyPath = 'writings/创作1/故事/商队故事.md'
const story = await read.execute({ path: storyPath })
check('读到了商队故事', story.totalLines > 10 && story.lines.length > 0)
check('行号从 1 开始', story.lines[0].number === 1)
check('返回路径是相对的', story.path.startsWith('alice/'))

// 3. offset / limit
const slice = await read.execute({ path: storyPath, offset: 3, limit: 5 })
check('offset 生效', slice.lines[0].number === 3 && slice.lines.length === 5)
check('截断标记为 true', slice.truncated === true)

// 4. 越界：`..`、绝对路径、指向外面的软链
for (const bad of ['../character/data/character.json', 'writings/../../character/data/character.json']) {
  let blocked = false
  try {
    await read.execute({ path: bad })
  } catch (error) {
    blocked = /只能看|拒绝/.test(String(error?.message ?? ''))
  }
  check(`挡住相对越界：${bad}`, blocked)
}

let blockedAbsolute = false
try {
  await read.execute({ path: 'C:\\Windows\\win.ini' })
} catch (error) {
  blockedAbsolute = /只能看|拒绝/.test(String(error?.message ?? ''))
}
check('挡住 alice 之外的绝对路径', blockedAbsolute)

const linkName = join(alice, 'tmp-link-outside')
try {
  symlinkSync(ROOT, linkName, 'junction')
  let blockedLink = false
  try {
    await read.execute({ path: 'tmp-link-outside/package.json' })
  } catch (error) {
    blockedLink = /只能看|拒绝/.test(String(error?.message ?? ''))
  }
  check('挡住指向外面的软链', blockedLink)
} catch {
  console.log('skip 软链测试（当前环境建不了 junction）')
} finally {
  try {
    rmSync(linkName, { force: true })
  } catch {
    // ignore
  }
}

// 5. 目录当文件、不存在的文件、空路径
let errDirectory = ''
try {
  await read.execute({ path: 'writings' })
} catch (error) {
  errDirectory = String(error?.message ?? '')
}
check('目录当文件会报错', /不是文件/.test(errDirectory))

let errMissing = ''
try {
  await read.execute({ path: 'writings/没有这个.md' })
} catch (error) {
  errMissing = String(error?.message ?? '')
}
check('不存在的文件会报错', /没有这个文件/.test(errMissing))

// 6. 列一个子目录
const sub = await list.execute({ dir: 'writings/创作1/角色' })
check('能列子目录', sub.entries.some((entry) => entry.path.endsWith('希娅·菲斯·维特拉尔.md')))

// 7. 空目录描述
const tmpDir = join(alice, 'tmp-empty')
mkdirSync(tmpDir, { recursive: true })
writeFileSync(join(tmpDir, 'readme.md'), 'hello\n', 'utf8')
const empty = await list.execute({ dir: 'tmp-empty' })
check('临时目录能列出一项', empty.entries.length === 1)
rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n结果：${pass} 过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
