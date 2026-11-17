// Задача Дизайна из чата: контракт модуля src/main/design/task.js (план, этап 4).
//
// Что фиксируется этим набором. Агент обычной переписки получает инструмент
// `design_task(бриф, тема)` и обязан поставить задачу в СУЩЕСТВУЮЩИЙ движок
// Дизайна (`dc_*`), а повторная правка из того же разговора обязана обновить
// ТОТ ЖЕ проект новой версией — не завести второй дизайн с половинкой макета.
// Три свойства, без которых это нельзя ни выпустить, ни принять:
//
//   1) падение дизайн-рантайма не имеет права ронять чат: `run` возвращает
//      отказ, а не бросает наружу — ни при каких входных данных;
//   2) файловые права Дизайна не расширяются: модуль знает ровно те четыре
//      зависимости, что ему передали, и ничего больше (ни `fs`, ни процессов,
//      ни сети, ни записи в чужую папку);
//   3) версии настоящие: правка оставляет прежнее состояние в `.versions` так,
//      что его можно прочитать, а лимит версий не обходится серией правок.
//
// Модуль — чистый, как `src/main/artifact-export.js`: всё приходит через
// `createDesignTask(deps)`, `deps = { store, designs, runTool, notify }`.
// Поэтому прогон узловой, без Electron: хранилище настоящее (временная папка),
// движок `dc_*` — подставной, но пишущий в это же хранилище, реестр дизайнов и
// `notify` — шпионы со счётчиками.
//
// ПРОВАЛЫ КРАСНЫЕ НАМЕРЕННО: модуля ещё нет (регламент — независимые тесты до
// кода). Оборотная сторона: ни одна проверка не должна падать с `TypeError:
// Cannot read properties of undefined`, иначе прогон читается как «сломан тест»,
// а не как «нет контракта». Поэтому `require` ловится сразу, а каждая проверка
// начинается со слова «нет контракта».
//
// Решения по контракту, принятые здесь (разработчик обязан их соблюдать, а
// приёмка — о них знать):
//   • пустой/нестроковый бриф, пустая тема, бриф длиннее разумного предела —
//     отказ ДО единого вызова движка; предел не назван числом: 200 000 знаков
//     отвергается, ~5 600 — проходят, граница внутри этого разрыва;
//   • тема обязательна и для новой задачи, и для правки (она называет проект);
//   • чужой `designId` — тот, что принадлежит другому `chatId`, — отказ;
//   • на успехе designs.add вызывается ровно один раз, на любом отказе — ни
//     разу: запись в реестре без написанного компонента была бы битой карточкой;
//   • из этого следует, что идентификатор дизайна движку передаёт сам модуль:
//     в `context` (`{ designId }`) или в аргументах — завязаться на `designs`
//     движок не может, потому что реестр правки не опережает;
//   • правка обязана изменить байты компонента: та же папка, новый номер
//     версии, прежние байты читаются из `.versions` и отличаются от текущих;
//   • писать в дизайн можно только через `runTool`: `store` передан как
//     читалка (список, текст, версии, входная страница), а `store.write`,
//     `store.replace`, `store.remove*` и референсы — уже расширение прав;
//   • `notify` принимает объект с полем `status`; финальное событие обязано
//     нести тот же статус, что вернул `run` ('ready' | 'failed'); отказ движка
//     обязан дойти до окна как `failed`, а не молча превратиться в «готово»;
//   • `run` не бросает ни при каких входных данных, включая `designId`-помойку.
//
// Набор самопроверен (прогон снят, в файле этого нет): эталонная реализация,
// написанная прямо в харнесе, даёт зелёными все 18 поведенческих проверок, а
// двенадцать подсказанных мутантов — игнор designId, версия всегда 1, версия
// «плато» на двойке, add до работы, запись мимо runTool, dump через fs, один
// notify, пустой макет вместо брифа, «успех» при success:false, rethrow, новый
// компонент на каждую правку, принятие гигантского брифа — красят ровно те
// проверки, которые должны. Пять законных реализаций зелёные: dc_write,
// dc_write + dc_check, dc_scaffold, dc_read + dc_html_str_replace и счёт версии
// по папке `.versions` — контракт не привязан ни к выбору инструмента, ни к
// стратегии правки, ни к тому, где живёт номер версии.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DesignStore, safeComponentName } = require('../src/main/design/store.js')
const { DESIGN_TOOL_NAMES } = require('../src/main/design/tools.js')

const TASK_FILE = path.join(__dirname, '..', 'src', 'main', 'design', 'task.js')
const taskExists = fs.existsSync(TASK_FILE)

// require ловится заранее: иначе файл упал бы один раз на загрузке, и ни одна
// проверка не сказала бы, чего именно из поведения не хватает.
let createDesignTask = null
let taskLoadError = null
try {
  createDesignTask = require(TASK_FILE).createDesignTask
} catch (error) {
  taskLoadError = error
}

let failed = 0
let total = 0

