// ---------------------------------------------------------------------------
// Свободные блоки результата в Ultra.
// Набор проверяет поведение: если `src/renderer/ultra-blocks.js` или
// `ultra-blocks.css` ещё нет, мягкая загрузка модуля и `scene.requireReal(...)`
// дают отказ одной строкой, а не роняют весь набор.
//
// Отступ колонок разговора под прилипший блок — отдельная группа проверок; она
// красная до реализации, прежние проверки не изменены и не ослаблены.
//
// Что требуется от блока результата (`.upanel`/`.umin`/`.rh` и
// `drawUltra`-соседи): блок лежит в окне свободно, его можно перетащить за
// заголовок, растянуть за ЛЮБОЙ край или угол, он прилипает к зоне с подсветкой
// границы, сворачивается в пилюлю и убирается совсем — с возможностью вернуть.
//
// ─── Публичный API, который этот набор замораживает ───────────────────────────
//
// Модуль: `src/renderer/ultra-blocks.js`, IIFE с `module.exports`/`root`, как
// `ultra-shell.js` и `composer-menu.js`. Стили — `src/renderer/ultra-blocks.css`,
// подключение — своим тегом в `src/renderer/index.html` до `app.js`.
//
//   create(deps) → Object.freeze({ mount, render, state, dispose, insets })
//     mount(host)   — навешивает слой `.ublocks` в узел окна (идемпотентно)
//     render(items) — items: [{ id, title, kind, versions }]; новые создаёт,
//                     прежние сохраняет С ИХ позициями, исчезнувшие стирает
//     state()       — { blocks: [{ id, x, y, w, h, min, closed }], zone }
//     dispose()     — снимает слушатели и узлы
//     insets()      — { left, right } в пикселях (см. ниже; в модуле её пока
//                     НЕТ — проверки на неё красные по замыслу)
//
//   deps: { document, window, t, open(item), onChange() }
//
// ─── Отступ колонок под прилипший блок ────────────────────────────────────────
//
// Прилипший к правому (или левому) краю окна блок садится поверх колонки
// разговора и строки ввода — человек теряет возможность печатать. Верное
// поведение: колонки САМИ отступают на ширину прилипшего блока, а узлы колонок
// модуль и оболочка не трогают.
//
// Точка сбора, которую набор требует от публичного API модуля:
//
//   insets() → { left: <число>, right: <число> }   — пиксели ЧИСЛОМ, без «px»
//     0                  — к этой стороне ничего не прилипло: блок свободен
//                          (не у края), свёрнут в пилюлю или убран
//     ширина + INSET_PAD — к этой стороне прилип блок; при нескольких блоках на
//                          одной стороне — по САМОМУ ШИРОКОМУ, без сложения
//
// `INSET_PAD = 16` — зазор между блоком и колонкой: «ширина прилипшего блока + 16».
// Дальше по цепочке (её меряет оконный зонд, не этот файл): оболочка
// `ultra-shell.js` переносит эти два числа на КОРЕНЬ переменными
// `--ultra-block-inset-right` / `--ultra-block-inset-left`, а стиль под
// `:root[data-version-preset="ultra"]` даёт `.feed-container` и `.composer-col`
// `padding-inline` из них, с переходом только по `padding`. Сам модуль чужих
// узлов не трогает: никакой расстановки строк от реализатора не требуется,
// требуется ровно эти два числа и отсутствие чужих inline-стилей.
//
// Узлы, которые набор ищет (имена — из макета, переводится только текст):
//   .ublocks            слой-приёмник
//   .ublock             блок; `data-block-id`; координаты — инлайном в px
//   .ublock-head        ручка перетаскивания (`data-drag="block"`)
//   .ublock-title       название результата
//   .ublock-meta        чем он является и сколько весит (через t())
//   .ublock-open        открыть (зовёт deps.open ровно один раз)
//   .ublock-min         свернуть в пилюлю
//   .ublock-close       убрать
//   .ublock-grip[data-edge=n|s|e|w|ne|nw|se|sw] — восемь ручек размера
//   .ublock-pill        пилюля свёрнутого блока (клик — развернуть)
//   .ublock-restore     возврат убранного блока («Результат»)
//   .ublock-snap        призрак зоны прилипания
//
// Геометрия: сетка 8 px, минимум 280×200, за пределами слоя блок не живёт,
// зоны — левый край, правый край, низ и «во весь экран» (строки 1155–1157
// макета). Движение: перетаскивание меняет координаты, а не свойства
// раскладки, и не анимируется.
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const MODULE_FILE = process.env.ONECODE_ULTRA_BLOCKS || 'src/renderer/ultra-blocks.js'
const MODULE_PATH = path.isAbsolute(MODULE_FILE) ? MODULE_FILE : path.join(ROOT, MODULE_FILE)
const CSS_FILE = process.env.ONECODE_ULTRA_BLOCKS_CSS || 'src/renderer/ultra-blocks.css'
const CSS_PATH = path.isAbsolute(CSS_FILE) ? CSS_FILE : path.join(ROOT, CSS_FILE)
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer')
const I18N_PATH = path.join(RENDERER_DIR, 'i18n.js')

const API_METHODS = ['mount', 'render', 'state', 'dispose']
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const GRID = 8
const MIN_W = 280
const MIN_H = 200
const VIEW = { left: 0, top: 0, width: 1280, height: 760 }
// Полоса Ultra: выше неё блок не забирается — там возврат к Сессиям и настройки.
const TOP_MIN = 56
// Зазор между прилипшим блоком и колонкой разговора: «ширина прилипшего блока + 16».
const INSET_PAD = 16
// Имена переменных, которые оболочка обязана публиковать на корне, и классы
// колонок, которые обязаны их читать.
const INSET_VARS = ['--ultra-block-inset-left', '--ultra-block-inset-right']
const INSET_COLUMNS = ['.feed-container', '.composer-col']

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + ((error && error.message) || error))
  }
}

const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
const rel = file => path.relative(ROOT, file).split(path.sep).join('/')
const oneLine = error => norm((error && error.message) || String(error))
const px = value => Number(String(value == null ? '' : value).replace(/[^0-9.\-]/g, '')) || 0

// ─── мягкая загрузка модуля ───────────────────────────────────────────────────
function softRequire (file) {
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `файл «${rel(file)}» ещё не написан (свободные блоки результата в Ultra)` }
  }
  try {
    delete require.cache[require.resolve(file)]
    return { ok: true, module: require(file) }
  } catch (error) {
    return { ok: false, reason: `«${rel(file)}» не подключается: ${oneLine(error)}` }
  }
}

function contractStub (reason) {
  const api = {}
  for (const name of API_METHODS) api[name] = () => { throw new Error(`НЕТ КОНТРАКТА: ${reason}`) }
  return api
}

// ─── словарь: английская пара каждой русской строки ────────────────────────────
function loadDict () {
  const box = { window: {} }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(I18N_PATH, 'utf8'), box)
  return (box.window.__I18N__ && box.window.__I18N__.en) || {}
}
let DICT = {}
try {
  DICT = loadDict()
} catch (error) {
  DICT = {}
}

// ─── самодельный DOM: только то, что нужно геометрии ──────────────────────────
// Координаты блоков набор читает из инлайновых стилей (их видит браузер), а
// указатель — из `clientX/clientY` события: настоящие координаты экрана харнесс
// изображает фиксированным окном 1280×760.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon'])

