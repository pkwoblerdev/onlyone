'use strict'
// АГ-8, И-4: настройки бюджета задачи и его состояние в Desk.
//
// Проверки держат три правила: настройки проверяются явно (без «тихого нуля»),
// смена настроек не обнуляет начатую задачу и не расширяет сохранённый бюджет,
// а вид показывает потраченное, резервы, неизвестный расход, срок и причину
// остановки из checkpoint.budget()/task-state, не заводя второй счётчик.
const assert = require('node:assert/strict')
const { createTaskBudget } = require('../src/main/task-budget.cjs')
const settingsLib = require('../src/main/budget-settings.cjs')
const viewLib = require('../src/renderer/budget-desk.js')

let checks = 0
const failures = []
function check (name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const BASE = 1_700_000_000_000
const DEFAULTS = settingsLib.DEFAULT_SETTINGS

function snapshotWithActivity () {
  const budget = createTaskBudget({
    limits: { requests: 10, tokens: 1000 },
    deadlineAt: BASE + 60 * 60 * 1000,
    now: () => BASE
  })
  budget.reserve({ id: 'r1', requests: 1, tokens: 300 })
  budget.settle({ id: 'r1', usage: { total_tokens: 250 }, elapsedMs: 120 })
  // Активный резерв: запрос в пути, в потраченном его ещё нет.
  budget.reserve({ id: 'r2', requests: 1, tokens: 200 })
  // Неизвестный расход: запрос состоялся, токенов провайдер не назвал.
  budget.reserve({ id: 'u1', requests: 1, tokens: 100 })
  budget.settle({ id: 'u1', usage: null, outcome: 'failed' })
  return budget.snapshot()
}

check('настройки: значения по умолчанию явные и полные', () => {
  const checked = settingsLib.normalizeBudgetSettings()
  assert.equal(checked.ok, true)
  assert.deepEqual({ ...checked.settings }, { requests: DEFAULTS.requests, tokens: DEFAULTS.tokens, deadlineMinutes: DEFAULTS.deadlineMinutes })
  assert.ok(Number.isSafeInteger(DEFAULTS.requests) && DEFAULTS.requests > 0)
  assert.ok(Number.isSafeInteger(DEFAULTS.tokens) && DEFAULTS.tokens > 0)
  assert.ok(Number.isSafeInteger(DEFAULTS.deadlineMinutes) && DEFAULTS.deadlineMinutes > 0)
  assert.equal(Object.isFrozen(checked.settings), true, 'настройки обязаны быть неизменяемыми')
})

check('настройки: явные пределы принимаются, null значит «без предела»', () => {
  const explicit = settingsLib.normalizeBudgetSettings({ requests: 12, tokens: 34567, deadlineMinutes: 45 })
  assert.equal(explicit.ok, true)
  assert.deepEqual({ ...explicit.settings }, { requests: 12, tokens: 34567, deadlineMinutes: 45 })
  const noLimits = settingsLib.normalizeBudgetSettings({ requests: null, tokens: null, deadlineMinutes: null })
  assert.equal(noLimits.ok, true)
  assert.equal(noLimits.settings.requests, null)
  assert.equal(noLimits.settings.tokens, null)
  assert.equal(noLimits.settings.deadlineMinutes, null)
})

check('настройки: мусор и ноль отвергаются с названным полем, а не превращаются в ноль', () => {
  const cases = [
    [{ requests: 0 }, 'requests', 'zero'],
    [{ requests: -1 }, 'requests', 'negative'],
    [{ requests: 1.5 }, 'requests', 'not-an-integer'],
    [{ tokens: '500' }, 'tokens', 'not-a-number'],
    [{ tokens: Number.NaN }, 'tokens', 'not-a-number'],
    [{ deadlineMinutes: 0 }, 'deadlineMinutes', 'zero'],
    [{ deadlineMinutes: 10081 }, 'deadlineMinutes', 'out-of-range'],
    [{ requests: 1, extra: 2 }, 'extra', 'unknown']
  ]
  for (const [raw, field, code] of cases) {
    const checked = settingsLib.normalizeBudgetSettings(raw)
    assert.equal(checked.ok, false, `${field}: мусор принят`)
    const error = checked.errors.find(item => item.field === field)
    assert.ok(error, `${field}: нет ошибки`)
    assert.equal(error.code, code, `${field}: ${error.code} вместо ${code}`)
  }
  const broken = settingsLib.normalizeBudgetSettings([1])
  assert.equal(broken.ok, false)
  assert.equal(broken.errors[0].field, 'settings')
  // В хранилище уходит только плоская запись известных полей.
  assert.deepEqual(settingsLib.storeRecord({ requests: 2, tokens: 3, deadlineMinutes: 4 }), { requests: 2, tokens: 3, deadlineMinutes: 4 })
  assert.throws(() => settingsLib.storeRecord({ requests: 0 }), /Неверные настройки/)
})

check('настройки: минуты срока переводятся в абсолютный deadlineAt', () => {
  const plan = settingsLib.budgetTemplate({ requests: 3, tokens: 400, deadlineMinutes: 30 }, BASE)
  assert.deepEqual({ ...plan.limits }, { requests: 3, tokens: 400 })
  assert.equal(plan.deadlineAt, BASE + 30 * 60 * 1000)
  const open = settingsLib.budgetTemplate({ requests: null, tokens: null, deadlineMinutes: null }, BASE)
  assert.equal(open.deadlineAt, null)
  assert.throws(() => settingsLib.budgetTemplate({ requests: 0 }, BASE), /Неверные настройки/)
})

check('смена настроек не сбрасывает задачу и не расширяет сохранённый бюджет', () => {
  const saved = snapshotWithActivity()
  const changed = { requests: 100, tokens: 100_000, deadlineMinutes: 15 }
  const plan = settingsLib.resolveBudget({ settings: changed, saved, now: BASE + 1000 })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'continuation')
  assert.deepEqual({ ...plan.limits }, { requests: 10, tokens: 1000 }, 'продолжение получило новые пределы')
  assert.equal(plan.deadlineAt, BASE + 60 * 60 * 1000, 'продолжение сдвинуло сохранённый срок')
  assert.equal(plan.appliesToCurrent, false)
  // Новая задача получит новые настройки — но только новая.
  assert.deepEqual({ ...plan.next.limits }, { requests: 100, tokens: 100_000 })
  assert.equal(plan.next.deadlineAt, BASE + 1000 + 15 * 60 * 1000)
  // Тот же бюджет, восстановленный по плану, помнит расход: продолжение не
  // начинается с нуля, а активный резерв при восстановлении становится
  // неизвестным исходом (процесс, который его держал, уже умер).
  const resumed = createTaskBudget({ limits: plan.limits, deadlineAt: plan.deadlineAt, restored: saved, now: () => BASE + 1000 })
  const snap = resumed.snapshot()
  assert.ok(snap.used.requests >= saved.used.requests, 'продолжение обнулило потраченные запросы')
  assert.equal(snap.used.tokens, saved.used.tokens)
  assert.ok(snap.unknownUsage >= saved.unknownUsage)
})

