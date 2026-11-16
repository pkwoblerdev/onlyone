'use strict'
// АГ-8, И-1: состояние задачи. Требование подтверждает приложение по
// доказательству со свежей версией входов, а не модель своим «готово».
// Изменение входа отзывает подтверждение, но историю не стирает. После
// перезапуска действие с неизвестным исходом сверяется, а не повторяется вслепую.
const assert = require('node:assert/strict')
const { createTaskState, cleanTaskState, STATES } = require('../src/main/task-state.cjs')

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}
let clock = 1000
const now = () => ++clock
const fresh = (options = {}) => createTaskState({ now, idPrefix: 'r1', ...options })

check('состояния требования — ровно из плана', () => {
  assert.deepEqual(STATES, ['not_started', 'in_progress', 'verifying', 'confirmed', 'stale', 'blocked', 'cancelled'])
})

check('заявление модели не подтверждает требование', () => {
  const task = fresh()
  task.require({ id: 'cancel', expected: 'Кнопка отмены прерывает запрос', criterion: 'тест отмены зелёный' })
  assert.equal(task.get('cancel').state, 'not_started')
  assert.equal(task.get('cancel').required, true, 'обязательность по умолчанию')
  assert.equal(task.move('cancel', 'in_progress').ok, true)
  assert.equal(task.move('cancel', 'verifying').ok, true)
  assert.equal(task.move('cancel', 'confirmed').ok, false, 'подтверждение только по доказательству')
  assert.equal(task.addEvidence({ source: 'claim', verdict: 'pass' }), null, 'слово модели — не источник доказательства')
  assert.equal(task.get('cancel').state, 'verifying')
  assert.equal(task.complete(), false)
})

check('доказательство со свежими входами подтверждает, остаток пуст', () => {
  const task = fresh()
  task.require({ id: 'a', expected: 'A' })
  task.move('a', 'in_progress'); task.move('a', 'verifying')
  const evidence = task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  assert.ok(evidence.id && evidence.at > 0, 'у доказательства есть id и время')
  assert.deepEqual(evidence.inputs, { workspace: 0 }, 'доказательство помнит версию входов')
  assert.equal(task.get('a').state, 'confirmed')
  assert.equal(task.get('a').confirmedBy, evidence.id)
  assert.equal(task.complete(), true)
  assert.deepEqual(task.remainder().open, [])
})

check('изменение входа отзывает подтверждение, история и доказательство остаются', () => {
  const task = fresh()
  task.require({ id: 'a', expected: 'A' })
  task.move('a', 'in_progress'); task.move('a', 'verifying')
  const first = task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  task.bumpInput('workspace')
  const req = task.get('a')
  assert.equal(req.state, 'stale')
  assert.ok(req.history.some(entry => entry.to === 'confirmed' && entry.evidenceId === first.id), 'подтверждение стёрто из истории')
  assert.ok(req.history.some(entry => entry.to === 'stale' && /workspace 0→1/.test(entry.reason)), 'нет причины отзыва')
  assert.equal(task.snapshot().evidence.length, 1, 'старое доказательство не удалено')
  assert.equal(task.complete(), false)
  // Старое доказательство не греет: оно о прежней версии входов.
  task.move('a', 'verifying')
  assert.equal(task.get('a').state, 'verifying')
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  assert.equal(task.get('a').state, 'confirmed')
})

check('зависимость названа — чужой вход не трогает; карта неизвестна — перепроверка консервативна', () => {
  const task = fresh()
  task.require({ id: 'spec', expected: 'по спецификации', dependsOn: ['spec'] })
  task.require({ id: 'any', expected: 'без карты зависимостей' })
  for (const id of ['spec', 'any']) { task.move(id, 'in_progress'); task.move(id, 'verifying') }
  task.setInput('spec', 'v1')
  task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'сверено со спецификацией' })
  assert.equal(task.get('spec').state, 'confirmed')
  assert.equal(task.get('any').state, 'confirmed')
  task.bumpInput('workspace')
  assert.equal(task.get('spec').state, 'confirmed', 'вход не из зависимостей отозвал подтверждение')
  assert.equal(task.get('any').state, 'stale', 'неизвестная карта зависимостей не перепроверена')
  task.setInput('spec', 'v2')
  assert.equal(task.get('spec').state, 'stale')
})

