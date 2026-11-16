'use strict'
// Юниты формы Центра задач (план, 3.4): как карточка планировщика становится
// тем, что может видеть окно, и как намерение окна становится вызовом
// планировщику. `spawn`, часы и планировщик — подставные; Electron не нужен.
const assert = require('node:assert/strict')
const path = require('node:path')

const { createTaskView } = require('../src/main/task-view')

let checks = 0
let failed = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}

const SECRET = 'sk-QoderTest-1234567890'
const card = (over = {}) => ({
  id: 'q1', title: 'Собрать отчёт', kind: 'shell', priority: 'normal', state: 'running',
  progress: null, startedAt: 1000, finishedAt: null, error: '', attempts: 1, log: [], ...over
})
const SECRET_SCRUB = text => String(text).split(SECRET).join('***')

function manager(tasks = [card()], calls = []) {
  return {
    calls,
    list: () => tasks.map(one => ({ ...one })),
    get: id => tasks.find(one => one.id === id) || null,
    pause: id => { calls.push(['pause', id]); return { ok: true, state: 'paused' } },
    resume: id => { calls.push(['resume', id]); return { ok: true, state: 'queued' } },
    cancel: id => { calls.push(['cancel', id]); return { ok: true, state: 'done' } },
    restart: id => { calls.push(['restart', id]); return { ok: true, state: 'queued' } }
  }
}

function view(tasks, options = {}) {
  const calls = []
  const api = createTaskView({
    manager: manager(tasks, calls), scrub: SECRET_SCRUB, now: () => 777, ...options
  })
  return { api, calls }
}

