// U-7: Workspace в Ultra и шеринг («Ultra = Ultra»).
//
// Слово владельца 01.10: в Ultra человек «крафтит» своё Workspace — расположение
// блоков, активных агентов, инструменты, подключённые файлы, контекст и
// сценарии — и может им поделиться; у другого человека в Ultra разворачивается
// в точности такое же рабочее пространство.
//
// ЧТО ЗДЕСЬ И ЧТО НЕ ЗДЕСЬ. Этот модуль — ЯДРО контейнера: что именно кладётся в
// файл, чем целостность контейнера проверяется и как чужой контейнер
// разворачивается. Это не интерфейс и не сеть. Граница проведена по одному
// признаку: всё, что можно проверить и развернуть без человека перед экраном,
// живёт здесь; всё, где нужен выбор способа (файл, ссылка, сеть), — не здесь.
//
// ПОЧЕМУ КОНТЕЙНЕР ОДНОВ ФАЙЛОМ. «В точности такое же» означает, что у другого
// человека не должно быть разночтений, из чего Workspace собран. Набор файлов
// человек приносит половиной, и половина не работает. Один файл с версией формата
// и контрольной суммой — единственный вид, который можно и проверить, и
// развернуть.
//
// БЕЗОПАСНОСТЬ, КОТОРАЯ ЗДЕСЬ ЖЁСТКО. Контейнер приходит от другого человека,
// то есть это НОВЫЕ данные, и доверять им нельзя:
//   — всё, что попадает в контейнер, проходит ту же чистку, что и данные из
//     сети: имена файлов без путей и без `..`, никаких команд, никаких адресов;
//   — контейнер НЕ приносит ни ключей, ни паролей, ни содержимого чужих файлов:
//     он приносит ИМЕНА и меру, а разворачивается против файлов того, у кого его
//     открывают;
//   — версия формата проверяется, и непонятный контейнер не разворачивается
//     молча, а называет причину.
//
// ЧТО НЕ ДЕЛАЕТ МОДУЛЬ. Не пишет на диск (это дело вызывающего, у него свой
// конверт `safeStorage`), не ходит в сеть, не трогает настройки. Всё это приходит
// снаружи зависимостями — так модуль проверяется без Electron вообще.
'use strict'

// Версия формата. Число, а не строка: контейнер прошлого года должен открываться
// сегодня, а завтрашний — нет, и молчаливый разбор чужого формата хуже отказа.
const FORMAT = 'onlyone.workspace'
const VERSION = 1

// Пределы. Контейнер — это файл, который человек приносит с собой; без предела
// один человек может положить в файл всё, что захочет, и второй откроет его на
// своём диске.
const LIMITS = Object.freeze({
  // Сколько чего в контейнере. Числа маленькие: Workspace — это организация
  // работы, а не перенос проекта.
  blocks: 64,
  agents: 32,
  tools: 32,
  files: 512,
  scenarios: 64,
  // Длина одной строки. Имена бывают длинными, но не настолько.
  text: 200,
  path: 400,
  // Мера блока в пикселях — от и до. Мера внутри окна, и контейнер из чужого
  // экрана на этом экране быть не может.
  size: Object.freeze({ min: 120, max: 20000 }),
  position: Object.freeze({ min: -20000, max: 20000 })
})

// ─── чистка значений ─────────────────────────────────────────────────────────
// Всё, что пришло из контейнера, проходит здесь. Правило одно и оно не
// обсуждается: чужой файл не имеет права указывать путь, имя команды или адрес.
// Имя файла — это имя, а не путь: без слешей, без `..`, без буквы диска.

const isSafeName = value => {
  const text = String(value == null ? '' : value).trim()
  if (!text || text.length > LIMITS.text) return null
  if (/[\\/]/.test(text)) return null
  if (text === '.' || text === '..' || text.includes('..')) return null
  if (/^[a-z]:/i.test(text)) return null
  if (/^[/~]/.test(text)) return null
  if (/[\0<>:"|?*]/.test(text)) return null
  return text
}

const text = (value, max = LIMITS.text) => {
  const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return out.slice(0, max)
}

const num = (value, bounds, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)))
}

