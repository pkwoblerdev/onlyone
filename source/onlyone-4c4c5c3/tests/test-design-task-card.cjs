// Карточка задачи Дизайна в ленте чата.
//
// Тест написан ДО кода: модуля `src/renderer/design-task-card.js` ещё нет, и
// весь набор красный по этой причине. Так и задумано — разработчик и ведущий
// перекрашивают его, ничего здесь не печатая.
//
// Приём тот же, что в `tests/test-artifact-panel-gallery.cjs`: модуль
// подключается настоящий (`require`), а вокруг него — самодельный DOM,
// внедряемые `deps` и `check(name, fn)`. Копию модуля в тест не переносим:
// копия устарела бы в тот же вечер, и проверка начала бы воспроизводить сама
// себя. Проверяется наблюдаемое поведение (что видно в ленте, какой адрес у
// кадра, куда уходит клик), а не способ, каким модуль строит узлы: карточку
// можно собрать и `createElement`, и `innerHTML`, заглушка разбирает и то и то.
//
// Контракт, зафиксированный ведущим:
//   `OnlyoneDesignTaskCard.create(deps)`, deps — минимум
//   `{ $, t, escapeHtml, electronAPI, document, openDesign }`;
//   возврат — замороженный объект с `{ renderTaskCard, updateTaskCard,
//   onDesignTaskEvent, clearTaskCards }`;
//   событие прогресса `{ chatId, taskId, designId, component, version,
//   status: 'running' | 'ready' | 'failed', error?, brief? }`.
//
// Чего в контракте нет и что тест добавляет сам (об этом сказано в докладе):
// чтобы отличить «свой» диалог от чужого, модуль должен знать, какой чат
// сейчас открыт. Харнесс даёт это тремя способами на выбор — `deps.currentChatId`,
// `deps.getChatId()` и атрибут `data-chat-id` на самой ленте, — и провал
// говорит об этом прямым текстом, а не молчит.
//
// Изоляция кадра проверяется буквально: `sandbox` обязан равняться
// `allow-scripts` и НЕ содержать `allow-same-origin`, и модуль не имеет права
// подписываться на `message`, то есть читать содержимое кадра.
//
// Здесь же блок проверок, что превью готовой правки не мигает пустотой. Та же
// версия — кадр не перезапускается; сменилась — новая грузится ВТОРЫМ узлом и
// подменяет первый по своему `load`; пока `load` не пришёл, на экране остаётся
// прежний загруженный кадр. Меряется это наблюдаемым DOM (`frameWatch`,
// `settle`, `isShownFrame`) — как именно, описано над ними. Оконная половина
// того же требования — ожидание `load` перед снимком в
// `tests/design-edit-turn-renderer.js`.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CARD_SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'design-task-card.js')
const CONTRACT_METHODS = ['renderTaskCard', 'updateTaskCard', 'onDesignTaskEvent', 'clearTaskCards']

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

// --- самодельный DOM -----------------------------------------------------------
//
// Разметка карточки собирается модулем — здесь только лента чата, в которую она
// приходит. `contains`, `querySelector` и разбор `innerHTML` нужны затем, чтобы
// искать карточку по её тексту, а не по имени узла, которого ещё нет.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'use', 'stop'])
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'selected', 'multiple', 'readonly'])
// У этих имён в заглушке есть свои геттеры — зеркалить атрибут в свойство нельзя,
// иначе setAttribute('id', ...) вызовет сеттер id и проверка уйдёт в рекурсию.
const NO_MIRROR = new Set(['id', 'class', 'classname', 'textcontent', 'innerhtml', 'children', 'childnodes', 'dataset', 'style'])