check('провал проверки по конкретному требованию возвращает его в работу', () => {
  const task = fresh()
  task.require({ id: 'a', expected: 'A' })
  task.move('a', 'in_progress'); task.move('a', 'verifying')
  task.addEvidence({ source: 'judge', verdict: 'fail', requirementIds: ['a'], coverage: 'судья: кнопка не видна' })
  assert.equal(task.get('a').state, 'in_progress')
})

check('агент не удаляет обязательное и не облегчает условие', () => {
  const task = fresh()
  task.require({ id: 'a', expected: 'Полный отчёт', criterion: 'все разделы' })
  assert.equal(task.move('a', 'cancelled').ok, false, 'агент отменил обязательное требование')
  task.require({ id: 'a', expected: 'Короткий отчёт', criterion: '', required: false })
  assert.equal(task.get('a').expected, 'Полный отчёт')
  assert.equal(task.get('a').criterion, 'все разделы')
  assert.equal(task.get('a').required, true)
  assert.equal(task.move('a', 'cancelled', { by: 'human' }).ok, true)
  assert.equal(task.move('a', 'in_progress', { by: 'human' }).ok, false, 'отменённое не оживает')
  assert.deepEqual(task.remainder().open, [])
})

check('действие: id, начало, результат; неподтверждённая остановка — неизвестный исход', () => {
  const task = fresh()
  const a = task.beginAction({ tool: 'run_command', target: 'npm run build' })
  assert.match(a.id, /^r1\.\d+$/)
  assert.equal(a.status, 'started')
  assert.ok(a.startedAt > 0)
  task.endAction(a.id, 'done')
  assert.equal(task.action(a.id).status, 'done')
  assert.ok(task.action(a.id).endedAt >= a.startedAt)
  const b = task.beginAction({ tool: 'run_command', target: 'npm run serve' })
  task.endAction(b.id, 'failed', { unconfirmed: true })
  assert.equal(task.action(b.id).status, 'unknown', 'интерфейс остановил, а процесс — неизвестно')
})

check('выполненное переживает перезапуск, начатое становится неизвестным', () => {
  const first = fresh()
  first.require({ id: 'a', expected: 'A' })
  first.move('a', 'in_progress'); first.move('a', 'verifying')
  first.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  const done = first.beginAction({ tool: 'write_file', target: 'a.js' })
  first.endAction(done.id, 'done')
  const disk = JSON.parse(JSON.stringify(first.snapshot()))
  const second = createTaskState({ now, idPrefix: 'r2', restored: cleanTaskState(disk) })
  assert.equal(second.get('a').state, 'confirmed', 'без неизвестных исходов подтверждение не теряется')
  assert.equal(second.action(done.id).status, 'done')
  assert.equal(second.action(done.id).carried, true)
  const next = second.beginAction({ tool: 'write_file', target: 'b.js' })
  assert.match(next.id, /^r2\./, 'новые id не сталкиваются с унаследованными')
})

check('неизвестный исход после сбоя: подтверждения перепроверяются', () => {
  const first = fresh()
  first.require({ id: 'a', expected: 'A' })
  first.move('a', 'in_progress'); first.move('a', 'verifying')
  first.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  first.beginAction({ tool: 'run_command', target: 'node migrate.js' }) // процесс умер здесь
  const second = createTaskState({ now, idPrefix: 'r2', restored: cleanTaskState(first.snapshot()) })
  assert.equal(second.remainder().unknownActions.length, 1)
  assert.equal(second.remainder().unknownActions[0].status, 'unknown')
  assert.equal(second.get('a').state, 'stale', 'действие с неизвестным исходом могло изменить входы')
  assert.ok(second.get('a').history.some(entry => entry.to === 'confirmed'), 'история подтверждения стёрта')
})

