// Окно Workspace Ultra: сбор, выгрузка, разворот (U-7).
//
// Оконный прогон `run-ultra-workspace-ui.cjs` не может проверить ветку ИМПОРТА:
// выгрузка и открытие файла идут через диалог главного процесса, а диалог в окне
// не откроется. Поэтому здесь модуль окна (`src/renderer/ultra-workspace.js`)
// гоняется с подставным мостом — и проверяется ровно то, что диалог скрывает:
// порядок действий, что разворот возвращает блоки на места, и что человек
// узнаёт словами о том, что не нашлось.
//
// ПОРЯДОК ДЕЙСТВИЙ — ЭТО И ЕСТЬ ПОВЕДЕНИЕ. Например, при выгрузке профиль
// сохраняется ПЕРЕД выгрузкой в файл: если файл не запишется, у человека должен
// остаться Workspace в профиле, а не пустота. Набор ломает порядок и смотрит,
// что заметит.
const assert = require('node:assert/strict')
const { create } = require('../src/renderer/ultra-workspace')

let failed = 0
let total = 0
// Проверки асинхронные: модуль окна ходит в мост, и синхронная обёртка проглотала
// бы отказ молча — `fn()` вернул бы обещание, а `throw` внутри случился бы позже
// и никем не был бы пойман. Поэтому обещания копятся и ждут в конце.
const pending = []
const check = (name, fn) => {
  total++
  pending.push(Promise.resolve()
    .then(fn)
    .then(() => console.log('ok', name))
    .catch(error => { failed++; console.error('FAIL', name, error.message) }))
}

const SHELL = {
  rows: [
    { id: 'a1', title: 'Лендинг', role: 'block', x: 40, y: 120, w: 360, h: 480, zone: 'left', min: false },
    { id: 'a2', title: 'Тарифы', role: 'tasks', x: 460, y: 120, w: 360, h: 480, zone: 'free', min: true }
  ]
}

// Мост с журналом: видно, что окно позвало и в каком порядке.
function harness (over) {
  const calls = []
  const toasts = []
  const shell = { workspaceBlocks: () => SHELL, setWorkspaceLayout: map => { calls.push(['setLayout', map]); return true } }
  const bridge = Object.assign({
    saveUltraWorkspace: async (workspace, meta) => { calls.push(['save', workspace, meta]); return { ok: true } },
    exportUltraWorkspace: async workspace => { calls.push(['export', workspace]); return { ok: true, file: 'x.workspace' } },
    importUltraWorkspace: async () => {
      calls.push(['import'])
      return { ok: true, missing: ['index.css'], workspace: { blocks: [] } }
    },
    getUltraLayout: async () => { calls.push(['layout']); return { a1: { x: 40, y: 120, w: 360, h: 480, zone: 'left' } } },
    getToolCapability: async () => ({ tools: ['write_file', 'search_files'] })
  }, over && over.bridge)
  const api = create({
    t: x => String(x == null ? '' : x),
    toast: (text, isError) => toasts.push([String(text), Boolean(isError)]),
    electronAPI: bridge,
    // Оболочка подменяется ЦЕЛИКОМ, когда поле передано: прежний вариант
    // возвращал запасную оболочку и подмену игнорировал — проверка «экран не взял
    // места» проходила на исправной оболочке и ничего не значила.
    shell: () => (over && 'shell' in over ? over.shell : shell),
    lastAssistantRecord: () => (over && over.record) || null
  })
  return { api, calls, toasts, shell }
}

// ─── крафт: Workspace собирается из настоящего состояния ─────────────────────

check('Workspace собирается из раскладки оболочки, а не из пустоты', async () => {
  const { api } = harness()
  const got = await api.collect()
  assert.equal(got.blocks.length, 2, 'оба блока раскладки должны попасть в Workspace')
  assert.equal(got.blocks[0].title, 'Лендинг')
  assert.equal(got.blocks[0].w, 360)
  assert.equal(got.blocks[1].minimized, true, 'признак свёрнутого блока обязан уйти в контейнер')
  assert.ok(got.name, 'у Workspace должно быть имя')
})

check('файлы берутся из того, что ход менял, и приводятся к именам', async () => {
  const { api } = harness({ record: { fileChanges: [{ file: 'src/main/main.js' }, { path: 'C:\\tmp\\app.js' }] } })
  const got = await api.collect()
  assert.deepEqual(got.files, ['main.js', 'app.js'], 'в контейнер не должны попасть чужие пути')
})

check('агенты берутся из тех, кто отвечал', async () => {
  const { api } = harness({ record: { stages: [{ name: 'Ведущий' }, { modelName: 'Проверяющий' }] } })
  const got = await api.collect()
  assert.deepEqual(got.agents, ['Ведущий', 'Проверяющий'])
})