const decodeEntities = text => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function makeDom () {
  const makeText = text => ({ nodeType: 3, textContent: String(text), parentNode: null })

  let document = null

  function detach (node) {
    const parent = node.parentNode
    if (!parent) return
    const index = parent._nodes.indexOf(node)
    if (index >= 0) parent._nodes.splice(index, 1)
    node.parentNode = null
    node.parentElement = null
    // Снятый с экрана фокус в настоящем браузере уходит на <body>. Заглушка
    // обязана вести себя так же, иначе проверка «обновление не сбрасывает
    // фокус» была бы зелёной сама по себе.
    if (document && nodeContains(document.activeElement, node)) document.activeElement = document.body
  }

  function adopt (parent, node) {
    detach(node)
    node.parentNode = parent
    if (parent.nodeType === 1) node.parentElement = parent
    parent._nodes.push(node)
    return node
  }

  function clear (node) {
    for (const child of node._nodes.slice()) detach(child)
  }

  function textOf (node) {
    return node._nodes.map(child => (child.nodeType === 3 ? child.textContent : textOf(child))).join('')
  }

  function serialize (node) {
    return node._nodes.map(child => {
      if (child.nodeType === 3) return child.textContent
      const attrs = [...child._attrs.entries()].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('')
      return `<${child.tagName.toLowerCase()}${attrs}>${serialize(child)}</${child.tagName.toLowerCase()}>`
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
    if (!/^[#.[\w]/.test(compound)) return false
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
    const walk = node => {
      for (const child of node._nodes) {
        if (child.nodeType === 1) { out.push(child); walk(child) }
      }
    }
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

  function matchChain (el, chain) {
    let index = chain.length - 1
    let current = el
    while (index >= 0) {
      if (!current || current.nodeType !== 1 || !matchCompound(current, chain[index])) return false
      current = current.parentElement
      index--
    }
    return true
  }

  function queryAll (root, selector) {
    const out = []
    for (const group of String(selector).split(',')) {
      const chain = group.trim().split(/\s+/).filter(Boolean)
      if (!chain.length) continue
      for (const el of descendants(root)) {
        if (matchChain(el, chain) && !out.includes(el)) out.push(el)
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
      if (BOOLEAN_ATTRS.has(name) && match[2] === undefined && match[3] === undefined && match[4] === undefined) {
        el[name] = true
        el._attrs.set(name, '')
        continue
      }
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
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tagName === closing) { stack.length = i; break }
        }
        continue
      }
      const el = createElement(match[2])
      applyAttrs(el, match[3])
      push(el)
      const selfClosed = match[4] === '/' || VOID_TAGS.has(el.tagName.toLowerCase())
      if (!selfClosed) stack.push(el)
    }
    const tail = String(source).slice(last)
    if (tail) push(makeText(decodeEntities(tail)))
    return out
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
      value: '',
      addEventListener (type, fn) { el._listeners.push({ type, fn }) },
      removeEventListener (type, fn) {
        const index = el._listeners.findIndex(item => item.type === type && item.fn === fn)
        if (index >= 0) el._listeners.splice(index, 1)
      },
      appendChild (node) { return adopt(el, node) },
      append (...nodes) { for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      insertBefore (node, before) {
        adopt(el, node)
        const index = el._nodes.indexOf(before)
        if (index >= 0) { el._nodes.splice(el._nodes.indexOf(node), 1); el._nodes.splice(index, 0, node) }
        return node
      },
      replaceChildren (...nodes) { clear(el); for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
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
      getBoundingClientRect () { return { left: 8, top: 8, right: 108, bottom: 38, width: 100, height: 30 } },
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
      click () { fireClick(el) }
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
      className: {
        get () { return el.getAttribute('class') || '' },
        set (value) { el.setAttribute('class', String(value)) }
      },
      id: {
        get () { return el.getAttribute('id') || '' },
        set (value) { el.setAttribute('id', String(value)) }
      },
      classList: { get () { return classList(el) } }
    })
    return el
  }

  function fireClick (el) {
    const event = {
      type: 'click', target: el, currentTarget: el,
      preventDefault () {}, stopPropagation () { event._stopped = true }
    }
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

  const body = createElement('BODY')
  document = {
    body,
    activeElement: body,
    documentElement: createElement('HTML'),
    createElement,
    createTextNode: makeText,
    _messageSubs: [],
    addEventListener (type, fn, options) {
      if (type === 'message') document._messageSubs.push(String(fn && fn.name) || 'fn')
      if (type === 'message') body._listeners.push({ type, fn })
    },
    removeEventListener () {},
    querySelector (selector) { return queryAll(body, selector)[0] || null },
    querySelectorAll (selector) { return queryAll(body, selector) },
    contains (node) { return nodeContains(body, node) },
    getSelection () { return null }
  }

  // Лента того же вида, что в настоящем `index.html`: `#chatFeed` — экран
  // диалога, `#messagesList` — его лента, `#splitMessagesList` — лента второй
  // панели. Атрибут `data-chat-id` харнесс вешает сам: это один из трёх
  // способов, каким модуль может узнать, какой чат сейчас открыт.
  for (const node of parseHtml(
    '<div id="chatFeed" class="chat-feed"><div id="messagesList" class="messages-list" data-chat-id="чат-А"></div></div>' +
    '<div id="splitFeed" class="chat-feed"><div id="splitMessagesList" class="messages-list" data-chat-id="чат-Б"></div></div>'
  )) adopt(body, node)

  const byId = new Map()
  for (const el of descendants(body)) {
    const id = el.getAttribute('id')
    if (id && !byId.has(id)) byId.set(id, el)
  }

  return { body, document, createElement, descendants, textNodes, nodeContains, fireClick, byId }
}

// Подписки на `message` ловятся и со стороны глобального окна: модуль, который
// читает содержимое кадра, нарушает изоляцию независимо от того, каким из двух
// способов он подписался.
const globalAddEventListener = globalThis.addEventListener
let messageCapture = null
globalThis.addEventListener = function (type, fn, ...rest) {
  if (messageCapture && type === 'message') messageCapture.push('globalThis')
  return typeof globalAddEventListener === 'function' ? globalAddEventListener.call(this, type, fn, ...rest) : undefined
}

// --- модуль под тестом ----------------------------------------------------------

let designCard = null
let moduleLoadError = null
try {
  if (!fs.existsSync(CARD_SOURCE)) throw new Error('файл не найден')
  designCard = require(CARD_SOURCE)
} catch (error) {
  moduleLoadError = error
}

const NO_CONTRACT = 'НЕТ КОНТРАКТА'

const relativeSource = () => path.relative(path.join(__dirname, '..'), CARD_SOURCE).split(path.sep).join('/')
// Первая строка сообщения: у упавшего `require` это бывает весь стек.
const loadReason = () => String((moduleLoadError && (moduleLoadError.message || moduleLoadError)) || 'файл не найден').split('\n')[0]

function noContract (reason) {
  const api = {}
  for (const name of CONTRACT_METHODS) {
    api[name] = () => { throw new Error(NO_CONTRACT + ': ' + reason) }
  }
  return api
}

// Текст задачи, по которому в ленте ищется карточка: имена узлов намеренно не
// используются — требования говорят о том, что видит человек.
function marker (name) {
  return 'МИШЕНА-' + name
}

function task (over) {
  return Object.assign({
    chatId: 'чат-А',
    taskId: 'задача-1',
    designId: 'макет-42',
    component: 'Landing.dc.html',
    version: 1,
    status: 'running',
    brief: 'Собери страницу «' + marker('А1') + '» с тарифами'
  }, over)
}

const t = (text, ...args) => {
  let index = 0
  return String(text).replace(/%s/g, () => (index < args.length ? String(args[index++]) : '%s'))
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]))

// Сцена:DOM, внедряемые `deps`, вызов `create` и помощники поиска карточки.
// Каждая проверка получает свою сцену, чтобы события разных проверок не
// смешивались в одной ленте.
function makeScene (opts = {}) {
  const dom = makeDom()
  const currentChatId = opts.currentChatId || 'чат-А'
  const calls = { openDesign: [], designTask: [], bridge: [] }
  const electronAPI = {
    onDesignTaskEvent: callback => { calls.bridge.push(callback) },
    designTask: async payload => { calls.designTask.push(payload); return { ok: true } }
  }
  const openDesign = (...args) => { calls.openDesign.push(args) }

  const $ = id => {
    if (dom.byId.has(id)) return dom.byId.get(id)
    // Новый узел на неизвестный id: модуль вправе попросить элемент, которого в
    // разметке нет. Заглушка отдаёт его и помнит — проверка это увидит.
    const el = dom.createElement('div')
    el.setAttribute('id', id)
    dom.body.appendChild(el)
    dom.byId.set(id, el)
    return el
  }

  const deps = { $, t, escapeHtml, electronAPI, document: dom.document, openDesign, currentChatId, getChatId: () => currentChatId }

  messageCapture = []
  let api
  if (moduleLoadError) api = noContract(`модуль ${relativeSource()} не подключается: ${loadReason()}`)
  else if (!designCard || typeof designCard.create !== 'function') api = noContract('в модуле нет create(): отдаётся ' + typeof (designCard || {}).create)
  else {
    try {
      api = designCard.create(deps) || {}
    } catch (error) {
      api = noContract('create() бросила исключение: ' + (error && error.message))
    }
  }
  const missing = CONTRACT_METHODS.filter(name => typeof api[name] !== 'function')
  const wrapped = api
  if (missing.length) {
    api = noContract('у возвращённого create() объекта нет ' + missing.join(', ') + '; есть только: ' +
      Object.keys(wrapped).join(', '))
  }
  // Подписки на `message` собираются с двух сторон: модуль может сесть на
  // внедряемый `document` или на глобальное окно (в браузере это одно и то же).
  const subs = [...messageCapture, ...dom.document._messageSubs.map(() => 'document')]
  messageCapture = null

  const FEED_IDS = new Set(['messagesList', 'splitMessagesList', 'chatFeed', 'splitFeed'])
  const isFeed = el => Boolean(el) && el.nodeType === 1 &&
    (FEED_IDS.has(el.getAttribute('id') || '') || (el.getAttribute('class') || '').split(/\s+/).includes('messages-list'))

  // Карточка = узел, добавленный в ленту (или в <body>): самый верхний предок
  // текста задачи, чей родитель — лента или <body>. Так подсчёт не зависит от
  // того, сколько вложенных span внутри карточки нарисовал модуль.
  function cardRoots (token) {
    const roots = new Set()
    for (const node of dom.textNodes(dom.body)) {
      if (!String(node.textContent).includes(token)) continue
      let el = node.parentNode
      if (!el || el === dom.body) continue
      while (el.parentNode && el.parentNode !== dom.body && !isFeed(el.parentNode)) el = el.parentNode
      roots.add(el)
    }
    return [...roots]
  }

  const describe = list => list.length
    ? list.map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180)).join(' || ')
    : '(ни одной карточки в ленте)'

  return {
    dom, api, deps, calls, subs, currentChatId, cardRoots, describe,
    // Одна карточка по маркеру задачи; если их несколько — провал с перечнем.
    card (token) {
      const list = cardRoots(token)
      if (list.length !== 1) throw new Error(`карточка задачи «${token}» найдена в количестве ${list.length} штук вместо одной: ${this.describe(list)}`)
      return list[0]
    },
    has (token) { return cardRoots(token).length > 0 },
    textIn (root) { return String(root.textContent || '').replace(/\s+/g, ' ').trim() },
    feedOf (cardEl) { return cardEl.parentElement },
    frames (cardEl) { return dom.descendants(cardEl).filter(el => el.tagName === 'IFRAME') }
  }
}

