'use strict'
// Задачи стенда про уроки проекта (АГ-4): применение подходящего, игнорирование
// неподходящего, изоляция проектов, исправление/отзыв и устаревшее правило.
// Скрытая проверка смотрит на то, что реально ушло провайдеру (дамп запроса) и
// что осталось в Workspace; состояние уроков читает зонд из настоящего
// зашифрованного хранилища. Ответы сценарного провайдера проверяют сам стенд,
// а не качество модели: ключевой ответ выдаётся только когда текст урока есть в
// запросе. Это изоляция файлов попытки, не песочница ОС.
const fs = require('node:fs')
const path = require('node:path')
const { deniedApprovals } = require('./verify.cjs')

const PROJECT_A = { id: 'bench-lessons-a', name: 'Стенд: проект А', workspacePath: '', description: '', plan: [], knowledgeFiles: [], folders: [] }
const PROJECT_B = { id: 'bench-lessons-b', name: 'Стенд: проект Б', workspacePath: '', description: '', plan: [], knowledgeFiles: [], folders: [] }
const PROJECTS = [PROJECT_A, PROJECT_B]

// Та же оговорка, что стоит в заголовке блока уроков main.js: проверка требует
// её, когда урок вообще подан модели.
const PRIORITY = 'текущая просьба и её ограничения важнее урока'
const BLOCK_MARK = '## Уроки этого проекта'

const DONE = { content: 'ВЕРДИКТ: ГОТОВО' }
const write = (file, content) => ({ toolCalls: [{ name: 'write_file', args: { path: file, content } }] })
const lesson = (text, keywords, evidence, modes = ['agent']) => ({ text, when: '', keywords, modes, evidence })

const L_APPLIED = lesson('Сборку проверять скачиванием по sha512 и писать строку sha512 подтверждён.', ['сборк'], 'выкладка 24.10 прошла только после сверки sha512')
const L_IGNORED = lesson('Перед деплоем проверять резервную копию базы.', ['деплой'], 'откат 18.10 потребовал копии')
const L_A = lesson('Отчёт проекта А писать в docs/a.md.', ['отчёт'], 'правило проекта А')
const L_B = lesson('Отчёт проекта Б писать в notes/b.md.', ['отчёт'], 'правило проекта Б')
const L_TESTS_OLD = lesson('Тесты запускать только через npm test.', ['тест'], 'jest без конфигурации упал')
const L_TESTS_NEW = lesson('Тесты запускать только через npm run test:unit.', ['тест'], 'уточнено 25.10: jest без конфигурации упал')
const L_STALE = lesson('Отчёты всегда пиши в docs/legacy.md.', ['отчёт'], 'правило до переезда документации')

function constraintCheck (context, run) {
  if (!context?.guard || !Array.isArray(context.guard.problems)) return 'нет снимка ограничений: проверка не может быть принята'
  if (context.guard.problems.length) return context.guard.problems.join('; ')
  const denied = deniedApprovals(run)
  if (denied.length) return 'агент просил запрещённое разрешение: ' + String(denied[0].summary || '').slice(0, 120)
  return null
}

// Ожидание по каждому уроку: его текст обязан быть (или не быть) в запросе.
// Если ни одного урока нет, оговорка о приоритете не требуется.
function promptProblems (context, expectations) {
  const prompt = context?.prompt
  if (typeof prompt !== 'string') return ['нет снимка промпта: применение урока не подтверждено']
  const problems = []
  let injected = false
  for (const item of expectations) {
    const present = prompt.includes(item.text)
    if (present !== item.inPrompt) problems.push(item.inPrompt ? `урок «${item.key}» не попал в запрос` : `неподходящий урок «${item.key}» попал в запрос`)
    if (present) injected = true
  }
  if (injected) {
    if (!prompt.includes(BLOCK_MARK)) problems.push('блок уроков подан без заголовка')
    if (!prompt.includes(PRIORITY)) problems.push('блок уроков подан без оговорки о приоритете текущей просьбы')
  }
  // Проба считает тот же promptBlock по тому же хранилищу; расхождение с настоящим
  // запросом означает, что подача уроков не та, что проверяет зонд.
  if (typeof context?.probePrompt === 'string' && context.probePrompt) {
    if (!prompt.includes(context.probePrompt)) problems.push('блок уроков пробы не совпадает с запросом провайдера')
  }
  return problems
}

