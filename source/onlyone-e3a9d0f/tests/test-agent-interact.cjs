// test-agent-interact.cjs — КРАСНЫЕ проверки движка действий браузера агента
// (план, пункт 3.6б «Браузер агента: действия и живой вид»).
//
// Тест написан ДО продуктового кода: `src/main/agent-interact.js` в дереве
// отсутствует, и весь набор красный по этой причине — по отсутствию поведения, а
// не по синтаксической ошибке загрузки. Шапка делает мягкий `try/require`,
// первая проверка объявляет «модуля нет», а каждая следующая получает вместо
// настоящего API заглушку, которая бросает `НЕТ КОНТРАКТА: <причина>`. Прогон
// печатает список красных с внятной строкой на каждую, а не один
// `Cannot find module`.
//
// Контракт, замороженный ведущим (проверяется буквально; остальное — дело
// реализации):
//   модуль   `src/main/agent-interact.js`,
//   экспорт  `createAgentInteraction({ webContents, validateUrl, signal, timeoutMs })`
//            → `{ click, type, screenshot, frame }`;
//   вход     `click(target)` / `type(target, text, { submit })`, `target` —
//            `{ index }` (номер распознаваемого элемента текущего кадра) или
//            `{ text }` (видимый текст / label / placeholder / aria-label);
//   кадр     `frame()` → `{ url, title, elements: [{ index, tag, role, name, type, href }] }`;
//   отказ    ответом `{ ok: false, error }`, а не исключением.
//
// Чего контракт НЕ задаёт и что харнесс подставляет сам (названы в докладе —
// реализация вправе выбрать любой из перечисленных вариантов):
//  - `validateUrl` по форме повторяет уже существующий сторож `validateBrowserUrl`
//    (`src/main/agent-browser.js`): при отказе бросает, при успехе возвращает
//    объект. Подставленный сторож удовлетворяет и прочтению «ответом»: успех —
//    правдивый объект с `ok: true`;
//  - где задаются `maxChars`/`offset` (в `createAgentInteraction` или в аргументе
//    вызова) — харнесс отдаёт одно и то же значение в обоих местах;
//  - под каким именем в ответ лежит текст страницы — ответ обходится целиком
//    (`stringsOf`), а фейковый `webContents` выдаёт текст под всеми
//    правдоподобными ключами;
//  - чем движок передаёт текст в поле (`executeJavaScript`, `insertText`, `send`)
//    — журнал вызовов проверяется по всем трём поверхностям;
//  - что именно делает `dispose` — не проверяется: его в контракте нет.
//
// Про `webContents`: узловой прогон идёт в чистом Node, настоящего Electron нет
// (в общем `node_modules` нет `conf`, оконные прогоны сегодня не запускаются).
// Вокруг движка — подставной `webContents` с поверхностью `executeJavaScript`,
// `capturePage`, `getURL`, `isDestroyed`, `isLoading`, `on`, `once`,
// `removeListener`, `off`, `removeAllListeners`, `send`, `insertText`, `focus`,
// `invalidate`. Если движку понадобится что-то ещё из настоящего Electron — это
// надо дописать сюда и назвать в докладе, а не ослаблять проверку.
//
// Настоящей сети в наборе нет: сторож подставной, адреса никто не разрешает.
//
// Пути к исходникам можно подменить переменными (`ONECODE_INTERACT_UNDER_TEST`,
// `ONECODE_MAIN_UNDER_TEST`) — тот же приём, что в
// `tests/test-run-checkpoint-main-wiring.cjs`: так харнесс проверяет сам себя на
// эталонной реализации. В общем прогоне переменные не выставлены.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
// Путь к движку можно подменить только одному харнессу (та же приём, что
// `ONECODE_MAIN_UNDER_TEST` в tests/test-run-checkpoint-main-wiring.cjs): так
// проверка проверяет себя, а не воспроизводит саму себя. В общем прогоне
// переменная не выставлена, и читается канонический src/main/agent-interact.js.
const MODULE_SOURCE = process.env.ONECODE_INTERACT_UNDER_TEST || path.join(ROOT, 'src', 'main', 'agent-interact.js')
const MAIN_SOURCE = process.env.ONECODE_MAIN_UNDER_TEST || path.join(ROOT, 'src', 'main', 'main.js')

const API_METHODS = ['click', 'type', 'screenshot', 'frame']
const GUARD_MS = 1000 // «ни один прогон не висит дольше секунды»

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

const within = (ms, promise, what) => {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`больше ${ms} мс — ${what}`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

const NO_CONTRACT = 'НЕТ КОНТРАКТА'
const STUB_MARK = Symbol('нет контракта')
const rel = file => path.relative(ROOT, file).split(path.sep).join('/')
const msg = error => String((error && error.message) || error || '').split('\n')[0].slice(0, 300)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = file => fs.readFileSync(file, 'utf8')
const stripComments = source => String(source)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')

// --- мягкая загрузка модуля под тестом ------------------------------------------

let interact = null
let moduleLoadError = null
try {
  if (!fs.existsSync(MODULE_SOURCE)) throw new Error('файла нет в дереве')
  interact = require(MODULE_SOURCE)
} catch (error) {
  moduleLoadError = error
}

function noContract (reason) {
  const api = {}
  for (const name of [...API_METHODS, 'dispose']) {
    api[name] = () => { throw new Error(NO_CONTRACT + ': ' + reason) }
  }
  api[STUB_MARK] = reason
  return api
}

// Проверка «нет утечки слушателей» красна сама по себе, если движка нет:
// навешивать подписки некому, и счётчик молчит. Такие проверки обязаны
// явно объявить, что проводились не на чём.
function requireRealApi (api, what) {
  if (api && api[STUB_MARK]) throw new Error(`${NO_CONTRACT}: ${api[STUB_MARK]} — ${what} проводилась бы впустую`)
}

async function buildApi (createOptions) {
  if (moduleLoadError) {
    return noContract(`${rel(MODULE_SOURCE)} не подключается (${msg(moduleLoadError)}) — весь набор красный по этой причине`)
  }
  if (!interact || typeof interact.createAgentInteraction !== 'function') {
    return noContract(`в модуле нет экспорта createAgentInteraction(): отдаётся ${typeof (interact || {}).createAgentInteraction}`)
  }
  let created
  try {
    created = await interact.createAgentInteraction(createOptions)
  } catch (error) {
    return noContract(`createAgentInteraction() бросила: ${msg(error)}`)
  }
  const missing = API_METHODS.filter(name => typeof (created || {})[name] !== 'function')
  if (missing.length) {
    return noContract(`у результата createAgentInteraction() нет ${missing.join(', ')}; есть только: ${Object.keys(created || {}).join(', ') || '(ничего)'}`)
  }
  return created
}

// --- разбор ответа ---------------------------------------------------------------

function jsonSafe (value, seen) {
  const guard = seen || new Set()
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'function') return '[fn]'
  if (type !== 'object') return type === 'bigint' ? String(value) : value
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} байт]`
  if (guard.has(value)) return '[цикл]'
  const inner = new Set(guard)
  inner.add(value)
  if (Array.isArray(value)) return value.map(item => jsonSafe(item, inner))
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, inner)
  return out
}

const serialize = value => {
  try { return JSON.stringify(jsonSafe(value)) || '' } catch { return '[не сериализуется]' }
}

// Все строки ответа — и значения, и имена полей: так проверка «текст никуда не
// утёк» не зависит от того, в какое поле его положил реализатор.
function stringsOf (value, out = [], seen = new Set()) {
  if (typeof value === 'string') { out.push(value); return out }
  if (value === null || typeof value !== 'object') return out
  if (Buffer.isBuffer(value)) { out.push(`<buffer ${value.length}>`); return out }
  if (seen.has(value)) return out
  seen.add(value)
  if (Array.isArray(value)) { for (const item of value) stringsOf(item, out, seen); return out }
  for (const [key, item] of Object.entries(value)) { out.push(':' + key); stringsOf(item, out, seen) }
  return out
}

const joined = value => stringsOf(value).join('\n')

function nonPlainValues (value) {
  const found = []
  const walk = (node, keyPath) => {
    if (Buffer.isBuffer(node)) { found.push(`${keyPath}: ${node.length} байт`); return }
    if (typeof node === 'function') { found.push(`${keyPath}: функция`); return }
    if (node && typeof node === 'object') {
      if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${keyPath}[${i}]`))
      else for (const [key, item] of Object.entries(node)) walk(item, `${keyPath}.${key}`)
    }
  }
  walk(value, '$')
  return found
}

