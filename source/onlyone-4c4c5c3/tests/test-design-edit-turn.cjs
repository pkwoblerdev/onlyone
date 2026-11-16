// test-design-edit-turn.cjs — КРАСНЫЕ проверки шага 2 пункта 4.2: правка макета
// из чата идёт ХОДОМ ДИЗАЙНА, а не чатным движком, и только когда макет открыт
// в окне (решение владельца от 28.09).
//
// Набор написан ДО продуктового кода и обязан краснеть ПО ОТСУТСТВУЮЩЕМУ
// ПОВЕДЕНИЮ, а не падать на загрузке: первые две проверки — опорные («main.js
// загрузился в песочницу», «модуль карточки подключился»), остальные идут
// списком и каждая печатает, какого именно звена контракта не хватает.
//
// Что заморожено ведущим (и проверяется здесь):
//   1. Окно сообщает главному процессу, какой макет у него открыт, узким IPC
//      `design-focus` с нагрузкой `{ designId }` (`designId` — строка или null).
//      В мосту метод обязан быть в форме соседей: `electronAPI.designFocus(designId)`
//      → `ipcRenderer.invoke('design-focus', { designId })`, и окно обязанно звать
//      его литералом (иначе `test-audit` посчитает метод неиспользуемым).
//   2. `design_task` с `design_id` при открытом макете: главный процесс шлёт окну
//      `design-chat-edit` с `{ requestId, chatId, designId, component, instruction }`
//      и НЕ вызывает `dc_write` сам; правку делает окно своим обычным путём.
//   3. Если макет не открыт — правка не стартует: ни `dc_*`, ни `design-chat-edit`,
//      ни нового макета, ни роста версии; карточка пишет «ждёт — откроется при
//      следующем запуске», и ответ инструмента модели говорит то же словами.
//   4. Макет открыт, но его ход уже идёт — тоже «ждёт».
//   5. Обещание исполняется: когда окно позже сообщает `design-focus` об этом
//      макете, отложенная правка уходит тем же `design-chat-edit` ровно один раз и
//      перестаёт быть отложенной. Хранение — память главного процесса, не файл и
//      не TaskManager.
//   6. Повторная правка того же макета не заводит второй макет (закрыто в 4.2),
//      блокировка в файл не пишется.
//
// Чего в контракте НЕТ (набор зафиксировал сам, это названо в докладе):
//  • имена состояний карточки для двух новых случаев. Проверяются оба: модуль
//    обязан различить «правка идёт ходом Дизайна» и «ждёт — откроется при
//    следующем запуске» по любому из правдоподобных проводов (`status: 'turn-edit'`,
//    `status: 'waiting'`, флаг `waiting`/`viaTurn` при обычном `running`) — но
//    молчание (та же строка, что при сборке нового макета) засчитывается провалом;
//  • откуда главному процессу знать, что ход макета идёт: проверено настоящим
//    образом — через свой же канал `send-message` с `designId`, то есть ход
//    Дизайна реально идёт в момент правки.
//
// Electron для набора не нужен: главный процесс загружается в `vm`-песочницу с
// подставными `app`/`BrowserWindow`/`ipcMain`/`safeStorage`, хранилище дизайнов —
// настоящее, но в временном профиле и под шпионом вызовов, `executeDesignTool` —
// настоящий под записиывателем вызовов (кроме `dc_check`, который в песочнице не
// может отрисовать страницу). Сети нет: `fetch` бросает, тестовый провайдер не
// вызывается — ход держится дымовым фикстурным путём.
//
// Путь к исходнику главного процесса выводится переменной `ONECODE_MAIN_UNDER_TEST`
// (тот же приём, что в `tests/test-agent-browser-grants.cjs`), чтобы набор можно
// было прогнать на эталонной реализации.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')

const ROOT = path.join(__dirname, '..')
const MAIN_SOURCE = process.env.ONECODE_MAIN_UNDER_TEST || path.join(ROOT, 'src', 'main', 'main.js')
const PRELOAD_SOURCE = process.env.ONECODE_PRELOAD_UNDER_TEST || path.join(ROOT, 'src', 'preload', 'preload.js')
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer')
const CARD_SOURCE = path.join(RENDERER_DIR, 'design-task-card.js')
const I18N_SOURCE = path.join(RENDERER_DIR, 'i18n.js')

const WRITE_METHODS = new Set(['write', 'writeUnlocked', 'replace', 'setProps', 'setEntry', 'remove',
  'removeDesign', 'keepVersion', 'addRef', 'writeRef', 'removeRef', 'installRuntime', 'ensure'])

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + String((error && error.message) || error).split('\n')[0].slice(0, 500))
  }
}

// --- исходники ------------------------------------------------------------------

const read = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch { return '' }
}
const mainSource = read(MAIN_SOURCE)
const preloadSource = read(PRELOAD_SOURCE)
const cardSource = read(CARD_SOURCE)
const rendererSource = (() => {
  let names = []
  try { names = fs.readdirSync(RENDERER_DIR).filter(name => name.endsWith('.js')) } catch { names = [] }
  return names.map(name => ({ name, text: read(path.join(RENDERER_DIR, name)) }))
})()

// Тело верхнеуровневой функции: проверки по исходнику работают с участком, а не
// со всем файлом, иначе «имя встречается в файле» посчиталось бы проводкой.
function topLevelFn (source, name, file) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `в ${file} нет функции ${name}: проводку искать негде`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `функция ${name} не закрылась на уровне файла: участок не выделить`)
  return source.slice(start, end + 2)
}

// --- песочница главного процесса --------------------------------------------------