async function acheck (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

// Обычный throw вместо assert.equal(typeof …): провал обязан звучать как «нет
// контракта», а не как «выражение дало falsy».
function contract () {
  if (typeof createDesignTask !== 'function') {
    throw new Error('нет контракта: src/main/design/task.js:createDesignTask — ' +
      (taskExists
        ? 'модуль есть, но не экспортирует createDesignTask' +
          (taskLoadError ? ` (${String(taskLoadError.message).split('\n')[0]})` : '')
        : 'модуля ещё нет — задача Дизайна из чата не реализована'))
  }
  return createDesignTask
}

function build (deps) {
  const task = contract()(deps)
  if (!task || typeof task.run !== 'function') {
    throw new Error('нет контракта: createDesignTask(deps) не возвращает объект с методом run')
  }
  return task
}

// `run` обещает не бросать наружу. Обёртка превращает чужое исключение в провал
// с текстом, который это прямо называет, — и не обрывает остальные проверки.
async function safeRun (task, input) {
  let result
  try {
    result = await task.run(input)
  } catch (error) {
    throw new Error('run бросил наружу, а обещал возвращать отказ: ' +
      String(error && error.message).split('\n')[0])
  }
  if (!result || typeof result !== 'object') {
    throw new Error('run вернул не объект: ' + JSON.stringify(result))
  }
  return result
}

// --- пределы, зафиксированные контрактом --------------------------------------
// Верхняя граница брифа: 200 000 знаков отказываются, 5 000 — проходят. Где
// именно внутри этого диапазона лежит предел, решает реализация (в продукте его
// всё равно отсекает окно контекста модели), но «откажем на любой длине» и
// «примём что угодно» оба не проходят набор.
const BRIEF_HUGE = 'а'.repeat(200000)
const BRIEF_MID = 'Описание раздела. '.repeat(330)   // ~5600 знаков

const BRIEF = 'Нужен лендинг сервиса доставки цветов: форма заказа, блок отзывов и часы работы'
const TOPIC = 'Лендинг доставки цветов'
const REVISION = 'Сделай заголовок крупнее'

const THROW_MARK = 'авария дизайн-рантайма'
const SOFT_MARK = 'dc_check не пройден: превью пустое'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-design-task-'))
const store = new DesignStore(ROOT)

// --- что модулю разрешено и запрещено -----------------------------------------
// Права на запись в дизайн принадлежат движку `dc_*`, то есть `runTool`. Хранилище
// передано модулю только для чтения состояния и истории: список, текст компонента,
// входная страница, версии. Прямой `store.write`/`store.replace` был бы обходным
// путём мимо движка (и мимо проверки, и мимо прогресса в окне), а `remove*` и
// референсы — это действия человека, а не задачи агента.
const STORE_ALLOWED = new Set([
  'folder', 'ensure', 'list', 'read', 'getEntry', 'setEntry',
  'listVersions', 'restoreVersion', 'refsFolder', 'listRefs', 'readRef'
])
const STORE_FORBIDDEN = new Set([
  'write', 'writeUnlocked', 'replace', 'setProps', 'remove', 'removeDesign',
  'addRef', 'writeRef', 'removeRef', 'keepVersion', 'refInside', 'freeRefName', 'installRuntime'
])

// Модули, которых в зависимостях чистого модуля быть не может: приходили бы в
// обход `store`/`designs`/`runTool`/`notify`. `path`, `crypto`, `os` не запрещены:
// сами по себе прав не дают, а `randomUUID` нужен для идентификаторов.
const FORBIDDEN_REQUIRES = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'child_process', 'node:child_process',
  'cluster', 'worker_threads', 'node:worker_threads', 'http', 'node:http', 'https', 'node:https',
  'http2', 'net', 'node:net', 'tls', 'dgram', 'dns', 'electron', 'node:crypto'
])

function spyStore (target, log) {
  return new Proxy(target, {
    get (obj, prop) {
      const value = Reflect.get(obj, prop)
      if (typeof value !== 'function') return value
      return (...args) => {
        const name = String(prop)
        log.push(name)
        if (STORE_FORBIDDEN.has(name)) {
          throw new Error(`права расширены: модуль зовёт store.${name}() напрямую — ` +
            'запись и удаление в дизайн идут только через runTool')
        }
        return value.apply(target, args)
      }
    }
  })
}

// Шпионы прямой работы с системой. Патчится ровно то, чем настоящее хранилище НЕ
// пользуется (синхронный fs и свободные асинхронные методы), поэтому соседство с
// настоящим DesignStore прогон не ломает. Окно включения — только сам вызов `run`.
const SPY_SYNC_FS = ['writeFileSync', 'appendFileSync', 'copyFileSync', 'unlinkSync', 'renameSync',
  'mkdirSync', 'rmdirSync', 'rmSync', 'truncateSync', 'chmodSync', 'symlinkSync', 'linkSync',
  'openSync', 'createWriteStream']
const SPY_ASYNC_FS = ['appendFile', 'cp', 'opendir', 'truncate', 'chmod', 'chown', 'utimes', 'lutimes', 'watch']
const SPY_CHILD = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']
const SPY_NET = { http: ['request', 'get'], https: ['request', 'get'], net: ['connect', 'createServer'],
  dns: ['lookup', 'resolve'], dgram: ['createSocket'], tls: ['connect'] }

function armSystemSpies () {
  const seen = []
  const revert = []
  const note = kind => (...args) => {
    seen.push(kind + '(' + args.slice(0, 2).map(a =>
      (typeof a === 'string' ? a.slice(0, 80) : Array.isArray(a) ? JSON.stringify(a).slice(0, 80) : '[не строка]'))
      .join(', ') + ')')
    throw new Error('модуль трогает систему напрямую: ' + kind)
  }
  const fsSync = require('fs')
  const fsPromises = require('fs/promises')
  for (const name of SPY_SYNC_FS) {
    if (!(name in fsSync)) continue
    revert.push([fsSync, name, fsSync[name]])
    fsSync[name] = note('fs.' + name)
  }
  for (const name of SPY_ASYNC_FS) {
    if (!(name in fsPromises)) continue
    revert.push([fsPromises, name, fsPromises[name]])
    fsPromises[name] = note('fs.promises.' + name)
  }
  const child = require('child_process')
  for (const name of SPY_CHILD) {
    if (!(name in child)) continue
    revert.push([child, name, child[name]])
    child[name] = note('child_process.' + name)
  }
  for (const [mod, names] of Object.entries(SPY_NET)) {
    let lib = null
    try { lib = require(mod) } catch { lib = null }
    if (!lib) continue
    for (const name of names) {
      if (!(name in lib)) continue
      revert.push([lib, name, lib[name]])
      lib[name] = note(mod + '.' + name)
    }
  }
  const hadFetch = typeof globalThis.fetch === 'function'
  revert.push([globalThis, 'fetch', hadFetch ? globalThis.fetch : undefined])
  globalThis.fetch = note('fetch')
  return {
    seen,
    restore () {
      for (const [holder, name, previous] of revert) {
        if (previous === undefined) delete holder[name]
        else holder[name] = previous
      }
    }
  }
}

// --- подставной движок dc_* ---------------------------------------------------
// Не «возвращает успех», а делает настоящую работу в настоящем хранилище:
// иначе проверки версий и лимита превратились бы в проверку слов.
function pathOf (args) {
  const raw = args.path ?? args.name ?? args.component ?? args.file
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('dc_* вызван без имени компонента: ' + JSON.stringify(args))
  }
  const value = String(raw)
  // Настоящий `safeComponentName` взял бы basename и молча сложил бы путь на
  // реальный компонент; здесь это явный отказ — контракт требует имён без пути.
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error('имя компонента не задаётся путём: ' + value)
  }
  return safeComponentName(value)
}

