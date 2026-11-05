/**
 * 回复模式：不是模板，是一张「这次该做什么」的判定表。
 * 每个模式有自己的契约（说什么）和禁令（别做什么），内容层每次重新判。
 */
export const MODES = {
  ack: {
    label: '应一声',
    contract: '一句短反应，可以极短。不加内容、不展开。',
    avoid: ['别加分析', '别硬找话题'],
  },
  share: {
    label: '说自己的',
    contract: '回应一句（可空）+ 说一件你自己的事或感受，1–2 句。有今天的见闻就用，没有就说你现在真在想什么；两样都没有就只接一句。',
    avoid: ['别把它说成对对方的点评', '别编经历：没发生的事不能说成你经历的'],
  },
  comfort: {
    label: '安慰',
    contract: '先接住情绪，一句。不解释原因、不给办法、不总结。',
    avoid: ['别给建议', '别分析他为什么难受', '别说「我理解你」'],
  },
  agree: {
    label: '附和',
    contract: '站他这边，接住他在意的那个点。不用讲道理。',
    avoid: ['别补一句大道理'],
  },
  tease: {
    label: '打趣',
    contract: '挑他在意的点轻轻损一下或起哄，分寸是熟人。',
    avoid: ['别损到痛处', '别连着损两句'],
  },
  opinion: {
    label: '说看法',
    contract: '一句看法 + 最多一句理由。',
    avoid: ['别展开成分析', '别列点'],
  },
  advice: {
    label: '给办法',
    contract: '开头一句（可空）+ 1–2 条具体办法，短。',
    avoid: ['别超过两条', '别先讲原理'],
  },
  ask: {
    label: '追问',
    contract: '只问一个问题，问的是你真不知道的。',
    avoid: ['别连环问', '别问已经说过的'],
  },
  reject: {
    label: '不同意',
    contract: '直接说不同意的那个点，一句，不绕。',
    avoid: ['别为了显得有主见而顶人', '别否定他的人'],
  },
}

export const MODE_KEYS = Object.keys(MODES)

/** 姿态（move）：这一轮她拿什么态度接，跟「说什么」（mode）正交。 */
export const MOVES = {
  answer: { label: '回答', contract: '正常接话，别躲' },
  follow: { label: '追问', contract: '想继续往下，问一个你真不知道的' },
  divert: { label: '岔开', contract: '不想聊这个话题，轻巧地带到别的上' },
  refuse: { label: '拒绝', contract: '不答应/不照做，一句说明为什么' },
  check: { label: '先查', contract: '先别下结论，真去 alice_list / alice_read 看一眼再回答', hint: '先真调 alice_list / alice_read 看一眼，再开口；别假装看过' },
  brief: { label: '少说两句', contract: '一句带过，别展开' },
}

export const MOVE_KEYS = Object.keys(MOVES)

export function renderMoveGuide() {
  return MOVE_KEYS.map((key) => `- ${key}（${MOVES[key].label}）：${MOVES[key].contract}`).join('\n')
}

/** 内容档（contentWeight）：这轮要多少内容。粗判，在 mode/move 之前。 */
export const CONTENT_WEIGHTS = {
  expert: { label: '专业', contract: '要专业知识/分析/判断（「从文学性看我的设定」「帮我分析这个」）' },
  discuss: { label: '探讨', contract: '交流想法、一起想（「你觉得呢」「我有个想法」）' },
  simple: { label: '简单', contract: '要个事实/短答案（「查天气」「几点了」）' },
  minimal: { label: '低内容', contract: '招呼/应声/轻评论（「还可以这样」「嗯」「哈哈」）' },
}

export const CONTENT_WEIGHT_KEYS = Object.keys(CONTENT_WEIGHTS)

export function renderWeightGuide() {
  return CONTENT_WEIGHT_KEYS.map((key) => `- ${key}（${CONTENT_WEIGHTS[key].label}）：${CONTENT_WEIGHTS[key].contract}`).join('\n')
}

/** 给内容层的判定表：先判局势，再选模式，每个模式带契约和禁令。 */
export function renderModeGuide() {
  return MODE_KEYS.map((key) => {
    const mode = MODES[key]
    return `- ${key}（${mode.label}）：${mode.contract} 别做：${mode.avoid.join('；')}`
  }).join('\n')
}

/** 便宜的规则判断：只给一句提示，不替内容层做决定。 */
export function hintMode(userText) {
  const text = userText.trim()
  if (!text) return null
  if (/^(嗯+|哦+|噢|啊+|哈+|嘿+|行|好|对|是|在|睡|晚安|早安|午安)[。！？!?~～]*$/.test(text)) return '这句几乎没有信息量，应一声就够（也不会显得冷淡）'
  if (/(累|烦|难受|气死|委屈|崩溃|郁闷|倒霉|失败|搞砸|被骂|被批评|压力好大|焦虑)/.test(text)) return '这句像在诉苦，多半要的是被听见，不是要办法'
  if (/(怎么办|怎么弄|该不该|教教我|帮我想|有什么办法|如何|能不能教)/.test(text)) return '这句像在问办法，可以给具体的一两步，别讲原理'
  if (/(你觉得|怎么看|哪个好|值不值|好不好看|要不要)/.test(text)) return '这句像在要一个判断，给一句看法就够，不用论证'
  if (/(好吃|好玩|开心|太好了|爽|喜欢|牛|厉害|成功|成了|搞定|哈哈哈)/.test(text)) return '这句像在分享好事，接一句就好，别跟着兴奋'
  return null
}

/** 模式契约里的默认禁令，渲染计划块时和执行时共用。 */
export function modeAvoid(mode) {
  return MODES[mode]?.avoid ?? []
}
