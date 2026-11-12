// 爱丽丝的漫游开关（浏览器端，由 roam-panel.js 注入到页面）
//
// 右下角「漫」按钮（在声音圆点、记忆按钮上面）：
//   - 亮着「漫」= 漫游开着；灰着「停」= 关着
//   - 点一下切换，状态由主进程的 roam.json 持久化
//   - 开着时标题显示已花/预算；花满 5 块自动停（下次点开重新计费）
(() => {
  const STATE_URL = '/dsh-character/roam/state'
  const TOGGLE_URL = '/dsh-character/roam/toggle'

  if (window.__yuzuRoamLoaded) return
  window.__yuzuRoamLoaded = true

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '漫'
  btn.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:102px', 'z-index:2147483000',
    'width:34px', 'height:34px', 'border-radius:50%', 'border:none',
    'color:#fff', 'font-size:13px', 'line-height:34px', 'text-align:center',
    'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'transition:background .15s,opacity .15s',
  ].join(';')

  const paint = (state) => {
    const on = Boolean(state?.toggle)
    btn.textContent = on ? '漫' : '停'
    btn.title = on
      ? `漫游开着（已花 ${state.cost ?? 0}/${state.budget ?? 5}，花满自动停）`
      : '漫游关着（点一下开：三分钟不说话就自己逛逛）'
    btn.style.background = on ? 'rgba(56,161,105,.85)' : 'rgba(107,114,128,.75)'
    btn.style.opacity = on ? '.75' : '.45'
  }

  btn.addEventListener('click', async () => {
    try {
      const res = await fetch(TOGGLE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (res.ok) paint(await res.json())
    } catch {
      // 服务还没起来：下次再点。
    }
  })

  const mount = () => document.body.appendChild(btn)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
  paint({ toggle: false, cost: 0, budget: 5 })

  fetch(STATE_URL, { cache: 'no-store' })
    .then((r) => r.json())
    .then(paint)
    .catch(() => {})
})()