// Кнопка «Открыть в Дизайне»: ищется по доступному имени, а не по классу —
// имён узлов в контракте нет.
function openButton (scene, cardEl) {
  const named = el => [el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('data-tooltip') || ''].join(' ')
  return scene.dom.descendants(cardEl)
    .filter(el => el.tagName === 'BUTTON')
    .find(el => /откры[ть].*дизайн|в дизайн/i.test(named(el))) || null
}

function sourceText () {
  if (moduleLoadError) throw new Error(NO_CONTRACT + ': исходник модуля не читается — ' + loadReason())
  return fs.readFileSync(CARD_SOURCE, 'utf8')
}

// «Свежий» параметр адреса: любой запрос, который меняет вид кадра при новой
// версии. Имя pinned-контрактом не задан (`?v=` или аналог), поэтому допускается
// любая пара ключа со значением, где ключ похож на версию/метку времени.
function freshParam (url) {
  const query = String(url).split('?')[1] || ''
  if (!query) return null
  const pairs = query.split(/[&;]/).map(part => part.split('=')[0]).filter(Boolean)
  return pairs.find(key => /^(v|version|ver|ts|t|nonce|cache|rev)$/i.test(key)) || null
}

function versionShown (text, version) {
  return new RegExp(`верси[яи]\\D{0,3}${version}\\b|\\bv\\.?\\s*${version}\\b|\\b${version}\\s*(?:-я|я)?\\s*верси`, 'i').test(String(text))
}

// Имя компонента в адресе могло быть закодировано, а `%` в нём приходит из
// текста задачи: декодер не должен ронять проверку на битой последовательности.
function decodeSrc (url) {
  try { return decodeURIComponent(String(url)) } catch { return String(url) }
}

// --- превью готовой правки: кадр не мигает ------------------------------------
//
// Карточка готовой правки попадала в снимок с пустым превью. Причина в
// продукте, а не в прогоне: на `ready` модуль снимал прежний `<iframe>` и тут
// же вставлял новый с новым адресом — до того, как новый документ успевал
// загрузиться. Миг пустого прямоугольника видит человек, оконный прогон просто
// успевает его снять.
//
// Требование: «на `ready` превью не перезагружается, если версия не сменилась;
// если сменилась — новая версия грузится во второй кадр и подменяет первый по
// его `load`. Прогон ждёт `load`».
//
// Имен внутри модуля эти проверки не требуют — только наблюдаемого DOM:
//   • узел кадра переживает событие с прежней версией: тот же объект, тот же
//     адрес, ни одной новой записи `src`, счётчик созданных `<iframe>` не растёт;
//   • новый адрес грузится ВТОРЫМ узлом, а прежний остаётся на экране;
//   • подмена происходит по событию `load` нового узла. Это стандартный DOM, а
//     не имя: `addEventListener('load', …)` или `onload` на самом кадре (приём
//     уже есть в продукте — `src/renderer/artifact-panel.js:439`). Пока подписки
//     нет, харнесс не может сделать вид, что страница загрузилась: показанный
//     кадр остаётся незагруженным, и проверка говорит об этом прямым текстом, а
//     не проходит, додумав загрузку за модуль.
//   • «спрятан» читается четырьмя способами, принятыми в проекте (в `index.css`
//     ровно так же: `.design-preview-frame[hidden] { display: none }`): `hidden`,
//     `style.display:none`, `style.visibility:hidden`, `style.opacity:0`.
//
// Счётчик кадров снимается с внедряемого `deps.document.createElement`, а не из
// нутра модуля: если реализатор соберёт кадр через `innerHTML`, счётчик останется
// нулевым — тогда те же требования держат проверка «узел тот же» и «адрес не
// переустанавливался», а счётчик требует лишь не расти.

function srcOf (frame) {
  if (!frame) return ''
  // Адрес могли назначить и `setAttribute('src', …)`, и свойством `.src`:
  // в заглушке это разные места (`_attrs` и свойство), поэтому свойство вперёд.
  return String(frame.src || frame.getAttribute('src') || '')
}

// Значение «свежего» параметра, а не только его имя (имя знает `freshParam`).
// Смена версии обязана менять именно значение, иначе браузер отдал бы прежний
// снимок из кэша.
function freshValue (url) {
  const query = String(url).split('?')[1] || ''
  for (const part of query.split(/[&;]/)) {
    const split = part.indexOf('=')
    const key = split < 0 ? part : part.slice(0, split)
    if (/^(v|version|ver|ts|t|nonce|cache|rev)$/i.test(key)) return decodeSrc(split < 0 ? '' : part.slice(split + 1))
  }
  return null
}

function isHiddenNode (el) {
  if (!el) return false
  // `hidden === ''` — след `setAttribute('hidden', '')` в заглушке (свойство
  // зеркалится строкой); в настоящем DOM там был бы `true`.
  if (el.hidden === true || el.hidden === '') return true
  const style = el.style || {}
  if (style.display === 'none' || style.visibility === 'hidden') return true
  if (String(style.opacity) === '0') return true
  return false
}

// Кадр показан, если не спрятан он сам и ни один предок (превью-контейнер
// модуль прячет вместе с кадром).
function isShownFrame (frame) {
  let el = frame
  while (el) { if (isHiddenNode(el)) return false; el = el.parentNode }
  return true
}

function loadHandlers (frame) {
  const found = (frame._listeners || []).filter(item => item.type === 'load')
  if (typeof frame.onload === 'function') found.push({ fn: frame.onload })
  return found
}

// Любое стандартное событие на узел: отдаётся ровно тем подпискам, что есть.
// Здесь это нужно для `error`, где подписки может и не быть — отказ загрузиться
// требованием не является, проверять надо поведение после него.
function dispatchOn (frame, type) {
  if (!frame) return 0
  const event = { type, target: frame, currentTarget: frame }
  let sent = 0
  for (const item of (frame._listeners || []).filter(entry => entry.type === type)) { sent++; item.fn(event) }
  const inline = frame['on' + type]
  if (typeof inline === 'function') { sent++; inline(event) }
  return sent
}

// Подмену кадра реализатор вправе отложить на следующий кадр — в окне это
// `requestAnimationFrame`. В node его нет, и тогда проверка краснела бы на
// пустом месте (ReferenceError вместо поведения), поэтому харнесс даёт свой
// следующий кадр: таймер на 16 мс, тот же порядок, что в браузере.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16)
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
}

