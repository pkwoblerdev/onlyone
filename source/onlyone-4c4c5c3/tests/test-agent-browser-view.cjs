// test-agent-browser-view.cjs — КРАСНЫЕ проверки живого вида браузера агента в
// панели «Работа» (план, пункт 3.6б «Браузер агента: действия и живой вид»).
//
// Тест написан ДО продуктового кода: `src/renderer/agent-browser-view.js` в
// дереве нет, и весь набор красный по этой причине — по отсутствию поведения.
// Шапка делает мягкий `try/require`, первая проверка объявляет «модуля нет»,
// остальные работают с заглушкой, которая бросает `НЕТ КОНТРАКТА: <причина>`,
// поэтому прогон даёт список красных с внятной строкой на каждую, а не один
// `Cannot find module`.
//
// Контракт, замороженный ведущим:
//   модуль   `src/renderer/agent-browser-view.js` — `create(deps)` с API
//            `{ renderFrame, setError, setStopped, dispose }`;
//   канал    `agent-browser-event` в окне, слушатель `onAgentBrowserEvent` в
//            `src/preload/preload.js` (тот же порядок, что `onDesignTaskEvent`);
//   вид      кадр страницы агента в панели «Работа» и кнопка «Остановить»;
//   подключение — своим тегом в `index.html` до `app.js`.
//
// Стиль харнесса — как в `tests/test-design-task-card.cjs`: настоящий модуль,
// самодельный DOM, внедряемые `deps`, поиск узлов по видимому тексту, а не по
// именам классов (имен узлов в контракте нет).
//
// Чего контракт НЕ задаёт и что харнесс подставляет сам (названы в докладе):
//  - где живёт карточка: даны и панель `#tasksPanel`, и `deps.host`, и `$()`;
//    поиск ведётся по всему `<body>`, модуль волен выбрать место;
//  - каким полем события приходит адрес кадра: `frameUrl`, `screenshotUrl`,
//    `previewUrl`, `imageUrl`, `src`, `href` — все шесть равны одному значению,
//    реализация берёт любое;
//  - форма `setError`: строка причины или объект `{ error }` — принимаются оба;
//  - поле `status`/`kind` события — в наборе есть, но требовать его не будем.
//
// Оконного прогона здесь нет сознательно: живые прогоны сегодня не запускаются
// (в общем `node_modules` нет `conf`), он — отдельная работа.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const VIEW_SOURCE = process.env.ONECODE_VIEW_UNDER_TEST || path.join(ROOT, 'src', 'renderer', 'agent-browser-view.js')
// Пути к чужим файлам выводятся переменными — тот же приём, что
// `ONECODE_MAIN_UNDER_TEST` в tests/test-run-checkpoint-main-wiring.cjs: так
// харнесс проверяет себя на эталонной реализации. В общем прогоне они не
// выставлены, и читаются канонические файлы.
const INDEX_SOURCE = process.env.ONECODE_INDEX_UNDER_TEST || path.join(ROOT, 'src', 'renderer', 'index.html')
const PRELOAD_SOURCE = process.env.ONECODE_PRELOAD_UNDER_TEST || path.join(ROOT, 'src', 'preload', 'preload.js')

const API_METHODS = ['renderFrame', 'setError', 'setStopped', 'dispose']
const FRAME_URL = 'https://example.com/live/frame-1.png'
const FRAME_URL_KEYS = ['frameUrl', 'screenshotUrl', 'previewUrl', 'imageUrl', 'src', 'href']

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + ((error && error.message) || error))
  }
}

const NO_CONTRACT = 'НЕТ КОНТРАКТА'
const rel = file => path.relative(ROOT, file).split(path.sep).join('/')
const msg = error => String((error && error.message) || error || '').split('\n')[0].slice(0, 300)

// --- мягкая загрузка модуля ------------------------------------------------------

let view = null
let moduleLoadError = null
try {
  if (!fs.existsSync(VIEW_SOURCE)) throw new Error('файла нет в дереве')
  view = require(VIEW_SOURCE)
} catch (error) {
  moduleLoadError = error
}

function noContract (reason) {
  const api = {}
  for (const name of API_METHODS) api[name] = () => { throw new Error(NO_CONTRACT + ': ' + reason) }
  return api
}

// --- самодельный DOM -------------------------------------------------------------

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const NO_MIRROR = new Set(['id', 'class', 'classname', 'textcontent', 'innerhtml', 'children', 'childnodes', 'dataset', 'style'])

