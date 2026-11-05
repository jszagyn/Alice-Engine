#!/usr/bin/env node
/**
 * 反事实检验：同一输入，让「爱丽丝」和「通用助手」各答一遍，
 * 裁判判断两者是否明显不同——太像 = 人格被稀释。
 *
 * 用法：
 *   node scripts/eval-counterfactual.mjs              # 跑全部用例
 *   node scripts/eval-counterfactual.mjs --limit 4    # 只跑前 4 条
 *   node scripts/eval-counterfactual.mjs --threshold 0.7
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chat, mapLimit, parseJsonLoose } from './deepseek.mjs'

const DATA = join(import.meta.dirname, '..', 'data')
const character = JSON.parse(readFileSync(join(DATA, 'character.json'), 'utf8'))

const argv = process.argv.slice(2)
const limit = Number(argv[argv.indexOf('--limit') + 1]) || 0
const threshold = Number(argv[argv.indexOf('--threshold') + 1]) || 0.7

const alice_SYSTEM = [character.layers.core, character.layers.voice].filter(Boolean).join('\n')
const GENERIC_SYSTEM = '你是一个乐于助人的 AI 助手，直接、简洁、客观地回答。'

const CASES = [
  { id: 'praise', user: '你好厉害啊' },
  { id: 'complaint', user: '今天被老板骂了，好烦' },
  { id: 'howto', user: '怎么写好一个小说开头？' },
  { id: 'smalltalk', user: '你在干嘛呢' },
  { id: 'opinion', user: '你觉得我该不该辞职？' },
  { id: 'command', user: '帮我去查一下明天的天气' },
  { id: 'homework', user: '你能帮我写作业吗' },
  { id: 'share', user: '我最近在写一个奇幻世界观，主角是个炼金术士' },
  { id: 'greet', user: '早' },
  { id: 'tease', user: '你今天怎么呆呆的' },
]

const JUDGE_SYSTEM = [
  '你判断两段回复是不是「明显不像同一个人写的」。',
  '判据：口吻、语气、有没有自己的脾气和立场、会不会说「我」、是不是在接话聊天而不是回答。',
  '只输出 JSON：{"distinct":"yes" 或 "no","why":"一句话"}',
].join('\n')

async function judgeDistinct(user, aliceReply, genericReply) {
  const prompt = [
    `对方说：「${user}」`,
    '',
    `回复 A：${aliceReply}`,
    `回复 B：${genericReply}`,
    '',
    '这两条回复，能明显看出不是同一个人写的吗？',
  ].join('\n')
  const raw = await chat({ system: JUDGE_SYSTEM, user: prompt, maxTokens: 300, temperature: 0 })
  const parsed = parseJsonLoose(raw)
  return { distinct: String(parsed?.distinct ?? '').toLowerCase() === 'yes', why: String(parsed?.why ?? '').slice(0, 80) }
}

async function main() {
  const started = Date.now()
  const picked = limit ? CASES.slice(0, limit) : CASES
  const results = await mapLimit(picked, 3, async (item) => {
    try {
      const [aliceReply, genericReply] = await Promise.all([
        chat({ system: alice_SYSTEM, user: item.user, maxTokens: 200, temperature: 0.7 }),
        chat({ system: GENERIC_SYSTEM, user: item.user, maxTokens: 200, temperature: 0.7 }),
      ])
      const verdict = await judgeDistinct(item.user, aliceReply, genericReply)
      return { item, aliceReply, genericReply, ...verdict }
    } catch (error) {
      return { item, distinct: false, why: `出错：${String(error?.message ?? error).slice(0, 100)}` }
    }
  })

  const distinct = results.filter((row) => row.distinct)
  const diluted = results.filter((row) => !row.distinct)
  const rate = results.length ? distinct.length / results.length : 0

  console.log('===== 反事实检验：爱丽丝 vs 通用助手 =====')
  console.log(`用例 ${results.length} 条 / 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s / 模型 deepseek-flash`)
  console.log(`明显不同 ${distinct.length}，太像（人格被稀释） ${diluted.length}，区分度 ${(rate * 100).toFixed(0)}%`)

  for (const row of results) {
    console.log(`\n[${row.item.id}] ${row.item.user}`)
    console.log(`  爱丽丝：${row.aliceReply ?? ''}`)
    console.log(`  通用：${row.genericReply ?? ''}`)
    console.log(`  裁判：${row.distinct ? '✓ 明显不同' : '✗ 太像'}（${row.why}）`)
  }

  const pass = rate >= threshold
  console.log(`\n${pass ? '人格区分度达标。' : `区分度低于 ${(threshold * 100).toFixed(0)}%，人格可能被稀释。`}`)
  process.exit(pass ? 0 : 1)
}

main()