const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback)

// Список строк: режется по длине, каждая проходит чистку, дубли уходят.
const names = (value, limit) => {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const one of list) {
    const safe = isSafeName(one)
    if (!safe) continue
    if (out.includes(safe)) continue
    out.push(safe)
    if (out.length >= limit) break
  }
  return out
}

// ─── что кладётся ────────────────────────────────────────────────────────────
// Пять вещей, названных владельцем: расположение блоков, активные агенты,
// инструменты, подключённые файлы, контекст и сценарии. Ничего сверх этого: поле
// «что ещё» в контейнере — это место, куда через полгода положат секрет.

function blockEntry (raw) {
  // Идентификатор блока не из контейнера не восстановить, поэтому он остаётся
  // СВОИМ для каждой раскладки, и разворот сопоставляет блоки по названию и роли,
  // а не по чужому идентификатору.
  const title = text(raw && raw.title)
  const role = text(raw && raw.role, 40)
  if (!title) return null
  return {
    title,
    role,
    x: num(raw && raw.x, LIMITS.position, 0),
    y: num(raw && raw.y, LIMITS.position, 0),
    w: num(raw && raw.w, LIMITS.size, 360),
    h: num(raw && raw.h, LIMITS.size, 480),
    // `zone` — куда блок прилип: left, right, bottom, free. Неизвестное значение
    // читается как «свободный блок», а не как чужое слово из файла.
    zone: ['left', 'right', 'bottom', 'free'].includes(raw && raw.zone) ? raw.zone : 'free',
    minimized: bool(raw && raw.minimized)
  }
}

function scenarioEntry (raw) {
  const title = text(raw && raw.title)
  if (!title) return null
  return {
    title,
    // Сценарий Ultra — это свободный блок, а не готовый процесс: у него нет
    // графа этапов, и придумывать его при развороте значило бы врать.
    blocks: names(raw && raw.blocks, LIMITS.blocks),
    note: text(raw && raw.note)
  }
}

function normalize (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
    .map(blockEntry).filter(Boolean).slice(0, LIMITS.blocks)
  const scenarios = (Array.isArray(source.scenarios) ? source.scenarios : [])
    .map(scenarioEntry).filter(Boolean).slice(0, LIMITS.scenarios)
  return {
    name: text(source.name, LIMITS.text) || 'Workspace',
    // Версия и формат — СНАРУЖИ, в шапке. Внутри им не место: разбор шапки идёт
    // раньше, чем он вообще смотрит на содержимое.
    blocks,
    agents: names(source.agents, LIMITS.agents),
    tools: names(source.tools, LIMITS.tools),
    // Файлы — имена относительно папок проекта. Чужие абсолютные пути в
    // контейнере не хранятся: у другого человека их всё равно нет.
    files: names(source.files, LIMITS.files),
    context: text(source.context, LIMITS.text * 4),
    scenarios
  }
}

// ─── контрольная сумма ───────────────────────────────────────────────────────
// Не криптографическая: смысл в том, чтобы развёрнутый контейнер и собранный из
// него обратно дали одно и то же, и чтобы молча подменённый файл это выдал.
// Порядок ключей задан явно, иначе сумма зависела бы от порядка полей.

const FINGERPRINT_KEYS = Object.freeze(['name', 'agents', 'tools', 'files', 'context'])

