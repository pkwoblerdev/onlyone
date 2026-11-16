// Проводка контрольных точек в главном процессе (план, этап 6, блок 2).
//
// `run-checkpoints.js` умеет шифровать, считать остаток по LIMITS и наследовать
// сделанное — но умеет, а не делает: всё это включается вызовом из `main.js`.
// Этот тест вырезает из главного процесса три настоящих участка и запускает их:
// создание хранилища, отдачу карточки «Работа прервалась» и разбор продолженного
// хода в `send-message`. Модули настоящие (`run-checkpoints`, `agent-cycle`,
// `agent-run-context`), заглушены только `app`, `ipcMain` и `safeStorage`:
// проверяется договор, по которому просьба уходит в encryptString перед записью
// и возвращается из decryptString перед чтением. Настоящий DPAPI и настоящее
// окно — за `tests/run-resume-secure-ui.cjs`.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createCheckpointStore, continuationPrompt } = require('../src/main/run-checkpoints')
const { tr } = require('../src/main/ui-text.cjs')
const { createDesignEditTurn } = require('../src/main/design/edit-turn')
const { createCycle, LIMITS } = require('../src/main/agent-cycle')
const { createRunContext } = require('../src/main/agent-run-context')

// Путь к исходнику можно подменить только одному харнессу —
// `audits/qoder-2-2026-09-24/checkpoint-wiring-mutation.cjs`, который проверяет,
// что эти проверки краснеют на прежнем коде. В общем прогоне переменная не
// выставлена, и читается канонический `src/main/main.js`.
const MAIN_PATH = process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(__dirname, '..', 'src', 'main', 'main.js')
const main = fs.readFileSync(MAIN_PATH, 'utf8')