const decodeEntities = text => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function makeDom () {
  const makeText = text => ({ nodeType: 3, textContent: String(text), parentNode: null })
  let document = null

  // --- MutationObserver -----------------------------------------------------------
  // Живой вид прикреплён к панели, которая перестраивает своё содержимое целиком,
  // и в окне он держит на этой панели `MutationObserver`. Заглушка повторяет тот
  // же договор: `adopt`/`detach` отмечают узел, колбэк приходит отдельной
  // микрозадачей.
  const watchers = new Map()
  function mark (node) {
    const list = node && watchers.get(node)
    if (!list) return
    for (const callback of list) queueMicrotask(() => callback([]))
  }
  function MutationObserver (callback) {
    let seen = []
    return {
      observe (node) {
        if (!node) return
        if (!watchers.has(node)) watchers.set(node, new Set())
        watchers.get(node).add(callback)
        seen.push(node)
      },
      disconnect () {
        for (const node of seen) {
          const list = watchers.get(node)
          if (list) list.delete(callback)
        }
        seen = []
      }
    }
  }

  function detach (node) {
    const parent = node.parentNode
    if (!parent) return
    const index = parent._nodes.indexOf(node)
    if (index >= 0) parent._nodes.splice(index, 1)
    node.parentNode = null
    node.parentElement = null
    mark(parent)
    if (document && nodeContains(document.activeElement, node)) document.activeElement = document.body
  }

  function adopt (parent, node) {
    detach(node)
    node.parentNode = parent
    if (parent.nodeType === 1) node.parentElement = parent
    parent._nodes.push(node)
    mark(parent)
    return node
  }

  function clear (node) {
    for (const child of node._nodes.slice()) detach(child)
  }

  const textOf = node => node._nodes.map(child => (child.nodeType === 3 ? child.textContent : textOf(child))).join('')

  // Текстовые узлы при сериализации ЭКРАНИРУЮТСЯ: иначе проверка «текст модели
  // попал в DOM как текст, а не как разметка» краснела бы на правильном коде.
  function serialize (node) {
    return node._nodes.map(child => {
      if (child.nodeType === 3) return escapeText(child.textContent)
      const tag = child.tagName.toLowerCase()
      const attrs = [...child._attrs.entries()].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('')
      if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`
      return `<${tag}${attrs}>${serialize(child)}</${tag}>`
    }).join('')
  }

  function classList (el) {
    const list = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
    const put = items => el.setAttribute('class', items.join(' '))
    return {
      add (...names) { put([...new Set([...list(), ...names])]) },
      remove (...names) { put(list().filter(item => !names.includes(item))) },
      contains (name) { return list().includes(name) },
      toggle (name, force) {
        const want = force === undefined ? !list().includes(name) : Boolean(force)
        if (want) put([...new Set([...list(), name])])
        else put(list().filter(item => item !== name))
        return want
      }
    }
  }

  function matchCompound (el, compound) {
    if (!compound) return false
    if (!/^[#.[\w*]/.test(compound)) return false
    if (compound === '*') return true
    const tag = /^[a-zA-Z][\w-]*/.exec(compound)
    if (tag && el.tagName !== tag[0].toUpperCase()) return false
    const parts = compound.match(/[#.][\w-]+|\[[^\]]+\]/g) || []
    for (const part of parts) {
      if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false }
      else if (part[0] === '.') { if (!(el.getAttribute('class') || '').split(/\s+/).includes(part.slice(1))) return false }
      else {
        const inner = part.slice(1, -1)
        const eq = /^([\w:-]+)\s*=\s*([\s\S]*)$/.exec(inner)
        if (!eq) { if (!el.hasAttribute(inner)) return false }
        else if ((el.getAttribute(eq[1]) || '') !== eq[2].replace(/^["']|["']$/g, '')) return false
      }
    }
    return true
  }

  function descendants (root) {
    const out = []
    const walk = node => { for (const child of node._nodes) if (child.nodeType === 1) { out.push(child); walk(child) } }
    walk(root)
    return out
  }

  function nodeContains (parent, node) {
    let current = node
    while (current) { if (current === parent) return true; current = current.parentNode }
    return false
  }

  function textNodes (root) {
    const out = []
    const walk = node => {
      for (const child of node._nodes) {
        if (child.nodeType === 3) out.push(child)
        else if (child.nodeType === 1) walk(child)
      }
    }
    walk(root)
    return out
  }

  function queryAll (root, selector) {
    const out = []
    for (const group of String(selector).split(',')) {
      const chain = group.trim().split(/\s+/).filter(Boolean)
      if (!chain.length) continue
      for (const el of descendants(root)) {
        let index = chain.length - 1
        let current = el
        let ok = true
        while (index >= 0) {
          if (!current || current.nodeType !== 1 || !matchCompound(current, chain[index])) { ok = false; break }
          current = current.parentElement
          index--
        }
        if (ok && !out.includes(el)) out.push(el)
      }
    }
    return out
  }

  function applyAttrs (el, source) {
    const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let match
    while ((match = re.exec(String(source || '')))) {
      const name = match[1].toLowerCase()
      const value = match[2] !== undefined ? decodeEntities(match[2])
        : match[3] !== undefined ? decodeEntities(match[3])
          : match[4] !== undefined ? decodeEntities(match[4]) : ''
      el.setAttribute(name, value)
    }
  }

  function parseHtml (source) {
    const out = []
    const stack = []
    const push = node => {
      const parent = stack[stack.length - 1]
      if (parent) adopt(parent, node)
      else out.push(node)
    }
    const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
    let last = 0
    let match
    while ((match = re.exec(String(source)))) {
      const text = String(source).slice(last, match.index)
      if (text) push(makeText(decodeEntities(text)))
      last = re.lastIndex
      if (match[0].startsWith('<!')) continue
      if (match[1]) {
        const closing = match[1].toUpperCase()
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tagName === closing) { stack.length = i; break }
        continue
      }
      const el = createElement(match[2])
      applyAttrs(el, match[3])
      push(el)
      if (!(match[4] === '/' || VOID_TAGS.has(el.tagName.toLowerCase()))) stack.push(el)
    }
    const tail = String(source).slice(last)
    if (tail) push(makeText(decodeEntities(tail)))
    return out
  }

  function fireClick (el) {
    const event = { type: 'click', target: el, currentTarget: el, preventDefault () {}, stopPropagation () { event._stopped = true } }
    let current = el
    while (current) {
      event.currentTarget = current
      for (const listener of (current._listeners || []).filter(item => item.type === 'click')) listener.fn(event)
      if (typeof current.onclick === 'function') current.onclick(event)
      if (event._stopped) break
      current = current.parentElement
    }
    return event
  }

  function createElement (tagName) {
    const el = {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      _nodes: [],
      _attrs: new Map(),
      _listeners: [],
      parentNode: null,
      parentElement: null,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      addEventListener (type, fn) { el._listeners.push({ type, fn }) },
      removeEventListener (type, fn) {
        const index = el._listeners.findIndex(item => item.type === type && item.fn === fn)
        if (index >= 0) el._listeners.splice(index, 1)
      },
      appendChild (node) { return adopt(el, node) },
      append (...nodes) { for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      replaceChildren (...nodes) { clear(el); for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      insertBefore (node, before) {
        adopt(el, node)
        const index = el._nodes.indexOf(before)
        if (index >= 0) { el._nodes.splice(el._nodes.indexOf(node), 1); el._nodes.splice(index, 0, node) }
        return node
      },
      remove () { detach(el) },
      getAttribute (name) {
        const key = String(name).toLowerCase()
        if (el._attrs.has(key)) return el._attrs.get(key)
        const direct = NO_MIRROR.has(key) ? undefined : el[key]
        if (typeof direct === 'string') return direct
        if (direct === true) return ''
        return null
      },
      setAttribute (name, value) {
        const key = String(name).toLowerCase()
        el._attrs.set(key, String(value))
        if (!NO_MIRROR.has(key)) el[key] = String(value)
      },
      hasAttribute (name) { return el.getAttribute(name) !== null },
      removeAttribute (name) {
        const key = String(name).toLowerCase()
        el._attrs.delete(key)
        if (!NO_MIRROR.has(key)) delete el[key]
      },
      getElementsByTagName (name) { return descendants(el).filter(node => node.tagName === String(name).toUpperCase()) },
      querySelector (selector) { return queryAll(el, selector)[0] || null },
      querySelectorAll (selector) { return queryAll(el, selector) },
      matches (selector) { return String(selector).split(',').some(part => matchCompound(el, part.trim())) },
      closest (selector) {
        let current = el
        while (current) { if (matchCompound(current, selector)) return current; current = current.parentElement }
        return null
      },
      contains (node) { return nodeContains(el, node) },
      focus () { document.activeElement = el },
      blur () {},
      click () { return fireClick(el) }
    }
    Object.defineProperties(el, {
      children: { get () { return el._nodes.filter(node => node.nodeType === 1) } },
      childNodes: { get () { return el._nodes.slice() } },
      firstChild: { get () { return el._nodes[0] || null } },
      textContent: {
        get () { return textOf(el) },
        set (value) { clear(el); if (value !== '' && value !== null && value !== undefined) adopt(el, makeText(String(value))) }
      },
      innerHTML: {
        get () { return serialize(el) },
        set (value) { clear(el); for (const node of parseHtml(value)) adopt(el, node) }
      },
      outerHTML: { get () { return serialize({ _nodes: [el] }) } },
      className: { get () { return el.getAttribute('class') || '' }, set (value) { el.setAttribute('class', String(value)) } },
      id: { get () { return el.getAttribute('id') || '' }, set (value) { el.setAttribute('id', String(value)) } },
      classList: { get () { return classList(el) } }
    })
    return el
  }

  const body = createElement('BODY')
  const documentSubs = []
  document = {
    body,
    activeElement: body,
    documentElement: createElement('HTML'),
    createElement,
    createTextNode: makeText,
    addEventListener (type, fn, options) { documentSubs.push({ target: 'document', type, fn, options }) },
    removeEventListener (type, fn) {
      const index = documentSubs.findIndex(item => item.type === type && item.fn === fn)
      if (index >= 0) documentSubs.splice(index, 1)
    },
    querySelector (selector) { return queryAll(body, selector)[0] || null },
    querySelectorAll (selector) { return queryAll(body, selector) },
    contains (node) { return nodeContains(body, node) }
  }

  // Панель «Работа» в окне растёт динамически (`app.js` снимает `#tasksPanel`),
  // харнесс даёт её заранее: живой вид обязан появиться внутри.
  for (const node of parseHtml('<div id="tasksPanel" class="tasks-panel"><div class="tasks-body"></div></div>')) adopt(body, node)

  const byId = new Map()
  for (const el of descendants(body)) {
    const id = el.getAttribute('id')
    if (id && !byId.has(id)) byId.set(id, el)
  }

  const win = {
    _subs: [],
    addEventListener (type, fn, options) { win._subs.push({ target: 'window', type, fn, options }) },
    removeEventListener (type, fn) {
      const index = win._subs.findIndex(item => item.type === type && item.fn === fn)
      if (index >= 0) win._subs.splice(index, 1)
    },
    matchMedia: () => ({ matches: false, addEventListener () {}, removeEventListener () {} }),
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id)
  }

  return {
    body, document, win, createElement, descendants, textNodes, nodeContains, fireClick, byId,
    MutationObserver,
    subs: () => [...documentSubs, ...win._subs]
  }
}

// --- deps и событие канала --------------------------------------------------------

const t = (text, ...args) => {
  let index = 0
  return String(text).replace(/%s/g, () => (index < args.length ? String(args[index++]) : '%s'))
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]))