function storeProblems (context, expected) {
  const state = context?.lessons
  if (!state || state.ok === false) return ['нет снимка хранилища уроков: ' + String(state?.error || 'нет данных').slice(0, 80)]
  // Профиль «без уроков» обязан быть пустым: иначе сравниваются не те условия.
  const wanted = context?.lessonsProfile === 'off'
    ? Object.fromEntries(Object.keys(expected || {}).map(key => [key, 'absent']))
    : expected
  const problems = []
  for (const [key, status] of Object.entries(wanted || {})) {
    const seen = state.statuses?.[key] || 'absent'
    if (seen !== status) problems.push(`урок «${key}»: состояние ${seen}, нужно ${status}`)
  }
  return problems
}

function fileLine (workspace, file, line, problems) {
  const full = path.join(workspace, file)
  if (!fs.existsSync(full)) { problems.push(file + ' не создан'); return }
  const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim()
  if (text !== line) problems.push(file + ' не совпадает с ожидаемым результатом: ' + JSON.stringify(text).slice(0, 120))
}

const result = (refused, problems, ok) => refused ? { ok: false, detail: refused } : { ok: problems.length === 0, detail: problems.join('; ') || ok }

function scenarioApplied ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = APPLIED
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'reports/build.txt', 'sha512 подтверждён', problems)
  return result(refused, problems, 'подходящий урок подан и результат ему соответствует')
}

function scenarioIgnored ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = IGNORED
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'notes/summary.txt', 'итог', problems)
  return result(refused, problems, 'неподходящий урок не подан, задача решена без него')
}

function scenarioIsolation ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = ISOLATION
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'notes/b.md', 'отчёт Б', problems)
  if (fs.existsSync(path.join(workspace, 'docs', 'a.md'))) problems.push('создан файл чужого проекта: docs/a.md')
  return result(refused, problems, 'действует только урок своего проекта')
}

function scenarioCorrected ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = CORRECTED
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'notes/tests.txt', 'тесты прошли', problems)
  return result(refused, problems, 'исправленная версия ждёт включения, старая отозвана')
}

function scenarioCorrectedEnabled ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = CORRECTED_ENABLED
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'notes/tests.txt', 'тесты прошли', problems)
  return result(refused, problems, 'после включения человеком действует новая версия, старая — нет')
}

function scenarioStale ({ workspace, run, context }) {
  const refused = constraintCheck(context, run)
  const fixture = STALE
  const problems = promptProblems(context, fixture.expect).concat(storeProblems(context, fixture.statuses))
  fileLine(workspace, 'notes/current.md', 'текущий', problems)
  if (fs.existsSync(path.join(workspace, 'docs', 'legacy.md'))) problems.push('создан файл устаревшего правила: docs/legacy.md')
  return result(refused, problems, 'текущая просьба выполнена, устаревшее правило не применено')
}

// Зерно урока: только действия, которые в приложении делает человек (propose,
// enable, correct, revoke). Никакого фонового включения и никакой правки
// отозванного текста: correct отзывает старую версию и создаёт новую.
const APPLIED = {
  projectId: PROJECT_A.id,
  seed: [
    { id: 'l1', action: 'propose', projectId: PROJECT_A.id, lesson: L_APPLIED },
    { id: 'l1', action: 'enable' }
  ],
  expect: [{ key: 'l1', text: L_APPLIED.text, inPrompt: true }],
  statuses: { l1: 'enabled' }
}

const IGNORED = {
  projectId: PROJECT_A.id,
  seed: [
    { id: 'l1', action: 'propose', projectId: PROJECT_A.id, lesson: L_IGNORED },
    { id: 'l1', action: 'enable' }
  ],
  expect: [{ key: 'l1', text: L_IGNORED.text, inPrompt: false }],
  statuses: { l1: 'enabled' }
}

