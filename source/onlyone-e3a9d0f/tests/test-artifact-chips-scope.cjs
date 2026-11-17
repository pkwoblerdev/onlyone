// Н79: ряд кнопок артефакта принадлежит ОТКРЫТОМУ диалогу, а не тому, из
// которого прилетело событие. Узловой прогон на подставном DOM и подставном
// `electronAPI` (образец — сосед `test-artifact-panel-gallery.cjs`): модуль
// панели подключается настоящий, окружение — заглушки.
//
// Что требует набор от провода (и что обязан обеспечить продукт-код):
//  - ряд `#artifactChips` перестраивается только под чат, открытый в окне;
//    событие из фонового диалога ряд не трогает;
//  - идентификатор открытого чата приходит модулю геттером из `deps` по образцу
//    `design-task-card.js`: `getChatId: () => id открытого диалога (или '')`.
//    Прямых чтений `window.electronAPI`, `document` вне deps и вызовов
//    `selectChat` в модуле быть не должно;
//  - без переданного геттера (или когда он вернул пустой id) ряд молчит: не
//    падает, не стирается до нуля (замер из аудита: «кнопок в ряду 0» при трёх
//    артефактах) и не рисует чужое.
//
// Красное здесь — по поведению, а не по форме: набор стартует с зелёной базы
// («модуль загрузился и рисует явный чат»), поэтому падение на загрузке
// невозможно перепутать с настоящим провалом проверки.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PANEL_SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'artifact-panel.js')
const INDEX_HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html')

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

const t = (text, ...args) => {
  let index = 0
  return String(text).replace(/%s/g, () => (index < args.length ? String(args[index++]) : '%s'))
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]))

// --- подставной DOM -----------------------------------------------------------
// Заимствован у соседнего галерейного набора без изменений: он уже разбирает и
// `createElement`, и `innerHTML`, и держит цепочку родителей для `closest` —
// панель пишет ряд обоими способами, а проверка обязана видеть результат, а не
// способ записи.

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

