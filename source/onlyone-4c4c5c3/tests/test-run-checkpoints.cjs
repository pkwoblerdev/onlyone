'use strict'
// Контрольные точки хода: переживают падение, не повторяют сделанное вслепую.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCheckpointStore, continuationPrompt, hasSideEffects } = require('../src/main/run-checkpoints')

let checks = 0
function check(name, fn) { fn(); checks++; console.log('ok', name) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-checkpoints-'))
const id = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`

try {
  check('чтение не записывается, изменение — записывается', () => {
    assert.equal(hasSideEffects('read_file'), false)
    assert.equal(hasSideEffects('search_files'), false)
    assert.equal(hasSideEffects('run_command'), true)
    assert.equal(hasSideEffects('write_file'), true)
    assert.equal(hasSideEffects('mcp_github_create_issue'), true)
    assert.equal(hasSideEffects('own_counter'), true)
  })

  check('действие записано на диск до того, как инструмент запущен', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(1), chatId: 'chat-1', ask: 'собери проект' })
    assert.equal(run.begin('read_file', { path: 'a.txt' }), null)
    run.begin('run_command', { command: 'npm install' })
    // Падение здесь: процесс умер, конец действия не записан.
    const found = createCheckpointStore({ dir }).interrupted()
    assert.equal(found.length, 1)
    assert.equal(found[0].chatId, 'chat-1')
    assert.deepEqual(found[0].unknown, [{ tool: 'run_command', target: 'npm install', status: 'unknown' }])
    store.dismiss(id(1))
  })

  check('отказ диска виден: durable = false, действие не считается записанным', () => {
    // Отдельная папка: соседние проверки вычищают общий каталог без
    // рекурсии, а здесь остаётся каталог вместо файла хода.
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-checkpoints-broken-'))
    try {
      const store = createCheckpointStore({ dir: brokenDir })
      const run = store.start({ runId: id(9), chatId: 'chat-9', ask: 'перезапиши файл' })
      assert.equal(run.begin('write_file', { path: 'a.js' }).durable, true)
      // Файл хода заменён каталогом: переименование больше не проходит — это
      // тот же кратковременный отказ диска, что Codex воспроизвёл фикстурой.
      const target = path.join(brokenDir, `${id(9)}.json`)
      fs.rmSync(target, { force: true })
      fs.mkdirSync(target)
      const action = run.begin('run_command', { command: 'npm publish' })
      assert.equal(action.durable, false, 'отказ записи притворился успехом')
      // Не записанное «начато» не остаётся в списке: иначе опись врёт о том,
      // чего на диске нет.
      fs.rmSync(target, { recursive: true, force: true })
      assert.deepEqual(createCheckpointStore({ dir: brokenDir }).interrupted(), [])
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true })
    }
  })

  check('ход не запускает инструмент, если отметка не дошла до диска', () => {
    const main = require('node:fs').readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
    assert.match(main, /checkpointAction\.durable === false/, 'признак отказа не проверяется')
    assert.match(main, /const notDurable = Boolean\(checkpointAction\) && checkpointAction\.durable === false\n      if \(notDurable\) checkpointAction = null/,
      'отказ не снимает отметку')
    const refusalAt = main.indexOf('Контрольная точка хода не записана на диск')
    const executeAt = main.indexOf('|| executeTool(event, toolName, args, payload.requestId, design, signal)')
    assert.ok(refusalAt > 0 && refusalAt < executeAt, 'отказ стоит после исполнения, а не до него')
  })

  check('сделанное, неудачное и неизвестное разделены', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(2), ask: 'x' })
    run.begin('write_file', { path: 'src/a.js', content: 'СЕКРЕТНОЕ-СОДЕРЖИМОЕ' }).end('done')
    run.begin('run_command', { command: 'npm test' }).end('failed')
    run.begin('create_directory', { path: 'out' }).end('denied')
    run.begin('run_command', { command: 'npm run build' })
    const [found] = store.interrupted()
    assert.deepEqual(found.done.map(a => a.target), ['src/a.js'])
    assert.deepEqual(found.failed.map(a => a.target), ['npm test', 'out'])
    assert.deepEqual(found.unknown.map(a => a.target), ['npm run build'])
    const raw = fs.readFileSync(path.join(dir, `${id(2)}.json`), 'utf8')
    assert.equal(raw.includes('СЕКРЕТНОЕ'), false, 'содержимое файла не должно попадать в контрольную точку')
    store.dismiss(id(2))
  })

  check('законченный или остановленный ход не оставляет файла', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(3) })
    run.begin('write_file', { path: 'b' })
    run.close()
    assert.equal(store.interrupted().length, 0)
    assert.equal(run.begin('write_file', { path: 'c' }), null, 'после закрытия ничего не пишется')
    assert.equal(fs.existsSync(path.join(dir, `${id(3)}.json`)), false)
  })

  check('битый, чужой и недописанный файлы не ломают список', () => {
    fs.writeFileSync(path.join(dir, `${id(4)}.json`), '{"schemaVersion":1,"runId":')
    fs.writeFileSync(path.join(dir, 'не-ход.json'), '{}')
    fs.writeFileSync(path.join(dir, `${id(5)}.json.123.tmp`), '{}')
    fs.writeFileSync(path.join(dir, `${id(6)}.json`), JSON.stringify({ schemaVersion: 1, runId: id(7), actions: [] }))
    const found = createCheckpointStore({ dir }).interrupted()
    // Битый файл хода виден как повреждённая прерванная работа (Н9), а не исчезает
    // молча; чужой runId, недописанный .tmp и не-ход по-прежнему пропускаются.
    assert.equal(found.length, 1, 'битый файл исчез из списка прерванных ходов')
    assert.equal(found[0].runId, id(4))
    assert.equal(found[0].corrupt, true, 'повреждённая запись не помечена')
    assert.equal(found[0].askUnreadable, true)
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name))
  })

  check('неверный идентификатор не даёт выйти из папки', () => {
    const store = createCheckpointStore({ dir })
    assert.throws(() => store.start({ runId: '../../evil' }))
    assert.equal(store.dismiss('../settings'), false)
  })

  check('опись растёт не бесконечно и честно говорит, сколько выпало', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(8) })
    for (let i = 0; i < 230; i++) run.begin('write_file', { path: `f${i}` }).end('done')
    const [found] = store.interrupted()
    assert.equal(found.done.length, 200)
    assert.equal(found.droppedActions, 30)
    assert.match(continuationPrompt(found), /Ещё 30 ранних действий/)
    store.dismiss(id(8))
  })

  check('текст продолжения просит проверить, а не повторить', () => {
    const text = continuationPrompt({
      ask: 'собери сайт', done: [{ tool: 'write_file', target: 'index.html' }], failed: [],
      unknown: [{ tool: 'run_command', target: 'npm install' }], droppedActions: 0
    })
    assert.match(text, /Исходная просьба: «собери сайт»/)
    assert.match(text, /не повторяй:\n- write_file: index.html/)
    assert.match(text, /Сначала проверь[\s\S]*- run_command: npm install/)
  })

  check('бюджет и этапы одного ядра переживают закрытие, но секреты — нет', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(10), chatId: 'resume-chat' })
    run.updateContext({
      schemaVersion: 1, surface: 'chat', state: 'running',
      startedAt: 100, deadlineAt: 500, currentPhase: 'verify',
      usage: { totalTokens: 1234, reports: 3 }, droppedEvents: 0,
      journal: [
        { sequence: 1, at: 100, type: 'phase', phase: 'plan', prompt: 'DO NOT STORE' },
        { sequence: 2, at: 110, type: 'usage', tokens: 1234, apiKey: 'DO NOT STORE' },
        { sequence: 3, at: 120, type: 'phase', phase: 'verify', round: 1 }
      ], apiKey: 'DO NOT STORE'
    })
    const found = store.interrupted()[0]
    assert.equal(found.context.usage.totalTokens, 1234)
    assert.equal(found.context.currentPhase, 'verify')
    assert.deepEqual(found.context.journal.map(event => event.phase).filter(Boolean), ['plan', 'verify'])
    const raw = fs.readFileSync(path.join(dir, `${id(10)}.json`), 'utf8')
    assert.equal(raw.includes('DO NOT STORE'), false)
    const prompt = continuationPrompt(found)
    assert.match(prompt, /1234 использованных токенов/)
    assert.match(prompt, /Последний сохранённый этап: verify/)
    store.dismiss(id(10))
  })

  // Общий цикл (2a): бюджет и результаты проверок должны переживать падение,
  // чтобы продолжение шло на остатке попыток, а не с полным комплектом.
  check('остаток бюджета цикла и непройденные проверки переживают падение', () => {
    const { createCycle } = require('../src/main/agent-cycle')
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(11), chatId: 'resume-chat', ask: 'доведи до конца' })
    const cycle = createCycle({ onSave: snapshot => run.updateCycle(snapshot) })
    cycle.spend('reworks')
    cycle.spend('judge')
    cycle.record({ source: 'acceptance', verdict: 'fail', gaps: ['нет проверок', 'ключ API: sk-DO-NOT-STORE'] })
    const found = store.interrupted().find(item => item.runId === id(11))
    assert.equal(found.cycle.spent.reworks.used, 1)
    assert.equal(found.cycle.spent.judge.used, 1)
    assert.equal(found.cycle.checks.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, `${id(11)}.json`), 'utf8').includes('DO NOT STORE'), false,
      'в описи пробелов остаётся только то, что названо проверкой')

    const prompt = continuationPrompt(found)
    assert.match(prompt, /Осталось попыток на этом ходе: доработка 2, независимых проверок 1/)
    assert.match(prompt, /приёмка по просьбе: нет проверок/)
    assert.match(prompt, /Не трать попытки на то, что уже подтверждено/)

    // Продолжение: тот же остаток, а не полный бюджет.
    const resumed = createCycle({ restored: found.cycle })
    assert.equal(resumed.left('reworks'), 2)
    assert.equal(resumed.left('judge'), 1)
    assert.deepEqual(resumed.openGaps(), ['нет проверок', 'ключ API: sk-DO-NOT-STORE'])
    store.dismiss(id(11))
  })

  check('испорченный снимок цикла не даёт ход бесконечных попыток', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(12) })
    assert.equal(run.updateCycle({ spent: { reworks: { used: -9, limit: 99 } }, checks: [{ source: 'луна', verdict: 'pass' }] }), true)
    const found = store.interrupted().find(item => item.runId === id(12))
    assert.equal(found.cycle.spent.reworks.used, 0)
    assert.deepEqual(found.cycle.checks, [])
    assert.equal(continuationPrompt(found).includes('Осталось попыток'), true)
    store.dismiss(id(12))
  })

  // Привязка к моду переживает перезапуск как публичные id, чтобы продолжение
  // заново проверило пакет, навык, чат и ревизию; токен и текст навыка — нет.
  check('привязка к моду переживает падение, но токен и инструкция туда не попадают', () => {
    const store = createCheckpointStore({ dir })
    store.start({ runId: id(14), chatId: 'mod-chat', ask: 'проверь',
      mod: { modId: 'onlyone.project-checks', panelId: 'checks', buttonId: 'test', statusHash: 'h1',
        revision: 3, chatId: 'mod-chat', skillId: 'PRIVATE SKILL', token: 'PREVIEW TOKEN', extra: 'DROP' } })
    const found = store.interrupted().find(item => item.runId === id(14))
    assert.deepEqual(found.mod, { modId: 'onlyone.project-checks', panelId: 'checks', buttonId: 'test',
      chatId: 'mod-chat', revision: 3, statusHash: 'h1' })
    const raw = fs.readFileSync(path.join(dir, `${id(14)}.json`), 'utf8')
    assert.equal(raw.includes('PREVIEW TOKEN'), false, 'preview token never reaches the checkpoint')
    assert.equal(raw.includes('PRIVATE SKILL'), false, 'skill text never reaches the checkpoint')
    store.start({ runId: id(15), mod: { modId: 'broken' } })
    assert.equal(store.interrupted().find(item => item.runId === id(15)).mod, null,
      'a binding without a panel is ignored')
    store.dismiss(id(14)); store.dismiss(id(15))
  })

  // Продолжение падает тоже: третий старт обязан помнить сделанное с самого
  // первого хода, иначе «не повторяй подтверждённое» держится ровно один
  // перезапуск.
  check('подтверждённые действия наследуются через второй перезапуск', () => {
    const store = createCheckpointStore({ dir })
    const first = store.start({ runId: id(13), ask: 'доведи до конца' })
    first.begin('write_file', { path: 'src/a.js' }).end('done')
    first.begin('run_command', { command: 'npm test' })   // упал посреди команды
    const afterFirst = store.interrupted().find(item => item.runId === id(13))
    assert.equal(afterFirst.done.length, 1)
    assert.equal(afterFirst.unknown.length, 1)
    store.dismiss(id(13))

    const second = store.start({ runId: id(14), ask: 'доведи до конца',
      carried: [...afterFirst.done, ...afterFirst.failed, ...afterFirst.unknown] })
    second.begin('write_file', { path: 'src/b.js' }).end('done')
    const afterSecond = store.interrupted().find(item => item.runId === id(14))
    assert.deepEqual(afterSecond.done.map(item => item.target).sort(), ['src/a.js', 'src/b.js'],
      'сделанное первым ходом осталось в описи второго')
    assert.deepEqual(afterSecond.unknown.map(item => item.target), ['npm test'],
      'неизвестный исход наследуется и после второго падения всё ещё требует проверки')
    const prompt = continuationPrompt(afterSecond)
    assert.match(prompt, /Уже сделано — не повторяй:[\s\S]*src\/a\.js[\s\S]*src\/b\.js/)
    assert.match(prompt, /Сначала проверь[\s\S]*npm test/)
    store.dismiss(id(14))
  })

  check('файл сообщает, дошёл ли он до диска', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(15) })
    assert.equal(run.saved(), true)
    run.close()
    assert.equal(run.saved(), false, 'закрытый ход не считается сохранённым')
  })

  check('недоступный диск не роняет ход', () => {
    const blocker = path.join(dir, 'файл-вместо-папки')
    fs.writeFileSync(blocker, '')
    const store = createCheckpointStore({ dir: blocker })
    const run = store.start({ runId: id(9) })
    assert.doesNotThrow(() => run.begin('write_file', { path: 'x' }).end('done'))
    assert.deepEqual(store.interrupted(), [])
  })

  // ─── адресные регрессии к находкам харнесса resume-restart (24.09) ──────

  check('незнакомый статус действия не исчезает, а ждёт проверки', () => {
    // Файл мог остаться с версии, где статусов больше, или быть поправленым
    // соседним процессом. Молча выбросить такое действие — значит разрешить
    // продолжению повторить его вслепую.
    const store = createCheckpointStore({ dir })
    fs.writeFileSync(path.join(dir, `${id(16)}.json`), JSON.stringify({
      schemaVersion: 1, runId: id(16),
      actions: [{ tool: 'write_file', target: 'a.js', status: 'какой-то-новый-статус' },
        { tool: 'run_command', target: 'npm test' },
        { tool: 'rm_tree', target: 'b', status: 'done' }]
    }))
    const [found] = store.interrupted()
    assert.equal(found.done.map(a => a.tool).join(), 'rm_tree')
    assert.equal(found.unknown.map(a => a.tool).join(), 'write_file,run_command',
      'действие с незнакомым статусом пропало из описи')
    assert.match(continuationPrompt(found), /Сначала проверь[\s\S]*write_file: a\.js/)
    store.dismiss(id(16))
  })

  check('токен в цели и в просьбе не ложится на диск открытым текстом', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(17), ask: 'Залей по адресу https://api.example/v1?token=СЕКРЕТ-ТОКЕН-9f8e7d6c и собери' })
    run.begin('set_webhook', { url: 'https://api.example/cb?key=СЕКРЕТ-КЛЮЧ-1a2b3c&x=1' })
    run.begin('run_command', { command: 'curl -H "Authorization: Bearer abcdef123456ABCDEF" https://api.example/me' })
    const raw = fs.readFileSync(path.join(dir, `${id(17)}.json`), 'utf8')
    for (const secret of ['СЕКРЕТ-ТОКЕН-9f8e7d6c', 'СЕКРЕТ-КЛЮЧ-1a2b3c', 'abcdef123456ABCDEF']) {
      assert.equal(raw.includes(secret), false, `на диске остался «${secret}»`)
    }
    const [found] = store.interrupted()
    assert.match(found.ask, /https:\/\/api\.example\/v1\?token=\*\*\*/, 'просьба перестала быть читаемой вовсе')
    const targets = found.unknown.map(a => a.target)
    assert.match(targets[0], /\?key=\*\*\*&x=1/, `обычный параметр в цели задевать нельзя: ${targets[0]}`)
    assert.match(targets[1], /Authorization: Bearer \*\*\*/, `заголовок не закрыт: ${targets[1]}`)
    store.dismiss(id(17))
  })

  check('обычная просьба и обычная команда доходят дословно', () => {
    // Маска не должна съедать текст: по описи человек решает, что продолжать.
    const store = createCheckpointStore({ dir })
    const ask = 'Собери лендинг про пальмы, ключевые файлы не трогай, token_count = 5'
    const run = store.start({ runId: id(18), ask })
    run.begin('write_file', { path: 'site/index.html' })
    run.begin('run_command', { command: 'npm test && npm run build' })
    const [found] = store.interrupted()
    assert.equal(found.ask, ask)
    assert.deepEqual(found.unknown.map(a => a.target), ['site/index.html', 'npm test && npm run build'])
    store.dismiss(id(18))
  })

  check('остаток попыток считается от LIMITS, а не от limit в файле', () => {
    // Файл переживает версии программы и правки соседним процессом. Ровно так
    // же делает createCycle при восстановлении: опись и исполнение не расходятся.
    const { LIMITS } = require('../src/main/agent-cycle')
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(19) })
    run.updateCycle({ schemaVersion: 1, spent: { reworks: { used: 1, limit: 999 }, judge: { used: 0, limit: 999 }, rounds: { used: 2, limit: 999 } } })
    const [found] = store.interrupted()
    assert.equal(found.cycle.spent.reworks.limit, 999, 'файл должны были читать как есть')
    const text = continuationPrompt(found)
    assert.match(text, new RegExp(`доработка ${LIMITS.reworks - 1}, независимых проверок ${LIMITS.judge}`), text)
    assert.equal(/доработка 9\d\d|998/.test(text), false, 'опись обещает попытки, которых нет')
    // предельный случай: потрачено больше предела — остаток нулевой, не отрицательный
    run.updateCycle({ schemaVersion: 1, spent: { reworks: { used: 40, limit: 999 } } })
    assert.match(continuationPrompt(store.interrupted()[0]), /доработка 0,/)
    store.dismiss(id(19))
  })

  check('с шифром просьба не читается на диске и возвращается при чтении', () => {
    // Так контрольная точка будет храниться, когда главный процесс передаст
    // пару protect/unprotect (safeStorage). Без неё остаётся вычищение по
    // форме, и оно тоже проверено выше.
    const vault = new Map()
    const store = createCheckpointStore({
      dir,
      protect: text => { const tag = `шифр-${vault.size + 1}`; vault.set(tag, text); return tag },
      unprotect: tag => vault.get(tag) || ''
    })
    const ask = 'Токен ghp_AAAAAAAAAAAAAAAA положил в файл'
    const run = store.start({ runId: id(20), ask })
    run.begin('write_file', { path: 'a.txt' })
    const raw = fs.readFileSync(path.join(dir, `${id(20)}.json`), 'utf8')
    assert.equal(raw.includes('ghp_AAAAAAAAAAAAAAAA'), false)
    assert.equal(raw.includes('Токен'), false, 'текст просьбы должен лежать шифром')
    assert.match(JSON.parse(raw).ask, /^enc:v1:/)
    const [found] = store.interrupted()
    assert.equal(found.ask, 'Токен *** положил в файл', 'шифр обязан возвращаться, но и он проходит вычищение')
    store.dismiss(id(20))
    // прежний файл без шифра читается как есть
    fs.writeFileSync(path.join(dir, `${id(21)}.json`), JSON.stringify({ schemaVersion: 1, runId: id(21), ask: 'старая версия без шифра', actions: [] }))
    assert.equal(store.interrupted()[0].ask, 'старая версия без шифра')
    store.dismiss(id(21))
  })

  // ─── АГ-8, И-1: состояние задачи живёт в том же файле контрольной точки ───

  check('требования и доказательства лежат в файле хода и переживают падение', () => {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId: id(30), ask: 'доведи' })
    run.syncPlan([{ id: 'a', title: 'Отмена запроса', status: 'doing' }], 0)
    const action = run.begin('write_file', { path: 'src/cancel.js' })
    action.end('done')
    run.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
    const [found] = store.interrupted()
    assert.equal(found.task.requirements[0].state, 'in_progress')
    assert.equal(found.task.evidence.length, 1)
    assert.equal(found.task.actions[0].requirementId, 'plan:0:a')
    assert.match(found.task.actions[0].id, new RegExp(`^${id(30).slice(0, 8)}\\.`))
    store.dismiss(id(30))
  })

  check('продолжение наследует состояние: выполненное цело, начатое — неизвестное, подтверждение перепроверяется', () => {
    const store = createCheckpointStore({ dir })
    const first = store.start({ runId: id(31), ask: 'доведи' })
    first.syncPlan([{ id: 'a', title: 'A', status: 'done' }], 0)
    first.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
    first.begin('run_command', { command: 'node migrate.js' })
    const found = store.interrupted().find(item => item.runId === id(31))
    const second = store.start({ runId: id(32), ask: 'доведи', carriedTask: found.task })
    const snap = second.snapshot().task
    assert.equal(snap.requirements[0].state, 'stale')
    assert.ok(snap.requirements[0].history.some(entry => entry.to === 'confirmed'))
    assert.equal(snap.actions[0].status, 'unknown')
    const refused = second.admit('run_command', { command: 'node migrate.js' })
    assert.equal(refused.allowed, false)
    assert.equal(second.admit('run_command', { command: 'node migrate.js' }).allowed, true, 'после предупреждения решение за моделью')
    assert.match(continuationPrompt(store.interrupted().find(item => item.runId === id(31))),
      /Требования задачи:\n- \[подтверждено\] A/)
    store.dismiss(id(31)); store.dismiss(id(32))
  })

  check('текст требования шифруется, секрет в нём вычищен', () => {
    const vault = new Map()
    const store = createCheckpointStore({ dir,
      protect: text => { const tag = `шифр-${vault.size + 1}`; vault.set(tag, text); return tag },
      unprotect: tag => vault.get(tag) || '' })
    const run = store.start({ runId: id(33) })
    run.syncPlan([{ id: 'a', title: 'Положить токен ghp_AAAAAAAAAAAAAAAA в файл', status: 'todo' }], 0)
    const raw = fs.readFileSync(path.join(dir, `${id(33)}.json`), 'utf8')
    assert.equal(raw.includes('ghp_AAAAAAAAAAAAAAAA'), false)
    assert.equal(raw.includes('Положить'), false, 'текст требования лежит открытым')
    const [found] = store.interrupted()
    assert.match(found.task.requirements[0].expected, /Положить токен \*\*\* в файл/)
    store.dismiss(id(33))
  })

  check('чтение цели снимает неизвестный исход; не записанное на диск действие не попадает в состояние', () => {
    const store = createCheckpointStore({ dir })
    const first = store.start({ runId: id(34) })
    first.begin('write_file', { path: 'a.js' })
    const found = store.interrupted().find(item => item.runId === id(34))
    const run = store.start({ runId: id(35), carriedTask: found.task })
    assert.equal(run.observe({ path: 'a.js' }), 1)
    assert.equal(run.snapshot().task.actions.filter(item => item.status === 'unknown' && !item.resolution).length, 0)
    store.dismiss(id(34)); store.dismiss(id(35))
  })

  check('возврат ключа восстанавливает expected и criterion симметрично (новый main Н1)', () => {
    // Требование, пережившее «чужой ключ»: в записи стоят заглушка LOST_TEXT и
    // обнулённый criterion, а настоящие шифры несут expectedSealed/criterionSealed.
    const SEALED = 'enc:v1:'
    const prot = t => 'P' + t
    const unprot = tag => (typeof tag === 'string' && tag.startsWith('P') ? tag.slice(1) : '')
    const runId = id(36)
    const data = {
      schemaVersion: 1, runId, requestId: '', chatId: null, designId: null, surface: 'chat',
      ask: SEALED + prot('исходная просьба'), mod: null, startedAt: 1, updatedAt: 2, context: null, cycle: null,
      actions: [], droppedActions: 0,
      task: {
        requirements: [{ id: 'r.e1', expected: 'Текст требования не прочитан: не подошёл ключ профиля', criterion: '',
          required: true, dependsOn: null, origin: 'plan', agentIndex: 0, state: 'stale', unreadable: true,
          expectedSealed: SEALED + prot('ОЖИДАНИЕ'), criterionSealed: SEALED + prot('КРИТЕРИЙ'),
          history: [], createdAt: 1, updatedAt: 1 }],
        evidence: [], inputs: {}, budget: null
      }
    }
    fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(data))
    let req = createCheckpointStore({ dir, protect: prot, unprotect: unprot }).interrupted()[0].task.requirements[0]
    assert.equal(req.expected, 'ОЖИДАНИЕ', 'expected не восстановился')
    assert.equal(req.criterion, 'КРИТЕРИЙ', 'criterion потерян, хотя criterionSealed лежит на диске')
    // Контроль: то же требование, но не проходившее unreadable-ветку (шифр прямо в полях).
    const ctrlId = id(37)
    fs.writeFileSync(path.join(dir, `${ctrlId}.json`), JSON.stringify({ ...data, runId: ctrlId,
      task: { requirements: [{ id: 'r.e1', expected: SEALED + prot('ОЖИДАНИЕ'), criterion: SEALED + prot('КРИТЕРИЙ'),
        required: true, dependsOn: null, origin: 'plan', agentIndex: 0, state: 'in_progress',
        history: [], createdAt: 1, updatedAt: 1 }], evidence: [], inputs: {}, budget: null } }))
    req = createCheckpointStore({ dir, protect: prot, unprotect: unprot }).interrupted()[0].task.requirements[0]
    assert.equal(req.expected, 'ОЖИДАНИЕ')
    assert.equal(req.criterion, 'КРИТЕРИЙ', 'обычная ветка перестала читать criterion')
    fs.rmSync(path.join(dir, `${runId}.json`), { force: true })
    fs.rmSync(path.join(dir, `${ctrlId}.json`), { force: true })
  })

  check('недоступный шифр: просьба не помечается шифром и читается после его возврата (sec Н1)', () => {
    // Ровно живая обвязка main.js: при недоступном safeStorage protect отдаёт вход как есть.
    const runId = id(38)
    const offline = createCheckpointStore({ dir, protect: text => text, unprotect: text => text })
    const run = offline.start({ runId, ask: 'почини деплой и пришли ответ' })
    run.begin('run_command', { command: 'npm publish' })
    const raw = () => JSON.parse(fs.readFileSync(path.join(dir, `${runId}.json`), 'utf8')).ask
    assert.equal(raw().startsWith('enc:v1:'), false, 'открытые байты помечены как шифр')
    // Миграция прежнего файла при недоступном шифре тоже не должна клеить метку.
    offline.interrupted()
    assert.equal(raw().startsWith('enc:v1:'), false, 'миграция переклеила открытое в шифр')
    // Следующий запуск, когда шифр вернулся: просьба читается, а не «не прочитано».
    const vault = new Map()
    const online = createCheckpointStore({ dir,
      protect: text => { const tag = `шифр-${vault.size + 1}`; vault.set(tag, text); return tag },
      unprotect: tag => vault.get(tag) || '' })
    const [found] = online.interrupted()
    assert.equal(found.askUnreadable, false, 'просьба потеряна на пути временного сбоя шифра')
    assert.match(found.ask, /почини деплой/)
    online.dismiss(runId)
  })

  check('main.js: чек-лист и допуск идут через контрольную точку', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
    assert.match(main, /checkpoint\?\.syncPlan\(/, 'task_plan не заводит требования')
    assert.match(main, /carriedTask: resumed/, 'продолжение не наследует состояние')
    const admitAt = main.indexOf('payload.checkpoint?.admit(')
    const beginAt = main.indexOf('payload.checkpoint?.begin(toolName')
    assert.ok(admitAt > 0 && admitAt < beginAt, 'допуск должен стоять до записи «начато»')
  })
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
