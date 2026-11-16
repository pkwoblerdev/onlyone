'use strict'

// Fixed page code only: the agent supplies data, never executable JavaScript.
function pageScript (request) {
  return `(${function (request) {
    if (location.href !== request.url || Date.now() > request.deadline) return { ok: false, code: 'conflict' }
    const visible = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
        rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
    }
    const sensitive = node => node.matches('input[type=password],input[type=file],input[type=hidden]') ||
      /password|secret|token|credit|cc-|one-time-code/i.test([node.name, node.id, node.autocomplete].join(' '))
    const selector = node => {
      const parts = []
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const tag = current.localName
        const siblings = [...(current.parentElement?.children || [current])].filter(item => item.localName === tag)
        parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')')
      }
      return parts.join(' > ')
    }
    if (request.interaction === 'observe') {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
      const chunks = []; let length = 0, node, scanned = 0
      while ((node = walker.nextNode()) && scanned++ < 20000 && length < 12000) {
        const parent = node.parentElement
        if (!parent || parent.closest('script,style,input,textarea,select,[contenteditable], [hidden]') || !visible(parent)) continue
        const text = node.textContent.trim().slice(0, 12000 - length)
        if (text) { chunks.push(text); length += text.length }
      }
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].slice(0, 2000)
        .filter(node => visible(node) && !sensitive(node)).slice(0, 150).map(node => ({
          selector: selector(node), tag: node.localName, type: node.type || '',
          label: (node.getAttribute('aria-label') || node.innerText || node.placeholder || '').slice(0, 200),
          disabled: !!node.disabled
        }))
      return { ok: true, title: document.title.slice(0, 200), text: chunks.join('\n'), elements,
        viewport: { width: innerWidth, height: innerHeight }, untrustedContent: true }
    }
    // Поле, где действует агент, обводится; прежняя обводка страницы хранится в метке и возвращается.
    if (request.interaction === 'mark') {
      for (const old of document.querySelectorAll('[data-onlyone-mark]')) {
        const [outline, offset] = JSON.parse(old.dataset.onlyoneMark)
        old.style.outline = outline; old.style.outlineOffset = offset
        delete old.dataset.onlyoneMark
      }
      if (!request.selector) return { ok: true }
      let node
      try { node = document.querySelector(request.selector) } catch { return { ok: false, code: 'invalid-selector' } }
      if (!node) return { ok: false, code: 'unavailable-target' }
      node.dataset.onlyoneMark = JSON.stringify([node.style.outline, node.style.outlineOffset])
      node.style.outline = '2px solid ' + (request.tone === 'warn' ? '#8b4e06' : '#b83c0a')
      node.style.outlineOffset = '2px'
      return { ok: true }
    }
    if (request.interaction === 'scroll') { scrollBy(0, request.delta); return { ok: true } }
    let node
    try { node = document.querySelector(request.selector) } catch { return { ok: false, code: 'invalid-selector' } }
    if (!node || !visible(node) || sensitive(node) || node.disabled) return { ok: false, code: 'unavailable-target' }
    const rect = node.getBoundingClientRect()
    const top = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)))
    if (!top || (top !== node && !node.contains(top))) return { ok: false, code: 'covered-target' }
    if (request.interaction === 'click') { node.click(); return { ok: true } }
    if (!node.matches('input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],input:not([type]),textarea') || node.readOnly) return { ok: false, code: 'unavailable-target' }
    const prototype = node.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, request.value)
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }.toString()})(${JSON.stringify(request)})`
}