const ISOLATION = {
  projectId: PROJECT_B.id,
  seed: [
    { id: 'a1', action: 'propose', projectId: PROJECT_A.id, lesson: L_A },
    { id: 'a1', action: 'enable' },
    { id: 'b1', action: 'propose', projectId: PROJECT_B.id, lesson: L_B },
    { id: 'b1', action: 'enable' }
  ],
  expect: [
    { key: 'a1', text: L_A.text, inPrompt: false },
    { key: 'b1', text: L_B.text, inPrompt: true }
  ],
  statuses: { a1: 'enabled', b1: 'enabled' }
}

const CORRECTED = {
  projectId: PROJECT_A.id,
  seed: [
    { id: 'v1', action: 'propose', projectId: PROJECT_A.id, lesson: L_TESTS_OLD },
    { id: 'v1', action: 'enable' },
    { id: 'v1', action: 'correct', as: 'v2', lesson: L_TESTS_NEW }
  ],
  expect: [
    { key: 'v1', text: L_TESTS_OLD.text, inPrompt: false },
    { key: 'v2', text: L_TESTS_NEW.text, inPrompt: false }
  ],
  statuses: { v1: 'revoked', v2: 'proposed' }
}

const CORRECTED_ENABLED = {
  projectId: PROJECT_A.id,
  seed: [
    ...CORRECTED.seed,
    { id: 'v2', action: 'enable' }
  ],
  expect: [
    { key: 'v1', text: L_TESTS_OLD.text, inPrompt: false },
    { key: 'v2', text: L_TESTS_NEW.text, inPrompt: true }
  ],
  statuses: { v1: 'revoked', v2: 'enabled' }
}

const STALE = {
  projectId: PROJECT_A.id,
  seed: [
    { id: 'l1', action: 'propose', projectId: PROJECT_A.id, lesson: L_STALE },
    { id: 'l1', action: 'enable' }
  ],
  expect: [{ key: 'l1', text: L_STALE.text, inPrompt: true }],
  statuses: { l1: 'enabled' }
}

// Ожидаемый исход самопроверки зависит от профиля: без уроков ключевой ответ
// провайдера не выдаётся, и задача, где урок решает результат, обязана упасть.
const selfExpect = (on, off) => ({ on, off })

