// ---------------------------------------------------------------------------
// Пункт 9.2 — оболочка Ultra: КРАСНЫЙ узловой набор.
//
// Тест написан ДО продуктового кода: `src/renderer/ultra-shell.js` и
// `src/renderer/ultra-shell.css` в дереве нет. Набор обязан краснеть ПОВЕДЕНИЕМ,
// а не разваливаться: загрузка модуля мягкая, отсутствующий продукт описан
// одной внятной строкой, а все проверки по продукту идут через
// `scene.requireReal(...)`, который бросает «НЕТ КОНТРАКТА: …».
//
// Оболочка выбирается ЗНАЧЕНИЕМ версии, а не новым выключателем: 28.09 в
// конфигурацию интерфейса легло `versionPreset` = default | pro | ultra
// (b8f34e — красный тест, 8a1cba6 — реализация, набор tests/test-ui-config-preset.cjs).
// Отдельного признака Ultra в этом наборе нет и быть не должно.
//
// Правки приёмки 29.09 (1–4 к оболочке) добавили проверки, которых первый
// набор не умел видеть, — и харнесс под них расширен: `<canvas>` записывает
// вызовы рисования (чем и куда мажет живой фон), `getComputedStyle` отвечает
// токенами темы, «уменьшить движение» переключается сценой, `MutationObserver`
// поднимается вручную, а в сцене появилась настоящая шапка чата с её кнопками.
// Ровный фон на трёх кадрах был поэтому и не пойман: рисование-то шло, но слой
// уходил за непрозрачный фон предков — теперь проверяется и это.
//
// Как вешается признак режима (контракт просил требовать ТОГО же способа, а не
// нового). Факт из дерева: `src/renderer/app.js` ставит признаки режима на
// корень через dataset — `document.documentElement.dataset.appReady = '1'`
// (строка 9424) и `document.documentElement.dataset.theme = …`
// (`src/renderer/ui-catalog.js:4`); `src/renderer/index.css` читает их как
// `:root[data-theme=…]`. На `<body>` в этом дереве висят только КЛАССЫ
// (`sidebar-narrow`, `task-center-open`), а не признаки режима. Значит набор
// требует атрибут `data-version-preset` на `<html>` — тот же способ.
//
// ─── Публичный API, который этот набор замораживает ───────────────────────────
//
// Модуль: `src/renderer/ultra-shell.js`, IIFE с `module.exports`/`root`, как
// `composer-menu.js` и `chat-list.js`. Подключение — своим тегом в
// `src/renderer/index.html` до `app.js`. Стили — `src/renderer/ultra-shell.css`.
//
//   create(deps) → Object.freeze({ mount, update, state, openSession,
//                                  newSession, showEntry, dispose })
//
//   mount(config)     — config это ИТОГ `ui-config.load()` (со всеми полями).
//                       При `config.versionPreset === 'ultra'` оболочка
//                       строится: `<html>` получает `data-version-preset="ultra"`,
//                       `--sidebar-display` и `--work-panel-display` ставятся в
//                       `none` (СУЩЕСТВУЮЩИМИ переменными; новой переменной
//                       включения и второго выключателя нет), в `deps.host`
//                       рисуется экран входа. При `default` и `pro` — ровно
//                       ничего: ни узлов, ни атрибута, ни тронутых переменных.
//   update(config)    — конфигурация изменилась (настройки или примерка):
//                       перестроить оболочку или убрать её вместе с признаком и
//                       переменными.
//   state()           — 'off' | 'entry' | 'empty' | 'chat'.
//   openSession(id)   — открыть ОДИН диалог: `deps.selectChat(id)` ровно один
//                       раз, список Sessions убирается, второго списка нет.
//   newSession()      — пустое состояние новой сессии (искра, приветствие,
//                       строка ввода, живой фон).
//   showEntry()       — возврат к экрану входа со списком Sessions; в режиме
//                       Ultra это делает ОДНА кнопка.
//   dispose()         — снять признак с корня, вернуть переменные display,
//                       убрать свои узлы и всю свою проводку.
//
//   deps = {
//     document, window,        // окно целиком, без обращения к глобалам
//     t(text, ...args),        // КАЖДАЯ видимая строка, включая подсказки
//     escapeHtml(value),
//     host,                    // элемент, куда ставится оболочка
//     chats(),                 // те же диалоги, что держит окно, В ТОМ ЖЕ
//                              // порядке: [{ id, title, updatedAt, … }]
//     timeOf(chat),            // та же пара «название + время», что у окна
//     greeting(),              // приветствие окна (уже переведённое: оно живёт
//                              // в GREETINGS в app.js, модуль его не переводит)
//     titleOf(chatId),         // заголовок открытого диалога для строки
//     selectChat(chatId),      // проводка к существующему selectChat(pane, id)
//     newChat(),               // проводка к createNewChat()
//     send(text)               // строка ввода отдаёт текст окну
//   }
//
// Строка ввода — `<form>` с `textarea` (как обычный композер окна): по submit
// модуль зовёт `deps.send(text)` ровно один раз.
//
// Что перенесено в окно (`tests/run-ultra-shell-ui.cjs`), потому что без
// Chromium не увидеть: вычисленный стиль панелей, что кадр — это действительно
// Ultra, а не прежний экран, и английский без единой русской буквы.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const rel = file => path.relative(ROOT, file).split(path.sep).join('/')

// Пути можно подменить переменными ТОЛЬКО для самопроверки набора на эталонной
// реализации (тот же приём, что `ONECODE_UI_CONFIG_UNDER_TEST` у соседа). В
// общем прогоне переменные не выставлены, и набор смотрит на настоящие файлы.
const MODULE_FILE = process.env.ONECODE_ULTRA_SHELL || 'src/renderer/ultra-shell.js'
const MODULE_PATH = path.isAbsolute(MODULE_FILE) ? MODULE_FILE : path.join(ROOT, MODULE_FILE)
const CSS_FILE = process.env.ONECODE_ULTRA_SHELL_CSS || 'src/renderer/ultra-shell.css'
const CSS_PATH = path.isAbsolute(CSS_FILE) ? CSS_FILE : path.join(ROOT, CSS_FILE)
const UI_CONFIG_PATH = process.env.ONECODE_UI_CONFIG_UNDER_TEST || path.join(ROOT, 'src', 'main', 'ui-config.js')
const APP_SOURCE = process.env.ONECODE_APP_UNDER_TEST || path.join(ROOT, 'src', 'renderer', 'app.js')
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer')
const INDEX_HTML = path.join(RENDERER_DIR, 'index.html')
const I18N_PATH = path.join(RENDERER_DIR, 'i18n.js')

const API_METHODS = ['mount', 'update', 'state', 'openSession', 'newSession', 'showEntry', 'dispose']
const ROOT_CLASS = 'ultra'
// Переменные, которые уже есть в дереве (см. toCssVariables в ui-config.js).
const KNOWN_VARS = new Set([
  '--sidebar-width', '--sidebar-w', '--work-panel-width', '--code-font-size',
  '--font-ui-size', '--line-height', '--sidebar-display', '--work-panel-display'
])
const DISPLAY_VARS = new Set(['--sidebar-display', '--work-panel-display'])
const LAYOUT_PROPS = ['width', 'height', 'top', 'bottom', 'left', 'right', 'margin', 'padding', 'inset']

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

const NO_CONTRACT = 'НЕТ КОНТРАКТА'
const oneLine = value => String((value && value.message) || value || '').split('\n')[0].slice(0, 240)
const norm = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim()

// ─── мягкая загрузка модуля ───────────────────────────────────────────────────
// Два отказа, которые обязаны описываться строкой, а не ронять набор: файла нет
// и файл есть, но require бросает. На них стоят зелёные опоры 1 и 2.
function softRequire (file) {
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `файл «${rel(file)}» ещё не написан (пункт 9.2: оболочка Ultra) — всё, что ниже, красное по этой причине` }
  }
  try {
    delete require.cache[require.resolve(file)]
    return { ok: true, module: require(file) }
  } catch (error) {
    return { ok: false, reason: `модуль «${rel(file)}» не подключается: ${oneLine(error)}` }
  }
}

// Заглушка НЕ бросает на каждом вызове: сцена с ней строится целиком, а
// `requireReal` даёт один внятный текст на проверку. Так набор краснеет по
// отсутствию поведения, а не падает на первом же mount().
function contractStub (reason) {
  const api = {}
  for (const name of API_METHODS) api[name] = () => (name === 'state' ? 'off' : undefined)
  api.reason = reason
  return api
}

// ─── словарь: английская пара каждой русской строки ────────────────────────────
function loadDict () {
  const box = { window: {} }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(I18N_PATH, 'utf8'), box)
  return (box.window.__I18N__ && box.window.__I18N__.en) || {}
}
const DICT = loadDict()

const fill = (template, args) => {
  let next = 0
  return String(template).replace(/%s/g, () => (next < args.length ? String(args[next++]) : '%s'))
}

// ─── самодельный DOM (образец: tests/test-agent-browser-view.cjs) ───────────────
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon'])
const NO_MIRROR = new Set(['id', 'class', 'classname', 'textcontent', 'innerhtml', 'children', 'childnodes', 'dataset', 'style'])

const decodeEntities = text => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

const dashCase = key => String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())
const camelCase = name => String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase())