function targetDesign (env, args, context) {
  const candidates = [
    context?.designId, context?.design_id, context?.id, context?.design?.id, context?.design,
    args?.designId, args?.design_id,
    env.registry.length ? env.registry[env.registry.length - 1].id : null,
    env.knownDesignId
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return null
}

async function applyTool (env, name, args, context) {
  const designId = targetDesign(env, args, context)
  if (!designId) {
    throw new Error('движок не понял, в какой дизайн писать: ни в context, ни в args нет designId, ' +
      'а в реестре нет ни одной записи')
  }
  switch (name) {
    case 'dc_write': {
      const template = String(args.b_dc_html ?? '')
      if (!template.trim()) throw new Error('Пустая разметка: компонент должен что-то рисовать.')
      if (/<x-dc[\s>]/i.test(template) || /<!DOCTYPE/i.test(template)) {
        throw new Error('Передавай только содержимое между <x-dc> и </x-dc>: обёртку добавляет среда.')
      }
      const written = await store.write(designId, pathOf(args), {
        template,
        logic: String(args.c_dc_js ?? ''),
        props: String(args.d_props_json ?? '')
      })
      return { success: true, path: written.name }
    }
    case 'dc_scaffold': {
      const pages = Array.isArray(args.pages) && args.pages.length ? args.pages
        : Array.isArray(args.sections) && args.sections.length
          ? args.sections.map(section => ({ name: section.id, title: section.title, purpose: section.purpose }))
          : [{ name: 'Home', title: 'Главная', purpose: '' }]
      const written = []
      for (const page of pages) {
        const raw = String(page?.name || 'Home')
        if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
          throw new Error('имя страницы не задаётся путём: ' + raw)
        }
        const body = [page?.title ? `<h1>${page.title}</h1>` : '',
          page?.purpose ? `<p>${page.purpose}</p>` : '',
          page?.headline ? `<h2>${page.headline}</h2>` : '']
          .filter(Boolean).join('\n') || '<p>каркас</p>'
        written.push(await store.write(designId, raw, { template: body, logic: '' }))
      }
      const entry = await store.setEntry(designId, written[0].name)
      return { success: true, components: written.map(item => item.name), entry: entry.name }
    }
    case 'dc_read': {
      const found = await store.read(designId, pathOf(args))
      return { success: true, path: found.name, b_dc_html: found.template, c_dc_js: found.logic, d_props_json: found.props }
    }
    case 'dc_list':
      return { success: true, components: await store.list(designId) }
    case 'dc_set_entry':
      return { success: true, path: (await store.setEntry(designId, pathOf(args))).name }
    case 'dc_html_str_replace':
    case 'dc_js_str_replace': {
      const part = name === 'dc_html_str_replace' ? 'template' : 'logic'
      const result = await store.replace(designId, pathOf(args), part,
        String(args.old_str ?? ''), String(args.new_str ?? ''))
      return { success: true, path: result.name, replaced: result.replaced }
    }
    case 'dc_set_props':
      return { success: true, path: (await store.setProps(designId, pathOf(args), String(args.d_props_json ?? ''))).name }
    case 'dc_delete':
      // В продукте удаление спрашивает человека. У задачи из чата подтверждения
      // нет, поэтому и удаление компонента здесь отказ: права на разрушение из
      // чата не должны появляться.
      return { success: false, denied: true, error: 'Удаление компонента требует подтверждения человека — в задаче чата его нет.' }
    case 'dc_check':
      if (env.checkFails) return { success: true, passed: false, problems: [],
        screens: [{ width: 1280, rendered: true, unnamedControls: 3, errors: [] }] }
      return { success: true, passed: true, problems: [] }
    case 'dc_measure':
      return { success: true, typeScale: [], contrast: [] }
    case 'dc_screenshot':
      return { success: true, image: null }
    case 'dc_export':
      return { success: true, file: 'export.png' }
    case 'dc_imagery':
      return { success: true, css: 'background: linear-gradient(120deg,#111,#333)' }
    case 'dc_starter':
      return { success: true, template: '<div class="slide">заготовка</div>', logic: '' }
    case 'dc_reference':
      return { success: true, text: 'разбор типовой работы' }
    case 'dc_refs':
      return { success: true, refs: await store.listRefs(designId) }
    case 'dc_comments':
      return { success: true, comments: [] }
    default:
      return { success: true }
  }
}

// --- окружение одной проверки --------------------------------------------------
function makeEnv (opts = {}) {
  const env = {
    registry: [],
    designsCalls: [],
    storeCalls: [],
    calls: [],
    events: [],
    knownDesignId: opts.designId || null,
    failOnce: opts.failOnce || null,
    // Отказ именно runtime-проверки: движок отвечает успехом, но страница не прошла
    // проверку отрисовки. Задача обязана свестись к отказу, а не к «готово».
    checkFails: Boolean(opts.checkFails)
  }

  // Реестр дизайнов — то же, что в продукте `readSecure/writeSecure('designs')`.
  // Возвращает ОБЫЧНЫЕ значения (не промисы): `await` на них работает, синхронный
  // вызов тоже, поэтому реализация не обязана угадывать форму доступа. Копии,
  // чтобы «обновить реестр» нельзя было мутацией собственного снимка.
  env.designs = {
    list: () => {
      env.designsCalls.push('list')
      return env.registry.map(entry => ({ ...entry }))
    },
    add: entry => {
      env.designsCalls.push('add')
      if (!entry || typeof entry !== 'object') throw new Error('designs.add получил не запись')
      env.registry.push({ ...entry })
      return env.registry.length
    },
    update: entry => {
      env.designsCalls.push('update')
      const at = env.registry.findIndex(item => item && entry && item.id === entry.id)
      if (at >= 0) env.registry[at] = { ...env.registry[at], ...entry }
      return at >= 0
    }
  }

  env.store = spyStore(store, env.storeCalls)

  env.runTool = async (name, args, context) => {
    env.calls.push({ name: String(name), args: args ?? null, context: context ?? null })
    if (env.failOnce === 'throw') {
      env.failOnce = null
      throw new Error('движок упал: ' + THROW_MARK)
    }
    if (env.failOnce === 'soft') {
      env.failOnce = null
      return { success: false, error: SOFT_MARK }
    }
    if (!DESIGN_TOOL_NAMES.has(name)) throw new Error(`Неизвестный инструмент дизайна: ${name}`)
    return applyTool(env, name, args || {}, context)
  }

  env.notify = event => { env.events.push(event) }

  env.deps = () => ({ store: env.store, designs: env.designs, runTool: env.runTool, notify: env.notify })

  // Все файловые пути, которые модуль передал движку (включая страницы каркаса).
  env.componentNames = () => {
    const out = []
    for (const call of env.calls) {
      const args = call.args || {}
      for (const value of [args.path, args.name, args.component, args.file]) {
        if (typeof value === 'string') out.push({ name: call.name, value })
      }
      for (const page of Array.isArray(args.pages) ? args.pages : []) {
        if (page && typeof page.name === 'string') out.push({ name: call.name, value: page.name })
      }
      for (const section of Array.isArray(args.sections) ? args.sections : []) {
        if (section && typeof section.id === 'string') out.push({ name: call.name, value: section.id })
      }
    }
    return out
  }

  env.newFiles = before => {
    const after = walk(ROOT)
    return [...after].filter(entry => !before.has(entry))
  }

  return env
}

