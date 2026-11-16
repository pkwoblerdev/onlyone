// Минимальный DOM-стенд для ломающих проверок renderer-модулей (без Electron).
// Поддерживает: innerHTML-разбор, querySelector(All), события с once/capture,
// focus/blur, classList, dataset, атрибуты. Только для repro в Temp.
'use strict'

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'use', 'stop'])
const BOOL = new Set(['hidden', 'disabled', 'checked', 'selected', 'multiple', 'readonly', 'controls', 'autoplay', 'allowpopups', 'sandbox'])
const dec = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
const enc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function makeDom () {
  const text = t => ({ nodeType: 3, textContent: String(t), parentNode: null, parentElement: null })
  function detach (n) { const p = n.parentNode; if (!p) return; const i = p._nodes.indexOf(n); if (i >= 0) p._nodes.splice(i, 1); n.parentNode = null; n.parentElement = null }
  function adopt (p, n) { detach(n); n.parentNode = p; if (p.nodeType === 1) n.parentElement = p; p._nodes.push(n); return n }
  function clear (n) { for (const c of n._nodes.slice()) detach(c) }
  function textOf (n) { return n._nodes.map(c => c.nodeType === 3 ? c.textContent : textOf(c)).join('') }
  function ser (n) {
    return n._nodes.map(c => {
      if (c.nodeType === 3) return c.textContent
      const a = [...c._attrs.entries()].map(([k, v]) => ` ${k}="${enc(v)}"`).join('')
      const tag = c.tagName.toLowerCase()
      return VOID.has(tag) ? `<${tag}${a}>` : `<${tag}${a}>${ser(c)}</${tag}>`
    }).join('')
  }
  function descendants (root) { const out = []; (function walk (n) { for (const c of n._nodes) if (c.nodeType === 1) { out.push(c); walk(c) } })(root); return out }
  function matchOne (el, sel) {
    if (!sel) return false
    const tag = /^[a-zA-Z][\w-]*/.exec(sel)
    if (tag && el.tagName !== tag[0].toUpperCase()) return false
    for (const part of sel.match(/[#.][\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?/g) || []) {
      if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false }
      else if (part[0] === '.') { if (!(el.getAttribute('class') || '').split(/\s+/).includes(part.slice(1))) return false }
      else if (part[0] === '[') {
        const inner = part.slice(1, -1)
        const eq = /^([\w:-]+)\s*=\s*([\s\S]*)$/.exec(inner)
        if (!eq) { if (!el.hasAttribute(inner)) return false }
        else if ((el.getAttribute(eq[1]) || '') !== eq[2].replace(/^["']|["']$/g, '')) return false
      } else if (part === ':scope') { /* ok */ }
      else if (part.startsWith(':not(')) { if (matchOne(el, part.slice(5, -1))) return false }
      else if (part === ':disabled') { if (!el.disabled) return false }
      else if (part === ':hidden') { if (!el.hidden) return false }
    }
    return true
  }
  function matchChain (el, chain, i) {
    if (!el || el.nodeType !== 1 || !matchOne(el, chain[i])) return false
    if (i === 0) return true
    let p = el.parentElement
    while (p) { if (matchChain(p, chain, i - 1)) return true; p = p.parentElement }
    return false
  }
  function queryAll (root, selector) {
    const out = []
    for (const group of String(selector).split(',')) {
      const chain = group.trim().replace(/^:scope\s*>?\s*/, '').split(/\s+/).filter(Boolean)
      if (!chain.length) continue
      for (const el of descendants(root)) {
        if (matchChain(el, chain, chain.length - 1) && !out.includes(el)) out.push(el)
      }
    }
    return out
  }
  function fire (el, type, props = {}) {
    const ev = { type, target: el, currentTarget: el, defaultPrevented: false, propagationStopped: false, immediateStopped: false,
      preventDefault () { this.defaultPrevented = true }, stopPropagation () { this.propagationStopped = true }, stopImmediatePropagation () { this.immediateStopped = true; this.propagationStopped = true }, ...props }
    let node = el
    while (node) {
      ev.currentTarget = node
      for (const l of (node._listeners || []).slice()) {
        if (l.type !== type) continue
        if (l.once) { const i = node._listeners.indexOf(l); if (i >= 0) node._listeners.splice(i, 1) }
        try { l.fn.call(node, ev) } catch (e) { ev.error = e }
        if (ev.immediateStopped) break
      }
      if (ev.propagationStopped) break
      node = node.parentNode
    }
    return ev
  }
  function applyAttrs (el, src) {
    const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let m
    while ((m = re.exec(String(src || '')))) {
      const name = m[1].toLowerCase()
      const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]
      const value = raw !== undefined ? dec(raw) : ''
      if (BOOL.has(name) && raw === undefined) { el[name] = true; el._attrs.set(name, ''); continue }
      el.setAttribute(name, value)
    }
  }
  function parseHtml (source) {
    const out = [], stack = []
    const push = n => { const p = stack[stack.length - 1]; if (p) adopt(p, n); else out.push(n) }
    const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
    let last = 0, m
    while ((m = re.exec(String(source)))) {
      const t = String(source).slice(last, m.index); if (t) push(text(dec(t)))
      last = re.lastIndex
      if (m[0].startsWith('<!')) continue
      if (m[1]) { const c = m[1].toUpperCase(); for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tagName === c) { stack.length = i; break } continue }
      const el = createElement(m[2]); applyAttrs(el, m[3]); push(el)
      if (!(m[4] === '/' || VOID.has(el.tagName.toLowerCase()))) stack.push(el)
    }
    const tail = String(source).slice(last); if (tail) push(text(dec(tail)))
    return out
  }
  function createElement (tagName) {
    const el = {
      nodeType: 1, tagName: String(tagName).toUpperCase(), _nodes: [], _attrs: new Map(), _listeners: [],
      parentNode: null, parentElement: null, style: { setProperty (k, v) { this[k] = v }, removeProperty (k) { delete this[k] } },
      dataset: {}, hidden: false, disabled: false, value: '', contentEditable: 'false', tabIndex: 0,
      scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTop: 0, offsetWidth: 100, offsetHeight: 30,
      addEventListener (type, fn, opts) { el._listeners.push({ type, fn, once: Boolean(opts && opts.once), capture: Boolean(opts && opts.capture) }) },
      removeEventListener (type, fn) { const i = el._listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) el._listeners.splice(i, 1) },
      dispatchEvent (ev) { return fire(el, ev.type, ev) },
      appendChild (n) { return adopt(el, n) },
      append (...ns) { for (const n of ns) adopt(el, typeof n === 'string' ? text(n) : n) },
      prepend (...ns) { for (const n of ns.slice().reverse()) { const node = typeof n === 'string' ? text(n) : n; detach(node); el._nodes.unshift(node); node.parentNode = el; node.parentElement = el } },
      insertBefore (n, ref) { const node = typeof n === 'string' ? text(n) : n; detach(node); const i = ref ? el._nodes.indexOf(ref) : -1; if (i < 0) el._nodes.push(node); else el._nodes.splice(i, 0, node); node.parentNode = el; node.parentElement = el; return node },
      replaceChildren (...ns) { clear(el); for (const n of ns) adopt(el, typeof n === 'string' ? text(n) : n) },
      remove () { detach(el) },
      after (...ns) { const p = el.parentNode; if (!p) return; const i = p._nodes.indexOf(el); for (const n of ns.slice().reverse()) { const node = typeof n === 'string' ? text(n) : n; detach(node); p._nodes.splice(i + 1, 0, node); node.parentNode = p; node.parentElement = p.nodeType === 1 ? p : null } },
      before (...ns) { const p = el.parentNode; if (!p) return; const i = p._nodes.indexOf(el); for (const n of ns) { const node = typeof n === 'string' ? text(n) : n; detach(node); p._nodes.splice(i, 0, node); node.parentNode = p; node.parentElement = p.nodeType === 1 ? p : null } },
      replaceWith (...ns) { const p = el.parentNode; if (!p) return; const i = p._nodes.indexOf(el); detach(el); for (const n of ns.slice().reverse()) { const node = typeof n === 'string' ? text(n) : n; detach(node); p._nodes.splice(i, 0, node); node.parentNode = p; node.parentElement = p.nodeType === 1 ? p : null } },
      getAttribute (n) { const k = String(n).toLowerCase(); if (el._attrs.has(k)) return el._attrs.get(k); return null },
      setAttribute (n, v) { const k = String(n).toLowerCase(); el._attrs.set(k, String(v)); if (k === 'class') el._className = String(v); if (k === 'id') el._id = String(v); if (k === 'hidden') el.hidden = v !== 'false'; if (k === 'disabled') el.disabled = v !== 'false'; if (k === 'value') el.value = String(v) },
      hasAttribute (n) { return el._attrs.has(String(n).toLowerCase()) },
      removeAttribute (n) { el._attrs.delete(String(n).toLowerCase()) },
      toggleAttribute (n, force) { const has = el.hasAttribute(n); const want = force === undefined ? !has : Boolean(force); if (want) el.setAttribute(n, ''); else el.removeAttribute(n); return want },
      cloneNode (deep) { const copy = createElement(el.tagName); for (const [k, v] of el._attrs) copy.setAttribute(k, v); if (deep) for (const c of el._nodes) copy.appendChild(c.nodeType === 3 ? text(c.textContent) : c.cloneNode(true)); return copy },
      getBoundingClientRect () { return { left: 8, top: 8, right: 108, bottom: 38, width: 100, height: 30 } },
      querySelector (s) { return queryAll(el, s)[0] || null },
      querySelectorAll (s) { return queryAll(el, s) },
      matches (s) { return String(s).split(',').some(p => matchOne(el, p.trim())) },
      closest (s) { let c = el; while (c && c.nodeType === 1) { if (c.matches(s)) return c; c = c.parentElement } return null },
      contains (n) { let c = n; while (c) { if (c === el) return true; c = c.parentNode } return false },
      focus () { document.activeElement = el; fire(el, 'focus') },
      blur () { if (document.activeElement === el) document.activeElement = null; fire(el, 'blur') },
      click () { fire(el, 'click', { bubbles: true }) },
      reload () { el._reloaded = (el._reloaded || 0) + 1 },
      getWebContentsId () { return 42 },
      setZoomFactor () {}, capturePage () { return Promise.resolve({ toDataURL: () => 'data:,', getSize: () => ({ width: 10, height: 10 }), resize () { return this } }) },
      executeJavaScript () { return Promise.resolve() },
      canGoToOffset () { return false }, goToOffset () {}, stop () {}, cut () {}, copy () {}, paste () {}, selectAll () {},
      load () {}, pause () {}, play () {},
      getContext () { return null }
    }
    Object.defineProperties(el, {
      children: { get () { return el._nodes.filter(n => n.nodeType === 1) } },
      childNodes: { get () { return el._nodes.slice() } },
      firstChild: { get () { return el._nodes[0] || null } },
      firstElementChild: { get () { return el._nodes.find(n => n.nodeType === 1) || null } },
      textContent: { get () { return textOf(el) }, set (v) { clear(el); if (v !== '' && v != null) adopt(el, text(String(v))) } },
      innerHTML: { get () { return ser(el) }, set (v) { clear(el); for (const n of parseHtml(v)) adopt(el, n) } },
      outerHTML: { get () { return ser({ _nodes: [el] }) } },
      className: { get () { return el.getAttribute('class') || '' }, set (v) { el.setAttribute('class', String(v)) } },
      id: { get () { return el.getAttribute('id') || '' }, set (v) { el.setAttribute('id', String(v)) } },
      src: { get () { return el.getAttribute('src') || '' }, set (v) { el.setAttribute('src', String(v)) } },
      isContentEditable: { get () { return el.contentEditable === 'true' } },
      selectedOptions: { get () { return el._nodes.filter(n => n.tagName === 'OPTION' && n.selected) } },
      classList: { get () {
        const list = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
        const put = a => el.setAttribute('class', a.join(' '))
        return { add: (...n) => put([...new Set([...list(), ...n])]), remove: (...n) => put(list().filter(i => !n.includes(i))),
          contains: n => list().includes(n), toggle (n, f) { const w = f === undefined ? !list().includes(n) : Boolean(f); if (w) put([...new Set([...list(), n])]); else put(list().filter(i => i !== n)); return w } }
      } }
    })
    // dataset связан с атрибутами data-*: модули пишут setAttribute, читают dataset.
    const dash = k => 'data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase())
    const camel = k => k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())
    el.dataset = new Proxy({}, {
      get: (t, k) => (typeof k === 'string' ? (el.getAttribute(dash(k)) === null ? undefined : el.getAttribute(dash(k))) : undefined),
      set: (t, k, v) => { el.setAttribute(dash(k), String(v)); return true },
      has: (t, k) => el.hasAttribute(dash(k)),
      deleteProperty: (t, k) => { el.removeAttribute(dash(k)); return true },
      ownKeys: () => [...el._attrs.keys()].filter(k => k.startsWith('data-')).map(camel),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    })
    return el
  }
  const body = createElement('BODY')
  const html = createElement('HTML')
  adopt(html, body)
  const document = {
    body, documentElement: html, activeElement: null, readyState: 'complete', hidden: false,
    createElement, createElementNS: (ns, tag) => createElement(tag), createTextNode: text,
    addEventListener (t, f, o) { body.addEventListener(t, f, o) }, removeEventListener (t, f) { body.removeEventListener(t, f) },
    dispatchEvent (ev) { return fire(body, ev.type, ev) },
    querySelector (s) { return queryAll(html, s)[0] || null },
    querySelectorAll (s) { return queryAll(html, s) },
    getElementById (id) { return queryAll(html, `[id=${id}]`)[0] || null },
    contains (n) { return html.contains(n) },
    getSelection () { return { selectAllChildren () {} } }
  }
  return { document, createElement, fire, parseHtml, queryAll }
}

// Элемент, который создаётся по первому требованию (для $ = id => ...).
function autoDom (dom, markup = '') {
  const known = new Map()
  if (markup) dom.document.body.innerHTML = markup
  for (const el of dom.queryAll(dom.document.documentElement, '[id]')) known.set(el.id, el)
  const $ = id => {
    if (known.has(id)) return known.get(id)
    const found = dom.document.getElementById(id)
    if (found) { known.set(id, found); return found }
    const el = dom.createElement('div')
    el.id = id
    dom.document.body.appendChild(el)
    known.set(id, el)
    return el
  }
  return { $, known }
}

module.exports = { makeDom, autoDom }