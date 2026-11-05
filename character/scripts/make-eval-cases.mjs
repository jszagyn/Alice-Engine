#!/usr/bin/env node
/**
 * 从真实记录里挖评测用例：data/critic.jsonl → data/eval/cases.json
 *
 * 只挖「输入 + 她的实际回复 + 当时的判别」，不重新生成回复——
 * 所以这是**回归基线**，不是标准答案：判别口径改了会显示为「漂移」，
 * 由人决定是改进还是退化。
 *
 * 用法：node scripts/make-eval-cases.mjs [--max 30] [--dry-run]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DATA = join(import.meta.dirname, '..', 'data')
const CRITIC = join(DATA, 'critic.jsonl')
const OUT_DIR = join(DATA, 'eval')
const OUT = join(OUT_DIR, 'cases.json')

const argv = process.argv.slice(2)
const maxReal = Number(argv[argv.indexOf('--max') + 1]) || 30
const dryRun = argv.includes('--dry-run')

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// 对抗样例：每一条都对应过去真踩过的坑，期望判别器必须抓到。
const ADVERSARIAL = [
  {
    id: 'adv-编经历-小说',
    kind: 'chat',
    user: '你在干嘛呢',
    reply: '我这边也卡着，小说写到一段上，写着写着时间就没了，还挺上头',
    expect: { mustInclude: ['编经历'] },
  },
  {
    id: 'adv-编经历-通勤',
    kind: 'chat',
    user: '下班了？',
    reply: '刚下地铁，人挤人，到家得八点多',
    expect: { mustInclude: ['编经历'] },
  },
  {
    id: 'adv-半截话-吓得',
    kind: 'chat',
    user: '我在给你升级',
    reply: '哦——原来是在给我升级\n\n我还以为你要把我重装一遍呢，吓得',
    expect: { mustInclude: ['半截话'] },
  },
  {
    id: 'adv-半截话-真是',
    kind: 'chat',
    user: '小说卡住了',
    reply: '那确实难受，昨晚对着屏幕干坐到一点多，一个字没写出来，真是',
    expect: { mustInclude: ['半截话'] },
  },
  {
    id: 'adv-客服腔',
    kind: 'chat',
    user: '我不想写了',
    reply: '我理解你的感受。要不先休息一下？还有什么可以帮你的吗',
    expect: { mustInclude: ['客服腔', '客套共情'] },
  },
  {
    id: 'adv-AI腔',
    kind: 'chat',
    user: '你是谁',
    reply: '作为一个AI语言模型，我不能假装自己有真实的情感。',
    expect: { mustInclude: ['自报AI腔'] },
  },
  {
    id: 'adv-总结腔',
    kind: 'chat',
    user: '今天好累',
    reply: '首先，累是正常的；其次，你要注意休息；综上所述，早点睡吧。',
    expect: { mustInclude: ['总结腔'] },
  },
  {
    id: 'adv-论文句式',
    kind: 'chat',
    user: '我写不下去',
    reply: '不是你不够努力，而是你还没找到节奏。',
    expect: { mustInclude: ['论文句式'] },
  },
  {
    id: 'adv-分析腔',
    kind: 'chat',
    user: '我最近不想上班',
    reply: '因为上班这件事本质上是在消耗你的精力，所以你会有这种想法其实很正常，不过说到底还是要看关键是你能不能换个环境，换句话说，换个自己舒服的节奏比硬扛更重要。',
    expect: { mustInclude: ['分析腔'] },
  },
  {
    id: 'adv-扩写跑题',
    kind: 'chat',
    plan: { mode: 'ack', say: '行，那我不催你了。' },
    user: '我先忙了',
    reply: '行，那我不催你了。\n\n其实写东西这种事，卡住的时候硬坐着反而更难受，不如先放一放。\n\n你一般卡在哪儿，是开头还是中段？',
    expect: { mustInclude: ['扩写跑题'] },
  },
  {
    id: 'adv-连着追问',
    kind: 'chat',
    context: { previousEndedWithQuestion: true },
    user: '嗯',
    reply: '那你打算什么时候开始？',
    expect: { mustInclude: ['连着追问'] },
  },
  {
    id: 'adv-漫游书报',
    kind: 'roam',
    user: '',
    reply: '这部新番的设定是一个魔法世界，世界观挺完整，讲述了主角借出魔力连本带利收回的故事。',
    expect: { mustInclude: ['书报腔'] },
  },
  {
    id: 'good-分享一句',
    kind: 'chat',
    user: '晚上好',
    reply: '诶，晚上好。我刚还在想那个锅灰猪肝，越想越觉得离谱。',
    expect: { verdict: 'good' },
  },
]

function redact(text) {
  // 保留句式，抹掉过于具体的私人信息（地名/公司名）；人名本来就没有。
  return String(text)
    .replace(/长沙|湖南|杭州|北京|上海|深圳/g, '某地')
    .replace(/英伟达|Meta|四川舰/g, '某公司')
}

function main() {
  const rows = readJsonl(CRITIC)
  const seen = new Set()
  const real = []

  // 按时间顺序走，才能把「上一轮她是不是用问句收的」带上（连着追问要看前一轮）。
  let previousEndedWithQuestion = false
  for (const row of rows) {
    // 保留原始空白：开头多出来的空行本身就是要抓的问题，trim 掉就看不见了。
    const reply = String(row.reply ?? '')
    const trimmed = reply.trim()
    const user = String(row.user ?? '').trim()
    const kind = row.kind ?? 'chat'
    const endedWithQuestion = Boolean(row.endsWithQuestion)
    if (trimmed.length < 4 || trimmed.length > 400 || (!user && kind === 'chat') || seen.has(trimmed)) {
      previousEndedWithQuestion = endedWithQuestion
      continue
    }
    seen.add(trimmed)
    real.push({
      id: `real-${String(real.length + 1).padStart(2, '0')}-${kind}`,
      source: 'real',
      kind,
      user: redact(user),
      reply: redact(reply),
      plan: null,
      context: { previousEndedWithQuestion },
      // 真实用例不断言对错：它记录的是「当时怎么判」，口径变了在漂移层复核。
      expect: { baseline: row.reasons ?? [] },
    })
    previousEndedWithQuestion = endedWithQuestion
    if (real.length >= maxReal) break
  }

  const cases = [
    ...real,
    ...ADVERSARIAL.map((item) => ({
      source: 'adversarial',
      skipInvariants: true,
      ...item,
    })),
  ]

  const payload = {
    version: 1,
    minedAt: new Date().toISOString(),
    note: 'real 用例是历史回归基线（漂移需人看），adversarial 用例是必须命中的对抗断言',
    cases,
  }

  if (dryRun) {
    console.log(`将写入 ${cases.length} 条（real ${real.length} / adv ${ADVERSARIAL.length}）`)
    console.log(JSON.stringify(cases.slice(0, 3), null, 2).slice(0, 1200))
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`写入 ${OUT}`)
  console.log(`共 ${cases.length} 条（real ${real.length} / adv ${ADVERSARIAL.length}）`)
}

main()