check('явное решение меняет пределы текущей задачи, но не отодвигает срок', () => {
  const saved = snapshotWithActivity()
  const plan = settingsLib.resolveBudget({ settings: { requests: 100, tokens: 10_000, deadlineMinutes: 30 }, saved, now: BASE + 1000, explicit: true })
  assert.equal(plan.source, 'explicit')
  assert.equal(plan.appliesToCurrent, true)
  assert.deepEqual({ ...plan.limits }, { requests: 100, tokens: 10_000 })
  // Новый срок раньше сохранённого — берётся ранний. Позднее сохранённого — не берётся.
  assert.equal(plan.deadlineAt, BASE + 1000 + 30 * 60 * 1000)
  const later = settingsLib.resolveBudget({ settings: { requests: 5, tokens: 100, deadlineMinutes: 600 }, saved, now: BASE + 1000, explicit: true })
  assert.equal(later.deadlineAt, BASE + 60 * 60 * 1000, 'явное решение отодвинуло срок')
  const open = settingsLib.resolveBudget({ settings: { requests: 5, tokens: 100, deadlineMinutes: null }, saved, now: BASE + 1000, explicit: true })
  assert.equal(open.deadlineAt, BASE + 60 * 60 * 1000, 'явное решение сняло сохранённый срок')
})

check('продолжение без предела не получает новый срок из настроек', () => {
  const saved = snapshotWithActivity()
  saved.deadlineAt = null
  const plan = settingsLib.resolveBudget({ settings: { requests: 10, tokens: 1000, deadlineMinutes: 30 }, saved, now: BASE })
  assert.equal(plan.deadlineAt, null)
})