const limitNote = text => /лимит|максимум|потолок|не влез|обрез|не больше|допустим|не попал|max[_ -]?(chars|bytes)|truncat|limit/i.test(text)
const sizeNote = text => /пиксел|байт|размер|разрешени|KB|МБ|px|\d+\s*[x×]\s*\d+|знак/i.test(text)

// «Есть ещё» — только по положительным признакам: числовое nextOffset,
// взведённый флаг или явные слова «обрезано / не влезло / показано N из M».
// Отрицания («дальше нечего», «не осталось») сюда сознательно не входят:
// ответ «ничего нет» обязан читаться как отсутствие продолжения.
function claimsMore (value) {
  const body = serialize(value)
  const next = body.match(/"(?:next[_ -]?offset|nextOffset|next)"\s*:\s*(null|\d+)/i)
  if (next) return next[1] !== 'null'
  const flag = body.match(/"(?:has[_ -]?more|hasMore|more|truncated\w*|cut)"\s*:\s*(true|false)/i)
  if (flag) return flag[1] === 'true'
  return /обрезан|не влезло|осталось \d+|ещ[ёе] \d+ знак|продолжение:|показано \d+[^0-9]{0,8}\d+ из \d+/i.test(body)
}

// --- модель страницы для подставного webContents ---------------------------------

const LONG_PAGE = Array.from({ length: 600 }, (_, i) => 'Т' + String(i).padStart(4, '0')).join(' ')

const PLAIN_ELEMENTS = [
  { index: 0, tag: 'a', role: 'link', name: 'Открыть отчёт', type: null, href: 'https://example.com/report' },
  { index: 1, tag: 'input', role: 'textbox', name: 'Поисковый запрос', type: 'text', href: null, id: 'q', placeholder: 'Поисковый запрос', attributes: { id: 'q', name: 'q', type: 'text', autocomplete: 'off' } },
  { index: 2, tag: 'input', role: 'textbox', name: 'МИШЕНА-ОБЫЧНОЕ-ПОЛЕ', type: 'text', href: null, id: 'note', placeholder: 'МИШЕНА-ОБЫЧНОЕ-ПОЛЕ', attributes: { id: 'note', name: 'note', type: 'text' } },
  { index: 3, tag: 'button', role: 'button', name: 'Искать', type: 'submit', href: null },
  { index: 4, tag: 'select', role: 'combobox', name: 'Город', type: 'select-one', href: null }
]