function fingerprint (workspace) {
  const data = workspace || normalize({})
  const parts = []
  for (const key of FINGERPRINT_KEYS) parts.push(key + '=' + JSON.stringify(data[key]))
  parts.push('blocks=' + JSON.stringify((data.blocks || []).map(one => [one.title, one.role, one.zone, one.w, one.h])))
  parts.push('scenarios=' + JSON.stringify((data.scenarios || []).map(one => [one.title, one.blocks])))
  let hash = 0x811c9dc5
  const text2 = parts.join('|')
  for (let i = 0; i < text2.length; i++) {
    hash ^= text2.charCodeAt(i)
    // FNV-1a на 32 битах: умножение держим в беззнаковом, иначе в старших битах
    // JS даёт отрицательное и сумма «плывёт» от машины к машине.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// ─── сборка и разбор ─────────────────────────────────────────────────────────

// Собрать контейнер из рабочего пространства. Отдаётся ТЕКСТ, а не файл:
// запись на диск и конверт `safeStorage` — дело вызывающего, и модуль не должен
// знать, шифруется контейнер или нет.
function pack (workspace, meta) {
  const clean = normalize(workspace)
  const body = {
    format: FORMAT,
    version: VERSION,
    // Кто собрал — только имя, которое человек сам ввёл. Никаких путей,
    // никаких машинных идентификаторов: контейнер уходит другому человеку.
    author: text(meta && meta.author, LIMITS.text),
    name: clean.name,
    agents: clean.agents,
    tools: clean.tools,
    files: clean.files,
    context: clean.context,
    blocks: clean.blocks,
    scenarios: clean.scenarios,
    fingerprint: fingerprint(clean)
  }
  return JSON.stringify(body, null, 2)
}

// Разобрать контейнер. Возвращает `{ ok, workspace, reason, meta }` и НИКОГДА не
// бросает: контейнер приходит от человека, и ошибка разбора — это его ошибка,
// а не падение программы. `ok: false` всегда с причиной словами.
function unpack (source) {
  let raw = source
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    // Уже разобранный объект: забыть про это нельзя, значит приму и его.
  } else {
    try {
      raw = JSON.parse(Buffer.isBuffer(source) ? source.toString('utf8') : String(source == null ? '' : source))
    } catch (error) {
      return { ok: false, reason: `контейнер не прочитан: ${String((error && error.message) || error).slice(0, 120)}` }
    }
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'в контейнере нет объекта' }
  }
  if (raw.format !== FORMAT) {
    return { ok: false, reason: `это не контейнер Workspace: ожидался «${FORMAT}», а в файле «${text(raw.format, 40)}»` }
  }
  if (raw.version !== VERSION) {
    return { ok: false, reason: `версия контейнера ${JSON.stringify(raw.version)} этому окну не подходит: ждётся ${VERSION}` }
  }
  const workspace = normalize(raw)
  // Расхождение суммы — это либо подмена файла, либо правка руками. И то и
  // другое надо сказать словами, а не развернуть молча.
  const said = text(raw.fingerprint, 16)
  const real = fingerprint(workspace)
  if (said && said !== real) {
    return {
      ok: false, reason: `контейнер изменён после сборки: в файле сумма ${said}, а по содержимому ${real}`,
      meta: { fingerprint: real, said }
    }
  }
  return { ok: true, workspace, meta: { fingerprint: real, said, author: text(raw.author, LIMITS.text) } }
}

// Развернуть контейнер — то, что происходит, когда человек открыл чужой файл.
// ПРОВЕРКА ПЕРЕД ЗАПИСЬЮ ЗДЕСЬ, А НЕ У ВЫЗЫВАЮЩЕГО: развёрнутое может быть
// куда угодно, и если правило живёт в вызывающем, оно завтра забудется.
//
// `available` — имена файлов, которые есть У ТОГО, кто открывает. Контейнер может
// упоминать файл, которого у него нет: это не ошибка, а «не нашлось», и молчать
// об этом нельзя — человек решит, что развернулось всё.
function apply (workspace, available) {
  const have = new Set((Array.isArray(available) ? available : []).map(one => String(one)))
  const missing = []
  const files = []
  for (const name of workspace.files || []) {
    if (have.size && !have.has(name)) { missing.push(name); continue }
    files.push(name)
  }
  return {
    ok: true,
    workspace: { ...workspace, files },
    // Считать вслух обязаны: развёрнутое «почти всё» молча выглядит как «всё».
    missing,
    report: {
      blocks: (workspace.blocks || []).length,
      agents: (workspace.agents || []).length,
      tools: (workspace.tools || []).length,
      files: files.length,
      scenarios: (workspace.scenarios || []).length
    }
  }
}

module.exports = {
  FORMAT, VERSION, LIMITS,
  normalize, fingerprint, pack, unpack, apply,
  isSafeName
}
