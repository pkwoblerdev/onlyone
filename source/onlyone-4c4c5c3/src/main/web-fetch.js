'use strict'

// Чтение веб-страницы для агента.
//
// Агенту нужен текст, а не разметка: скрипты, стили и служебные блоки
// выбрасываются, заголовки и списки остаются, ссылки становятся абсолютными —
// по ним можно пойти дальше. Длинная страница отдаётся частями: ответ говорит,
// с какого места читать следующую, и агент не тащит в контекст всё сразу.
//
// Куда можно ходить, решает не этот модуль, а вызывающий: перед каждым
// запросом, включая перенаправления, спрашивается allow(url, { local }).
// Иначе разрешённый сайт мог бы перенаправить на адрес в локальной сети.
//
// Проверяется ровно тот адрес, по которому подключаются: имя разрешили один
// раз на хоп, посмотрели все ответы, показали человеку — и к этим адресам
// и идут. Прежний порядок «сначала dns.lookup для проверки, потом транспорт
// разбирает имя заново» оставлял окно: между двумя разрешениями адрес мог
// смениться (DNS с нулевым временем жизни), и запрос уходил на loopback,
// которого человек не видел. Поэтому транспорт — node:http и node:https с
// закреплённым lookup: глобальным fetch адрес не закрепить, undici из Node
// не экспортируется.

const dns = require('node:dns').promises
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const zlib = require('node:zlib')

const MAX_BYTES = 3 * 1024 * 1024
const DEFAULT_CHARS = 20000
const MAX_CHARS = 60000
const TIMEOUT_MS = 20000
const MAX_REDIRECTS = 5

const stripBrackets = value => String(value || '').replace(/^\[|\]$/g, '')

function parseTarget(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('Некорректный адрес. Нужна полная ссылка вида https://example.com/page.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Читаются только ссылки http и https.')
  if (url.username || url.password) throw new Error('Логин и пароль в адресе не принимаются.')
  if (!url.hostname) throw new Error('В адресе нет хоста.')
  url.hash = ''
  return url
}

function portOf(url) {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
}

