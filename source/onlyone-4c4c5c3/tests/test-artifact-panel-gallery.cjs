// Галерея версий артефакта (план, 1.4) и список форматов выгрузки — поведение
// окна, проверяемое без Electron.
//
// Приём тот же, что в `tests/test-design-preview-engine.cjs`: модуль панели
// подключается настоящий (`require`), а вокруг него — заглушки DOM, `fetch` и
// `electronAPI` с фиксированным списком зависимостей. Копию панели в тест не
// переносим: копия устарела бы в тот же вечер, и проверка начала бы воспроизводить
// саму себя.
//
// Заглушка разбирает и `createElement`, и `innerHTML` нарочно: галерею можно
// собрать и так, и так, а проверка обязана держать поведение (строки есть, они
// настоящие кнопки, клик переключает показ), а не способ записи в разметку.
//
// Дерево заглушки строится из настоящей разметки панели в `index.html`, поэтому
// строки галереи ищутся без знания их id: требование — «видны внутри панели», а
// не «лежат в элементе с таким-то именем».
//
// Проверки красные намеренно: галереи и `artifactExportFormats` в модуле ещё нет.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PANEL_SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'artifact-panel.js')
const INDEX_HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html')
const artifacts = require('../src/main/artifacts')

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

function makeDom (panelMarkup) {
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
        // Зеркало в свойство делается не для всех имён — обратно из свойства
        // читаются только те, у которых нет своих геттеров: `el.id` у элемента без
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
  for (const node of parseHtml(panelMarkup)) adopt(body, node)

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

// Разметка панели берётся из настоящего `index.html`: тест обязан видеть тот же
// каркас, что видит окно, и не должен расхожеться с ним в именах.
function panelMarkup () {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const start = html.indexOf('<aside id="artifactPanel"')
  assert.notEqual(start, -1, 'в index.html не найден #artifactPanel — проверять стало нечего')
  const end = html.indexOf('</aside>', start)
  assert.ok(end > start, 'блок панели в index.html не закрыт')
  return html.slice(start, end + '</aside>'.length)
}

const t = (text, ...args) => {
  let index = 0
  return String(text).replace(/%s/g, () => (index < args.length ? String(args[index++]) : '%s'))
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]))

const panelModule = require(PANEL_SOURCE)

const trash = []
function tempDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-artifact-gallery-'))
  trash.push(dir)
  return dir
}

// Кнопки, которые есть в разметке панели всегда: строки галереи ищутся среди
// остальных, без знания их имён.
const MARKUP_BUTTONS = new Set(['artifactClose', 'artifactEdit', 'artifactMore', 'artifactExpand', 'artifactSave'])

// Панель на «минах»: любое обращение к DOM в проверках форматов — провал с
// текстом мины, а не тихое «ну как-то же работает».
function landmineDeps () {
  const boom = () => { throw new Error('форматы выгрузки полезли в DOM') }
  return {
    $: boom,
    t,
    escapeHtml,
    enhanceSelect: boom,
    openContextMenu: boom,
    askConfirm: async () => true,
    electronAPI: {},
    document: new Proxy({}, { get () { throw new Error('форматы выгрузки полезли в DOM') } })
  }
}
const noDom = () => panelModule.create(landmineDeps())

const allText = el => [
  el.textContent,
  el.getAttribute('aria-label') || '',
  el.getAttribute('data-tooltip') || '',
  el.getAttribute('title') || ''
].join(' ')

const tokens = text => (String(text).match(/\d+/g) || []).map(Number)
// Строка ищется по паре «номер версии + её размер»: по одному номеру строки
// разъезжаются с числовыми фрагментами местной даты (час 02 — это и «2», и
// половина «02:30»).
const rowFor = (rows, version) => rows.find(row => {
  const list = tokens(allText(row))
  return list.includes(version.n) && list.includes(version.chars)
})
const expectRow = (rows, version) => {
  const row = rowFor(rows, version)
  assert.ok(row, `строки версии ${version.n} нет среди: ${rows.map(allText).join(' | ') || '(галерея пуста)'}`)
  return row
}

// Как окно получает артефакты: копия формы `artifactPublic` из главного процесса
// — панели нужны ровно эти поля.
function publicMeta (meta) {
  const current = (meta.versions || []).find(item => item.n === meta.current) || (meta.versions || [])[0]
  return {
    id: meta.id, chatId: meta.chatId || null, title: meta.title, kind: meta.kind,
    fileName: meta.fileName || '', createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    current: meta.current,
    versions: (meta.versions || []).map(item => ({ n: item.n, at: item.at, chars: item.chars, file: item.file })),
    url: `onecode-artifact://${meta.id}/${current?.file || ''}`
  }
}