check('повтор действия с неизвестным исходом не проходит вслепую', () => {
  const first = fresh()
  first.beginAction({ tool: 'run_command', target: 'npm publish' })
  const task = createTaskState({ now, idPrefix: 'r2', restored: cleanTaskState(first.snapshot()) })
  const [unknown] = task.remainder().unknownActions
  assert.equal(task.admit({ tool: 'run_command', target: 'npm test' }).allowed, true, 'другое действие не держим')
  const refused = task.admit({ tool: 'run_command', target: 'npm publish' })
  assert.equal(refused.allowed, false)
  assert.equal(refused.actionId, unknown.id)
  assert.match(refused.reason, /неизвест/i)
  assert.match(refused.reason, /провер/i)
  // Предупреждение записано в состоянии и переживает ещё один перезапуск.
  const again = createTaskState({ now, idPrefix: 'r3', restored: cleanTaskState(task.snapshot()) })
  const second = again.admit({ tool: 'run_command', target: 'npm publish' })
  assert.equal(second.allowed, true, 'после предупреждения решение за моделью')
  const repeat = again.beginAction({ tool: 'run_command', target: 'npm publish' })
  assert.equal(again.action(unknown.id).resolution, 'repeated')
  assert.equal(again.action(unknown.id).resolvedBy, repeat.id)
  assert.equal(again.remainder().unknownActions.length, 0)
})

check('наблюдение цели сверяет неизвестный исход без отказа', () => {
  const first = fresh()
  first.beginAction({ tool: 'write_file', target: 'src/a.js' })
  const task = createTaskState({ now, idPrefix: 'r2', restored: cleanTaskState(first.snapshot()) })
  assert.equal(task.observe('src/b.js'), 0)
  assert.equal(task.observe('src/a.js'), 1)
  assert.equal(task.remainder().unknownActions.length, 0)
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js' }).allowed, true)
})

check('чек-лист модели заводит требования; «сделано» = проверяется', () => {
  const task = fresh()
  task.syncPlan([
    { id: 'p1', title: 'Сверстать форму', detail: 'форма открывается', status: 'done' },
    { id: 'p2', title: 'Отправка формы', status: 'doing' },
    { id: 'p3', title: 'Письмо подтверждения', status: 'blocked' },
    { id: 'p4', title: 'Документация', status: 'todo' }
  ], 0)
  const states = Object.fromEntries(task.snapshot().requirements.map(item => [item.id, item.state]))
  assert.deepEqual(states, { 'plan:0:p1': 'verifying', 'plan:0:p2': 'in_progress', 'plan:0:p3': 'blocked', 'plan:0:p4': 'not_started' })
  assert.equal(task.get('plan:0:p1').criterion, 'форма открывается')
  // Модель переписала список без пункта — требование остаётся в остатке.
  task.syncPlan([{ id: 'p1', title: 'Сверстать форму', status: 'done' }], 0)
  assert.equal(task.get('plan:0:p4').state, 'not_started')
  assert.ok(task.remainder().open.some(item => item.id === 'plan:0:p4'))
  // Действие привязывается к требованию, которое агент сейчас выполняет.
  assert.equal(task.beginAction({ tool: 'write_file', target: 'send.js', agentIndex: 0 }).requirementId, 'plan:0:p2')
})

// Б-7, остаток «параллельные задачи». Требования разных агентов живут в одном
// состоянии, но доказательство у каждой задачи своё: зелёный тест помощника не
// доказывает часть ведущего (и наоборот — помощника доказывает только его
// проверка или интеграционная проверка ведущего). Иначе две задачи, одна
// закрытая и проверенная, вторая нет, сдаются общим «готово».
check('зелёная проверка помощника не подтверждает часть ведущего', () => {
  const task = fresh()
  task.syncPlan([{ id: 'lead', title: 'Ведущий: кнопка отмены', status: 'done' }], 0)
  task.syncPlan([{ id: 'help', title: 'Помощник: выложить обновление', status: 'done' }], 1)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 1 })
  assert.equal(task.get('plan:1:help').state, 'confirmed', 'своя проверка не подтвердила свою часть')
  assert.equal(task.get('plan:0:lead').state, 'verifying', 'чужая зелёная проверка подтвердила часть ведущего')
  assert.equal(task.complete(), false, 'общий «готово» при неподтверждённой параллельной задаче')
  assert.ok(task.remainder().open.some(item => item.id === 'plan:0:lead'))
})

