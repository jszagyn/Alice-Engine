const POSITIVE = /(谢谢|谢啦|多谢|厉害|不错|真好|喜欢你|好棒|可爱|聪明|有趣|好玩|有意思|thank|thanks|nice|great|awesome)/i
const NEGATIVE = /(不对|错了|失望|无聊|闭嘴|算了|随便|幼稚|stupid|wrong|boring|dumb)/i
const QUESTION = /[?？]|(吗|呢)[。！!.?？]?$/
const NEWS = /(新闻|热搜|新出|最近|你听说|你知道吗|看到|刷到|news|trending)/i
const REPAIR = /(抱歉|对不起|是我语气|刚才是我)/
const SHARE = /(我觉得|我感觉|我这个人|我比较|我平时|我会|我偏|对我来说)/
const ASKBACK = /(你呢|那你呢|你觉不觉得|你会不会|你怎么样|你偏)/
const REQUEST = /(帮我|给我|先帮我|麻烦你|帮个忙|能不能帮我)/
const COMMAND = /(快去|赶紧|立刻|马上|必须|快点|别废话|别磨蹭|你去做|去把|去做|先做)/
const EMO_HIGH = /(太好了|太棒|绝了|哈哈哈|爽|开心|高兴|厉害|牛|好耶|！！！)/
const EMO_LOW = /(烦|难受|难过|累死|崩溃|失望|气死|委屈|想哭|焦虑|压力大)/

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * Rule-based appraisal: what this turn meant for her, not what she said.
 * Every contribution is named so data/appraisal.jsonl explains each shift.
 */
export function appraise({ user = '', assistant = '', toolErrors = 0 }, character = null) {
  const deltas = { valence: 0, arousal: 0, energy: 0, trust: 0, pressure: 0, frustration: 0, curiosity: 0, affinity: 0 }
  const reasons = []
  const warmth = character?.traits?.warmth ?? 0.7
  const curiosity = character?.traits?.curiosity ?? 0.8
  const trustGain = character?.dynamics?.trustGain ?? 0.03
  const trustLoss = character?.dynamics?.trustLoss ?? 0.06

  if (POSITIVE.test(user)) {
    deltas.valence += 0.14 + 0.12 * warmth
    deltas.arousal += 0.06
    deltas.trust += trustGain
    reasons.push('被肯定')
  }
  if (NEGATIVE.test(user)) {
    deltas.valence -= 0.28
    deltas.arousal += 0.04
    deltas.trust -= trustLoss
    reasons.push('被否定')
  }
  if (QUESTION.test(user)) {
    deltas.arousal += 0.04
    deltas.trust += trustGain * 0.35
    reasons.push('被问')
  }
  if (NEWS.test(user)) {
    deltas.arousal += 0.03 + 0.06 * curiosity
    reasons.push('有新鲜事')
  }
  if (REPAIR.test(user)) {
    deltas.valence += 0.12
    deltas.trust += trustGain * 0.7
    reasons.push('他道歉了')
  }
  if (SHARE.test(user)) {
    deltas.trust += trustGain * 0.7
    deltas.arousal += 0.03
    reasons.push('说了自己')
  }
  if (ASKBACK.test(user)) {
    deltas.trust += trustGain * 0.7
    deltas.valence += 0.04
    reasons.push('问回你')
  }
  if (COMMAND.test(user)) {
    deltas.pressure += 0.15
    deltas.valence -= 0.04
    reasons.push('被强令')
  } else if (REQUEST.test(user)) {
    deltas.pressure += 0.05
    reasons.push('被请求')
  }
  if (user.length >= 20) {
    deltas.trust += trustGain * 0.35
    deltas.arousal += 0.02
    reasons.push('有来有回')
  }
  if (user.trim().length > 0 && user.trim().length < 4 && !QUESTION.test(user)) {
    deltas.valence -= 0.06
    deltas.arousal -= 0.04
    reasons.push('被敷衍')
  }
  if (toolErrors > 0) {
    deltas.valence -= 0.08
    reasons.push('工具出错')
  }
  if (assistant.length > 200) {
    deltas.arousal += 0.03
    reasons.push('说得起劲')
  }

  // 五维情绪的另外三维：挫败/好奇/社交亲和，从 tags 反推。
  if (reasons.includes('被否定')) { deltas.frustration += 0.18; deltas.affinity -= 0.12 }
  if (reasons.includes('被敷衍')) { deltas.frustration += 0.08; deltas.affinity -= 0.1 }
  if (reasons.includes('被强令')) deltas.frustration += 0.08
  if (reasons.includes('工具出错')) deltas.frustration += 0.12
  if (reasons.includes('有新鲜事')) deltas.curiosity += 0.15
  if (reasons.includes('被问')) deltas.curiosity += 0.08
  if (reasons.includes('被肯定')) deltas.affinity += 0.08
  if (reasons.includes('问回你')) deltas.affinity += 0.06
  if (reasons.includes('说了自己')) deltas.affinity += 0.05
  if (reasons.includes('有来有回')) deltas.affinity += 0.04

  deltas.trust = clamp(deltas.trust, -trustLoss, trustGain)

  // 他的情绪：兴奋 / 低落 / 平静（给情绪层的情绪基数用）。
  const hisEmotion = EMO_HIGH.test(user) ? 'high' : EMO_LOW.test(user) ? 'low' : 'mid'

  return {
    deltas,
    reason: reasons.length ? reasons.join(' · ') : '平常一轮',
    tags: reasons,
    hisEmotion,
    turn: { user: user.slice(0, 200), assistant: assistant.slice(0, 400), toolErrors },
  }
}
