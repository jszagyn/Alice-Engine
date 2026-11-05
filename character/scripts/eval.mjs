#!/usr/bin/env node
/**
 * 评测回归集：node scripts/eval.mjs [--update] [--verbose]
 *
 * 三层检查：
 *  1. 断言层（必须过）：对抗用例必须命中指定坏例；good 用例不许有坏例。
 *  2. 不变量层（必须过）：她的话里不该出现的东西（客服腔/敬语/开头空行过多）。
 *  3. 漂移层（只报告）：真实用例的判别和基线不一样——可能是我改好了，也可能是改坏了，
 *     由人看。`--update` 把当前结果写成新基线。
 *
 * 退出码：断言或不变量失败 → 1；只有漂移 → 0。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { criticize } from '../lib/critic.js'

const DATA = join(import.meta.dirname, '..', 'data')
const CASES_FILE = join(DATA, 'eval', 'cases.json')
const BASE_FILE = join(DATA, 'eval', 'baseline.json')

const argv = process.argv.slice(2)
const update = argv.includes('--update')
const verbose = argv.includes('--verbose')

const INVARIANTS = [
  { label: '敬语「您」', severity: 'fail', test: (reply) => /您/.test(reply) },
  { label: '客服套话', severity: 'fail', test: (reply) => /(请稍等|正在为您|有什么可以帮|有什么能帮|希望这些建议|如有疑问|如有任何问题)/.test(reply) },
  // 观感问题：模型爱在开头垫空行。不影响对话质量，但页面上会多出空白，记为警告不判失败。
  { label: '开头空行过多', severity: 'warn', test: (reply) => /^(?:[ \t]*\n){2,}/.test(reply) },
]

function loadCases() {
  if (!existsSync(CASES_FILE)) {
    console.error(`缺 ${CASES_FILE}，先跑 node scripts/make-eval-cases.mjs`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(CASES_FILE, 'utf8'))
}

function loadBaseline() {
  if (!existsSync(BASE_FILE)) return null
  try {
    return JSON.parse(readFileSync(BASE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function checkCase(item) {
  const context = { ...(item.context ?? {}), kind: item.kind ?? 'chat' }
  const result = criticize(item.reply, item.plan ?? null, context)
  const failures = []
  const warnings = []
  const expect = item.expect ?? {}

  if (expect.verdict && result.verdict !== expect.verdict) {
    failures.push(`判别应为 ${expect.verdict}，实际 ${result.verdict}（${result.reasons.join('、') || '无'}）`)
  }
  for (const reason of expect.mustInclude ?? []) {
    if (!result.reasons.includes(reason)) failures.push(`应命中「${reason}」，实际：${result.reasons.join('、') || '无'}`)
  }
  for (const reason of expect.mustNotInclude ?? []) {
    if (result.reasons.includes(reason)) failures.push(`不该命中「${reason}」`)
  }
  if (!item.skipInvariants) {
    for (const rule of INVARIANTS) {
      if (!rule.test(item.reply)) continue
      const line = `违反不变量：${rule.label}`
      if (rule.severity === 'warn') warnings.push(line)
      else failures.push(line)
    }
  }

  return { result, failures, warnings }
}

function main() {
  const { cases } = loadCases()
  const baseline = loadBaseline()?.cases ?? {}

  const failures = []
  const warnings = []
  const drifts = []
  const current = {}

  for (const item of cases) {
    const { result, failures: caseFailures, warnings: caseWarnings } = checkCase(item)
    current[item.id] = { verdict: result.verdict, reasons: result.reasons }
    for (const failure of caseFailures) failures.push({ id: item.id, failure })
    for (const warning of caseWarnings) warnings.push({ id: item.id, warning })

    if (item.source === 'real' && baseline[item.id]) {
      const before = baseline[item.id]
      const changed =
        before.verdict !== result.verdict ||
        before.reasons.join('|') !== result.reasons.join('|')
      if (changed) {
        drifts.push({
          id: item.id,
          before: `${before.verdict}${before.reasons.length ? `（${before.reasons.join('、')}）` : ''}`,
          after: `${result.verdict}${result.reasons.length ? `（${result.reasons.join('、')}）` : ''}`,
          reply: item.reply.slice(0, 60),
        })
      }
    }
  }

  const total = cases.length
  const failedIds = new Set(failures.map((row) => row.id))

  console.log('===== 爱丽丝 · 评测回归集 =====')
  console.log(`用例 ${total} 条（真实 ${cases.filter((c) => c.source === 'real').length} / 对抗 ${cases.filter((c) => c.source !== 'real').length}）`)
  console.log(`断言 + 不变量：${total - failedIds.size} 过 / ${failedIds.size} 失败`)
  if (warnings.length) console.log(`警告（不判失败）：${warnings.length} 条`)
  if (failures.length) {
    console.log('\n[失败]')
    for (const row of failures) console.log(`  ${row.id}\n    ${row.failure}`)
  }
  if (warnings.length) {
    console.log('\n[警告]')
    const byLabel = new Map()
    for (const row of warnings) {
      const key = row.warning.replace('违反不变量：', '')
      byLabel.set(key, (byLabel.get(key) ?? 0) + 1)
    }
    for (const [label, count] of byLabel) console.log(`  ${label}：${count} 条`)
  }

  if (baseline && drifts.length) {
    console.log(`\n[漂移] ${drifts.length} 条（判别和基线不同，复核一下是改好了还是改坏了）`)
    for (const row of drifts) {
      console.log(`  ${row.id}：${row.before} → ${row.after}\n    原文：${row.reply}`)
    }
  } else if (baseline) {
    console.log('\n[漂移] 无——和基线一致')
  }

  if (verbose) {
    console.log('\n[逐条]')
    for (const item of cases) {
      const row = current[item.id]
      console.log(`  ${row.verdict === 'good' ? '✓' : '×'} ${item.id} ${row.reasons.join('、')}`)
    }
  }

  if (update) {
    mkdirSync(join(DATA, 'eval'), { recursive: true })
    writeFileSync(
      BASE_FILE,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), cases: current }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\n基线已更新：${BASE_FILE}`)
  } else if (!baseline) {
    console.log('\n（还没有基线，跑一次 `node scripts/eval.mjs --update` 建立）')
  }

  process.exit(failedIds.size ? 1 : 0)
}

main()
