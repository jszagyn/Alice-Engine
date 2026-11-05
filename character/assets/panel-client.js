// 记忆面板的前端（由 panel.js 注入）。
// 右下角「记」按钮 → 面板：列出她的记忆，能确认、取消确认、删掉、补一条。
;(() => {
  if (window.__alicePanelLoaded) return
  window.__alicePanelLoaded = true

  const API = '/dsh-character/memory'
  const BTN_ID = 'yz-mem-btn'
  const PANEL_ID = 'yz-mem-panel'

  const style = document.createElement('style')
  style.textContent = `
    #${BTN_ID} {
      position: fixed; right: 14px; bottom: 58px; z-index: 2147483000;
      width: 34px; height: 34px; border-radius: 50%; border: 1px solid #4b5563;
      background: #1f2937; color: #e5e7eb; font-size: 13px; line-height: 1;
      cursor: pointer; opacity: .75; font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
    }
    #${BTN_ID}:hover { opacity: 1; }
    #${PANEL_ID} {
      position: fixed; right: 14px; bottom: 100px; z-index: 2147483001;
      width: 340px; max-height: 62vh; display: none; flex-direction: column;
      background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45); font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
      font-size: 12px; overflow: hidden;
    }
    #${PANEL_ID}.open { display: flex; }
    .yz-mem-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #374151; }
    .yz-mem-title { font-weight: 600; font-size: 13px; }
    .yz-mem-stats { color: #9ca3af; flex: 1; }
    .yz-mem-close { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 16px; line-height: 1; }
    .yz-mem-add { display: flex; gap: 6px; padding: 9px 12px; border-bottom: 1px solid #374151; }
    .yz-mem-add input {
      flex: 1; min-width: 0; background: #1f2937; border: 1px solid #4b5563; border-radius: 6px;
      color: #e5e7eb; padding: 5px 8px; font-size: 12px; outline: none;
    }
    .yz-mem-add input:focus { border-color: #6b7280; }
    .yz-mem-slots { padding: 6px 0; border-bottom: 1px solid #374151; }
    .yz-slot { display: flex; align-items: center; gap: 6px; padding: 4px 12px; }
    .yz-slot-label { color: #9ca3af; flex: 0 0 auto; }
    .yz-slot-value { flex: 1; min-width: 0; word-break: break-word; }
    .yz-slot-src { color: #6b7280; font-size: 11px; }
    .yz-slot-edit { background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 11px; padding: 0; }
    .yz-slot-input {
      flex: 1; min-width: 0; background: #1f2937; border: 1px solid #4b5563; border-radius: 6px;
      color: #e5e7eb; padding: 3px 6px; font-size: 12px; outline: none;
    }
    .yz-mem-list { overflow-y: auto; padding: 6px 0; }
    .yz-mem-item { padding: 8px 12px; border-bottom: 1px solid #1f2937; }
    .yz-mem-item:last-child { border-bottom: none; }
    .yz-mem-text { line-height: 1.5; word-break: break-word; }
    .yz-mem-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: #6b7280; flex-wrap: wrap; }
    .yz-mem-tag { padding: 0 5px; border-radius: 4px; border: 1px solid #374151; font-size: 11px; }
    .yz-mem-tag.ok { color: #34d399; border-color: #065f46; }
    .yz-mem-tag.auto { color: #fbbf24; border-color: #78350f; }
    .yz-mem-tag.dim { color: #9ca3af; }
    .yz-mem-acts { margin-left: auto; display: flex; gap: 8px; }
    .yz-mem-acts button { background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 11px; padding: 0; }
    .yz-mem-acts button.danger { color: #f87171; }
    .yz-mem-empty { padding: 16px 12px; color: #6b7280; text-align: center; }
    .yz-mem-foot { padding: 6px 12px; border-top: 1px solid #374151; color: #f87171; min-height: 0; }
  `
  document.head.appendChild(style)

  const btn = document.createElement('button')
  btn.id = BTN_ID
  btn.type = 'button'
  btn.title = '她的记忆'
  btn.textContent = '记'

  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.innerHTML = `
    <div class="yz-mem-head">
      <span class="yz-mem-title">她的记忆</span>
      <span class="yz-mem-stats"></span>
      <button class="yz-mem-close" type="button" title="关掉">×</button>
    </div>
    <div class="yz-mem-slots"></div>
    <div class="yz-mem-add">
      <input type="text" maxlength="60" placeholder="补一条：master 喜欢…">
      <button type="button" class="yz-mem-save">记下</button>
    </div>
    <div class="yz-mem-list"></div>
    <div class="yz-mem-foot"></div>
  `

  const listEl = panel.querySelector('.yz-mem-list')
  const slotsEl = panel.querySelector('.yz-mem-slots')
  const statsEl = panel.querySelector('.yz-mem-stats')
  const footEl = panel.querySelector('.yz-mem-foot')
  const inputEl = panel.querySelector('.yz-mem-add input')
  const saveEl = panel.querySelector('.yz-mem-save')

  let loading = false

  function setFoot(text) {
    footEl.textContent = text || ''
  }

  function tag(text, cls) {
    const el = document.createElement('span')
    el.className = `yz-mem-tag ${cls}`
    el.textContent = text
    return el
  }

  function renderSlots(slots) {
    const rows = Array.isArray(slots) ? slots : []
    slotsEl.textContent = ''
    if (!rows.length) return
    for (const slot of rows) {
      const row = document.createElement('div')
      row.className = 'yz-slot'

      const label = document.createElement('span')
      label.className = 'yz-slot-label'
      label.textContent = slot.label ?? slot.key

      const value = document.createElement('span')
      value.className = 'yz-slot-value'
      value.textContent = slot.value ?? ''

      const src = document.createElement('span')
      src.className = 'yz-slot-src'
      src.textContent = slot.sourceText ?? ''

      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'yz-slot-edit'
      edit.textContent = '改'
      edit.addEventListener('click', () => {
        const input = document.createElement('input')
        input.className = 'yz-slot-input'
        input.value = slot.value ?? ''
        input.maxLength = 40
        row.replaceChild(input, value)
        input.focus()
        input.select()
        let done = false
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            done = true
            post('slot', { key: slot.key, value: input.value.trim() })
          }
          if (event.key === 'Escape') {
            done = true
            load()
          }
        })
        input.addEventListener('blur', () => {
          if (!done) load()
        })
      })

      row.append(label, value, src, edit)
      slotsEl.appendChild(row)
    }
  }

  function render(data) {
    const items = Array.isArray(data?.items) ? data.items : []
    const stats = data?.stats ?? {}
    statsEl.textContent = items.length
      ? `${stats.total ?? items.length} 条 · 确认 ${stats.confirmed ?? 0} / 自动 ${stats.auto ?? 0}`
      : '空的'
    renderSlots(data?.slots)

    listEl.textContent = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'yz-mem-empty'
      empty.textContent = '还没记住什么'
      listEl.appendChild(empty)
      return
    }

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'yz-mem-item'

      const text = document.createElement('div')
      text.className = 'yz-mem-text'
      text.textContent = item.text ?? ''
      row.appendChild(text)

      const meta = document.createElement('div')
      meta.className = 'yz-mem-meta'
      meta.appendChild(tag(item.tier === 'event' ? '事件' : '事实', 'dim'))
      meta.appendChild(tag(item.confirmed ? '已确认' : '自动', item.confirmed ? 'ok' : 'auto'))
      if (item.status === 'superseded') meta.appendChild(tag('已被取代', 'dim'))
      if (item.status === 'dormant') meta.appendChild(tag('沉睡', 'dim'))

      const acts = document.createElement('div')
      acts.className = 'yz-mem-acts'

      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.textContent = item.confirmed ? '取消确认' : '确认'
      confirmBtn.addEventListener('click', () => {
        post('confirm', { id: item.id, confirmed: !item.confirmed })
      })
      acts.appendChild(confirmBtn)

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'danger'
      delBtn.textContent = '删'
      delBtn.addEventListener('click', () => {
        post('delete', { id: item.id })
      })
      acts.appendChild(delBtn)

      meta.appendChild(acts)
      row.appendChild(meta)
      listEl.appendChild(row)
    }
  }

  async function load() {
    if (loading) return
    loading = true
    try {
      const response = await fetch(API, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      setFoot('')
      render(data)
    } catch (error) {
      setFoot(`读取失败：${error?.message ?? error}`)
    } finally {
      loading = false
    }
  }

  async function post(action, body) {
    setFoot('')
    try {
      const response = await fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      render(data)
    } catch (error) {
      setFoot(`没成功：${error?.message ?? error}`)
      load()
    }
  }

  function toggle(open) {
    const next = typeof open === 'boolean' ? open : !panel.classList.contains('open')
    panel.classList.toggle('open', next)
    if (next) {
      setFoot('')
      load()
      inputEl.focus()
    }
  }

  btn.addEventListener('click', () => toggle())
  panel.querySelector('.yz-mem-close').addEventListener('click', () => toggle(false))
  saveEl.addEventListener('click', () => {
    const text = inputEl.value.trim()
    if (!text) return
    post('add', { text }).then(() => {
      inputEl.value = ''
    })
  })
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveEl.click()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggle(false)
  })

  document.body.appendChild(btn)
  document.body.appendChild(panel)
})()