async function main() {
  await check('список отдаёт карточки со всеми полями договора экрана', async () => {
    const { api } = view([card({ progress: 0.25 })])
    const got = await api.list()
    assert.equal(got.ok, true, `list() ответил ${JSON.stringify(got).slice(0, 120)}`)
    const one = got.tasks[0]
    for (const field of ['id', 'title', 'kind', 'priority', 'state', 'progress', 'startedAt', 'finishedAt',
      'error', 'attempts', 'log', 'canPause', 'canResume', 'canCancel', 'canRestart'])
      assert.ok(field in one, `в карточке нет поля ${field}: экран не сможет нарисовать состояние`)
    assert.equal(one.progress, 0.25, 'доля работы не доехала')
    for (const hidden of ['command', 'args', 'cwd'])
      assert.equal(hidden in one, false, `окну показали ${hidden} — командную строку задачи интерфейс не видит`)
  })

  await check('матрица действий: кнопка там, где планировщик её не отвергнет', async () => {
    const matrix = {
      queued: { canPause: true, canResume: false, canCancel: true, canRestart: false },
      running: { canPause: true, canResume: false, canCancel: true, canRestart: false },
      paused: { canPause: false, canResume: true, canCancel: true, canRestart: true },
      error: { canPause: false, canResume: false, canCancel: false, canRestart: true },
      done: { canPause: false, canResume: false, canCancel: false, canRestart: true },
      interrupted: { canPause: false, canResume: true, canCancel: true, canRestart: true }
    }
    for (const [state, expect] of Object.entries(matrix)) {
      const got = await view([card({ state })]).api.list()
      const seen = Object.fromEntries(Object.entries(got.tasks[0]).filter(([key]) => key.startsWith('can')))
      assert.deepEqual(seen, expect, `состояние ${state}: матрица вышла ${JSON.stringify(seen)}, ожидалось ${JSON.stringify(expect)}`)
    }
  })

  await check('прогресс — только названное число, доля за пределами диапазона режется', async () => {
    assert.equal((await view([card({ progress: null })]).api.list()).tasks[0].progress, null, 'прогресс придуман там, где его нет')
    assert.equal((await view([card({ progress: 4 })]).api.list()).tasks[0].progress, 1, 'доля 400% не влезла в диапазон')
    assert.equal((await view([card({ progress: -2 })]).api.list()).tasks[0].progress, 0, 'отрицательная доля ушла под ноль неправильно')
  })

  await check('заголовок, причина и журнал зачищаются, смысл остаётся', async () => {
    const one = view([card({
      title: `проверка ${SECRET} сборки`, error: `процесс пал: ${SECRET}`, log: [`ключ ${SECRET} не принят`]
    })]).api.list().tasks[0]
    const dump = JSON.stringify(one)
    assert.ok(!dump.includes(SECRET), `ключ протёк в карточку: ${dump.slice(0, 200)}`)
    assert.match(one.title, /проверка.*сборк/, 'зачистка съела заголовок целиком')
    assert.match(one.error, /пал/, 'зачистка съела причину отказа')
    assert.match(one.log.join(' '), /не принят/, 'зачистка съела журнал')
    assert.match(dump, /\*\*\*/, 'форма зачистки не как у redactSecrets')
  })

  await check('намерение экрана доходит до планировщика именованным вызовом', async () => {
    const { api, calls } = view()
    assert.deepEqual(await api.action('pause', { id: 'q1' }), { ok: true, state: 'paused' }, 'пауза не дошла')
    await api.action('resume', { id: 'q1' })
    await api.action('cancel', { id: 'q1' })
    await api.action('restart', { id: 'q1' })
    assert.deepEqual(calls.map(one => one[0]), ['pause', 'resume', 'cancel', 'restart'], `планировщик услышал ${JSON.stringify(calls)}`)
    assert.ok(calls.every(one => one[1] === 'q1'), 'id задачи потерян')
  })

  await check('битое намерение и чужой id — отказ словами, без броска', async () => {
    const { api, calls } = view()
    for (const body of [null, undefined, {}, { id: '' }]) {
      const got = await api.action('pause', body)
      assert.equal(got.ok, false, `пустой вход принят: ${JSON.stringify(body)}`)
      assert.ok(String(got.error || '').trim(), 'отказ без причины')
    }
    const wrong = await api.action('unfreeze', { id: 'q1' })
    assert.equal(wrong.ok, false, 'несуществующее действие выполнено')
    const thrown = view([], { manager: { list: () => [], pause: () => { throw new Error('нет процесса') } } })
    const got = await thrown.api.action('pause', { id: 'q1' })
    assert.equal(got.ok, false, 'бросок планировщика ушёл в канал')
    assert.match(String(got.error), /нет процесса/, `причина броска не доехала: ${JSON.stringify(got)}`)
    void calls
  })

  await check('состояние для окна несёт карточки и не несёт содержания', async () => {
    const { api } = view([card()])
    const body = api.eventBody({ type: 'task-state', at: 5, tasks: [card({ title: `тест ${SECRET}`, command: `run ${SECRET}` })] })
    const dump = JSON.stringify(body)
    assert.equal(body.type, 'task-state', 'событие потеряло тип')
    assert.ok(dump.includes('q1'), 'в теле нет id задачи — экран не поймёт, какую карточку обновлять')
    assert.ok(!dump.includes(SECRET), `в тело события уехал ключ: ${dump.slice(0, 200)}`)
    assert.equal(/"command"/.test(dump), false, 'командная строка уехала в окно')
  })

  await check('присоединённую работу экран не предлагает вернуть в исполнение', async () => {
    // Планировщик не может поднять чужое исполнение: процесса больше нет, а
    // разрешение человека относилось к тому запуску. Кнопка, которая всегда
    // отказывает, хуже отсутствующей.
    const { api } = view([card({ state: 'done', attached: true })])
    const one = (await api.list()).tasks[0]
    assert.equal(one.canRestart, false, 'упавшей чужой работе предложён перезапуск')
    assert.equal(one.canResume, false, 'чужой работе предложено возобновление')
    assert.equal(one.canPause, false, `с завершённой чужой работы предложено снять (${one.state})`)

    const live = (await view([card({ state: 'running', attached: true })]).api.list()).tasks[0]
    assert.equal(live.canPause, true, 'живую чужую работу нельзя снять — кнопка нужнее отказа')
    assert.equal(live.canCancel, true, 'живую чужую работу нельзя отменить')
    assert.equal(live.canRestart, false, 'живой чужой работе предложен перезапуск')

    const own = (await view([card({ state: 'error' })]).api.list()).tasks[0]
    assert.equal(own.canRestart, true, 'обычной упавшей работе запретили перезапуск: правило зашло слишком далеко')
  })

  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  console.error('ПРОВАЛ [набор]:', error && error.message)
  process.exitCode = 1
})