check('состояние: потрачено, активные резервы, неизвестный расход и срок', () => {
  const snapshot = snapshotWithActivity()
  const model = viewLib.view({ snapshot, settings: settingsLib.normalizeBudgetSettings().settings, now: BASE + 1000 })
  assert.equal(model.present, true)
  assert.equal(model.empty, null)
  assert.equal(model.requests.used, 2)
  assert.equal(model.requests.limit, 10)
  assert.equal(model.requests.remaining, 7)
  assert.equal(model.requests.text, '2 / 10')
  assert.equal(model.tokens.used, 250)
  assert.equal(model.tokens.limit, 1000)
  assert.equal(model.tokens.remaining, 550)
  assert.equal(model.tokens.text, '250 / 1 000')
  assert.equal(model.reserved.requests, 1)
  assert.equal(model.reserved.tokens, 200)
  assert.match(model.reserved.text, /1/)
  assert.match(model.reserved.text, /200/)
  assert.equal(model.unknown.requests, 1)
  assert.equal(model.unknown.present, true)
  assert.match(model.unknown.text, /1/)
  assert.equal(model.deadline.at, BASE + 60 * 60 * 1000)
  assert.equal(model.deadline.expired, false)
  assert.match(model.deadline.text, /осталось/)
  assert.equal(model.reason, null)
  assert.deepEqual(model.rows.map(row => row.key), ['requests', 'tokens', 'reserved', 'unknown', 'deadline'])
})

check('пустое состояние: задачи нет, настройки всё равно видны', () => {
  const model = viewLib.view({ snapshot: null, settings: { requests: 20, tokens: 5000, deadlineMinutes: 60 }, now: BASE })
  assert.equal(model.present, false)
  assert.match(model.empty, /Задача не идёт/)
  assert.deepEqual(model.rows, [])
  assert.equal(model.settingsRows.length, 3)
  assert.match(model.settingsRows[0].value, /20/)
  assert.match(model.settingsRows[1].value, /5 000/)
  assert.match(model.settingsRows[2].value, /1 ч/)
})

check('причина остановки: бюджет, срок, неизвестный расход, резервы, отказ записи', () => {
  const snapshot = snapshotWithActivity()
  const reason = refusal => viewLib.view({ snapshot, settings: DEFAULTS, now: BASE + 1000, refusal }).reason
  assert.equal(reason({ ok: false, dimension: 'tokens' }).code, 'budget')
  assert.equal(reason({ ok: false, dimension: 'tokens' }).dimension, 'tokens')
  assert.equal(reason({ ok: false, dimension: 'requests' }).dimension, 'requests')
  assert.equal(reason({ ok: false, dimension: 'deadline' }).code, 'deadline')
  assert.equal(reason({ ok: false, dimension: 'unknown' }).code, 'unknown')
  assert.equal(reason({ ok: false, dimension: 'reservations' }).code, 'reservations')
  assert.equal(reason({ ok: false, error: 'not_durable', durable: false }).code, 'write')
  // Списание, которое не дошло до диска, — тоже отказ записи, хотя ok === true.
  assert.equal(reason({ ok: true, durable: false }).code, 'write')
  // Отказ точнее выведенного состояния: явный отказ по токенам важнее истёкшего срока.
  const expired = JSON.parse(JSON.stringify(snapshot))
  expired.deadlineAt = BASE - 1
  assert.equal(viewLib.view({ snapshot: expired, settings: DEFAULTS, now: BASE }).reason.code, 'deadline')
  assert.equal(viewLib.view({ snapshot: expired, settings: DEFAULTS, now: BASE, refusal: { ok: false, dimension: 'tokens' } }).reason.code, 'budget')
  // Исчерпанный предел виден и без записанного отказа.
  const exhausted = JSON.parse(JSON.stringify(snapshot))
  exhausted.limits.requests = 2
  exhausted.reserved = { requests: 0, tokens: 0 }
  exhausted.reservations = []
  assert.equal(viewLib.view({ snapshot: exhausted, settings: DEFAULTS, now: BASE }).reason.code, 'budget')
})

check('строки идут через t(), в панели нет полей ввода', () => {
  const snapshot = snapshotWithActivity()
  const model = viewLib.view({ snapshot, settings: DEFAULTS, now: BASE + 1000, t: source => 'T:' + source })
  assert.equal(model.title, 'T:Бюджет задачи')
  assert.equal(model.rows[0].label, 'T:Запросы')
  // Мини-DOM: paint не должен создавать input/select/textarea/form.
  const make = tag => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, children: [], textContent: '',
    append (...nodes) { this.children.push(...nodes) },
    replaceChildren (...nodes) { this.children = nodes },
    setAttribute (name, value) { this[name] = value }
  })
  const document = { createElement: make }
  const container = make('div')
  viewLib.paint(container, model, { document })
  const all = []
  const walk = node => { all.push(node); for (const child of node.children || []) walk(child) }
  walk(container)
  assert.equal(all.some(node => ['INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(node.tagName)), false, 'в панели появилось поле ввода')
  const text = all.map(node => node.textContent).join(' ')
  assert.match(text, /T:Бюджет задачи/)
  assert.match(text, /T:Запросы/)
  assert.match(text, /T:Действующие пределы/)
})

if (failures.length) {
  console.error(`\nПровалено ${failures.length} из ${checks + failures.length}: ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log(`\nВсе ${checks} проверок бюджета пройдены.`)
}