function makeElectronStub ({ userData, sent, windows }) {
  const noop = () => {}
  const handlers = new Map()
  const partition = {
    setPermissionRequestHandler: noop, setPermissionCheckHandler: noop,
    webRequest: { onBeforeRequest: noop, onBeforeRedirect: noop },
    protocol: { handle: noop, unhandle: noop, registerFileProtocol: noop },
    on: noop, clearStorageData: async () => {}, removeItem: async () => {}
  }
  const session = { fromPartition: () => partition, setPermissionRequestHandler: noop, on: noop,
    webRequest: { onBeforeRequest: noop }, protocol: { handle: noop, unhandle: noop },
    clearStorageData: async () => {}, cookies: { get: async () => [] } }
  class FakeWindow {
    constructor () {
      this.webContents = {
        id: windows.length + 1,
        send: (channel, body) => sent.push({ channel, body, via: 'window' }),
        on: noop, isDestroyed: () => false, loadFile: async () => {}, loadURL: async () => {},
        executeJavaScript: async () => undefined, setWindowOpenHandler: noop, getURL: () => 'about:blank'
      }
      windows.push(this)
    }
    on () {} loadFile () {} loadURL () {} show () {} close () {} focus () {} hide () {}
    isDestroyed () { return false }
    isVisible () { return true }
    static getAllWindows () { return windows }
  }
  return {
    handlers,
    electron: {
      app: {
        commandLine: { hasSwitch: name => name === 'user-data-dir', getSwitchValue: () => '', appendSwitch: noop, appendArgument: noop },
        setName: noop, getPath: () => userData, setPath: noop, whenReady: () => new Promise(() => {}),
        on: noop, quit: noop, getAppPath: () => ROOT, getVersion: () => '0', isPackaged: false,
        getName: () => 'onlyone', isReady: () => false, hide: noop, show: noop,
        dock: { setMenu: noop }, setLoginItemSettings: noop, relaunch: noop,
        requestSingleInstanceLock: () => true, getFileIcon: async () => ({})
      },
      BrowserWindow: FakeWindow,
      ipcMain: {
        handle: (channel, fn) => { handlers.set(channel, fn); return true },
        handleOnce: (channel, fn) => { handlers.set(channel, fn); return true },
        on: noop, once: noop, removeHandler: channel => handlers.delete(channel),
        hasListener: () => true, removeAllListeners: noop
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: value => Buffer.from(String(value)),
        decryptString: bytes => Buffer.from(bytes).toString('utf8')
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
        showMessageBox: async () => ({ response: 0 })
      },
      session,
      shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop, trashItem: async () => {} },
      protocol: { registerSchemesAsPrivileged: noop, handle: () => true, registerFileProtocol: noop },
      net: { request: () => ({ on: noop, end: noop, write: noop }) },
      Menu: class { static buildFromTemplate () { return { popup: noop } } setApplicationMenu () {} },
      MenuItem: class {}, Tray: class {},
      Notification: class { static isSupported () { return false } show () {} },
      clipboard: { readText: () => '', writeText: noop },
      nativeImage: { createFromDataURL: () => ({ toPNG: () => Buffer.from('') }) },
      powerMonitor: { on: noop },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) },
      webContents: { getAllContents: () => [] }
    }
  }
}

class FakeSettingsStore {
  constructor (log) { this.map = new Map(); this.log = log }
  get (key, fallback) { return this.map.has(key) ? this.map.get(key) : fallback }
  set (key, value) { this.log.push(key); this.map.set(key, value) }
  has (key) { return this.map.has(key) }
  delete (key) { this.map.delete(key) }
  clear () { this.map.clear() }
  onDidAnyChange () { return () => {} }
}

// Один запуск главного процесса: свой временный профиль, свои шпионы.
function bootMain (opts = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-edit-turn-'))
  const sent = []
  const windows = []
  const toolCalls = []
  const storeCalls = []
  const settingsWrites = []
  const { handlers, electron } = makeElectronStub({ userData, sent, windows })
  const src = fs.readFileSync(MAIN_SOURCE, 'utf8')
  // Относительные `require` разбираются ОТ НАСТОЯЩЕГО `src/main`, а читается тот
  // файл, что назван `ONECODE_MAIN_UNDER_TEST`: иначе копия главного процесса для
  // прогона на эталонной реализации не нашла бы `./design/tools`.
  const requireBase = path.join(ROOT, 'src', 'main', 'main.js')
  const realRequire = Module.createRequire(requireBase)
  const cache = new Map()
  const designStoreInstances = []

  const sandboxRequire = id => {
    if (id === 'electron') return electron
    if (id === 'electron-store') return class extends FakeSettingsStore { constructor () { super(settingsWrites) } }
    const real = realRequire(id)
    if (id === './design/tools' && real && typeof real.executeDesignTool === 'function') {
      if (!cache.has(id)) {
        cache.set(id, Object.assign({}, real, {
          executeDesignTool (params) {
            toolCalls.push({ name: String((params && params.name) || ''), args: (params && params.args) || null })
            // Отрисовку в песочнице проверить нечем: скрытое окно заглушки ничего
            // не загружает. Проверка отрисовки — дело оконного прогона, здесь же
            // важно лишь то, ЗВАЛ ли чатный путь движок.
            if (params && params.name === 'dc_check') return Promise.resolve({ success: true, passed: true, problems: [] })
            return real.executeDesignTool(params)
          }
        }))
      }
      return cache.get(id)
    }
    if (id === './design/store' && real && typeof real.DesignStore === 'function') {
      if (!cache.has(id)) {
        const Base = real.DesignStore
        class SpiedStore extends Base {
          constructor (...args) {
            super(...args)
            designStoreInstances.push(this)
            for (const name of Object.getOwnPropertyNames(Base.prototype)) {
              if (name === 'constructor') continue
              const value = Base.prototype[name]
              if (typeof value !== 'function') continue
              this[name] = (...callArgs) => { storeCalls.push(name); return value.apply(this, callArgs) }
            }
          }
        }
        cache.set(id, Object.assign({}, real, { DesignStore: SpiedStore }))
      }
      return cache.get(id)
    }
    return real
  }
  sandboxRequire.resolve = id => (id === 'electron' || id === 'electron-store' ? id : realRequire.resolve(id))
  sandboxRequire.cache = realRequire.cache

  const ctx = {
    require: sandboxRequire, module: { exports: {} }, exports: {},
    __dirname: path.dirname(requireBase), __filename: requireBase, console,
    process: {
      env: Object.assign({}, opts.env), platform: process.platform, argv: [],
      on: () => () => {}, exit: () => {}, versions: process.versions, cwd: () => ROOT,
      hrtime: process.hrtime, memoryUsage: () => ({ rss: 0 }), type: 'browser'
    },
    Buffer, setTimeout, setInterval, clearTimeout, clearInterval, setImmediate,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
    structuredClone, performance,
    fetch: async () => { throw new Error('в проверке сети нет') }
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx, { filename: MAIN_SOURCE })

  const frame = { url: require('node:url').pathToFileURL(path.join(ROOT, 'src/renderer/index.html')).href }
  const sender = { id: 1, mainFrame: frame, getType: () => 'window', isDestroyed: () => false, send: (channel, body) => sent.push({ channel, body, via: 'sender' }) }
  const event = { sender, senderFrame: frame, frames: [] }

  const run = {
    ctx, handlers, sent, toolCalls, storeCalls, settingsWrites, event, userData, windows,
    designsRoot: () => path.join(userData, 'designs'),
    inContext: code => vm.runInContext(code, ctx),
    fire (channel, ...args) {
      const fn = handlers.get(channel)
      if (typeof fn !== 'function') throw new Error('НЕТ ОБРАБОТЧИКА: ' + channel)
      return fn(event, ...args)
    },
    channels: () => sent.map(item => item.channel),
    payloads: channel => sent.filter(item => item.channel === channel).map(item => item.body),
    resetLogs () { toolCalls.length = 0; storeCalls.length = 0; settingsWrites.length = 0; sent.length = 0 },
    async designTask (args, requestId) {
      return await ctx.designTask(event, args, requestId, null)
    },
    // Единственный документированный способ сказать главному процессу, какой
    // макет открыт: тот же узкий IPC, что вводит контракт.
    async reportFocus (designId) {
      if (typeof handlers.get('design-focus') !== 'function') {
        throw new Error('нет контракта: главный процесс не слушает канал `design-focus`, ' +
          'ему неизвестно, какой макет открыт в окне, — правка ходом Дизайна не могла начаться')
      }
      return await handlers.get('design-focus')(event, { designId })
    },
    designStore: () => {
      // Хранилище ленивое: заведение макета не должно зависеть от того, случился
      // ли уже в песочнице первый дизайн-вызов.
      if (!designStoreInstances.length) run.inContext('ensureDesignStore()')
      if (!designStoreInstances.length) throw new Error('нет контракта: главный процесс не создал хранилище дизайнов')
      return designStoreInstances[designStoreInstances.length - 1]
    },
    writes: () => storeCalls.filter(name => WRITE_METHODS.has(name)),
    tree: () => {
      const out = []
      const walk = (dir, prefix) => {
        let entries = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          out.push(rel)
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
        }
      }
      walk(run.designsRoot(), '')
      return out
    },
    cleanup () { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* временный профиль — не доказательство */ } }
  }
  return run
}

