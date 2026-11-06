// 爱丽丝的声音桥（浏览器端，由 voice.js 注入到页面）
//
// 她说完一句，主进程把文本塞进队列，这里轮询取出来用系统自带的语音念。
// 不联网、不要 key、不要额外安装——用的是 Windows / Edge 里已经有的中文语音。
// 右下角的圆点是开关（常驻）：亮着「声」= 开，灰着「静」= 关，状态记在 localStorage。
(() => {
  const ENDPOINT = '/dsh-character/voice/pending'
  const STORE_KEY = 'dsh-character-voice-enabled'
  const POLL_MS = 1200
  const MAX_CHARS = 400

  if (window.__aliceVoiceLoaded) return
  window.__aliceVoiceLoaded = true
  if (!('speechSynthesis' in window)) return

  let enabled = localStorage.getItem(STORE_KEY) !== '0'
  let lastId = null
  let speaking = false
  const pending = []

  // ——— 开关（常驻，点一下切换，不消失） ———
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.textContent = '声'
  dot.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
    'width:34px', 'height:34px', 'border-radius:50%', 'border:none',
    'color:#fff', 'font-size:14px', 'line-height:34px', 'text-align:center',
    'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'transition:background .15s,opacity .15s',
  ].join(';')

  const paint = () => {
    dot.textContent = enabled ? '声' : '静'
    dot.title = enabled ? '爱丽丝的声音：开着（点一下静音）' : '爱丽丝的声音：静音（点一下打开）'
    dot.style.background = enabled ? 'rgba(70,120,200,.85)' : 'rgba(107,114,128,.75)'
    dot.style.opacity = enabled ? '.75' : '.45'
  }

  const stopSpeaking = () => {
    pending.length = 0
    speaking = false
    try {
      window.speechSynthesis.cancel()
    } catch {
      // 取消失败不影响开关状态。
    }
  }

  dot.addEventListener('click', () => {
    enabled = !enabled
    localStorage.setItem(STORE_KEY, enabled ? '1' : '0')
    paint()
    if (enabled) {
      // 重新打开时只记当前位置，不把关着期间的积压一次念完。
      lastId = null
      poll()
    } else {
      stopSpeaking()
    }
  })

  const mount = () => document.body.appendChild(dot)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
  paint()

  // ——— 选一个中文声音 ———
  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices()
    if (!voices.length) return null
    const zh = voices.filter((v) => /^zh/i.test(v.lang) || /chinese|中文|普通话/i.test(v.name))
    const pool = zh.length ? zh : voices
    const preferred = /Xiaoxiao|Xiaoyi|Yunxi|Yunyang|Huihui|Yaoyao|Tingting|Kangkang|Neural/i
    return pool.find((v) => preferred.test(v.name)) ?? pool[0]
  }

  // ——— 一句一句念 ———
  const speakNext = () => {
    if (!enabled || speaking) return
    const next = pending.shift()
    if (!next) return

    if (next.audio) {
      // TTS 合成好了：直接播合成音频，不用系统语音。
      speaking = true
      const audio = new Audio(`/dsh-character/voice/audio?id=${next.id}`)
      audio.onended = () => {
        speaking = false
        speakNext()
      }
      audio.onerror = () => {
        speaking = false
        speakNext()
      }
      audio.play().catch(() => {
        speaking = false
        speakNext()
      })
      return
    }

    const text = String(next.text ?? '').slice(0, MAX_CHARS).trim()
    if (text.length < 2) return speakNext()

    speaking = true
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = pickVoice()
    if (voice) utterance.voice = voice
    utterance.lang = 'zh-CN'
    utterance.rate = 1.03
    utterance.pitch = 1.08
    utterance.onend = () => {
      speaking = false
      speakNext()
    }
    utterance.onerror = () => {
      speaking = false
      speakNext()
    }
    window.speechSynthesis.speak(utterance)
  }

  async function poll() {
    if (!enabled) return
    try {
      const url = lastId === null ? ENDPOINT : `${ENDPOINT}?since=${lastId}`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (lastId === null) {
        // 第一次连上（或刚重新打开）：只记位置，不把历史全念一遍。
        lastId = Number(data.now ?? 0)
        return
      }
      for (const item of data.items ?? []) {
        if (item.id <= lastId) continue
        lastId = item.id
        pending.push(item)
      }
      speakNext()
    } catch {
      // 服务还没起来 / 页面在离线：下一轮再说。
    }
  }

  // 有些浏览器要等 voices 加载完，先预热一次。
  window.speechSynthesis.getVoices()
  if (typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices())
  }

  setInterval(poll, POLL_MS)
  poll()
})()
