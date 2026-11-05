// 四组剧本测试：情境 / 记忆连续 / 演化 / 一致性。
// 全确定性（不调 LLM），跑脚本化场景，验证机制按预期反应。
// 和 eval.mjs（判判别器）互补：这里测状态机 + 记忆 + 情绪。
// 用法：node scripts/eval-scenarios.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-character-scenario-'))
process.env.DSH_CHARACTER_DATA = sandbox

const { loadState, applyAppraisal, renderState } = await import('../lib/state.js')
const { appraise } = await import('../lib/appraise.js')
const { loadProfile, rememberInProfile } = await import('../lib/profile.js')
const { loadEpisodic, rememberEpisode, relevantEpisodes } = await import('../lib/episodic.js')

const character = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'character.json'), 'utf8'))

let pass = 0
let fail = 0
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// ── 场景 1：情境反应（appraise 对不同话给对增量）──
console.log('[场景 1：情境反应]')
{
  const neg = appraise({ user: '你真没用，闭嘴' })
  ok('被否定 → 挫败上升', (neg.deltas.frustration ?? 0) > 0)
  ok('被否定 → 亲和下降', (neg.deltas.affinity ?? 0) < 0)
  ok('被否定 → 心情下降', (neg.deltas.valence ?? 0) < 0)
  const news = appraise({ user: '你听说那个新游戏了吗' })
  ok('有新鲜事 → 好奇上升', (news.deltas.curiosity ?? 0) > 0)
  const praise = appraise({ user: '谢谢你，真厉害' })
  ok('被肯定 → 亲和上升', (praise.deltas.affinity ?? 0) > 0)
}

// ── 场景 2：记忆连续（槽位写进 + 短期检索带出）──
console.log('[场景 2：记忆连续]')
{
  const profile = loadProfile()
  const wrote = rememberInProfile(profile, '我住在杭州西湖区', { source: 'master' })
  ok('「住杭州」写进 profile', wrote.some((w) => w.key === 'identity.city'))

  const episodic = loadEpisodic()
  const ep = rememberEpisode(episodic, '我最近在写一篇叫希娅日记的小说', { saidBy: 'master' })
  ok('「写小说」进短期记忆', Boolean(ep))
  const rel = relevantEpisodes(episodic, '希娅日记写得怎么样了', 2)
  ok('相关检索带出小说那条', rel.some((e) => e.text.includes('小说')))
}

// ── 场景 3：情绪演化（连续被否定 → 挫败累积 → tendency 变）──
console.log('[场景 3：情绪演化]')
{
  const state = loadState(character.initial)
  const before = state.frustration ?? 0.2
  for (const user of ['你闭嘴', '太无聊了', '不对你错了']) {
    applyAppraisal(state, appraise({ user }), character)
  }
  ok('连续被否定后挫败累积', (state.frustration ?? 0.2) > before, `（${before.toFixed(2)} → ${(state.frustration ?? 0.2).toFixed(2)}）`)
  ok('tendency 命中挫败分支', renderState(state).includes('挫败'))
}

// ── 场景 4：一致性（信任涨慢跌快）──
console.log('[场景 4：信任不对称]')
{
  const up = loadState(character.initial)
  applyAppraisal(up, appraise({ user: '谢谢你，真厉害' }), character)
  const gain = (up.trust ?? 1) - character.initial.trust

  const down = loadState(character.initial)
  applyAppraisal(down, appraise({ user: '你闭嘴' }), character)
  const loss = character.initial.trust - (down.trust ?? 0)

  ok('信任跌的比涨的多（涨慢跌快）', loss > gain, `（涨 ${gain.toFixed(3)} / 跌 ${loss.toFixed(3)}）`)
}

console.log(`\n结果：${pass} 过 / ${fail} 失败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