check('интеграционная проверка ведущего подтверждает части помощников', () => {
  const task = fresh()
  task.syncPlan([{ id: 'lead', title: 'Ведущий: кнопка отмены', status: 'done' }], 0)
  task.syncPlan([{ id: 'help', title: 'Помощник: выложить обновление', status: 'done' }], 1)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 0 })
  assert.equal(task.get('plan:1:help').state, 'confirmed', 'проверка ведущего перестала быть интеграционной')
  assert.equal(task.complete(), true)
})

check('доказательство записывается за агентом, чьё действие его добыло', () => {
  const task = fresh()
  task.syncPlan([{ id: 'part', title: 'Часть помощника', status: 'doing' }], 2)
  // Команда-проверка закрывает только сделанную часть: сначала работа по пункту.
  const work = task.beginAction({ tool: 'write_file', target: 'src/part.js', agentIndex: 2 })
  task.endAction(work.id, 'done')
  task.syncPlan([{ id: 'part', title: 'Часть помощника', status: 'done' }], 2)
  const action = task.beginAction({ tool: 'run_command', target: 'npm test', agentIndex: 2, verification: true })
  const proof = task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', actionId: action.id })
  assert.equal(proof.agentIndex, 2, 'доказательство приписано не тому агенту')
  assert.equal(task.get('plan:2:part').state, 'confirmed')
})

check('остаток и готовность считаются по своей задаче, а у ведущего — по всем', () => {
  const task = fresh()
  task.syncPlan([{ id: 'mine', title: 'Моя часть', status: 'done' }], 1)
  task.syncPlan([{ id: 'theirs', title: 'Часть ведущего', status: 'doing' }], 0)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 1 })
  assert.equal(task.complete(1), true, 'помощника держит чужая незакрытая часть')
  assert.deepEqual(task.remainder(1).open, [])
  assert.equal(task.complete(), false, 'у ведущего общий итог не запрещён')
  assert.ok(task.remainder().open.some(item => item.id === 'plan:0:theirs'))
})

check('свежая проверка до заявления подтверждает сразу', () => {
  const task = fresh()
  task.syncPlan([{ id: 'p1', title: 'A', status: 'doing' }], 0)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test' })
  assert.equal(task.get('plan:0:p1').state, 'in_progress', 'невзятое на проверку не подтверждается')
  task.syncPlan([{ id: 'p1', title: 'A', status: 'done' }], 0)
  assert.equal(task.get('plan:0:p1').state, 'confirmed', 'входы не менялись — доказательство свежее')
})

check('простая задача без требований идёт коротким путём', () => {
  const task = fresh()
  assert.equal(task.complete(), null)
  assert.deepEqual(task.remainder(), { open: [], claimed: [], stale: [], blocked: [], unknownActions: [] })
})

check('повтор A → B → A без новых оснований распознаётся как цикл, предупреждение одно', () => {
  const task = fresh()
  const a = task.beginAction({ tool: 'write_file', target: 'src/a.js' })
  task.endAction(a.id, 'done')
  const b = task.beginAction({ tool: 'write_file', target: 'src/b.js' })
  task.endAction(b.id, 'done')
  const refused = task.admit({ tool: 'write_file', target: 'src/a.js' })
  assert.equal(refused.allowed, false, 'цикл A → B → A пропущен')
  assert.equal(refused.cycle, true)
  assert.equal(refused.actionId, a.id, 'цикл обязан называть прежнее действие')
  assert.match(refused.reason, /A → B → A|цикл/i, 'причина не названа')
  assert.match(refused.reason, /основани/i, 'не сказано, чего не хватает')
  // Предупреждение одно: осознанный повтор после него не держим.
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js' }).allowed, true, 'решение модели после предупреждения')
})

check('новое доказательство — основание: повтор после проверки не цикл', () => {
  const task = fresh()
  const a = task.beginAction({ tool: 'write_file', target: 'src/a.js' })
  task.endAction(a.id, 'done')
  const b = task.beginAction({ tool: 'write_file', target: 'src/b.js' })
  task.endAction(b.id, 'done')
  task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'b.js содержит ожидаемое' })
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js' }).allowed, true, 'новое наблюдение — основание повтора')
})