// Сценарий: настоящий артефакт во временной папке, настоящая разметка панели,
// заглушка DOM и `fetch` поверх схемы `onecode-artifact://`.
async function makeScenario (first) {
  const dir = tempDir()
  const store = artifacts.create({ dir })

  // Новый артефакт в том же хранилище: панель умеет показывать и второй, и для
  // этого не нужен второй прогон с другим `fetch`.
  async function add ({ kind = 'code', title = 'Заметка', contents = ['раз'], at = null } = {}) {
    let meta = await store.add({ chatId: 'чат-1', kind, title, content: contents[0] || 'раз' })
    for (const text of contents.slice(1)) meta = await store.update(meta.id, text)
    if (at) {
      // Метки времени подставляются в `meta.json` руками: хранилище ставит
      // `Date.now()`, а различить три версии, рождённые в одну миллисекунду,
      // человек по экрану не сможет — ровно это галерея и обязана показывать.
      const file = path.join(store.folderOf(meta.id), 'meta.json')
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      raw.versions.forEach((item, index) => { item.at = at[index] })
      fs.writeFileSync(file, JSON.stringify(raw))
      meta = await store.readMeta(meta.id)
    }
    return publicMeta(meta)
  }
  const artifact = await add(first)

  const dom = makeDom(panelMarkup())
  const panelEl = dom.byId.get('artifactPanel')
  const calls = { getArtifacts: 0, fetch: [] }
  const registry = { list: [artifact] }

  globalThis.fetch = async url => {
    calls.fetch.push(String(url))
    const found = /^onecode-artifact:\/\/([^/]+)\/(.*)$/.exec(String(url))
    if (!found) return { ok: false, status: 404, url: String(url), text: async () => '' }
    const fresh = await store.readMeta(found[1])
    const version = fresh && fresh.versions.find(item => item.file === found[2])
    if (!version) return { ok: false, status: 404, url: String(url), text: async () => '' }
    return { ok: true, status: 200, url: String(url), text: async () => store.versionText(found[1], version.n) }
  }

  const electronAPI = {
    getArtifacts: async () => { calls.getArtifacts++; return { artifacts: registry.list } },
    saveArtifactVersion: async () => ({ ok: true }),
    renameArtifact: async () => ({ ok: true }),
    archiveArtifact: async () => ({ ok: true }),
    revealArtifact: async () => ({ ok: true }),
    exportArtifact: async () => ({ ok: false, error: 'канала выгрузки ещё нет' }),
    onArtifactChanged: () => {}
  }

  const $ = id => {
    if (dom.byId.has(id)) return dom.byId.get(id)
    // Новый элемент на неизвестный id: панель вправе попросить узел, которого
    // пока нет в разметке, — заглушка отдаёт его и помнит, чтобы проверка увидела.
    const el = dom.createElement('div')
    el.setAttribute('id', id)
    dom.body.appendChild(el)
    dom.byId.set(id, el)
    return el
  }

  const panel = panelModule.create({
    $, t, escapeHtml, enhanceSelect: () => {}, openContextMenu: () => {},
    askConfirm: async () => true, electronAPI, document: dom.document
  })

  const flush = async () => {
    for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve))
  }

  const extraButtons = () => dom.descendants(panelEl)
    .filter(el => el.tagName === 'BUTTON' && !MARKUP_BUTTONS.has(el.getAttribute('id') || ''))

  return {
    dom, store, panel, artifact, calls, $, registry, panelEl, flush, add, extraButtons,
    // Строка галереи — кнопка внутри панели, в тексте которой есть номер версии,
    // «версия N» или год метки: имена узлов намеренно не используются, чтобы не
    // связывать проверку с разметкой, которой ещё нет.
    rows: () => extraButtons().filter(el => /(#\s*\d|верси[яи]\s*\d|\d{4})/i.test(allText(el))),
    click: async el => {
      assert.ok(el, 'клик запрошен по отсутствующей строке галереи')
      dom.fireClick(el)
      await flush()
    }
  }
}

const LOCAL_YEAR = 2026
const LOCAL_MONTH = 10
const HOUR = 60 * 60 * 1000

const formatsOf = artifact => {
  const fn = panelModule.artifactExportFormats || noDom().artifactExportFormats
  if (typeof fn !== 'function') throw new Error('artifactExportFormats не найдена ни в модуле, ни у панели')
  return fn(artifact)
}

const EXPECTED_FORMATS = {
  page: ['file', 'html', 'png'],
  chart: ['file', 'png', 'svg'],
  image: ['file', 'html', 'png'],
  table: ['file'],
  code: ['file'],
  diff: ['file']
}

async function main () {
  // --- чистая функция списка форматов -------------------------------------------

  await check('artifactExportFormats доступна наружу', async () => {
    const onModule = typeof panelModule.artifactExportFormats
    const onPanel = typeof noDom().artifactExportFormats
    if (onModule !== 'function' && onPanel !== 'function') {
      throw new Error(`artifactExportFormats не экспортируется: модуль — ${onModule}, панель — ${onPanel}`)
    }
  })

  for (const kind of Object.keys(EXPECTED_FORMATS)) {
    await check(`форматы выгрузки для «${kind}» — ${EXPECTED_FORMATS[kind].join(', ')}`, async () => {
      const list = formatsOf({ kind, id: 'арт', versions: [{ n: 1, at: 1, chars: 2, file: '1-x' }], current: 1 })
      assert.ok(Array.isArray(list), 'возвращается не список')
      assert.deepEqual(list.map(item => item.format).sort(), EXPECTED_FORMATS[kind],
        `${kind}: предложения выгрузки разъехались с контрактом`)
      if (EXPECTED_FORMATS[kind].length > 1) {
        assert.equal(list[0].format, 'file', `${kind}: «как есть» должно быть первым предложением`)
      }
    })
  }

  await check('форматы выгрузки для неизвестного вида и пустого артефакта — пусто', async () => {
    for (const artifact of [{ kind: 'exe' }, { kind: '' }, {}, null, undefined]) {
      const list = formatsOf(artifact)
      assert.ok(Array.isArray(list), `не список для ${JSON.stringify(artifact)}`)
      assert.deepEqual(list, [], `что-то предложено для ${JSON.stringify(artifact)}`)
    }
  })

  await check('подписи форматов — русские и не повторяются', async () => {
    for (const kind of Object.keys(EXPECTED_FORMATS)) {
      const list = formatsOf({ kind })
      const labels = list.map(item => item.label)
      assert.equal(labels.length, EXPECTED_FORMATS[kind].length,
        `${kind}: подписей ${labels.length}, форматов ${EXPECTED_FORMATS[kind].length}`)
      for (const label of labels) {
        assert.equal(typeof label, 'string', `${kind}: подпись не строка`)
        assert.ok(label.trim().length > 1, `${kind}: пустая подпись в меню`)
        assert.match(label, /[А-Яа-яЁё]/, `${kind}: подпись не по-русски: ${label}`)
      }
      assert.equal(new Set(labels).size, labels.length, `${kind}: подписи повторяются: ${labels.join(', ')}`)
    }
  })

  await check('artifactExportFormats не трогает DOM', async () => {
    // Именно ради этого она и проверяется узловым прогоном: список форматов должен
    // собираться из вида артефакта, а не из разобранного состояния панели.
    const panel = noDom()
    const fn = panelModule.artifactExportFormats || panel.artifactExportFormats
    assert.equal(typeof fn, 'function', 'artifactExportFormats не найдена')
    for (const kind of Object.keys(EXPECTED_FORMATS)) fn({ kind })
  })

  // --- галерея версий -------------------------------------------------------------

  // Три метки: две в один местный день с разницей в шесть часов (проверка, что
  // время показывается), третья — через местную полночь относительно UTC.
  const sameDayEarly = new Date(LOCAL_YEAR, LOCAL_MONTH, 20, 9, 5).getTime()
  const sameDayLate = sameDayEarly + 6 * HOUR
  const offsetMinutes = -new Date(sameDayEarly).getTimezoneOffset()
  const crossing = offsetMinutes >= 0
    ? Date.UTC(LOCAL_YEAR, LOCAL_MONTH, 21, 23, 30)
    : Date.UTC(LOCAL_YEAR, LOCAL_MONTH, 22, 0, 30)
  const localOfCrossing = new Date(crossing)

  await check('галерея показывает все версии показанного артефакта', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    assert.equal(rows.length, 3, `строк галереи ${rows.length}, версий 3`)
    for (const version of scene.artifact.versions) {
      expectRow(rows, version)
    }
  })

  await check('в строке — вид артефакта и размер в знаках', async () => {
    const scene = await makeScenario({ kind: 'code', contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    for (const version of scene.artifact.versions) {
      const row = expectRow(rows, version)
      assert.match(allText(row), /код/i, `в строке версии ${version.n} нет вида артефакта: ${allText(row)}`)
      assert.ok(tokens(allText(row)).includes(version.chars),
        `в строке версии ${version.n} нет размера «${version.chars} знаков»: ${allText(row)}`)
    }
  })

  await check('в строке — местная дата: год и день, а не число миллисекунд', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    for (const version of scene.artifact.versions) {
      const row = expectRow(rows, version)
      const numbers = tokens(allText(row))
      const local = new Date(version.at)
      assert.ok(numbers.includes(local.getFullYear()),
        `в строке версии ${version.n} нет года ${local.getFullYear()}: ${allText(row)}`)
      assert.ok(numbers.includes(local.getDate()),
        `в строке версии ${version.n} нет дня ${local.getDate()}: ${allText(row)}`)
      assert.equal(numbers.includes(version.at), false, `версия ${version.n} показана эпохой в миллисекундах`)
    }
  })

  await check('метка времени считается в местном часу, а не по UTC', async () => {
    if (offsetMinutes === 0) {
      console.log('   (часовой пояс = UTC — различить местное и utc время нечем, проверка пропущена)')
      return
    }
    assert.notEqual(localOfCrossing.getDate(), localOfCrossing.getUTCDate(),
      'сам харнесс подобрал метку, где местный день совпадает с utc')
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const row = expectRow(scene.rows(), scene.artifact.versions[2])
    const numbers = tokens(allText(row))
    assert.ok(numbers.includes(localOfCrossing.getDate()),
      `версия показана по utc: ждём местный день ${localOfCrossing.getDate()}, в строке «${allText(row)}» ` +
      `(utc-день ${localOfCrossing.getUTCDate()})`)
    assert.ok(numbers.includes(localOfCrossing.getFullYear()),
      `местный год не сошёлся: ${allText(row)}`)
  })

  await check('время в строке видно: две версии одного дня различаются', async () => {
    // «Дата без времени» превращает галерею в список одинаковых строк: версии,
    // рождённые в один день, человек не отличит и выберет наугад. Знаки у двух
    // версий нарочно одинаковые — иначе строки различались бы самим числом знаков,
    // и проверка зелёная не по той причине.
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'x'.repeat(120), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    const localFirst = new Date(sameDayEarly)
    const localSecond = new Date(sameDayLate)
    assert.equal(localFirst.getDate(), localSecond.getDate(), 'харнесс подобрал разные дни')
    // Метка времени — всё, что в строке не номер версии и не её размер.
    const stampOf = version => tokens(allText(expectRow(rows, version)))
      .filter(token => token !== version.n && token !== version.chars).join(',')
    const first = stampOf(scene.artifact.versions[0])
    const second = stampOf(scene.artifact.versions[1])
    assert.ok(first.length && second.length, `в строках нет ни одной метки времени: «${first}» / «${second}»`)
    assert.notEqual(first, second, `версии одного дня показывают одно время: ${first} = ${second}`)
  })

  await check('текущая версия помечена aria-current, и ровно одна', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    const marked = rows.filter(row => String(row.getAttribute('aria-current')) === 'true')
    assert.equal(marked.length, 1, `помечено ${marked.length} строк вместо одной: ${rows.map(allText).join(' | ')}`)
    const current = scene.artifact.versions.find(item => item.n === scene.artifact.current)
    assert.ok(rowFor(marked, current),
      `помечена не текущая версия ${scene.artifact.current}: ${allText(marked[0])}`)
    for (const row of rows.filter(item => item !== marked[0])) {
      assert.notEqual(String(row.getAttribute('aria-current')), 'true', 'двойная пометка')
      assert.notEqual(String(row.getAttribute('aria-current')), 'page', 'aria-current="page" — не про версии')
    }
  })

  await check('строки — настоящие кнопки type="button" с доступным именем', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    assert.ok(rows.length, 'строк галереи нет вовсе')
    for (const row of rows) {
      assert.equal(row.tagName, 'BUTTON', `строка галереи — ${row.tagName}, а не кнопка: ${allText(row)}`)
      assert.equal(row.getAttribute('type'), 'button',
        'у кнопки галереи нет type="button" — внутри формы это кнопка отправки')
      const name = (row.textContent || '').trim() || (row.getAttribute('aria-label') || '').trim()
      assert.ok(name.length > 3, `кнопка без доступного имени: ${allText(row)}`)
    }
    // Отдельно про «не div onclick»: слушатель обязан висеть на самой кнопке или
    // на её родителе — раздача кликов в заглушке идёт через события DOM.
  })

  await check('клик по строке переключает показанную версию существующим путём', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const before = { fetch: scene.calls.fetch.length, list: scene.calls.getArtifacts }
    const second = scene.artifact.versions.find(item => item.n === 2)
    await scene.click(expectRow(scene.rows(), second))
    assert.ok(scene.calls.fetch.length > before.fetch,
      'клик по строке не привёл к перечтению содержимого: показ идёт в обход showArtifact')
    const urls = scene.calls.fetch.slice(before.fetch)
    assert.ok(urls.some(url => url.endsWith('/' + second.file)),
      `прочитан не файл версии 2 (${second.file}): ${urls.join(', ')}`)
    assert.ok(scene.calls.getArtifacts > before.list,
      'список артефактов не перечитан — кликнули свою копию вместо пути показа окна')
    const meta = scene.$('artifactMeta').textContent
    assert.match(meta.replace(/\s+/g, ' '), /версия\s*2\s*из\s*3/i,
      `подпись внизу панели не переключилась: ${meta}`)
  })

  await check('после клика пометка «текущая» переезжает на выбранную строку', async () => {
    // aria-current описывает то, что человек видит в панели СЕЙЧАС: `current` у
    // артефакта — версия, которую последней записало хранилище, и после выбора
    // второй версии из семи она остаётся седьмой. Пометка, которая не едет, врёт
    // программам для чтения с экрана и человеку с клавиатуры.
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const first = scene.artifact.versions.find(item => item.n === 1)
    await scene.click(expectRow(scene.rows(), first))
    const marked = scene.rows().filter(row => String(row.getAttribute('aria-current')) === 'true')
    assert.equal(marked.length, 1, `помечено ${marked.length} строк после выбора версии 1`)
    assert.ok(rowFor(marked, first), `помечена не выбранная версия: ${allText(marked[0])}`)
  })

  await check('одна версия — галерея не показывает пустую оболочку', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120)] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    assert.equal(scene.rows().length, 0,
      `у артефакта с одной версией галерея показала ${scene.rows().length} строк: ${scene.rows().map(allText).join(' | ')}`)
    assert.match(scene.$('artifactText').textContent, /xxx/,
      'содержимое единственной версии перестало показываться вместе с галереей')
  })

  await check('версий нет — панель не падает и оболочки не показывает', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120)] })
    const empty = { ...scene.artifact, versions: [], current: 0, url: `onecode-artifact://${scene.artifact.id}/` }
    scene.registry.list = [empty]
    await scene.panel.showArtifact(empty)
    await scene.flush()
    assert.equal(scene.rows().length, 0, `без версий галерея показала строки: ${scene.rows().map(allText).join(' | ')}`)
  })

  await check('длинный список показывается целиком: 20 версий — 20 строк', async () => {
    // Предел хранилища (MAX_VERSIONS) проверяется в test-artifacts.cjs; здесь —
    // что окно не режет то, что уже отдало хранилище, и не прячет конец списка
    // за «ещё N», которого нельзя открыть. Размеры версий выбраны 100..119 знаков,
    // чтобы ни один из них не совпал с номером версии.
    const contents = Array.from({ length: 20 }, (_, i) => 'a'.repeat(100 + i))
    const scene = await makeScenario({ contents })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    const rows = scene.rows()
    assert.equal(rows.length, 20, `строк ${rows.length}, версий ${scene.artifact.versions.length}`)
    for (const version of scene.artifact.versions) {
      expectRow(rows, version)
    }
  })

  await check('строки живут внутри панели и не переходят на другой артефакт', async () => {
    const scene = await makeScenario({ contents: ['x'.repeat(120), 'y'.repeat(240), 'z'.repeat(360)], at: [sameDayEarly, sameDayLate, crossing] })
    await scene.panel.showArtifact(scene.artifact)
    await scene.flush()
    // Сначала требование, что строки вообще есть: без него проверка зелёная от
    // пустоты и не замечает, что галерею выбросили в конец <body>.
    assert.equal(scene.rows().length, 3, `строк галереи ${scene.rows().length}, версий 3`)
    for (const row of scene.rows()) {
      assert.equal(scene.panelEl.contains(row), true, `строка галереи висит вне панели: ${allText(row)}`)
    }
    const other = await scene.add({ kind: 'table', title: 'Тарифы', contents: ['план,цена'] })
    scene.panel.closeArtifactPanel()
    scene.registry.list = [other]
    await scene.panel.showArtifact(other)
    await scene.flush()
    assert.equal(scene.rows().length, 0,
      `после показа артефакта с одной версией остались строки прежнего: ${scene.rows().map(allText).join(' | ')}`)
  })

  for (const dir of trash) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* временная папка — не доказательство */ }
  }
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})