function makeDom () {
  const makeText = text => ({ nodeType: 3, textContent: String(text), parentNode: null })
  let document = null
  let win = null

  const detach = node => {
    const parent = node.parentNode
    if (!parent) return
    const at = parent._nodes.indexOf(node)
    if (at >= 0) parent._nodes.splice(at, 1)
    node.parentNode = null
    node.parentElement = null
  }
  const adopt = (parent, node) => { detach(node); node.parentNode = parent; if (parent.nodeType === 1) node.parentElement = parent; parent._nodes.push(node); return node }
  const clear = node => { for (const child of node._nodes.slice()) detach(child) }
  const textOf = node => node._nodes.map(child => (child.nodeType === 3 ? child.textContent : textOf(child))).join('')

  function makeStyle (el) {
    const map = new Map()
    const base = {
      _map: map,
      getPropertyValue: key => (map.has(String(key).toLowerCase()) ? map.get(String(key).toLowerCase()) : ''),
      setProperty: (key, value) => { map.set(String(key).toLowerCase(), String(value)) },
      removeProperty: key => { map.delete(String(key).toLowerCase()) }
    }
    return new Proxy(base, {
      get (target, key) {
        if (typeof key === 'symbol' || key in target) return target[key]
        const name = String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())
        return map.has(name) ? map.get(name) : ''
      },
      set (target, key, value) {
        if (key in target) { target[key] = value; return true }
        map.set(String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value))
        return true
      }
    })
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
    if (compound === '*') return el.nodeType === 1
    if (!/^[#.[\w*]/.test(compound)) return false
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

  const descendants = root => {
    const out = []
    const walk = node => { for (const child of node._nodes) if (child.nodeType === 1) { out.push(child); walk(child) } }
    walk(root)
    return out
  }
  const nodeContains = (parent, node) => { let current = node; while (current) { if (current === parent) return true; current = current.parentNode } return false }

  function queryAll (root, selector) {
    const out = []
    for (const group of String(selector).split(',')) {
      const chain = group.trim().split(/\s+/).filter(Boolean)
      if (!chain.length) continue
      const last = chain[chain.length - 1]
      for (const el of descendants(root)) {
        if (!matchCompound(el, last)) continue
        let current = el.parentElement
        let index = chain.length - 2
        let ok = true
        while (index >= 0) {
          if (!current) { ok = false; break }
          if (matchCompound(current, chain[index])) { current = current.parentElement; index--; continue }
          current = current.parentElement
        }
        if (ok && !out.includes(el)) out.push(el)
      }
    }
    return out
  }

  function fire (el, type, extra) {
    const path = []
    let current = el
    while (current) { if (current.nodeType === 1) path.push(current); current = current.parentElement }
    if (document) path.push(document)
    if (win) path.push(win)
    const event = Object.assign({
      type, target: el, currentTarget: el, button: 0, clientX: 0, clientY: 0, pointerId: 1,
      preventDefault () { event._defaultPrevented = true },
      stopPropagation () { event._stopped = true },
      setPointerCapture () {}, releasePointerCapture () {}
    }, extra || {})
    for (const node of path) {
      event.currentTarget = node
      for (const listener of (node._listeners || []).filter(item => item.type === type)) listener.fn(event)
      const handler = node['on' + type]
      if (typeof handler === 'function') handler(event)
      if (event._stopped) break
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
      hidden: false,
      value: '',
      addEventListener (type, fn) { el._listeners.push({ type, fn }) },
      removeEventListener (type, fn) {
        const at = el._listeners.findIndex(item => item.type === type && item.fn === fn)
        if (at >= 0) el._listeners.splice(at, 1)
      },
      appendChild (node) { return adopt(el, node) },
      append (...nodes) { for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      replaceChildren (...nodes) { clear(el); for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      remove () { detach(el) },
      getAttribute (name) {
        const key = String(name).toLowerCase()
        if (el._attrs.has(key)) return el._attrs.get(key)
        return null
      },
      setAttribute (name, value) { el._attrs.set(String(name).toLowerCase(), String(value)) },
      hasAttribute (name) { return el._attrs.has(String(name).toLowerCase()) },
      removeAttribute (name) { el._attrs.delete(String(name).toLowerCase()) },
      querySelector (selector) { return queryAll(el, selector)[0] || null },
      querySelectorAll (selector) { return queryAll(el, selector) },
      matches (selector) { return String(selector).split(',').some(part => matchCompound(el, part.trim())) },
      closest (selector) {
        let current = el
        while (current) { if (current.nodeType === 1 && matchCompound(current, selector)) return current; current = current.parentElement }
        return null
      },
      contains (node) { return nodeContains(el, node) },
      setPointerCapture () {},
      releasePointerCapture () {},
      getBoundingClientRect () { return el === host ? { ...VIEW } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } }
    }
    el.style = makeStyle(el)
    Object.defineProperties(el, {
      children: { get () { return el._nodes.filter(node => node.nodeType === 1) } },
      firstElementChild: { get () { return el._nodes.find(node => node.nodeType === 1) || null } },
      textContent: {
        get () { return textOf(el) },
        set (value) { clear(el); if (value !== '' && value != null) adopt(el, makeText(String(value))) }
      },
      className: { get () { return el.getAttribute('class') || '' }, set (value) { el.setAttribute('class', String(value)) } },
      classList: { get () { return classList(el) } }
    })
    return el
  }

  const html = createElement('HTML')
  const body = createElement('BODY')
  adopt(html, body)
  const subs = []
  document = {
    nodeType: 9,
    documentElement: html,
    body,
    createElement,
    createElementNS: (_ns, tag) => createElement(tag),
    createTextNode: makeText,
    addEventListener (type, fn) { subs.push({ type, fn }) },
    removeEventListener (type, fn) {
      const at = subs.findIndex(item => item.type === type && item.fn === fn)
      if (at >= 0) subs.splice(at, 1)
    },
    _listeners: subs,
    querySelector: selector => queryAll(body, selector)[0] || null,
    querySelectorAll: selector => queryAll(body, selector),
    getElementById: id => descendants(html).find(el => el.getAttribute('id') === id) || null
  }

  const host = createElement('DIV')
  host.setAttribute('id', 'ultraBlocksHost')
  adopt(body, host)

  win = {
    _listeners: [],
    innerWidth: VIEW.width,
    innerHeight: VIEW.height,
    devicePixelRatio: 1,
    addEventListener (type, fn) { win._listeners.push({ type, fn }) },
    removeEventListener (type, fn) {
      const at = win._listeners.findIndex(item => item.type === type && item.fn === fn)
      if (at >= 0) win._listeners.splice(at, 1)
    },
    matchMedia: query => ({ matches: false, media: String(query), addEventListener () {}, removeEventListener () {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  }

  return { html, body, document, win, host, createElement, fire, descendants, queryAll }
}

// ─── сцена ────────────────────────────────────────────────────────────────────
const ITEMS = [
  { id: 'a-one', title: 'Лендинг для студии йоги', kind: 'page', versions: 3 },
  { id: 'b-two', title: 'Тарифы', kind: 'table', versions: 1 }
]

function makeScene (opts = {}) {
  const dom = makeDom()
  const lang = opts.lang || 'ru'
  const opens = []
  const changes = []
  const keys = []
  const t = (text, ...args) => {
    const raw = norm(text)
    keys.push(raw)
    const template = lang === 'en' && DICT[raw] ? DICT[raw] : raw
    let at = 0
    return String(template).replace(/%s/g, () => (at < args.length ? String(args[at++]) : '%s'))
  }
  const deps = Object.assign({
    document: dom.document,
    window: dom.win,
    t,
    host: dom.host,
    open: item => opens.push(item && item.id),
    onChange: () => changes.push(1)
  }, opts.deps || {})

  const loaded = opts.forceBroken ? { ok: false, reason: opts.forceBroken } : softRequire(MODULE_PATH)
  let broken = loaded.ok ? null : loaded.reason
  if (!broken && typeof (loaded.module || {}).create !== 'function') {
    broken = `в модуле «${rel(MODULE_PATH)}» нет create(deps): наружу отдаётся ${typeof (loaded.module || {}).create}`
  }
  let api = null
  if (!broken) {
    const names = ['document', 'window']
    const saved = names.map(name => [name, globalThis[name]])
    try {
      globalThis.document = dom.document
      globalThis.window = dom.win
      api = loaded.module.create(deps) || {}
    } catch (error) {
      broken = `create(deps) бросила: ${oneLine(error)}`
    } finally {
      for (const [name, value] of saved) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value }
    }
  }
  if (!broken) {
    const absent = API_METHODS.filter(name => typeof api[name] !== 'function')
    if (absent.length) broken = `у результата create() нет ${absent.join(', ')}; есть только: ${Object.keys(api).join(', ') || '(ничего)'}`
  }
  if (broken) api = contractStub(broken)

  const scene = {
    dom, deps, api, broken, keys, opens, changes, lang, opts,
    requireReal (what) {
      if (broken) throw new Error(`НЕТ КОНТРАКТА: ${broken} — ${what} проводилась бы впустую`)
    },
    layer: () => dom.queryAll(dom.body, '.ublocks')[0] || null,
    blocks: () => dom.queryAll(dom.body, '.ublock'),
    pills: () => dom.queryAll(dom.body, '.ublock-pill'),
    restore: () => dom.queryAll(dom.body, '.ublock-restore')[0] || null,
    ghost: () => dom.queryAll(dom.body, '.ublock-snap')[0] || null,
    blockOf: id => scene.blocks().find(el => el.getAttribute('data-block-id') === id) || null,
    boxOf (el) {
      if (!el) return null
      return { x: px(el.style.left), y: px(el.style.top), w: px(el.style.width), h: px(el.style.height) }
    },
    // Полный путь указателя: нажать, дотащить, отпустить — как это делает окно.
    drag (el, from, to) {
      dom.fire(el, 'pointerdown', { clientX: from[0], clientY: from[1] })
      dom.fire(el, 'pointermove', { clientX: to[0], clientY: to[1] })
      dom.fire(el, 'pointerup', { clientX: to[0], clientY: to[1] })
    },
    state: () => {
      try { return scene.api.state() || {} } catch (error) { return { error: oneLine(error) } }
    },
    start (items) {
      scene.api.mount(dom.host)
      scene.api.render(items || ITEMS)
    }
  }
  return scene
}

// ─── стили: что набор читает текстом ───────────────────────────────────────────
function stripComments (text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
const readIfExists = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

function blocksCss () {
  const text = readIfExists(CSS_PATH)
  assert.notEqual(text, null,
    `файл стилей «${rel(CSS_PATH)}» ещё не написан (свободные блоки результата)`)
  return stripComments(text)
}

function splitDeclarations (body) {
  const out = []
  let current = ''
  let depth = 0
  for (const ch of String(body)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { out.push(current); current = ''; continue }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out.map(one => one.trim()).filter(Boolean)
}

function parseRules (css) {
  const rules = []
  const walk = (text, inside) => {
    let i = 0
    let buffer = ''
    while (i < text.length) {
      const ch = text[i]
      if (ch === '{') {
        const selector = buffer.trim()
        buffer = ''
        let depth = 1
        let j = i + 1
        while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++ }
        const body = text.slice(i + 1, j - 1)
        if (/^@(media|supports|layer|container)/i.test(selector)) walk(body, `${inside} ${selector}`.trim())
        else if (!/^@/.test(selector)) {
          const decls = new Map()
          for (const part of splitDeclarations(body)) {
            const at = part.indexOf(':')
            if (at < 1) continue
            decls.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim())
          }
          for (const one of selector.split(',')) if (one.trim()) rules.push({ selector: one.trim(), decls, media: inside })
        }
        i = j
        continue
      }
      if (ch === '}') { i++; buffer = ''; continue }
      buffer += ch
      i++
    }
  }
  walk(css, '')
  return rules
}

const classesOf = el => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)

// ─── зелёные опоры ────────────────────────────────────────────────────────────
check('зелёная опора: отсутствующий модуль описан внятной строкой, а не стеком', () => {
  const probe = path.join(os.tmpdir(), `onlyone-no-such-blocks-${process.pid}.cjs`)
  try { fs.rmSync(probe, { force: true }) } catch { /* файла и нет */ }
  const loaded = softRequire(probe)
  assert.equal(loaded.ok, false, 'несуществующий файл не мог подключиться — а подключился')
  assert.match(loaded.reason, /onlyone-no-such-blocks/, `отказ не называет файл: ${loaded.reason}`)
  assert.match(loaded.reason, /ещё не написан/, `отказ не говорит, что файла нет: ${loaded.reason}`)
  assert.equal(loaded.reason.includes('\n'), false, `одна строка, а не стек: ${loaded.reason}`)
  const scene = makeScene({ forceBroken: loaded.reason })
  assert.throws(() => scene.requireReal('проверка'), /ещё не написан/, 'каждая проверка обязана повторять причину отказа')
})

check('зелёная опора: модуль отдаёт контракт mount, render, state, dispose', () => {
  const scene = makeScene()
  scene.requireReal('контракт модуля')
  for (const name of API_METHODS) assert.equal(typeof scene.api[name], 'function', `нет метода ${name}()`)
  scene.start()
  assert.ok(scene.layer(), 'после mount() в окне нет слоя .ublocks')
})

// ─── красные по поведению ──────────────────────────────────────────────────────
check('render: один блок на результат, с названием, родом и весом через t()', () => {
  const scene = makeScene()
  scene.requireReal('ряд блоков')
  scene.start()
  const blocks = scene.blocks()
  assert.equal(blocks.length, ITEMS.length, `блоков ${blocks.length}, а результатов ${ITEMS.length}`)
  for (const item of ITEMS) {
    const block = scene.blockOf(item.id)
    assert.ok(block, `блока результата «${item.title}» нет`)
    assert.ok(norm(block.querySelector('.ublock-title')?.textContent).includes(item.title),
      `в блоке «${item.id}» нет названия результата: «${norm(block.querySelector('.ublock-title')?.textContent)}»`)
    const meta = norm(block.querySelector('.ublock-meta')?.textContent)
    assert.ok(meta.length, `в блоке «${item.id}» нет строки о том, чем он является и сколько весит`)
    assert.equal(/%s/.test(meta), false, `подстановка не заполнена: «${meta}»`)
  }
  assert.ok(scene.keys.length, 'ни одной строки блок не перевёл через deps.t')
})

check('блоки не наезжают друг на друга и переживают перечитывание списка', () => {
  const scene = makeScene()
  scene.requireReal('позиции блоков')
  scene.start()
  const first = scene.boxOf(scene.blockOf(ITEMS[0].id))
  const second = scene.boxOf(scene.blockOf(ITEMS[1].id))
  for (const [name, box] of [['первый', first], ['второй', second]]) {
    assert.ok(box.w >= MIN_W && box.h >= MIN_H, `у ${name} блока размер ${box.w}×${box.h} меньше минимума ${MIN_W}×${MIN_H}`)
    assert.ok(box.x >= 0 && box.y >= 0, `${name} блок стоит за левым/верхним краем: ${box.x},${box.y}`)
  }
  const overlap = first.x < second.x + second.w && second.x < first.x + first.w &&
    first.y < second.y + second.h && second.y < first.y + first.h
  assert.equal(overlap, false, `новые блоки легли друг на друга: ${JSON.stringify(first)} и ${JSON.stringify(second)}`)
  scene.api.render(ITEMS)
  assert.deepEqual(scene.boxOf(scene.blockOf(ITEMS[0].id)), first,
    'перерисовывание того же списка сбросило позицию блока: человек теряет расстановку на каждом событии')
})

check('исчезнувший результат уносит свой блок, а не пустой каркас', () => {
  const scene = makeScene()
  scene.requireReal('устаревшие блоки')
  scene.start()
  assert.equal(scene.blocks().length, ITEMS.length, 'сначала блоков было столько, сколько результатов')
  scene.api.render(ITEMS.slice(0, 1))
  assert.equal(scene.blocks().length, 1, `результатов стал один, а блоков ${scene.blocks().length}`)
  assert.equal(scene.blockOf(ITEMS[1].id), null, 'блок исчезнувшего результата остался на экране')
})

check('за заголовок блок перетаскивается и не выходит за пределы окна', () => {
  const scene = makeScene()
  scene.requireReal('перетаскивание')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  const head = block.querySelector('.ublock-head')
  assert.ok(head, 'у блока нет заголовка — его не за что взять')
  assert.equal(head.getAttribute('data-drag'), 'block', 'заголовок не объявлен ручкой перетаскивания (data-drag="block")')
  const before = scene.boxOf(block)
  const grab = { x: before.x + 40, y: before.y + 12 }
  scene.drag(head, [grab.x, grab.y], [grab.x + 160, grab.y + 88])
  const moved = scene.boxOf(block)
  assert.equal(moved.x, before.x + 160, `блок не доехал за указателем: ${before.x} → ${moved.x}`)
  assert.equal(moved.y, before.y + 88, `и по вертикали тоже: ${before.y} → ${moved.y}`)
  assert.equal(moved.w, before.w, 'перетаскивание изменило ширину блока — этого быть не должно')
  assert.equal(moved.h, before.h, 'перетаскивание изменило высоту блока — этого быть не должно')
  // Дальний бросок к правому краю — это уже прилипание (следующая проверка), а не
  // свободная позиция: за пределы окна блок уйти не обязан, но обязан сесть в
  // зону. Здесь смотрим только на то, что он остался в пределах.
  scene.drag(head, [grab.x + 160, grab.y + 88], [grab.x + 9000, grab.y + 9000])
  const clamped = scene.boxOf(block)
  assert.ok(clamped.x + clamped.w <= VIEW.width, `блок выехал за правый край: ${clamped.x} + ${clamped.w} > ${VIEW.width}`)
  assert.ok(clamped.y + clamped.h <= VIEW.height, `и за нижний: ${clamped.y} + ${clamped.h} > ${VIEW.height}`)
  scene.drag(head, [clamped.x + 40, clamped.y + 12], [clamped.x - 9000, clamped.y - 9000])
  const back = scene.boxOf(block)
  assert.ok(back.x >= 0 && back.y >= TOP_MIN, `улетел за левый/верхний край: ${back.x},${back.y}`)
})

check('координаты ложатся на сетку 8 px', () => {
  const scene = makeScene()
  scene.requireReal('сетка')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  const head = block.querySelector('.ublock-head')
  const before = scene.boxOf(block)
  scene.drag(head, [before.x + 40, before.y + 12], [before.x + 40 + 37, before.y + 12 + 21])
  const box = scene.boxOf(block)
  assert.equal(box.x % GRID, 0, `x после перетаскивания не на сетке: ${box.x}`)
  assert.equal(box.y % GRID, 0, `y после перетаскивания не на сетке: ${box.y}`)
})

check('каждый из восьми краёв и углов тянет блок в свою сторону', () => {
  const scene = makeScene()
  scene.requireReal('ручки размера')
  scene.start()
  const wants = {
    e: box => ({ w: box.w + 80 }),
    w: box => ({ x: box.x - 80, w: box.w + 80 }),
    s: box => ({ h: box.h + 60 }),
    n: box => ({ y: box.y - 64, h: box.h + 64 }),
    se: box => ({ w: box.w + 80, h: box.h + 60 }),
    sw: box => ({ x: box.x - 80, w: box.w + 80, h: box.h + 60 }),
    ne: box => ({ w: box.w + 80, y: box.y - 64, h: box.h + 64 }),
    nw: box => ({ x: box.x - 80, y: box.y - 64, w: box.w + 80, h: box.h + 64 })
  }
  // Смещения кратны сетке 8 px: иначе проверка спорила бы с округлением, а не
  // с тем, тянет ли ручка свою сторону.
  const STEP = { x: 80, y: 64 }
  for (const edge of EDGES) {
    const one = makeScene()
    one.requireReal(`ручка ${edge}`)
    one.start()
    const block = one.blockOf(ITEMS[0].id)
    const grip = (block.querySelectorAll('.ublock-grip') || []).find(el => el.getAttribute('data-edge') === edge)
    assert.ok(grip, `у блока нет ручки за край «${edge}»: растягивание возможно только за один угол`)
    const before = one.boxOf(block)
    const at = { x: before.x + before.w / 2, y: before.y + before.h / 2 }
    const dy = edge.includes('n') ? -STEP.y : edge.includes('s') ? 60 : 0
    one.dom.fire(grip, 'pointerdown', { clientX: at.x, clientY: at.y })
    one.dom.fire(grip, 'pointermove', { clientX: at.x + (edge.includes('w') ? -STEP.x : STEP.x), clientY: at.y + dy })
    one.dom.fire(grip, 'pointerup', { clientX: at.x, clientY: at.y })
    const after = one.boxOf(block)
    const want = wants[edge](before)
    for (const key of Object.keys(want)) {
      assert.equal(after[key], want[key], `ручка «${edge}»: ${key} стал ${after[key]}, ждали ${want[key]} (было ${before[key]})`)
    }
  }
})

check('размер не уменьшается ниже минимума и не выезжает за окно', () => {
  const scene = makeScene()
  scene.requireReal('минимальный размер')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  const grips = block.querySelectorAll('.ublock-grip') || []
  for (const edge of ['e', 's', 'se']) {
    const grip = grips.find(el => el.getAttribute('data-edge') === edge)
    assert.ok(grip, `нет ручки «${edge}»`)
    const before = scene.boxOf(block)
    const at = { x: before.x + before.w - 4, y: before.y + before.h - 4 }
    scene.dom.fire(grip, 'pointerdown', { clientX: at.x, clientY: at.y })
    scene.dom.fire(grip, 'pointermove', { clientX: at.x - 4000, clientY: at.y - 4000 })
    scene.dom.fire(grip, 'pointerup', { clientX: at.x, clientY: at.y })
    const box = scene.boxOf(block)
    assert.ok(box.w >= MIN_W && box.h >= MIN_H, `ручка «${edge}» сжала блок до ${box.w}×${box.h} (минимум ${MIN_W}×${MIN_H})`)
  }
  const before = scene.boxOf(block)
  const grip = (block.querySelectorAll('.ublock-grip') || []).find(el => el.getAttribute('data-edge') === 'se')
  const at = { x: before.x + before.w - 4, y: before.y + before.h - 4 }
  scene.dom.fire(grip, 'pointerdown', { clientX: at.x, clientY: at.y })
  scene.dom.fire(grip, 'pointermove', { clientX: at.x + 9000, clientY: at.y + 9000 })
  scene.dom.fire(grip, 'pointerup', { clientX: at.x, clientY: at.y })
  const big = scene.boxOf(block)
  assert.ok(big.x + big.w <= VIEW.width && big.y + big.h <= VIEW.height,
    `блок вырос за окно: ${big.x}+${big.w} × ${big.y}+${big.h} против ${VIEW.width} × ${VIEW.height}`)
})

check('у края окна блок прилипает к зоне: сначала призрак, потом геометрия', () => {
  const scene = makeScene()
  scene.requireReal('прилипание')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  const head = block.querySelector('.ublock-head')
  const before = scene.boxOf(block)
  const grab = { x: before.x + 40, y: before.y + 12 }
  scene.dom.fire(head, 'pointerdown', { clientX: grab.x, clientY: grab.y })
  scene.dom.fire(head, 'pointermove', { clientX: VIEW.width - 12, clientY: VIEW.height / 2 })
  const ghost = scene.ghost()
  assert.ok(ghost, 'у правого края окна не появился призрак зоны — блок не показывает, куда сядет')
  const zone = scene.state().zone
  assert.equal(zone, 'right', `зона «${zone || 'нет'}» вместо правой`)
  scene.dom.fire(head, 'pointerup', { clientX: VIEW.width - 12, clientY: VIEW.height / 2 })
  const box = scene.boxOf(block)
  assert.ok(box.x + box.w > VIEW.width * 0.6, `правая зона не применена: блок ${box.x}+${box.w} из ${VIEW.width}`)
  assert.ok(box.y >= 0 && box.y + box.h <= VIEW.height, `правая зона вылезла за окно: ${box.y}+${box.h}`)
  assert.equal(scene.ghost(), null, 'призрак зоны остался после отпускания')
})

check('свёрнутый блок становится пилюлей и разворачивается на своё место', () => {
  const scene = makeScene()
  scene.requireReal('сворачивание')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  const before = scene.boxOf(block)
  const button = block.querySelector('.ublock-min')
  assert.ok(button, 'у блока нет кнопки свернуть')
  domClick(scene, button)
  assert.equal(scene.blockOf(ITEMS[0].id), null, `блок не свернулся: он всё ещё на экране (${scene.blocks().length} блоков)`)
  const pill = scene.pills().find(el => norm(el.textContent).includes(ITEMS[0].title))
  assert.ok(pill, `пилюли свернутого результата нет (пилюль: ${scene.pills().length})`)
  domClick(scene, pill)
  const back = scene.blockOf(ITEMS[0].id)
  assert.ok(back, 'после клика по пилюле блок не вернулся')
  assert.deepEqual(scene.boxOf(back), before, `блок вернулся на другое место: ${JSON.stringify(scene.boxOf(back))} против ${JSON.stringify(before)}`)
  assert.equal(scene.pills().length, 0, 'пилюля осталась на экране рядом с развернутым блоком')
})

check('убранный блок возвращается кнопкой «Результат»', () => {
  const scene = makeScene()
  scene.requireReal('уборка и возврат')
  scene.start()
  const had = scene.blocks().length
  for (const block of scene.blocks().slice()) {
    const close = block.querySelector('.ublock-close')
    assert.ok(close, 'у блока нет кнопки убрать')
    domClick(scene, close)
  }
  assert.equal(scene.blocks().length, 0, `все блоки убраны, а на экране их ${scene.blocks().length}`)
  const restore = scene.restore()
  assert.ok(restore, 'после уборки нечего нажимать, чтобы вернуть результат')
  assert.ok(norm(restore.textContent).length, 'кнопка возврата без подписи')
  domClick(scene, restore)
  assert.equal(scene.blocks().length, had, `после возврата блоков ${scene.blocks().length}, было ${had}`)
})

check('кнопка «Открыть» зовёт окно ровно один раз и именно этим результатом', () => {
  const scene = makeScene()
  scene.requireReal('открытие результата')
  scene.start()
  const block = scene.blockOf(ITEMS[1].id)
  const open = block.querySelector('.ublock-open')
  assert.ok(open, 'у блока нет кнопки открыть')
  domClick(scene, open)
  assert.deepEqual(scene.opens, [ITEMS[1].id], `deps.open получил [${scene.opens.join(', ')}] вместо одного «${ITEMS[1].id}»`)
})

check('dispose снимает узлы и слушатели окна', () => {
  const scene = makeScene()
  scene.requireReal('снятие')
  const idle = scene.dom.document._listeners.length + scene.dom.win._listeners.length
  scene.start()
  const live = scene.dom.document._listeners.length + scene.dom.win._listeners.length
  assert.ok(live > idle, 'модуль не слушает ни документ, ни окно: тащить блок за пределы кнопки невозможно')
  scene.api.dispose()
  assert.equal(scene.layer(), null, 'после dispose() слой блоков остался в окне')
  const left = scene.dom.document._listeners.length + scene.dom.win._listeners.length
  assert.equal(left, idle, `после dispose() слушателей ${left}, а было до монтирования ${idle}: подписка переживает оболочку`)
})

check('каждая видимая строка блока прошла через deps.t; на английском кириллицы нет', () => {
  const ru = makeScene({ lang: 'ru' })
  ru.requireReal('подписи блока')
  ru.start()
  const texts = visibleTexts(ru)
  assert.ok(texts.length, 'в блоках не найдено ни одной видимой строки')
  const en = makeScene({ lang: 'en' })
  en.requireReal('английские подписи блока')
  en.start()
  // Название результата — данные окна, их переводит не блок: сравнение с
  // чужими строками здесь было бы проверкой того, что человек сам написал.
  const data = ITEMS.map(item => item.title)
  const isData = text => data.some(title => text === title || text.includes(title))
  const stray = [...new Set(visibleTexts(en).filter(text => /[а-яё]/.test(text) && !isData(text)))]
  assert.deepEqual(stray, [], `на английском в блоках остались русские строки: ${stray.join(' | ')}`)
})

check('у каждого ключа deps.t есть английская пара в src/renderer/i18n.js', () => {
  const scene = makeScene({ lang: 'ru' })
  scene.requireReal('ключи перевода')
  scene.start()
  const missing = [...new Set(scene.keys)].filter(key => !DICT[key])
  assert.deepEqual(missing, [], `для этих строк нет английской пары в i18n.js: ${missing.join(' | ')}`)
})

check('каждый класс, который ставит модуль, описан в ultra-blocks.css', () => {
  const css = blocksCss()
  const rules = parseRules(css)
  const declared = new Set()
  for (const rule of rules) {
    for (const m of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) declared.add(m[1])
  }
  const scene = makeScene()
  scene.requireReal('классы модуля')
  scene.start()
  const used = new Set()
  for (const el of scene.dom.descendants(scene.dom.body)) for (const name of classesOf(el)) used.add(name)
  const absent = [...used].filter(name => !declared.has(name))
  assert.deepEqual(absent, [], `классов нет в стилях: ${absent.join(', ')} — узел встанет без вида`)
})

check('в стилях блоков нет transition: all, а движение не трогает раскладку', () => {
  const css = blocksCss()
  assert.equal(/transition:\s*all\b/i.test(css), false, 'transition: all запрещён: пересчёт раскладки на каждом движении')
  const LAYOUT = ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin', 'padding', 'inset', 'transform']
  const moved = []
  for (const rule of parseRules(css)) {
    for (const [prop, value] of rule.decls) {
      if (prop === 'transition') {
        if (/\ball\b/.test(value)) { moved.push(`${rule.selector}: transition: ${value}`); continue }
        for (const part of value.replace(/cubic-bezier\([^)]*\)/g, 'ease').split(',')) {
          const name = part.trim().split(/\s+/)[0]
          if (LAYOUT.includes(name)) moved.push(`${rule.selector}: transition → ${name}`)
        }
      }
      if (prop === 'animation' && !/none/.test(value)) {
        for (const token of value.split(/[\s,]+/)) {
          const m = new RegExp(`@keyframes\\s+${token}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(css)
          if (!m) continue
          for (const key of LAYOUT) if (new RegExp(`(^|[\\s;{])${key}\\s*:`, 'm').test(m[1])) moved.push(`${rule.selector}: @keyframes ${token} двигает ${key}`)
        }
      }
    }
  }
  assert.deepEqual([...new Set(moved)], [], `блоки двигают раскладку стилем: ${[...new Set(moved)].join('; ')}`)
})

check('фокус в блоках описан через :focus-visible', () => {
  const css = blocksCss()
  const scene = makeScene()
  scene.requireReal('фокус в блоках')
  scene.start()
  const interactive = scene.dom.descendants(scene.dom.body).filter(el => ['BUTTON', 'A', 'TEXTAREA', 'INPUT'].includes(el.tagName) || el.getAttribute('role') === 'button')
  assert.ok(interactive.length, 'в блоках нет ни одной кнопки — проверять фокус не на чём')
  const declared = parseRules(css)
  const uncovered = []
  for (const el of interactive) {
    const own = classesOf(el)
    const covered = declared.some(rule => /:focus-visible/.test(rule.selector) && own.some(name => new RegExp(`\\.${name.replace(/-/g, '\\-')}\\b`).test(rule.selector)))
    if (!covered) uncovered.push(own.join('.') || el.tagName.toLowerCase())
  }
  assert.deepEqual([...new Set(uncovered)], [], `без :focus-visible остались ${[...new Set(uncovered)].join(', ')}`)
})

check('подсказки только через data-tooltip; кнопка-значок подписана для чтения с экрана', () => {
  const scene = makeScene()
  scene.requireReal('подсказки блока')
  scene.start()
  const nodes = scene.dom.descendants(scene.dom.body)
  const native = nodes.filter(el => el.hasAttribute('title'))
  assert.deepEqual(native.map(el => el.tagName), [], `нативный title запрещён (${native.length} узлов): в этом окне подсказка идёт через data-tooltip`)
  for (const block of scene.blocks()) {
    for (const name of ['.ublock-min', '.ublock-close', '.ublock-open']) {
      const button = block.querySelector(name)
      assert.ok(button, `в блоке нет ${name}`)
      assert.ok(norm(button.getAttribute('aria-label')), `${name} не подписан для чтения с экрана`)
      assert.ok(norm(button.getAttribute('data-tooltip')), `${name} остался без подсказки`)
    }
  }
})

check('блок результата не перекрывает управление: кнопки живут в самом блоке', () => {
  const scene = makeScene()
  scene.requireReal('кнопки блока')
  scene.start()
  const block = scene.blockOf(ITEMS[0].id)
  assert.ok(block.querySelector('.ublock-head'), 'у блока нет заголовка — по макету он и ручка, и панель управления')
  const grips = block.querySelectorAll('.ublock-grip') || []
  assert.equal(grips.length, EDGES.length, `ручек размера ${grips.length}, а по макету восемь (любой край и угол)`)
  for (const edge of EDGES) assert.ok(grips.some(el => el.getAttribute('data-edge') === edge), `нет ручки «${edge}»`)
})

// ─── Отступы колонок под прилипший блок (красные: insets() в модуле нет) ──────
check('Н95: модуль отдаёт insets() — два числа пикселей, и у свободных блоков оба нулевые', () => {
  const scene = makeScene()
  scene.requireReal('Н95: insets()')
  scene.start()
  const at = readInsets(scene, 'свободные блоки')
  assert.deepEqual(at, { left: 0, right: 0 },
    `результаты ни к одному краю не прилипли, а отступ уже есть: ${JSON.stringify(at)}`)
  for (const block of scene.blocks()) {
    const box = scene.boxOf(block)
    assert.ok(farFromEdges(box),
      `сцена неверна: блок ${box.x}+${box.w} из ${VIEW.width} стоит у края — нулей ждать не с чего`)
  }
})

check('Н95: прилипший справа блок даёт правый отступ «ширина + 16», левый остаётся нулевым', () => {
  const scene = makeScene()
  scene.requireReal('Н95: правый отступ')
  scene.start()
  const id = ITEMS[0].id
  dockTo(scene, id, 'right')
  const box = scene.boxOf(scene.blockOf(id))
  assert.ok(box.x + box.w > VIEW.width * 0.6,
    `сцена неверна: блок не сел в правую зону (${box.x}+${box.w} из ${VIEW.width}) — мерить отступ нечего`)
  const at = readInsets(scene, 'прилипший справа')
  assert.equal(at.right, box.w + INSET_PAD,
    `правый отступ ${at.right}, а жали ${box.w} + ${INSET_PAD}: ширину прилипшего блока плюс зазор`)
  assert.equal(at.left, 0,
    `левый отступ ${at.left} при свободном левом крае — колонка ушла бы влево без причины`)
})

check('Н95: прилипший слева блок даёт левый отступ «ширина + 16», правый остаётся нулевым', () => {
  const scene = makeScene()
  scene.requireReal('Н95: левый отступ')
  scene.start()
  const id = ITEMS[0].id
  dockTo(scene, id, 'left')
  const box = scene.boxOf(scene.blockOf(id))
  assert.ok(box.x < VIEW.width * 0.4,
    `сцена неверна: блок не сел в левую зону (${box.x}+${box.w} из ${VIEW.width}) — мерить отступ нечего`)
  const at = readInsets(scene, 'прилипший слева')
  assert.equal(at.left, box.w + INSET_PAD,
    `левый отступ ${at.left}, а жали ${box.w} + ${INSET_PAD}: ширину прилипшего блока плюс зазор`)
  assert.equal(at.right, 0,
    `правый отступ ${at.right} при свободном правом крае — строка ввода съехала бы вправо без причины`)
})

check('Н95: свободный блок и блок, отклеенный от края, отступа не требуют', () => {
  const scene = makeScene()
  scene.requireReal('Н95: отклеивание')
  scene.start()
  const id = ITEMS[0].id
  assert.deepEqual(readInsets(scene, 'стартовые блоки'), { left: 0, right: 0 }, 'откуда-то взявшийся отступ до всякого прилипания')
  dockTo(scene, id, 'right')
  const docked = readInsets(scene, 'прилипший блок')
  assert.ok(docked.right > 0, `блок прилип справа, а отступа нет: ${JSON.stringify(docked)}`)
  const block = scene.blockOf(id)
  const at = scene.boxOf(block)
  // Уводим блок с края тем же перетаскиванием: 464+632 = 1096 из 1280 px — до
  // обоих краев больше ста, ни о какой зоне речи не идёт.
  scene.drag(block.querySelector('.ublock-head'), [at.x + 40, at.y + 12], [500, 400])
  const free = scene.boxOf(scene.blockOf(id))
  assert.ok(farFromEdges(free),
    `сцена неверна: блок после отклеивания всё ещё у края (${free.x}+${free.w} из ${VIEW.width})`)
  assert.deepEqual(readInsets(scene, 'отклеенный блок'), { left: 0, right: 0 },
    'блок уехал с края, а колонка до сих пор отступает в пустоту')
})

check('Н95: пилюля и убранный блок отступ отпускают, возврат ставит его обратно', () => {
  const scene = makeScene()
  scene.requireReal('Н95: пилюля, уборка, возврат')
  scene.start()
  const id = ITEMS[0].id
  dockTo(scene, id, 'right')
  const width = scene.boxOf(scene.blockOf(id)).w
  const want = width + INSET_PAD
  assert.equal(readInsets(scene, 'прилипший блок').right, want, 'отступ до сворачивания — база всех дальнейших сравнений')
  domClick(scene, scene.blockOf(id).querySelector('.ublock-min'))
  assert.equal(readInsets(scene, 'свёрнутый в пилюлю').right, 0,
    'пилюля не занимает край от верха до низа — правый отступ она держать не обязана')
  const pill = scene.pills().find(el => norm(el.textContent).includes(ITEMS[0].title))
  assert.ok(pill, 'пилюли нет — возвращать проверять нечем')
  domClick(scene, pill)
  assert.equal(readInsets(scene, 'возврат из пилюли').right, want,
    `блок вернулся на край, а отступ нет: жали ${want}, вышло ${readInsets(scene, 'возврат из пилюли').right}`)
  domClick(scene, scene.blockOf(id).querySelector('.ublock-close'))
  assert.equal(readInsets(scene, 'убранный блок').right, 0,
    'убранный блок держит отступ — колонка осталась бы сдвинутой в пустоту')
  const restore = scene.restore()
  assert.ok(restore, 'кнопки возврата нет — дальше проверять не на чём')
  domClick(scene, restore)
  assert.equal(readInsets(scene, 'возврат убранного блока').right, want,
    `блок вернулся на правый край, а отступ остался нулём: жали ${want}`)
})

check('Н95: несколько прилипших справа — отступ по самому широкому, а не сумма', () => {
  const scene = makeScene()
  scene.requireReal('Н95: два блока на одном краю')
  scene.start()
  dockTo(scene, ITEMS[0].id, 'right')
  dockTo(scene, ITEMS[1].id, 'right')
  const widths = ITEMS.map(item => scene.boxOf(scene.blockOf(item.id)).w)
  const at = readInsets(scene, 'два прилипших справа')
  const want = Math.max(...widths) + INSET_PAD
  assert.equal(at.right, want,
    `справа прилипли блоки по ${widths.join(' и ')} px: жали ${want} (по самому широкому плюс зазор), а не сумму ${widths.reduce((sum, one) => sum + one, 0)} — колонка уехала бы за экран`)
  assert.equal(at.left, 0, `левый край свободен, а отступ ${at.left}`)
})

check('Н95: модуль меряет отступ числом, а не правит раскладку чужих узлов', () => {
  const scene = makeScene()
  scene.requireReal('Н95: чужие узлы')
  scene.start()
  dockTo(scene, ITEMS[0].id, 'right')
  readInsets(scene, 'прилипший блок')
  const TOUCHED_PROPS = ['padding', 'padding-inline', 'padding-inline-start', 'padding-inline-end',
    'padding-left', 'padding-right', 'margin', 'margin-left', 'margin-right', 'width', 'left', 'right']
  const touched = []
  for (const el of [scene.dom.html, ...scene.dom.descendants(scene.dom.body)]) {
    if (el.closest('.ublocks')) continue
    for (const prop of TOUCHED_PROPS) {
      const value = norm(el.style[prop])
      if (value) touched.push(`${el.tagName}.${classesOf(el).join('.') || '(без класса)'}: ${prop}: ${value}`)
    }
  }
  assert.deepEqual(touched, [],
    `модуль раздвигает чужие узлы инлайном: ${touched.join('; ')} — по решению Н95 отступ берут колонки через переменные, а блок их не трогает`)
})

check('Н95: колонки разговора берут padding из переменных оболочки под признаком пресета', () => {
  const files = ['src/renderer/index.css', 'src/renderer/ultra-shell.css']
  const rules = []
  for (const file of files) {
    const text = readIfExists(path.join(ROOT, file))
    assert.notEqual(text, null, `стилей «${file}» в дереве нет — проверять нечего`)
    for (const rule of parseRules(stripComments(text))) {
      rules.push({ file, selector: rule.selector, decls: rule.decls })
    }
  }
  const PADDING = ['padding', 'padding-inline', 'padding-inline-start', 'padding-inline-end', 'padding-left', 'padding-right']
  const problems = []
  for (const column of INSET_COLUMNS) {
    const re = new RegExp('\\.' + column.slice(1).replace(/-/g, '\\-') + '(?![-\\w])')
    const mine = rules.filter(one => re.test(one.selector))
    assert.ok(mine.length, `${column}: в стилях окна нет ни одного правила этой колонки — читать отступ некому`)
    const scoped = mine.filter(one => /\[data-version-preset\s*=\s*["']?ultra/.test(one.selector))
    assert.ok(scoped.length,
      `${column}: правило отступа нельзя давать вне признака — без :root[data-version-preset="ultra"] колонки сдвинулись бы и в обычном виде`)
    const values = []
    for (const one of scoped) {
      for (const [prop, value] of one.decls) {
        if (PADDING.includes(prop) && /--ultra-block-inset/.test(value)) values.push(`${prop}: ${value}`)
      }
    }
    const joined = values.join(' | ')
    for (const variable of INSET_VARS) {
      if (!joined.includes(variable)) {
        problems.push(`${column}: padding не читает ${variable} — в правилах пресета заявлено только «${joined || 'ни одного padding'}», а оболочка без этого объявления публикует переменную в пустоту`)
      }
    }
    for (const one of scoped) {
      for (const [prop, value] of one.decls) {
        if (prop !== 'transition') continue
        for (const part of value.replace(/cubic-bezier\([^)]*\)/g, 'ease').split(',')) {
          const name = part.trim().split(/\s+/)[0]
          if (!name || name === 'none') continue
          if (!PADDING.includes(name)) problems.push(`${column} (${one.file}): transition → ${name} — переход только по padding, «all» и любая раскладка запрещены`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

// ─── U-2: экран «Задач» живёт в свободном блоке тем же механизмом ────────────
//
// В Ultra «Задачи» открываются свободным блоком, а не экраном на пол-окна. Модуль блоков про задачи не знает НИЧЕГО: тело блока ему
// отдают извне (`deps.bodyFor`), а он вешает этот узел и не пересобирает его при
// каждом перечитывании списка. Иначе чужой экран терял бы фокус поля поиска,
// прокрутку и свои слушатели на каждом `render()`.
//
// Второе: место и размер блока помнятся между запусками. Модуль обязан отдать
// свою геометрию наружу (`geometry()`) и принять обратно (`restore(map)`) —
// сам он диск не трогает, как и весь слой Ultra.

const TASKS_ITEM = { id: 'tasks', title: 'Задачи', kind: 'tasks', w: 360, h: 480 }

// Сцена, где у предмета `tasks` тело отдаёт вызывающий, а у остальных предметов
// его нет (модуль обязан вернуться к обычному телу, а не рисовать пустоту).
function makeBodyScene (opts = {}) {
  let provided = null
  const calls = []
  const scene = makeScene({
    deps: {
      bodyFor: item => {
        calls.push(item && item.id)
        return item && item.id === 'tasks' ? provided : null
      }
    }
  })
  scene.bodyCalls = calls
  scene.give = node => { provided = node; return node }
  scene.begin = () => scene.start([{ id: 'a-one', title: 'Лендинг', kind: 'page', versions: 1 }, TASKS_ITEM])
  return scene
}

check('U-2: тело блока берётся у вызывающего и тот же узел переживает перечитывание списка', () => {
  const scene = makeBodyScene()
  scene.requireReal('U-2: чужое тело блока')
  const node = scene.give(scene.dom.document.createElement('div'))
  node.setAttribute('id', 'taskCenterView')
  const child = scene.dom.document.createElement('span')
  child.textContent = 'В работе: 2'
  node.appendChild(child)
  scene.begin()
  const block = scene.blockOf('tasks')
  assert.ok(block, 'блока «tasks» на экране нет')
  assert.equal(block.querySelector('#taskCenterView'), node,
    'в блоке не тот узел: тело блока должно быть тем же объектом, что отдал вызывающий')
  assert.equal(node.querySelector('span').textContent, 'В работе: 2',
    'содержимое чужого узла потеряно')
  assert.ok(!block.querySelector('.ublock-meta'),
    'рядом с чужим телом модуль нарисовал свою подпись — в блоке два тела')
  scene.api.render([{ id: 'a-one', title: 'Лендинг', kind: 'page', versions: 1 }, TASKS_ITEM])
  const again = scene.blockOf('tasks')
  assert.ok(again === block, 'body container must stay attached during render')
  assert.equal(again.querySelector('.ublock-title').textContent, TASKS_ITEM.title, 'refresh must replace the title, not append it')
  assert.equal(again && again.querySelector('#taskCenterView'), node,
    'после перечитывания списка в блоке другой узел: экран потерял бы фокус, прокрутку и слушателей')
  assert.ok(scene.bodyCalls.includes('tasks'), 'модуль ни разу не спросил тело у вызывающего')
})

check('U-2: у блока с чужим телом нет кнопки «Открыть» — экран на пол-окна не открывается', () => {
  const scene = makeBodyScene()
  scene.requireReal('U-2: нет кнопки «Открыть»')
  scene.give(scene.dom.document.createElement('div'))
  scene.begin()
  const block = scene.blockOf('tasks')
  assert.ok(block, 'блока «tasks» нет')
  assert.ok(!block.querySelector('.ublock-open'),
    'у блока «Задачи» есть кнопка «Открыть»: второй путь ведёт на экран на пол-окна, которого в Ultra быть не должно')
  domClick(scene, block.querySelector('.ublock-head'))
  assert.deepEqual(scene.opens, [],
    `нажатие на заголовок открыло результат: ${JSON.stringify(scene.opens)}`)
})

check('U-2: предмет сам задаёт размер по умолчанию (у «Задач» — 360×480)', () => {
  const scene = makeBodyScene()
  scene.requireReal('U-2: размер предмета')
  scene.give(scene.dom.document.createElement('div'))
  scene.begin()
  const box = scene.boxOf(scene.blockOf('tasks'))
  assert.ok(box, 'блока «tasks» нет')
  assert.equal(box.w, 360, `ширина блока ${box.w}, а жали 360 px по предмету`)
  assert.equal(box.h, 480, `высота блока ${box.h}, а жали 480 px по предмету`)
})

check('U-2: геометрия отдаётся наружу и принимается обратно (память между запусками)', () => {
  const first = makeBodyScene()
  first.requireReal('U-2: память геометрии')
  first.give(first.dom.document.createElement('div'))
  first.begin()
  const block = first.blockOf('a-one')
  const at = first.boxOf(block)
  first.drag(block.querySelector('.ublock-head'), [at.x + 40, at.y + 12], [at.x + 240, at.y + 160])
  const moved = first.boxOf(first.blockOf('a-one'))
  assert.ok(moved.x !== at.x || moved.y !== at.y,
    `сцена неверна: перетаскивание не сдвинуло блок (${JSON.stringify(at)} → ${JSON.stringify(moved)})`)
  const saved = typeof first.api.geometry === 'function' ? first.api.geometry() : null
  assert.ok(saved && typeof saved === 'object',
    `geometry() нет или вернула ${JSON.stringify(saved)} — без этого сохранять нечего`)
  const one = saved['a-one']
  assert.ok(one && Number(one.x) === moved.x && Number(one.y) === moved.y &&
    Number(one.w) === moved.w && Number(one.h) === moved.h,
    `geometry() отдала ${JSON.stringify(one)}, а блок на экране стоит в ${JSON.stringify(moved)}`)

  const second = makeBodyScene()
  second.requireReal('U-2: память геометрии')
  second.give(second.dom.document.createElement('div'))
  if (typeof second.api.restore !== 'function') {
    throw new Error('у модуля нет restore(map) — возвращать сохранённое нечем')
  }
  second.api.restore(saved)
  second.begin()
  const back = second.boxOf(second.blockOf('a-one'))
  assert.ok(back, 'после возврата блока нет')
  assert.deepEqual([back.x, back.y, back.w, back.h], [moved.x, moved.y, Number(moved.w), Number(moved.h)],
    `после загрузки сохранённого блок встал в ${JSON.stringify(back)}, а жали ${JSON.stringify(moved)}`)
})

check('U-2: убранный блок не разрушает чужой узел и возвращает его тем же', () => {
  const scene = makeBodyScene()
  scene.requireReal('U-2: узел вызывающего переживает закрытие')
  const node = scene.give(scene.dom.document.createElement('div'))
  node.setAttribute('id', 'taskCenterView')
  const child = scene.dom.document.createElement('span')
  child.textContent = 'Прерванные: 1'
  node.appendChild(child)
  scene.begin()
  domClick(scene, scene.blockOf('tasks').querySelector('.ublock-close'))
  assert.ok(!scene.blockOf('tasks'), 'блок не убрался')
  assert.equal(node.querySelector('span').textContent, 'Прерванные: 1',
    'закрытие блока стёрло содержимое чужого экрана')
  domClick(scene, scene.restore())
  assert.ok(scene.blockOf('tasks'), 'после «вернуть» блока нет')
  assert.equal(scene.blockOf('tasks').querySelector('#taskCenterView'), node,
    'возвращённый блок не принял прежний узел')
})

check('U-2: свободное перетаскивание и новый размер тоже сообщают об изменении', () => {
  // Без этого сигнала память места не заведётся: человек передвинул блок, а
  // окно об этом не узнало, потому что `onChange` стоял только на прилипании
  // к зоне.
  const scene = makeScene()
  scene.requireReal('U-2: сигнал после перетаскивания')
  scene.start()
  const block = scene.blockOf('a-one')
  const at = scene.boxOf(block)
  scene.drag(block.querySelector('.ublock-head'), [at.x + 40, at.y + 12], [at.x + 120, at.y + 96])
  const moved = scene.boxOf(scene.blockOf('a-one'))
  assert.ok(moved.x !== at.x || moved.y !== at.y,
    `сцена неверна: блок не сдвинулся (${JSON.stringify(at)} → ${JSON.stringify(moved)})`)
  const afterMove = scene.changes.length
  assert.ok(afterMove > 0, 'после свободного перетаскивания onChange не сработал — сохранять некому')
  const grip = scene.blockOf('a-one').querySelector('[data-edge="e"]')
  assert.ok(grip, 'у блока нет восточной ручки')
  scene.drag(grip, [moved.x + moved.w - 2, moved.y + moved.h / 2], [moved.x + moved.w + 64, moved.y + moved.h / 2])
  const grown = scene.boxOf(scene.blockOf('a-one'))
  assert.ok(grown.w > moved.w, `блок не растянулся: ${moved.w} → ${grown.w}`)
  assert.ok(scene.changes.length > afterMove, 'после изменения размера onChange не сработал')
})

check('U-2: свободный блок не остаётся поверх заданной окном области (deps.keepOut)', () => {
  // Строка ввода — то место, которое блок закрывать не вправе: человек должен
  // видеть и поле, и кнопку отправки, с каким бы местом блок ни отпустили.
  const keepOut = { left: 300, top: 600, right: 900, bottom: 660, width: 600, height: 60 }
  const scene = makeScene({ deps: { keepOut: () => keepOut } })
  scene.requireReal('U-2: блок не наезжает на строку ввода')
  scene.start()
  const block = scene.blockOf('a-one')
  const at = scene.boxOf(block)
  // Указатель ведём так, чтобы левый верхний край блока попал в полосу
  // запрещённой области (520, 620): середина окна, ни одна зона прилипания
  // здесь не участвует.
  scene.drag(block.querySelector('.ublock-head'), [at.x + 40, at.y + 12], [520 + 40, 620 + 12])
  const box = scene.boxOf(scene.blockOf('a-one'))
  const hits = !(box.x + box.w <= keepOut.left || box.x >= keepOut.right ||
    box.y + box.h <= keepOut.top || box.y >= keepOut.bottom)
  assert.ok(!hits,
    `блок отпущен поверх строки ввода: ${JSON.stringify(box)} против зоны ${JSON.stringify(keepOut)}`)
})

console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
if (failed) console.log(`КРАСНЫХ проверок: ${failed} — красные звенья это отступы колонок: у модуля нет insets(), а колонки не читают переменные отступа (так и задумано)`)
process.exit(failed ? 1 : 0)

// ─── помощники сцен ───────────────────────────────────────────────────────────
function domClick (scene, el) {
  if (!el) throw new Error('нужен узел для нажатия')
  scene.dom.fire(el, 'pointerdown', { clientX: 0, clientY: 0 })
  scene.dom.fire(el, 'pointerup', { clientX: 0, clientY: 0 })
  scene.dom.fire(el, 'click', { clientX: 0, clientY: 0 })
}

function visibleTexts (scene) {
  const out = []
  for (const el of scene.dom.descendants(scene.dom.body)) {
    for (const name of ['placeholder', 'aria-label', 'data-tooltip']) {
      const value = norm(el.getAttribute(name))
      if (value) out.push(value)
    }
    if (el.children.length === 0) {
      const value = norm(el.textContent)
      if (value) out.push(value)
    }
  }
  return out
}

// ─── помощники отступов ───────────────────────────────────────────────────────
// Публичная точка сбора отступов: `insets()` на объекте, который возвращает
// `create(deps)`. В модуле её пока нет — именно поэтому проверки отступов красные.
// Форма возврата и смысл чисел описаны в шапке файла; расстановку строк внутри
// набора не требует (кроме одного: чужие узлы инлайном не разъезжаются).
function readInsets (scene, what) {
  scene.requireReal(`Н95: insets() — ${what}`)
  if (typeof scene.api.insets !== 'function') {
    throw new Error(`у результата create() нет метода insets(): модуль не отдаёт измеренные отступы колонок (${what}). `
      + `Требуется { left, right } — пиксели числом, см. шапку файла; есть только: ${Object.keys(scene.api).join(', ') || '(ничего)'}`)
  }
  let raw = null
  try {
    raw = scene.api.insets()
  } catch (error) {
    throw new Error(`insets() бросила (${what}): ${oneLine(error)}`)
  }
  const box = raw || {}
  const out = {}
  for (const side of ['left', 'right']) {
    const value = Number(box[side])
    assert.ok(Number.isFinite(value),
      `insets().${side} = ${JSON.stringify(box[side])} — жали число пикселей, а не ${typeof box[side]} (${what})`)
    assert.ok(value >= 0, `insets().${side} = ${value} — отступ отрицательным быть не может (${what})`)
    out[side] = value
  }
  return out
}

// Прилипание к краю ровно тем путём, что и у человека: взять за заголовок,
// дотащить указатель до края, отпустить (зона срабатывает на отпускании).
function dockTo (scene, id, side) {
  const block = scene.blockOf(id)
  assert.ok(block, `блока результата «${id}» на экране нет`)
  const head = block.querySelector('.ublock-head')
  assert.ok(head, 'у блока нет заголовка — его не за что взять')
  const at = scene.boxOf(block)
  const x = side === 'right' ? VIEW.width - 12 : 12
  scene.drag(head, [at.x + 40, at.y + 12], [x, Math.round(VIEW.height / 2)])
}

// Годность сцены: блок стоит далеко от обоих боковых краёв — запас в сто шагов
// больше любой мыслимой полосы прилипания, поэтому проверка не спорит с тем,
// какой ширины её сделал реализатор.
function farFromEdges (box) {
  const SAFE = 100
  return box.x >= SAFE && VIEW.width - (box.x + box.w) >= SAFE
}