// Макет в реестре и на диске — тем же способом, каким их заводит окно: реестр по
// каналу `set-designs`, страница — настоящим хранилищем в том же профиле.
async function seedDesign (run, { id, chatId, topic, component, version }) {
  const store = run.designStore()
  await store.write(id, component, { template: `<h1>${topic}</h1><p>МИШЕНА-ДО-ПРАВКИ</p>`, logic: '', props: '' })
  await run.fire('set-designs', [{ id, name: topic, chatId, component, version, createdAt: 1, updatedAt: 1 }])
  run.resetLogs()
  return store
}

// Ответ инструмента модели — одной строкой: поля в контракте не зафиксированы,
// важнее, что модель вообще прочитала.
function answerText (result) {
  if (!result || typeof result !== 'object') return String(result ?? '')
  return [result.error, result.message, result.hint, result.answer, result.content, result.status,
    JSON.stringify(result)].filter(Boolean).join(' ')
}

// --- карточка: минимальная DOM-заглушка ------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'source'])
const decodeEntities = text => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

function makeDom () {
  const mkText = value => ({ nodeType: 3, textContent: String(value), parentNode: null })
  const textOf = node => node.nodes.map(child => (child.nodeType === 3 ? child.textContent : textOf(child))).join('')
  const serialize = node => node.nodes.map(child => {
    if (child.nodeType === 3) return child.textContent
    const attrs = [...child.attrs.entries()].map(([key, value]) => ` ${key}="${String(value)}"`).join('')
    return `<${child.tag.toLowerCase()}${attrs}>${serialize(child)}</${child.tag.toLowerCase()}>`
  }).join('')
  const detach = node => {
    const parent = node && node.parentNode
    if (!parent) return
    const at = parent.nodes.indexOf(node)
    if (at >= 0) parent.nodes.splice(at, 1)
    node.parentNode = null
    node.parentElement = null
  }
  const adopt = (parent, node) => {
    detach(node)
    node.parentNode = parent
    if (parent.nodeType === 1) node.parentElement = parent
    parent.nodes.push(node)
    return node
  }
  const descendantsOf = root => {
    const out = []
    const walk = node => { for (const child of node.nodes) if (child.nodeType === 1) { out.push(child); walk(child) } }
    walk(root)
    return out
  }
  const matches = (el, selector) => {
    for (const part of String(selector).split(',').map(item => item.trim()).filter(Boolean)) {
      const tag = /^[a-zA-Z][\w-]*/.exec(part)
      if (tag && el.tag !== tag[0].toUpperCase()) continue
      const rest = part.slice(tag ? tag[0].length : 0)
      let ok = true
      for (const bit of rest.match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
        if (bit[0] === '#') ok = ok && el.getAttribute('id') === bit.slice(1)
        else if (bit[0] === '.') ok = ok && (el.getAttribute('class') || '').split(/\s+/).includes(bit.slice(1))
        else ok = ok && el.hasAttribute(bit.slice(1, -1))
      }
      if (ok) return true
    }
    return false
  }
  const parse = source => {
    const roots = []
    const stack = []
    const push = node => { const parent = stack[stack.length - 1]; if (parent) adopt(parent, node); else roots.push(node) }
    const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g
    let match
    while ((match = re.exec(String(source)))) {
      if (match[1]) {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === match[1].toUpperCase()) { stack.length = i; break }
        continue
      }
      if (match[2]) {
        const el = createElement(match[2])
        const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
        let attr
        while ((attr = attrRe.exec(match[3] || ''))) {
          const value = attr[2] !== undefined ? decodeEntities(attr[2])
            : attr[3] !== undefined ? decodeEntities(attr[3])
              : attr[4] !== undefined ? decodeEntities(attr[4]) : ''
          el.setAttribute(attr[1], value)
        }
        push(el)
        if (match[4] !== '/' && !VOID_TAGS.has(el.tag.toLowerCase())) stack.push(el)
        continue
      }
      if (match[5]) push(mkText(decodeEntities(match[5])))
    }
    return roots
  }
  function createElement (tag) {
    const el = {
      nodeType: 1, tag: String(tag).toUpperCase(), nodes: [], attrs: new Map(), listeners: [],
      parentNode: null, parentElement: null, dataset: {}, style: {}, hidden: false, disabled: false,
      setAttribute (name, value) { el.attrs.set(String(name).toLowerCase(), String(value)) },
      getAttribute (name) { const key = String(name).toLowerCase(); return el.attrs.has(key) ? el.attrs.get(key) : null },
      hasAttribute (name) { return el.getAttribute(name) !== null },
      removeAttribute (name) { el.attrs.delete(String(name).toLowerCase()) },
      appendChild (node) { return adopt(el, node) },
      append (...nodes) { for (const node of nodes) adopt(el, typeof node === 'string' ? mkText(node) : node) },
      replaceChildren (...nodes) { el.nodes.slice().forEach(detach); for (const node of nodes) adopt(el, node) },
      remove () { detach(el) },
      addEventListener (type, fn) { el.listeners.push({ type, fn }) },
      removeEventListener (type, fn) {
        const at = el.listeners.findIndex(item => item.type === type && item.fn === fn)
        if (at >= 0) el.listeners.splice(at, 1)
      },
      querySelector (selector) { return descendantsOf(el).find(node => matches(node, selector)) || null },
      querySelectorAll (selector) { return descendantsOf(el).filter(node => matches(node, selector)) },
      click () {
        const ev = { type: 'click', target: el, preventDefault () {}, stopPropagation () {} }
        let current = el
        while (current) {
          for (const item of current.listeners.filter(entry => entry.type === 'click')) item.fn(ev)
          if (typeof current.onclick === 'function') current.onclick(ev)
          current = current.parentElement
        }
      },
      scrollIntoView () {},
      getBoundingClientRect () { return { top: 10, bottom: 210, width: 300, height: 200 } }
    }
    Object.defineProperties(el, {
      tagName: { get () { return el.tag } },
      children: { get () { return el.nodes.filter(node => node.nodeType === 1) } },
      textContent: {
        get () { return textOf(el) },
        set (value) { el.nodes.slice().forEach(detach); if (value !== '' && value != null) adopt(el, mkText(String(value))) }
      },
      innerHTML: {
        get () { return serialize(el) },
        set (value) { el.nodes.slice().forEach(detach); for (const node of parse(value)) adopt(el, node) }
      },
      className: { get () { return el.getAttribute('class') || '' }, set (value) { el.setAttribute('class', value) } },
      classList: {
        get () {
          const list = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
          const put = items => el.setAttribute('class', items.join(' '))
          return {
            add: (...names) => put([...new Set([...list(), ...names])]),
            remove: (...names) => put(list().filter(item => !names.includes(item))),
            contains: name => list().includes(name),
            toggle: (name, force) => { const want = force === undefined ? !list().includes(name) : Boolean(force); if (want) put([...new Set([...list(), name])]); else put(list().filter(item => item !== name)); return want }
          }
        }
      }
    })
    return el
  }
  const body = createElement('BODY')
  const list = createElement('DIV')
  list.setAttribute('id', 'messagesList')
  list.setAttribute('class', 'messages-list')
  list.setAttribute('data-chat-id', 'чат-А')
  adopt(body, list)
  const document = {
    body,
    createElement,
    createTextNode: mkText,
    addEventListener () {},
    removeEventListener () {},
    querySelector: selector => (matches(body, selector) ? body : descendantsOf(body).find(node => matches(node, selector)) || null),
    querySelectorAll: selector => descendantsOf(body).filter(node => matches(node, selector))
  }
  return { body, document, list, descendants: descendantsOf, createElement }
}