// Всё, что легло вне папки самого дизайна: сама папка — не «вне».
function outsideDesign (rel, designId) {
  return rel !== designId && !rel.startsWith(designId + '/')
}

function walk (dir, prefix = '') {
  const out = new Set()
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    out.add(rel)
    if (entry.isDirectory()) for (const nested of walk(path.join(dir, entry.name), rel)) out.add(nested)
  }
  return out
}

// Состояние из `notify`: реализация вправе добавлять что угодно ещё, но статус
// обязан быть, и финальный обязан совпадать с тем, что вернул `run`.
function statusOf (event) {
  if (typeof event === 'string') return event.trim().toLowerCase()
  if (event && typeof event === 'object') {
    return String(event.status ?? event.state ?? event.phase ?? '').trim().toLowerCase()
  }
  return ''
}

const normalize = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const words = value => String(value).toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(w => w.length > 3)

// Снимок компонента с диска — байтами, как в `test-design-element-undo.cjs`:
// `store.read` разбирает файл и побайтового равенства не докажет.
const componentFile = (designId, name) =>
  path.join(ROOT, designId, name.endsWith('.dc.html') ? name : `${name}.dc.html`)
const versionFile = (designId, name, entry) =>
  path.join(ROOT, designId, '.versions', name.endsWith('.dc.html') ? name : `${name}.dc.html`,
    entry.file || `${entry.id}.html`)