function makeDom (initialMarkup) {
  const makeText = text => ({ nodeType: 3, textContent: String(text), parentNode: null })

  function detach (node) {
    const parent = node.parentNode
    if (!parent) return
    const index = parent._nodes.indexOf(node)
    if (index >= 0) parent._nodes.splice(index, 1)
    node.parentNode = null
    node.parentElement = null
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
      contentEditable: 'false',
      scrollWidth: 0,
      clientWidth: 0,
      scrollHeight: 0,
      clientHeight: 0,
      addEventListener (type, fn) { el._listeners.push({ type, fn }) },
      removeEventListener (type, fn) {
        const index = el._listeners.findIndex(item => item.type === type && item.fn === fn)
        if (index >= 0) el._listeners.splice(index, 1)
      },
      appendChild (node) { return adopt(el, node) },
      append (...nodes) { for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      replaceChildren (...nodes) { clear(el); for (const node of nodes) adopt(el, typeof node === 'string' ? makeText(node) : node) },
      remove () { detach(el) },
      getAttribute (name) {
        const key = String(name).toLowerCase()
        if (el._attrs.has(key)) return el._attrs.get(key)
        // Зеркало в свойство делается не для всех имён: `el.id` у элемента без
        // id вызвал бы getAttribute('id') и ушёл в бесконечный цикл.
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
        while (current) { if (el.matches.call(current, selector)) return current; current = current.parentElement }
        return null
      },
      contains (node) {
        let current = node
        while (current) { if (current === el) return true; current = current.parentNode }
        return false
      },
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

  const body = createElement('BODY')
  const document = {
    body,
    activeElement: null,
    documentElement: createElement('HTML'),
    createElement,
    createTextNode: makeText,
    addEventListener () {},
    removeEventListener () {},
    querySelector (selector) { return queryAll(body, selector)[0] || null },
    querySelectorAll (selector) { return queryAll(body, selector) },
    contains (node) { return body.contains(node) },
    getSelection () { return null }
  }
  for (const node of parseHtml(initialMarkup)) adopt(body, node)

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

  const byId = new Map()
  for (const el of descendants(body)) {
    const id = el.getAttribute('id')
    if (id && !byId.has(id)) byId.set(id, el)
  }

  return { body, document, createElement, descendants, queryAll, fireClick, parseHtml, byId }
}

// --- сценарий ------------------------------------------------------------------

const panelModule = require(PANEL_SOURCE)

// Ряд берётся из настоящей разметки: имена узлов в проверке обязаны совпадать с
// тем, что видит окно, а не с тем, что придумал тест.
function stripMarkup () {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const found = /<div id="artifactChips"[\s>][\s\S]*?<\/div>/.exec(html)
  assert.ok(found, 'в index.html не найден #artifactChips — проверять стало нечего')
  return found[0]
}

const OPEN = 'открытый-1'
const BG = 'фоновый-2'

function art (id, chatId, title) {
  return {
    id, chatId, title, kind: 'code', fileName: '',
    createdAt: 1, updatedAt: 1, current: 1,
    versions: [{ n: 1, at: 1, chars: 5, file: '1-source' }],
    url: `onecode-artifact://${id}/1-source`
  }
}

globalThis.fetch = async url => ({ ok: true, status: 200, url: String(url), text: async () => 'содержимое' })

// Два диалога: в открытом три артефакта, в фоновом один — со своим id, чтобы
// подмену ряда было видно по содержимому, а не только по числу кнопок.
// getArtifacts('') копирует главное процесс: без фильтра по чату — ВСЕ
// артефакты (см. list() в src/main/artifacts.js), поэтому «порисовать пустоту»
// превращается в «нарисовать чужое» — ровно то, что ряд не имеет права делать.
function makeScenario ({ withGetter = true, getChatId = () => OPEN } = {}) {
  const dom = makeDom(stripMarkup())
  const chats = {
    [OPEN]: [art('a1', OPEN, 'Заявка'), art('a2', OPEN, 'Тарифы'), art('a3', OPEN, 'Смета')],
    [BG]: [art('b1', BG, 'Фоновый отчёт')]
  }
  const all = () => Object.values(chats).flat()
  const calls = { chats: [] }
  let handler = null

  const electronAPI = {
    getArtifacts: async chatId => {
      calls.chats.push(String(chatId ?? ''))
      return { artifacts: String(chatId) ? (chats[String(chatId)] || []) : all() }
    },
    onArtifactChanged: cb => { handler = cb },
    saveArtifactVersion: async () => ({ ok: true }),
    renameArtifact: async () => ({ ok: true }),
    archiveArtifact: async () => ({ ok: true }),
    revealArtifact: async () => ({ ok: true }),
    exportArtifact: async () => ({ ok: true })
  }

  const $ = id => {
    if (dom.byId.has(id)) return dom.byId.get(id)
    const el = dom.createElement('div')
    el.setAttribute('id', id)
    dom.body.appendChild(el)
    dom.byId.set(id, el)
    return el
  }

  const deps = {
    $, t, escapeHtml, enhanceSelect: () => {}, openContextMenu: () => {},
    askConfirm: async () => true, electronAPI, document: dom.document
  }
  if (withGetter) deps.getChatId = getChatId
  const panel = panelModule.create(deps)
  panel.bind()

  const flush = async () => {
    for (let i = 0; i < 32; i++) await new Promise(resolve => setImmediate(resolve))
  }
  const chipEls = () => dom.descendants(dom.byId.get('artifactChips')).filter(el => el.tagName === 'BUTTON')
  const chipIds = () => chipEls().map(el => String(el.dataset.id ?? ''))

  // Событие об артефакте — тем же каналом, каким его отдаёт preload: bind()
  // подписал обработчик через electronAPI.onArtifactChanged, прогон зовёт его.
  const fire = async payload => {
    assert.ok(handler, 'модуль не подписался на событие об артефакте — проверять нечем')
    let thrown = null
    try { handler(payload) } catch (error) { thrown = error }
    await flush()
    return thrown
  }

  const addOpen = a => { chats[OPEN].push(a) }

  return { panel, dom, calls, chipEls, chipIds, fire, flush, addOpen }
}

async function main () {
  await check('база харнесса: явный запрос ряда рисует кнопки запрошенного чата', async () => {
    // Зелёная опора: если падает она — сломан прогон, а не продукт.
    const scene = makeScenario()
    await scene.panel.refreshArtifactChips(OPEN)
    assert.deepEqual(scene.chipIds().sort(), ['a1', 'a2', 'a3'],
      `ряд после явного запроса: ${JSON.stringify(scene.chipIds())}`)
  })

  await check('Н79: событие из фонового диалога не перестраивает ряд открытого', async () => {
    const scene = makeScenario()
    await scene.panel.refreshArtifactChips(OPEN)
    const before = scene.chipIds()
    const thrown = await scene.fire({ chatId: BG, action: 'updated', artifact: art('b1', BG, 'Фоновый отчёт') })
    assert.equal(thrown, null, `событие бросило исключение: ${thrown && thrown.message}`)
    assert.deepEqual(scene.chipIds(), before,
      `ряд перестроился под фоновый диалог «${BG}»: было ${JSON.stringify(before)}, стало ${JSON.stringify(scene.chipIds())}`)
  })

  await check('Н79: событие открытого диалога ряд обновляет, а не молчит навечно', async () => {
    // Обратная сторона запрета: «не подменять чужое» не должно означать «никогда
    // не перечитывать своё». Новое сообщение в открытом диалоге — новое событие.
    const scene = makeScenario()
    await scene.panel.refreshArtifactChips(OPEN)
    const fresh = art('a4', OPEN, 'Сводка')
    scene.addOpen(fresh)
    await scene.fire({ chatId: OPEN, action: 'added', artifact: fresh })
    assert.deepEqual(scene.chipIds().sort(), ['a1', 'a2', 'a3', 'a4'],
      `событие открытого диалога не добавило новую кнопку: ${JSON.stringify(scene.chipIds())}`)
  })

  await check('Н79: перестроение ряда без явного чата (подъём окна) его не стирает', async () => {
    // Замер из аудита: после подъёма окна «кнопок в ряду 0» при трёх артефактах.
    // Клик по строке галереи и любой повторный проход рисуют ряд заново; без
    // переданного явного чата ряд обязан взять открытый через геттер deps, а не
    // прочитать пустоту (в главном процессе getArtifacts('') — это ВСЕ чаты).
    const scene = makeScenario()
    await scene.panel.refreshArtifactChips(OPEN)
    const before = scene.chipIds()
    await scene.panel.refreshArtifactChips()
    assert.deepEqual(scene.chipIds().sort(), before.sort(),
      `перестроение без явного чата изменило ряд: было ${JSON.stringify(before)}, стало ${JSON.stringify(scene.chipIds())}`)
  })

  await check('модуль не зовёт selectChat и не лезет в состояние окна напрямую', () => {
    const source = fs.readFileSync(PANEL_SOURCE, 'utf8')
    assert.equal(source.includes('selectChat'), false,
      'artifact-panel.js зовёт selectChat: подъём/перерисовка ряда не имеет права менять чат окна')
    assert.equal(source.includes('window.electronAPI'), false,
      'artifact-panel.js читает window.electronAPI напрямую: канал обязан приходить через deps')
    assert.equal(/window\.document\b/.test(source), false, 'artifact-panel.js читает window.document напрямую')
    assert.equal(/globalThis\.(document|electronAPI)\b/.test(source), false,
      'artifact-panel.js читает document/electronAPI из globalThis: всё через deps')
    assert.match(source, /const\s*\{[^}]*\belectronAPI\b[^}]*\bdocument\b[^}]*\}\s*=\s*deps/,
      'document и electronAPI не деструктурируются из deps — прогон не подменить')
  })

  await check('Н79: без геттера открытого чата ряд молчит — не падает и не рисует чужое', async () => {
    // Проводка обязана требовать getChatId из deps; пока ведущий её не вписал,
    // модуль не имеет права на своё усмотрение выбирать чат для ряда.
    const scene = makeScenario({ withGetter: false })
    await scene.panel.refreshArtifactChips(OPEN)
    const before = scene.chipIds()
    const thrown = await scene.fire({ chatId: BG, action: 'updated', artifact: art('b1', BG, 'Фоновый отчёт') })
    assert.equal(thrown, null, `событие без геттера бросило исключение: ${thrown && thrown.message}`)
    assert.deepEqual(scene.chipIds(), before,
      `без getChatId ряд перестроился под чужой чат: было ${JSON.stringify(before)}, стало ${JSON.stringify(scene.chipIds())}`)
  })

  await check('Н79: геттер вернул пустой id — ряд не стирается и не показывает все чаты', async () => {
    // Открытого диалога нет (в окне только список): перерисовывать ряд не под
    // что. getArtifacts('') в главном процессе отдаёт ВСЕ артефакты, поэтому
    // «просто перечитать пустой id» — это «нарисовать чужое», а «стереть» —
    // тот самый замер 3→0 из аудита.
    const scene = makeScenario({ getChatId: () => '' })
    await scene.panel.refreshArtifactChips(OPEN)
    const before = scene.chipIds()
    const thrown = await scene.fire({ chatId: BG, action: 'updated', artifact: art('b1', BG, 'Фоновый отчёт') })
    assert.equal(thrown, null, `событие при пустом открытом чате бросило исключение: ${thrown && thrown.message}`)
    assert.deepEqual(scene.chipIds(), before,
      `при getChatId='' ряд изменился: было ${JSON.stringify(before)}, стало ${JSON.stringify(scene.chipIds())}`)
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})