// Поля-секреты: признак подложен под все правдоподобные ключи — движок волен
// читать любой, но обязан прочесть хоть какой-то. Доступное имя (`name` по
// контракту) специально нейтральное: по нему поле секретным не опознать.
const SECRET_ELEMENTS = [
  { index: 5, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ-С1', type: 'password', href: null, id: 'pw', attributes: { type: 'password', id: 'pw' } },
  { index: 6, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ-С2', type: 'text', href: null, autocomplete: 'current-password', attributes: { type: 'text', autocomplete: 'current-password' } },
  { index: 7, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ-С3', type: 'text', href: null, autocomplete: 'new-password', attributes: { type: 'text', autocomplete: 'new-password' } },
  { index: 8, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ-С4', type: 'text', href: null, id: 'user_password', domName: 'api_key', attributes: { id: 'user_password', name: 'api_key' } },
  { index: 9, tag: 'input', role: 'textbox', name: 'МИШЕНА-ПОЛЕ-С5', type: 'text', href: null, id: 'access_token', domName: 'secret', attributes: { id: 'access_token', name: 'secret' } }
]

const ALL_ELEMENTS = [...PLAIN_ELEMENTS, ...SECRET_ELEMENTS]

const ANY_CARRIER = text => ({
  text, body: text, content: text, html: text, value: text, innerText: text, visibleText: text, pageText: text
})

function pageModel (over = {}) {
  const elements = over.elements || PLAIN_ELEMENTS
  const page = over.page === undefined ? LONG_PAGE : over.page
  return Object.assign({
    ok: true,
    success: true,
    url: over.url || 'https://example.com/one',
    title: over.title || 'Страница МИШЕНА',
    elements,
    count: elements.length,
    matched: elements.length,
    clicked: true,
    typed: true,
    name: elements[0] ? elements[0].name : ''
  }, ANY_CARRIER(page))
}

function makeImage ({ width = 1024, height = 768, bytes = 4096 } = {}) {
  const blob = Buffer.alloc(bytes, 0x41)
  const payload = blob.toString('base64')
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    toPNG: () => blob,
    toBitmap: () => blob,
    toJPEG: () => blob,
    toDataURL: () => 'data:image/png;base64,' + payload
  }
}

// --- подставной webContents ------------------------------------------------------

function makeWebContents (opts = {}) {
  const log = []
  const listeners = []
  const stats = { on: 0, once: 0, removeListener: 0, off: 0, removeAllListeners: 0 }
  const state = { url: opts.url || 'https://example.com/one', destroyed: Boolean(opts.destroyed) }
  let jsCalls = 0

  const record = (method, args) => { log.push({ method, args }) }

  const wc = {
    getURL () { record('getURL', []); return state.url },
    isDestroyed () { record('isDestroyed', []); return state.destroyed },
    isLoading () { record('isLoading', []); return false },
    focus () { record('focus', []) },
    invalidate () { record('invalidate', []) },
    executeJavaScript (script) {
      record('executeJavaScript', [String(script)])
      jsCalls++
      if (opts.jsThrows) return Promise.reject(new Error(opts.jsThrows))
      if (opts.hang) return new Promise(() => {})
      const reply = typeof opts.reply === 'function' ? opts.reply(jsCalls) : opts.reply
      return Promise.resolve(reply === undefined ? pageModel() : reply)
    },
    capturePage (rect) {
      record('capturePage', [rect === undefined ? '' : String(rect)])
      if (opts.captureThrows) return Promise.reject(new Error(opts.captureThrows))
      if (opts.captureHang) return new Promise(() => {})
      return Promise.resolve(opts.image || makeImage())
    },
    insertText (text) { record('insertText', [String(text)]) },
    send (...args) { record('send', args.map(item => String(item))) },
    on (event, fn) { stats.on++; listeners.push({ event, fn }); return wc },
    once (event, fn) { stats.once++; listeners.push({ event, fn, once: true }); return wc },
    removeListener (event, fn) {
      stats.removeListener++
      const index = listeners.findIndex(item => item.event === event && item.fn === fn)
      if (index >= 0) listeners.splice(index, 1)
      return wc
    },
    off (event, fn) { stats.off++; return wc.removeListener(event, fn) },
    removeAllListeners (event) {
      stats.removeAllListeners++
      for (let i = listeners.length - 1; i >= 0; i--) if (!event || listeners[i].event === event) listeners.splice(i, 1)
      return wc
    },
    // --- только для харнесса ---
    setUrl (next) { state.url = String(next) },
    destroy () { state.destroyed = true },
    fire (event, ...args) {
      for (const item of listeners.filter(l => l.event === event)) {
        try { item.fn({}, ...args) } catch {}
        if (item.once) {
          const index = listeners.indexOf(item)
          if (index >= 0) listeners.splice(index, 1)
        }
      }
    },
    outstanding: () => listeners.slice(),
    stats: () => Object.assign({}, stats, { outstanding: listeners.length }),
    log: () => log.slice(),
    logText: () => log.map(item => `${item.method}(${item.args.join(', ')})`).join('\n')
  }
  return wc
}

// --- подставной сторож адресов ---------------------------------------------------
// Повторяет семантику настоящего `validateBrowserUrl`: локальные и частные
// адреса и чужие протоколы — бросок с названной причиной, публичный адрес —
// правдивый объект. Проверка в том, что движок СПРАШИВАЕТ этот сторож, а не
// решает сам.

const PRIVATE_HOST = /^(?:localhost$|.*\.localhost$|0\.0\.0\.0$|::1$|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i

function makeGuard (opts = {}) {
  const calls = []
  const fn = async raw => {
    const url = String((raw && raw.href) || raw || '')
    calls.push(url)
    if (opts.rejectAll) throw new Error(opts.rejectAll)
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      throw new Error(`Некорректный формат URL: ${url}`)
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(`Недопустимый протокол "${parsed.protocol}": поддерживаются только http: и https:`)
    }
    if (PRIVATE_HOST.test(parsed.hostname)) {
      throw new Error(`Запрещён доступ к локальному или частному адресу "${parsed.hostname}" (SSRF защита)`)
    }
    return Object.assign(parsed, { ok: true, allowed: true })
  }
  return { fn, calls }
}

// --- сцена -----------------------------------------------------------------------

async function makeScene (opts = {}) {
  const wc = makeWebContents(opts.wc || {})
  const guard = makeGuard(opts.guard || {})
  const controller = opts.noSignal ? null : new AbortController()
  const signalStats = { added: 0, removed: 0 }
  if (controller) {
    const signal = controller.signal
    const realAdd = signal.addEventListener.bind(signal)
    const realRemove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (type, fn, ...rest) => {
      if (type === 'abort') signalStats.added++
      return realAdd(type, fn, ...rest)
    }
    signal.removeEventListener = (type, fn, ...rest) => {
      if (type === 'abort') signalStats.removed++
      return realRemove(type, fn, ...rest)
    }
  }
  const createOptions = {
    webContents: wc,
    validateUrl: guard.fn,
    timeoutMs: opts.timeoutMs === undefined ? 5000 : opts.timeoutMs
  }
  if (controller) createOptions.signal = controller.signal
  if (opts.maxChars !== undefined) createOptions.maxChars = opts.maxChars
  if (opts.offset !== undefined) createOptions.offset = opts.offset
  const api = await buildApi(createOptions)
  return { wc, guard, controller, signalStats, api, createOptions }
}

// Вызов действия. Исключение превращается в наблюдаемый провал: пункт 7
// требует, чтобы отказ был ОТВЕТОМ.
async function act (api, name, args = []) {
  const label = `${name}(${args.map(item => serialize(item)).join(', ')})`
  try {
    return { value: await within(GUARD_MS, api[name](...args), label) }
  } catch (error) {
    return { thrown: error, label }
  }
}

const refusalReason = res => String((res && (res.error || res.message)) || '')
const addressRefusal = res => Boolean(res) && res.ok === false &&
  /(адрес|хост|host|протокол|локальн|частн|приватн|SSRF|url|запрещ)/i.test(refusalReason(res))

const pageTokens = value => {
  const found = new Set()
  for (const text of stringsOf(value)) {
    for (const match of String(text).matchAll(/Т(\d{4})/g)) found.add(Number(match[1]))
  }
  return [...found].sort((a, b) => a - b)
}
const tokensPresent = value => pageTokens(value).length > 0
const tokenWindow = value => {
  const tokens = pageTokens(value)
  return { first: tokens.length ? tokens[0] : null, last: tokens.length ? tokens[tokens.length - 1] : null, count: tokens.length }
}

// Блок одного инструмента в TOOL_DEFINITIONS: от его `name: '...'` до
// следующего `name: '` — иначе окно зацепило бы соседний инструмент и его
// аргументы (например, `url` у `fetch_url`).
function toolBlock (region, name) {
  const at = region.indexOf(`name: '${name}'`)
  if (at < 0) return null
  const next = region.indexOf("name: '", at + name.length + 12)
  return region.slice(at, next > at ? next : region.length)
}

// --- проверки --------------------------------------------------------------------

async function main () {
  await check('модуль agent-interact.js существует и отдаёт createAgentInteraction с четырьмя действиями', async () => {
    assert.ok(!moduleLoadError, `${NO_CONTRACT}: ${rel(MODULE_SOURCE)} не подключается (${msg(moduleLoadError)})`)
    assert.equal(typeof interact.createAgentInteraction, 'function', 'в модуле нет экспорта createAgentInteraction')
    const { api } = await makeScene()
    for (const name of API_METHODS) {
      assert.equal(typeof api[name], 'function', `у результата createAgentInteraction() нет метода ${name}`)
    }
  })

  await check('frame() отдаёт кадр замороженной формы: url, title и elements[] со сплошными index', async () => {
    const { api, wc } = await makeScene()
    const { value: frame, thrown } = await act(api, 'frame')
    if (thrown) throw new Error(`frame() бросила: ${msg(thrown)}`)
    assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame), `frame() вернула ${typeof frame} вместо объекта кадра`)
    assert.notEqual(frame.ok, false, `frame() отказала на разрешённой странице: ${refusalReason(frame)}`)
    assert.equal(String(frame.url || ''), 'https://example.com/one', `в кадре не тот адрес: ${frame.url}`)
    assert.equal(String(frame.title || ''), 'Страница МИШЕНА', `в кадре не тот заголовок: ${frame.title}`)
    assert.ok(Array.isArray(frame.elements), `elements — не массив (${typeof frame.elements})`)
    assert.equal(frame.elements.length, PLAIN_ELEMENTS.length, `в кадр попали не все распознаваемые элементы: ${frame.elements.length}`)
    const indices = frame.elements.map(item => item.index)
    assert.deepEqual(indices, [0, 1, 2, 3, 4], `index обязаны быть сплошными с нуля, а пришли ${JSON.stringify(indices)}`)
    for (const el of frame.elements) {
      for (const key of ['tag', 'role', 'name', 'type', 'href']) {
        assert.ok(key in el, `у элемента ${el.index} нет поля ${key}, обещанного контрактом`)
        assert.ok(el[key] === null || typeof el[key] === 'string', `поле ${key} элемента ${el.index} — ${typeof el[key]}, а не строка`)
      }
    }
    assert.equal(wc.stats().outstanding, 0, `после frame() у webContents висит ${wc.stats().outstanding} слушателей`)
  })

  await check('сторож вызывается на каждом действии, а не один раз при входе', async () => {
    const { api, guard } = await makeScene({ wc: { image: makeImage({ bytes: 4096 }) } })
    const attempted = [
      ['frame', []],
      ['click', [{ index: 0 }]],
      ['type', [{ index: 2 }, 'Обычный-МИШЕНА-текст', { submit: false }]],
      ['screenshot', []]
    ]
    const problems = []
    for (const [name, args] of attempted) {
      const { value, thrown } = await act(api, name, args)
      if (thrown) problems.push(`${name}: бросила ${msg(thrown)}`)
      else if (addressRefusal(value)) problems.push(`${name}: отказ по адресу (${refusalReason(value)}) при разрешённом адресе`)
      else if (!value || typeof value !== 'object') problems.push(`${name}: вернула ${typeof value} вместо ответа`)
    }
    assert.deepEqual(problems, [], 'разрешённая страница не обслуживается:\n  ' + problems.join('\n  '))
    assert.ok(guard.calls.length >= attempted.length,
      `на ${attempted.length} действия сторож спрошен ${guard.calls.length} раз — адрес проверяется каждым действием, а не один раз при входе`)
    for (const call of guard.calls) {
      assert.equal(String(call).replace(/\/$/, ''), 'https://example.com/one', `сторож спросили не о живом адресе страницы: ${call}`)
    }
  })

  const REDIRECT_CASES = [
    { url: 'http://127.0.0.1:8080/admin', marker: '127.0.0.1', reason: /127\.0\.0\.1|локальн|частн|приватн|SSRF|запрещ/i },
    { url: 'http://localhost:3000/api', marker: 'localhost', reason: /localhost|локальн|частн|SSRF|запрещ/i },
    { url: 'http://169.254.169.254/latest/meta-data', marker: '169.254', reason: /169\.254|link-local|частн|локальн|SSRF|запрещ/i },
    { url: 'http://10.0.0.5/inside', marker: '10.0.0.5', reason: /10\.0\.0\.5|частн|приватн|локальн|SSRF|запрещ/i },
    { url: 'http://192.168.1.1/router', marker: '192.168', reason: /192\.168|частн|приватн|локальн|SSRF|запрещ/i },
    { url: 'file:///C:/Windows/win.ini', marker: 'file:', reason: /file:|протокол|запрещ|недопустим/i },
    { url: 'data:text/html,<h1>hi</h1>', marker: 'data:', reason: /data:|протокол|запрещ|недопустим/i }
  ]

  async function redirectProblems (cases) {
    const problems = []
    for (const item of cases) {
      const wc = makeWebContents({ url: 'https://example.com/one' })
      const guard = makeGuard()
      const controller = new AbortController()
      const api = await buildApi({ webContents: wc, validateUrl: guard.fn, signal: controller.signal, timeoutMs: 2000 })
      const opened = await act(api, 'frame')
      if (opened.thrown) { problems.push(`${item.marker}: первый frame() бросил ${msg(opened.thrown)}`); continue }
      if (addressRefusal(opened.value)) { problems.push(`${item.marker}: кадр до перехода отказал: ${refusalReason(opened.value)}`); continue }
      // Страница сама ушла на другой адрес — посреди сессии, без ведома движка.
      wc.setUrl(item.url)
      wc.fire('did-navigate', item.url)
      guard.calls.length = 0
      for (const [name, args] of [['frame', []], ['click', [{ index: 0 }]], ['screenshot', []]]) {
        const { value, thrown } = await act(api, name, args)
        const label = `${item.marker} → ${name}`
        if (thrown) { problems.push(`${label}: бросила ${msg(thrown)} — переход надо отклонять ответом`); continue }
        if (!addressRefusal(value)) {
          problems.push(`${label}: страницу, уехавшую на ${item.url}, не отклонил (ответ: ${serialize(value).slice(0, 150)})`)
          continue
        }
        if (!item.reason.test(refusalReason(value))) {
          problems.push(`${label}: отказ без названной причины: «${refusalReason(value)}»`)
        }
        if (!guard.calls.some(url => String(url).includes(item.marker))) {
          problems.push(`${label}: отклонил, не спросив сторож об адресе ${item.url} (спрошен о ${JSON.stringify(guard.calls)}) — подставной сторож обходится`)
        }
      }
    }
    return problems
  }

  await check('редирект посреди сессии в локальную или частную сеть отклоняется каждым следующим действием', async () => {
    const problems = await redirectProblems(REDIRECT_CASES.filter(item => !/^(file|data):/.test(item.url)))
    assert.deepEqual(problems, [], 'локальные и частные адреса после перехода не отклоняются:\n  ' + problems.slice(0, 12).join('\n  '))
  })

  await check('переход на file: и data: отклоняется, и сторож спрошен именно об этом адресе', async () => {
    const problems = await redirectProblems(REDIRECT_CASES.filter(item => /^(file|data):/.test(item.url)))
    assert.deepEqual(problems, [], 'запрещённый протокол посреди сессии не отклонён:\n  ' + problems.join('\n  '))
  })

  await check('второго сторожа в движке нет: адресных списков в его исходнике не появляется', async () => {
    if (moduleLoadError) throw new Error(`${NO_CONTRACT}: ${rel(MODULE_SOURCE)} не подключается (${msg(moduleLoadError)}) — переиспользование сторожа нечем проверить`)
    const source = stripComments(read(MODULE_SOURCE))
    const literals = source.match(/['"`](?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost|::1)/g) || []
    assert.deepEqual(literals, [],
      `в ${rel(MODULE_SOURCE)} появились собственные адресные литералы (${literals.slice(0, 6).join(', ')}): адрес проверяет подставленный ` +
      'сторож (в продуктиве — validateBrowserUrl из agent-browser.js поверх web-fetch.js), второго сторожа в проекте не заводим')
    assert.ok(/validateUrl/.test(source), 'в исходнике нет ни одного обращения к validateUrl — адрес проверяется мимо подставленного сторожа')
  })

  const SECRET_TEXT = 'Совсекрет-МИШЕНА-K7xq'

  await check('ввод в поле-секрет запрещён: password, current-password, new-password, name/id с секретным словом', async () => {
    const problems = []
    for (const element of SECRET_ELEMENTS) {
      const { api, wc } = await makeScene({ wc: { reply: () => pageModel({ elements: ALL_ELEMENTS }) } })
      const { value, thrown } = await act(api, 'type', [{ index: element.index }, SECRET_TEXT, { submit: false }])
      const label = `элемент ${element.index} (type=${element.type}, autocomplete=${element.autocomplete || '-'}, id=${element.id || '-'})`
      if (thrown) { problems.push(`${label}: type() бросила ${msg(thrown)} — отказ надо оформлять ответом`); continue }
      if (!value || value.ok !== false) {
        problems.push(`${label}: ввод в поле-секрет не отклонён (ответ: ${serialize(value).slice(0, 150)})`)
        continue
      }
      if (!/секрет|password|парол|токен|token|ключ|api[_ -]?key|скрыт|не вводим|запрещ/i.test(refusalReason(value))) {
        problems.push(`${label}: отказ не назван отказом по полю-секрету: «${refusalReason(value)}»`)
      }
      const leaked = []
      if (serialize(value).includes(SECRET_TEXT)) leaked.push('в ответ модели')
      if (wc.logText().includes(SECRET_TEXT)) leaked.push('в журнал вызовов webContents')
      if (leaked.length) problems.push(`${label}: введённый текст утёк ${leaked.join(' и ')} — отказ обязан случиться до того, как текст уйдёт куда-либо`)
    }
    assert.deepEqual(problems, [], 'поля-секреты пропускают ввод или светят текст:\n  ' + problems.join('\n  '))
  })

  await check('обычное поле ввод принимает: отказ по секрету не достигается отказом на всём подряд', async () => {
    const { api, wc } = await makeScene({ wc: { reply: () => pageModel({ elements: ALL_ELEMENTS }) } })
    const { value, thrown } = await act(api, 'type', [{ index: 2 }, 'Обычный-МИШЕНА-текст', { submit: false }])
    if (thrown) throw new Error(`type() по обычному полю бросила: ${msg(thrown)}`)
    assert.notEqual(value && value.ok, false,
      `обычное поле отклонено (${refusalReason(value)}) — на «отказе по любому полю» проверка секретов была бы зелёной сама по себе`)
    assert.ok(wc.logText().includes('Обычный-МИШЕНА-текст'),
      'введённый текст не дошёл ни до одной поверхности страницы (executeJavaScript / insertText / send): значит, отказ по секрету ничего не отсекает')
  })

  // 12.10.2026: защита секретов срабатывала на любое слово «ключ», и поле «Ключевые слова» агент заполнить не мог.
  // Настоящие секреты (пароль, токен, API-ключ, ключ доступа, секретный, приватный ключ) защищены по-прежнему.
  const WORDY = [
    { index: 10, tag: 'input', role: 'textbox', name: 'Ключевые слова', label: 'Ключевые слова', placeholder: 'ключевое слово для поиска', type: 'text', href: null, id: 'kw', attributes: { type: 'text', id: 'kw' } },
    { index: 11, tag: 'input', role: 'textbox', name: 'Тема письма', label: 'Тема письма', placeholder: 'ключевая идея', type: 'text', href: null, id: 'subject', attributes: { type: 'text', id: 'subject' } }
  ]
  const GUARDED = [
    { index: 12, tag: 'input', role: 'textbox', name: 'API-ключ', label: 'API-ключ', type: 'text', href: null, attributes: { type: 'text' } },
    { index: 13, tag: 'input', role: 'textbox', name: 'Ключ доступа', label: 'Ключ доступа', type: 'text', href: null, attributes: { type: 'text' } },
    { index: 14, tag: 'input', role: 'textbox', name: 'Секретный вопрос', label: 'Секретный вопрос', type: 'text', href: null, attributes: { type: 'text' } },
    { index: 15, tag: 'input', role: 'textbox', name: 'Приватный ключ', label: 'Приватный ключ', type: 'text', href: null, attributes: { type: 'text' } },
    { index: 16, tag: 'input', role: 'textbox', name: 'Токен', label: 'Токен', type: 'text', href: null, attributes: { type: 'text' } }
  ]

  await check('поля со словом «ключевой» принимают текст, настоящие секреты по-прежнему закрыты', async () => {
    const problems = []
    for (const element of WORDY) {
      const { api } = await makeScene({ wc: { reply: () => pageModel({ elements: [...ALL_ELEMENTS, ...WORDY, ...GUARDED] }) } })
      const { value, thrown } = await act(api, 'type', [{ index: element.index }, 'обычный текст', { submit: false }])
      if (thrown || !value || value.ok === false) problems.push(`«${element.name}» отклонено как секрет: ${thrown ? msg(thrown) : refusalReason(value)}`)
    }
    for (const element of GUARDED) {
      const { api } = await makeScene({ wc: { reply: () => pageModel({ elements: [...ALL_ELEMENTS, ...WORDY, ...GUARDED] }) } })
      const { value, thrown } = await act(api, 'type', [{ index: element.index }, SECRET_TEXT, { submit: false }])
      if (thrown || !value || value.ok !== false) problems.push(`«${element.name}» принял ввод, а это секрет`)
    }
    assert.deepEqual(problems, [], 'поля секретов и обычные поля путаются: ' + problems.join(' | '))
  })

  await check('висячий executeJavaScript не держит инструмент: честный отказ по timeoutMs', async () => {
    const started = Date.now()
    const { api } = await makeScene({ timeoutMs: 120, wc: { hang: true } })
    const problems = []
    for (const [name, args] of [['frame', []], ['click', [{ index: 0 }]], ['type', [{ index: 2 }, 'текст', { submit: false }]]]) {
      const { value, thrown } = await act(api, name, args)
      if (thrown) problems.push(`${name}: бросила ${msg(thrown)}`)
      else if (!value || value.ok !== false) problems.push(`${name}: вернула ${serialize(value).slice(0, 120)} вместо отказа`)
      else if (!/таймаут|время|timeout|превышен|не дожд|срок/i.test(refusalReason(value))) {
        problems.push(`${name}: срок не назван причиной отказа: «${refusalReason(value)}»`)
      }
    }
    assert.deepEqual(problems, [], 'висячая страница не прервана по сроку:\n  ' + problems.join('\n  '))
    assert.ok(Date.now() - started < 3500, `три действия с висячей страницей шли ${Date.now() - started} мс — срок обязан быть у каждого`)
  })

  await check('висячий capturePage не держит инструмент: честный отказ по timeoutMs', async () => {
    const { api } = await makeScene({ timeoutMs: 120, wc: { captureHang: true } })
    const { value, thrown } = await act(api, 'screenshot')
    if (thrown) throw new Error(`screenshot() бросила: ${msg(thrown)}`)
    assert.ok(value && value.ok === false, `висячий снимок вернул ${serialize(value).slice(0, 120)} вместо отказа`)
    assert.match(refusalReason(value), /таймаут|время|timeout|превышен|не дожд|срок/i)
  })

  await check('signal.abort() снимает действие раньше срока и называет причину', async () => {
    const started = Date.now()
    const { api, controller } = await makeScene({ timeoutMs: 5000, wc: { hang: true } })
    const pending = act(api, 'click', [{ index: 0 }])
    await sleep(40)
    controller.abort()
    const { value, thrown } = await pending
    assert.ok(!thrown, `отмена бросила исключение: ${msg(thrown)}`)
    assert.ok(value && value.ok === false, `после abort() вернул ${serialize(value).slice(0, 120)} вместо отказа`)
    assert.match(refusalReason(value), /останов|отмен|прерван|abort|прекращ|cancelled/i)
    assert.ok(Date.now() - started < 900,
      `отмена наступила через ${Date.now() - started} мс при timeoutMs=5000 — сигнал обязан снимать действие раньше срока, а не дожидать его`)
  })

  await check('после отказа, таймаута и отмены у webContents не остаётся ни одного слушателя', async () => {
    const scenes = []
    scenes.push({ name: 'таймаут', scene: await makeScene({ timeoutMs: 120, wc: { hang: true } }) })
    scenes.push({
      name: 'отказ сторожа',
      scene: await makeScene({ guard: { rejectAll: 'Запрещён доступ к локальному или частному адресу "127.0.0.1" (SSRF защита)' } })
    })
    const abortable = await makeScene({ timeoutMs: 5000, wc: { hang: true } })
    const pending = act(abortable.api, 'screenshot')
    await sleep(30)
    abortable.controller.abort()
    await pending
    scenes.push({ name: 'отмена', scene: abortable })

    const leaked = []
    for (const { name, scene } of scenes) {
      requireRealApi(scene.api, `проверка «после ${name} нет висящих слушателей»`)
      for (const [action, args] of [['frame', []], ['click', [{ index: 0 }]], ['type', [{ index: 2 }, 'текст', { submit: false }]], ['screenshot', []]]) {
        await act(scene.api, action, args)
      }
      const left = scene.wc.outstanding()
      if (left.length) {
        const stats = scene.wc.stats()
        leaked.push(`«${name}»: висит ${left.length} слушателей (${left.map(item => item.event).join(', ')}); ` +
          `навесил on/once ${stats.on + stats.once}, снял removeListener/off ${stats.removeListener + stats.off}, removeAllListeners ${stats.removeAllListeners}`)
      }
    }
    assert.deepEqual(leaked, [], 'движок копит подписки на подставном webContents:\n  ' + leaked.join('\n  '))
  })

  await check('повторные вызовы не копят подписки — ни на webContents, ни на abort-сигнал', async () => {
    const { api, wc, signalStats } = await makeScene({ timeoutMs: 300 })
    requireRealApi(api, 'проверка «повторные вызовы не копят подписки»')
    const rounds = []
    for (let i = 0; i < 4; i++) {
      await act(api, 'frame')
      rounds.push({ listeners: wc.outstanding().length, abort: signalStats.added - signalStats.removed })
    }
    assert.equal(rounds[0].listeners, 0, `после первого же вызова на webContents висит ${rounds[0].listeners} слушателей`)
    assert.equal(rounds[3].listeners, 0, `после четырёх вызовов висит ${rounds[3].listeners} слушателей — каждый ход добавляет по подписке`)
    const abortCounts = new Set(rounds.map(round => round.abort))
    assert.equal(abortCounts.size, 1,
      `подписок на abort-сигнал по раундам: ${rounds.map(round => round.abort).join(', ')} — движок вешает слушателя на каждый вызов и не снимает`)
  })

  await check('результат действия обрезан по maxChars, продолжение отдаётся по offset', async () => {
    const maxChars = 120
    const first = await makeScene({ maxChars, offset: 0, wc: { reply: () => pageModel({ page: LONG_PAGE }) } })
    const part1 = await act(first.api, 'click', [{ index: 0 }, { maxChars, offset: 0 }])
    assert.ok(!part1.thrown, `click() бросила: ${msg(part1.thrown)}`)
    assert.ok(part1.value && part1.value.ok !== false, `действие на разрешённой странице отказало: ${refusalReason(part1.value)}`)
    assert.ok(tokensPresent(part1.value),
      `текст страницы не попал в ответ ни под одним из правдоподобных имён (${Object.keys(ANY_CARRIER('')).join(', ')}): проверке нечем мерить обрезку`)
    const window = tokenWindow(part1.value)
    assert.ok(window.last < 400, `в ответ ушла вся страница (${LONG_PAGE.length} знаков) при maxChars=${maxChars}: лимит не соблюдён`)
    assert.ok(window.count <= 40, `окно из ${window.count} токенов не влезает в maxChars=${maxChars}`)
    assert.equal(window.first, 0, `первый ответ начинается не с начала страницы, а с токена ${window.first}`)
    assert.ok(limitNote(joined(part1.value)) || claimsMore(part1.value),
      `лимит не назван в ответе: ${serialize(part1.value).slice(0, 200)}`)

    const second = await makeScene({ maxChars, offset: 3000, wc: { reply: () => pageModel({ page: LONG_PAGE }) } })
    const part2 = await act(second.api, 'click', [{ index: 0 }, { maxChars, offset: 3000 }])
    assert.ok(!part2.thrown, `вызов с offset бросил: ${msg(part2.thrown)}`)
    assert.ok(part2.value && part2.value.ok !== false, `вызов с offset отказал: ${refusalReason(part2.value)}`)
    assert.ok(tokensPresent(part2.value), 'на offset=3000 в ответе нет ни одного знака страницы — продолжение не отдаётся')
    const next = tokenWindow(part2.value)
    assert.ok(next.first > 100, `offset=3000 вернул то же начало (токен ${next.first}): offset не соблюдён`)
    assert.ok(next.count <= 40, `продолжение тоже не обрезано: ${next.count} токенов при maxChars=${maxChars}`)
  })

  await check('«больше не влезло» отличается от «ничего нет», лимит кадра и размер снимка названы в ответе', async () => {
    const mid = await makeScene({ maxChars: 120, offset: 0, wc: { reply: () => pageModel({ page: LONG_PAGE }) } })
    const partway = await act(mid.api, 'click', [{ index: 0 }, { maxChars: 120, offset: 0 }])
    assert.ok(!partway.thrown, `базовый вызов бросил: ${msg(partway.thrown)}`)
    assert.ok(partway.value && partway.value.ok !== false, `базовый вызов отказал: ${refusalReason(partway.value)}`)
    assert.equal(claimsMore(partway.value), true,
      `посреди страницы ответ не говорит, что осталось ещё: ${serialize(partway.value).slice(0, 240)}`)

    const tailScene = await makeScene({ maxChars: 120, offset: LONG_PAGE.length + 500, wc: { reply: () => pageModel({ page: LONG_PAGE }) } })
    const end = await act(tailScene.api, 'click', [{ index: 0 }, { maxChars: 120, offset: LONG_PAGE.length + 500 }])
    assert.ok(!end.thrown, `вызов за концом страницы бросил: ${msg(end.thrown)}`)
    assert.ok(end.value && end.value.ok !== false, `за концом страницы отказ: ${refusalReason(end.value)} — надо отвечать «дальше ничего нет»`)
    assert.equal(tokensPresent(end.value), false, `за концом страницы в ответе всё ещё ${tokenWindow(end.value).count} токенов текста`)
    assert.equal(claimsMore(end.value), false,
      `страница кончилась, а ответ обещает продолжение: ${serialize(end.value).slice(0, 240)} — «не влезло» и «ничего нет» не различимы`)
    assert.match(serialize(end.value), /null|false|пуст|нет|конча|конце|вс[ёе]|дошл|end|последн/i,
      `конец страницы ничем не обозначен: ${serialize(end.value).slice(0, 240)}`)

    const frameScene = await makeScene({
      maxChars: 120,
      wc: {
        reply: () => pageModel({
          page: LONG_PAGE,
          elements: [
            { index: 0, tag: 'a', role: 'link', name: 'МИШЕНА-КОРОТКОЕ-ИМЯ', type: null, href: null },
            { index: 1, tag: 'button', role: 'button', name: 'МИШЕНА-ДЛИННОЕ-ИМЯ-' + 'Л'.repeat(4000), type: 'submit', href: null }
          ]
        })
      }
    })
    const frame = await act(frameScene.api, 'frame', [{}])
    assert.ok(!frame.thrown, `frame() бросила: ${msg(frame.thrown)}`)
    assert.ok(frame.value && frame.value.ok !== false, `frame() отказала: ${refusalReason(frame.value)}`)
    assert.ok(/МИШЕНА-КОРОТКОЕ-ИМЯ/.test(joined(frame.value)),
      `короткое имя элемента пропало из кадра: ${serialize(frame.value).slice(0, 200)}`)
    assert.ok(serialize(frame.value).length <= 4000,
      `кадр весом ${serialize(frame.value).length} байт при maxChars=120 — потолка кадра нет`)
    assert.ok(limitNote(joined(frame.value)), `лимит кадра не назван в ответе: ${serialize(frame.value).slice(0, 200)}`)
    assert.match(joined(frame.value), /\d{2,}/, 'числа, по которому видно потолок кадра, в ответе нет')

    const shotScene = await makeScene({ wc: { image: makeImage({ width: 1280, height: 800, bytes: 4096 }) } })
    const shot = await act(shotScene.api, 'screenshot')
    assert.ok(!shot.thrown, `screenshot() бросила: ${msg(shot.thrown)}`)
    assert.ok(shot.value && shot.value.ok !== false, `обычный снимок отклонён: ${refusalReason(shot.value)}`)
    assert.ok(sizeNote(joined(shot.value)), `размера снимка в ответе нет: ${serialize(shot.value).slice(0, 200)}`)
    assert.match(joined(shot.value), /1280|800|\d{3,}/, 'числа, по которому видно потолок снимка, в ответе нет')
  })

  await check('снимок имеет потолок по байтам и пикселям и не уходит модели целыми байтами', async () => {
    const cases = [
      ['пиксели 8000x6000', makeImage({ width: 8000, height: 6000, bytes: 4096 })],
      ['байты 12 МБ', makeImage({ width: 1024, height: 768, bytes: 12 * 1024 * 1024 })]
    ]
    const problems = []
    for (const [label, image] of cases) {
      const { api } = await makeScene({ wc: { image } })
      const { value, thrown } = await act(api, 'screenshot')
      if (thrown) { problems.push(`${label}: бросила ${msg(thrown)}`); continue }
      if (!value || typeof value !== 'object') { problems.push(`${label}: вернула ${typeof value} вместо ответа`); continue }
      if (value.ok === false) {
        if (!/потолок|превыш|слишком|больш|не влез|ограничен|размер|пиксел|байт|макс|лимит|limit/i.test(refusalReason(value))) {
          problems.push(`${label}: отказ есть, но причиной размера он не назван: «${refusalReason(value)}»`)
        }
        continue
      }
      const body = serialize(value)
      if (/(?:^|[^a-z0-9])base64[",:]?\s*[",:]?\s*[A-Za-z0-9+/]{200,}/i.test(body)) problems.push(`${label}: в ответ модели уехало base64-ведро`)
      if (body.length > 4000) problems.push(`${label}: ответ весит ${body.length} байт — целые байты ушли модели`)
      for (const text of stringsOf(value)) {
        if (text.length > 600) problems.push(`${label}: строка ответа в ${text.length} знаков похожа на выгруженные байты: ${text.slice(0, 40)}…`)
      }
      const dirty = nonPlainValues(value)
      if (dirty.length) problems.push(`${label}: в ответе лежат бинарные данные или функции: ${dirty.join(', ')}`)
      if (!sizeNote(body)) problems.push(`${label}: ответ не говорит ни о каком размере снимка: ${body.slice(0, 200)}`)
      if (!/потолок|превыш|обрез|сжат|умен|масштаб|не влез|макс|лимит|cap|limit|допустим/i.test(body)) {
        problems.push(`${label}: потолок размера не назван: ${body.slice(0, 200)}`)
      }
    }
    assert.deepEqual(problems, [], 'снимок не ограничен по размеру:\n  ' + problems.join('\n  '))

    const ok = await makeScene({ wc: { image: makeImage({ width: 1024, height: 768, bytes: 4096 }) } })
    const small = await act(ok.api, 'screenshot')
    assert.ok(!small.thrown, `screenshot() на обычном снимке бросила: ${msg(small.thrown)}`)
    assert.notEqual(small.value && small.value.ok, false,
      `обычный снимок (1024x768, 4 КБ) отклонён: ${refusalReason(small.value)} — потолок выдуман, а не соблюдён`)
    assert.match(serialize(small.value), /снимок|скриншот|screen|shot|кадр|png|изображен|preview|file|путь|url|href|path|ref/i,
      'ответ про снимок не сообщает, где на него смотреть: ни ссылки, ни имени файла')
  })

  await check('отказ оформлен ответом, а не исключением: мёртвое окно, отказ прав, плохой адрес, плохая цель', async () => {
    const scenes = {
      'мёртвое окно': await makeScene({ wc: { destroyed: true, url: 'не-адрес' } }),
      'отказ прав (executeJavaScript бросает)': await makeScene({ wc: { jsThrows: 'Permission denied: доступ к странице запрещён политикой' } }),
      'отказ снимка (capturePage бросает)': await makeScene({ wc: { captureThrows: 'Not allowed by permission policy' } }),
      'сторож отказал': await makeScene({ guard: { rejectAll: 'Запрещён доступ к локальному или частному адресу "127.0.0.1" (SSRF защита)' } }),
      'адрес неразборим': await makeScene({ wc: { url: 'вообще-не-url' } }),
      'пустой target': await makeScene(),
      'несуществующий index': await makeScene(),
      'несколько элементов под одним текстом': await makeScene({
        wc: { reply: () => pageModel({ elements: [{ index: 0, tag: 'button', role: 'button', name: 'ОК', type: 'submit', href: null }, { index: 1, tag: 'button', role: 'button', name: 'ОК', type: 'submit', href: null }] }) }
      })
    }
    const problems = []
    const calls = [['frame', []], ['click', [{ index: 99 }]], ['type', [{ index: 99 }, 'текст', { submit: false }]], ['screenshot', []]]
    for (const [label, scene] of Object.entries(scenes)) {
      const extra = label === 'пустой target' ? [['click', [{}]], ['type', [null, 'текст']]]
        : label === 'несколько элементов под одним текстом' ? [['click', [{ text: 'ОК' }]]] : []
      for (const [name, args] of [...calls, ...extra]) {
        const { value, thrown } = await act(scene.api, name, args)
        const title = `${label} → ${name}(${serialize(args[0] === undefined ? {} : args[0])})`
        if (thrown) problems.push(`${title}: бросила ${msg(thrown)}`)
        if (value && value.ok === false && !refusalReason(value).trim()) problems.push(`${title}: ok:false без причины`)
        if (value && value.ok === false && refusalReason(value).length > 400) problems.push(`${title}: причина длиннее 400 знаков`)
        if (value && value.ok === false && nonPlainValues(value).length) problems.push(`${title}: в отказе лежат бинарные данные`)
      }
    }
    assert.deepEqual(problems, [], 'публичный API роняет вызывающего вместо честного отказа:\n  ' + problems.slice(0, 14).join('\n  '))
  })

  await check('имена элементов и текст страницы — экранируемые строки, а не собранная разметка', async () => {
    const XSS_NAME = 'МИШЕНА-ИМЯ <img src=x onerror=alert(1)>'
    const XSS_TEXT = 'МИШЕНА-ТЕКСТ <img src=x onerror=alert(2)>'
    const elements = [
      { index: 0, tag: 'button', role: 'button', name: XSS_NAME, type: 'submit', href: 'javascript:alert(3)' },
      { index: 1, tag: 'a', role: 'link', name: 'Обычная ссылка', type: null, href: 'https://example.com/x' }
    ]
    const { api } = await makeScene({ wc: { reply: () => pageModel({ elements, page: XSS_TEXT }) } })
    const { value: frame, thrown } = await act(api, 'frame')
    if (thrown) throw new Error(`frame() бросила: ${msg(thrown)}`)
    assert.ok(frame && Array.isArray(frame.elements), `кадра нет: ${serialize(frame).slice(0, 160)}`)
    const target = frame.elements.find(el => String(el.name || '').includes('МИШЕНА-ИМЯ'))
    assert.ok(target, `имя элемента пропало из кадра: ${frame.elements.map(el => String(el.name)).join(' | ')}`)
    assert.equal(typeof target.name, 'string', `имя элемента — ${typeof target.name}, а не строка`)
    assert.ok(/&lt;img|<img src=x onerror=alert\(1\)>/.test(target.name),
      `имя элемента искажено до нечитаемого: «${target.name}» — надо отдать строку, которую окно экранирует как есть`)
    const dirty = nonPlainValues(frame)
    assert.deepEqual(dirty, [], `в кадре не-строки: ${dirty.join(', ')}`)

    const markup = /<(?:span|div|b|em|i|p|a|button)\b[^>]*>[^<]*МИШЕНА-(?:ИМЯ|ТЕКСТ)/i
    assert.equal(markup.test(joined(frame)), false,
      'модуль сам обернул имя модели в разметку — текст страницы и имена элементов обязаны уходить экранируемыми строками')
    const page = await act(api, 'click', [{ index: 0 }])
    assert.ok(!page.thrown, `click() бросила: ${msg(page.thrown)}`)
    assert.equal(markup.test(joined(page.value)), false, 'текст страницы собран в разметку вместо экранируемой строки')
    assert.ok(/МИШЕНА-ТЕКСТ/.test(joined(page.value)) || page.value && page.value.ok === false,
      `текст страницы исчез из ответа: ${serialize(page.value).slice(0, 200)}`)
  })

  await check('в чате есть browse_click, browse_input и browse_screenshot: определения, глаголы, ветки executeTool', async () => {
    const main = read(MAIN_SOURCE)
    const start = main.indexOf('const TOOL_DEFINITIONS = [')
    assert.ok(start >= 0, 'в main.js не найден якорь `const TOOL_DEFINITIONS = [` — проверка проводки ослепла')
    const end = main.indexOf('\n]', start)
    const region = main.slice(start, end > start ? end : main.length)
    const verbsStart = main.indexOf('const TOOL_VERBS')
    const verbs = main.slice(verbsStart, main.indexOf('function describeToolCall', verbsStart))
    const problems = []
    for (const name of ['browse_click', 'browse_input', 'browse_screenshot']) {
      const block = toolBlock(region, name)
      if (!block) problems.push(`${name}: нет в TOOL_DEFINITIONS`)
      else if (!/parameters[\s\S]{0,400}properties/.test(block)) problems.push(`${name}: у определения нет схемы аргументов`)
      if (!new RegExp(`${name}:\\s*'[^']+'`).test(verbs)) problems.push(`${name}: нет строки в TOOL_VERBS — в ленте «что делает агент» будет пустым`)
      if (!new RegExp(`name\\s*===\\s*'${name}'`).test(main)) problems.push(`${name}: нет ветки в executeTool`)
    }
    assert.deepEqual(problems, [], 'проводка инструментов чата не собрана:\n  ' + problems.join('\n  '))
    assert.ok(/agent-interact/.test(main), 'main.js не подключает src/main/agent-interact.js — действия идут мимо движка')
  })

  await check('ни один из browse_* инструментов не просит url: действие идёт только по открытому адресу', async () => {
    const main = read(MAIN_SOURCE)
    const start = main.indexOf('const TOOL_DEFINITIONS = [')
    assert.ok(start >= 0, 'в main.js не найден якорь `const TOOL_DEFINITIONS = [` — проверка проводки ослепла')
    const region = main.slice(start, main.indexOf('\n]', start) > start ? main.indexOf('\n]', start) : main.length)
    const problems = []
    for (const name of ['browse_click', 'browse_input', 'browse_screenshot']) {
      const block = toolBlock(region, name)
      if (!block) { problems.push(`${name}: определения ещё нет — проверить форму аргументов нечем`); continue }
      if (/\burl\b\s*:/.test(block)) problems.push(`${name}: у инструмента есть параметр адрес — действие обязано идти по уже открытому адресу, а не по новому`)
    }
    assert.deepEqual(problems, [], 'инструменты действий принимают адрес:\n  ' + problems.join('\n  '))
  })

  await check('события живого вида уходят в окно по каналу agent-browser-event через sendToWindow', async () => {
    const main = read(MAIN_SOURCE)
    const calls = main.match(/sendToWindow\s*\([^)]*'agent-browser-event'/g) || []
    assert.ok(calls.length >= 1, "в main.js нет ни одного sendToWindow(..., 'agent-browser-event', ...): живое окно не получит ни одного кадра")
    assert.ok(/createAgentInteraction|require\(['"][^'"]*agent-interact/.test(main),
      'главный процесс не заводит движок действий — событию неоткуда взяться')
    assert.equal(/webContents\.send\s*\(\s*['"]agent-browser-event/.test(main), false,
      'событие уходит напрямую в webContents.send, минуя sendToWindow: мёртвое окно уронит ход (план, 6.5)')
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed) console.log(`КРАСНЫХ проверок: ${failed} — продуктового кода 3.6б ещё нет, так и задумано`)
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})
