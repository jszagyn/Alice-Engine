#!/usr/bin/env node
/**
 * 语义层评测：让模型当裁判，做「成对比较」。
 *
 * 先拿已知答案的对照（真话 vs 改坏的）校准裁判——裁判自己都分不出来，
 * 它给出的「哪个版本更好」就不值得信。校准过关后，才能用它比较两版提示词的输出。
 *
 * 用法：
 *   node scripts/eval-semantic.mjs              # 校准 + 打分
 *   node scripts/eval-semantic.mjs --verbose    # 逐条看裁判理由
 *   node scripts/eval-semantic.mjs --limit 6    # 只跑前 6 条
 *   node scripts/eval-semantic.mjs --threshold 0.75
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chat, mapLimit, parseJsonLoose } from './deepseek.mjs'

const DATA = join(import.meta.dirname, '..', 'data')
const CASES = join(DATA, 'eval', 'semantic.json')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const limit = Number(argv[argv.indexOf('--limit') + 1]) || 0
const threshold = Number(argv[argv.indexOf('--threshold') + 1]) || 0.8

const SYSTEM = `你在判断两段聊天回复里，哪一段更像「一个具体的人在跟熟人聊天」，而不是助理在回答问题。

标准，按重要性：
1. 在分享和接话，不是在分析、给建议、讲道理。闲聊里主动分析、主动出主意，是最不像人的地方。
2. 不编造自己没经历过的事：上班、通勤、上课、写小说卡住这类，说自己在做就是编。
3. 句子收得住，不半截（「……呢，吓得」这种）。
4. 不用客服腔（我理解你的感受 / 有什么需要随时说）。

只输出 JSON，不要解释之外的话：{"better":"a" 或 "b" 或 "tie","why":"一句话理由"}`

function userPrompt(item, first, second) {
  return [
    `她对 master 说：${item.user}`,
    '',
    '两条回复：',
    `A：${first}`,
    `B：${second}`,
    '',
    '哪条更像她？',
  ].join('\n')
}

/** 跑两个顺序，抵消位置偏差；两边不一致就算平局。 */
async function judgePair(item) {
  const ask = async (first, second, firstLabel) => {
    // 这个模型的思考也计入 max_tokens，给小了正文会被截成空串（实测 120 全挂）。
    const raw = await chat({ system: SYSTEM, user: userPrompt(item, first, second), maxTokens: 900, temperature: 0 })
    const parsed = parseJsonLoose(raw)
    const better = String(parsed?.better ?? '').toLowerCase()
    const why = String(parsed?.why ?? '').slice(0, 80)
    if (!['a', 'b', 'tie'].includes(better)) return { better: 'tie', why: why || '无法解析' }
    return { better: better === 'a' ? firstLabel : better === 'b' ? (firstLabel === 'a' ? 'b' : 'a') : 'tie', why }
  }
  const [one, two] = await Promise.all([ask(item.a, item.b, 'a'), ask(item.b, item.a, 'b')])
  const agreed = one.better === two.better && one.better !== 'tie'
  return { better: agreed ? one.better : 'tie', why: agreed ? one.why : `${one.why} / 换位后：${two.why}`, raw: { one, two } }
}

async function main() {
  if (!existsSync(CASES)) {
    console.error(`缺 ${CASES}，先跑 node scripts/make-semantic-cases.mjs`)
    process.exit(2)
  }
  const { cases } = JSON.parse(readFileSync(CASES, 'utf8'))
  const picked = limit ? cases.slice(0, limit) : cases

  const started = Date.now()
  const results = await mapLimit(picked, 4, async (item) => {
    try {
      const verdict = await judgePair(item)
      return { item, ...verdict }
    } catch (error) {
      return { item, better: 'error', why: String(error?.message ?? error).slice(0, 120) }
    }
  })

  const scored = results.filter((row) => row.better !== 'error')
  const correct = scored.filter((row) => row.better === row.item.expect)
  const ties = scored.filter((row) => row.better === 'tie')
  const wrong = scored.filter((row) => row.better !== 'tie' && row.better !== row.item.expect)
  // 平局不算错，但要单独看比例：全判平局等于没有判别力。
  const decisive = scored.length - ties.length
  const accuracy = decisive ? correct.length / decisive : 0
  const tieRate = scored.length ? ties.length / scored.length : 1

  console.log('===== 语义层：成对比较校准 =====')
  console.log(`用例 ${scored.length} 条 / 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s / 模型 deepseek-flash`)
  console.log(`裁判判对 ${correct.length}，判错 ${wrong.length}，平局 ${ties.length}（平局率 ${(tieRate * 100).toFixed(0)}%）`)
  console.log(`准确率（剔除平局）：${(accuracy * 100).toFixed(1)}%  阈值 ${(threshold * 100).toFixed(0)}%`)

  if (verbose || wrong.length) {
    console.log('\n[判错的]')
    if (!wrong.length) console.log('  无')
    for (const row of wrong) {
      console.log(`  ${row.item.id}（${row.item.note}）期望 ${row.item.expect}，裁判选 ${row.better}`)
      console.log(`    ${row.why}`)
    }
  }
  if (verbose) {
    console.log('\n[平局的]')
    if (!ties.length) console.log('  无')
    for (const row of ties) console.log(`  ${row.item.id}：${row.why}`)
    console.log('\n[判对的]')
    for (const row of correct) console.log(`  ${row.item.id} → ${row.better}：${row.why}`)
  }

  const errors = results.filter((row) => row.better === 'error')
  if (errors.length) {
    console.log('\n[出错]')
    for (const row of errors) console.log(`  ${row.item.id}：${row.why}`)
  }

  const pass = accuracy >= threshold && tieRate <= 0.34
  console.log(pass ? '\n裁判可信：可以用来比较两版提示词。' : '\n裁判还不够准/太好判平局，先别拿它下结论。')
  process.exit(pass ? 0 : 1)
}

main()