check('прямой повтор A → A и цикл другого исполнителя циклом не считаются', () => {
  const task = fresh()
  const a = task.beginAction({ tool: 'write_file', target: 'src/a.js' })
  task.endAction(a.id, 'done')
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js' }).allowed, true, 'между A нет другой работы — это не A → B → A')
  const helper = task.beginAction({ tool: 'write_file', target: 'src/b.js', agentIndex: 1 })
  task.endAction(helper.id, 'done')
  const again = task.beginAction({ tool: 'write_file', target: 'src/a.js', agentIndex: 1 })
  task.endAction(again.id, 'done')
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js', agentIndex: 0 }).allowed, true, 'чужой цикл не приписан ведущему')
})

check('цикл виден после перезапуска: основание считается по доказательствам, а не по памяти', () => {
  const first = fresh()
  const a = first.beginAction({ tool: 'write_file', target: 'src/a.js' })
  first.endAction(a.id, 'done')
  const b = first.beginAction({ tool: 'write_file', target: 'src/b.js' })
  first.endAction(b.id, 'done')
  const task = createTaskState({ now, idPrefix: 'r3', restored: cleanTaskState(first.snapshot()) })
  const refused = task.admit({ tool: 'write_file', target: 'src/a.js' })
  assert.equal(refused.allowed, false, 'после перезапуска цикл забыт')
  assert.equal(refused.actionId, a.id)
})

check('адресный отзыв: зависимый вход отзывает только своё требование', () => {
  const task = fresh()
  task.require({ id: 'api', expected: 'API отвечает', dependsOn: ['api'] })
  task.require({ id: 'ui', expected: 'Кнопка видна', dependsOn: ['ui'] })
  for (const id of ['api', 'ui']) { task.move(id, 'in_progress'); task.move(id, 'verifying') }
  task.setInput('api', 'v1')
  task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'оба требования сверены' })
  assert.equal(task.get('api').state, 'confirmed')
  assert.equal(task.get('ui').state, 'confirmed')
  task.setInput('api', 'v2')
  assert.equal(task.get('api').state, 'stale', 'зависимый вход не отозвал подтверждение')
  assert.equal(task.get('ui').state, 'confirmed', 'чужой вход отозвал подтверждение')
  assert.ok(task.get('api').history.some(entry => entry.to === 'stale' && /api v1→v2/.test(entry.reason)), 'причина отзыва не адресная')
})

check('файл с диска пересобирается по белому списку', () => {
  const clean = cleanTaskState({
    schemaVersion: 1,
    requirements: [
      { id: 'ok', expected: 'A', state: 'confirmed', confirmedBy: 'e-missing', history: [] },
      { id: 'moon', expected: 'B', state: 'луна', history: [{ from: 'x', to: 'y' }] },
      { id: '', expected: 'C', state: 'not_started' },
      { id: 'big', expected: 'D', state: 'not_started', history: Array.from({ length: 90 }, () => ({ from: 'not_started', to: 'in_progress', at: 1 })) }
    ],
    evidence: [{ id: 'e1', source: 'claim', verdict: 'pass', inputs: {} }, { id: 'e2', source: 'command', verdict: 'pass', inputs: { workspace: 2 }, apiKey: 'DROP' }],
    inputs: { workspace: 2, 'bad name with spaces': 3 },
    actions: [{ id: 'r1.1', tool: 'write_file', target: 'a', status: 'новый-статус' }],
    secret: 'DROP'
  })
  const byId = Object.fromEntries(clean.requirements.map(item => [item.id, item]))
  assert.equal(byId.ok.state, 'stale', 'подтверждение без доказательства в файле не принимается')
  assert.equal(byId.moon.state, 'stale', 'незнакомое состояние — перепроверить, а не считать сделанным')
  assert.equal(byId[''], undefined)
  assert.ok(byId.big.history.length <= 20)
  assert.deepEqual(clean.evidence.map(item => item.id), ['e2'])
  assert.equal(JSON.stringify(clean).includes('DROP'), false)
  assert.deepEqual(clean.inputs, { workspace: 2 })
  assert.equal(clean.actions[0].status, 'unknown', 'незнакомый статус — неизвестный исход')
  assert.equal(cleanTaskState(null), null)
})

if (failures.length) {
  console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