function at(marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

// Настоящие участки главного процесса.
const STORE_CODE = cut('const runCheckpoints = createCheckpointStore(', '\nlet interruptedRuns = null')
// Помощники шифрования, на которые хранилище опирается с шифрованием на диске:
// safeStorageAvailable / protectStore / unprotectStore. Берутся из main.js как есть.
const HELPERS_CODE = cut('function safeStorageAvailable() {', '// Контрольные точки ходов')
const CARD_CODE = cut("ipcMain.handle('interrupted-runs',", "ipcMain.handle('dismiss-interrupted-run'")
const RESUME_FROM = 'const resumed = payload.resumeRunId'
const RESUME_TO = 'payload = { ...payload, runContext, checkpoint, cycle, budget }'
const RESUME_CODE = main.slice(at(RESUME_FROM), at(RESUME_TO, at(RESUME_FROM)) + RESUME_TO.length)
// Снятие прежней записи с 31.10 стоит в участке допуска — после проверки мода
// (иначе отказ prepare оставлял человека без карточки «Продолжить»). Тело
// берётся из main.js как есть и зовётся здесь там же, где живёт: после допуска.
const DISMISS_CODE = main.slice(at('if (resumed && checkpoint.saved()) {'),
  at('\n      }', at('if (resumed && checkpoint.saved()) {')) + 8)
// Вербовка признака «сделай полностью» — та же функция, что в главном процессе,
// а не похожая в тесте: вместе с ней проверяются и сами отметки.
const MARKS_CODE = cut('const WHOLE_JOB_MARKS = [', '\nfunction wantsWholeJob')
const WANTS_CODE = cut('function wantsWholeJob(input) {', '\n// How many times a turn')
const TEXT_CODE = cut('function messageText(content) {', '\n// The user saying the job')

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// ---------------------------------------------------------------------------
// Фабрики: тот же код, что в main.js, только с подставленным шифром и путём
// ---------------------------------------------------------------------------

// safeStorage здесь — обратимая упаковка по тому же договору (строка на вход,
// строка на выход): проверяется проводка, а не криптография.
function sealer({ ok = true } = {}) {
  const calls = { encrypt: 0, decrypt: 0 }
  const safeStorage = {
    encryptString(text) {
      calls.encrypt++
      if (!ok) throw new Error('DPAPI unavailable')
      return Buffer.from(text, 'utf8').toString('base64')
    },
    decryptString(buffer) {
      calls.decrypt++
      if (!ok) throw new Error('DPAPI unavailable')
      return Buffer.from(buffer).toString('utf8')
    }
  }
  return { safeStorage, calls }
}

// Хранилище, собранное строкой из main.js: папка хода берётся из getPath, как в
// живом приложении, то есть контрольные точки лежат в <профиль>/runs.
function buildStore(where, cipher = {}) {
  const { safeStorage, calls } = sealer(cipher)
  const store = new Function('createCheckpointStore', 'app', 'join', 'safeStorage',
    `${HELPERS_CODE}\n${STORE_CODE}; return runCheckpoints`)(
    createCheckpointStore, { getPath: () => where }, path.join,
    { isEncryptionAvailable: () => true, ...safeStorage })
  return { store, safeStorageCalls: calls }
}

function buildWantsWholeJob() {
  return new Function(`${MARKS_CODE}\n${TEXT_CODE}\n${WANTS_CODE}; return wantsWholeJob`)()
}

// Карточка «Работа прервалась» — обработчик того же тела, что в main.js.
function buildCard(list) {
  let handler = null
  new Function('ipcMain', 'interruptedRunList', 'continuationPrompt', 'wantsWholeJob', CARD_CODE)(
    { handle: (_channel, fn) => { handler = fn } }, () => list, continuationPrompt, buildWantsWholeJob())
  return handler()
}

// Участок `send-message`, который заводит ход и продолжение. Возвращает то, на
// что опирается остальной ход: payload, контрольную точку, бюджет, контекст.
function runResume({ where, payload, list, cipher = {} }) {
  const { store } = buildStore(where, cipher)
  // Участок хода отмечает начало хода макета у помощника правки из чата
  // (4.2 шаг 2): берём настоящий модуль, без внешних зависимостей — только память.
  const designEditTurn = createDesignEditTurn({ designs: {}, send: () => {} })
  const here = {}
  const out = new Function('payload', 'interruptedRunList', 'runCheckpoints', 'createRunContext', 'createCycle',
    'wantsWholeJob', 'TURN_SOFT_LIMIT_MS', 'app', 'process', 'activeAbortControllers', 'event', 'designEditTurn', 'here', 'tr',
    'budgetPlanForTurn', 'createBudgetRuntime', 'activeBudgetRuns', 'lastBudgetRefusal', 'deskService', 'noteBudgetResult',
    `${RESUME_CODE}
${DISMISS_CODE}; return { payload, checkpoint, cycle, runContext, resumed }`)(
    payload, () => list, store, createRunContext, createCycle, buildWantsWholeJob(), 60000,
    { isPackaged: false }, process, new Map(),
    // IPC-событие хода: по нему ход привязывается к своему окну (закрытие одного
    // окна не снимает ход другого). Окно здесь одно и живое.
    { sender: { id: 1 } }, designEditTurn, here, tr,
    () => ({ limits: null, deadlineAt: null }), () => ({ ok: true, enabled: false, id: null }),
    new Map(), new Map(), null, () => {})
  assert.equal(here.runContext, out.runContext, 'observations belong to this resumed turn')
  return { ...out, store }
}

const mkDir = name => fs.mkdtempSync(path.join(os.tmpdir(), `onlyone-checkpoint-wiring-${name}-`))
const runsOf = where => path.join(where, 'runs')
const runPath = (where, runId) => path.join(runsOf(where), `${runId}.json`)
const runFile = (where, runId) => JSON.parse(fs.readFileSync(runPath(where, runId), 'utf8'))
const rawRun = (where, runId) => fs.readFileSync(runPath(where, runId), 'utf8')
const seal = text => `enc:v1:${Buffer.from(text).toString('base64')}`
const RAW_ASK = 'Собери отчёт по пальмам и выложи на сайт'
const SECRET_ASK = `${RAW_ASK}, ключ sk-or-v1-EXAMPLE233cf8ed4abcdef1234567890`
const id = n => `aaaa0000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`

// Просьба в этих проверках уходит в шифр, поэтому файл пишется руками: надо
// проверить, как карточка считает остаток по готовой записи, а не как она её
// записала — это проверки выше.
function lieFile(where, runId, { ask, wholeJob, used, limit }) {
  fs.mkdirSync(runsOf(where), { recursive: true })
  fs.writeFileSync(runPath(where, runId), JSON.stringify({
    schemaVersion: 1, runId, chatId: 'chat-lie', surface: 'chat',
    ask, startedAt: 1, updatedAt: 1, cycle: {
      schemaVersion: 1, wholeJob, deadlineAt: 0, restoredFrom: '', stages: [], checks: [],
      spent: { reworks: { used, limit }, judge: { used: 0, limit: 99 }, rounds: { used: 0, limit: 99 } }
    },
    actions: [{ seq: 1, tool: 'write_file', target: 'index.html', status: 'done', at: 1 }]
  }))
}

// Прерванный ход: в файле лежат поверхность и два
// действия — одно сделано, второе оборвалось посреди выполнения.
function seedInterrupted(where, runId, { chatId = 'chat-w', designId = null, ask = RAW_ASK } = {}) {
  const { store } = buildStore(where)
  const run = store.start({ runId, chatId, designId, surface: designId ? 'design' : 'chat', ask })
  run.begin('write_file', { path: 'report.md' }).end('done')
  run.begin('run_command', { command: 'npm run build' })
  return store
}

const CONTINUE_TEXT = continuationPrompt({ ask: RAW_ASK, done: [], failed: [], unknown: [],
  context: null, cycle: null, droppedActions: 0 })
const payloadOf = ({ runId, designId = null }) => ({
  requestId: 'r-2', chatId: designId ? null : 'chat-w', designId,
  resumeRunId: runId, messages: [{ role: 'user', content: CONTINUE_TEXT }]
})

try {
  // -------------------------------------------------------------------------
  // 1. Шифрование просьбы
  // -------------------------------------------------------------------------

  check('main.js заводит хранилище с парой protect/unprotect от safeStorage', () => {
    // Хранилище зовёт protectStore/unprotectStore, а те — safeStorage: пара цела,
    // если и звенья, и сами помощники на месте.
    assert.ok(/protect:\s*text\s*=>\s*safeStorageAvailable\(\)\s*\?\s*protectStore\(text\)/.test(STORE_CODE), 'нет protect от safeStorage')
    assert.ok(/unprotect:\s*body\s*=>\s*safeStorageAvailable\(\)\s*\?\s*unprotectStore\(body\)/.test(STORE_CODE), 'нет unprotect от safeStorage')
    assert.ok(/safeStorage\.encryptString/.test(HELPERS_CODE) && /safeStorage\.decryptString/.test(HELPERS_CODE), 'помощники не зовут safeStorage')
  })

  check('просьба ложится на диск шифром, а не текстом', () => {
    const where = mkDir('seal')
    try {
      const { store, safeStorageCalls } = buildStore(where)
      store.start({ runId: id(1), chatId: 'chat-1', ask: RAW_ASK })
      assert.ok(runFile(where, id(1)).ask.startsWith('enc:v1:'), 'в файле нет пометки шифра')
      assert.ok(!rawRun(where, id(1)).includes(RAW_ASK), 'просьба читается в файле открытым текстом')
      assert.equal(safeStorageCalls.encrypt, 1, 'шифр вызван не один раз на запись')
      store.dismiss(id(1))
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('карточка получает просьбу обратно через расшифровку', () => {
    const where = mkDir('unseal')
    try {
      const { store, safeStorageCalls } = buildStore(where)
      store.start({ runId: id(2), chatId: 'chat-2', ask: RAW_ASK })
      const blind = createCheckpointStore({ dir: runsOf(where) }).interrupted()
      assert.equal(blind.length, 1, 'ход без пары unprotect пропал из списка')
      assert.equal(blind[0].askUnreadable, true, 'нечитаемая просьба выдана за пустую')
      assert.equal(String(blind[0].ask).includes('enc:v1:'), false, 'без ключа шифр распечатался бы как текст')
      const read = store.interrupted()
      assert.equal(read[0].ask, RAW_ASK, 'просьба не дошла до карточки')
      assert.equal(safeStorageCalls.decrypt, 1, 'чтение идёт мимо safeStorage')
      store.dismiss(id(2))
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('токен в просьбе не уезжает на диск даже внутрь шифра', () => {
    const where = mkDir('secret')
    try {
      const { store } = buildStore(where)
      store.start({ runId: id(3), chatId: 'chat-3', ask: SECRET_ASK })
      const body = Buffer.from(runFile(where, id(3)).ask.slice('enc:v1:'.length), 'base64').toString('utf8')
      assert.ok(!body.includes('sk-or-v1-abcdef'), 'секрет попал в шифр до упаковки')
      assert.ok(body.includes('***'), 'секрет не вычищен')
      assert.ok(!/sk-or-v1/.test(JSON.stringify(store.interrupted())), 'секрет вернулся в опись')
      store.dismiss(id(3))
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('шифр недоступен — ход не падает, открытого секрета на диске нет', () => {
    const where = mkDir('nocipher')
    try {
      const { store } = buildStore(where, { ok: false })
      const run = store.start({ runId: id(4), chatId: 'chat-4', ask: SECRET_ASK })
      assert.ok(run, 'ход не заведён из-за недоступного шифра')
      assert.ok(!rawRun(where, id(4)).includes('sk-or-v1-abcdef'), 'без шифра секрет лёг на диск открыто')
      store.dismiss(id(4))
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('расшифровка не удалась — карточка говорит о нечитаемой просьбе, опись действий цела', () => {
    const where = mkDir('bad-decrypt')
    try {
      const { store } = buildStore(where)
      const run = store.start({ runId: id(5), chatId: 'chat-5', ask: RAW_ASK })
      run.begin('run_command', { command: 'npm run build' })
      // Смена учётной записи Windows: шифр перестаёт открываться.
      const broken = buildStore(where, { ok: false })
      const read = broken.store.interrupted()
      assert.equal(read.length, 1, 'ход пропал из-за нерасшифрованного поля')
      assert.equal(read[0].askUnreadable, true, 'нечитаемая просьба выдана за пустую')
      assert.equal(String(read[0].ask).includes('enc:v1:'), false, 'карточка показала бы чужие байты вместо просьбы')
      assert.equal(read[0].unknown.length, 1, 'опись неизвестных действий потерялась')
      const text = continuationPrompt(read[0])
      assert.ok(/npm run build/.test(text), 'действие исчезло из описи')
      assert.ok(!/Собери отчёт/.test(text), 'в описи выдумалась просьба, которой нет')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  // Файл прежней версии программы лежит открытым текстом — читать надо умеючи:
  // совместность со старыми ходами важнее строгого шва.
  check('старый файл с открытой просьбой читается, секрет в нём закрывается', () => {
    const where = mkDir('legacy')
    try {
      fs.mkdirSync(runsOf(where), { recursive: true })
      fs.writeFileSync(runPath(where, id(6)), JSON.stringify({
        schemaVersion: 1, runId: id(6), chatId: 'chat-6', surface: 'chat',
        ask: 'Собери проект, пароль: hunter2hunter2hunter2', startedAt: 1, updatedAt: 1,
        actions: [{ seq: 1, tool: 'write_file', target: 'a.js', status: 'done', at: 1 }]
      }))
      const { store } = buildStore(where)
      const read = store.interrupted()
      assert.equal(read.length, 1, 'старый ход не найден')
      assert.equal(read[0].ask, 'Собери проект, пароль: ***', 'старый файл не прочитан или секрет не закрыт')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  // -------------------------------------------------------------------------
  // 2. Доверенный расчёт бюджета
  // -------------------------------------------------------------------------

  const reworksIn = prompt => Number((prompt.match(/доработка (\d+)/) || [])[1])

  check('карточка считает предел по просьбе, а не по полю файла', () => {
    const where = mkDir('budget-file-lie')
    try {
      const { store } = buildStore(where)
      lieFile(where, id(7), { ask: seal('Собери проект'), wholeJob: true, used: 0, limit: 999 })
      const card = buildCard(store.interrupted())
      assert.equal(reworksIn(card[0].prompt), LIMITS.reworks,
        'просьба без знака «полностью» обещает шесть попыток')
      assert.ok(!/\b999\b|\b9[0-9]\b/.test(card[0].prompt), 'в опись просочился предел из файла')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('просьба «сделай полностью» даёт шесть попыток, хотя файл молчал', () => {
    const where = mkDir('budget-ask')
    try {
      const { store } = buildStore(where)
      lieFile(where, id(8), { ask: seal('Доведи проект до конца'), wholeJob: false,
        used: 0, limit: LIMITS.reworks })
      const card = buildCard(store.interrupted())
      assert.equal(reworksIn(card[0].prompt), LIMITS.reworksWholeJob, 'карточка не увидела знак в просьбе')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('потраченное при падении не возвращается', () => {
    const where = mkDir('budget-used')
    try {
      const { store } = buildStore(where)
      lieFile(where, id(9), { ask: seal('Доведи проект до конца'), wholeJob: true, used: 5,
        limit: LIMITS.reworksWholeJob })
      const card = buildCard(store.interrupted())
      assert.equal(reworksIn(card[0].prompt), 1, 'остаток не равен пределу минус потраченное')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('карточка и цикл продолженного хода называют один остаток', () => {
    for (const [ask, name] of [['Собери проект', 'обычная просьба'], ['Доведи проект до конца', 'со знаком']]) {
      const where = mkDir('agree')
      try {
        lieFile(where, id(10), { ask: seal(ask), wholeJob: false, used: 1, limit: LIMITS.reworks })
        const { store } = buildStore(where)
        const run = store.interrupted()[0]
        const card = reworksIn(buildCard(store.interrupted())[0].prompt)
        const out = runResume({ where, cipher: {}, list: store.interrupted(),
          payload: payloadOf({ runId: run.runId }) })
        assert.equal(out.cycle.left('reworks'), card,
          `${name}: карточка обещает ${card}, цикл даёт ${out.cycle.left('reworks')}`)
        assert.equal(out.cycle.wholeJob, buildWantsWholeJob()(ask), `${name}: предел не соответствует просьбе`)
        assert.equal(out.cycle.restored, true, `${name}: бюджет начат заново, а не продолжен`)
        store.dismiss(out.runContext.runId)
      } finally { fs.rmSync(where, { recursive: true, force: true }) }
    }
  })

  // 3. Продолжение сохраняет поверхность и сделанное
  // -------------------------------------------------------------------------

  check('Дизайн остаётся Дизайном и после перезапуска', () => {
    const where = mkDir('design-surface')
    try {
      seedInterrupted(where, id(13), { designId: 'design-1' })
      const { store } = buildStore(where)
      const out = runResume({ where, cipher: {}, list: store.interrupted(),
        payload: payloadOf({ runId: id(13), designId: 'design-1' }) })
      const file = runFile(where, out.runContext.runId)
      assert.equal(file.surface, 'design', 'ход Дизайна продолжился как чат')
      assert.equal(file.designId, 'design-1', 'макет открепился при продолжении')
      store.dismiss(out.runContext.runId)
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('наследуются и сделанное, и неизвестный исход', () => {
    const where = mkDir('carried')
    try {
      seedInterrupted(where, id(14))
      const { store } = buildStore(where)
      const out = runResume({ where, cipher: {}, list: store.interrupted(),
        payload: payloadOf({ runId: id(14) }) })
      const file = runFile(where, out.runContext.runId)
      const write = file.actions.find(item => item.tool === 'write_file')
      const build = file.actions.find(item => item.tool === 'run_command')
      assert.equal(write && write.status, 'done', 'сделанное не унаследовано')
      assert.equal(write && write.carried, true, 'унаследованное не помечено как унаследованное')
      assert.equal(build && build.status, 'started', 'оборванное действие стало считаться сделанным')
      store.dismiss(out.runContext.runId)
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  // -------------------------------------------------------------------------
  // 4. Снятие прежней записи
  // -------------------------------------------------------------------------

  check('при живом диске прежняя запись снимается, когда новая сохранена', () => {
    const where = mkDir('dismiss')
    try {
      seedInterrupted(where, id(15))
      const { store } = buildStore(where)
      const list = store.interrupted()
      const out = runResume({ where, cipher: {}, list, payload: payloadOf({ runId: id(15) }) })
      assert.equal(fs.existsSync(runPath(where, id(15))), false, 'старый файл остался на диске')
      assert.equal(list.some(item => item.runId === id(15)), false, 'старый ход остался в списке окна')
      assert.ok(fs.existsSync(runPath(where, out.runContext.runId)), 'новый ход не записан')
      store.dismiss(out.runContext.runId)
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('диск не принимает новую запись — прежняя остаётся, память не теряется', () => {
    const where = mkDir('dismiss-broken')
    const realWrite = fs.writeFileSync
    try {
      seedInterrupted(where, id(16))
      const { store } = buildStore(where)
      fs.writeFileSync = (target, ...rest) => {
        if (String(target).startsWith(runsOf(where))) throw new Error('ENOSPC')
        return realWrite(target, ...rest)
      }
      const out = runResume({ where, cipher: {}, list: store.interrupted(), payload: payloadOf({ runId: id(16) }) })
      assert.equal(out.checkpoint.saved(), false, 'ход объявил себя записанным без диска')
      assert.equal(fs.existsSync(runPath(where, id(16))), true,
        'прежняя запись снята, хотя новая до диска не дошла')
    } finally {
      fs.writeFileSync = realWrite
      fs.rmSync(where, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // 4a. Ошибка восстановления не превращается в новую задачу
  // -------------------------------------------------------------------------

  check('повторное продолжение по снятой записи не заводит тихо новую задачу', () => {
    const where = mkDir('resume-twice')
    try {
      seedInterrupted(where, id(17))
      const { store } = buildStore(where)
      const list = store.interrupted()
      const payload = payloadOf({ runId: id(17) })
      const first = runResume({ where, cipher: {}, list, payload })
      assert.equal(first.resumed?.runId, id(17), 'первое продолжение не нашло запись')
      store.dismiss(first.runContext.runId)
      // Второе «Продолжить» приходит с тем же id: первый ход уже снял запись.
      // Это не новая задача — это ошибка восстановления, и она обязана быть
      // названа, а не превратиться в ход с пустой описью.
      assert.throws(() => runResume({ where, cipher: {}, list, payload }),
        /Прерванный ход не найден/, 'повторное продолжение молча начало новую задачу')
      const left = fs.existsSync(runsOf(where))
        ? fs.readdirSync(runsOf(where)).filter(name => name.endsWith('.json')) : []
      assert.deepEqual(left, [], 'после отказа остался новый файл хода')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('продолжение по повреждённой записи названо ошибкой, а не новой задачей', () => {
    const where = mkDir('resume-corrupt')
    try {
      // Карточка могла остаться от прежнего чтения, а файл — обрезаться или
      // исчезнуть. Продолжать нечего; начинать вместо этого новый ход нельзя.
      fs.mkdirSync(runsOf(where), { recursive: true })
      fs.writeFileSync(runPath(where, id(18)), '{"schemaVersion":1,"runId":')
      const { store } = buildStore(where)
      // Контракт изменён находкой Н9 (break-4, 11.11): битый файл больше не исчезает
      // из списка молча — он виден как прерванная работа с признаком порчи, иначе
      // человек не знает о потере и повторяет побочные действия вслепую. Продолжать
      // его по-прежнему нельзя: ошибка названа, новый ход не заводится (проверки ниже).
      const broken = store.interrupted()
      assert.equal(broken.length, 1, 'повреждённая запись исчезла из списка молча')
      assert.equal(broken[0].corrupt, true, 'запись не помечена повреждённой')
      assert.equal(broken[0].askUnreadable, true, 'текст просьбы не назван нечитаемым')
      assert.throws(() => runResume({ where, cipher: {}, list: [], payload: payloadOf({ runId: id(18) }) }),
        /Прерванный ход не найден/, 'ошибка восстановления завела новую задачу')
      const names = fs.readdirSync(runsOf(where)).filter(name => name.endsWith('.json'))
      assert.deepEqual(names, [`${id(18)}.json`], 'к повреждённой записи добавился новый ход')
      assert.equal(fs.readFileSync(runPath(where, id(18)), 'utf8'), '{"schemaVersion":1,"runId":')
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  // -------------------------------------------------------------------------
  // 5. Прежний DNS-патч не должен случайно откатиться: сам он проверяется в
  // `test-web-fetch.cjs`, здесь только факт проводки в общем файле
  // -------------------------------------------------------------------------

  check('привязка к моду сохраняется и восстанавливается до сжатия истории', () => {
    assert.match(main, /mod: payload\.modAction \|\| null/, 'запись не сохраняет привязку к моду')
    assert.match(main, /if \(!payload\.modAction && resumed\?\.mod\) payload = \{ \.\.\.payload, modAction: \{ \.\.\.resumed\.mod, chatId: payload\.chatId \|\| null \} \}/,
      'продолжение не восстанавливает привязку к моду')
    const prepare = main.indexOf("require('./mods-run.cjs').prepare")
    const compress = main.indexOf('compressHistoryForTurn(payload.messages')
    assert.ok(prepare > 0 && compress > prepare, 'prepare обязан идти раньше сжатия истории')
  })

  check('продолжение прерванного хода реально возвращает привязку к моду', () => {
    const where = mkDir('mod-resume')
    try {
      const { store } = buildStore(where)
      store.start({ runId: id(21), chatId: 'chat-w', ask: RAW_ASK, mod: { modId: 'onlyone.project-checks', panelId: 'checks', buttonId: 'test', revision: 4, chatId: 'chat-w', token: 'SECRET' } })
      const out = runResume({ where, cipher: {}, list: store.interrupted(), payload: payloadOf({ runId: id(21) }) })
      assert.deepEqual(out.resumed.mod, { modId: 'onlyone.project-checks', panelId: 'checks', buttonId: 'test', revision: 4, chatId: 'chat-w' }, 'привязка вернулась без токена')
      assert.equal(JSON.stringify(out.resumed).includes('SECRET'), false)
    } finally { fs.rmSync(where, { recursive: true, force: true }) }
  })

  check('навык мода идёт во все роли команды через общий payload', () => {
    for (const marker of ['const leadPayload = {', 'const helperPayload = {', 'const acceptancePayload = {'])
      assert.match(main.slice(at(marker), at(marker) + 60), /\.\.\.payload,/, marker + ' не наследует payload с modSkill')
    assert.match(main, /runAgentSlot\(event, slot, \{\r?\n\s+\.\.\.payload,/, 'круг возражений не наследует payload')
  })

  check('отказ до допуска не публикует событие хода', () => {
    assert.match(main, /let admitted = false/, 'нет признака допуска')
    assert.match(main, /if \(admitted && typeof publishModsEvent/, 'событие публикуется без допуска')
    assert.match(main, /runContext\.finish\(controller\.signal\.aborted \|\| smoke\.aborted \? 'cancelled' : 'completed'\)/,
      'тестовый ход не получает настоящего завершения')
  })

  check('dispatch fetch_url по-прежнему берёт local из ctx', () => {
    assert.ok(/const local = ctx \? ctx\.local : await webFetch\.isLocalHost/.test(main),
      'проверка локального адреса снова делается вторым dns.lookup')
  })
} finally {
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
}
console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
process.exit(failures.length ? 1 : 0)