const ELEMENTS = [
  { index: 0, tag: 'a', role: 'link', name: 'МИШЕНА-ЭЛЕМЕНТ-ССЫЛКА', type: null, href: 'https://example.com/report' },
  { index: 1, tag: 'button', role: 'button', name: 'МИШЕНА-ИМЯ <img src=x onerror=alert(1)>', type: 'submit', href: 'javascript:alert(2)' },
  { index: 2, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ & <script>alert(3)</script>', type: 'text', href: null }
]

// Событие канала: разрешённые поля контракта, ссылка на кадр под всеми
// правдоподобными именами и заведомо лишние ключи (пункт 9 требований).
function frameEvent (over = {}) {
  const event = {
    kind: 'frame',
    status: 'frame',
    url: 'https://example.com/one',
    title: 'МИШЕНА-ЗАГОЛОВОК <i>страницы</i>',
    elements: ELEMENTS,
    width: 1280,
    height: 800,
    bytes: 24576,
    truncated: true,
    chatId: 'чат-А',
    requestId: 'ход-1'
  }
  for (const key of FRAME_URL_KEYS) event[key] = FRAME_URL
  return Object.assign(event, {
    html: '<b>МИШЕНА-ЛИШНЕЕ-HTML</b>',
    markup: '<b>МИШЕНА-ЛИШНЕЕ-MARKUP</b>',
    innerHtml: '<i>МИШЕНА-ЛИШНЕЕ-INNERHTML</i>',
    script: 'МИШЕНА-ЛИШНЕЕ-SCRIPT',
    dom: '<u>МИШЕНА-ЛИШНЕЕ-DOM</u>',
    cookie: 'МИШЕНА-ЛИШНЕЕ-COOKIE',
    password: 'МИШЕНА-ЛИШНЕЕ-PASSWORD-DUMMY',
    frameHtml: '<em>МИШЕНА-ЛИШНЕЕ-FRAMEHTML</em>'
  }, over)
}

const STRAY_MARKERS = ['МИШЕНА-ЛИШНЕЕ-HTML', 'МИШЕНА-ЛИШНЕЕ-MARKUP', 'МИШЕНА-ЛИШНЕЕ-INNERHTML', 'МИШЕНА-ЛИШНЕЕ-SCRIPT',
  'МИШЕНА-ЛИШНЕЕ-DOM', 'МИШЕНА-ЛИШНЕЕ-COOKIE', 'МИШЕНА-ЛИШНЕЕ-PASSWORD-DUMMY', 'МИШЕНА-ЛИШНЕЕ-FRAMEHTML']

function makeScene (opts = {}) {
  const dom = makeDom()
  const calls = { stop: [], bridge: [] }
  const electronAPI = {
    onAgentBrowserEvent: callback => {
      calls.bridge.push(callback)
      return () => { /* отписка моста */ }
    },
    onDesignTaskEvent: () => () => {}
  }
  const stop = (...args) => { calls.stop.push(args) }
  const host = dom.createElement('div')
  host.setAttribute('id', 'agentBrowserHost')
  dom.body.appendChild(host)

  const $ = id => {
    if (dom.byId.has(id)) return dom.byId.get(id)
    const el = dom.createElement('div')
    el.setAttribute('id', id)
    dom.body.appendChild(el)
    dom.byId.set(id, el)
    return el
  }

  const deps = Object.assign({
    document: dom.document,
    window: dom.win,
    $,
    t,
    escapeHtml,
    electronAPI,
    stop,
    host,
    // Вид следит за хозяином карточки: панель «Работа» перестраивает своё
    // содержимое целиком, и без наблюдающего карточка исчезала бы вместе с ним.
    MutationObserver: dom.MutationObserver,
    panel: dom.byId.get('tasksPanel'),
    tasksPanel: dom.byId.get('tasksPanel')
  }, opts.deps || {})

  let api = null
  let broken = null
  if (moduleLoadError) broken = `${rel(VIEW_SOURCE)} не подключается (${msg(moduleLoadError)}) — весь набор красный по этой причине`
  else if (!view || typeof view.create !== 'function') broken = `в модуле нет create(deps): отдаётся ${typeof (view || {}).create}`
  else {
    try {
      api = view.create(deps) || {}
    } catch (error) {
      broken = `create(deps) бросила: ${msg(error)}`
    }
    if (!broken) {
      const absent = API_METHODS.filter(name => typeof api[name] !== 'function')
      if (absent.length) broken = `у результата create() нет ${absent.join(', ')}; есть только: ${Object.keys(api).join(', ') || '(ничего)'}`
    }
  }
  const realApi = api || {}
  if (broken) api = noContract(broken)

  const isHost = el => Boolean(el) && el.nodeType === 1 && (
    ['tasksPanel', 'agentBrowserHost'].includes(el.getAttribute('id') || '') ||
    (el.getAttribute('class') || '').split(/\s+/).some(name => /tasks-panel|tasks-body|agent-browser/i.test(name))
  )

  function roots (token) {
    const found = new Set()
    for (const node of dom.textNodes(dom.body)) {
      if (!String(node.textContent).includes(token)) continue
      let el = node.parentNode
      if (!el || el === dom.body) continue
      while (el.parentNode && el.parentNode !== dom.body && !isHost(el.parentNode)) el = el.parentNode
      found.add(el)
    }
    return [...found]
  }

  const describe = list => list.length
    ? list.map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)).join(' || ')
    : '(ни одного узла живого вида в DOM)'

  const bodyText = () => String(dom.body.textContent || '').replace(/\s+/g, ' ').trim()
  const bodyHtml = () => String(dom.body.innerHTML || '')

  return {
    dom, api, realApi, deps, calls, roots, describe, bodyText, bodyHtml,
    host, panel: dom.byId.get('tasksPanel'),
    requireReal (what) {
      if (broken) throw new Error(`${NO_CONTRACT}: ${broken} — ${what} проводилась бы впустую`)
    },
    allNodes: () => dom.descendants(dom.body),
    buttons () {
      return this.allNodes().filter(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')
    },
    stopButton () {
      const named = el => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''}`
      return this.buttons().filter(el => /останов|стоп|stop|прерв/i.test(named(el)))
    },
    frames () { return this.allNodes().filter(el => el.tagName === 'IFRAME') }
  }
}

const sourceText = () => {
  if (moduleLoadError) throw new Error(`${NO_CONTRACT}: исходник ${rel(VIEW_SOURCE)} не читается — ${msg(moduleLoadError)}`)
  return fs.readFileSync(VIEW_SOURCE, 'utf8')
}

// --- проверки --------------------------------------------------------------------

async function main () {
  await check('модуль agent-browser-view существует и отдаёт create(deps) с четырьмя методами', async () => {
    assert.ok(!moduleLoadError, `${NO_CONTRACT}: ${rel(VIEW_SOURCE)} не подключается (${msg(moduleLoadError)})`)
    assert.equal(typeof view.create, 'function', 'в модуле нет create(deps)')
    const scene = makeScene()
    for (const name of API_METHODS) {
      assert.equal(typeof scene.api[name], 'function', `у результата create() нет метода ${name}, обещанного контрактом`)
    }
    assert.equal(Object.isFrozen(scene.realApi), true,
      'результат create() не заморожен: живой вид правили бы из app.js, а не из модуля (образец: design-task-card.js)')
  })

  await check('живой вид показывает адрес, заголовок и имена элементов кадра', async () => {
    const scene = makeScene()
    scene.requireReal('проверка кадра')
    scene.api.renderFrame(frameEvent())
    const text = scene.bodyText()
    assert.ok(text.includes('example.com'), `в живом виде нет адреса страницы: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.ok(text.includes('МИШЕНА-ЗАГОЛОВОК'), `в живом виде нет заголовка кадра: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.ok(text.includes('МИШЕНА-ЭЛЕМЕНТ-ССЫЛКА'), `в живом виде нет имён элементов кадра: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.match(text, /\d+[^]{0,20}(элемент|кнопк|пол[её]|распознан|найдено)|((элемент|кнопк|пол[её]|распознан|найдено)[^]{0,20}\d+)/i,
      `живой вид не говорит, сколько распознаваемых элементов в кадре: «${text.slice(0, 200)}»`)
  })

  await check('карточка строится только из разрешённых полей события: лишние ключи в DOM не рисуются', async () => {
    const scene = makeScene()
    scene.requireReal('проверка лишних полей события')
    scene.api.renderFrame(frameEvent())
    const painted = STRAY_MARKERS.filter(marker => scene.bodyHtml().includes(marker) || scene.bodyText().includes(marker))
    assert.deepEqual(painted, [],
      `в событии канала есть поля, которых в контракте нет, и они нарисовались в окне: ${painted.join(', ')} — живому виду ` +
      'положено брать только url, title, elements[].{index,tag,role,name,type,href} и ссылку на кадр')
  })

  await check('url, title и имена элементов попадают в DOM экранированными', async () => {
    const scene = makeScene()
    scene.requireReal('проверка экранирования')
    scene.api.renderFrame(frameEvent())
    const nodes = scene.allNodes()
    const imgs = nodes.filter(el => el.tagName === 'IMG')
    assert.equal(imgs.length, 0, `имя элемента прорисовалось узлом img (${imgs.length} шт.) — текст модели идёт в DOM экранированным`)
    const scripts = nodes.filter(el => el.tagName === 'SCRIPT')
    assert.equal(scripts.length, 0, `заголовок или имя элемента прорисовалось узлом script (${scripts.length} шт.)`)
    const evilAnchors = nodes.filter(el => el.tagName === 'A' && /^javascript:/i.test(String(el.getAttribute('href') || '')))
    assert.deepEqual(evilAnchors.map(el => el.textContent), [],
      'из href элемента собрана кликабельная ссылка с javascript: — разметку из полей модели строить нельзя')
    const text = scene.bodyText()
    assert.ok(text.includes('onerror=alert(1)'), `вредоносное имя элемента не видно текстом: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.ok(text.includes('МИШЕНА-ПОЛЕ'), `имя с амперсандом и тегами пропало из вида: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.equal(/<img src=x onerror/i.test(scene.bodyHtml()), false,
      'в разметке окна появился неэкранированный <img src=x onerror=…>')
    assert.equal(/<i>страницы<\/i>/.test(scene.bodyHtml()), false,
      'заголовок кадра попал в DOM разметкой, а не текстом')
  })

  await check('кадр изолирован: iframe с sandbox="allow-scripts" и без allow-same-origin', async () => {
    const scene = makeScene()
    scene.requireReal('проверка изоляции кадра')
    scene.api.renderFrame(frameEvent())
    const frames = scene.frames()
    assert.equal(frames.length, 1, `живой кадр нарисован ${frames.length} iframe вместо одного: ${scene.describe(scene.roots('МИШЕНА'))}`)
    const sandbox = String(frames[0].getAttribute('sandbox') || '')
    assert.equal(sandbox, 'allow-scripts',
      `sandbox кадра обязан быть буквально «allow-scripts», а он «${sandbox}»: с allow-same-origin страница агента попала бы в Origin окна`)
    const src = String(frames[0].getAttribute('src') || '')
    assert.ok(src.length > 0, 'у кадра нет адреса: живой вид показывал бы пустой кадр')
    assert.equal(/undefined|null/.test(src), false, `адрес кадра собран из пустоты: «${src}»`)
    assert.equal(frames[0]._listeners.some(item => item.type === 'message'), false, 'модуль подписал message на сам кадр')
  })

  await check('кнопка «Остановить» есть, доступна с клавиатуры, подписана data-tooltip и зовёт stop один раз на клик', async () => {
    const scene = makeScene()
    scene.requireReal('проверка кнопки остановки')
    scene.api.renderFrame(frameEvent())
    const found = scene.stopButton()
    assert.equal(found.length, 1, `предложение «Остановить» найдено в количестве ${found.length}: ${scene.describe(scene.roots('МИШЕНА'))}`)
    const button = found[0]
    assert.equal(button.tagName, 'BUTTON', `«Остановить» нарисована узлом ${button.tagName}, а не кнопкой — с клавиатуры в неё не попасть`)
    assert.equal(button.getAttribute('type'), 'button', 'у кнопки нет type="button": Enter в соседнем поле нажмёт её')
    assert.notEqual(button.getAttribute('tabindex'), '-1', 'кнопка снята с клавиатурной навигации (tabindex="-1")')
    assert.notEqual(button.hidden, true, 'кнопка «Остановить» скрыта — останавливать нечем?')
    assert.ok((button.textContent || '').trim().length > 2 || (button.getAttribute('aria-label') || '').trim().length > 2,
      'у кнопки нет доступного имени: скринридер прочитает пустую кнопку')
    assert.ok((button.getAttribute('data-tooltip') || '').trim().length > 2,
      'у кнопки нет data-tooltip — в этом проекте подсказки носятся только так (tests/test-tooltips.cjs)')
    assert.equal(button.getAttribute('title'), null, `у кнопки стоит нативный title («${button.getAttribute('title')}») — нельзя`)
    assert.equal(button._listeners.filter(item => item.type === 'click').length, 1,
      `на кнопке висит ${button._listeners.filter(item => item.type === 'click').length} обработчиков клика — stop вызвался бы дважды`)
    button.click()
    assert.equal(scene.calls.stop.length, 1, `клик вызвал stop ${scene.calls.stop.length} раз вместо одного`)
  })

  await check('после остановки повторные события состояния не меняют', async () => {
    const scene = makeScene()
    scene.requireReal('проверка остановки')
    scene.api.renderFrame(frameEvent())
    assert.ok(scene.stopButton().length, 'кнопки «Остановить» нет уже в первом кадре — проверке нечего нажимать')
    scene.api.setStopped()
    assert.match(scene.bodyText(), /останов|стоп|прекращ|прерван/i,
      `после setStopped() в живом виде не видно, что работа остановлена: ${scene.describe(scene.roots('МИШЕНА'))}`)
    scene.api.renderFrame(frameEvent({ title: 'МИШЕНА-ПОСЛЕ-ОСТАНОВКИ', url: 'https://example.com/после' }))
    assert.equal(scene.bodyText().includes('МИШЕНА-ПОСЛЕ-ОСТАНОВКИ'), false,
      'после остановки новый кадр перерисовал вид: состояние сменилось обратно на «работает»')
    assert.match(scene.bodyText(), /останов|стоп|прекращ|прерван/i,
      `состояние «остановлено» пропало после нового события: ${scene.describe(scene.roots('МИШЕНА'))}`)
  })

  await check('пустой кадр не рисует белый экран: видно название состояния', async () => {
    const scene = makeScene()
    scene.requireReal('проверка пустого кадра')
    const empty = frameEvent({ url: '', title: '', elements: [] })
    for (const key of FRAME_URL_KEYS) empty[key] = ''
    scene.api.renderFrame(empty)
    const text = scene.bodyText()
    assert.ok(text.length > 0, `пустой кадр нарисовал белый экран: в DOM нет ни слова (${scene.describe(scene.roots('МИШЕНА'))})`)
    assert.match(text, /пуст|ожид|жд[её]м|откры|ещ[её] нет|не начат|кадр|загруж|работ|нет данных/i,
      `пустой кадр не назван состоянием: «${text.slice(0, 200)}»`)
    assert.equal(scene.frames().length, 0,
      `на пустом кадре в окне всё равно висит iframe (${String(scene.frames()[0] && scene.frames()[0].getAttribute('src'))})`)
  })

  await check('ошибочный кадр не рисует белый экран: видно состояние и причину', async () => {
    const scene = makeScene()
    scene.requireReal('проверка отказа')
    const reason = 'Страница ушла на локальный адрес 127.0.0.1 — действие отклонено'
    scene.api.renderFrame(frameEvent())
    scene.api.setError(reason)
    const text = scene.bodyText()
    assert.match(text, /ошибк|отказ|не вышло|не удал|не собрал|прерван|останов|стоп|нельзя|запрещ|сорв/i,
      `отказ не назван отказом ни одним понятным словом: «${text.slice(0, 200)}»`)
    assert.ok(text.includes('127.0.0.1'), `причина отказа не показана текстом события: «${text.slice(0, 200)}»`)
    assert.equal(scene.frames().length, 0,
      `на отказе кадр остался в окне (${String(scene.frames()[0] && scene.frames()[0].getAttribute('src'))}) — показывать нечего`)
    const positive = text.replace(/не\s+\w+/g, '')
    assert.equal(/готов|успешн|получено/i.test(positive), false, `отказанное состояние названо успешным: «${text.slice(0, 200)}»`)

    const second = makeScene()
    second.requireReal('проверка отказа второй формы')
    second.api.setError({ error: 'Окно браузера закрылось' })
    assert.ok(second.bodyText().includes('Окно браузера закрылось'),
      `setError({ error }) не показал причину: ${second.describe(second.roots('МИШЕНА'))}`)
  })

  await check('dispose() убирает узлы и слушатели, повторный вызов не падает и больше не рисует', async () => {
    const scene = makeScene()
    scene.requireReal('проверка dispose')
    scene.api.renderFrame(frameEvent())
    assert.ok(scene.bodyText().includes('МИШЕНА-ЭЛЕМЕНТ-ССЫЛКА'), 'харнесс не видит узлов живого вида до dispose')
    scene.api.dispose()
    const leftNodes = scene.allNodes().filter(el => /МИШЕНА-ЭЛЕМЕНТ-ССЫЛКА|МИШЕНА-ЗАГОЛОВОК/.test(String(el.textContent || '')))
    assert.deepEqual(leftNodes.map(el => el.tagName.toLowerCase()), [],
      `после dispose() в DOM остались узлы живого вида: ${leftNodes.map(el => el.tagName.toLowerCase()).join(', ')}`)
    const subs = scene.dom.subs()
    assert.deepEqual(subs.map(sub => `${sub.target}:${sub.type}`), [],
      `после dispose() осталось ${subs.length} подписок на документ/окно: ${subs.map(sub => `${sub.target}:${sub.type}`).join(', ')}`)
    scene.api.dispose()

    const again = makeScene()
    again.requireReal('проверка dispose на свежей сцене')
    again.api.dispose()
    again.api.renderFrame(frameEvent())
    assert.equal(again.allNodes().filter(el => /МИШЕНА-ЭЛЕМЕНТ-ССЫЛКА/.test(String(el.textContent || ''))).length, 0,
      'после dispose() модуль всё равно рисует кадры — узлы копятся на каждое переподключение окна')
  })

  await check('всё через deps: ни слушателя message, ни прямого electronAPI, ни нативных title', async () => {
    const scene = makeScene()
    scene.requireReal('проверка deps')
    scene.api.renderFrame(frameEvent())
    scene.api.setError('проверка deps')
    scene.api.setStopped()
    const messageSubs = scene.dom.subs().filter(sub => sub.type === 'message')
    assert.deepEqual(messageSubs.map(sub => sub.target), [],
      'модуль подписался на message окна — читать содержимое кадра он не имеет права (кадр без allow-same-origin затем и закрыт)')
    const onMessage = scene.allNodes().filter(el => (el._listeners || []).some(item => item.type === 'message') || el.onmessage !== undefined)
    assert.deepEqual(onMessage.map(el => el.tagName.toLowerCase()), [], 'модуль вешает message/onmessage на узлы — это чтение из кадра')
    const source = sourceText()
    const offenders = []
    source.split('\n').forEach((line, index) => {
      const plain = line.trim()
      if (/window\.electronAPI|globalThis\.electronAPI|root\.electronAPI/.test(plain)) offenders.push(`${index + 1}: ${plain}`)
      if (/addEventListener\s*\(\s*['"]message['"]/.test(plain)) offenders.push(`${index + 1}: ${plain}`)
      if (/(?:^|\s)title\s*=\s*["'`]/.test(plain) && !/function\s+\w+\([^)]*title\s*=/.test(plain)) offenders.push(`${index + 1}: ${plain}`)
      if (/\.title\s*=\s*["'`]/.test(plain)) offenders.push(`${index + 1}: ${plain}`)
      if (/setAttribute\s*\(\s*['"]title['"]/.test(plain)) offenders.push(`${index + 1}: ${plain}`)
    })
    assert.deepEqual(offenders, [], 'модуль берёт канал из глобального окна, слушает message или использует нативные подсказки:\n  ' + offenders.join('\n  '))
    assert.ok(scene.calls.bridge.length >= 1,
      'create(deps) не подписался на deps.electronAPI.onAgentBrowserEvent — в окне события не дойдут')
  })

  await check('событие канала доходит до вида: и напрямую, и через onAgentBrowserEvent из deps', async () => {
    const scene = makeScene()
    scene.requireReal('проверка подписки на канал')
    assert.ok(scene.calls.bridge.length >= 1,
      `create(deps) не подписался на deps.electronAPI.onAgentBrowserEvent (подписок: ${scene.calls.bridge.length}) — живой вид из канала не увидят`)
    scene.api.renderFrame(frameEvent({ title: 'МИШЕНА-НАПРЯМУЮ', url: 'https://example.com/напрямую' }))
    assert.ok(scene.bodyText().includes('МИШЕНА-НАПРЯМУЮ'),
      `прямой renderFrame() не рисует кадр: ${scene.describe(scene.roots('МИШЕНА'))}`)

    const second = makeScene()
    second.requireReal('проверка канала')
    const push = second.calls.bridge[0]
    assert.equal(typeof push, 'function', `onAgentBrowserEvent получила не колбэк, а ${typeof push}`)
    push(frameEvent({ title: 'МИШЕНА-ЧЕРЕЗ-КАНАЛ', url: 'https://example.com/канал' }))
    assert.ok(second.bodyText().includes('МИШЕНА-ЧЕРЕЗ-КАНАЛ'),
      `событие, пришедшее по каналу, не нарисовалось: ${second.describe(second.roots('МИШЕНА'))}`)
  })

  await check('живой вид подключён в index.html своим тегом до app.js', async () => {
    const index = fs.readFileSync(INDEX_SOURCE, 'utf8')
    const viewTag = index.indexOf('agent-browser-view.js')
    assert.ok(viewTag >= 0, 'в index.html нет тега <script src="agent-browser-view.js"> — модуль в окне не загрузится')
    const appTag = index.indexOf('<script src="app.js"')
    assert.ok(appTag >= 0, 'харнесс не нашёл в index.html подключения app.js — порядок проверять не от чего')
    assert.ok(viewTag < appTag, `тег agent-browser-view.js идёт после app.js (${viewTag} > ${appTag}): окно создаст вид позже, чем нужно`)
    assert.ok(/<script[^>]*agent-browser-view\.js[^>]*>\s*<\/script>/.test(index),
      'подключение тега выглядит иначе, чем у соседних модулей (образец: design-task-card.js) — сверь форму')
  })

  await check('preload отдаёт onAgentBrowserEvent с функцией отписки', async () => {
    const preload = fs.readFileSync(PRELOAD_SOURCE, 'utf8')
    const at = preload.indexOf('onAgentBrowserEvent')
    assert.ok(at >= 0, 'в preload.js нет onAgentBrowserEvent — окну не слушать живой вид')
    const block = preload.slice(at, at + 400)
    assert.ok(/callback\s*=>/.test(block), `onAgentBrowserEvent принимает не колбэк: ${block.slice(0, 120)}`)
    assert.ok(/ipcRenderer\.on\(\s*'agent-browser-event'/.test(block), `onAgentBrowserEvent слушает не тот канал: ${block.slice(0, 160)}`)
    assert.ok(/return\s*\(\s*\)\s*=>[\s\S]{0,140}removeListener\(\s*'agent-browser-event'/.test(block),
      `onAgentBrowserEvent не возвращает функцию отписки (тот же порядок, что у onDesignTaskEvent): ${block.slice(0, 220)}`)
  })

  // Кадр отдаётся не из сети, а из памяти хода по своей схеме
  // (`agent-browser-shot://…`, см. serveAgentShot в main.js). Оконный прогон
  // это и проверяет; здесь — чтобы фильтр не остался http(s)--only и чтобы
  // «разрешили свою схему» не превратилось в «разрешили что угодно».
  await check('кадр по схеме живого вида проходит; data:, file: и javascript: — нет', async () => {
    const SHOT_URL = 'agent-browser-shot://0e9a3b1c-0000-4000-8000-112233445566/0'
    const withShot = over => Object.fromEntries(FRAME_URL_KEYS.map(key => [key, over]))
    const shotScene = makeScene()
    shotScene.requireReal('проверка схемы кадра')
    shotScene.api.renderFrame(frameEvent(withShot(SHOT_URL)))
    const shotFrames = shotScene.frames()
    assert.equal(shotFrames.length, 1, `кадр по agent-browser-shot:// не нарисован (iframe: ${shotFrames.length}): ${shotScene.describe(shotScene.roots('МИШЕНА'))}`)
    assert.equal(String(shotFrames[0].getAttribute('src')), SHOT_URL,
      `адрес кадра изменён: «${shotFrames[0].getAttribute('src')}» вместо «${SHOT_URL}»`)

    for (const banned of [
      'data:image/svg+xml,<svg onload=alert(1)>',
      'file:///C:/Users/victim/Desktop/secret.png',
      'javascript:alert(1)'
    ]) {
      const scene = makeScene()
      scene.requireReal('проверка запрета ' + banned.slice(0, 12))
      scene.api.renderFrame(frameEvent(withShot(banned)))
      const srcs = scene.frames().map(frame => String(frame.getAttribute('src') || ''))
      assert.equal(srcs.some(src => src.startsWith(banned.slice(0, banned.indexOf(':') + 1))), false,
        `в кадр пустили «${banned}» — схема кадра обязана оставаться собственной, http(s) и agent-browser-shot`)
    }
  })

  await check('политика содержимого index.html пускает схему кадра в frame-src', async () => {
    const index = fs.readFileSync(INDEX_SOURCE, 'utf8')
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(index)
    assert.ok(csp, 'в index.html нет политики содержимого — проверять нечего')
    const directive = name => (new RegExp(`${name} ([^;]+)`).exec(csp[1]) || [])[1] || ''
    assert.match(directive('frame-src'), /agent-browser-shot:/,
      'кадр живого вида не загрузится: frame-src не знает схемы agent-browser-shot:')
    assert.ok(!/'unsafe-eval'/.test(csp[1]), 'политика не должна ослабевать до unsafe-eval')
    assert.ok(!/\*/.test(directive('frame-src')), `frame-src расширен подстановочным знаком: «${directive('frame-src')}»`)
  })

  // Панель «Работа» (`work-panel.js`) перестраивает своё содержимое целиком:
  // `panel.innerHTML = …` уносит всё, что прикрепили снаружи. Живой вид обязан
  // вернуть свою карточку — иначе она исчезает ровно тогда, когда ход кончился
  // и на кадр смотрят.
  await check('панель перестроилась — живой вид возвращает карточку на место', async () => {
    const scene = makeScene()
    scene.requireReal('проверка перемонтирования карточки')
    scene.api.renderFrame(frameEvent())
    const card = scene.allNodes().find(el => String(el.className || '').split(/\s+/).includes('agent-browser-view'))
    assert.ok(card, `карточки живого вида нет уже в первом кадре: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.equal(scene.dom.nodeContains(scene.dom.body, card), true, 'карточка первого кадра не в дереве документа')
    const place = card.parentElement
    assert.ok(place, 'карточка висит без узла-хозяина — перемонтировать не во что')

    // 1. Хозяин жив, но очистил себя: так делает перестройка панели.
    place.replaceChildren()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(scene.dom.nodeContains(place, card), true,
      'после перестройки панели карточка живого вида осталась вырванной: вид исчезает на глазах')
    assert.match(scene.bodyText(), /МИШЕНА-ЗАГОЛОВОК/,
      'карточка вернулась пустой: живой вид потерял показанный кадр')

    // 2. Хозяина убрали из документа совсем, потом вернули: панель «Работа»
    //    пересоздаётся, когда её прячут и снова открывают.
    place.remove()
    await new Promise(resolve => setImmediate(resolve))
    scene.dom.body.appendChild(place)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(scene.dom.nodeContains(scene.dom.body, card), true,
      'после возвращения панели карточка живого вида так и не вернулась в документ')
  })

  // Кнопка «Остановить»: вид обязан ПЕРЕКЛЮЧИТЬСЯ в состояние, а не только
  // позвонить в окно. Проверка ищет слово «остановлено» — подпись кнопки
  // («Остановить») ему не подмога: она после остановки обязана исчезнуть.
  await check('кнопка «Остановить» переводит вид в состояние «остановлено»', async () => {
    const scene = makeScene()
    scene.requireReal('проверка состояния по кнопке остановки')
    scene.api.renderFrame(frameEvent())
    const found = scene.stopButton()
    assert.equal(found.length, 1, `кнопки «Остановить» в первом кадре нет: ${scene.describe(scene.roots('МИШЕНА'))}`)
    found[0].click()
    assert.equal(scene.calls.stop.length, 1, `клик по «Остановить» позвонил в окно ${scene.calls.stop.length} раз`)
    assert.match(scene.bodyText(), /остановлен/i,
      `после нажатия вид не показал состояние «остановлено»: ${scene.describe(scene.roots('МИШЕНА'))}`)
    assert.equal(scene.stopButton().length, 0,
      'кнопка «Остановить» осталась на экране: её можно нажать второй раз')
  })

  // Живой вид обязан вести НА ЭКРАН каждую свою подпись через `deps.t`:
  // и статус, и «адрес:», и счётчик элементов, и размер кадра. Иначе в
  // английском окне остаётся русская строка, которую словарь не увидит.
  await check('каждая подпись живого вида идёт через deps.t', async () => {
    const keys = []
    const scene = makeScene({
      deps: {
        t: (key, ...args) => {
          keys.push(String(key))
          let index = 0
          return String(key).replace(/%s/g, () => (index < args.length ? String(args[index++]) : '%s'))
        }
      }
    })
    scene.requireReal('проверка переводимых подписей')
    scene.api.renderFrame(frameEvent())
    for (const label of ['Браузер агента', 'адрес:', 'элементов в кадре:', 'пикселов', 'байт']) {
      assert.ok(keys.some(key => key.includes(label)),
        `подпись «${label}» вставлена в окно мимо deps.t (через t() прошли: ${keys.join(' | ') || '(ничего)'})`)
    }
    const text = scene.bodyText()
    assert.match(text, /1280x800/, `размер кадра пропал из вида: ${text.slice(0, 220)}`)
    assert.match(text, /24576/, `число байт пропало из вида: ${text.slice(0, 220)}`)
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed) console.log(`КРАСНЫХ проверок: ${failed} — продуктового кода 3.6б ещё нет, так и задумано`)
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.message) || error))
  process.exit(1)
})