const run = async () => {
  // 1 — почему краснеют все остальные.
  await acheck('есть контракт: src/main/design/task.js отдаёт createDesignTask с методом run', async () => {
    assert.ok(taskExists, 'нет файла src/main/design/task.js — задача Дизайна из чата ещё не реализована, ' +
      'и все проверки ниже красные именно поэтому')
    assert.equal(typeof createDesignTask, 'function',
      'нет контракта: createDesignTask не экспортируется' + (taskLoadError ? ` (${taskLoadError.message})` : ''))
    const env = makeEnv()
    const task = build(env.deps())
    assert.equal(typeof task.run, 'function', 'нет контракта: у результата createDesignTask нет метода run')
  })

  // 2 — валидация входа до побочных действий.
  await acheck('пустой бриф и бриф из пробелов отвергаются без единого вызова движка', async () => {
    for (const brief of ['', '   ', '\n\t ', '  \u2009 ']) {
      const env = makeEnv()
      const res = await safeRun(build(env.deps()), { brief, topic: TOPIC, chatId: 'chat-1' })
      assert.equal(res.ok, false, `бриф ${JSON.stringify(brief)} принят, а должен быть отвергнут`)
      assert.equal(typeof res.error, 'string')
      assert.ok(res.error.trim().length > 0, 'отказ без объяснения: ' + JSON.stringify(res))
      assert.equal(env.calls.length, 0, `движок вызван ${env.calls.length} раз при отвергнутом брифе`)
      assert.equal(env.registry.length, 0, 'пустой бриф создал запись в реестре')
    }
  })

  await acheck('нестроковый бриф отвергается без единого вызова движка', async () => {
    // Чат присылает то, что напечатала модель: объект, число, массив — это не
    // текст задачи. Приведение через String() превратило бы «[object Object]»
    // в макет, и человек получил бы дизайн с мусорным брифом.
    for (const brief of [null, undefined, 42, {}, [], true, () => 'текст']) {
      const env = makeEnv()
      const res = await safeRun(build(env.deps()), { brief, topic: TOPIC, chatId: 'chat-1' })
      assert.equal(res.ok, false, `бриф ${Object.prototype.toString.call(brief)} принят как текст`)
      assert.equal(env.calls.length, 0, 'движок вызван при нестроковом брифе')
    }
  })

  await acheck('пустая тема отвергается без единого вызова движка', async () => {
    // Тема называет проект: без неё дизайн нельзя ни найти в списке, ни
    // продолжить правкой.
    for (const topic of ['', '   ', null, undefined, 0]) {
      const env = makeEnv()
      const res = await safeRun(build(env.deps()), { brief: BRIEF, topic, chatId: 'chat-1' })
      assert.equal(res.ok, false, `тема ${JSON.stringify(topic)} принята`)
      assert.equal(env.calls.length, 0, 'движок вызван при пустой теме')
    }
  })

  // 3 — размер входа.
  await acheck('бриф в 200 000 знаков отвергается, движок не вызван', async () => {
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF_HUGE, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, false, 'гигантский бриф принят: он уехал бы в контекст модели целиком')
    assert.match(String(res.error || ''), /длин|размер|предел/i, 'отказ не объясняет границу: ' + JSON.stringify(res))
    assert.equal(env.calls.length, 0, 'движок вызван при отвергнутом размере брифа')
  })

  await acheck('бриф в несколько тысяч знаков проходит', async () => {
    // Охрана от обратного: предел нельзя поставить в несколько слов, иначе
    // нормальный бриф из чата начал бы «отказываться» от работы.
    assert.ok(BRIEF_MID.length > 4000 && BRIEF_MID.length < 20000, 'образец среднего брифа выродился')
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF_MID, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'разумный по размеру бриф отвергнут: ' + JSON.stringify(res))
  })

  // 4 — успех на подставном движке.
  await acheck('успех: один дизайн, читаемое имя компонента, версия 1, статус ready', async () => {
    const env = makeEnv()
    const before = walk(ROOT)
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'задача не выполнена: ' + JSON.stringify(res))
    assert.equal(res.status, 'ready', 'статус не ready: ' + JSON.stringify(res))
    assert.equal(res.version, 1, 'первая версия должна быть 1, а не ' + JSON.stringify(res.version))
    assert.match(String(res.designId || ''), /^[A-Za-z0-9_-]{1,64}$/,
      'designId не годится как имя папки: ' + JSON.stringify(res.designId))
    assert.ok(path.resolve(ROOT, res.designId).startsWith(path.resolve(ROOT) + path.sep),
      'designId выводит за корень дизайнов: ' + res.designId)

    // Ровно один дизайн: и `add` один раз, и в реестре одна запись.
    assert.equal(env.designsCalls.filter(call => call === 'add').length, 1,
      'designs.add вызван не один раз: ' + env.designsCalls.join(', '))
    assert.equal(env.registry.length, 1, 'в реестре не один дизайн: ' + JSON.stringify(env.registry))
    assert.equal(env.registry[0].id, res.designId, 'запись в реестре не про тот дизайн')

    // Имя компонента — имя, а не путь и не дамп брифа.
    assert.equal(typeof res.component, 'string')
    assert.ok(res.component.trim().length > 0, 'пустое имя компонента')
    assert.ok(!res.component.includes('/') && !res.component.includes('\\') && !res.component.includes('..'),
      'имя компонента содержит путь: ' + res.component)
    assert.ok(res.component.length <= 80, `имя компонента в ${res.component.length} знаков — это не имя: ${res.component}`)
    assert.notEqual(safeComponentName(res.component), 'dc-runtime.js', 'имя занято средой выполнения')

    // И возвращённое имя, и файл на диске существуют: список хранилища — правда.
    const listed = await store.list(res.designId)
    assert.ok(listed.length >= 1, 'в папке дизайна нет ни одного компонента')
    const stem = value => String(value).replace(/\.dc\.html$/i, '').toLowerCase()
    assert.ok(listed.some(file => stem(file) === stem(res.component)),
      `компонента «${res.component}» в дизайне нет; есть: ${listed.join(', ')}`)
    const written = await store.read(res.designId, listed[0])
    assert.ok(written.template.trim().length > 0, 'компонент пустой: ' + JSON.stringify(written))
    assert.deepEqual(env.newFiles(before).filter(rel => outsideDesign(rel, res.designId)), [],
      'задача оставила файлы вне папки своего дизайна')
  })

  // «Готово» без проверки рантайма — враньё в карточке: запись могла лечь битой
  // (неразрешённая ссылка, пустой экран), и человек узнает об этом, только сам
  // открыв Дизайн. Порядок вызовов держится проверкой, а не доброй волей
  // реализатора: без неё «не зову dc_check» проходит весь набор.
  const WRITING = ['dc_write', 'dc_scaffold', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props']
  const VERIFYING = ['dc_check', 'dc_measure']
  function assertVerified(env, res, label) {
    const names = env.calls.map(call => call.name)
    const wrote = names.findIndex(name => WRITING.includes(name))
    assert.ok(wrote >= 0, `${label}: компонент никто не записывал; вызовы: ${names.join(', ')}`)
    const checked = names.findIndex((name, index) => index > wrote && VERIFYING.includes(name))
    assert.ok(checked >= 0,
      `${label}: после записи нет ни ${VERIFYING[0]}, ни ${VERIFYING[1]} — статус ready ничем не подтверждён; ` +
      `порядок: ${names.join(', ')}`)
    const target = JSON.stringify(env.calls[checked].args || {}).toLowerCase()
    const stem = String(res.component || '').toLowerCase().replace(/\.dc\.html$/, '')
    assert.ok(target.includes(stem) || target.includes('.dc.html'),
      `${label}: проверка идёт не по записанному компоненту: ${JSON.stringify(env.calls[checked].args)}`)
  }

  await acheck('успех обязывает движок проверить записанный компонент', async () => {
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'задача не выполнена: ' + JSON.stringify(res))
    assertVerified(env, res, 'новая задача')
  })

  await acheck('заголовок страницы — имя работы, а не дословная просьба', async () => {
    // Кадр живого прогона показал обратное: крупным кеглем на сайт легло
    // «Собери одностраничный сайт „МИШЕНА-ОТКРЫТЬ“». Просьба человека — это
    // задание, а не текст макета: на экране оно читается как заглушка.
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'задача не выполнена: ' + JSON.stringify(res))
    const scaffold = env.calls.find(call => call.name === 'dc_scaffold')
    assert.ok(scaffold, 'каркас не собирался — проверять заголовок негде')
    const page = (scaffold.args.pages || [])[0] || {}
    const headline = String(page.headline || '')
    assert.ok(headline.trim().length > 0, 'страница осталась без заголовка')
    assert.equal(/^(собери|сделай|создай|сверстай|разработай|нужен|нужна|нужно|требуется|надо)\b/i.test(headline.trim()), false,
      `заголовок начинается с приказа человека: «${headline}»`)
    assert.equal(headline.includes(':'), false,
      `в заголовок легла просьба с перечислением разделов: «${headline}»`)
    assert.ok(headline.toLowerCase().includes(String(TOPIC).toLowerCase().slice(0, 12)),
      `заголовок не про саму работу: «${headline}», тема «${TOPIC}»`)
  })

  await acheck('отказ runtime-проверки страницы — отказ задачи, а не «готово»', async () => {
    // Движок отвечает `{ success: true }` и при этом `passed: false`: страница
    // записана, но не рисуется как надо. Принять такое за успех — значит показать
    // человеку «Макет готов» над пустым экраном.
    const env = makeEnv({ checkFails: true })
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, false, 'непроверенная страница принята как готовая: ' + JSON.stringify(res))
    assert.equal(res.status, 'failed', 'статус отказа не failed: ' + JSON.stringify(res))
    assert.ok(String(res.error || '').length > 4, 'отказ без объяснения: ' + JSON.stringify(res))
    assert.equal(env.events.filter(event => event.status === 'failed').length >= 1, true,
      `окно не получило failed: ${env.events.map(event => event.status).join(', ')}`)
    assert.equal(env.designsCalls.includes('add'), false,
      'отказанная страница записана в реестр дизайнов')
  })

  await acheck('задача без разговора-владельца отвергается до вызова движка', async () => {
    // Право правки держится на chatId записи. Пустой владелец — это не «анонимная
    // задача», а запись, которую потом невозможно ни защитить, ни найти.
    for (const chatId of ['', null, undefined, '   ']) {
      const env = makeEnv()
      const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId })
      assert.equal(res.ok, false, `принят chatId ${JSON.stringify(chatId)}`)
      assert.equal(res.status, 'failed', `отказ без статуса failed: ${JSON.stringify(res)}`)
      assert.equal(env.calls.length, 0, `движок вызван для задачи без владельца (${JSON.stringify(chatId)})`)
      assert.equal(env.designsCalls.includes('add'), false, 'запись в реестр без владельца')
    }
  })

  await acheck('правка не называется выполненной: исполнитель записал просьбу в макет', async () => {
    // Местный исполнитель намерение не читает: он кладёт просьбу видимым блоком.
    // Отчёт «макет собран» над прежним заголовком — это отчёт о несделанном, и
    // держится он одним словом, которое прогон обязан видеть.
    const env = makeEnv()
    const task = build(env.deps())
    const first = await safeRun(task, { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(first.ok, true, 'исходная задача не выполнена: ' + JSON.stringify(first))
    const second = await safeRun(task, {
      brief: REVISION, topic: TOPIC, designId: first.designId, instruction: REVISION, chatId: 'chat-1'
    })
    assert.equal(second.ok, true, 'правка не выполнена: ' + JSON.stringify(second))
    const final = [...env.events].reverse().find(event => event.status === 'ready')
    assert.ok(final, 'финального события правки нет')
    assert.match(String(final.message || ''), /записан|ещё надо выполни/,
      `правка названа готовой без слова о том, что её ещё делать: «${final.message}»`)
    assert.equal(/макет собран/i.test(String(final.message || '')), false,
      `на правке тот же текст, что на новой сборке: «${final.message}»`)
    // Новая задача, наоборот, обязана отчитываться собранно — иначе проверка выше
    // краснела бы от любого текста.
    const created = env.events.find(event => event.status === 'ready')
    assert.match(String(created.message || ''), /собран/i, `первая задача не названа собранной: «${created.message}»`)
  })

  await acheck('инструмент чата не проходит в дизайн-ход (проводка)', async () => {
    // Граница поверхностей живёт в main.js: `dc_*` не пускает чат, а всё остальное
    // не пускает Дизайн. Если `design_task` попадёт в список дизайн-инструментов,
    // ход раздела получит право заводить проекты мимо окна.
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
    assert.equal(DESIGN_TOOL_NAMES.has('design_task'), false, 'design_task записан в инструменты Дизайна')
    assert.match(main, /name: 'design_task'/, 'инструмента нет в списке инструментов чата')
    assert.match(main, /В разделе «Дизайн» инструмент \$\{name\} недоступен/,
      'гейт отказа не-dc_* в дизайне исчез из main.js')
  })

  await acheck('правка тоже обязана проходить проверку, а не только перетираться', async () => {
    const env = makeEnv()
    const task = build(env.deps())
    const first = await safeRun(task, { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(first.ok, true, 'исходная задача не выполнена: ' + JSON.stringify(first))
    env.calls.length = 0
    const second = await safeRun(task, {
      brief: REVISION, topic: TOPIC, designId: first.designId, instruction: REVISION, chatId: 'chat-1'
    })
    assert.equal(second.ok, true, 'правка не выполнена: ' + JSON.stringify(second))
    assertVerified(env, { ...second, component: second.component || first.component }, 'правка')
  })

  // Каркас (`dc_scaffold`) отдаёт скелет: в шаблоне остаются подстановки
  // `{{ brand }}`, `{{ action }}`, `{{ about }}`, `{{ year }}`. Задача из чата
  // обязана отдать законченную страницу — с именем работы вместо «Название» и со
  // своим словом на кнопке: и человек, и проверка рантайма видят то, что реально
  // нарисовано, а пустые ссылки считаются кнопками без имени.
  //
  // Проверка идёт на НАСТОЯЩЕМ движке `dc_*`, а не на заглушке: подставной
  // каркас подстановок не оставляет, и проверка на нём зелена сама по себе — то
  // есть не проверяет ничего.
  await acheck('страница из чата не остаётся заготовкой с подстановками', async () => {
    const { executeDesignTool } = require('../src/main/design/tools.js')
    const env = makeEnv()
    const deps = env.deps()
    const task = build({
      ...deps,
      runTool: (name, args, context) => executeDesignTool({
        // Настоящий хранилище, а не шпион: запись делает движок `dc_*`, и
        // претензия «модуль полез в store.write» здесь была бы ложью. Модуль же
        // по-прежнему получает шпиона и сам писать не может.
        store,
        designId: context?.designId,
        name,
        args,
        comments: [],
        check: async () => ({ passed: true, screens: [{ width: 1280, rendered: true, unnamedControls: 0, errors: [] }] })
      })
    })
    const res = await safeRun(task, { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'задача на настоящем каркасе не выполнена: ' + JSON.stringify(res))
    const html = fs.readFileSync(componentFile(res.designId, res.component), 'utf8')
    const left = [...html.matchAll(/\{\{\s*[\w.$-]+\s*\}\}/g)].map(item => item[0])
    assert.deepEqual(left, [], 'в странице остались неразрешённые подстановки: ' + left.join(', '))
    assert.ok(html.toLowerCase().includes(String(TOPIC).toLowerCase()),
      'тема задачи не попала в страницу — человек видит безымянный шаблон: ' + html.slice(0, 200))
  })

  // 5 — тема и бриф доезжают до движка.
  await acheck('бриф и тема влияют на запрос, который уходит в движок', async () => {
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'задача не выполнена: ' + JSON.stringify(res))
    const dumped = JSON.stringify(env.calls).toLowerCase()
    assert.ok(dumped.includes(BRIEF.toLowerCase().slice(0, 40)),
      'бриф не попал в аргументы движка — макет пишется вслепую: ' + dumped.slice(0, 400))
    const topicWords = words(TOPIC)
    assert.ok(topicWords.every(word => dumped.includes(word)),
      `тема не повлияла на запрос (нет слов «${topicWords.join(', ')}»): ${dumped.slice(0, 400)}`)
    // И это не пустой макет: то, что легло на диск, связано со сказанным.
    const files = await store.list(res.designId)
    const text = normalize((await Promise.all(files.map(file => store.read(res.designId, file))))
      .map(found => found.template).join(' '))
    assert.ok(text.length > 0, 'в дизайне нет ни байта разметки')
    assert.ok(normalize(TOPIC).slice(0, 12) && text.includes(normalize(TOPIC).slice(0, 12)),
      `тема не отразилась в содержимом компонента: ${files.join(', ')}`)
  })

  await acheck('notify идёт по порядку: минимум «идёт» и финал, равный статусу отказа/успеха', async () => {
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(env.events.length >= 2,
      `окно получило ${env.events.length} событий — прогресс задачи должен быть виден до финала`)
    const statuses = env.events.map(statusOf)
    assert.ok(statuses.every(status => status.length > 0),
      'есть событие без состояния: ' + JSON.stringify(env.events))
    assert.equal(statuses[statuses.length - 1], res.status,
      `финальное событие не про финал: ${statuses.join(' → ')} при статусе ${res.status}`)
    assert.ok(statuses[0] !== 'ready' && statuses[0] !== 'failed',
      'первое событие уже финальное — в окне задача выглядела готовой до работы')
    assert.equal(statuses.slice(0, -1).filter(status => status === res.status).length, 0,
      'финальный статус объявлен раньше последнего события: ' + statuses.join(' → '))
  })

  // 6 — правка того же проекта.
  await acheck('правка из чата обновляет ТОТ ЖЕ дизайн новой версией', async () => {
    const env = makeEnv()
    const task = build(env.deps())
    const first = await safeRun(task, { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(first.ok, true, 'исходная задача не выполнена: ' + JSON.stringify(first))
    assert.equal((await store.listVersions(first.designId, first.component)).length, 0,
      'у только что созданного компонента уже есть версия — история начатана до правки')

    const pre = fs.readFileSync(componentFile(first.designId, first.component))
    const second = await safeRun(task, {
      brief: REVISION, topic: TOPIC, designId: first.designId, instruction: REVISION, chatId: 'chat-1'
    })
    assert.equal(second.ok, true, 'правка не выполнена: ' + JSON.stringify(second))
    assert.equal(second.designId, first.designId,
      `правка завела другой дизайн: ${second.designId} вместо ${first.designId}`)
    assert.equal(second.version, 2, 'правка не подняла версию до 2: ' + JSON.stringify(second.version))
    assert.equal(env.registry.length, 1,
      'правка добавила второй дизайн в реестр: ' + JSON.stringify(env.registry))
    assert.equal(env.designsCalls.filter(call => call === 'add').length, 1,
      'designs.add вызван повторно: правка обязана обновлять запись, а не создавать её')
    assert.ok(env.designsCalls.includes('update'),
      'правка не отразилась в реестре — designs.update не вызван')

    // Настоящая проверка на keepVersion: прежнее состояние на диске, читается и
    // отличается от текущего.
    const versions = await store.listVersions(second.designId, second.component || first.component)
    assert.ok(versions.length >= 1, 'после правки в .versions пусто — прежние байты потеряны')
    const kept = fs.readFileSync(versionFile(second.designId, second.component || first.component, versions[0]))
    assert.ok(kept.length > 0, 'версия пустая')
    assert.equal(kept.equals(pre), true,
      'сохранённая версия — не прежние байты компонента')
    const now = fs.readFileSync(componentFile(second.designId, second.component || first.component))
    assert.equal(now.equals(pre), false, 'правка не изменила компонент — новая версия нарисована на бумаге')
  })

  // 7 — чужой и несуществующий designId.
  await acheck('несуществующий designId отвергается до вызова движка', async () => {
    const env = makeEnv()
    const res = await safeRun(build(env.deps()), { brief: REVISION, topic: TOPIC, designId: 'dnet-zdes', chatId: 'chat-1' })
    assert.equal(res.ok, false, 'чужой дизайн принят как свой: ' + JSON.stringify(res))
    assert.equal(env.calls.length, 0, 'движок вызван под несуществующий дизайн')
    assert.equal(env.registry.length, 0, 'отказ добавил запись в реестр')
    assert.equal(fs.existsSync(path.join(ROOT, 'dnet-zdes')), false,
      'отказ создал папку дизайна — половина состояния осталась')
  })

  await acheck('designId из другого разговора отвергается до вызова движка', async () => {
    // «Тот же проект» означает «тот же и тот же владелец»: правка чужого
    // дизайна была бы записью в работу другого диалога.
    const env = makeEnv()
    env.registry.push({ id: 'dchuzhoy', chatId: 'chat-A', name: TOPIC })
    const res = await safeRun(build(env.deps()), {
      brief: REVISION, topic: TOPIC, designId: 'dchuzhoy', instruction: REVISION, chatId: 'chat-B'
    })
    assert.equal(res.ok, false, 'чужой designId принят: ' + JSON.stringify(res))
    assert.equal(env.calls.length, 0, 'движок вызван в чужой дизайн')
    assert.equal(env.registry.length, 1, 'отказ изменил реестр')
  })

  await acheck('некорректный designId даёт отказ, а не исключение наружу', async () => {
    // Идентификатор приходит из разговора, где его могла написать модель.
    for (const designId of ['../escape', 'd/../x', 'd\\/x', 'пробел ы', 'x'.repeat(200), 42, {}]) {
      const env = makeEnv()
      const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, designId, chatId: 'chat-1' })
      assert.equal(res.ok, false, `designId ${JSON.stringify(designId)} принят`)
      assert.ok(String(res.error || '').trim().length > 0, 'отказ без причины: ' + JSON.stringify(res))
    }
  })

  // 8 — падение движка не роняет чат.
  await acheck('движок бросил: run возвращает failed и не роняет чат', async () => {
    const env = makeEnv({ failOnce: 'throw' })
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, false, 'падение движка оформлено как успех: ' + JSON.stringify(res))
    assert.equal(res.status, 'failed', 'статус не failed: ' + JSON.stringify(res))
    assert.match(String(res.error || ''), new RegExp(THROW_MARK),
      'причина падения не передана: ' + JSON.stringify(res))
    const statuses = env.events.map(statusOf)
    assert.ok(statuses.includes('failed'),
      'окно не узнало об отказе — notify не получил failed: ' + statuses.join(' → '))
    assert.equal(statuses[statuses.length - 1], 'failed', 'финал notify не совпал с отказом')
  })

  // 9 — отказ движка (не исключение).
  await acheck('движок вернул success:false: это отказ с объяснением, а не успех', async () => {
    const env = makeEnv({ failOnce: 'soft' })
    const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, false, 'отказ движка оформлен как готовая работа: ' + JSON.stringify(res))
    assert.equal(res.status, 'failed')
    assert.equal(typeof res.error, 'string')
    assert.ok(res.error.trim().length > 0, 'в карточке отказа нечем объяснить причину')
    assert.match(res.error, new RegExp(SOFT_MARK.split(':')[0]),
      'причина движка проглочена: ' + JSON.stringify(res))
    assert.equal(env.events.map(statusOf).includes('failed'), true, 'notify не получил failed')
  })

  // 10 — права не расширяются.
  await acheck('кроме переданных зависимостей модуль ни к чему не прикасается', async () => {
    const env = makeEnv()
    const before = walk(ROOT)
    const spies = armSystemSpies()
    let res
    try {
      res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    } finally {
      spies.restore()
    }
    assert.equal(res.ok, true, 'задача не выполнена: ' + JSON.stringify(res))
    assert.deepEqual(spies.seen, [],
      'модуль обошёл зависимости и полез в систему: ' + spies.seen.join('; '))
    assert.deepEqual([...new Set(env.storeCalls)].filter(name => !STORE_ALLOWED.has(name)), [],
      'у хранилища спросили то, что не входило в контракт: ' + env.storeCalls.join(', '))
    assert.ok(env.calls.length > 0, 'движок не вызван ни разу — тогда чем сделан макет?')
    assert.deepEqual(env.calls.filter(call => !DESIGN_TOOL_NAMES.has(call.name)).map(call => call.name), [],
      'в движок ушло что-то кроме dc_*')
    const withPath = env.componentNames().filter(item =>
      item.value.includes('/') || item.value.includes('\\') || item.value.includes('..'))
    assert.deepEqual(withPath, [], 'имя компонента передано путём: ' + JSON.stringify(withPath))
    assert.deepEqual(env.newFiles(before).filter(rel => outsideDesign(rel, res.designId)), [],
      'кроме папки своего дизайна тронуто: ' + env.newFiles(before).join(', '))
    assert.deepEqual(env.designsCalls.filter(call => !['list', 'add', 'update'].includes(call)), [],
      'у реестра спросили не то, что он обещал: ' + env.designsCalls.join(', '))
  })

  await acheck('в исходнике модуля нет файловой системы, процессов, сети и Electron', async () => {
    // Ранняя страховка к шпионам: импорт `fs` не всегда успевает проявиться
    // в конкретном прогоне, но он всегда виден в тексте модуля.
    assert.ok(taskExists, 'нет файла src/main/design/task.js')
    const source = fs.readFileSync(TASK_FILE, 'utf8')
    const specifiers = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
    assert.deepEqual(specifiers.filter(name => FORBIDDEN_REQUIRES.has(name)), [],
      'модуль тянет права в обход зависимостей: ' + specifiers.join(', '))
    assert.equal(/(?<![.\w])fetch\s*\(/.test(source), false, 'у модуля есть сетевой запрос')
    assert.equal(/XMLHttpRequest|new\s+WebSocket/.test(source), false, 'у модуля есть сетевой клиент')
  })

  // 11 — «половинок» не остаётся.
  await acheck('отказ не оставляет половинки в реестре дизайнов', async () => {
    // Выбрано поведение «на успехе ровно один add, на отказе — ни одного»:
    // запись в реестре без написанного компонента была бы битой карточкой,
    // по которой человек кликает и попадает в пустой раздел.
    for (const failOnce of ['throw', 'soft']) {
      const env = makeEnv({ failOnce })
      const res = await safeRun(build(env.deps()), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
      assert.equal(res.ok, false, `отказ (${failOnce}) оформлен как успех: ${JSON.stringify(res)}`)
      assert.equal(env.designsCalls.filter(call => call === 'add').length, 0,
        `после отказа (${failOnce}) в реестре появилась запись`)
      assert.equal(env.registry.length, 0, `после отказа (${failOnce}) реестр изменился`)
    }
  })

  // 12 — лимит версий после серии правок.
  await acheck('25 прогонов того же проекта держат лимит версий (<= 20)', async () => {
    const env = makeEnv()
    const task = build(env.deps())
    let designId = null
    let component = null
    const versions = []
    for (let step = 0; step < 25; step++) {
      const input = designId
        ? { brief: `${REVISION} (шаг ${step + 1})`, topic: TOPIC, designId, instruction: REVISION, chatId: 'chat-1' }
        : { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' }
      const res = await safeRun(task, input)
      assert.equal(res.ok, true, `прогон ${step + 1} не выполнен: ` + JSON.stringify(res))
      if (designId === null) { designId = res.designId; component = res.component }
      assert.equal(res.designId, designId, `прогон ${step + 1} ушёл в другой дизайн`)
      versions.push(Number(res.version))
    }
    // Номер обязан расти, а не застревать на «2»: первые десять шагов — до
    // любого влияния лимита, поэтому счётчик нельзя выйти из-под проверки,
    // просто считая версии по длине папки.
    assert.deepEqual(versions.slice(0, 10).filter((value, index) =>
      index > 0 && !(value > versions[index - 1])), [],
      'номер версии перестал расти: ' + versions.join(', '))
    assert.equal(env.registry.length, 1, 'серия правок размножила дизайны')
    const kept = await store.listVersions(designId, component)
    assert.ok(kept.length <= 20,
      `история выросла до ${kept.length} — лимит 20 не соблюдается`)
    assert.ok(kept.length >= 1, 'после 25 правок истории версий нет вовсе')
    const files = await store.list(designId)
    assert.ok(files.length >= 1, 'серия правок не оставила ни одного компонента')
  })

  // 13 — окно может быть закрыто.
  await acheck('createDesignTask без notify работает и не падает', async () => {
    const env = makeEnv()
    const deps = { store: env.store, designs: env.designs, runTool: env.runTool }
    const res = await safeRun(build(deps), { brief: BRIEF, topic: TOPIC, chatId: 'chat-1' })
    assert.equal(res.ok, true, 'зависимость notify стала обязательной: ' + JSON.stringify(res))
    assert.equal(res.status, 'ready')
    assert.equal(env.calls.length > 0, true, 'движок не вызван — успех на пустоте')
  })
}

run()
  .then(() => {
    fs.rmSync(ROOT, { recursive: true, force: true })
    console.log(JSON.stringify({
      ok: failed === 0,
      checks: total,
      failed,
      module: taskExists && typeof createDesignTask === 'function' ? 'есть' : 'отсутствует'
    }))
    process.exit(failed ? 1 : 0)
  })
  .catch(error => {
    // Харнесс падает — но отчёт всё равно печатается: честный список провалов
    // важнее красивого обрыва.
    failed++
    console.error('ПРОВАЛ ХАРНЕССА: ' + (error && error.stack || error))
    try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* временная папка — не доказательство */ }
    console.log(JSON.stringify({
      ok: false,
      checks: total,
      failed,
      module: taskExists && typeof createDesignTask === 'function' ? 'есть' : 'отсутствует'
    }))
    process.exit(1)
  })