// --- проверки ---------------------------------------------------------------------

const TOPIC = 'Лендинг доставки цветов'
const BRIEF_NEW = 'Одностраничный сайт доставки цветов: первый экран, тарифы, форма заказа'
const INSTRUCTION = 'Сделай заголовок крупнее'
const CHAT = 'чат-А'
const DESIGN = 'dproof42'

// Формы, которыми главный процесс может объявить отложенную правку (имена в
// контракте не зафиксированы — перебираем правдоподобные).
const TURN_EDIT_SHAPES = [
  { status: 'turn-edit' }, { status: 'edit-turn' }, { status: 'design-turn' }, { status: 'running-turn' },
  { status: 'running', viaTurn: true }, { status: 'running', editViaDesignTurn: true },
  { status: 'running', kind: 'chat-edit' }
]
const WAITING_SHAPES = [
  { status: 'waiting' }, { status: 'queued' }, { status: 'pending' }, { status: 'held' }, { status: 'deferred' },
  { status: 'running', waiting: true }, { status: 'running', deferred: true }, { status: 'running', reason: 'design-not-open' }
]

function cardScene () {
  const dom = makeDom()
  const sent = []
  const electronAPI = { onDesignTaskEvent: cb => { sent.push(cb); return () => {} } }
  let card = null
  let loadError = null
  try {
    const mod = require(CARD_SOURCE)
    const api = mod.create({
      $: id => (id === 'messagesList' ? dom.list : dom.createElement('div')),
      t: (text, ...args) => { let i = 0; return String(text).replace(/%s/g, () => String(args[i++])) },
      escapeHtml: value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
      electronAPI, document: dom.document, openDesign: () => {}
    })
    card = api
  } catch (error) { loadError = error }
  return { dom, card, loadError, api: card }
}

// Карточка по маркеру задачи: ищем по тексту брифа, а не по классу.
function cardTextFor (scene, over, marker) {
  const api = scene.card
  if (!api || typeof api.onDesignTaskEvent !== 'function') throw new Error('нет контракта: модуль карточки не отдаёт onDesignTaskEvent')
  api.onDesignTaskEvent(Object.assign({
    chatId: CHAT, taskId: 'задача-' + marker, designId: DESIGN, component: 'Home.dc.html',
    version: 1, status: 'running', brief: `Правка «${marker}» макета`
  }, over))
  const nodes = scene.dom.list.nodes.filter(node => node.nodeType === 1 && String(node.textContent).includes(marker))
  if (!nodes.length) throw new Error(`карточка «${marker}» не появилась в ленте: ${String(scene.dom.list.textContent).slice(0, 160)}`)
  return String(nodes[0].textContent).replace(/\s+/g, ' ').trim()
}