function makeDom () {
  const makeText = text => ({ nodeType: 3, textContent: String(text), parentNode: null })
  let document = null

  const detach = node => {
    const parent = node.parentNode
    if (!parent) return
    const index = parent._nodes.indexOf(node)
    if (index >= 0) parent._nodes.splice(index, 1)
    node.parentNode = null
    node.parentElement = null
  }
  const adopt = (parent, node) => { detach(node); node.parentNode = parent; if (parent.nodeType === 1) node.parentElement = parent; parent._nodes.push(node); return node }
  const clear = node => { for (const child of node._nodes.slice()) detach(child) }
  const textOf = node => node._nodes.map(child => (child.nodeType === 3 ? child.textContent : textOf(child))).join('')

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

  // style: и обычные свойства (`el.width = '10px'`), и `setProperty('--x', …)`:
  // набор читает, какие CSS-переменные оболочка поставила на корень.
  function makeStyle (el) {
    const map = new Map()
    const base = {
      _map: map,
      _el: el,
      getPropertyValue: key => (map.has(String(key).toLowerCase()) ? map.get(String(key).toLowerCase()) : ''),
      setProperty: (key, value) => { map.set(String(key).toLowerCase(), String(value)) },
      removeProperty: key => { map.delete(String(key).toLowerCase()) }
    }
    return new Proxy(base, {
      get (target, key) {
        if (typeof key === 'symbol' || key in target) return target[key]
        const name = dashCase(String(key))
        return map.has(name) ? map.get(name) : ''
      },
      set (target, key, value) {
        if (key in target) { target[key] = value; return true }
        map.set(dashCase(String(key)), String(value))
        return true
      }
    })
  }

  // dataset живёт в тех же атрибутах, что и `data-*`, — как в настоящем DOM:
  // набор вправе спросить и `el.dataset.versionPreset`, и
  // `getAttribute('data-version-preset')`, и то, что поставил сам модуль.
  function makeDataset (el) {
    return new Proxy({}, {
      get (_, key) { return typeof key === 'string' ? el.getAttribute('data-' + dashCase(key)) : undefined },
      set (_, key, value) { el.setAttribute('data-' + dashCase(key), String(value)); return true },
      deleteProperty (_, key) { el.removeAttribute('data-' + dashCase(key)); return true },
      has (_, key) { return el.hasAttribute('data-' + dashCase(key)) },
      ownKeys () { return [...el._attrs.keys()].filter(name => name.startsWith('data-')).map(name => camelCase(name.slice(5))) },
      getOwnPropertyDescriptor () { return { enumerable: true, configurable: true } }
    })
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
  const textNodes = root => {
    const out = []
    const walk = node => { for (const child of node._nodes) { if (child.nodeType === 3) out.push(child); else if (child.nodeType === 1) walk(child) } }
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
    const push = node => { const parent = stack[stack.length - 1]; if (parent) adopt(parent, node); else out.push(node) }
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

  // Пузырёк событий: click / submit / input / keydown — модуль вправе слушать и
  // строку, и форму, и документ.
  function fire (el, type, extra) {
    const path = []
    let current = el
    while (current) { if (current.nodeType === 1) path.push(current); current = current.parentElement }
    if (document) path.push(document)
    if (win) path.push(win)
    const event = Object.assign({
      type, target: el, currentTarget: el,
      preventDefault () { event._defaultPrevented = true },
      stopPropagation () { event._stopped = true }
    }, extra || {})
    for (const node of path) {
      event.currentTarget = node
      const listeners = (node._listeners || []).filter(item => item.type === type)
      for (const listener of listeners) listener.fn(event)
      const handler = node['on' + type]
      if (typeof handler === 'function') handler(event)
      if (event._stopped) break
    }
    return event
  }

  // <canvas>: рисование не выполняется, а записывается. Набор смотрит, КАКИМ
  // цветом и КУДА оболочка мажет живой фон — «на холсте что-то нарисовано» само
  // по себе ничего не значит: ровный фон был и тогда, когда свечение уходило
  // под непрозрачный предок.
  const CANVAS_OPS = ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'closePath', 'arc', 'arcTo',
    'ellipse', 'stroke', 'fill', 'save', 'restore', 'translate', 'scale', 'moveTo', 'lineTo']

  function makeCanvas (el) {
    const ops = []
    const ctx = {}
    for (const name of CANVAS_OPS) {
      ctx[name] = (...args) => {
        ops.push({ name, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, composite: ctx.globalCompositeOperation })
      }
    }
    const gradient = (...args) => {
      const grad = {
        _stops: [],
        addColorStop (at, color) { grad._stops.push({ at: Number(at), color: String(color) }) }
      }
      ops.push({ name: 'gradient', kind: args.length === 6 ? 'radial' : 'linear', args, grad })
      return grad
    }
    ctx.createRadialGradient = gradient
    ctx.createLinearGradient = gradient
    el.width = 300
    el.height = 150
    el._ops = ops
    el.getContext = kind => (String(kind) === '2d' ? ctx : null)
    return el
  }

  // Токены темы, которые модуль читает через getComputedStyle: акцент берётся
  // оттуда же, откуда у искры, — свечение обязано совпасть с ним по цвету.
  const TOKENS = {
    '--accent': '#e08c62',
    '--accent-ink': '#241a12',
    '--bg-app': '#23211d',
    '--text': '#e4dfd6'
  }
  const resolveToken = (node, prop) => {
    let current = node
    while (current) {
      const own = current.style && current.style.getPropertyValue ? current.style.getPropertyValue(prop) : ''
      if (own) return own
      current = current.parentElement || current.parentNode || null
      if (current && current.nodeType === 9) current = current.documentElement
    }
    return TOKENS[prop] || ''
  }

  // Наблюдатель за узлами: оболочка следит за чужим счётчиком задач, не трогая
  // его. Проверка поднимает его сама — `fireMutations()`.
  const observers = []
  function MutationObserverStub (fn) {
    this.fn = fn
    this.targets = []
    this.live = true
    observers.push(this)
  }
  MutationObserverStub.prototype.observe = function (target) { this.targets.push(target) }
  MutationObserverStub.prototype.disconnect = function () {
    this.live = false
    const at = observers.indexOf(this)
    if (at >= 0) observers.splice(at, 1)
  }
  MutationObserverStub.prototype.takeRecords = function () { return [] }
  const fireMutations = () => { for (const one of observers.slice()) if (one.live) one.fn([]) }

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
      disabled: false,
      value: '',
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
        const at = el._nodes.indexOf(before)
        if (at >= 0) { el._nodes.splice(el._nodes.indexOf(node), 1); el._nodes.splice(at, 0, node) }
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
        if (!NO_MIRROR.has(key) && !key.includes('-')) el[key] = String(value)
      },
      hasAttribute (name) { return el.getAttribute(name) !== null },
      removeAttribute (name) {
        const key = String(name).toLowerCase()
        el._attrs.delete(key)
        if (!NO_MIRROR.has(key) && !key.includes('-')) delete el[key]
      },
      getElementsByTagName (name) { return descendants(el).filter(node => node.tagName === String(name).toUpperCase()) },
      querySelector (selector) { return queryAll(el, selector)[0] || null },
      querySelectorAll (selector) { return queryAll(el, selector) },
      matches (selector) { return String(selector).split(',').some(part => matchCompound(el, part.trim())) },
      closest (selector) {
        let current = el
        while (current) { if (current.nodeType === 1 && matchCompound(current, selector)) return current; current = current.parentElement }
        return null
      },
      contains (node) { return nodeContains(el, node) },
      focus () { if (document) document.activeElement = el },
      blur () {},
      click () { return fire(el, 'click') },
      getBoundingClientRect () { return { left: 0, top: 0, right: 1280, bottom: 760, width: 1280, height: 760, x: 0, y: 0 } }
    }
    el.style = makeStyle(el)
    el.dataset = makeDataset(el)
    if (el.tagName === 'CANVAS') makeCanvas(el)
    Object.defineProperties(el, {
      children: { get () { return el._nodes.filter(node => node.nodeType === 1) } },
      childNodes: { get () { return el._nodes.slice() } },
      firstChild: { get () { return el._nodes[0] || null } },
      firstElementChild: { get () { return el._nodes.find(node => node.nodeType === 1) || null } },
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

  const html = createElement('HTML')
  const head = createElement('HEAD')
  const body = createElement('BODY')
  adopt(html, head); adopt(html, body)
  const documentSubs = []
  document = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    activeElement: body,
    createElement,
    createElementNS: (_ns, tagName) => createElement(tagName),
    createTextNode: makeText,
    createDocumentFragment: () => createElement('DIV'),
    addEventListener (type, fn) { documentSubs.push({ type, fn }) },
    removeEventListener (type, fn) {
      const index = documentSubs.findIndex(item => item.type === type && item.fn === fn)
      if (index >= 0) documentSubs.splice(index, 1)
    },
    _listeners: documentSubs,
    querySelector (selector) { return queryAll(body, selector)[0] || null },
    querySelectorAll (selector) { return queryAll(body, selector) },
    getElementById (id) { return descendants(html).find(el => el.getAttribute('id') === id) || null },
    contains (node) { return nodeContains(html, node) }
  }

  // Обычный вид окна: боковая панель со списком диалогов, чат с шапкой и её
  // кнопками, панель «Работа». Оболочка обязана жить поверх этого, не трогая
  // чужие узлы — потому шапка чата в сцене настоящая.
  for (const node of parseHtml(
    '<div id="sidebar" class="sidebar"><ul id="chatHistoryList" class="chat-history"></ul></div>' +
    '<div id="chatView" class="chat-view active"><header id="chatHeader" class="chat-header">' +
    '<div class="chat-header-actions">' +
    '<button id="navTasks" class="task-center-trigger"><span>Tasks</span>' +
    '<span id="taskCenterBadge" class="task-center-trigger-count">0</span></button>' +
    '<button id="splitViewBtn" class="btn-icon"></button>' +
    '<button id="clearChatBtn" class="btn-icon"></button>' +
    '<button id="tasksHeaderBtn" class="btn-icon tasks-header-btn"></button>' +
    '</div></header>' +
    '<ul id="messagesList"></ul>' +
    '<form id="composerForm"><textarea id="composerTextarea"></textarea><button id="sendBtn" type="submit"></button></form></div>' +
    '<div id="tasksPanel" class="tasks-panel"></div>'
  )) adopt(body, node)
  const host = createElement('DIV')
  host.setAttribute('id', 'ultraHost')
  host.setAttribute('class', 'ultra-host')
  adopt(body, host)

  const win = {
    _listeners: [],
    // «Уменьшить движение» переключается сценой: фон обязан нарисовать РОВНО
    // один кадр и не ставить петлю.
    _reduce: false,
    _raf: 0,
    _frames: [],
    addEventListener (type, fn) { win._listeners.push({ type, fn }) },
    removeEventListener (type, fn) {
      const index = win._listeners.findIndex(item => item.type === type && item.fn === fn)
      if (index >= 0) win._listeners.splice(index, 1)
    },
    matchMedia: query => ({
      matches: /prefers-reduced-motion/.test(String(query)) ? win._reduce : false,
      media: String(query),
      addEventListener () {},
      removeEventListener () {}
    }),
    // Кадры записываются, но сами не выполняются: иначе петля «нарисовать →
    // поставить кадр → нарисовать» не отпускает процесс набора. О том, что фон
    // дышит, говорит счётчик постановок.
    requestAnimationFrame: fn => { win._raf++; win._frames.push(fn); return win._raf },
    cancelAnimationFrame: id => { const at = win._frames.findIndex((fn, index) => index + 1 === Number(id)); if (at >= 0) win._frames.splice(at, 1) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    getComputedStyle: node => ({ getPropertyValue: prop => resolveToken(node, String(prop).trim()) }),
    MutationObserver: MutationObserverStub,
    localStorage: {
      _data: new Map(),
      getItem (key) { return this._data.has(String(key)) ? this._data.get(String(key)) : null },
      setItem (key, value) { this._data.set(String(key), String(value)) },
      removeItem (key) { this._data.delete(String(key)) }
    },
    devicePixelRatio: 1
  }

  return {
    html, head, body, document, win, host, createElement, parseHtml, descendants, textNodes, nodeContains,
    fire, byId: id => document.getElementById(id),
    MutationObserver: MutationObserverStub, fireMutations, observers,
    badge: () => document.getElementById('taskCenterBadge')
  }
}

// ─── сцена: оболочка, подсунутая окном ────────────────────────────────────────
const CHATS_RU = [
  { id: 'c-landing', title: 'Лендинг для студии йоги', updatedAt: 1_700_000_000_000 },
  { id: 'c-habits', title: 'Android-приложение «Привычки»', updatedAt: 1_600_000_000_000 },
  { id: 'c-keys', title: 'Разбор журнала ключей', updatedAt: 1_800_000_000_000 }
]
const CHATS_EN = [
  { id: 'c-landing', title: 'Yoga studio landing', updatedAt: 1_700_000_000_000 },
  { id: 'c-habits', title: 'Habit tracker app', updatedAt: 1_600_000_000_000 },
  { id: 'c-keys', title: 'Key log review', updatedAt: 1_800_000_000_000 }
]
// «Время» — метки латиницей, чтобы пользовательские данные не мешали проверке
// кириллицы вне `t()`. Смысл другой: строка Sessions несёт ТО ЖЕ время, которое
// отдаёт окно (`deps.timeOf`), а то, что придумал модуль.
const TIMES = { 'c-landing': 'TIME-ONE', 'c-habits': 'TIME-TWO', 'c-keys': 'TIME-THREE' }
const GREETINGS = { ru: 'GREETING-RU', en: 'GREETING-EN' }

const ULTRA_CONFIG = extra => Object.assign({
  sidebarWidth: 240, workPanelWidth: 360, codeFontSize: 13, fontUiSize: 13.5,
  lineHeight: 1.45, showSidebar: true, showWorkPanel: false,
  panelsOrder: ['sidebar', 'chat', 'work'], versionPreset: 'ultra'
}, extra || {})

function makeScene (opts = {}) {
  const dom = makeDom()
  // Система «уменьшить движение» ставится ДО создания оболочки: фон обязан
  // нарисовать один кадр и не заводить петлю, а не переставить её на ходу.
  if (opts.reduce) dom.win._reduce = true
  const lang = opts.lang || 'ru'
  const chats = opts.chats || (lang === 'en' ? CHATS_EN : CHATS_RU)
  const keys = []
  const calls = { selectChat: [], newChat: [], send: [] }

  const t = (text, ...args) => {
    const raw = norm(text)
    const out = lang === 'ru' || !DICT[raw] ? fill(raw, args) : fill(DICT[raw], args)
    keys.push({ key: raw, out: norm(out) })
    return out
  }
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]))

  const deps = Object.assign({
    document: dom.document,
    window: dom.win,
    t,
    escapeHtml,
    host: dom.host,
    $: id => dom.byId(id),
    MutationObserver: dom.MutationObserver,
    chats: () => chats,
    timeOf: chat => TIMES[chat.id] || '',
    greeting: () => GREETINGS[lang],
    titleOf: id => (chats.find(chat => chat.id === id) || {}).title || '',
    selectChat: id => { calls.selectChat.push(id) },
    newChat: () => { calls.newChat.push(1); return { id: 'c-new', title: lang === 'en' ? 'New chat' : 'Новый диалог', updatedAt: Date.now(), messages: [] } },
    send: text => { calls.send.push(text) }
  }, opts.deps || {})

  // Состояние ДО оболочки: окно с обеими панелями на виду. Проверки «default и
  // pro ничего не меняют» и dispose() сравнивают переменные с этими значениями.
  dom.html.style.setProperty('--sidebar-display', 'flex')
  dom.html.style.setProperty('--work-panel-display', 'flex')

  const loaded = opts.forceBroken ? { ok: false, reason: opts.forceBroken } : softRequire(MODULE_PATH)
  let broken = loaded.ok ? null : loaded.reason
  if (!broken && typeof (loaded.module || {}).create !== 'function') {
    broken = `в модуле «${rel(MODULE_PATH)}» нет create(deps): наружу отдаётся ${typeof (loaded.module || {}).create}`
  }
  let api = null
  if (!broken) {
    // Модули этого дерева в IIFE смотрят и на globals (`document`, `window`,
    // `localStorage`), как chat-list.js: на время сцены их подставляем, после —
    // снимаем, чтобы одна сцена не отравляла другую.
    const names = ['document', 'window', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']
    const saved = names.map(name => [name, globalThis[name]])
    try {
      globalThis.document = dom.document
      globalThis.window = dom.win
      globalThis.localStorage = dom.win.localStorage
      globalThis.getComputedStyle = dom.win.getComputedStyle
      globalThis.requestAnimationFrame = dom.win.requestAnimationFrame
      globalThis.cancelAnimationFrame = dom.win.cancelAnimationFrame
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
  const realApi = api
  if (broken) api = contractStub(broken)

  const shellNodes = () => dom.descendants(dom.host)
  const shellText = () => norm(dom.host.textContent)
  const userData = [
    ...chats.map(chat => norm(chat.title)),
    ...chats.map(chat => TIMES[chat.id] || ''),
    GREETINGS[lang]
  ].filter(Boolean)
  const userValue = text => userData.some(value => value === text || text.includes(value) || value.includes(text))
  const depth = el => { let n = 0; let current = el; while (current.parentElement) { n++; current = current.parentElement } return n }

  // Строка диалога: самый глубокий узел, в котором есть это название и нет
  // чужих. Классов в контракте нет — ищем по видимому тексту.
  function rowsFor (title) {
    const others = chats.map(chat => norm(chat.title)).filter(other => other !== norm(title))
    return shellNodes()
      .filter(el => shellTextOf(el).includes(norm(title)))
      .filter(el => !others.some(other => other && shellTextOf(el).includes(other)))
      .sort((a, b) => depth(b) - depth(a))
  }
  const shellTextOf = el => norm(el.textContent)

  const scene = {
    dom, deps, calls, keys, api, realApi, broken, chats, lang, opts,
    host: dom.host,
    fireMutations: dom.fireMutations,
    badge: dom.badge,
    shellNodes,
    shellText,
    shellTextOf,
    rowsFor,
    userValue,
    requireReal (what) {
      if (broken) throw new Error(`${NO_CONTRACT}: ${broken} — ${what} проводилась бы впустую`)
    },
    shellRoot () { return dom.host.firstElementChild || null },
    svgs () { return shellNodes().filter(el => el.tagName === 'SVG') },
    forms () { return shellNodes().filter(el => el.tagName === 'FORM') },
    inputs () { return shellNodes().filter(el => ['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'textbox' || el.getAttribute('contenteditable')) },
    buttons () { return shellNodes().filter(el => el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') },
    typeInto (el, text) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = text
      else el.textContent = text
      dom.fire(el, 'input')
    },
    // Отправка строки ввода: submit формы, а если модуль слушает кнопку — клик
    // по кнопке отправки. Считается ровно один вызов deps.send.
    submit () {
      const form = scene.forms()[0]
      if (!form) return { sent: 0, detail: 'в оболочке нет <form>: строка ввода обязана быть формой, как композер окна' }
      dom.fire(form, 'submit')
      if (!calls.send.length) {
        const button = scene.shellNodes().find(el => el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit')
        if (button) dom.fire(button, 'click')
      }
      return { sent: calls.send.length, detail: `форм ${scene.forms().length}, полей ввода ${scene.inputs().length}` }
    }
  }
  return scene
}

const entryScene = (opts = {}) => {
  const scene = makeScene(opts)
  scene.api.mount(ULTRA_CONFIG())
  return scene
}
const chatScene = (opts = {}) => {
  const scene = entryScene(opts)
  scene.api.openSession(scene.chats[0].id)
  return scene
}
const emptyScene = (opts = {}) => {
  const scene = entryScene(opts)
  scene.api.newSession()
  return scene
}

const rootFlag = scene => scene.dom.html.getAttribute('data-version-preset')

// ─── стили: что набор читает текстом ───────────────────────────────────────────
function stripComments (text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const readIfExists = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

// Все стили окна: запрет вращения искры и `transition: all` действует на любой
// файл, обходить его новым файлом нельзя.
const CSS_EXTRA = String(process.env.ONECODE_ULTRA_SHELL_CSS_EXTRA || '').split(';').filter(Boolean)
const CSS_ALL = fs.readdirSync(RENDERER_DIR).filter(name => name.endsWith('.css'))
  .map(name => stripComments(fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8')))
  .concat(CSS_EXTRA.map(file => stripComments(fs.readFileSync(file, 'utf8')))).join('\n')

function shellCss () {
  const text = readIfExists(CSS_PATH)
  assert.notEqual(text, null,
    `файл стилей оболочки «${rel(CSS_PATH)}» ещё не написан (пункт 9.2) — проверять классы оболочки, вращение искры и заморозку фона негде`)
  return stripComments(text)
}

function moduleSource () {
  assert.ok(fs.existsSync(MODULE_PATH), `файл модуля «${rel(MODULE_PATH)}» ещё не написан (пункт 9.2: оболочка Ultra)`)
  return stripComments(fs.readFileSync(MODULE_PATH, 'utf8'))
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

// Правила «селектор → объявления», включая вложенные в @media: проверка
// prefers-reduced-motion обязана смотреть ВСЕ блоки с этим условием.
function parseRules (css, media = '') {
  const rules = []
  const walk = (text, start, end, inside) => {
    let i = start
    let buffer = ''
    while (i < end) {
      const ch = text[i]
      if (ch === '{') {
        const selector = buffer.trim()
        buffer = ''
        let depth = 1
        let j = i + 1
        while (j < end && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++ }
        const body = text.slice(i + 1, j - 1)
        if (/^@(media|supports|layer|container)/i.test(selector)) walk(body, 0, body.length, `${inside} ${selector}`.trim())
        else if (!/^@/.test(selector)) {
          const decls = new Map()
          for (const part of splitDeclarations(body)) {
            const at = part.indexOf(':')
            if (at < 1) continue
            decls.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).replace(/\s*!important\s*$/i, '').trim())
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
  walk(css, 0, css.length, media)
  return rules
}

// Тело @keyframes по имени: вращение и смещение живут именно там.
function keyframeBodies (css) {
  const out = new Map()
  for (const m of String(css).matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let i = m.index + m[0].length
    let depth = 1
    while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++ }
    out.set(m[1], css.slice(m.index + m[0].length, i - 1))
  }
  return out
}

const RULES_ALL = parseRules(CSS_ALL)
const KEYFRAMES_ALL = keyframeBodies(CSS_ALL)

function matchesOne (el, compound) {
  const parts = compound.match(/[#.][\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*|\*$/) || []
  for (const part of parts) {
    if (part === '*') continue
    if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false }
    else if (part[0] === '.') { if (!(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).includes(part.slice(1))) return false }
    else if (part[0] === '[') {
      const inner = part.slice(1, -1)
      const eq = /^([\w:-]+)\s*=\s*([\s\S]*)$/.exec(inner)
      if (!eq) { if (!el.hasAttribute(inner)) return false }
      else if ((el.getAttribute(eq[1]) || '') !== eq[2].replace(/^["']|["']$/g, '')) return false
    } else if (el.tagName !== part.toUpperCase()) return false
  }
  return parts.length > 0
}

// Правило относится к элементу, если один из селекторов совпал по цепочке.
function ruleMatches (el, rule) {
  for (const group of String(rule.selector).split(',')) {
    const chain = group.trim().split(/[\s>+~]+/).filter(Boolean)
    if (!chain.length) continue
    let index = chain.length - 1
    let current = el
    let ok = true
    while (index >= 0) {
      if (!current || current.nodeType !== 1) { ok = false; break }
      const compound = chain[index].replace(/:not\([^)]*\)|::?[a-z-]+(\([^)]*\))?/gi, '')
      if (!(compound === '' ? true : matchesOne(current, compound))) { ok = false; break }
      current = current.parentElement
      index--
    }
    if (ok) return true
  }
  return false
}

const rulesFor = (el, rules = RULES_ALL) => rules.filter(rule => ruleMatches(el, rule))
const classesOf = el => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)

const HOOK_CLASSES = new Set(['icon', 'small', 'active', 'hidden', 'is-shown', 'chevron', 'send-icon', 'stop-icon'])
function usedClasses (scene) {
  const names = new Set()
  for (const el of scene.shellNodes()) for (const name of classesOf(el)) names.add(name)
  return names
}

// Живой фон и искра — узлы, которые набор ищет по форме, а не по имени класса:
// имён узлов в контракте нет.
function backgroundNode (scene) {
  scene.requireReal('поиск живого фона')
  const nodes = scene.shellNodes()
  const byClass = nodes.filter(el => /ubg|bg|aura|horizon|background/i.test(classesOf(el).join(' ')))
  const withCanvas = nodes.filter(el => classesOf(el).length && (el.children || []).some(child => child.tagName === 'CANVAS'))
  const hidden = nodes.filter(el => el.getAttribute('aria-hidden') === 'true')
  const found = byClass[0] || withCanvas[0] || hidden[0] || null
  assert.ok(found, `в оболочке нет узла живого фона (${nodes.length} узлов: ни слоя с классом фона, ни <canvas>, ни aria-hidden подложки)`)
  return found
}

function sparkNode (scene) {
  scene.requireReal('поиск искры')
  const svgs = scene.svgs().filter(el => !el.closest('button'))
  assert.ok(svgs.length, 'в оболочке нет значка искры — крупного svg вне кнопок; на нём и проверяется, что он не вращается')
  return svgs.sort((a, b) => classesOf(b).length - classesOf(a).length)[0]
}

// ─── зелёные опоры: набор стоит на том, что уже есть в дереве ──────────────────
check('зелёная опора: отсутствующий файл модуля описан внятной строкой, а не стеком', () => {
  const probe = path.join(os.tmpdir(), `onlyone-no-such-module-${process.pid}.cjs`)
  try { fs.rmSync(probe, { force: true }) } catch { /* файла и нет */ }
  const loaded = softRequire(probe)
  assert.equal(loaded.ok, false, 'несуществующий файл не мог подключиться — а подключился')
  assert.ok(loaded.reason, 'отказ не описан: вместо строки пустота')
  assert.equal(loaded.reason.includes('\n'), false, `описание отказа обязано быть одной строкой: ${loaded.reason}`)
  assert.match(loaded.reason, /onlyone-no-such-module/, `сообщение не называет файл: ${loaded.reason}`)
  assert.match(loaded.reason, /ещё не написан/, `сообщение не говорит, что файла нет: ${loaded.reason}`)
  assert.equal(/Cannot find module|MODULE_NOT_FOUND|at \S+ \(/.test(loaded.reason), false,
    `отказ отдаётся стек Node вместо человеческой строки: ${loaded.reason}`)
  const scene = makeScene({ forceBroken: loaded.reason })
  assert.equal(scene.api.state(), 'off', 'без модуля сцена обязана жить на заглушке, а не падать на mount()')
  assert.throws(() => scene.requireReal('проверка'), /ещё не написан/, 'каждая красная проверка обязана повторять причину отказа')
})

check('зелёная опора: модуль, который падает при require, не роняет набор', () => {
  const probe = path.join(os.tmpdir(), `onlyone-broken-module-${process.pid}.cjs`)
  fs.writeFileSync(probe, "throw new Error('битый модуль: нет окна')\n", 'utf8')
  try {
    const loaded = softRequire(probe)
    assert.equal(loaded.ok, false, 'битый файл не мог подключиться — а подключился')
    assert.match(loaded.reason, /не подключается/, `отказ обязан говорить, что модуль не подключается: ${loaded.reason}`)
    assert.match(loaded.reason, /битый модуль/, `причина падения require потеряна: ${loaded.reason}`)
    assert.equal(loaded.reason.includes('\n'), false, `одна строка, а не стек: ${loaded.reason}`)
    const scene = makeScene({ forceBroken: loaded.reason })
    for (const name of API_METHODS) assert.equal(typeof scene.api[name], 'function', `заглушка не даёт метод ${name}()`)
    scene.api.mount(ULTRA_CONFIG())
    assert.equal(scene.host.children.length, 0, 'заглушка не имеет права рисовать оболочку')
    assert.throws(() => scene.requireReal('проверка'), /не подключается/, 'причина отказа не доходит до проверки')
  } finally {
    try { fs.rmSync(probe, { force: true }) } catch { /* временный файл */ }
  }
})

check('зелёная опора: пресет оболочки читается из конфигурации интерфейса', () => {
  const uiConfig = require(UI_CONFIG_PATH)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-ultra-cfg-'))
  try {
    const saved = uiConfig.save(dir, { versionPreset: 'ultra' })
    assert.equal(saved.ok, true, `конфигурация с Ultra не сохранилась: ${saved.error}`)
    assert.equal(uiConfig.load(dir).versionPreset, 'ultra', 'пресет не дошёл до окна через load()')
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-ultra-empty-'))
    try { assert.equal(uiConfig.load(empty).versionPreset, 'default', 'профиль без поля обязан давать прежний вид') }
    finally { try { fs.rmSync(empty, { recursive: true, force: true }) } catch { /* временный профиль */ } }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* временный профиль */ }
  }
})

check('зелёная опора: панели выключаются двумя существующими переменными, новых имён нет', () => {
  const uiConfig = require(UI_CONFIG_PATH)
  const vars = uiConfig.toCssVariables(uiConfig.validate({ versionPreset: 'ultra' }).config)
  assert.deepEqual(Object.keys(vars).sort(), [
    '--code-font-size', '--font-ui-size', '--line-height', '--sidebar-display',
    '--sidebar-width', '--work-panel-display', '--work-panel-width'
  ].sort(), `список CSS-переменных окна изменился: ${Object.keys(vars).join(', ')} — оболочка обязана пользоваться им, а не плодить свой выключатель`)
  assert.equal(vars['--sidebar-display'], 'flex', 'при showSidebar: true панель видна')
  const hidden = uiConfig.toCssVariables(uiConfig.validate({ showSidebar: false, showWorkPanel: false }).config)
  assert.equal(hidden['--sidebar-display'], 'none')
  assert.equal(hidden['--work-panel-display'], 'none')
})

check('зелёная опора: признак режима в этом дереве висит на <html> через dataset', () => {
  const app = fs.readFileSync(APP_SOURCE, 'utf8')
  assert.match(app, /document\.documentElement\.dataset\.\w+\s*=/,
    'способ вешать признак режима найден иначе — перепроверьте контракт: набор требует data-version-preset на <html>')
  assert.match(app, /document\.documentElement\.dataset\.appReady\s*=\s*'1'/,
    'признак готовности окна обязан остаться на корне: на него опираются прогоны')
  const css = readIfExists(path.join(RENDERER_DIR, 'index.css')) || ''
  assert.match(css, /:root\[data-theme=/, 'стили окна читают режим с :root — тот же способ обязан выбрать и Ultra')
})

check('зелёная опора: харнесс переводит через deps.t, английская пара берётся из i18n.js', () => {
  assert.ok(DICT['Новый диалог'], 'словарь не загрузился: проверка «всё через t()» бессмысленна')
  const ru = makeScene({ forceBroken: 'самопроверка харнесса' })
  const en = makeScene({ forceBroken: 'самопроверка харнесса', lang: 'en' })
  assert.equal(ru.deps.t('Новый диалог'), 'Новый диалог', 'в русском режиме t() обязан отдавать источник')
  assert.equal(en.deps.t('Новый диалог'), DICT['Новый диалог'], 'в английском режиме t() обязан брать пару из словаря')
  assert.equal(en.deps.t('Показать все (%s)', 12), DICT['Показать все (%s)'].replace('%s', '12'), 'подстановка %s сломалась')
})

check('зелёная опора: подсказки в окне идут через data-tooltip, нативный title запрещён', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  // Исключение то же, что у tests/test-tooltips.cjs: у <iframe> title — это имя
  // области для читалки, а не нативная всплывающая подсказка.
  const native = [...html.matchAll(/<[^>]*\stitle="[^"]*"/g)]
    .map(m => m[0])
    .filter(one => !/<iframe\b/i.test(one) && !/<title\b/i.test(one))
    .map(one => one.slice(-40))
  assert.deepEqual(native, [], `в разметке окна появились нативные подсказки: ${native.join(' | ')}`)
  assert.match(html, /data-tooltip=/, 'data-tooltip — единственный способ подписать подсказку, в разметке его нет')
})

// ─── красные по поведению: экран входа ─────────────────────────────────────────
check('экран входа: список Sessions из тех же диалогов, тот же порядок и пара «название + время»', () => {
  const scene = entryScene()
  scene.requireReal('экран входа со списком Sessions')
  const rows = scene.chats.map(chat => {
    const row = scene.rowsFor(chat.title)[0]
    assert.ok(row, `в списке Sessions нет строки диалога «${chat.title}»: ${scene.shellText().slice(0, 200)}`)
    return row
  })
  const order = rows.map(row => scene.shellNodes().indexOf(row))
  assert.equal(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), true,
    `порядок Sessions не тот, что у окна (порядок индексов в дереве: ${order.join(', ')}): ${rows.map(row => scene.shellTextOf(row).slice(0, 24)).join(' | ')}`)
  for (const chat of scene.chats) {
    const row = scene.rowsFor(chat.title)[0]
    const text = scene.shellTextOf(row)
    assert.ok(text.includes(TIMES[chat.id]),
      `в строке «${chat.title}» нет времени «${TIMES[chat.id]}», которое отдаёт окно: «${text.slice(0, 80)}» — пара «название + время» обязательна`)
  }
})

check('экран входа: в центре искра, приветствие и строка ввода, сзади живой фон', () => {
  const scene = entryScene()
  scene.requireReal('экран входа')
  assert.ok(scene.svgs().length, `на экране входа нет искры: ${scene.shellText().slice(0, 160)}`)
  assert.ok(scene.shellText().includes(GREETINGS[scene.lang]),
    `приветствия окна (deps.greeting/timeOf) не видно: «${scene.shellText().slice(0, 160)}»`)
  assert.ok(scene.inputs().length, 'на экране входа нет строки ввода')
  const bgs = scene.shellNodes().filter(el => /ubg|bg|aura|horizon|background/i.test(classesOf(el).join(' ')))
    .concat(scene.shellNodes().filter(el => (el.children || []).some(child => child.tagName === 'CANVAS')))
    .concat(scene.shellNodes().filter(el => el.getAttribute('aria-hidden') === 'true'))
  assert.ok(bgs.length, 'живого фона на экране входа нет: ни слоя с классом фона, ни <canvas>, ни aria-hidden подложки')
  const bg = bgs[0]
  assert.equal(bg.getAttribute('aria-hidden'), 'true', 'декоративный живой фон обязан быть скрыт от чтения с экрана')
})

check('клик по строке Sessions открывает ОДИН чат: deps.selectChat ровно один раз', () => {
  const scene = entryScene()
  scene.requireReal('клик по строке Sessions')
  const chat = scene.chats[0]
  scene.dom.fire(scene.rowsFor(chat.title)[0], 'click')
  assert.deepEqual(scene.calls.selectChat, [chat.id],
    `на один клик по «${chat.title}» окно получило ${scene.calls.selectChat.length} вызовов selectChat: [${scene.calls.selectChat.join(', ')}] — диалог обязан открываться одним чатом`)
  assert.equal(scene.api.state(), 'chat', `состояние после клика «${scene.api.state()}» вместо «chat»`)
})

// Поломка 30.09: в Ultra на входе и в пустой сессии нельзя было ни добавить
// папку, ни выбрать модель — обычная строка ввода скрыта, а своя их не давала.
check('вход и пустая сессия: под строкой ввода есть «папка» и «модель», подписи читаются из окна', () => {
  for (const [label, build] of [['вход', entryScene], ['пустая сессия', emptyScene]]) {
    const scene = build({ deps: { folderLabel: () => 'мой-проект', modelLabel: () => 'GLM 5.3 Flash' } })
    scene.requireReal('строка папки и модели: ' + label)
    const folder = scene.dom.host.querySelectorAll('.uopt-folder')
    const model = scene.dom.host.querySelectorAll('.uopt-model')
    assert.equal(folder.length, 1, label + ': кнопка папки — ' + folder.length + ' вместо одной')
    assert.equal(model.length, 1, label + ': кнопка модели — ' + model.length + ' вместо одной')
    assert.match(String(folder[0].textContent), /мой-проект/, label + ': подпись папки не из окна')
    assert.match(String(model[0].textContent), /GLM 5.3 Flash/, label + ': подпись модели не из окна')
  }
})

check('подпись папки и модели не копится от обновления к обновлению', () => {
  const scene = entryScene({ deps: { folderLabel: () => 'мой-проект', modelLabel: () => 'GLM 5.3 Flash' } })
  scene.requireReal('подписи папки и модели без накопления')
  scene.api.refresh && scene.api.refresh()
  const folder = scene.dom.host.querySelectorAll('.uopt-folder .uopt-text')[0]
  assert.equal(String(folder.textContent), 'мой-проект', 'подпись папки «' + folder.textContent + '» вместо одной')
})

check('клик по «папке» и «модели» зовёт действия окна: меню папок и каталог моделей', () => {
  const opened = { folders: 0, models: 0 }
  const scene = entryScene({ deps: {
    openFolders: () => { opened.folders++ },
    openModels: () => { opened.models++ }
  } })
  scene.requireReal('клик по кнопкам папки и модели')
  scene.dom.fire(scene.dom.host.querySelectorAll('.uopt-folder')[0], 'click')
  scene.dom.fire(scene.dom.host.querySelectorAll('.uopt-model')[0], 'click')
  assert.equal(opened.folders, 1, 'меню папок открыто ' + opened.folders + ' раз вместо одного')
  assert.equal(opened.models, 1, 'каталог моделей открыт ' + opened.models + ' раз вместо одного')
})

check('в одном чате строки «папка / модель» нет: там работает обычная строка ввода окна', () => {
  const scene = chatScene()
  scene.requireReal('чат без строки папки и модели')
  assert.equal(scene.dom.host.querySelectorAll('.uopt').length, 0, 'в чате Ultra лишняя строка папки и модели')
})

check('открытый чат: список Sessions убран и вторым списком не появляется', () => {
  const scene = chatScene()
  scene.requireReal('один открытый чат')
  assert.equal(scene.calls.selectChat.length, 1, `оболочка звала selectChat ${scene.calls.selectChat.length} раза на один вход в чат`)
  const left = scene.chats.filter(chat => scene.shellText().includes(scene.shellTextOf(chat.title) || chat.title))
  assert.deepEqual(left.map(chat => chat.title), [],
    `в открытом чате оболочка перечисляет диалоги (${left.map(chat => chat.title).join(', ')}) — клик по строке обязан убрать список, а второй список не появляется`)
})

check('один чат, слева пусто: постоянной рейки с диалогами в Ultra нет', () => {
  const scene = chatScene()
  scene.requireReal('пустая левая часть в одном чате')
  const lists = scene.shellNodes().filter(el => ['UL', 'OL', 'NAV'].includes(el.tagName) ||
    ['list', 'listbox', 'navigation', 'menu'].includes(el.getAttribute('role')))
  assert.deepEqual(lists.map(el => el.getAttribute('class') || el.tagName), [],
    `в состоянии чата оболочка держит список (${lists.length} узлов) — в Ultra постоянной рейки диалогов нет`)
  const history = scene.dom.byId('chatHistoryList')
  assert.equal(scene.dom.host.contains(history), false, 'список диалогов окна переехал в оболочку: рейка осталась бы видимой')
})

check('возврат к списку Sessions — одной кнопкой входа', () => {
  const scene = chatScene()
  scene.requireReal('кнопка возврата к Sessions')
  const named = scene.buttons().filter(el => {
    const text = norm(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''}`)
    return /sessions|сессии|диалоги/i.test(text)
  })
  assert.equal(named.length, 1,
    `кнопок возврата к Sessions ${named.length} вместо одной: ${named.map(el => norm(el.textContent) || el.getAttribute('aria-label') || '?').join(' | ') || '(ни одной)'}`)
  scene.dom.fire(named[0], 'click')
  assert.equal(scene.api.state(), 'entry', `после кнопки состояние «${scene.api.state()}» вместо «entry»`)
  const back = scene.chats.filter(chat => !scene.rowsFor(chat.title).length)
  assert.deepEqual(back.map(chat => chat.title), [], `после возврата список Sessions incomplete: ${back.map(chat => chat.title).join(', ')}`)
})

check('пустое состояние новой сессии: искра, приветствие, строка ввода, живой фон', () => {
  const scene = emptyScene()
  scene.requireReal('пустое состояние новой сессии')
  assert.equal(scene.api.state(), 'empty', `после newSession() состояние «${scene.api.state()}» вместо «empty»`)
  assert.ok(scene.svgs().length, 'в пустом состоянии нет искры')
  assert.ok(scene.shellText().includes(GREETINGS.ru), `приветствия нет: «${scene.shellText().slice(0, 160)}»`)
  assert.ok(scene.inputs().length, 'в пустом состоянии нет строки ввода')
  assert.ok(scene.shellNodes().some(el => el.getAttribute('aria-hidden') === 'true'), 'в пустом состоянии нет живого фона')
})

check('строка ввода отдаёт текст deps.send ровно один раз', () => {
  const scene = emptyScene()
  scene.requireReal('строка ввода')
  const field = scene.inputs()[0]
  scene.typeInto(field, 'Собери экран входа')
  const result = scene.submit()
  assert.equal(result.sent, 1, `после отправки deps.send вызван ${result.sent} раз(а) — ${result.detail}`)
  assert.equal(scene.calls.send[0], 'Собери экран входа', `окну уехал не тот текст: ${JSON.stringify(scene.calls.send[0])}`)
})

// ─── красные по поведению: пресет и обычные виды ───────────────────────────────
check('признак оболочки на корне: data-version-preset="ultra" только от versionPreset', () => {
  const scene = entryScene()
  scene.requireReal('признак пресета на корне')
  assert.equal(rootFlag(scene), 'ultra',
    `на <html> признак «${rootFlag(scene)}»: оболочка обязана вешать data-version-preset="ultra" на корень — тем же способом, что data-app-ready и data-theme`)
  assert.equal(scene.dom.body.getAttribute('data-version-preset'), null,
    'признака режима на <body> быть не должно: в этом дереве режимы помечаются на <html>')
  const off = makeScene()
  off.requireReal('признак только от versionPreset')
  off.api.mount(ULTRA_CONFIG({ versionPreset: 'default', showSidebar: false, showWorkPanel: false, sidebarWidth: 180 }))
  assert.notEqual(rootFlag(off), 'ultra', 'пресет «ultra» появился из чужого поля (showSidebar/sidebarWidth), а не из versionPreset')
  const pro = makeScene()
  pro.api.mount(ULTRA_CONFIG({ versionPreset: 'pro' }))
  assert.notEqual(rootFlag(pro), 'ultra', 'про-вид нарисовал оболочку Ultra')
})

check('Ultra гасит боковую панель и панель «Работа» существующими переменными', () => {
  const scene = entryScene()
  scene.requireReal('выключатель панелей')
  assert.equal(scene.dom.html.style.getPropertyValue('--sidebar-display'), 'none',
    `--sidebar-display = «${scene.dom.html.style.getPropertyValue('--sidebar-display')}»: Ultra обязан прятать сайдбар существующей переменной`)
  assert.equal(scene.dom.html.style.getPropertyValue('--work-panel-display'), 'none',
    `--work-panel-display = «${scene.dom.html.style.getPropertyValue('--work-panel-display')}»: панель «Работа» прячется ею, а не новым признаком`)
  const set = new Set()
  for (const el of [scene.dom.html, scene.dom.body, ...scene.shellNodes()]) {
    for (const name of el.style._map.keys()) if (name.startsWith('--')) set.add(name)
  }
  const foreign = [...set].filter(name => !KNOWN_VARS.has(name) && /display|visibility|version|preset|ultra|mode|show/i.test(name))
  assert.deepEqual(foreign, [], `оболочка завела новый выключатель: ${foreign.join(', ')} — панели уже выключаются --sidebar-display и --work-panel-display`)
  const switchers = [...set].filter(name => /^(none|flex|block|grid|inline-flex|hidden|visible)$/.test(String(scene.dom.html.style.getPropertyValue(name))) && !DISPLAY_VARS.has(name))
  assert.deepEqual(switchers, [], `чужая переменная работает выключателем панелей: ${switchers.join(', ')}`)
})

check('default и pro оболочки не видят: ни узлов, ни признака, ни тронутых переменных', () => {
  for (const preset of ['default', 'pro']) {
    const scene = makeScene()
    scene.requireReal(`обычный вид (${preset}) не получает оболочки`)
    scene.api.mount(ULTRA_CONFIG({ versionPreset: preset }))
    assert.equal(scene.host.children.length, 0, `пресет «${preset}»: в deps.host появились узлы оболочки (${scene.host.children.length}) — раскладки по-прежнему нет`)
    assert.notEqual(rootFlag(scene), 'ultra', `пресет «${preset}» поставил признак Ultra`)
    assert.equal(scene.dom.html.style.getPropertyValue('--sidebar-display'), 'flex', `пресет «${preset}» спрятал боковую панель`)
    assert.equal(scene.dom.html.style.getPropertyValue('--work-panel-display'), 'flex', `пресет «${preset}» спрятал панель «Работа»`)
  }
})

check('update() и dispose() снимают оболочку: признак и переменные возвращаются', () => {
  const scene = entryScene()
  scene.requireReal('выход из Ultra')
  scene.api.update(ULTRA_CONFIG({ versionPreset: 'default' }))
  assert.notEqual(rootFlag(scene), 'ultra', 'после update на default признак Ultra остался на корне')
  scene.api.mount(ULTRA_CONFIG())
  scene.api.dispose()
  assert.equal(scene.dom.html.style.getPropertyValue('--sidebar-display'), 'flex',
    'dispose() не вернул --sidebar-display: без окна Ultra человек остался бы без боковой панели')
  assert.equal(scene.dom.html.style.getPropertyValue('--work-panel-display'), 'flex', 'dispose() не вернул --work-panel-display')
  assert.equal(scene.host.children.length, 0, `после dispose() в оболочке осталось ${scene.host.children.length} узлов`)
  assert.notEqual(rootFlag(scene), 'ultra', 'после dispose() признак режима остался на <html>')
})

// ─── красные по поведению: строки, подсказки, классы ───────────────────────────
check('каждая видимая строка оболочки прошла через deps.t; на английском кириллицы нет', () => {
  const ru = entryScene()
  ru.requireReal('строки через deps.t')
  ru.api.newSession()
  const recorded = ru.keys.map(one => one.out).filter(Boolean)
  assert.ok(recorded.length >= 3, `оболочка показала экран, позвав t() ${recorded.length} раз — строк больше, чем ключей`)
  const stray = []
  const judge = (text, where) => {
    if (!text || !/[а-яё]/i.test(text)) return
    const fromT = recorded.some(value => value && (value.includes(text) || text.includes(value)))
    if (fromT || ru.userValue(text)) return
    stray.push(`${where}: ${text.slice(0, 60)}`)
  }
  for (const node of ru.dom.textNodes(ru.host)) judge(norm(node.textContent), 'текст')
  for (const el of ru.shellNodes()) {
    for (const name of ['placeholder', 'aria-label', 'data-tooltip']) judge(norm(el.getAttribute(name)), name)
  }
  assert.deepEqual([...new Set(stray)], [], `кириллица, не прошедшая через deps.t (и не данные окна): ${[...new Set(stray)].join(' | ').slice(0, 240)}`)

  const en = entryScene({ lang: 'en' })
  en.requireReal('английский экран входа')
  en.api.newSession()
  const cyrillic = [...new Set([
    ...en.dom.textNodes(en.host).map(node => norm(node.textContent)).filter(text => /[а-яё]/i.test(text)),
    ...en.shellNodes().flatMap(el => ['placeholder', 'aria-label', 'data-tooltip']
      .map(name => norm(el.getAttribute(name))).filter(text => /[а-яё]/i.test(text)))
  ])]
  assert.deepEqual(cyrillic, [], `на английском экране читается кириллица: ${cyrillic.join(' | ').slice(0, 240)}`)
})

check('у каждого ключа deps.t есть английская пара в src/renderer/i18n.js', () => {
  const scene = entryScene()
  scene.requireReal('английские пары строк оболочки')
  scene.api.newSession()
  scene.api.openSession(scene.chats[0].id)
  const russian = [...new Set(scene.keys.map(one => one.key))].filter(key => /[а-яё]/i.test(key))
  assert.ok(russian.length, `оболочка не позвала t() ни с одной русской строкой (${scene.keys.length} ключей) — проверить пару нечем`)
  const missing = russian.filter(key => !(key in DICT))
  assert.deepEqual(missing, [], `без английской пары: ${missing.slice(0, 8).join(' | ')} — правило: все строки через t() с парой в i18n.js`)
})

check('подсказки только через data-tooltip; кнопка-значок подписана для чтения с экрана', () => {
  const scene = chatScene()
  scene.requireReal('подсказки оболочки')
  const native = scene.shellNodes().filter(el => el.hasAttribute('title'))
  assert.deepEqual(native.map(el => el.outerHTML.slice(0, 60)), [],
    'нативный title в оболочке запрещён (tests/test-tooltips.cjs): подсказки идут только через data-tooltip')
  const unnamed = scene.buttons().filter(el => !norm(el.textContent))
    .filter(el => !el.getAttribute('aria-label') && !el.getAttribute('data-tooltip'))
  assert.deepEqual(unnamed.map(el => classesOf(el).join('.') || el.tagName.toLowerCase()), [],
    `кнопок-значков без имени и без data-tooltip: ${unnamed.length} — ${unnamed.map(el => classesOf(el).join('.') || el.tagName.toLowerCase()).join(', ')}`)
})

check('каждый класс, который ставит оболочка, описан в src/renderer/ultra-shell.css', () => {
  const css = shellCss()
  const source = moduleSource()
  const scene = entryScene()
  scene.requireReal('классы оболочки')
  scene.api.newSession()
  scene.api.openSession(scene.chats[0].id)
  const declared = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]))
  const used = [...usedClasses(scene)]
  for (const m of source.matchAll(/classList\.(?:add|toggle|remove)\('([a-zA-Z][\w-]*)'/g)) used.push(m[1])
  for (const m of source.matchAll(/class(?:Name)?\s*[:=]\s*["'`]([^"'`]+)["'`]/g)) used.push(...m[1].split(/\s+/))
  for (const m of source.matchAll(/class="([^"${]+)"/g)) used.push(...m[1].split(/\s+/))
  const unstyled = [...new Set(used)].filter(name => name && !HOOK_CLASSES.has(name) && !declared.has(name))
  assert.deepEqual(unstyled, [], `классов, которых нет в ultra-shell.css: ${unstyled.join(', ')} — стиль по имени, которого нет, это «почти правильно» вместо ошибки`)
  assert.match(css, new RegExp(`\\.${ROOT_CLASS}\\b`), `в ultra-shell.css нет правила для корня оболочки (по макету — .${ROOT_CLASS})`)
})

// ─── красные по поведению: искра, живой фон, фокус ─────────────────────────────
check('искра не вращается: ни rotate, ни spin-анимации на её классе', () => {
  shellCss()
  const scene = emptyScene()
  scene.requireReal('искра в пустом состоянии')
  const spark = sparkNode(scene)
  const offenders = []
  for (const rule of rulesFor(spark)) {
    for (const [prop, value] of rule.decls) {
      if (!/^(animation|transition)/.test(prop) || /none/.test(value)) continue
      if (/rotate|spin/i.test(value)) { offenders.push(`${rule.selector} (${rule.media}): ${prop}: ${value}`); continue }
      for (const token of value.split(/[\s,]+/)) {
        const body = KEYFRAMES_ALL.get(token)
        if (body && /rotate\(|turn\b|spin/i.test(body)) offenders.push(`${rule.selector}: @keyframes ${token} крутит искру`)
      }
    }
  }
  for (const el of [spark, ...spark.children]) {
    const inline = String(el.style.getPropertyValue('animation') || '') + String(el.style.getPropertyValue('transition') || '')
    if (/rotate|spin/i.test(inline)) offenders.push(`<${el.tagName.toLowerCase()} class="${classesOf(el).join(' ')}"> крутится инлайном: ${inline}`)
  }
  assert.deepEqual([...new Set(offenders)], [], `искра вращается: ${[...new Set(offenders)].join('; ')} — хром молчит, говорит содержимое; допустимы свечение и дыхание яркости`)
})

check('живой фон замораживается по prefers-reduced-motion', () => {
  shellCss()
  const scene = emptyScene()
  scene.requireReal('живой фон')
  const bg = backgroundNode(scene)
  const own = classesOf(bg)
  const frozen = RULES_ALL.filter(rule => /prefers-reduced-motion/.test(rule.media) &&
    (ruleMatches(bg, rule) || own.some(name => new RegExp(`\\.${name.replace(/-/g, '\\-')}\\b`).test(rule.selector))))
  const stops = frozen.filter(rule => [...rule.decls.entries()].some(([prop, value]) =>
    /^animation/.test(prop) && (/none/.test(value) || /\b0(\.0?1)?m?s\b/.test(value))))
  const source = moduleSource()
  const jsFreeze = /prefers-reduced-motion/.test(source) && /matchMedia/.test(source)
  assert.ok(stops.length || jsFreeze,
    `живой фон не замирает по prefers-reduced-motion: правил, снимающих его анимацию — ${stops.length}, ` +
    'в модуле проверки matchMedia нет — следят tests/test-motion.cjs и tests/test-interface-rules.cjs')
})

check('живой фон не анимирует свойств раскладки', () => {
  shellCss()
  const scene = emptyScene()
  scene.requireReal('живой фон')
  const bg = backgroundNode(scene)
  const moved = []
  for (const rule of rulesFor(bg)) {
    for (const [prop, value] of rule.decls) {
      if (!/^(transition|animation)/.test(prop)) continue
      if (/^transition/.test(prop)) {
        for (const part of value.replace(/cubic-bezier\([^)]*\)/g, 'ease').split(',')) {
          const name = part.trim().split(/\s+/)[0]
          if (LAYOUT_PROPS.includes(name)) moved.push(`${rule.selector}: ${prop} → ${name}`)
        }
      }
      for (const token of value.split(/[\s,]+/)) {
        const body = KEYFRAMES_ALL.get(token)
        if (!body) continue
        for (const m of body.matchAll(/([a-z-]+)\s*:/gi)) {
          if (LAYOUT_PROPS.includes(m[1])) moved.push(`${rule.selector}: @keyframes ${token} двигает ${m[1]}`)
        }
        if (/translate[(-]/i.test(body)) moved.push(`${rule.selector}: @keyframes ${token} смещает фон transform'ом`)
      }
    }
  }
  assert.deepEqual([...new Set(moved)], [], `живой фон двигает раскладку: ${[...new Set(moved)].join('; ')}`)
})

check('в стилях оболочки нет transition: all, а фокус описан через :focus-visible', () => {
  const css = shellCss()
  assert.equal(/transition:\s*all\b/i.test(css), false, 'transition: all запрещён: пересчёт раскладки на каждом наведении')
  const scene = emptyScene()
  scene.requireReal('фокус оболочки')
  const interactive = scene.shellNodes().filter(el => ['BUTTON', 'A', 'TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'button')
  assert.ok(interactive.length, 'в оболочке нет ни одного фокусируемого элемента — проверять фокус не на чём')
  const uncovered = []
  const bare = []
  for (const el of interactive) {
    const own = classesOf(el)
    const global = ['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') === 'button'
    const mine = RULES_ALL.some(rule => /:focus-visible/.test(rule.selector) && own.some(name => new RegExp(`\\.${name.replace(/-/g, '\\-')}\\b`).test(rule.selector)))
    if (!(global || mine)) uncovered.push(own.join('.') || el.tagName.toLowerCase())
    for (const rule of rulesFor(el)) {
      if (/:focus(?!-)/.test(rule.selector) && !/:focus-visible/.test(rule.selector) && own.some(name => rule.selector.includes('.' + name))) bare.push(rule.selector)
    }
  }
  assert.deepEqual([...new Set(uncovered)], [], `без :focus-visible остались ${[...new Set(uncovered)].join(', ')} — обводка при мыши или её отсутствие`)
  assert.deepEqual([...new Set(bare)], [], `фокус стилизуется по :focus: ${[...new Set(bare)].join(' | ')}`)
  assert.match(css, /:focus-visible/, 'в ultra-shell.css нет ни одного :focus-visible')
})

check('корень оболочки назван по макету и отличается от прежнего вида', () => {
  shellCss()
  const scene = entryScene()
  scene.requireReal('корень оболочки')
  const root = scene.shellRoot()
  assert.ok(root, 'после mount() в deps.host нет ни одного узла оболочки')
  assert.ok(classesOf(root).includes(ROOT_CLASS),
    `корень оболочки назван «${classesOf(root).join(' ') || '(без класса)'}»: по макету 2.0 это .${ROOT_CLASS}`)
  assert.equal(rootFlag(scene), 'ultra', 'раз оболочка на месте — признак на корне обязан быть')
})

// ─── красные по приёмке Claude 29.09: правки 1–4 оболочки Ultra ────────────────

// Селектор упоминает узел именно как `body`, `#app`, `.app-container`, а не
// как кусок чужого имени (`.app-body` содержит «body»).
const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function mentions (selector, name) {
  return String(selector).split(',').some(part => new RegExp(`(^|[\\s>+~(])${escapeRe(name)}([\\s>+~:,]|$)`)
    .test(` ${part.trim()} `))
}
const ULTRA_FLAG = '[data-version-preset="ultra"]'
function backgroundValues (rules, name) {
  return rules
    .filter(rule => rule.selector.includes(ULTRA_FLAG) && !rule.media && mentions(rule.selector, name))
    .flatMap(rule => [...rule.decls]
      .filter(([prop]) => /^background(-color)?$/.test(prop))
      .map(([, value]) => value))
}
const ACCENT_RGB = [224, 140, 98]
function isAccentColor (value) {
  const text = String(value || '')
  const plain = /^rgba?\(([^)]+)\)/i.exec(text)
  if (plain) {
    const parts = plain[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    return parts.length >= 3 && parts[0] === ACCENT_RGB[0] && parts[1] === ACCENT_RGB[1] && parts[2] === ACCENT_RGB[2]
  }
  return /--accent\b|var\(--accent\)/i.test(text)
}

// Правка 1 приёмки: на трёх кадрах фон ровный. Холст оболочка рисовала, но
// слой с отрицательным z-index уходит ЗА фон предков — а `html, body, #app`
// в этом дереве непрозрачны. Значит под Ultra между корнем и холстом не должно
// остаться ни одного крашенного предка, а база легла на сам корень.
check('живой фон не закрыт фоном окна: предки холста под Ultra прозрачны, база — на корне', () => {
  const rules = parseRules(shellCss())
  const offenders = []
  for (const name of ['body', '#app', '.app-container']) {
    const values = backgroundValues(rules, name)
    if (!values.length) { offenders.push(`${name}: под Ultra правила о фоне нет — остаётся крашеным из index.css`); continue }
    const solid = values.filter(value => !/transparent/.test(value))
    if (solid.length) offenders.push(`${name}: фон «${solid.join(', ')}» перекрывает холст`)
  }
  assert.deepEqual(offenders, [], `живой фон невидим: ${offenders.join('; ')}`)
  const onRoot = rules
    .filter(rule => rule.selector.replace(/\s+/g, '') === `:root${ULTRA_FLAG}`)
    .flatMap(rule => [...rule.decls]
      .filter(([prop]) => /^background(-color)?$/.test(prop))
      .map(([, value]) => value))
  assert.ok(onRoot.some(value => !/transparent/.test(value)),
    `на :root под Ultra базы Ultra нет (${onRoot.join(', ') || 'ни одного значения фона'}): подложку экрана рисует оболочка, а не окно`)
  const behind = rules.filter(rule => mentions(rule.selector, '.ubg')).map(rule => rule.decls.get('z-index')).filter(Boolean)
  assert.ok(behind.some(value => Number(value) < 0),
    `слой живого фона не уходит за содержимое окна (z-index: ${behind.join(', ') || 'не объявлен'})`)
})

check('горизонт: живой фон рисует акцентное свечение в нижней половине холста и кромку', () => {
  const scene = emptyScene()
  scene.requireReal('живой фон в пустой сессии')
  const sky = scene.shellNodes().find(el => el.tagName === 'CANVAS')
  assert.ok(sky, 'в оболочке нет <canvas>: живой фон нечем рисовать')
  const ops = sky._ops || []
  const grads = ops.filter(op => op.name === 'gradient' && op.kind === 'radial')
  assert.ok(grads.length >= 2, `радиальных градиентов ${grads.length} вместо двух и больше: свечение горизонта — не один мазок`)
  const stops = grads.flatMap(one => one.grad._stops.map(item => item.color))
  assert.ok(stops.some(isAccentColor),
    `ни одна остановка градиента не в цвете акцента (${ACCENT_RGB.join(',')} из getComputedStyle): ${stops.slice(0, 6).join(' | ') || 'остановок нет'}`)
  const low = grads.filter(one => Number(one.args[1]) > sky.height * 0.5)
  assert.ok(low.length,
    `свечение выше середины холста — центры ${grads.map(one => Math.round(Number(one.args[1]))).join(', ')} из ${sky.height}: по макету 2.0 горизонт под строкой ввода`)
  assert.ok(ops.filter(one => one.name === 'stroke').some(one => isAccentColor(one.strokeStyle)),
    'кромка горизонта не обведена акцентом: без неё свечение выглядит полосой')
  assert.ok(scene.dom.win._raf >= 1, `живой фон не дышит: requestAnimationFrame вызван ${scene.dom.win._raf} раз`)
})

check('при «уменьшить движение» живой фон рисует один кадр и не заводит петлю', () => {
  const scene = makeScene({ reduce: true })
  scene.requireReal('замороженный живой фон')
  scene.api.mount(ULTRA_CONFIG())
  const sky = scene.shellNodes().find(el => el.tagName === 'CANVAS')
  assert.ok(sky, 'в оболочке нет <canvas>')
  assert.ok((sky._ops || []).length, 'при замороженном движении фон не нарисован вовсе: экран был бы пустым, а не застывшим')
  assert.equal(scene.dom.win._raf, 0,
    `при prefers-reduced-motion оболочка поставила requestAnimationFrame ${scene.dom.win._raf} раз — фон обязан замереть`)
})

// Правка 2: строка ввода 680 px, список 440 px — левый край не совпадает.
check('экран входа: список Sessions стоит в колонке строки ввода, время — по правому краю', () => {
  shellCss()
  const scene = entryScene()
  scene.requireReal('колонка Sessions на экране входа')
  const composer = scene.forms()[0]
  assert.ok(composer, 'на экране входа нет формы строки ввода')
  const chat = scene.chats[0]
  const row = scene.rowsFor(chat.title)[0]
  assert.ok(row, 'в списке Sessions нет ни одной строки диалога')
  const list = row.parentElement
  assert.ok(list, 'строка диалога не висит в списке Sessions')
  const widthOf = el => {
    const values = rulesFor(el).map(rule => rule.decls.get('width')).filter(value => value && /px\s*$/i.test(value))
    return values[values.length - 1] || '(ширина не объявлена)'
  }
  assert.equal(widthOf(list), widthOf(composer),
    `ширина списка Sessions «${widthOf(list)}» не равна ширине строки ввода «${widthOf(composer)}»: колонка разъезжается по левому краю`)
  const time = (row.children || []).find(el => scene.shellTextOf(el).includes(TIMES[chat.id]))
  assert.ok(time, `у строки «${chat.title}» нет отдельного узла с временем «${TIMES[chat.id]}»`)
  const rules = rulesFor(time)
  const pushed = rules.some(rule => ['right', 'end'].includes(rule.decls.get('text-align')) ||
    rule.decls.get('float') === 'right' || /auto/.test(rule.decls.get('margin-left') || ''))
  assert.ok(pushed, 'время строки не прижато к правому краю — оно обязано стоять по краю строки ввода')
})

// Правка 3: «Sessions» на русском экране.
check('Sessions по-русски — «Сессии», на английском — Sessions; то же в полосе возврата', () => {
  const ru = entryScene({ lang: 'ru' })
  ru.requireReal('русская подпись списка Sessions')
  assert.ok(ru.shellText().includes('Сессии'),
    `на русском список подписан не «Сессии»: «${ru.shellText().slice(0, 120)}»`)
  const ruBar = emptyScene({ lang: 'ru' })
  assert.ok(ruBar.shellText().includes('Сессии'),
    `полоса пустой сессии по-русски не говорит «Сессии»: «${ruBar.shellText().slice(0, 120)}»`)
  const en = entryScene({ lang: 'en' })
  assert.ok(en.shellText().includes('Sessions'), `на английском подпись потерялась: «${en.shellText().slice(0, 120)}»`)
  assert.equal(/Сесс/i.test(en.shellText()), false, 'на английском в оболочке осталась русская подпись списка')
})

// Правка 4: лишний хром в одном чате.
check('один чат Ultra: кнопок разделения окна и панели «Работа» на экране нет', () => {
  const rules = parseRules(shellCss())
  const stillThere = []
  for (const name of ['#splitViewBtn', '.tasks-header-btn']) {
    const killed = rules.some(rule => rule.selector.includes(ULTRA_FLAG) && mentions(rule.selector, name) &&
      [...rule.decls].some(([prop, value]) => prop === 'display' && /\bnone\b/.test(value)))
    if (!killed) stillThere.push(name)
  }
  assert.deepEqual(stillThere, [],
    `в Ultra на экране остались чужие кнопки (${stillThere.join(', ')}): разделение окна и панель «Работа» в Ultra не живут`)
})

check('один чат Ultra: «Задачи» прячутся при нуле и возвращаются с первой задачей', () => {
  const scene = chatScene()
  scene.requireReal('счётчик задач в шапке чата')
  const badge = scene.badge()
  assert.ok(badge, 'в сцене нет счётчика задач окна')
  assert.equal(scene.shellTextOf(badge), '0', 'счётчик сцены обязан начинаться с нуля')
  assert.equal(scene.dom.html.getAttribute('data-ultra-tasks'), 'zero',
    `оболочка не переносит нулевой счётчик задач на корень (признак «${scene.dom.html.getAttribute('data-ultra-tasks') || 'нет'}») — в Ultra висит «Tasks 0»`)
  badge.textContent = '3'
  scene.fireMutations()
  assert.equal(scene.dom.html.getAttribute('data-ultra-tasks'), 'some',
    'после первой задачи признак на корне не вернулся: кнопка «Задачи» осталась бы спрятанной')
  const rules = parseRules(shellCss())
  assert.ok(rules.some(rule => rule.selector.includes('data-ultra-tasks="zero"') && mentions(rule.selector, '#navTasks') &&
    [...rule.decls].some(([prop, value]) => prop === 'display' && /\bnone\b/.test(value))),
    'нулевой счётчик задач не прячет кнопку «Задачи» стилем под признаком Ultra')
  scene.api.dispose()
  assert.equal(scene.dom.html.getAttribute('data-ultra-tasks'), null,
    'dispose() оставил признак счётчика задач на корне: обычный вид потерял бы кнопку')
})

// ─── U-2: «Задачи» в Ultra открываются свободным блоком ──────────────────────
//
// Слово владельца 30.09: в Ultra «Задачи» — свободный блок, а не экран на
// пол-окна. Оболочка не знает, как устроен центр задач: окно отдаёт ей тело
// блока (`deps.tasksBody`), оболочка дополняет список результатов одним
// предметом и решает, показать его или убрать. Место и размер оболочка не
// хранит — просит у окна `deps.loadLayout()` при первом монтаже слоя и отдаёт
// `deps.saveLayout(map)`, когда человек переставил или растянул блок.

function fakeBlocks (log) {
  const geo = {}
  const api = {
    deps: null,
    items: [],
    create (deps) { api.deps = deps; return api },
    mount (target) { log.mounts.push(target); return target },
    render (items) {
      api.items = (Array.isArray(items) ? items : []).slice()
      log.renders.push(api.items.map(item => item.id).join('+'))
      // Настоящий слой блоков вешает тело (`deps.bodyFor`) на узел блока —
      // подделка делает то же самое, иначе нечем проверить, куда переезжает
      // экран окна и откуда его надо вернуть.
      for (const item of api.items) {
        if (!item || item.id !== 'ultra-tasks' || typeof api.deps.bodyFor !== 'function') continue
        const node = api.deps.bodyFor(item)
        const shell = api.deps.document.createElement('div')
        shell.setAttribute('data-block-id', item.id)
        shell.setAttribute('class', 'ublock')
        if (node) shell.appendChild(node)
        api.bodyNode = shell
      }
      return api.items
    },
    state: () => ({ blocks: api.items.map(item => ({ id: item.id })), zone: null }),
    geometry: () => JSON.parse(JSON.stringify(geo)),
    restore (map) { Object.assign(geo, JSON.parse(JSON.stringify(map || {}))); return api.geometry() },
    insets: () => ({ left: 0, right: 0 }),
    dispose () { log.disposed.push(1) },
    // Законченное перетаскивание: модуль сам зовёт `onChange`, тем же путём
    // оболочка и узнаёт, что геометрию пора сохранить.
    settle (id, at) {
      geo[id] = Object.assign({}, geo[id], at)
      if (api.deps && typeof api.deps.onChange === 'function') api.deps.onChange()
    }
  }
  return api
}

function tasksScene (opts = {}) {
  const log = { mounts: [], renders: [], disposed: [], saved: [], loaded: opts.layout || null }
  const blocks = fakeBlocks(log)
  const body = makeScene({
    deps: Object.assign({
      blocks,
      results: () => [{ id: 'a-page', title: 'Лендинг', kind: 'page', versions: 1 }],
      saveLayout: map => { log.saved.push(map) },
      loadLayout: () => log.loaded
    }, opts.deps || {})
  })
  body.blocks = blocks
  body.log = log
  return body
}

check('U-2: «Задачи» в чате Ultra — предмет свободного блока 360×480, а не экран на пол-окна', () => {
  const scene = tasksScene()
  scene.requireReal('U-2: блок «Задачи»')
  scene.api.openSession(scene.chats[0].id)
  assert.equal(typeof scene.api.tasksClicked, 'function',
    'у оболочки нет tasksClicked() — окно не может спросить, кто открывает «Задачи»')
  const handled = scene.api.tasksClicked()
  assert.equal(handled, true, 'оболочка не взяла на себя нажатие «Задачи» в чате Ultra')
  const item = scene.blocks.items.find(one => one.id === 'ultra-tasks')
  assert.ok(item, `в списке блоков нет «ultra-tasks»: ${scene.blocks.items.map(one => one.id).join(', ') || 'пусто'}`)
  assert.equal(item.w, 360, `ширина предмета ${item.w}, а жали 360 px`)
  assert.equal(item.h, 480, `высота предмета ${item.h}, а жали 480 px`)
  assert.ok(norm(item.title).length, 'у предмета нет названия — блок остался бы без заголовка')
})

check('U-2: второе нажатие убирает блок, третье возвращает его на прежнее место', () => {
  const scene = tasksScene()
  scene.requireReal('U-2: память места блока «Задачи»')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  scene.blocks.settle('ultra-tasks', { x: 880, y: 96, w: 420, h: 520 })
  scene.api.tasksClicked()
  assert.ok(!scene.blocks.items.some(one => one.id === 'ultra-tasks'),
    'после второго нажатия блок остался в списке')
  scene.api.tasksClicked()
  const back = scene.blocks.geometry()['ultra-tasks']
  assert.ok(back && back.x === 880 && back.y === 96 && back.w === 420 && back.h === 520,
    `возвращённый блок сел не туда: ${JSON.stringify(back)}`)
})

check('U-2: переставленный блок сохраняется через deps.saveLayout, а не в памяти вкладки', () => {
  const scene = tasksScene()
  scene.requireReal('U-2: сохранение геометрии')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  scene.blocks.settle('ultra-tasks', { x: 640, y: 128, w: 360, h: 480 })
  const last = scene.log.saved[scene.log.saved.length - 1]
  assert.ok(last && last['ultra-tasks'] && last['ultra-tasks'].x === 640,
    `saveLayout не получал геометрию с блоком (вызовов: ${scene.log.saved.length}, последнее: ${JSON.stringify(last)})`)
})

check('U-2: сохранённое между запусками читается один раз и ложится в слой блоков', () => {
  const stored = { 'ultra-tasks': { x: 700, y: 200, w: 360, h: 480, min: false, closed: false, zone: null } }
  const scene = tasksScene({ layout: stored })
  scene.requireReal('U-2: чтение сохранённой геометрии')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const one = scene.blocks.geometry()['ultra-tasks']
  assert.ok(one && one.x === 700 && one.y === 200,
    `блок не вернулся на сохранённое место: ${JSON.stringify(one)}`)
})

check('U-2: тело блока берёт у окна, а на входе (не чат) нажатие остаётся оконным', () => {
  const scene = tasksScene()
  scene.requireReal('U-2: тело блока от окна')
  const node = scene.dom.document.createElement('section')
  node.setAttribute('id', 'taskCenterView')
  if (typeof scene.deps === 'object' && scene.deps) scene.deps.tasksBody = () => node
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const provided = typeof scene.blocks.deps.bodyFor === 'function' ? scene.blocks.deps.bodyFor({ id: 'ultra-tasks' }) : null
  assert.equal(provided, node,
    'модуль блоков не спрашивает тело у оболочки: экран задач пришлось бы пересобирать')
  const entry = tasksScene()
  entry.requireReal('U-2: вне чата нажатие остаётся оконным')
  assert.equal(entry.api.tasksClicked(), false,
    'на экране входа оболочка перехватила «Задачи»: окно не откроет свой раздел')
})

check('U-2: первый блок «Задач» встаёт под кнопкой, а не в общую точку старта', () => {
  const scene = tasksScene({ deps: { tasksAnchor: () => ({ left: 900, right: 1260, top: 48, bottom: 80, width: 360, height: 32 }) } })
  scene.requireReal('U-2: место под кнопкой')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const item = scene.blocks.items.find(one => one.id === 'ultra-tasks')
  assert.ok(item, 'предмета «ultra-tasks» нет')
  assert.ok(Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)),
    `у предмета нет стартовых координат: ${JSON.stringify(item)}`)
  assert.ok(Math.abs(item.x + 360 - 1260) <= 8,
    `правый край блока не под кнопкой: x=${item.x} + 360 против правого края кнопки 1260`)
  assert.ok(Math.abs(item.y - 88) <= 8,
    `блок не под кнопкой: y=${item.y}, а жали 80 + 8`)
})

check('U-2: сохранённое место сильнее стартового под кнопкой', () => {
  const stored = { 'ultra-tasks': { x: 120, y: 300, w: 360, h: 480, min: false, closed: false, zone: null } }
  const scene = tasksScene({
    layout: stored,
    deps: { tasksAnchor: () => ({ left: 900, right: 1260, top: 48, bottom: 80, width: 360, height: 32 }) }
  })
  scene.requireReal('U-2: память важнее кнопки')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const item = scene.blocks.items.find(one => one.id === 'ultra-tasks')
  assert.ok(item, 'предмета «ultra-tasks» нет')
  assert.ok(item.x === undefined || item.x === 120,
    `блок поехал на кнопку, хотя место сохранено: x=${item.x}`)
  assert.ok(item.y === undefined || item.y === 300,
    `сохранённое y потеряно: y=${item.y}`)
})

check('U-2: нулевой прямоугольник скрытой кнопки не двигает блок к левому краю', () => {
  // В Ultra кнопка «Задачи» спрятана при нулевом счётчике (правка 4 приёмки
  // 9.2), а `getBoundingClientRect()` скрытого узла — одни нули. На них блок
  // уезжал в x = −360, то есть к левому краю окна.
  const scene = tasksScene({ deps: { tasksAnchor: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) } })
  scene.requireReal('U-2: скрытая кнопка')
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const item = scene.blocks.items.find(one => one.id === 'ultra-tasks')
  assert.ok(item, 'предмета «ultra-tasks» нет')
  assert.equal(item.x, undefined,
    `блок получил стартовый x=${item.x} по нулевому прямоугольнику кнопки`)
  assert.equal(item.y, undefined,
    `блок получил стартовый y=${item.y} по нулевому прямоугольнику кнопки`)
})

check('U-2: закрытый блок возвращает экран окна домой', () => {
  const scene = tasksScene()
  scene.requireReal('U-2: возврат узла')
  const holder = scene.dom.document.createElement('section')
  holder.setAttribute('id', 'chatView')
  const view = scene.dom.document.createElement('div')
  view.setAttribute('id', 'taskCenterView')
  holder.appendChild(view)
  scene.deps.tasksBody = () => view
  scene.api.openSession(scene.chats[0].id)
  scene.api.tasksClicked()
  const block = scene.blocks.items.find(one => one.id === 'ultra-tasks')
  assert.ok(block, 'предмета «ultra-tasks» нет')
  assert.notEqual(view.parentElement, holder, 'экран так и не переехал в блок — проверять нечего')
  scene.api.tasksClicked()
  assert.equal(view.parentElement, holder,
    `после закрытия блока экран остался в чужом узле (${view.parentElement && view.parentElement.getAttribute('id') || view.parentElement && view.parentElement.getAttribute('class')}): dispose() оболочки выбросил бы его из окна`)
  scene.api.dispose()
  assert.equal(view.parentElement, holder, 'после dispose() экран не дома')
})

// ─── 9.2 остаток: выбор Ultra в настройках «Вид приложения» ────────────────────
//
// Требование 29.09 14:40: карточка «onlyone Ultra» в Настройках выбирается и
// пишет `versionPreset: 'ultra'` тем же `setUiConfig` (7.1), без перезапуска;
// возврат на onlyone — так же; Pro остаётся «скоро» и не выбирается. Кадр 1.14:
// «Оболочка есть — пора включить».
//
// Дефект, который закрывает пункт, — ВТОРОЙ ИСТОЧНИК ИСТИНЫ. Факт из дерева на
// момент написания проверок: карточки (`src/renderer/onboarding.js`) пишут
// приватный ключ `onlyone.edition` в localStorage и на экран не влияют, а экран
// слушает `versionPreset` конфигурации интерфейса. Поэтому набор мерит два факта
// сразу:
//
//   1) КУДА идёт запись — в мост `window.electronAPI.setUiConfig`, ровно тот же
//      канал, что держат настройки панелей и примерка из чата (7.1, 7.2);
//   2) ЧТО именно уехало — `versionPreset` = ultra|default, а восемь остальных
//      полей конфигурации СОХРАНИЛИСЬ. Это не придирка к форме запроса:
//      `ipcMain.handle('set-ui-config')` в main.js зовёт `ui-config.save()`,
//      а тот добивает отсутствующие поля до DEFAULT_UI_CONFIG, а не до значений
//      профиля. Значит неполный payload — это потерянные ширины, шрифты и
//      порядок панелей, и проверка краснеет по результату в профиле.
//
// Что набор СОЗНАТЕЛЬНО не требует (внутренности решения):
//   · имени обработчика, порядка `await` и того, откуда карточка берёт текущую
//     конфигурацию — с моста (`getUiConfig`) или из окна (`onlyoneApp.getUiConfig`);
//     обаstub'а отдают profile-файл, прочитанный НАСТОЯЩИМ `src/main/ui-config.js`;
//   · нужна ли запись `onlyone.edition` в localStorage вдобавок — вторым
//     выключателем экрана она быть не вправе, и это меряется поведением
//     (карточки отражают `versionPreset`, а не ключ), а не запретом строки;
//   · как именно помечена выбранная карточка: требует `aria-checked` и того, что
//     выбранный вид ОТЛИЧАЕТСЯ от остальных (классом — любым, не именем).
//
// Живой экран, отсутствие перезапуска и кадры проверяет оконный прогон
// (`tests/ultra-shell-renderer.js`, режимы `version-choose`/`version-ultra`/
// `version-return`, и `tests/run-ultra-shell-ui.cjs`).

const ONBOARDING_FILE = process.env.ONECODE_ONBOARDING_UNDER_TEST || 'src/renderer/onboarding.js'
const ONBOARDING_PATH = path.isAbsolute(ONBOARDING_FILE) ? ONBOARDING_FILE : path.join(ROOT, ONBOARDING_FILE)
const SETTINGS_MARKUP = process.env.ONECODE_SETTINGS_MARKUP_UNDER_TEST || INDEX_HTML

// Стартовая конфигурация сцены: ОТЛИЧИМА от DEFAULT_UI_CONFIG каждым полем, иначе
// «остальные поля не обнулены» измерить нельзя — обнуление до дефолтов незаметно.
const SETTINGS_START = Object.freeze({
  sidebarWidth: 300, workPanelWidth: 420, codeFontSize: 16, fontUiSize: 12.5,
  lineHeight: 1.6, showSidebar: true, showWorkPanel: true,
  panelsOrder: ['chat', 'sidebar', 'work'], versionPreset: 'default'
})
const SETTINGS_FIELDS = Object.freeze(Object.keys(SETTINGS_START))
// Признаки, которые ЭТО ДЕРЕВО уже держит на корне (data-theme, data-app-ready) и
// которые ставит оболочка по значению versionPreset (data-version-preset,
// data-ultra-tasks). Ничего другого клик по карточке заводить не вправе.
const ALLOWED_ROOT_FLAGS = /^data-(version-preset|ultra-tasks|theme|app-ready)$/

// Разметка вкладки «Вид приложения» берётся из настоящего `index.html`: проверка
// обязана видеть карточки там, где их видит человек, а не там, где их нарисовал
// тест. Функция бросает внятной строкой, если вкладки в разметке нет.
function appearanceSectionHtml () {
  let html = null
  try { html = fs.readFileSync(SETTINGS_MARKUP, 'utf8') } catch (error) {
    throw new Error(`разметку окна («${rel(SETTINGS_MARKUP)}») не прочитать: ${oneLine(error)}`)
  }
  const start = html.search(/<section[^>]*data-settings-panel="appearance"[^>]*>/)
  if (start < 0) throw new Error(`в «${rel(SETTINGS_MARKUP)}» нет вкладки «Вид приложения» (data-settings-panel="appearance") — карточкам версии негде стоять`)
  const end = html.indexOf('</section>', start)
  if (end < 0) throw new Error('вкладка «Вид приложения» не закрыта — разметку окна нельзя взять как есть')
  return html.slice(start, end)
}

// onboarding.js поднимается в подставном окне так же, как в браузере: IIFE вешает
// всё на `window`. Отказ (файла нет / не подключился / нет нужного наружу API)
// описывается одной строкой и повторяется в каждой проверке — набор краснеет по
// отсутствию поведения, а не падает на первом клике.
function loadOnboarding (box) {
  if (!fs.existsSync(ONBOARDING_PATH)) {
    return { ok: false, reason: `файл «${rel(ONBOARDING_PATH)}» не найден — карточек версий в настройках нет (пункт 9.2, выбор версии)` }
  }
  try {
    vm.runInContext(fs.readFileSync(ONBOARDING_PATH, 'utf8'), box, { filename: rel(ONBOARDING_PATH) })
  } catch (error) {
    return { ok: false, reason: `onboarding.js в сцене настроек не подключается: ${oneLine(error)}` }
  }
  const api = box.onlyoneOnboarding
  if (!api || typeof api.renderSettingsEditions !== 'function' || typeof api.init !== 'function') {
    return { ok: false, reason: `onboarding.js не отдаёт наружу init() и renderSettingsEditions(): есть только ${api ? Object.keys(api).join(', ') : '(ничего)'}` }
  }
  return { ok: true }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function makeSettingsScene (opts = {}) {
  const lang = opts.lang || 'ru'
  const dom = makeDom()
  for (const node of dom.parseHtml(appearanceSectionHtml())) dom.body.appendChild(node)
  const host = dom.byId('editionChoices')

  const uiConfig = require(UI_CONFIG_PATH)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-settings-version-'))
  const start = Object.assign({}, SETTINGS_START, opts.config || {})
  const seeded = uiConfig.save(profile, start)
  if (!seeded.ok) throw new Error(`профиль сцены не принял стартовую конфигурацию: ${seeded.error}`)
  const stored = () => uiConfig.load(profile)

  // Перевод — тот же мост, что окну даёт `onlyoneApp.t`: без него проверка
  // «ни одной русской строки в английских карточках» ничего не стоит.
  const keys = []
  const t = (text, ...args) => {
    const raw = norm(text)
    const out = lang === 'ru' || !DICT[raw] ? fill(raw, args) : fill(DICT[raw], args)
    keys.push({ key: raw, out: norm(out) })
    return out
  }

  const calls = { setUiConfig: [], applyUiConfig: [], errors: [] }
  const listeners = []
  const electronAPI = {
    // Знакомство в сцене не открывается: прогон проверяет Настройки, а не анкету.
    automatedRun: true,
    getUiConfig: () => Promise.resolve(stored()),
    setUiConfig: config => {
      // Ровно тот же путь, что `ipcMain.handle('set-ui-config')`: save() в
      // профиль и ответ окну. Никакого «допиши недостающие поля из профиля» —
      // так сегодня делает настоящий main.js.
      calls.setUiConfig.push(JSON.parse(JSON.stringify(config)))
      const res = uiConfig.save(profile, config)
      if (!res.ok) { calls.errors.push(res.error); return Promise.resolve(res) }
      for (const one of listeners.slice()) one(res.config)
      return Promise.resolve(res)
    },
    resetUiConfig: () => Promise.resolve(uiConfig.reset(profile)),
    onUiConfigChanged: callback => { listeners.push(callback); return () => {} }
  }
  const onlyoneApp = {
    t,
    lang: () => lang,
    setLanguage: () => {},
    keysCount: () => 0,
    chatsCount: () => 0,
    personal: () => ({}),
    savePersonal: () => {},
    // Два канала, которыми карточка вправе прочитать текущую версию: мост и
    // мост окна. Оба отдают ОДНО И ТО ЖЕ значение — требовать один из двух набор
    // не стал бы проверкой, а проверкой было бы «значение прочитано из
    // конфигурации», и оно здесь ровно одно.
    getUiConfig: () => stored(),
    applyUiConfig: config => { calls.applyUiConfig.push(JSON.parse(JSON.stringify(config))) }
  }

  const box = {
    document: dom.document,
    localStorage: dom.win.localStorage,
    navigator: { language: lang === 'ru' ? 'ru-RU' : 'en-US' },
    matchMedia: query => dom.win.matchMedia(query),
    requestAnimationFrame: fn => dom.win.requestAnimationFrame(fn),
    cancelAnimationFrame: id => dom.win.cancelAnimationFrame(id),
    getComputedStyle: dom.win.getComputedStyle,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id),
    console,
    electronAPI,
    onlyoneApp
  }
  vm.createContext(box)
  vm.runInContext('globalThis.window = globalThis;', box)
  // Память прежних карточек: приватный ключ, который сегодня и есть второй
  // источник истины. Сцена задаёт его ДО подъёма, чтобы проверить, кто из двух
  // источников победит.
  if (opts.edition) dom.win.localStorage.setItem('onlyone.edition', String(opts.edition))

  const loaded = loadOnboarding(box)
  let broken = loaded.ok ? null : loaded.reason
  if (!broken) {
    try {
      box.onlyoneOnboarding.init()
      box.onlyoneOnboarding.renderSettingsEditions()
    } catch (error) {
      broken = `onboarding.js в сцене настроек падает на init()/renderSettingsEditions(): ${oneLine(error)}`
    }
  }

  const card = id => (host ? host.querySelector(`[data-edition="${id}"]`) : null)
  const cards = () => (host ? [...host.querySelectorAll('[data-edition]')] : [])
  const checked = id => {
    const el = card(id)
    return el ? norm(el.getAttribute('aria-checked')) : null
  }
  // Пометка «скоро» ищется по-человечески: элемент-пометка (любого имени со
  // «soon») или такое же слово в тексте карточки.
  const soonOf = el => {
    if (!el) return false
    const mark = el.querySelectorAll('*').find(node => /soon/i.test(classesOf(node).join(' ')))
    return Boolean(mark) || /скоро|\bsoon\b/i.test(norm(el.textContent))
  }
  const rootSnapshot = () => ({
    attrs: new Set([...dom.html._attrs.keys()].filter(name => name.startsWith('data-'))),
    vars: new Set(dom.html.style._map.keys())
  })
  const foreign = before => {
    const after = rootSnapshot()
    return {
      vars: [...after.vars].filter(name => !before.vars.has(name) && !KNOWN_VARS.has(name)),
      attrs: [...after.attrs].filter(name => !before.attrs.has(name) && !ALLOWED_ROOT_FLAGS.test(name))
    }
  }
  // Клик карточки: событие идёт от самой карточки (так же, как от `<span>`внутри
  // — обработчик висит на группе и берёт `closest`), потом даём асинхронному
  // обработчику два тика: проверка мерит результат, а не мгновенный стёк.
  async function click (id) {
    const el = card(id)
    if (!el) throw new Error(`в #editionChoices нет карточки «${id}»: ${cards().map(one => one.getAttribute('data-edition')).join(', ') || '(пусто)'}`)
    dom.fire(el, 'click')
    await new Promise(resolve => setTimeout(resolve, 60))
    await Promise.resolve()
    return el
  }

  const scene = {
    dom, host, box, lang, keys, calls, start, stored, card, cards, checked, soonOf,
    click, rootSnapshot, foreign,
    editionMemory: () => dom.win.localStorage.getItem('onlyone.edition'),
    rerender: () => box.onlyoneOnboarding.renderSettingsEditions(),
    // Так же меняет версию чат (пункт 7.2): полный config через тот же мост.
    bridgeSet: config => electronAPI.setUiConfig(Object.assign({}, stored(), config)),
    requireReal (what) {
      if (broken) throw new Error(`${NO_CONTRACT}: ${broken} — ${what} проводилась бы впустую`)
    },
    dispose () {
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* временный профиль */ }
    }
  }
  return scene
}

const asyncChecks = []
function acheck (name, fn) { asyncChecks.push([name, fn]) }

acheck('зелёная опора: карточки версии стоят во вкладке «Вид приложения» настоящих настроек', () => {
  const section = appearanceSectionHtml()
  assert.match(section, /id="editionChoices"/, 'вкладки «Вид приложения» есть, а группы #editionChoices в них нет')
  assert.match(section, /role="radiogroup"/, 'карточки версии не объявлены группой переключателей')
  assert.match(section, /Версия/, 'группа карточек не названа «Версия»')
  assert.match(section, /Данные общие/,
    'из подписи под «Версия» пропало обещание, что данные общие: при смене версии чаты, проекты и ключи обязаны оставаться')
})

acheck('зелёная опора: сцена настроек поднимает onboarding.js, карточки на месте, мост молчит', () => {
  const scene = makeSettingsScene()
  try {
    scene.requireReal('подъём onboarding.js в сцене настроек')
    const ids = scene.cards().map(el => el.getAttribute('data-edition'))
    assert.deepEqual(ids, ['default', 'pro', 'ultra'], `в #editionChoices карточки: ${ids.join(', ') || '(пусто)'}`)
    assert.deepEqual(scene.calls.setUiConfig, [], 'до всякого клика мост setUiConfig уже позван — карточки рисуются записью')
    assert.deepEqual(scene.calls.errors, [], `профиль не принял конфигурацию сцены: ${scene.calls.errors.join(' | ')}`)
    assert.equal(scene.stored().versionPreset, 'default', 'профиль сцены обязан стартовать с обычной версии')
    assert.equal(scene.stored().sidebarWidth, 300, 'стартовая конфигурация сцены обязана отличаться от DEFAULT_UI_CONFIG, иначе обнуление не измерить')
  } finally {
    scene.dispose()
  }
})

acheck('карточка Ultra выбираемая: без пометки «скоро» и без aria-disabled; Pro остаётся «скоро»', async () => {
  const scene = makeSettingsScene()
  try {
    scene.requireReal('готовность Ultra к выбору в настройках')
    const ultra = scene.card('ultra')
    const pro = scene.card('pro')
    assert.ok(ultra, 'в #editionChoices нет карточки «onlyone Ultra»')
    assert.ok(pro, 'в #editionChoices нет карточки «onlyone Pro»')
    assert.equal(ultra.getAttribute('aria-disabled'), null,
      `карточка Ultra помечена aria-disabled=«${ultra.getAttribute('aria-disabled')}»: оболочка 9.2 в дереве, Ultra выбираемая версия, а не «скоро»`)
    assert.equal(scene.soonOf(ultra), false,
      `на карточке Ultra осталась пометка «скоро» («${norm(ultra.textContent).slice(0, 70)}») — версия открыта, пометку снимать в карточке`)
    assert.equal(pro.getAttribute('aria-disabled'), 'true',
      'Pro стал доступен выбору: по поручению 29.09 Pro остаётся «скоро» и не выбирается')
    assert.equal(scene.soonOf(pro), true, 'с карточки Pro пропала пометка «скоро»')
  } finally {
    scene.dispose()
  }
})

acheck('выбранная карточка отражает versionPreset из конфигурации, а не приватный ключ окна', async () => {
  // Версию мог выставить чат (пункт 7.2) — настройка обязана это показать.
  const fromConfig = makeSettingsScene({ config: { versionPreset: 'ultra' }, edition: 'default' })
  try {
    fromConfig.requireReal('отражение текущей версии в карточках настроек')
    assert.equal(fromConfig.checked('ultra'), 'true',
      'конфигурация уже «ultra», а карточка Ultra не помечена выбранной (aria-checked=«' +
      fromConfig.checked('ultra') + '»): настройка читает свои воспоминания вместо состояния')
    assert.equal(fromConfig.checked('default'), 'false',
      'при versionPreset «ultra» выбранной осталась карточка «onlyone»')
    const marks = fromConfig.cards().map(el => classesOf(el).slice().sort().join(' '))
    assert.ok(new Set(marks).size > 1, `классы всех карточек одинаковы (${marks[0] || '(без классов)'}) — выбранную версию человек не видит`)
  } finally {
    fromConfig.dispose()
  }

  // Обратный случай: память прежних карточек больше не ведёт экран.
  const memory = makeSettingsScene({ edition: 'ultra' })
  try {
    memory.requireReal('отказ от второго источника истины')
    assert.equal(memory.checked('ultra'), 'false',
      `карточка Ultra помечена выбранной по ключу localStorage «onlyone.edition», хотя конфигурация ещё «default» — остался второй выключатель экрана`)
  } finally {
    memory.dispose()
  }

  // Смена версии вне настроек (чат, примерка) видна в настройках после
  // перерисовки — тот же канал чтения, что при запуске.
  const live = makeSettingsScene()
  try {
    live.requireReal('перечитывание версии из моста')
    await live.bridgeSet({ versionPreset: 'ultra' })
    live.rerender()
    assert.equal(live.checked('ultra'), 'true',
      'versionPreset записан в мост как «ultra», но карточка Ultra в настройках не стала выбранной')
    assert.equal(live.calls.setUiConfig.length, 1, `настройка сама позвала setUiConfig ${live.calls.setUiConfig.length} раз при перерисовке — перерисовка писать не вправе`)
  } finally {
    live.dispose()
  }
})

acheck('клик по Ultra пишет versionPreset через setUiConfig (7.1) и сохраняет чужие поля конфигурации', async () => {
  const scene = makeSettingsScene()
  try {
    scene.requireReal('запись выбранной версии через мост')
    const before = scene.rootSnapshot()
    await scene.click('ultra')
    assert.deepEqual(scene.calls.errors, [],
      `настройки не приняли записанный config: ${scene.calls.errors.join(' | ')} — ui-config.validate отвергает неизвестные поля и значения вне границ`)
    assert.equal(scene.calls.setUiConfig.length, 1,
      `после клика по Ultra мост получил ${scene.calls.setUiConfig.length} вызовов setUiConfig вместо одного — выбор версии идёт через setUiConfig (7.1)`)
    const sent = scene.calls.setUiConfig[0] || {}
    assert.equal(sent.versionPreset, 'ultra', `в мост ушёл versionPreset=«${sent.versionPreset}» вместо «ultra»`)
    const absent = SETTINGS_FIELDS.filter(name => sent[name] === undefined)
    assert.deepEqual(absent, [],
      `в мост ушёл config без ${absent.join(', ')}: ui-config.save в main.js добивает отсутствующие поля из DEFAULT, а не из профиля — ширины, шрифты и порядок панелей потерялись бы`)
    const drift = SETTINGS_FIELDS
      .filter(name => name !== 'versionPreset')
      .filter(name => !sameValue(scene.stored()[name], scene.start[name]))
    assert.deepEqual(drift, [],
      `записав версию, настройки обнулили чужие поля: ${drift.map(name => `${name} стал «${JSON.stringify(scene.stored()[name])}» вместо «${JSON.stringify(scene.start[name])}»`).join(', ')}`)
    assert.equal(scene.stored().versionPreset, 'ultra', 'профиль так и не принял «ultra» — кликнули по карточке, а записали мимо')
    const foreign = scene.foreign(before)
    assert.deepEqual(foreign.vars, [],
      `клик по карточке завёл новые CSS-переменные на корне: ${foreign.vars.join(', ')} — панели уже выключаются --sidebar-display и --work-panel-display`)
    assert.deepEqual(foreign.attrs, [],
      `клик по карточке завёл на корне новый выключатель: ${foreign.attrs.join(', ')} — экран выбирается значением versionPreset`)
  } finally {
    scene.dispose()
  }
})

acheck('возврат на onlyone — тот же клик по карточке «onlyone», тоже через мост', async () => {
  const scene = makeSettingsScene()
  try {
    scene.requireReal('возврат на обычную версию')
    await scene.click('ultra')
    await scene.click('default')
    const sent = scene.calls.setUiConfig[scene.calls.setUiConfig.length - 1]
    assert.ok(sent, 'после клика по карточке «onlyone» мост так ничего и не получил')
    assert.equal(sent.versionPreset, 'default', `возврат записал versionPreset=«${sent.versionPreset}» вместо «default»`)
    assert.equal(scene.stored().versionPreset, 'default', 'в профиле осталась «ultra» — обычный вид не вернётся')
    const drift = SETTINGS_FIELDS
      .filter(name => name !== 'versionPreset')
      .filter(name => !sameValue(scene.stored()[name], scene.start[name]))
    assert.deepEqual(drift, [], `возврат обнулил чужие поля конфигурации: ${drift.join(', ')}`)
    assert.equal(scene.checked('default'), 'true', 'после возврата карточка «onlyone» не помечена выбранной')
    assert.equal(scene.checked('ultra'), 'false', 'после возврата карточка Ultra осталась помеченной выбранной')
  } finally {
    scene.dispose()
  }
})

acheck('Pro не выбирается: клик по Pro не пишет в мост и не меняет версию', async () => {
  const scene = makeSettingsScene()
  try {
    scene.requireReal('запрет выбора Pro')
    const before = scene.rootSnapshot()
    await scene.click('pro')
    assert.deepEqual(scene.calls.setUiConfig, [],
      `клик по Pro дернул мост ${scene.calls.setUiConfig.length} раз: ${JSON.stringify(scene.calls.setUiConfig[0])} — Pro по поручению 29.09 не выбирается`)
    assert.equal(scene.stored().versionPreset, 'default', 'профиль принял версию от клика по Pro')
    assert.equal(scene.checked('pro'), 'false', 'Pro помечен выбранной карточкой')
    const foreign = scene.foreign(before)
    assert.deepEqual([foreign.vars, foreign.attrs], [[], []],
      `клик по Pro тронул корень: переменные ${foreign.vars.join(', ')}, признаки ${foreign.attrs.join(', ')}`)
  } finally {
    scene.dispose()
  }
})

acheck('карточки настроек переведены: в английской сцене ни одной русской строки, каждая — через t()', async () => {
  const en = makeSettingsScene({ lang: 'en' })
  try {
    en.requireReal('английские карточки версии')
    assert.ok(en.keys.length >= 3, `карточки позвали t() ${en.keys.length} раз — подписи рисуются мимо перевода`)
    const stray = []
    for (const el of en.cards()) {
      for (const text of [norm(el.textContent), norm(el.getAttribute('aria-label'))]) {
        if (/[а-яё]/i.test(text)) stray.push(text.slice(0, 60))
      }
    }
    assert.deepEqual([...new Set(stray)], [], `в английских карточек остались русские строки: ${[...new Set(stray)].join(' | ')}`)
    const missing = [...new Set(en.keys.map(one => one.key))]
      .filter(key => /[а-яё]/i.test(key) && !(key in DICT))
    assert.deepEqual(missing, [], `без английской пары: ${missing.slice(0, 6).join(' | ')} — правило: каждая новая строка через t() с парой в i18n.js`)
  } finally {
    en.dispose()
  }
})

async function runAsyncChecks () {
  for (const [name, fn] of asyncChecks) {
    total++
    try {
      await fn()
      console.log('  ok  ' + name)
    } catch (error) {
      failed++
      console.error('ПРОВАЛ [' + name + ']: ' + ((error && error.message) || error))
    }
  }
}

// Синхронные проверки оболочки уже отработали выше; карточки настроек меряются
// асинхронно (обработчик клика вправе ждать мост), поэтому итог печатается
// после них — иначе счёт разошёлся бы с напечатанным.
runAsyncChecks().then(() => {
  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed) {
    console.log(fs.existsSync(MODULE_PATH)
      ? `КРАСНЫХ проверок: ${failed} — оболочка в дереве есть, но не проходит правки приёмки 29.09 (живой фон, колонка Sessions, перевод, лишний хром), выбор Ultra в настройках (9.2 остаток) и «Задачи» свободным блоком (U-2)`
      : `Красных проверок: ${failed} — оболочки Ultra в дереве ещё нет (пункт 9.2), так и задумано`)
  }
  process.exitCode = failed ? 1 : 0
}).catch(error => {
  console.error('ПРОВАЛ [набор карточек настроек]: ' + ((error && error.message) || error))
  process.exitCode = 1
})