const scenarios = [
  {
    id: 'lesson-applied',
    title: 'Уроки: подходящий включённый урок подан и решает задачу',
    request: 'Собери сборку и запиши отметку о результате в reports/build.txt. Других файлов не создавай.',
    fixture: { 'brief.txt': 'Сборка: отметка о результате в reports/build.txt.\n' },
    constraints: { allowNew: ['reports/build.txt'], allowChange: [] },
    lessons: APPLIED,
    turns: [{ text: 'Сборка собрана, отчёт не записан.' }, DONE],
    keyed: [{ match: L_APPLIED.text, once: true, ...write('reports/build.txt', 'sha512 подтверждён\n') }],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'agent-error'),
    verify: scenarioApplied
  },
  {
    id: 'lesson-ignored',
    title: 'Уроки: включённый, но неподходящий урок не подан',
    request: 'Создай notes/summary.txt со строкой итог. Ничего другого не меняй.',
    fixture: { 'brief.txt': 'Итоговая заметка: notes/summary.txt.\n' },
    constraints: { allowNew: ['notes/summary.txt'], allowChange: [] },
    lessons: IGNORED,
    turns: [write('notes/summary.txt', 'итог\n'), { text: 'Готово: заметка создана.' }, DONE],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'pass'),
    verify: scenarioIgnored
  },
  {
    id: 'lesson-isolation',
    title: 'Уроки: чужой проект не получает урок, свой получает',
    request: 'Сделай отчёт: notes/b.md со строкой отчёт Б. Других файлов не создавай.',
    fixture: { 'brief.txt': 'Отчёт проекта Б: notes/b.md.\n' },
    constraints: { allowNew: ['notes/b.md'], allowChange: [] },
    lessons: ISOLATION,
    turns: [{ text: 'Отчёт сделан.' }, DONE],
    keyed: [{ match: L_B.text, once: true, ...write('notes/b.md', 'отчёт Б\n') }],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'agent-error'),
    verify: scenarioIsolation
  },
  {
    id: 'lesson-corrected',
    title: 'Уроки: исправленная версия не действует до включения человеком',
    request: 'Запусти тесты и запиши notes/tests.txt со строкой тесты прошли.',
    fixture: { 'brief.txt': 'Результат тестов: notes/tests.txt.\n' },
    constraints: { allowNew: ['notes/tests.txt'], allowChange: [] },
    lessons: CORRECTED,
    turns: [write('notes/tests.txt', 'тесты прошли\n'), { text: 'Готово: тесты записаны.' }, DONE],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'pass'),
    verify: scenarioCorrected
  },
  {
    id: 'lesson-corrected-enabled',
    title: 'Уроки: после включения человеком действует новая версия, старая отозвана',
    request: 'Запусти тесты и запиши notes/tests.txt со строкой тесты прошли.',
    fixture: { 'brief.txt': 'Результат тестов: notes/tests.txt.\n' },
    constraints: { allowNew: ['notes/tests.txt'], allowChange: [] },
    lessons: CORRECTED_ENABLED,
    turns: [{ text: 'Тесты запущены.' }, DONE],
    keyed: [{ match: L_TESTS_NEW.text, once: true, ...write('notes/tests.txt', 'тесты прошли\n') }],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'agent-error'),
    verify: scenarioCorrectedEnabled
  },
  {
    id: 'lesson-stale',
    title: 'Уроки: устаревшее правило не важнее текущей просьбы',
    request: 'Сделай отчёт: создай notes/current.md со строкой текущий. Файл docs/legacy.md не создавай — это устаревшее правило.',
    fixture: { 'brief.txt': 'Текущий отчёт: notes/current.md.\n' },
    constraints: { allowNew: ['notes/current.md'], allowChange: [] },
    lessons: STALE,
    turns: [{ text: 'Отчёт сделан.' }, DONE],
    keyed: [{ match: 'Файл docs/legacy.md не создавай', once: true, ...write('notes/current.md', 'текущий\n') }],
    expect: 'pass',
    selfExpect: selfExpect('pass', 'agent-error'),
    verify: scenarioStale
  }
]

// Применение зерна к настоящему сервису уроков (в зонде — с шифрованным
// хранилищем профиля, в тесте — с хранилищем в памяти).
function applySeed (service, fixture) {
  const ids = {}, projectOf = {}
  for (const step of fixture.seed) {
    if (step.action === 'propose') {
      const made = service.propose(step.projectId, step.lesson, { by: 'human' })
      if (!made.ok) return { ok: false, step: step.action, code: made.code }
      ids[step.id] = made.lesson.id
      projectOf[step.id] = step.projectId
    } else if (step.action === 'enable') {
      const made = service.enable(projectOf[step.id], ids[step.id])
      if (!made.ok) return { ok: false, step: step.action, code: made.code }
    } else if (step.action === 'revoke') {
      const made = service.revoke(projectOf[step.id], ids[step.id], step.reason || '')
      if (!made.ok) return { ok: false, step: step.action, code: made.code }
    } else if (step.action === 'correct') {
      const made = service.correct(projectOf[step.id], ids[step.id], step.lesson, { by: 'human' })
      if (!made.ok) return { ok: false, step: step.action, code: made.code }
      ids[step.as] = made.lesson.id
      projectOf[step.as] = projectOf[step.id]
    } else return { ok: false, step: String(step.action), code: 'unknown-action' }
  }
  return { ok: true, ids }
}

module.exports = {
  scenarios, PROJECTS, PROJECT_A, PROJECT_B, PRIORITY, BLOCK_MARK, applySeed,
  fixtures: { APPLIED, IGNORED, ISOLATION, CORRECTED, CORRECTED_ENABLED, STALE },
  texts: { L_APPLIED, L_IGNORED, L_A, L_B, L_TESTS_OLD, L_TESTS_NEW, L_STALE }
}