function createDeskObservation ({ lookup, resolveFrame }) {
  const guests = new WeakMap()
  const opened = record => record?.window && !record.window.isDestroyed() && !record.rendererGone
  function register (record, input) {
    if (!opened(record)) return { ok: false, code: 'not-open' }
    const block = record.model.snapshot().blocks.find(block => block.id === input?.id)
    if (!block || block.revision !== input.revision || block.kind !== 'browser') return { ok: false, code: 'conflict' }
    const guest = Number.isSafeInteger(input.guestId) ? lookup?.(input.guestId) : null
    if (!guest || guest.isDestroyed() || guest.hostWebContents !== record.window.webContents) return { ok: false, code: 'forbidden' }
    if (!guests.has(record)) guests.set(record, new Map())
    guests.get(record).set(block.id, { guest, revision: block.revision })
    return { ok: true }
  }
  async function targetOf (record, snapshot, blockId) {
    const block = snapshot.blocks.find(block => block.id === blockId)
    let target = guests.get(record)?.get(blockId)
    if (block && block.kind !== 'browser' && resolveFrame) {
      let frame
      try { frame = await resolveFrame(record, block) } catch { return { code: 'unavailable-target' } }
      if (frame) target = { revision: block.revision, guest: frame }
      if (record.model.snapshot().revision !== snapshot.revision) return { code: 'conflict' }
    }
    if (!block || !target || block.revision !== target.revision || target.guest.isDestroyed()) return { code: 'unavailable-target' }
    return { block, target }
  }
  // Обводка поля-цели — вид, а не действие: без ревизии и удержания блока, только своя страница.
  async function mark (record, input) {
    if (!opened(record)) return { ok: false, code: 'not-open' }
    if (typeof input?.selector !== 'string' || input.selector.length > 2000 || (input.selector && !['acc', 'warn'].includes(input.tone))) return { ok: false, code: 'invalid' }
    const found = await targetOf(record, record.model.snapshot(), input.block_id)
    if (!found.target) return { ok: false, code: found.code }
    const url = found.target.guest.getURL()
    try {
      const allowed = found.block.kind === 'browser' ? ['https:', 'http:'] : ['onecode-artifact:', 'about:']
      if (!allowed.includes(new URL(url).protocol)) return { ok: false, code: 'forbidden' }
      return await found.target.guest.executeJavaScript(pageScript({ interaction: 'mark', selector: input.selector, tone: input.tone, url, deadline: Date.now() + 2000 }), false)
    } catch { return { ok: false, code: 'interaction-failed' } }
  }
  async function run (record, input, signal) {
    if (!opened(record)) return { ok: false, code: 'not-open' }
    const snapshot = record.model.snapshot()
    if (snapshot.revision !== input.expected_revision) return { ok: false, code: 'conflict' }
    const found = await targetOf(record, snapshot, input.block_id)
    if (!found.target) return { ok: false, code: found.code }
    const { block, target } = found
    if (!['observe', 'click', 'fill', 'scroll'].includes(input.interaction) ||
        (['click', 'fill'].includes(input.interaction) && (typeof input.selector !== 'string' || input.selector.length > 2000 || !input.selector)) ||
        (input.interaction === 'fill' && (typeof input.value !== 'string' || input.value.length > 4096)) ||
        (input.interaction === 'scroll' && (!Number.isSafeInteger(input.delta) || Math.abs(input.delta) > 4000))) return { ok: false, code: 'invalid' }
    const url = target.guest.getURL()
    try {
      const allowed = block.kind === 'browser' ? ['https:', 'http:'] : ['onecode-artifact:', 'about:']
      if (!allowed.includes(new URL(url).protocol)) return { ok: false, code: 'forbidden' }
    } catch { return { ok: false, code: 'forbidden' } }
    if (signal?.aborted) return { ok: false, code: 'aborted' }
    if (input.interaction !== 'observe' && record.model.preview) {
      const check = record.model.preview({ operationId: 'observe:' + require('node:crypto').randomUUID(), expectedRevision: snapshot.revision,
        actorId: 'agent:observation', operations: [{ type: 'geometry', id: block.id, rect: block.rect }] })
      if (!check.ok) return { ok: false, code: check.code }
    }
    try {
      let timer
      const result = await Promise.race([target.guest.executeJavaScript(pageScript({ interaction: input.interaction,
        selector: input.selector, value: input.value, delta: input.delta, url, deadline: Date.now() + 5000 }), false),
      new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, code: input.interaction === 'observe' ? 'timeout' : 'action-uncertain' }), 5000) })]).finally(() => clearTimeout(timer))
      if (signal?.aborted) return { ok: false, code: 'aborted' }
      if (!opened(record) || record.model.snapshot().revision !== snapshot.revision) return { ok: false, code: 'conflict' }
      return result
    } catch { return { ok: false, code: 'interaction-failed' } }
  }
  return { register, run, mark }
}
module.exports = { createDeskObservation, pageScript }
