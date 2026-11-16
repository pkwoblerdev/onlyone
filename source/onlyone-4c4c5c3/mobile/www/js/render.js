/* Лента ответа на телефоне: Markdown, блоки хода (размышление, шаги, чек-лист, текст), снимки.
   Блоки приходят с компьютера в том виде, как их хранит onlyone (message-blocks.js): kind, text, parts{verb,target,tone,tool,meta}. */
(function (root) {
  'use strict'
  const { icon } = root.OnlyoneIcons
  const { t } = root.OnlyoneI18n

  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const esc = text => String(text == null ? '' : text).replace(/[&<>"']/g, ch => ENT[ch])

  // Ответ модели — недоверенный текст: сырой HTML в нём не рисуем, ссылки только http(s), картинки не грузим.
  function markdown(text) {
    const source = String(text || '')
    if (!root.marked) return '<p>' + esc(source) + '</p>'
    const renderer = new root.marked.Renderer()
    renderer.html = html => esc(html && typeof html === 'object' ? html.text || html.raw || '' : html)
    renderer.link = (href, title, label) => {
      let url = href
      let shown = label
      if (href && typeof href === 'object') { url = href.href; shown = href.text }
      if (!/^https?:\/\//i.test(String(url || ''))) return typeof shown === 'string' ? shown : esc(url || '')
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + (typeof shown === 'string' ? shown : esc(url)) + '</a>'
    }
    renderer.image = (href, title, label) => esc((href && href.text) || label || '')
    try { return root.marked.parse(source, { renderer, breaks: true, gfm: true, async: false }) } catch { return '<p>' + esc(source) + '</p>' }
  }

  function toolIcon(tool) {
    const name = String(tool || '')
    if (name === 'run_command' || name.startsWith('own_')) return 'terminal'
    if (/^(read_file|skill_file|project_file|dc_read)/.test(name)) return 'file'
    if (/^(write_file|dc_write|dc_html|dc_js|dc_set|define_tool)/.test(name)) return 'edit'
    if (name === 'fetch_url' || name.startsWith('browse_')) return 'globe'
    if (/^(list_files|dc_list|create_directory|move_path)/.test(name)) return 'folder'
    if (name === 'search_files') return 'search'
    if (/^(show_artifact|update_artifact|show_video|dc_refs)/.test(name)) return 'image'
    return 'code'
  }

  function stepHtml(block) {
    const parts = block.parts || {}
    const verb = parts.verb || block.title || parts.tool || t('Шаг')
    const target = parts.target || ''
    const count = Array.isArray(block.items) && block.items.length > 1 ? '×' + block.items.length : (parts.meta || '')
    return '<div class="step' + (parts.tone === 'err' ? ' err' : '') + '">' + icon(toolIcon(parts.tool || block.tool)) +
      '<b>' + esc(verb) + '</b>' + (target ? '<span>' + esc(target) + '</span>' : '') + (count ? '<em>' + esc(count) + '</em>' : '') + '</div>'
  }

  function planHtml(block) {
    let steps = []
    try { steps = JSON.parse(block.text) } catch { steps = [] }
    if (!Array.isArray(steps) || !steps.length) return ''
    const done = steps.filter(step => step && step.status === 'done').length
    const rows = steps.slice(0, 40).map(step => {
      const state = step && step.status === 'done' ? 'done' : (step && (step.status === 'doing' || step.status === 'in_progress') ? 'doing' : '')
      return '<div class="plan-item ' + state + '"><i class="dot"></i><span>' + esc((step && step.title) || t('Шаг')) + '</span></div>'
    }).join('')
    return '<div class="plan"><div class="plan-head"><span>' + esc(block.title || t('План')) + '</span><span>' + done + ' / ' + steps.length + '</span></div>' + rows + '</div>'
  }

  function thoughtHtml(text, live) {
    const body = String(text || '').trim()
    if (!body) return ''
    const first = body.split('\n')[0].replace(/^[#*\s]+|[*\s]+$/g, '').slice(0, 70) || t('Размышление')
    return '<details class="thought"' + (live ? ' open' : '') + '><summary>' + icon('chev', 'ic-sm ic-chev') + '<span>' + esc(first) + '</span></summary><div class="thought-body">' + esc(body.slice(0, 6000)) + '</div></details>'
  }

  function imagesOf(block) {
    const out = []
    for (const key of ['image', 'shot', 'screenshot', 'dataUrl']) {
      const value = block && block[key]
      if (typeof value === 'string' && /^data:image\//.test(value)) out.push(value)
    }
    return out
  }

  function blocksHtml(blocks, live) {
    const out = []
    const list = Array.isArray(blocks) ? blocks : []
    for (let index = 0; index < list.length; index++) {
      const block = list[index]
      if (!block) continue
      const kind = block.kind || block.type
      if (kind === 'text') { if (String(block.text || '').trim()) out.push('<div class="prose">' + markdown(block.text) + '</div>') }
      else if (kind === 'thinking' || kind === 'reasoning') out.push(thoughtHtml(block.text, live && index === list.length - 1))
      else if (kind === 'plan') out.push(planHtml(block))
      else if (kind === 'tool' || kind === 'step') out.push(stepHtml(block))
      for (const url of imagesOf(block)) out.push('<img class="shot" alt="' + esc(t('Снимок')) + '" src="' + esc(url) + '">')
    }
    return out.join('')
  }

  // Сообщение целиком: у ответа есть блоки — рисуем их; иначе простой текст ответа.
  function messageHtml(message) {
    if (!message) return ''
    if (message.role === 'user') return '<div class="msg-user">' + esc(message.content || '') + '</div>'
    const hasBlocks = Array.isArray(message.blocks) && message.blocks.length
    const blocks = hasBlocks ? message.blocks : [{ kind: 'text', text: message.content || '' }]
    const reasoning = !hasBlocks && message.reasoning ? thoughtHtml(message.reasoning, false) : ''
    return '<div class="msg-ai">' + reasoning + blocksHtml(blocks, false) + (message.error ? '<div class="err-text">' + esc(message.error) + '</div>' : '') + '</div>'
  }

  function liveHtml(live) {
    if (!live) return ''
    const blocks = Array.isArray(live.blocks) ? live.blocks : []
    let html = blocksHtml(blocks, true)
    const hasText = blocks.some(block => block && block.kind === 'text' && String(block.text || '').trim())
    if (!hasText && String(live.content || '').trim()) html += '<div class="prose">' + markdown(live.content) + '</div>'
    return '<div class="msg-ai">' + html + '<div class="live-line"><i class="dot work"></i><span>' + esc(t('Работает')) + '</span></div></div>'
  }

  root.OnlyoneRender = { markdown, messageHtml, liveHtml, blocksHtml, esc }
})(window)