check('инструменты берутся из того, что окно умеет сейчас', async () => {
  const { api } = harness()
  const got = await api.collect()
  assert.deepEqual(got.tools, ['write_file', 'search_files'])
})

check('нет моста инструментов — Workspace собирается, а не падает', async () => {
  const { api } = harness({ bridge: { getToolCapability: async () => { throw new Error('моста нет') } } })
  const got = await api.collect()
  assert.deepEqual(got.tools, [], 'отказ моста не должен ронять сбор')
})

check('пустой экран даёт Workspace без блоков, а не выдуманные', async () => {
  const { api } = harness({ shell: null })
  const got = await api.collect()
  assert.deepEqual(got.blocks, [])
})

// ─── выгрузка ────────────────────────────────────────────────────────────────

const settled = (() => {
  const out = []
  return { run: async (kind) => { out.push(kind); return true } }
})()

check('выгрузка сначала сохраняет профиль, потом пишет файл', async () => {
  let done = false
  const { api, calls } = harness()
  const promise = api.run('export')
  while (!calls.length) await new Promise(r => setTimeout(r, 5))
  assert.equal(calls[0][0], 'save', `первым обязан быть save, а было ${calls[0][0]}`)
  done = true
  assert.ok(done)
  const result = await promise
  assert.equal(result, true)
  assert.deepEqual(calls.map(one => one[0]), ['save', 'export'])
})

check('человен узнаёт, что выгрузил', async () => {
  const { api, toasts } = harness()
  await api.run('export')
  assert.equal(toasts.length, 1, 'молчание здесь равно «кнопка сломалась»')
  assert.match(toasts[0][0], /выгружен/i, toasts[0][0])
  assert.equal(toasts[0][1], false, 'успех не должен подаваться как ошибка')
})

check('отказ выгрузки называет причину, а не говорит «готово»', async () => {
  const { api, toasts } = harness({ bridge: { exportUltraWorkspace: async () => ({ ok: false, reason: 'диск занят' }) } })
  const result = await api.run('export')
  assert.equal(result, false)
  assert.match(toasts[0][0], /диск занят/, toasts[0][0])
  assert.equal(toasts[0][1], true, 'отказ должен быть виден как отказ')
})

check('отмена выгрузки — это не ошибка и не сообщение', async () => {
  const { api, toasts } = harness({ bridge: { exportUltraWorkspace: async () => ({ canceled: true }) } })
  const result = await api.run('export')
  assert.equal(result, false)
  assert.equal(toasts.length, 0, 'отмена человеком — его выбор, а не поломка')
})

// ─── разворот ────────────────────────────────────────────────────────────────

check('разворот: главный процесс импортирует, окно перечитывает раскладку и отдаёт её оболочке', async () => {
  const { api, calls } = harness()
  const result = await api.run('import')
  assert.equal(result, true)
  assert.deepEqual(calls.map(one => one[0]), ['import', 'layout', 'setLayout'],
    'порядок нарушен: без перечитывания раскладки блоки остались бы на старых местах')
})

check('о «не нашлось» сказано вслух, а не выброшено молча', async () => {
  const { api, toasts } = harness()
  await api.run('import')
  assert.match(toasts[0][0], /index\.css/, toasts[0][0])
  assert.match(toasts[0][0], /не нашлось/i, toasts[0][0])
})

check('развёрнутое, но экран места не взял, — это поломка, а не успех', async () => {
  const { api, toasts } = harness({ shell: { workspaceBlocks: () => SHELL, setWorkspaceLayout: () => false } })
  const result = await api.run('import')
  assert.equal(result, false, 'окно рапортовало успехом, хотя блоки остались на старых местах')
  assert.ok(toasts.some(one => one[1] === true), 'о том, что экран не взял места, должно быть сказано как об отказе')
})

check('отказ разворота (подменённый контейнер) называет причину', async () => {
  const { api, toasts } = harness({
    bridge: { importUltraWorkspace: async () => ({ ok: false, reason: 'контейнер изменён после сборки' }) }
  })
  const result = await api.run('import')
  assert.equal(result, false)
  assert.match(toasts[0][0], /изменён/i, toasts[0][0])
  assert.equal(toasts[0][1], true)
})

check('развёрнутый Workspace со всех сторон сохранён', async () => {
  const { api, toasts } = harness()
  await api.run('save')
  assert.match(toasts[0][0], /сохранён/i, toasts[0][0])
})

Promise.all(pending).then(() => {
  if (failed) { console.error(`проверок: ${total}, провалов: ${failed}`); process.exitCode = 1 }
  else console.log(`проверок: ${total}, провалов: 0`)
})