// Наблюдение за кадрами одной сцены: счётчик созданных `<iframe>`, записи `src`
// по каждому узлу, «какие узлы харнесс считает загруженными» (те, на которых он
// послал `load`) и помощник «браузер докачал, что умел».
function frameWatch (scene) {
  const doc = scene.dom.document
  const created = []
  const loaded = new WeakSet()
  const originalCreate = doc.createElement
  doc.createElement = function (tagName) {
    const el = originalCreate.call(doc, tagName)
    if (String(tagName).toLowerCase() !== 'iframe') return el
    const writes = []
    const wrappedSet = el.setAttribute
    let mirroring = false
    el.setAttribute = function (name, value) {
      const isSrc = String(name).toLowerCase() === 'src'
      if (isSrc) { writes.push(String(value)); mirroring = true }
      try { return wrappedSet.call(el, name, value) } finally { if (isSrc) mirroring = false }
    }
    let current = ''
    Object.defineProperty(el, 'src', {
      configurable: true,
      enumerable: true,
      get () { return current },
      set (value) { current = String(value); if (!mirroring) writes.push(current) }
    })
    created.push({ node: el, writes })
    return el
  }

  const inCard = root => scene.dom.descendants(root).filter(el => el.tagName === 'IFRAME')
  const entry = node => created.find(item => item.node === node) || { writes: [] }

  const watch = {
    created,
    loaded,
    count: () => created.length,
    writesOf: node => entry(node).writes,
    framesIn: inCard,
    shown: root => inCard(root).filter(isShownFrame),
    // «Браузер» докачивает всё, что умеет услышать: для каждого узла с подпиской
    // на `load` посылается событие, модулю отдаются микрозадачи и цикл таймеров
    // (подмена могла стоять в `requestAnimationFrame`). Возвращает узлы, которые
    // стоят в DOM, не загружены и подписки на `load` не имеют: их нечем
    // «докачать», и именно они предмет претензии.
    async settle (root) {
      const deaf = []
      for (let round = 0; round < 3; round++) {
        let fired = 0
        for (const frame of inCard(root)) {
          if (loaded.has(frame)) continue
          const handlers = loadHandlers(frame)
          if (!handlers.length) { if (!deaf.includes(frame)) deaf.push(frame); continue }
          loaded.add(frame)
          for (const item of handlers) item.fn({ type: 'load', target: frame, currentTarget: frame })
          fired++
        }
        if (!fired) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return deaf
    }
  }
  return watch
}

const NO_LOAD_SUBSCRIPTION = 'модуль не слушает `load` ни на одном кадре: подменить прежний кадр новым ' +
  'по загрузке нечем, и на экране остаётся узел с недогруженным документом (это и есть Н96). ' +
  'Нужна подписка на самом кадре — `addEventListener(\'load\', …)` или `onload` ' +
  '(образец в продукте: src/renderer/artifact-panel.js:439)'

// Сравнение узлов: `assert.equal` на DOM-объектах печатает весь узел с предками,
// и провал тонул бы в полмегабайта дампа вместо одной строки про Н96.
function assertSameNode (actual, expected, message) {
  assert.ok(actual === expected,
    `${message} (ожидался узел «${srcOf(expected)}», а показан «${srcOf(actual)}» — разные узлы)`)
}

// --- проверки ------------------------------------------------------------------

async function main () {
  await check('модуль design-task-card существует и отдаёт create с обещанными методами', async () => {
    assert.ok(!moduleLoadError,
      `${NO_CONTRACT}: src/renderer/design-task-card.js не подключается (${moduleLoadError && loadReason()}) — ` +
      'дальше все проверки красные по той же причине')
    assert.equal(typeof designCard, 'object', 'модуль возвращает не объект')
    assert.equal(typeof designCard.create, 'function', 'в модуле нет create(deps)')
    const scene = makeScene()
    for (const name of CONTRACT_METHODS) {
      assert.equal(typeof scene.api[name], 'function', `у возвращённого create() объекта нет метода ${name}`)
    }
    assert.equal(Object.isFrozen(scene.api), true,
      'результат create() не заморожен — окно правит карточку из app.js, а не из модуля (образец: artifact-panel.js)')
  })

  await check('состояние «идёт»: карточка видна, есть текст ожидания, превью-кадра ещё нет', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    const cards = scene.cardRoots(marker('А1'))
    assert.equal(cards.length, 1, `карточка «идёт» найдена в количестве ${cards.length}: ${scene.describe(cards)}`)
    const text = scene.textIn(cards[0])
    assert.ok(/ожид|жд[её]м|ид[её]т\s|собир|созда|формир|печат|работ/i.test(text),
      `в карточке «идёт» нет ни одного слова о том, что работа идёт и её надо подождать: «${text}»`)
    assert.equal(scene.frames(cards[0]).length, 0,
      `пока задача не готова, показывать нечего, а кадр уже в карточке: ${scene.frames(cards[0]).map(f => f.getAttribute('src')).join(', ')}`)
  })

  await check('состояние «готово»: кадр onecode-design://<designId>/<component> с «свежим» параметром', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 1 }))
    const card = scene.card(marker('А1'))
    const frames = scene.frames(card)
    assert.equal(frames.length, 1, `кадров в карточке ${frames.length} вместо одного: ${scene.describe([card])}`)
    const src = String(frames[0].getAttribute('src') || '')
    assert.ok(src.startsWith('onecode-design://макет-42/'),
      `адрес кадра начинается не со схемы дизайна своего макета: «${src}» (ждём onecode-design://макет-42/…)`)
    assert.ok(decodeSrc(src).includes('Landing.dc.html'),
      `в адресе кадра нет имени компонента Landing.dc.html: «${src}»`)
    assert.ok(freshParam(src), `в адресе кадра нет «свежего» параметра (?v= или аналог): «${src}»`)
  })

  await check('кадр карточки изолирован: sandbox ровно allow-scripts, без allow-same-origin', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    const card = scene.card(marker('А1'))
    const frames = scene.frames(card)
    assert.equal(frames.length, 1, `кадра в готовой карточке нет: ${scene.describe([card])}`)
    const sandbox = String(frames[0].getAttribute('sandbox') || '')
    assert.equal(sandbox, 'allow-scripts',
      `sandbox кадра обязан быть буквально «allow-scripts» (как в index.html:728), а он «${sandbox}» — ` +
      'без allow-same-origin, иначе макет модели попадёт в Origin окна')
  })

  await check('модуль не читает содержимое кадра: ни одного слушателя message', async () => {
    const scene = makeScene()
    scene.api.renderTaskCard(task({ status: 'ready' }))
    scene.api.updateTaskCard(task({ status: 'ready', version: 2 }))
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 3 }))
    const card = scene.card(marker('А1'))
    const frame = scene.frames(card)[0]
    assert.ok(frame, 'проверка изоляции слепнет без кадра: готовая карточка его не показала')
    assert.equal(frame.onmessage, undefined, `у кадра задан обработчик onmessage (${String(frame.onmessage)})`)
    assert.equal(frame._listeners.filter(item => item.type === 'message').length, 0,
      'модуль подписал message на сам кадр')
    assert.equal(scene.subs.length, 0,
      `модуль подписался на сообщения окна (${scene.subs.join(', ')}) — читать, что внутри кадра, он не имеет права`)
  })

  await check('состояние «ошибка»: видна причина, кадра нет, карточка не удалена и не «успешна»', async () => {
    const scene = makeScene()
    const error = 'Runtime-проверка Design: макет не открылся'
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    scene.api.onDesignTaskEvent(task({ status: 'failed', error }))
    const cards = scene.cardRoots(marker('А1'))
    assert.equal(cards.length, 1, `после отказа карточка должна остаться в ленте, а их ${cards.length}: ${scene.describe(cards)}`)
    const text = scene.textIn(cards[0])
    assert.ok(text.includes('Runtime-проверка Design'), `причина отказа не показана текстом события: «${text}»`)
    assert.equal(scene.frames(cards[0]).length, 0, `на отказе кадр показывать нечего: ${scene.describe(cards)}`)
    // «Не готов» — это про отказ, а не обещание успеха: отрицание снимается
    // перед сравнением, иначе честная карточка краснела бы на слове «готов».
    const positive = text.replace(/не\s+(будет\s+)?готов\w*/gi, '')
    assert.equal(/готов|успешн/i.test(positive), false, `отказанная задача названа выполненной: «${text}»`)
    assert.match(text, /ошибк|отказ|не вышло|не удал|не собрал|не получит|не сделан|сорв|не прош|прерван|слом|проблем|останов|стоп/i,
      `отказ не назван отказом ни одним понятным словом: «${text}»`)
  })

  await check('на отказе карточка не предлагает открыть макет, которого нет', async () => {
    // Отказанная задача может нести design_id из просьбы (человеку важно видеть,
    // О ЧЁМ речь), но открывать в разделе Дизайна нечего: кнопка, которая ведёт
    // в пустоту, хуже отсутствия кнопки.
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    scene.api.onDesignTaskEvent(task({ status: 'failed', error: 'Дизайна «net-takogo» нет в реестре' }))
    const card = scene.cardRoots(marker('А1'))[0]
    assert.ok(card, 'карточка отказа должна оставаться в ленте')
    const openers = [...card.querySelectorAll('button')].filter(node =>
      /откры/i.test(scene.textIn(node)) && /дизайн/i.test(scene.textIn(node)))
    assert.ok(openers.length <= 1, `слишком много предложений открыть макет: ${openers.length}`)
    const visible = openers.filter(node => {
      let el = node
      while (el && el !== card) { if (el.hidden === true) return false; el = el.parentElement }
      return card.hidden !== true
    })
    assert.deepEqual(visible.map(node => scene.textIn(node)), [],
      'на отказе предложение «Открыть в Дизайне» доступно — вести оно некуда')
  })

  await check('пока работа идёт, перехода в Дизайн тоже нет: открывать нечего', async () => {
    // Событие `running` уже несёт design_id (движок заводит проект до записи
    // страницы), и по этому признаку кнопка появлялась до того, как макет
    // существует: клик в этот момент открывал пустое рабочее место.
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    const card = scene.cardRoots(marker('А1'))[0]
    assert.ok(card, 'карточка «идёт» обязана быть в ленте')
    const openers = [...card.querySelectorAll('button')].filter(node =>
      /откры/i.test(scene.textIn(node)) && /дизайн/i.test(scene.textIn(node)))
    const available = openers.filter(node => {
      let el = node
      while (el && el !== card) { if (el.hidden === true || el.disabled === true) return false; el = el.parentElement }
      return card.hidden !== true
    })
    assert.deepEqual(available.map(node => scene.textIn(node)), [],
      `предложение открыть макет доступно до готовности: ${available.length}`)
    // И на «готово» оно обязано вернуться — иначе проверка выше просто слепая.
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    const ready = scene.cardRoots(marker('А1'))[0]
    const back = [...ready.querySelectorAll('button')].filter(node =>
      /откры/i.test(scene.textIn(node)) && /дизайн/i.test(scene.textIn(node)) && node.disabled !== true)
    assert.equal(back.length, 1, `на готовой карточке кнопки перехода не нашлось (${back.length})`)
  })

  await check('повторное событие с тем же taskId обновляет ту же карточку, а не добавляет вторую', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    const before = scene.cardRoots(marker('А1'))
    assert.equal(before.length, 1, `после «идёт» карточек ${before.length}: ${scene.describe(before)}`)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    const after = scene.cardRoots(marker('А1'))
    assert.equal(after.length, 1,
      `событие по той же задаче добавило вторую карточку: было ${before.length}, стало ${after.length} — ${scene.describe(after)}`)
    assert.equal(after[0], before[0],
      `карточка заменена новым узлом вместо обновления (текст: «${scene.textIn(after[0])}») — лента подпрыгнет на каждом событии`)
    assert.equal(scene.frames(after[0]).length, 1, 'после ready кадр так и не появился')
  })

  await check('обновление карточки не сбрасывает фокус с её кнопки', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    const card = scene.card(marker('А1'))
    const button = openButton(scene, card)
    assert.ok(button, `проверке фокуса не на что встать: кнопки «Открыть в Дизайне» в карточке нет — ${scene.textIn(card)}`)
    scene.dom.fireClick(button)
    button.focus()
    assert.equal(scene.dom.document.activeElement, button, 'харнесс не смог дать фокус кнопке')
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 4 }))
    const updated = scene.cardRoots(marker('А1'))
    assert.equal(updated.length, 1, `правка версии добавила вторую карточку: ${scene.describe(updated)}`)
    const active = scene.dom.document.activeElement
    assert.ok(active && updated[0].contains(active),
      `после обновления карточки фокус ушёл на ${active && active.tagName}: человек с клавиатуры потерял кнопку`)
  })

  await check('событие чужого диалога не попадает в ленту текущего', async () => {
    const scene = makeScene({ currentChatId: 'чат-А' })
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    const mine = scene.card(marker('А1'))
    const feed = scene.feedOf(mine)
    assert.ok(feed, `харнесс не смог определить ленту, в которой живёт карточка: ${scene.describe([mine])}`)
    scene.api.onDesignTaskEvent(task({
      taskId: 'задача-чужая', chatId: 'чат-Б', status: 'running',
      brief: 'Чужой разговор «' + marker('Б1') + '»'
    }))
    assert.equal(scene.textIn(feed).includes(marker('Б1')), false,
      `карточка чужого диалога нарисовалась в ленте текущего. Модуль обязан либо отбрасывать событие по ` +
      `deps.currentChatId (он передан: «${scene.currentChatId}», есть и deps.getChatId()), либо класть её ` +
      `в ленту своего чата — узлы #messagesList и #splitMessagesList помечены data-chat-id`)
    assert.equal(scene.cardRoots(marker('А1')).length, 1,
      'событие чужого диалога ещё и сбило карточку текущего')
  })

  // Два случая, которых проверка выше не касается: в них лента чужого разговора
  // в окне вообще не помечена, и остаётся только решить — рисовать или отбросить.
  // Без них фильтр «свой/чужой» не краснеет ни от какого мутанта.
  await check('чужое событие без своей ленты в окне не рисуется нигде', async () => {
    const scene = makeScene({ currentChatId: 'чат-А' })
    const other = scene.dom.byId.get('splitMessagesList')
    if (!other || typeof other.removeAttribute !== 'function') {
      throw new Error('харнесс не даёт снять метку чужой ленты — проверка стала бы слепой')
    }
    other.removeAttribute('data-chat-id')
    scene.api.onDesignTaskEvent(task({
      taskId: 'задача-чужая', chatId: 'чат-Б', status: 'running',
      brief: 'Чужой разговор «' + marker('Б2') + '»'
    }))
    assert.equal(scene.has(marker('Б2')), false,
      `карточка чужого диалога появилась в окне, где для неё нет ленты: ${scene.describe(scene.cardRoots(marker('Б2')))}`)
  })

  await check('своё событие не теряется, если ленты не помечены разговором', async () => {
    // Обратный мутант: фильтр, который считает чужим всё подряд, спрятал бы и
    // собственную карточку — молча, без единой ошибки в консоли.
    const scene = makeScene({ currentChatId: 'чат-А' })
    for (const id of ['messagesList', 'splitMessagesList']) {
      const node = scene.dom.byId.get(id)
      if (node && typeof node.removeAttribute === 'function') node.removeAttribute('data-chat-id')
    }
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    assert.equal(scene.cardRoots(marker('А1')).length, 1,
      `своё событие пропало: ${scene.describe(scene.cardRoots(marker('А1')))}`)
  })

  await check('кнопка «Открыть в Дизайне»: type="button", доступное имя, ровно один вызов openDesign', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    const card = scene.card(marker('А1'))
    const button = openButton(scene, card)
    assert.ok(button, `кнопки «Открыть в Дизайне» в готовой карточке нет: ${scene.textIn(card)}`)
    assert.equal(button.tagName, 'BUTTON', `действие нарисовано узлом ${button.tagName}, а не кнопкой`)
    assert.equal(button.getAttribute('type'), 'button',
      'у кнопки нет type="button": внутри формы это кнопка отправки, и Enter в поле её нажмёт')
    const name = (button.textContent || '').trim() || (button.getAttribute('aria-label') || '').trim()
    assert.ok(name.length > 3, `кнопка без доступного имени: ${scene.textIn(card)}`)
    scene.dom.fireClick(button)
    assert.equal(scene.calls.openDesign.length, 1,
      `клик вызвал openDesign ${scene.calls.openDesign.length} раз вместо одного`)
    const arg = scene.calls.openDesign[0] || []
    const passedId = [arg[0], arg[0] && arg[0].designId, arg[0] && arg[0].id].find(item => typeof item === 'string')
    assert.equal(passedId, 'макет-42',
      `openDesign вызвана не со своим макетом: ${JSON.stringify(arg)}`)
  })

  await check('версия показана и меняется после правки', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 3 }))
    const first = scene.card(marker('А1'))
    const firstText = scene.textIn(first)
    assert.ok(versionShown(firstText, 3),
      `в готовой карточке не читается номер версии 3 (ждём подписанный вид вроде «версия 3»): «${firstText}»`)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 11 }))
    const cards = scene.cardRoots(marker('А1'))
    assert.equal(cards.length, 1, `правка добавила вторую карточку: ${scene.describe(cards)}`)
    const text = scene.textIn(cards[0])
    assert.ok(versionShown(text, 11), `после правки номер версии не стал 11: «${text}»`)
    assert.equal(versionShown(text, 3), false, `карточка всё ещё показывает прежнюю версию 3: «${text}»`)
  })

  await check('кадр обновляется вместе с версией: адрес получает новое значение «свежего» параметра', async () => {
    const scene = makeScene()
    const watch = frameWatch(scene)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 1 }))
    const before = scene.frames(scene.card(marker('А1')))[0]
    // Разрыв в несколько миллисекунд: если «свежий» параметр — метка времени,
    // два события в одну миллисекунду дали бы одинаковый адрес не по вине кода.
    await new Promise(resolve => setTimeout(resolve, 12))
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    // Смена версии — это ВТОРОЙ кадр, который
    // подменяет первый по своему `load`. Адрес меряется тогда, когда «браузер»
    // подмену завершил: до `load` на экране прежний кадр, и читать `frames[0]`
    // значило бы мерить старую версию. Требование — «адрес меняется вместе с
    // версией» — осталось ровно тем же, как и проверка, что адрес не пустой.
    await watch.settle(scene.dom.body)
    const shownAfter = watch.shown(scene.card(marker('А1')))
    const after = shownAfter[0] || scene.frames(scene.card(marker('А1')))[0]
    const srcBefore = String((before || {}).getAttribute ? before.getAttribute('src') : '')
    const srcAfter = String((after || {}).getAttribute ? after.getAttribute('src') : '')
    assert.ok(srcAfter, `после правки кадра в карточке нет: ${scene.describe(scene.cardRoots(marker('А1')))}`)
    assert.notEqual(srcAfter, srcBefore,
      `адрес кадра не изменился между версиями 1 и 2 (${srcAfter}) — браузер покажет старый снимок из кэша`)
  })

  await check('подсказки только через data-tooltip: ни title= в исходнике, ни атрибута title на узлах', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    scene.api.onDesignTaskEvent(task({ status: 'failed', error: 'не собралось' }))
    for (const el of scene.dom.descendants(scene.dom.body)) {
      assert.equal(el.getAttribute('title'), null,
        `у узла ${el.tagName.toLowerCase()} в ленте стоит атрибут title («${el.getAttribute('title')}») — ` +
        'в этом проекте подписи делаются только через data-tooltip (tests/test-tooltips.cjs)')
    }
    const source = sourceText()
    const offenders = []
    source.split('\n').forEach((line, index) => {
      if (/(?:^|\s)title\s*=/.test(line) && !/function\s+\w+\([^)]*title\s*=/.test(line)) offenders.push((index + 1) + ': ' + line.trim())
      if (/\.title\s*=/.test(line)) offenders.push((index + 1) + ': ' + line.trim())
      if (/setAttribute\s*\(\s*['"]title['"]/i.test(line)) offenders.push((index + 1) + ': ' + line.trim())
    })
    assert.deepEqual(offenders, [], 'в исходнике модуля появились нативные подсказки title:\n  ' + offenders.join('\n  '))
  })

  await check('текст задачи попадает в DOM экранированным, а не разметкой', async () => {
    const scene = makeScene()
    const payload = 'МИШЕНА-ИКС <img src=x onerror=alert(1)>'
    scene.api.onDesignTaskEvent(task({ taskId: 'задача-икс', status: 'running', brief: payload }))
    const cards = scene.cardRoots('МИШЕНА-ИКС')
    assert.equal(cards.length, 1, `карточки с текстом задачи не найдено (их ${cards.length}): ${scene.describe(cards)}`)
    const card = cards[0]
    assert.ok(scene.textIn(card).includes('onerror=alert(1)'),
      `текст задачи не показан дословно: «${scene.textIn(card)}»`)
    const imgs = scene.dom.descendants(card).filter(el => el.tagName === 'IMG')
    assert.equal(imgs.length, 0,
      `brief задачи прорисовался узлами ${imgs.map(el => el.tagName).join(', ')} — текст модели обязан попадать в ленту через escapeHtml`)
  })

  await check('несколько задач одного диалога живут отдельными карточками', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ taskId: 'задача-раз', status: 'running', brief: 'Первая «' + marker('Р1') + '»' }))
    scene.api.onDesignTaskEvent(task({ taskId: 'задача-два', status: 'ready', brief: 'Вторая «' + marker('Р2') + '»' }))
    assert.equal(scene.cardRoots(marker('Р1')).length, 1, 'первая карточка пропала при появлении второй')
    assert.equal(scene.cardRoots(marker('Р2')).length, 1, 'вторая карточка не появилась')
  })

  await check('clearTaskCards() убирает карточки, повторный вызов не падает', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    assert.ok(scene.cardRoots(marker('А1')).length === 1, 'харнесс не смог подготовить карточку')
    scene.api.clearTaskCards()
    assert.equal(scene.cardRoots(marker('А1')).length, 0,
      `после clearTaskCards карточек осталось ${scene.cardRoots(marker('А1')).length}: ${scene.describe(scene.cardRoots(marker('А1')))}`)
    scene.api.clearTaskCards()
    scene.api.onDesignTaskEvent(task({ status: 'running' }))
    assert.equal(scene.cardRoots(marker('А1')).length, 1,
      'после очистки лента не принимает новые карточки — модуль почистил не только узлы')
  })

  await check('электронAPI приходит из deps: модуль не лезет в window.electronAPI', async () => {
    const source = sourceText()
    const offenders = []
    source.split('\n').forEach((line, index) => {
      if (/window\.electronAPI|globalThis\.electronAPI|root\.electronAPI/.test(line)) offenders.push((index + 1) + ': ' + line.trim())
    })
    assert.deepEqual(offenders, [],
      'модуль берёт канал из глобального окна, а не из deps — узловой прогон тогда ничего не проверяет:\n  ' + offenders.join('\n  '))
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready' }))
    assert.ok(scene.cardRoots(marker('А1')).length === 1, 'карточка не построена на внедряемом electronAPI')
  })

  await check('событие без designId в состоянии «готово» не рисует пустой адрес', async () => {
    const scene = makeScene()
    scene.api.onDesignTaskEvent(task({ status: 'ready', designId: null, taskId: 'задача-без-id' }))
    const cards = scene.cardRoots(marker('А1'))
    assert.ok(cards.length <= 1, `карточка без макета должна остаться одной текстовой, а их ${cards.length}: ${scene.describe(cards)}`)
    for (const frame of (cards.length ? scene.frames(cards[0]) : [])) {
      const src = String(frame.getAttribute('src') || '')
      assert.equal(/undefined|null/.test(src), false, `у кадра адрес собран из пустоты: «${src}»`)
      assert.ok(src.startsWith('onecode-design://'), `кадр указывает не на превью макета: «${src}»`)
    }
  })

  // --- превью готовой правки не мигает ------------------------------------------
  //
  // Та же версия — кадр не трогается; сменилась — новый грузится вторым узлом и
  // подменяет первый по своему `load`; пока `load` не пришёл, на экране остаётся
  // прежний загруженный кадр. Ни одно звено не называет имён внутри модуля:
  // меряются узлы, их адреса, видимость и то, успел ли «браузер» их докачать.

  // Сцена: карточка уже показала `ready` с версией `version`, и «браузер»
  // этот кадр докачал — на экране стоит загруженное превью.
  async function readyScene (version) {
    const scene = makeScene()
    const watch = frameWatch(scene)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version }))
    const card = scene.card(marker('А1'))
    const shown = watch.shown(card)
    assert.equal(shown.length, 1,
      `готовая карточка (версия ${version}) обязана держать на экране один кадр-превью, а их ${shown.length}: ` +
      `${watch.framesIn(card).map(f => `${srcOf(f)}${isHiddenNode(f) ? ' [спрятан]' : ' [показан]'}`).join(' | ')}`)
    await watch.settle(scene.dom.body)
    return { scene, watch, card, frame: shown[0] }
  }

  // Экран в один загруженный кадр: ровно один показанный `<iframe>`, он тот же
  // самый узел, что стоял до правки, и его документ докачан.
  function expectOneLoadedFrame (watch, card, expected, phase) {
    const shown = watch.shown(card)
    assert.equal(shown.length, 1,
      `на шаге «${phase}» на экране ${shown.length} кадров превью вместо одного: ` +
      `${watch.framesIn(card).map(f => `${srcOf(f)}${isShownFrame(f) ? ' [показан]' : ' [спрятан]'}`).join(' | ')} — ` +
      'пустое место или два кадра рядом человек видит ровно так же, как миг из Н96')
    assert.ok(shown[0].parentNode, `на шаге «${phase}» показанный кадр ни к чему не прикреплён — превью исчезло`)
    assertSameNode(shown[0], expected,
      `на шаге «${phase}» на экране не тот кадр, который был загружен: подмена обязана происходить по событию ` +
      '`load` нового кадра, а не в момент смены адреса — это и есть Н96 (миг пустого прямоугольника), и на экране ' +
      'должен оставаться прежний загруженный кадр')
    assert.ok(watch.loaded.has(shown[0]),
      `на шаге «${phase}» показан кадр «${srcOf(shown[0])}», документ которого не загружен (${NO_LOAD_SUBSCRIPTION})`)
    return shown[0]
  }

  await check('Н96. Повторное «готово» той же версии: кадр остаётся тем же узлом, адрес не переустанавливается', async () => {
    const scene = makeScene()
    const watch = frameWatch(scene)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 7 }))
    const card = scene.card(marker('А1'))
    const first = watch.framesIn(card)
    assert.equal(first.length, 1,
      `готовая карточка обязана показать один кадр-превью, а их ${first.length}: ${first.map(f => srcOf(f)).join(' | ')}`)
    const frame = first[0]
    const src = srcOf(frame)
    assert.ok(src, `у показанного кадра пустой адрес — дальше нечего сравнивать: ${scene.textIn(card)}`)
    const made = watch.count()
    const writes = watch.writesOf(frame).length
    await watch.settle(scene.dom.body)
    // Версия та же, а события идут: движок шлёт прогресс, лента перерисовывается,
    // карточка возвращается в ленту тем же узлом. Ни одно из этого не право
    // перезапускать превью.
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 7 }))
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 7, message: 'Проверка макета' }))
    scene.api.redrawTaskCards()
    const now = watch.framesIn(scene.card(marker('А1')))
    assert.equal(now.length, 1,
      `после повтора «готово» той же версии в превью ${now.length} узла: ${now.map(f => srcOf(f)).join(' | ')}`)
    assertSameNode(now[0], frame,
      'превью перезагружается, хотя версия не сменилась: человек видит миг пустого прямоугольника. ' +
      'На ready превью не перезагружается, если версия не сменилась')
    assert.equal(srcOf(now[0]), src,
      `адрес показанного кадра переустановлен на том же узле: было «${src}», стало «${srcOf(now[0])}» — живой кадр ` +
      'от этого обрывает загрузку и мигает пустотой')
    assert.equal(watch.count(), made,
      `создано ещё ${watch.count() - made} <iframe> на событии с прежней версией: превью пересобирается на каждом ` +
      'прогрессе задачи')
    assert.equal(watch.writesOf(frame).length, writes,
      'кадру назначали новый адрес поверх живого узла — прежний документ обрывается, на экране пустота')
  })

  await check('Н96. Сменилась версия: прежний кадр остаётся на экране, новая версия грузится вторым узлом', async () => {
    const { scene, watch, card, frame: old } = await readyScene(1)
    const srcOld = srcOf(old)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    assert.ok(old.parentNode,
      `смена версии сняла прежний кадр с экрана до загрузки нового: «${srcOld}» откреплён — на ленте миг пустоты. ` +
      'Старый кадр обязан оставаться видимым, пока новый не дойдёт до `load`')
    const all = watch.framesIn(card)
    expectOneLoadedFrame(watch, card, old, 'новая версия грузится')
    const pending = all.filter(node => node !== old)
    assert.equal(pending.length, 1,
      `новой версии грузить нечему: в превью ${all.length} узел (был только «${srcOld}») — адрес версии 2 должен ` +
      'появиться вторым кадром, а не заменой первого')
    const srcNew = srcOf(pending[0])
    assert.ok(srcNew, `второй кадр создан с пустым адресом: ${all.map(f => srcOf(f)).join(' | ')}`)
    assert.equal(srcNew === srcOld, false,
      `второй кадр грузит тот же адрес, что и первый (${srcNew}): версия 2 не будет показана`)
    assert.equal(freshValue(srcNew) === null || freshValue(srcNew) === freshValue(srcOld), false,
      `значение «свежего» параметра не изменилось (было «${freshValue(srcOld)}», стало «${freshValue(srcNew)}») — ` +
      'браузер отдал бы прежний снимок из кэша')
    assert.equal(isHiddenNode(pending[0]), true,
      `второй кадр «${srcNew}» не спрятан, хотя на экране ещё прежний: рядом два кадра, и человек видит прыгающую ` +
      'ленту. Признаки, которые видит харнесс: hidden, style.display:none, style.visibility:hidden, style.opacity:0')
    assert.equal(pending[0].parentNode === null, false, 'второй кадр создан, но не вставлен в превью — он не загрузится')
  })

  await check('Н96. По `load` нового кадра прежний убирается: на экране ровно новый, загруженный, без дыры', async () => {
    const { scene, watch, card, frame: old } = await readyScene(1)
    const srcOld = srcOf(old)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    const all = watch.framesIn(card)
    const pending = all.find(node => node !== old)
    assert.ok(pending, `нет второго кадра, который грузит версию 2 (в превью ${all.length} узел) — подменять нечего`)
    const deaf = await watch.settle(scene.dom.body)
    assert.deepEqual(deaf.map(srcOf), [], NO_LOAD_SUBSCRIPTION + '; сейчас без подписки стоят: ' + deaf.map(f => `«${srcOf(f)}»`).join(', '))
    const after = watch.framesIn(card)
    assert.equal(after.length, 1,
      `по загрузке нового кадра в превью осталось ${after.length} узла: прежний «${srcOld}» не убран — два кадра ` +
      `рядом: ${after.map(f => `${srcOf(f)}${isShownFrame(f) ? ' [показан]' : ' [спрятан]'}`).join(' | ')}`)
    assertSameNode(after[0], pending,
      'на экране после подмены прежний кадр: новая версия так и не показана')
    assert.equal(isShownFrame(after[0]), true,
      `новый кадр «${srcOf(after[0])}» докачан, но остался спрятанным: человек видит пустое место вместо превью`)
    assert.equal(old.parentNode === null, true, `прежний кадр «${srcOld}» не снят с экрана после подмены`)
    expectOneLoadedFrame(watch, card, pending, 'после подмены')
  })

  await check('Н96. Если `load` не приходит, на экране остаётся прежний загруженный кадр: ни пустоты, ни двух показанных', async () => {
    const { scene, watch, card, frame: old } = await readyScene(1)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    // Загрузку НЕ подтягиваем: так выглядит медленно грузящийся кадр.
    await new Promise(resolve => setTimeout(resolve, 40))
    expectOneLoadedFrame(watch, card, old, 'новый кадр ещё грузится')
    // Отказ загрузиться требованием не является (подписку на `error` модуль вправе
    // не заводить), но последствий быть не должно: ни пустого места, ни двух
    // показанных кадров.
    const pending = watch.framesIn(card).find(node => node !== old)
    if (pending) dispatchOn(pending, 'error')
    await new Promise(resolve => setTimeout(resolve, 25))
    expectOneLoadedFrame(watch, card, old, 'новый кадр не загрузился')
    const shown = watch.shown(card)
    assert.equal(/undefined|null/.test(srcOf(shown[0])), false,
      `на экране кадр с адресом из пустоты: «${srcOf(shown[0])}»`)
  })

  await check('Н96. Пока новый кадр грузится, повтор «готово» той же версии не заводит третий кадр', async () => {
    const { scene, watch, card, frame: old } = await readyScene(1)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    const pending = watch.framesIn(card).find(node => node !== old)
    assert.ok(pending, `версия 2 не грузится вторым кадром: ${watch.framesIn(card).map(srcOf).join(' | ')}`)
    const made = watch.count()
    // События прогресса идут и во время загрузки: версия уже та же самая.
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2, message: 'Проверка макета' }))
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    assert.equal(watch.count(), made,
      `пока грузился кадр версии 2, модуль создал ещё ${watch.count() - made} <iframe>: каждое событие прогресса ` +
      'перезапускает превью — отсюда и миг из Н96')
    expectOneLoadedFrame(watch, card, old, 'повтор события при грузящемся кадре')
    assert.equal(watch.framesIn(card).length, 2,
      `в превью ${watch.framesIn(card).length} узла вместо пары «прежний + грузящийся»: ${watch.framesIn(card).map(srcOf).join(' | ')}`)
  })

  await check('Н96. Три смены версии подряд: подмена по `load`, в превью ровно один узел и он загружен', async () => {
    const { scene, watch, card, frame: first } = await readyScene(1)
    let current = first
    let previousSrc = srcOf(first)
    for (const version of [2, 3, 4]) {
      scene.api.onDesignTaskEvent(task({ status: 'ready', version }))
      const deaf = await watch.settle(scene.dom.body)
      assert.deepEqual(deaf.map(srcOf), [],
        `на версии ${version} кадров без подписки на load: ${deaf.map(f => `«${srcOf(f)}»`).join(', ')}. ` +
        NO_LOAD_SUBSCRIPTION)
      const shownList = watch.shown(card)
      assert.equal(shownList.length, 1,
        `на версии ${version} на экране ${shownList.length} кадров превью вместо одного: ` +
        `${watch.framesIn(card).map(f => `${srcOf(f)}${isShownFrame(f) ? ' [показан]' : ' [спрятан]'}`).join(' | ')}`)
      const shown = shownList[0]
      assert.ok(watch.loaded.has(shown),
        `на версии ${version} показан кадр «${srcOf(shown)}» с незагруженным документом (${NO_LOAD_SUBSCRIPTION})`)
      assert.equal(watch.framesIn(card).length, 1,
        `после версии ${version} в превью ${watch.framesIn(card).length} узла: подмена копит кадры, а спрятанный ` +
        `прежний грузит отброшенную страницу молча — ${watch.framesIn(card).map(f => `${srcOf(f)}${isShownFrame(f) ? ' [показан]' : ' [спрятан]'}`).join(' | ')}`)
      const src = srcOf(shown)
      assert.ok(src.startsWith('onecode-design://макет-42/'), `версия ${version} показала чужой адрес: «${src}»`)
      assert.equal(src === previousSrc, false,
        `версия ${version} показала тот же адрес, что и прежняя (${src}): превью не обновилось`)
      assert.equal(versionShown(scene.textIn(card), version), true,
        `версия ${version} не названа в подписи карточки: «${scene.textIn(card)}»`)
      current = shown
      previousSrc = src
    }
    assert.ok(watch.loaded.has(current), 'финальный кадр так и не был загружен')
  })

  await check('Н96. Второй, догружаемый кадр изолирован так же: sandbox ровно allow-scripts на каждом узле превью', async () => {
    const { scene, watch, card, frame: old } = await readyScene(1)
    scene.api.onDesignTaskEvent(task({ status: 'ready', version: 2 }))
    const all = watch.framesIn(card)
    assert.ok(all.length >= 1, 'проверке изоляции не на что смотреть: в готовой карточке нет кадра')
    for (const frame of all) {
      const sandbox = String(frame.getAttribute('sandbox') || '')
      assert.equal(sandbox, 'allow-scripts',
        `у кадра «${srcOf(frame)}» sandbox равен «${sandbox}» — второй кадр, который грузится в фоне, обязан быть ` +
        'изолирован ровно так же, как показанный (без allow-same-origin макет модели попадает в Origin окна)')
    }
  })

  globalThis.addEventListener = globalAddEventListener
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})