// Разбор IPv6 по RFC 4291 руками, а не сравнением строк: хвост может быть
// IPv4 и в точках (`::ffff:127.0.0.1`), и двумя хететами в шестнадцатеричной
// форме (`::ffff:7f00:1`). Первое WHATWG URL приводит ко второму, поэтому
// проверка по строке всегда пропускает одну из двух записей одного адреса.
// Идентификатор зоны (`fe80::1%eth0`) на смысл адреса не влияет.
function ipv6ToBytes(text) {
  let value = stripBrackets(text).trim().toLowerCase()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (!value.includes(':')) return null
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null
    const octets = tail.split('.').map(Number)
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    value = `${value.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const compressed = value.indexOf('::')
  let head
  let rest
  if (compressed >= 0) {
    if (value.indexOf('::', compressed + 2) >= 0) return null
    head = value.slice(0, compressed).split(':').filter(Boolean)
    const after = value.slice(compressed + 2)
    rest = after === '' ? [] : after.split(':')
  } else {
    head = value.split(':')
    rest = []
  }
  const groups = [...head, ...rest]
  if (!groups.length || !groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return null
  const filled = compressed >= 0
    ? [...head, ...Array(Math.max(0, 8 - groups.length)).fill('0'), ...rest]
    : groups
  if (filled.length !== 8) return null
  const bytes = Buffer.alloc(16)
  filled.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2))
  return bytes
}

function ipv4ToBytes(text) {
  const octets = String(text).split('.')
  if (octets.length !== 4 || !octets.every(octet => /^\d{1,3}$/.test(octet))) return null
  const values = octets.map(Number)
  if (values.some(octet => octet > 255)) return null
  return Buffer.from(values)
}

function addressBytes(text) {
  const host = stripBrackets(text).trim().toLowerCase()
  if (!host) return null
  if (net.isIPv4(host)) {
    const bytes = ipv4ToBytes(host)
    return bytes ? { family: 4, bytes } : null
  }
  if (net.isIPv6(host)) {
    const bytes = ipv6ToBytes(host)
    return bytes ? { family: 6, bytes } : null
  }
  return null
}

// Совпадение со старшими битами, а не с началом строки: `startsWith('fe80')`
// от link-local FE80::/10 накрывал только fe80::/112, и febf::1 проходил как
// внешний адрес.
function matchPrefix(bytes, base, bits) {
  for (let index = 0; index < bytes.length; index++) {
    const from = index * 8
    if (bits <= from) return true
    const mask = bits >= from + 8 ? 0xff : (0xff << (from + 8 - bits)) & 0xff
    if ((bytes[index] & mask) !== (base[index] & mask)) return false
  }
  return true
}

const v4 = (...octets) => Buffer.from(octets)
const v6 = text => ipv6ToBytes(text) || Buffer.alloc(16)

const PRIVATE_V4 = [
  [v4(0, 0, 0, 0), 8], // «эта сеть»
  [v4(10, 0, 0, 0), 8],
  [v4(127, 0, 0, 0), 8],
  [v4(100, 64, 0, 0), 10], // операторский NAT
  [v4(169, 254, 0, 0), 16],
  [v4(172, 16, 0, 0), 12],
  [v4(192, 0, 0, 0), 24], // служебные адреса IETF (RFC 6890): публичного маршрута нет
  [v4(198, 18, 0, 0), 15], // тестовые диапазоны (RFC 2544): то же
  [v4(192, 168, 0, 0), 16],
  [v4(224, 0, 0, 0), 3] // групповая рассылка и резерв: 224.0.0.0/3
]

const PRIVATE_V6 = [
  [v6('::'), 128],
  [v6('::1'), 128],
  [v6('fe80::'), 10], // весь link-local, не только fe80::/112
  [v6('fc00::'), 7], // unique-local по RFC 4193
  [v6('ff00::'), 8]
]

// Адреса, внутри которых живёт настоящий IPv4: смотреть надо на него.
// Teredo хранит адрес пира в дополнении до единицы. Разворачивать в точки
// для подключения можно только mapped-форму: `::1` — это IPv6-loopback, и
// сервер, который слушает только его, свёрнутый в 127.0.0.1 человек бы не
// достался, хотя спрашивается и то и другое одинаково.
const EMBEDDED_V4 = [
  { base: v6('::ffff:0:0'), bits: 96, at: 12, collapse: true },
  { base: v6('::'), bits: 96, at: 12 },
  { base: v6('2002::'), bits: 16, at: 2 },
  { base: v6('64:ff9b::'), bits: 96, at: 12 },
  { base: v6('2001:0::'), bits: 32, at: 12, complement: true }
]

function embeddedV4(bytes, onlyCollapse = false) {
  for (const entry of EMBEDDED_V4) {
    if (onlyCollapse && !entry.collapse) continue
    if (!matchPrefix(bytes, entry.base, entry.bits)) continue
    const inner = Buffer.from(bytes.subarray(entry.at, entry.at + 4))
    if (entry.complement) for (let index = 0; index < 4; index++) inner[index] ^= 0xff
    return inner
  }
  return null
}

const isPrivateV4 = bytes => PRIVATE_V4.some(([base, bits]) => matchPrefix(bytes, base, bits))

function isPrivateV6(bytes) {
  if (PRIVATE_V6.some(([base, bits]) => matchPrefix(bytes, base, bits))) return true
  const inner = embeddedV4(bytes)
  return inner ? isPrivateV4(inner) : false
}

function isPrivateAddress(address) {
  const parsed = addressBytes(address)
  // Непонятное значение трактуем как локальное: спрашивается, а не проходит.
  if (!parsed) return true
  return parsed.family === 4 ? isPrivateV4(parsed.bytes) : isPrivateV6(parsed.bytes)
}

// Форма, по которой реально подключаемся: вложенный IPv4 разворачиваем в
// точки, IPv6 отдаём без сжатия. Так проверенная запись адреса и та, что
// уходит в сокет, — одна и та же форма, а не две трактовки одной строки.
function canonicalAddress(address) {
  const parsed = addressBytes(address)
  if (!parsed) return null
  if (parsed.family === 4) return parsed.bytes.join('.')
  const inner = embeddedV4(parsed.bytes, true)
  if (inner) return inner.join('.')
  const groups = []
  for (let index = 0; index < 16; index += 2) groups.push(parsed.bytes.readUInt16BE(index).toString(16))
  return groups.join(':')
}

function isLocalName(hostname) {
  const host = stripBrackets(hostname).trim().toLowerCase().replace(/\.$/, '')
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
}

async function lookupAll(host, lookup = dns.lookup) {
  const entries = await lookup(host, { all: true, verbatim: true })
  const addresses = []
  for (const entry of entries || []) {
    const canonical = canonicalAddress(entry && entry.address)
    if (canonical && !addresses.includes(canonical)) addresses.push(canonical)
  }
  return addresses
}

// Одно разрешение на хоп: классификация и подключение идут по одному списку
// ответов, второго взгляда на DNS транспорт не делает.
//
// Разрешение имени — часть бюджета запроса, а не то, что можно ждать вечно:
// getaddrinfo зависает на столько, на сколько завис, и если человек нажал
// «стоп» или вышел срок, ждать ответа мы не обязаны.
async function resolveTarget(url, lookup = dns.lookup, signal = null) {
  const host = stripBrackets(url.hostname).toLowerCase()
  if (net.isIP(host)) {
    const canonical = canonicalAddress(host)
    if (!canonical) throw new Error(`Непонятный адрес хоста ${url.hostname}.`)
    return { host, port: portOf(url), addresses: [canonical] }
  }
  const resolving = lookupAll(host, lookup)
  let addresses
  try {
    addresses = await (signal ? stoppable(resolving, signal) : resolving)
  } catch (error) {
    // Отмена или срок: отдаём то же, что отдал бы транспорт при этом сигнале,
    // чтобы «стоп» для вызывающего не отличался от прежнего.
    if (error && error.stopped) throw signal.reason
    throw new Error(`Имя ${url.hostname} не разрешилось: ${error.code || error.message}`)
  }
  if (!addresses.length) throw new Error(`Имя ${url.hostname} не вернуло ни одного адреса.`)
  return { host, port: portOf(url), addresses }
}

// Гонка работы с сигналом отмены. Саму работу не отменить (резолвер Node
// закрытия не принимает), но промис мы не держим: ожидающий получает отказ
// сразу, а поздний ответ разрешения уже никому не нужен.
function stoppable(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Отменено'), { stopped: true }))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Отменено'), { stopped: true }))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) })
  })
}

function isLocalResolved(host, addresses) {
  return isLocalName(host) || addresses.some(address => isPrivateAddress(address))
}

async function classifyTarget(rawUrl, lookup = dns.lookup) {
  const url = parseTarget(rawUrl)
  const target = await resolveTarget(url, lookup)
  return { url, ...target, local: isLocalResolved(target.host, target.addresses) }
}

// Локальный адрес — это и localhost, и имя, которое указывает в домашнюю сеть:
// роутер, NAS, чужой dev-сервер. Такие адреса подтверждаются всегда.
// failClosed — для стража чужих загрузчиков (yt-dlp, MCP-клиент): они резолвят
// имя сами, и отказ резолва здесь — не «публичный адрес», а неизвестность,
// которая может разрешиться в loopback уже после проверки (break-5b Н15).
async function isLocalHost(hostname, lookup = dns.lookup, failClosed = false) {
  const host = stripBrackets(hostname).toLowerCase()
  if (isLocalName(host)) return true
  if (net.isIP(host)) return isPrivateAddress(host)
  let addresses = []
  try {
    addresses = await lookupAll(host, lookup)
  } catch {
    // Имя не разрешилось — свой транспорт упадёт с понятной ошибкой сети.
    return failClosed
  }
  if (!addresses.length) return failClosed
  return addresses.some(address => isPrivateAddress(address))
}

// «Авто» — режим без спроса: `approvalRequired` пропускает сеть молча. Значит
// локальный адрес там не подтверждается человеком, а запрещается outright —
// иначе инструмент в «Авто» достаёт loopback, link-local/metadata и домашнюю
// сеть, никого не спросив (Н93). Диапазоны — тот же helper, что у `fetch_url`:
// второго определения приватных адресов не заводим. Пустая строка — можно.
// Провайдеры и фид обновлений запрашивает само приложение, а не эти инструменты.
async function autoLocalRefusal(rawUrl, permission, lookup = dns.lookup) {
  if (permission !== 'auto') return ''
  let host = ''
  try {
    host = stripBrackets(new URL(String(rawUrl || '')).hostname).toLowerCase()
  } catch {
    return ''
  }
  if (!host || !(await isLocalHost(host, lookup, true))) return ''
  return `Адрес ${host} локальный, в вашей сети или не разрешился при проверке. В «Авто» такие адреса запрещены: спроса там нет. ` +
    'Выберите ссылку вручную в режиме с подтверждением или возьмите адрес вне домашней сети.'
}

// yt-dlp и MCP-клиент ходят по редиректам сами: проверка одной строки входа
// оставляла 302 в loopback без суда. В «Авто» цепь проходится своим закреплённым
// транспортом (как fetch_url), локальный хоп запрещается, отказ резолва или
// сети — тоже запрет (fail-closed). Ручные режимы не трогаются: там отвечает
// человек (break-5b Н15).
async function autoRedirectRefusal(rawUrl, permission, { lookup = dns.lookup, request = requestVerified, signal = null } = {}) {
  if (permission !== 'auto') return ''
  let url
  try { url = parseTarget(String(rawUrl || '')) } catch { return 'Некорректный или небезопасный адрес запрещён в режиме «Авто».' }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target
    try {
      target = await resolveTarget(url, lookup, signal)
    } catch {
      return `Адрес ${url.hostname} не разрешился при проверке перенаправлений. В «Авто» такие адреса запрещены: спроса там нет.`
    }
    if (isLocalResolved(target.host, target.addresses)) {
      return `Адрес ${target.host} локальный или в вашей сети${hop ? ' (перенаправление)' : ''}. В «Авто» такие адреса запрещены: спроса там нет.`
    }
    let response
    try {
      response = await request({ url, addresses: target.addresses, signal: signal || AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      return `Не удалось проверить перенаправления адреса ${url.hostname}. В «Авто» такие адреса запрещены: спроса там нет.`
    }
    const location = response.header('location')
    if (response.status >= 300 && response.status < 400 && location) {
      response.discard()
      try { url = parseTarget(new URL(location, url).href) } catch {
        return `Перенаправление адреса ${url.hostname} ведёт на непонятный адрес. В «Авто» это запрещено.`
      }
      continue
    }
    response.discard()
    return ''
  }
  return `Слишком много перенаправлений у адреса ${url.hostname}. В «Авто» это запрещено.`
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', times: '×', rarr: '→', larr: '←'
}

function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X'
      const n = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : whole
  })
}

// Разметка снимается проходом по строке, а не регуляркой с [^>]+: на тексте
// из одних «<» без «>» она перебирает остаток от каждого вхождения.
function stripTags(html) {
  const text = String(html || '')
  let out = ''
  let from = 0
  let scan = 0
  for (let open; (open = text.indexOf('<', scan)) >= 0;) {
    const close = text.indexOf('>', open + 1)
    if (close < 0) break
    if (close === open + 1) { scan = open + 1; continue } // «<>» тегом не считается
    out += text.slice(from, open)
    from = scan = close + 1
  }
  return out + text.slice(from)
}

// Служебные блоки вырезаются от открывающего тега до ближайшего закрывающего.
// Прежняя регулярка с ленивым [\s\S]*? при незакрытом теге просматривала
// остаток страницы от каждого вхождения — квадрат, а страница бывает 3 МиБ.
const BLOCK_OPENERS = {}
const BLOCK_CLOSERS = {}
const BLOCK_NAMES = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'head', 'select']

function stripBlocks(html, names = BLOCK_NAMES) {
  const key = names.join('|')
  const opener = BLOCK_OPENERS[key] || (BLOCK_OPENERS[key] = new RegExp(`<(${names.join('|')})\\b`, 'gi'))
  const gone = new Set()
  let out = ''
  let from = 0
  opener.lastIndex = 0
  for (let match; (match = opener.exec(html));) {
    const name = match[1].toLowerCase()
    if (gone.has(name)) continue
    const close = BLOCK_CLOSERS[name] || (BLOCK_CLOSERS[name] = new RegExp(`</${name}>`, 'gi'))
    close.lastIndex = opener.lastIndex
    const end = close.exec(html)
    if (!end) { gone.add(name); continue }
    out += html.slice(from, match.index)
    from = opener.lastIndex = end.index + end[0].length
  }
  return out + html.slice(from)
}

// Незакрытый комментарий раньше тоже просматривался до конца страницы на каждом
// `<!--`. Второй `<!--` без `-->` больше не запускает новый проход.
function stripComments(html) {
  let out = ''
  let from = 0
  let scan = 0
  for (let open; (open = html.indexOf('<!--', scan)) >= 0;) {
    const close = html.indexOf('-->', open + 4)
    if (close < 0) break
    out += html.slice(from, open)
    from = scan = close + 3
  }
  return out + html.slice(from)
}

// Заголовок превращается в строку Markdown тем же проходом: раньше ленивый
// `([\s\S]*?)</hN>` на незакрытом `<h1 ` перебирал остаток от каждого тега.
// Последний `</hN>` отсечён заранее: после него поиск закрывающего тега уже
// ничего не найдёт, и повторять проход по остатку незачем.
function headingsToText(source) {
  const lower = source.toLowerCase()
  const lastClose = {}
  for (const level of '123456') lastClose[level] = lower.lastIndexOf('</h' + level + '>')
  let out = ''
  let from = 0
  let scan = 0
  while (true) {
    const open = lower.indexOf('<h', scan)
    if (open < 0) break
    const level = lower[open + 2]
    if (!'123456'.includes(level) || /[a-z0-9]/.test(lower[open + 3] || '')) { scan = open + 2; continue }
    const gt = lower.indexOf('>', open + 3)
    if (gt < 0 || gt > lastClose[level]) break
    const closeTag = '</h' + level + '>'
    const close = lower.indexOf(closeTag, gt + 1)
    if (close < 0) break
    const inner = stripTags(source.slice(gt + 1, close)).replace(/\s+/g, ' ').trim()
    out += source.slice(from, open) + '\n\n' + '#'.repeat(Number(level)) + ' ' + inner + '\n\n'
    from = scan = close + closeTag.length
  }
  return out + source.slice(from)
}

// Остальная разметка — одним проходом. Прежние восемь `.replace()` с `[^>]*>`
// и ленивым `[\s\S]*?` вели себя квадратично на soup из незакрытых тегов:
// 320 КБ «<a » держали главный процесс 25 с, 40 КБ «<img alt=» — 98 с,
// а страница допускается до 3 МиБ.
const MAX_TAG_CHARS = 8192
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'ul', 'ol', 'table', 'tr',
  'blockquote', 'pre', 'li', 'dd', 'dt', 'dl', 'figure', 'figcaption', 'form', 'details', 'summary'])
const TAG_NAME = /^<(\/?)([a-z][a-z0-9-]*)/i
const ANCHOR_TAG = /^<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/i
const IMAGE_TAG = /^<img\b[^>]*?alt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/i
const LIST_ITEM = /^<li\b[^>]*>/i
const LINE_BREAK = /^<br\s*\/?>/i
const TABLE_CELL = /^<t[dh]\b[^>]*>/i

// Первый блок `<name …> … </name>` тем же способом, что и остальное: ленивый
// `([\s\S]*?)</name>` на soup из незакрытых `<title`/`<main`/`<article`
// просматривал остаток от каждого вхождения (320 КБ = 17–26 с).
function firstBlockContent(source, name) {
  const lower = source.toLowerCase()
  const open = '<' + name
  const closeTag = '</' + name + '>'
  const lastClose = lower.lastIndexOf(closeTag)
  let scan = 0
  while (scan <= lastClose) {
    const at = lower.indexOf(open, scan)
    if (at < 0) break
    const rest = lower[at + open.length]
    if (name !== 'title' && rest && /[a-z0-9_]/.test(rest)) { scan = at + open.length; continue }
    const gt = lower.indexOf('>', at)
    if (gt < 0) break
    const close = lower.indexOf(closeTag, gt + 1)
    if (close >= 0 && close <= lastClose) return source.slice(gt + 1, close)
    scan = at + open.length
  }
  return ''
}

function markupToText(source, absolute) {
  const lower = source.toLowerCase()
  const lastAnchor = lower.lastIndexOf('</a>')
  let out = ''
  let scan = 0
  while (scan < source.length) {
    const lt = lower.indexOf('<', scan)
    if (lt < 0) { out += source.slice(scan); break }
    out += source.slice(scan, lt)
    const gt = lower.indexOf('>', lt + 1)
    if (gt < 0) { out += source.slice(lt); break } // «<» без «>» — остаток идёт как текст
    if (gt === lt + 1) { out += '<'; scan = lt + 1; continue } // «<>» тегом не считается
    const head = source.slice(lt, gt + 1)
    const name = TAG_NAME.exec(head)
    if (name && name[1] !== '/') {
      const tag = name[2].toLowerCase()
      if (tag === 'a' || tag === 'img') {
        const isAnchor = tag === 'a'
        // Атрибуты смотрим в окне: незакрытая кавычка иначе прочитала бы остаток.
        // shortcut: тег длиннее 8 КиБ ссылкой не становится — его текст остаётся.
        const attrs = (isAnchor ? ANCHOR_TAG : IMAGE_TAG).exec(source.slice(lt, lt + MAX_TAG_CHARS))
        if (isAnchor && attrs) {
          const end = lt + attrs[0].length
          const close = end <= lastAnchor ? lower.indexOf('</a>', end) : -1
          if (close >= 0) {
            const label = stripTags(source.slice(end, close)).replace(/\s+/g, ' ').trim()
            const href = (attrs[1] ?? attrs[2] ?? '').trim()
            if (label) {
              out += !href || href.startsWith('#') || /^javascript:/i.test(href)
                ? label
                : `[${label}](${absolute(href)})`
            }
            scan = close + 4
            continue
          }
        } else if (!isAnchor && attrs) {
          const alt = (attrs[1] ?? attrs[2] ?? '').trim()
          out += alt ? ` [изображение: ${alt}] ` : ''
          scan = lt + attrs[0].length
          continue
        }
      } else if (tag === 'li' && LIST_ITEM.test(head)) {
        out += '\n- '
      } else if (tag === 'br' && LINE_BREAK.test(head)) {
        out += '\n'
      } else if ((tag === 'td' || tag === 'th') && TABLE_CELL.test(head)) {
        out += ' | '
      } else if (BLOCK_TAGS.has(tag)) {
        out += '\n'
      }
    } else if (name && name[1] === '/' && BLOCK_TAGS.has(name[2].toLowerCase())) {
      out += '\n'
    }
    scan = gt + 1 // любой прочий тег снимается
  }
  return out
}

function htmlToText(html, base) {
  let source = String(html || '')
  const title = decodeEntities(stripTags(firstBlockContent(source, 'title')))
    .replace(/\s+/g, ' ').trim()

  source = stripBlocks(stripComments(source))

  // Основное содержимое, если страница его размечает. Меню и подвал в ответе —
  // это сотни строк ссылок, которые агенту только мешают.
  const main = firstBlockContent(source, 'main') || firstBlockContent(source, 'article')
  if (main && stripTags(main).trim().length > 400) source = main
  else source = stripBlocks(source, ['nav', 'footer'])

  const absolute = href => {
    try { return new URL(decodeEntities(href), base).href } catch { return href }
  }

  const text = markupToText(headingsToText(source), absolute)

  const clean = decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: clean }
}

function charsetOf(type, head) {
  const fromHeader = String(type || '').match(/charset=["']?([\w-]+)/i)?.[1]
  if (fromHeader) return fromHeader
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8'
}

function decodeBody(buffer, type) {
  const head = buffer.subarray(0, 2048).toString('latin1')
  const label = charsetOf(type, head)
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    // Незнакомая кодировка в заголовке — читаем как UTF-8, а не падаем.
    return new TextDecoder('utf-8').decode(buffer)
  }
}

const BINARY = /^(image|audio|video|font)\/|^application\/(pdf|zip|octet-stream|x-(?:tar|gzip|7z|rar)|vnd\.)/

// Ответ транспорта приводится к одному виду: статус, заголовок, поток байтов
// и способ сбросить соединение. Так fetchPage не зависит от того, кто открыл
// сокет, а проверка подставляет свой транспорт, не подменяя разбор ответа.
function wrapResponse(response) {
  const status = response.statusCode || 0
  return {
    status,
    ok: status >= 200 && status < 300,
    header(name) {
      const value = response.headers[String(name).toLowerCase()]
      return Array.isArray(value) ? value[0] : value
    },
    stream: response,
    discard() { response.destroy() }
  }
}

// Подключение идёт только по тем адресам, которые уже показали человеку:
// транспорт спрашивает нас, где этот хост, и получает ровно проверенный
// список. Второго разрешения имени не происходит.
function pinnedLookup(addresses) {
  return (host, options, callback) => {
    const family = address => (address.includes(':') ? 6 : 4)
    const wanted = options && options.family
    const matching = wanted ? addresses.filter(address => family(address) === wanted) : addresses
    const usable = matching.length ? matching : addresses
    if (options && options.all) return callback(null, usable.map(address => ({ address, family: family(address) })))
    callback(null, usable[0], family(usable[0]))
  }
}

const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) onlyone',
  accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
  'accept-encoding': 'gzip, deflate, br'
}

function requestVerified({ url, addresses, signal, headers = REQUEST_HEADERS }) {
  const secure = url.protocol === 'https:'
  return new Promise((resolve, reject) => {
    let settled = false
    const request = (secure ? https : http).request({
      // Имя хоста остаётся исходным: меняем только то, где его искать. Поэтому
      // и Host, и SNI, и проверка сертификата идут по настоящему имени сайта,
      // а не по адресу, к которому подключились.
      host: url.hostname,
      port: portOf(url),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      lookup: pinnedLookup(addresses),
      signal
    }, response => {
      settled = true
      const socket = request.socket
      const dialed = socket && canonicalAddress(socket.remoteAddress)
      if (!dialed || !addresses.includes(dialed)) {
        socket.destroy()
        reject(new Error(`Соединение ушло на непроверенный адрес ${socket.remoteAddress}.`))
        return
      }
      resolve(wrapResponse(response))
    })
    request.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    request.end()
  })
}

// Распаковщик вешают между соединением и читателем, а pipe не переносит
// беду источника в приёмник: оборвалось соединение или человек нажал «стоп» —
// и чтение сжатой страницы висит вечно. Поэтому ошибку и закрытие источника
// передаём приёмнику явно.
function bodyStream(source) {
  const raw = source.stream
  const encoding = String(source.header('content-encoding') || '').toLowerCase().trim()
  let z = null
  if (encoding === 'gzip' || encoding === 'x-gzip') z = raw.pipe(zlib.createGunzip())
  else if (encoding === 'deflate') z = raw.pipe(zlib.createInflate())
  else if (encoding === 'br') z = raw.pipe(zlib.createBrotliDecompress())
  if (!z) return raw
  const breakOff = error => {
    if (!z.destroyed) z.destroy(error || new Error('Соединение оборвалось при чтении сжатой страницы.'))
  }
  raw.on('error', error => breakOff(error))
  raw.on('close', () => { if (!raw.readableEnded) breakOff() })
  return z
}

// Предел считаем по развернутым байтам, а не по сырым: иначе одна сжатая
// страница разрешилась бы в гигабайты в памяти до среза.
async function readLimited(source) {
  const chunks = []
  let total = 0
  let cut = false
  const stream = bodyStream(source)
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_BYTES) {
        const keep = buffer.length - (total - MAX_BYTES)
        if (keep > 0) chunks.push(buffer.subarray(0, keep))
        cut = true
        break
      }
      chunks.push(buffer)
    }
  } finally {
    if (stream !== source.stream) stream.destroy()
    source.discard()
  }
  return { buffer: Buffer.concat(chunks), cut }
}

async function fetchPage(rawUrl, { allow, signal = null, offset = 0, maxChars, lookup = dns.lookup, request = requestVerified } = {}) {
  if (typeof allow !== 'function') throw new Error('fetchPage: нужен allow(url).')
  let url = parseTarget(rawUrl)
  const limit = Math.min(MAX_CHARS, Math.max(1000, Number(maxChars) || DEFAULT_CHARS))
  // Срок сети отсчитывается от начала своей фазы, а не от старта чтения: карточка
  // подтверждения живёт до 30 минут, и раздумье человека не должно съедать таймер
  // запроса — нажатое «Разрешить» оборачивалось TimeoutError (break-5b Н14).
  const budget = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)

  let response = null
  let local = false
  for (let hop = 0; ; hop++) {
    // Адрес проверяется и закрепляется на каждом хопе, до разрешения:
    // перенаправление с разрешённого сайта в локальную сеть спрашивается
    // заново, и отвечает человек, а не сервер в сети.
    const target = await resolveTarget(url, lookup, budget())
    local = isLocalResolved(target.host, target.addresses)
    if (!(await allow(url, { local, addresses: target.addresses, hop }))) {
      return { success: false, denied: true, local, url: url.href, message: `Чтение ${url.host} отклонено пользователем.` }
    }
    // Отмена могла прийти, пока мы разрешали имя или ждали человека. Подключение
    // в этом случае не начинаем вовсе: «стоп» не должен оборачиваться новым
    // запросом, которого сервер ещё не видел.
    const combined = budget()
    if (combined.aborted) throw combined.reason
    response = await request({ url, addresses: target.addresses, signal: combined })
    const location = response.header('location')
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error('Слишком много перенаправлений.')
      response.discard()
      url = parseTarget(new URL(location, url).href)
      continue
    }
    break
  }

  const type = String(response.header('content-type') || '').toLowerCase()
  const kind = type.split(';')[0].trim()
  if (BINARY.test(kind)) {
    response.discard()
    return { success: false, status: response.status, finalUrl: url.href, local, contentType: kind,
      error: `Это не текстовая страница (${kind}). fetch_url читает HTML, текст и JSON.` }
  }

  const { buffer, cut } = await readLimited(response)
  const raw = decodeBody(buffer, type)
  let title = ''
  let text = raw
  if (kind.includes('html') || /^\s*<(!doctype html|html)/i.test(raw.slice(0, 300))) {
    ({ title, text } = htmlToText(raw, url.href))
  } else if (kind.includes('json')) {
    try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch { text = raw }
  }

  const start = Math.max(0, Math.min(Math.floor(Number(offset) || 0), text.length))
  const part = text.slice(start, start + limit)
  const nextOffset = start + part.length < text.length ? start + part.length : null
  const result = {
    success: response.ok,
    status: response.status,
    finalUrl: url.href,
    local,
    title,
    contentType: kind,
    length: text.length,
    offset: start,
    text: part,
    nextOffset
  }
  if (nextOffset !== null) result.hint = `Показано ${start}–${nextOffset} из ${text.length} знаков. Продолжение: fetch_url с offset=${nextOffset}.`
  if (cut) result.truncatedBytes = true
  if (!response.ok) result.error = `Сервер ответил ${response.status}.`
  return result
}

module.exports = {
  MAX_BYTES,
  DEFAULT_CHARS,
  MAX_CHARS,
  parseTarget,
  isPrivateAddress,
  canonicalAddress,
  isLocalName,
  resolveTarget,
  classifyTarget,
  isLocalHost,
  autoLocalRefusal,
  autoRedirectRefusal,
  decodeEntities,
  htmlToText,
  requestVerified,
  fetchPage
}