async function main () {
  // 1 — опорная зелёная: песочница вообще работала бы, а не падала на загрузке.
  await check('опора: main.js загружается в песочницу, designTask есть, каналы окна зарегистрированы', async () => {
    assert.ok(mainSource, `не читается ${MAIN_SOURCE} — проверки главного процесса слепы`)
    const run = bootMain()
    try {
      assert.equal(typeof run.ctx.designTask, 'function',
        'в загруженном main.js нет верхнеуровневой функции designTask — вызывать нечего')
      assert.ok(run.handlers.size > 40, `ipcMain.handle зарегистрировал только ${run.handlers.size} каналов`)
      assert.equal(typeof run.handlers.get('set-designs'), 'function', 'нет канала set-designs — реестр нечем засеять')
    } finally { run.cleanup() }
  })

  // 2 — опорная зелёная: модуль карточки подключается, движок задачи есть.
  await check('опора: модуль карточки подключается, движок задачи экспортируется', async () => {
    assert.ok(fs.existsSync(CARD_SOURCE), 'нет файла src/renderer/design-task-card.js')
    const scene = cardScene()
    assert.ok(!scene.loadError, 'модуль карточки не подключается: ' + (scene.loadError && scene.loadError.message))
    assert.equal(typeof scene.card.onDesignTaskEvent, 'function', 'у карточки нет onDesignTaskEvent')
    const task = require(path.join(ROOT, 'src', 'main', 'design', 'task.js'))
    assert.equal(typeof task.createDesignTask, 'function', 'движок задачи не экспортирует createDesignTask')
  })

  // 3 — КРАСНАЯ: узкий IPC фокуса.
  await check('main.js: ipcMain.handle(«design-focus») и мост electronAPI.designFocus', async () => {
    const run = bootMain()
    try {
      assert.equal(typeof run.handlers.get('design-focus'), 'function',
        'нет контракта: в главном процессе не зарегистрирован обработчик канала `design-focus` — ' +
        'окно не сообщает, какой макет открыт, и правка ходом Дизайна не могла появиться')
      assert.match(mainSource, /ipcMain\.handle\(\s*'design-focus'/,
        'в исходнике main.js нет литерала ipcMain.handle(\'design-focus\' — проводка ищется по нему')
    } finally { run.cleanup() }
  })

  // 4 — КРАСНАЯ: форма метода моста + вызов из окна (иначе test-audit считает
  // метод неиспользуемым).
  await check('preload.js: designFocus → invoke(«design-focus», { designId }); окно зовёт метод литералом', async () => {
    assert.ok(preloadSource, `не читается ${PRELOAD_SOURCE}`)
    assert.match(preloadSource, /designFocus\s*:\s*[\w$]+\s*=>\s*ipcRenderer\.invoke\(\s*'design-focus'\s*,\s*\{\s*designId\s*\}\s*\)/,
      'нет контракта: в мосту нет designFocus(designId) → ipcRenderer.invoke(\'design-focus\', { designId }) ' +
      'в той же форме, что соседние методы')
    const callers = rendererSource.filter(item => /electronAPI\.designFocus\(/.test(item.text)).map(item => item.name)
    assert.ok(callers.length,
      'нет контракта: ни один файл окна не вызывает electronAPI.designFocus( — метод был бы неиспользуемым ' +
      'для test-audit, а фокус главному процессу нечем сообщить. Проверенные файлы: ' +
      rendererSource.map(item => item.name).join(', '))
  })

  // 5 — КРАСНАЯ: правка при открытом макете идёт ходом Дизайна.
  await check('правка при открытом макете: событие design-chat-edit, движок не тронут', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      run.resetLogs()
      const result = await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-open')
      const edit = run.payloads('design-chat-edit')
      assert.ok(edit.length >= 1,
        `нет контракта: при открытом макете правка не ушла ходом Дизайна — событий design-chat-edit нет ` +
        `(каналов в окне: ${run.channels().join(', ') || 'ни одного'}; ответ модели: ${answerText(result).slice(0, 160)})`)
      const body = edit[0] || {}
      for (const field of ['requestId', 'chatId', 'designId', 'component', 'instruction']) {
        assert.ok(body[field] != null && String(body[field]) !== '', `в нагрузке design-chat-edit нет поля ${field}: ${JSON.stringify(body)}`)
      }
      assert.equal(String(body.requestId), 'req-open', `requestId не тот: ${JSON.stringify(body)}`)
      assert.equal(String(body.designId), DESIGN, `designId не тот: ${JSON.stringify(body)}`)
      assert.equal(String(body.chatId), CHAT, `chatId не тот: ${JSON.stringify(body)}`)
      assert.equal(String(body.instruction), INSTRUCTION, `instruction не дошло: ${JSON.stringify(body)}`)
      const writes = run.toolCalls.filter(call => ['dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_scaffold'].includes(call.name))
      assert.deepEqual(writes.map(call => call.name), [],
        `главный процесс сам правит макет (ожидается ноль обращений к записи): ${writes.map(c => c.name).join(', ')}`)
      assert.deepEqual(run.writes(), [],
        `правка при открытом макете написала в хранилище сама: ${run.writes().join(', ')}`)
      const registry = await run.fire('get-designs')
      assert.equal(registry.length, 1, `правка завела второй макет в реестре: ${JSON.stringify(registry.map(item => item.id))}`)
    } finally { run.cleanup() }
  })

  // 6 — КРАСНАЯ: правка при закрытом макете не стартует и говорит о ожидании.
  await check('правка при макете, НЕ открытом в окне: движок молчит, модель получает слово «ждёт»', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      const before = run.tree()
      const result = await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-closed')
      assert.deepEqual(run.toolCalls.map(call => call.name), [],
        `нет контракта: макет не открыт в окне, а чатный путь уже зовёт движок: ${run.toolCalls.map(c => c.name).join(', ')}`)
      assert.deepEqual(run.channels().filter(channel => channel === 'design-chat-edit'), [],
        'правка при закрытом окне ушла ходом Дизайна — а должна была остаться в ожидании')
      assert.deepEqual(run.writes(), [], `отложенная правка что-то записала в хранилище: ${run.writes().join(', ')}`)
      const registry = await run.fire('get-designs')
      assert.equal(registry.length, 1, `появился второй макет: ${JSON.stringify(registry.map(item => item.id))}`)
      assert.equal(Number(registry[0].version), 1, `версия выросла без работы: ${JSON.stringify(registry[0].version)}`)
      assert.deepEqual(run.tree().filter(rel => !before.includes(rel)), [],
        `отложенная правка оставила файлы в профиле дизайнов: ${run.tree().filter(rel => !before.includes(rel)).join(', ')}`)
      const events = run.payloads('design-task-event')
      assert.equal(events.filter(item => item && String(item.status).toLowerCase() === 'ready').length, 0,
        `окну сказали «готово», хотя правка даже не начиналась: ${events.map(item => item && item.status).join(', ')}`)
      const text = answerText(result)
      assert.match(text, /жд[её]т|жд[её]м|не начал|не стартов|отложен/i,
        `нет контракта: ответ инструмента модели не говорит, что правка ждёт: ${text.slice(0, 200)}`)
      assert.match(text, /следующ|запуск|откро/ ,
        `нет контракта: в ответе модели нет обещания «откроется при следующем запуске»: ${text.slice(0, 200)}`)
    } finally { run.cleanup() }
  })

  // 6a — СТРАХОВКА (не сломать 4.2): правка меняется, сборка нового макета — нет.
  await check('страховка: новый макет без design_id собирается чатным движком и при закрытом окне', async () => {
    const run = bootMain()
    try {
      run.inContext('lastTurnHere = { chatId: "чат-Б", projectId: null, chatFolders: [], projectFolders: [] }')
      const result = await run.designTask({ brief: BRIEF_NEW, topic: 'Сайт практик Тишина' }, 'req-new')
      assert.equal(run.channels().includes('design-chat-edit'), false,
        'сборку нового макета зачем-то отправили в ход Дизайна — окно его не открывало')
      assert.ok(run.toolCalls.length > 0,
        `новый макет ничего не записал движком: ответ ${answerText(result).slice(0, 160)}`)
      const registry = await run.fire('get-designs')
      assert.ok(registry.length >= 1, 'нового макета в реестре не появилось')
    } finally { run.cleanup() }
  })

  // 7 — КРАСНАЯ: макет занят своим ходом — тоже ожидание.
  await check('правка при занятом макете (ход Дизайна идёт): тот же отказ стартовать', async () => {
    const fixture = path.join(os.tmpdir(), 'onecode-edit-turn-fixture-' + Date.now().toString(36) + '.json')
    fs.writeFileSync(fixture, JSON.stringify({
      content: 'Ход Дизайна идёт.',
      toolStream: { tool: 'artifacts_list', args: {}, hold: 1200 }
    }))
    const run = bootMain({ env: { ONECODE_SMOKE: '1', ONECODE_SMOKE_FIXTURE: fixture } })
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      const focused = await run.reportFocus(DESIGN).then(() => true, () => false)
      assert.ok(focused, 'нет контракта: канал design-focus не зарегистрирован — чем объявить макет открытым?')
      run.resetLogs()
      const turn = Promise.resolve(run.fire('send-message', {
        requestId: 'run-design-1', chatId: CHAT, designId: DESIGN, designName: TOPIC,
        model: 'test/model', messages: [{ role: 'user', content: 'переставь заголовок' }], designComments: []
      }))
      let caught = null
      turn.catch(error => { caught = error })
      // Ждём, пока ход Дизайна действительно заведён: без этого проверка ниже
      // тестировала бы «не занято».
      const started = Date.now()
      while (Date.now() - started < 5000 && run.inContext('activeAbortControllers.has("run-design-1")') !== true) {
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      assert.equal(run.inContext('activeAbortControllers.has("run-design-1")'), true,
        'харнесс не смог завести настоящий ход Дизайна — проверка занятости повисла бы в слепой зоне')
      const result = await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-busy')
      assert.deepEqual(run.toolCalls.map(call => call.name), [],
        `нет контракта: макет занят ходом Дизайна, а правка всё-таки пошла в движок: ${run.toolCalls.map(c => c.name).join(', ')}`)
      assert.deepEqual(run.channels().filter(channel => channel === 'design-chat-edit'), [],
        'правка влетела ходом Дизайна поверх идущего хода того же макета')
      assert.match(answerText(result), /жд[её]т|жд[её]м|занят|не начал|отложен/i,
        `на занятом макете модель получила не слово об ожидании: ${answerText(result).slice(0, 200)}`)
      await new Promise(resolve => setTimeout(resolve, 1800))
      void caught
      fs.rmSync(fixture, { force: true })
    } finally { run.cleanup() }
  })

  // 8 — КРАСНАЯ: обещание «откроется при следующем запуске» исполняется.
  await check('отложенная правка уходит design-chat-edit ровно один раз после design-focus', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-defer')
      run.resetLogs()
      await run.reportFocus(DESIGN)
      const first = run.payloads('design-chat-edit')
      assert.equal(first.length, 1,
        `нет контракта: после того как окно сообщило design-focus, отложенная правка ушла ${first.length} раз вместо одного`)
      const body = first[0] || {}
      assert.equal(String(body.designId), DESIGN, `отложенная правка ушла не про свой макет: ${JSON.stringify(body)}`)
      assert.equal(String(body.instruction), INSTRUCTION, `отложенная просьба потерялась: ${JSON.stringify(body)}`)
      run.resetLogs()
      // Второе сообщение о том же фокусе (окно перерисовалось, человек вернулся)
      // не имеет права повторить правку.
      await run.reportFocus(DESIGN)
      assert.deepEqual(run.payloads('design-chat-edit'), [], 'отложенная правка ушла повторно: из очереди она не снята')
      // И следующая правка того же макета идёт сразу, а не копится к старой.
      run.resetLogs()
      await run.designTask({ brief: 'Убери блок тарифов', topic: TOPIC, design_id: DESIGN, instruction: 'Убери блок тарифов' }, 'req-next')
      const next = run.payloads('design-chat-edit')
      assert.equal(next.length, 1, `правка при открытом макете не ушла сразу: событий ${next.length}`)
      assert.equal(String((next[0] || {}).instruction), 'Убери блок тарифов', 'ушла не та правка — очередь не разобрана')
      assert.deepEqual(run.writes(), [], `главный процесс писал в макет сам: ${run.writes().join(', ')}`)
    } finally { run.cleanup() }
  })

  // 9 — КРАСНАЯ: очередь отложенных — только память главного процесса.
  await check('отложенная правка живёт в памяти: ни файла, ни записи в реестр, ни блокировки', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      const before = run.tree()
      run.resetLogs()
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-mem')
      assert.deepEqual(run.writes(), [],
        `нет контракта: макет не открыт, правка должна только подождать, а хранилище дизайнов тронулось записью: ${run.writes().join(', ')}`)
      assert.deepEqual(run.settingsWrites, [],
        `нет контракта: отложенная правка легла в настройки (обещана память главного процесса): ${run.settingsWrites.join(', ')}`)
      assert.deepEqual(run.tree().filter(rel => !before.includes(rel)), [],
        `нет контракта: отложенная правка создала файлы в профиле дизайнов: ${run.tree().filter(rel => !before.includes(rel)).join(', ')}`)
      const registry = await run.fire('get-designs')
      const entry = registry.find(item => item && item.id === DESIGN) || {}
      assert.equal(entry.locked, undefined, 'в реестр легла блокировка макета')
      assert.equal(/pending|queue|defer|отложен/i.test(JSON.stringify(entry)), false,
        `в реестре макета появились отложенные правки: ${JSON.stringify(entry)}`)
    } finally { run.cleanup() }
  })

  // 10 — КРАСНАЯ: карточка различает два новых состояния.
  await check('карточка: «правка идёт ходом Дизайна» — отдельное состояние, не сборка нового макета', async () => {
    const base = cardScene()
    const plain = cardTextFor(base, { status: 'running' }, 'МИШЕНА-СБОРКА')
    const seen = []
    for (const shape of TURN_EDIT_SHAPES) {
      const scene = cardScene()
      const marker = 'МИШЕНА-' + (shape.status || 'running') + '-' + Object.keys(shape).join('-')
      let text = ''
      try { text = cardTextFor(scene, Object.assign({}, shape, { brief: `Правка «${marker}» макета` }), marker) } catch { continue }
      seen.push(`${JSON.stringify(shape)} → ${text.slice(0, 90)}`)
      if (/правк/i.test(text) && /ход|дизайна/i.test(text) && text !== plain) {
        assert.ok(true)
        return
      }
      void scene
    }
    throw new Error('нет контракта: карточка не показывает состояние «правка идёт ходом Дизайна» ни в одном из ' +
      `предложенных проводов (обычная сборка: «${plain}»); проверено: ${seen.join(' | ') || 'ни одна карточка не построена'}`)
  })

  await check('карточка: «ждёт — откроется при следующем запуске» — отдельно от сборки и без кадра', async () => {
    const base = cardScene()
    const plain = cardTextFor(base, { status: 'running' }, 'МИШЕНА-СБОРКА-2')
    const seen = []
    for (const shape of WAITING_SHAPES) {
      const scene = cardScene()
      const marker = 'МИШЕНА-ЖДДТ-' + (shape.status || 'running') + '-' + Object.keys(shape).join('-')
      let text = ''
      try { text = cardTextFor(scene, Object.assign({}, shape, { brief: `Правка «${marker}» макета` }), marker) } catch { continue }
      seen.push(`${JSON.stringify(shape)} → ${text.slice(0, 90)}`)
      const waitingWords = /жд[её]т|жд[её]м/.test(text)
      const promiseWords = /следующ|запуск|откро/.test(text)
      if (waitingWords && promiseWords && text !== plain) {
        const cardNode = scene.dom.list.nodes.find(node => String(node.textContent).includes(marker))
        const frames = cardNode ? scene.dom.descendants(cardNode).filter(node => node.tag === 'IFRAME') : []
        assert.deepEqual(frames, [], `на «ждёт» кадр показывать нечего: ${frames.map(node => node.getAttribute('src')).join(', ')}`)
        const openers = cardNode ? scene.dom.descendants(cardNode).filter(node => node.tag === 'BUTTON' &&
          /откры/i.test(node.textContent || '') && /дизайн/i.test(node.textContent || '')) : []
        assert.deepEqual(openers.filter(node => node.hidden !== true && node.disabled !== true).map(node => node.textContent), [],
          'на «ждёт» есть активная кнопка «Открыть в Дизайне» — макет-то не тронут')
        return
      }
    }
    throw new Error('нет контракта: карточка не пишет «ждёт — откроется при следующем запуске» ни в одном из ' +
      `предложенных проводов (обычная сборка: «${plain}»); проверено: ${seen.join(' | ') || 'ни одна карточка не построена'}`)
  })

  // 11 — КРАСНАЯ: провода главного процесса для карточки существуют (окно обязано
  // получить чем построить эти состояния).
  await check('main.js: событие для правки ходом Дизайна доходит до окна каналом design-task-event', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      run.resetLogs()
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-card')
      const events = run.payloads('design-task-event')
      assert.ok(events.length >= 1, 'нет контракта: для правки ходом Дизайна окну не ушло ни одного design-task-event — ' +
        'карточке не из чего строить состояние')
      const statuses = events.map(item => String((item && item.status) || '').toLowerCase())
      assert.equal(statuses.includes('ready'), false, `правка ещё не сделана, а карточке уже сказали «готово»: ${statuses.join(', ')}`)
      assert.equal(statuses.includes('failed'), false, `правка не отказана, но событии пришло failed: ${statuses.join(', ')}`)
    } finally { run.cleanup() }
  })

  // 11a — КРАСНАЯ: слова о начавшейся правке доходят до карточки ТЕКСТОМ
  // правки. Человек в ленте читает именно эту строку, и «делает правку « »»
  // вместо текста просьбы было бы подписью ни о чём (проверка держит и обратный
  // случай: пустая строка в `message` тоже провал).
  await check('событие правки ходом Дизайна: в message есть текст инструкции, а не пустые кавычки', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      run.resetLogs()
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-words')
      const events = run.payloads('design-task-event')
      const isTurnEdit = item => {
        const status = String((item && item.status) || '').toLowerCase()
        return /turn-edit|edit-turn|design-turn|running-turn/.test(status) ||
          Boolean(item && (item.viaTurn === true || item.editViaDesignTurn === true || item.kind === 'chat-edit'))
      }
      const turnEvents = events.filter(isTurnEdit)
      assert.ok(turnEvents.length >= 1,
        `нет контракта: среди design-task-event нет ни одного события «правка идёт ходом Дизайна» — ` +
        `подпись правки проверять нечем; пришли статусы: ${events.map(item => item && item.status).join(', ') || 'ни одного события'}`)
      for (const item of turnEvents) {
        const message = String(item.message || '')
        assert.ok(message.trim(),
          `нет контракта: событие правки пришло без текста (` + JSON.stringify(item).slice(0, 200) + ')')
        assert.ok(message.includes(INSTRUCTION),
          `в подписи правки нет её текста — человек видит «${message.slice(0, 160)}», а просили «${INSTRUCTION}»`)
        assert.equal(/«\s*»/.test(message), false,
          `в подписи правки пустые кавычки вместо текста: «${message.slice(0, 160)}»`)
      }
    } finally { run.cleanup() }
  })

  // 12 — КРАСНАЯ: проводка по исходнику — как в test-agent-browser-grants.
  await check('main.js: designTask читает состояние фокуса и шлёт design-chat-edit через sendToWindow', async () => {
    assert.ok(mainSource, 'исходник main.js не прочитан')
    const body = topLevelFn(mainSource, 'designTask', path.basename(MAIN_SOURCE))
    assert.match(body, /design-chat-edit/, 'в теле designTask нет канала design-chat-edit: правка ходом Дизайна не проводка, а слова')
    assert.match(body, /sendToWindow\s*\(/, 'правка обязана уходить окну единственной точкой отправки — sendToWindow')
    assert.match(body, /focus|open|откры|актив/i, 'в designTask нет обращения к состоянию «какой макет открыт»')
    assert.equal(/webContents\.send\(/.test(body), false, 'в обход sendToWindow появилась прямая отправка в окно')
  })

  // 13 — КРАСНАЯ: чатный путь не должен вести правку через revisePage движка задачи.
  await check('правка из чата не исполняется чатным движком: designTask не отдаёт правку в revisePage', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      run.resetLogs()
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-path')
      const reads = run.toolCalls.filter(call => ['dc_read', 'dc_write'].includes(call.name))
      assert.deepEqual(reads.map(call => call.name), [],
        `чатный путь по-прежнему читает и перезаписывает макет сам (revisePage): ${reads.map(c => c.name).join(', ')}`)
    } finally { run.cleanup() }
  })

  // 14 — ЗЕЛЁНАЯ страховка (не ломать 4.2 и требования к строкам окна).
  await check('страховка: у новых строк карточки есть английская пара в словаре', async () => {
    assert.ok(cardSource, 'нет исходника карточки')
    assert.ok(fs.existsSync(I18N_SOURCE), 'нет src/renderer/i18n.js')
    const sandbox = { window: {} }
    vm.createContext(sandbox)
    vm.runInContext(read(I18N_SOURCE), sandbox)
    const dict = (sandbox.window.__I18N__ && sandbox.window.__I18N__.en) || {}
    assert.ok(Object.keys(dict).length > 400, 'английский словарь не загрузился')
    const keys = [...cardSource.matchAll(/(?<![.\w])t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)]
      .map(match => match[2])
      .filter(text => /[а-яё]/i.test(text))
    const missing = keys.filter(key => !dict[key])
    assert.deepEqual(missing, [],
      `русские строки карточки без английской пары (требование 4.2): ${JSON.stringify(missing)}`)
  })

  // 15 — СТРАХОВКА (требование 4.2 к оформлению): классы, которые ставит код
  // карточки, обязаны быть описаны в стилях.
  await check('страховка: каждый класс карточки описан в стилях окна', async () => {
    assert.ok(cardSource, 'нет исходника карточки')
    const cssDir = path.join(ROOT, 'src', 'renderer')
    let css = ''
    for (const name of fs.readdirSync(cssDir).filter(item => item.endsWith('.css'))) {
      css += read(path.join(cssDir, name))
    }
    assert.ok(css.length > 1000, 'стили окна не прочитаны — проверка была бы слепой')
    const tokens = new Set()
    for (const match of cardSource.matchAll(/className\s*=\s*(['"])((?:(?!\1)[^\\])*)\1/g)) {
      for (const token of match[2].split(/\s+/)) if (token) tokens.add(token)
    }
    for (const match of cardSource.matchAll(/classList\.add\(([^)]*)\)/g)) {
      for (const item of match[1].matchAll(/['"]([^'"]+)['"]/g)) tokens.add(item[1])
    }
    const missing = [...tokens].filter(token => !new RegExp('\\.' + token.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + '\\b').test(css))
    assert.deepEqual(missing, [],
      `классы карточки не описаны ни в одном стиле (требование 4.2): ${missing.join(', ')}`)
  })

  // 16 — КРАСНАЯ (остаток 4.2 по поручению 29.09): карточка правки обязана
  // доживать до «готово» с номером версии. Пока окно нечем сообщить о конце
  // правки, карточка навсегда остаётся в «Правка идёт ходом Дизайна».
  await check('main.js и мост: канал design-edit-result, окно зовёт его методом литералом', async () => {
    const run = bootMain()
    try {
      assert.equal(typeof run.handlers.get('design-edit-result'), 'function',
        'нет контракта: главный процесс не слушает канал `design-edit-result` — оконцу нечем сказать, что правка из чата кончилась')
      assert.match(mainSource, /ipcMain\.handle\(\s*'design-edit-result'/,
        "в исходнике main.js нет литерала ipcMain.handle('design-edit-result' — проводка ищется по нему")
      assert.match(preloadSource, /designEditResult\s*:\s*[\w$]+\s*=>\s*ipcRenderer\.invoke\(\s*'design-edit-result'/,
        'нет контракта: в мосту нет designEditResult(payload) → ipcRenderer.invoke(\'design-edit-result\', …)')
      const callers = rendererSource.filter(item => /electronAPI\.designEditResult\(/.test(item.text)).map(item => item.name)
      assert.ok(callers.length,
        'нет контракта: ни один файл окна не вызывает electronAPI.designEditResult( — отчёт о конце правки ' +
        'никто не отправляет. Проверенные файлы: ' + rendererSource.map(item => item.name).join(', '))
    } finally { run.cleanup() }
  })

  // 17 — КРАСНАЯ: сам отчёт. Правка ушла ходом Дизайна, ход кончился, окно
  // назвало версию — карточка обязана показать «готово» и номер.
  await check('отчёт окна о конце правки даёт карточке «готово» с номером версии', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-done')
      const edits = run.payloads('design-chat-edit')
      assert.equal(edits.length, 1, `нет контракта: правка при открытом макете не ушла ходом Дизайна (событий ${edits.length})`)
      run.resetLogs()
      await run.fire('design-edit-result', { requestId: 'req-done', designId: DESIGN, version: 2 })
      const events = run.payloads('design-task-event')
      assert.equal(events.length, 1,
        `окно сообщило о конце правки, а карточка получила ${events.length} событий: «готово» не выставлялось`)
      const done = events[0] || {}
      assert.equal(String(done.requestId), 'req-done', `отчёт закрыл не ту правку: ${JSON.stringify(done).slice(0, 160)}`)
      assert.equal(String(done.chatId || ''), CHAT, 'событие «готово» не привязано к разговору — карточка не найдёт, что обновлять')
      assert.equal(String(done.status), 'ready', `статус «${done.status}» вместо «ready»: карточка осталась бы в работе`)
      assert.equal(Number(done.version), 2, `номера версии в событии нет: ${JSON.stringify(done).slice(0, 160)}`)
      // И словами на ленте: человек читает карточку, а не поле события.
      const scene = cardScene()
      assert.ok(!scene.loadError, `карточка не загрузилась: ${(scene.loadError || {}).message}`)
      const text = cardTextFor(scene, {
        taskId: 'req-done', requestId: 'req-done', status: 'ready', version: Number(done.version),
        message: String(done.message || '')
      }, 'req-done-карточка')
      assert.match(text, /готов/i, `карточка по событию «ready» говорит не про готовность: «${text.slice(0, 160)}»`)
      assert.match(text, /версия 2/, `в карточке нет номера версии: «${text.slice(0, 160)}»`)
    } finally { run.cleanup() }
  })

  // 18 — КРАСНАЯ: номер версии принадлежит реестру, а не словам окна: окно могло
  // не успеть его узнать. И правка закрывается один раз.
  await check('версия для «готово» — из реестра, а второй отчёт той же правки молчит', async () => {
    const run = bootMain()
    try {
      await seedDesign(run, { id: DESIGN, chatId: CHAT, topic: TOPIC, component: 'Home.dc.html', version: 1 })
      run.inContext('lastTurnHere = { chatId: "чат-А", projectId: null, chatFolders: [], projectFolders: [] }')
      await run.reportFocus(DESIGN)
      await run.designTask({ brief: INSTRUCTION, topic: TOPIC, design_id: DESIGN, instruction: INSTRUCTION }, 'req-reg')
      run.resetLogs()
      // Реестр знает третью версию (её выпустил ход Дизайна), окно числа не назвало.
      await run.fire('set-designs', [{ id: DESIGN, name: TOPIC, chatId: CHAT, component: 'Home.dc.html', version: 3, createdAt: 1, updatedAt: 2 }])
      await run.fire('design-edit-result', { requestId: 'req-reg', designId: DESIGN })
      const first = run.payloads('design-task-event')
      assert.equal(first.length, 1, `первый отчёт не закрыл правку: событий ${first.length}`)
      assert.equal(Number((first[0] || {}).version), 3,
        `номер версии взят не из реестра: ${JSON.stringify(first[0]).slice(0, 160)}`)
      run.resetLogs()
      await run.fire('design-edit-result', { requestId: 'req-reg', designId: DESIGN, version: 4 })
      assert.deepEqual(run.payloads('design-task-event'), [],
        'тот же id правки закрылся «готово» второй раз: карточка перескакивала бы на несуществующую версию')
      // Чужой отчёт — про правку, которой главный процесс не заводил, — не имеет
      // права выдумывать состояние.
      run.resetLogs()
      await run.fire('design-edit-result', { requestId: 'req-чужой', designId: DESIGN, version: 9 })
      assert.deepEqual(run.payloads('design-task-event'), [],
        'отчёт о неизвестной правке породил «готово»: карточка чужого разговора показала бы версию, которой не было')
    } finally { run.cleanup() }
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed) process.exit(1)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})
