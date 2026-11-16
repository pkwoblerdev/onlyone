'use strict'
// Уроки проекта в стенде: зерно проходит только человеческие действия, проверка
// ловит урок в чужом проекте, неподходящий, отозванный и устаревший; сравнение
// off/on сохраняет условия, расход и причины неуспеха, а ошибка провайдера — свой
// исход. Окна и модели не запускаются: это проверка стенда на искусственных данных.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLessons } = require('../src/main/project-lessons.cjs')
const lessons = require('../scripts/quality-bench/lessons.cjs')
const { compareReports } = require('../scripts/quality-bench/compare.cjs')
const bench = require('../scripts/quality-bench.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-bench-lessons-'))
const space = (name, files = {}) => {
  const value = path.join(dir, name)
  fs.mkdirSync(value, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(value, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return value
}
const memory = () => {
  let saved = null
  return { storage: { load: () => saved, save: value => { saved = value } }, all: () => saved }
}
const seeded = fixture => {
  const store = memory()
  const service = createLessons({ storage: store.storage })
  const applied = lessons.applySeed(service, fixture)
  assert.equal(applied.ok, true, 'зерно уроков не применилось')
  return { service, store }
}
const statuses = (service, fixture) => {
  const map = {}
  for (const project of lessons.PROJECTS) for (const item of service.list(project.id).lessons) map[item.text] = item.status
  return Object.fromEntries(fixture.expect.map(item => [item.key, map[item.text] || 'absent']))
}
const contextOf = (fixture, service, request, profile = 'on') => {
  const prompt = service.promptBlock(fixture.projectId, { request, mode: 'agent' })
  return { guard: { problems: [] }, prompt, probePrompt: prompt, lessons: { ok: true, statuses: statuses(service, fixture) }, lessonsProfile: profile }
}
const byId = id => lessons.scenarios.find(item => item.id === id)

try {
  // 1. Набор задач: шесть сценариев уроков, у каждого зерно, скрытая проверка и ограничения.
  const ids = ['lesson-applied', 'lesson-ignored', 'lesson-isolation', 'lesson-corrected', 'lesson-corrected-enabled', 'lesson-stale']
  for (const id of ids) {
    const item = byId(id)
    assert.ok(item, id + ': сценарий не включён')
    assert.equal(item.expect, 'pass', id + ': ожидание live')
    assert.equal(typeof item.verify, 'function', id + ': нет проверки')
    assert.ok(item.lessons && Array.isArray(item.lessons.seed) && item.lessons.seed.length, id + ': нет зерна уроков')
    assert.ok(Array.isArray(item.turns), id + ': нет ответов сценария')
    assert.ok(item.constraints && Array.isArray(item.constraints.allowNew), id + ': нет ограничений')
    assert.ok([lessons.PROJECT_A.id, lessons.PROJECT_B.id].includes(item.lessons.projectId), id + ': чужой проект')
    assert.ok(item.selfExpect && ['pass', 'agent-error'].includes(item.selfExpect.on), id + ': нет ожидания on')
    assert.ok(['pass', 'agent-error'].includes(item.selfExpect.off), id + ': нет ожидания off')
  }
  assert.equal(new Set(lessons.scenarios.map(item => item.id)).size, ids.length)

  // 2. Зерно применяется только доступными человеку действиями и даёт ожидаемые состояния.
  for (const fixture of Object.values(lessons.fixtures)) {
    const { service } = seeded(fixture)
    assert.deepEqual(statuses(service, fixture), fixture.statuses, 'состояния зерна не совпали')
  }

  // 3. Подходящий урок попадает в promptBlock, неподходящий и чужой — нет.
  const applied = seeded(lessons.fixtures.APPLIED)
  assert.ok(applied.service.promptBlock(lessons.PROJECT_A.id, { request: 'Собери сборку', mode: 'agent' }).includes(lessons.texts.L_APPLIED.text), 'подходящий урок не подан')
  assert.equal(applied.service.promptBlock(lessons.PROJECT_A.id, { request: 'Напиши README', mode: 'agent' }), '', 'неподходящий урок подан')
  assert.equal(applied.service.promptBlock(lessons.PROJECT_B.id, { request: 'Собери сборку', mode: 'agent' }), '', 'урок утёк в чужой проект')

  const corrected = seeded(lessons.fixtures.CORRECTED)
  const correctedPrompt = corrected.service.promptBlock(lessons.PROJECT_A.id, { request: 'Запусти тесты', mode: 'agent' })
  assert.equal(correctedPrompt, '', 'исправленная версия действует без включения или старая не отозвана')
  const enabled = seeded(lessons.fixtures.CORRECTED_ENABLED)
  const enabledPrompt = enabled.service.promptBlock(lessons.PROJECT_A.id, { request: 'Запусти тесты', mode: 'agent' })
  assert.ok(enabledPrompt.includes(lessons.texts.L_TESTS_NEW.text), 'включённая новая версия не подана')
  assert.equal(enabledPrompt.includes(lessons.texts.L_TESTS_OLD.text), false, 'отозванная старая версия подана')

  // 4. Проверки: правильный результат проходит, подмена урока/файла — нет.
  const appliedScenario = byId('lesson-applied')
  const appliedContext = contextOf(lessons.fixtures.APPLIED, applied.service, appliedScenario.request)
  const appliedSpace = space('applied-good', { 'reports/build.txt': 'sha512 подтверждён\n' })
  const appliedOk = appliedScenario.verify({ workspace: appliedSpace, run: {}, context: appliedContext })
  assert.equal(appliedOk.ok, true, appliedOk.detail)
  const appliedNoPrompt = space('applied-no-prompt')
  assert.match(appliedScenario.verify({ workspace: appliedSpace, run: {}, context: { ...appliedContext, prompt: null } }).detail, /снимка промпта/)
  assert.equal(appliedScenario.verify({ workspace: appliedSpace, run: {}, context: { ...appliedContext, probePrompt: 'другой блок' } }).ok, false, 'расхождение пробы не поймано')
  const appliedWrong = space('applied-wrong', { 'reports/build.txt': 'сборка готова\n' })
  assert.equal(appliedScenario.verify({ workspace: appliedWrong, run: {}, context: appliedContext }).ok, false, 'неверный результат принят')
  const drained = space('applied-drained', { 'reports/build.txt': 'sha512 подтверждён\n' })
  assert.equal(appliedScenario.verify({ workspace: drained, run: {}, context: { ...appliedContext, prompt: 'без блока уроков', probePrompt: null } }).ok, false, 'урок не подан, а проверка прошла')

  const ignored = byId('lesson-ignored')
  const ignoredSeeded = seeded(lessons.fixtures.IGNORED)
  const ignoredContext = contextOf(lessons.fixtures.IGNORED, ignoredSeeded.service, ignored.request)
  const ignoredSpace = space('ignored-good', { 'notes/summary.txt': 'итог\n' })
  assert.equal(ignored.verify({ workspace: ignoredSpace, run: {}, context: ignoredContext }).ok, true)
  assert.equal(ignored.verify({ workspace: ignoredSpace, run: {}, context: { ...ignoredContext, prompt: '- ' + lessons.texts.L_IGNORED.text } }).ok, false, 'неподходящий урок в промпте не пойман')

  const isolation = byId('lesson-isolation')
  const isolationSeeded = seeded(lessons.fixtures.ISOLATION)
  const isolationContext = contextOf(lessons.fixtures.ISOLATION, isolationSeeded.service, isolation.request)
  const isolationSpace = space('isolation-good', { 'notes/b.md': 'отчёт Б\n' })
  assert.equal(isolation.verify({ workspace: isolationSpace, run: {}, context: isolationContext }).ok, true)
  const ownA = isolationSeeded.service.promptBlock(lessons.PROJECT_A.id, { request: 'Сделай отчёт', mode: 'agent' })
  assert.equal(isolation.verify({ workspace: isolationSpace, run: {}, context: { ...isolationContext, prompt: ownA, probePrompt: ownA } }).ok, false, 'урок проекта А принят в проекте Б')

  const correctedScenario = byId('lesson-corrected')
  const correctedSpace = space('corrected-good', { 'notes/tests.txt': 'тесты прошли\n' })
  assert.equal(correctedScenario.verify({ workspace: correctedSpace, run: {}, context: contextOf(lessons.fixtures.CORRECTED, corrected.service, correctedScenario.request) }).ok, true)
  const oldOnly = '- ' + lessons.texts.L_TESTS_OLD.text + '\n' + lessons.PRIORITY
  assert.equal(correctedScenario.verify({ workspace: correctedSpace, run: {}, context: { ...contextOf(lessons.fixtures.CORRECTED, corrected.service, correctedScenario.request), prompt: oldOnly, probePrompt: oldOnly } }).ok, false, 'старая версия принята')

  const enabledScenario = byId('lesson-corrected-enabled')
  const enabledSpace = space('enabled-good', { 'notes/tests.txt': 'тесты прошли\n' })
  assert.equal(enabledScenario.verify({ workspace: enabledSpace, run: {}, context: contextOf(lessons.fixtures.CORRECTED_ENABLED, enabled.service, enabledScenario.request) }).ok, true)
  assert.equal(enabledScenario.verify({ workspace: enabledSpace, run: {}, context: { ...contextOf(lessons.fixtures.CORRECTED_ENABLED, enabled.service, enabledScenario.request), prompt: oldOnly, probePrompt: oldOnly } }).ok, false, 'старая версия принята вместо новой')

  const stale = byId('lesson-stale')
  const staleSeeded = seeded(lessons.fixtures.STALE)
  const staleContext = contextOf(lessons.fixtures.STALE, staleSeeded.service, stale.request)
  const staleSpace = space('stale-good', { 'notes/current.md': 'текущий\n' })
  assert.equal(stale.verify({ workspace: staleSpace, run: {}, context: staleContext }).ok, true, 'текущая просьба не принята')
  const noPriority = staleContext.prompt.split(lessons.PRIORITY).join('')
  assert.equal(stale.verify({ workspace: staleSpace, run: {}, context: { ...staleContext, prompt: noPriority, probePrompt: noPriority } }).ok, false, 'нет оговорки о приоритете — принято')
  const legacy = space('stale-legacy', { 'notes/current.md': 'текущий\n', 'docs/legacy.md': 'старое\n' })
  assert.equal(stale.verify({ workspace: legacy, run: {}, context: staleContext }).ok, false, 'файл устаревшего правила принят')
  const staleNoLesson = space('stale-no-lesson', { 'notes/current.md': 'текущий\n' })
  assert.equal(stale.verify({ workspace: staleNoLesson, run: {}, context: { ...staleContext, prompt: '', probePrompt: '' } }).ok, false, 'устаревший урок обязан быть подан, чтобы проверять приоритет')

  // 5. Отчёт: ожидание самопроверки зависит от профиля, метаданные уроков на месте.
  const attempt = bench.finishAttempt({ scenario: { id: 'lesson-applied', title: 'x', expect: 'pass' }, repeat: 1,
    options: { mode: 'self', timeoutMs: 1000, out: dir, lessons: 'off' }, workspace: dir, profile: dir, chatId: 'x', model: 'm', dumpDir: '',
    first: { result: { content: 'Готово.' }, requests: 1, durationMs: 1 }, check: { ok: false, detail: 'урок не подан' },
    verdict: 'agent-error', stopReason: 'completed', initialFiles: [],
    lessons: { profile: 'off', projectId: lessons.PROJECT_A.id, expected: [{ key: 'l1', inPrompt: true }], observed: [{ key: 'l1', inPrompt: false }] },
    selfExpectation: 'agent-error' })
  assert.equal(attempt.expected, 'pass')
  assert.equal(attempt.selfExpectation, 'agent-error')
  assert.equal(attempt.lessons.profile, 'off')

  // 6. Сравнение off/on: пары, исходы, unknown spend и отдельная ошибка провайдера.
  const report = (profile, mutate = () => {}) => {
    const one = { tool: 'onlyone-agent-quality-bench', schemaVersion: 1, completed: true, mode: 'live', suiteDigest: 'a'.repeat(64),
      source: { commit: 'b'.repeat(40), dirty: false },
      attempts: [
        { scenario: 'lesson-applied', repeat: 1, mode: 'live', model: 'model/x', params: { permission: 'acceptEdits', timeoutMs: 60000 },
          verdict: profile === 'off' ? 'agent-error' : 'pass', expected: 'pass', check: { ok: profile === 'on', detail: profile === 'off' ? 'урок не подан' : 'ok' },
          durationMs: 100, requests: 2, tokens: 40, failure: null, stopReason: 'completed',
          lessons: { profile, projectId: 'bench-lessons-a', expected: [{ key: 'l1', inPrompt: true }], observed: [{ key: 'l1', inPrompt: profile === 'on' }] } },
        { scenario: 'lesson-ignored', repeat: 1, mode: 'live', model: 'model/x', params: { permission: 'acceptEdits', timeoutMs: 60000 },
          verdict: 'pass', expected: 'pass', check: { ok: true, detail: 'ok' }, durationMs: 80, requests: 1, tokens: 10, failure: null, stopReason: 'completed',
          lessons: { profile, projectId: 'bench-lessons-a', expected: [{ key: 'l1', inPrompt: false }], observed: [{ key: 'l1', inPrompt: false }] } }
      ] }
    mutate(one)
    return one
  }
  const off = report('off'), on = report('on')
  const compared = compareReports(off, on, 'lessons')
  assert.equal(compared.kind, 'lessons')
  assert.equal(compared.effectProven, false)
  assert.equal(compared.configurationFullyVerified, false)
  assert.deepEqual(compared.pairs.map(pair => pair.outcome), ['improved', 'unchanged'])
  assert.equal(compared.pairs[0].verdicts.a, 'agent-error')
  assert.equal(compared.pairs[0].failures.a, null)
  assert.equal(compared.totals.a.passed, 1)

  const errorReport = report('on', value => {
    value.attempts[0].verdict = 'provider-error'; value.attempts[0].check = { ok: false, detail: 'провайдер ответил 429' }
    value.attempts[0].tokens = null; value.attempts[0].requests = 3; value.attempts[0].failure = 'completed'
  })
  const withError = compareReports(off, errorReport, 'lessons')
  assert.equal(withError.pairs[0].outcome, 'provider-error', 'ошибка провайдера не отделена от проигрыша')
  assert.equal(withError.pairs[0].tokens.b, null)
  assert.equal(withError.totals.b.tokens, null, 'неизвестный расход превратился в число')
  assert.equal(withError.totals.b.providerErrors, 1)
  assert.equal(withError.totals.tokensDelta, null)
  assert.equal(withError.pairs[0].checks.b.includes('429'), true, 'причина неуспеха потеряна')

  const extra = { scenario: 'file-result', repeat: 1, mode: 'live', model: 'model/x', params: { permission: 'acceptEdits', timeoutMs: 60000 },
    verdict: 'pass', expected: 'pass', check: { ok: true, detail: 'ok' }, durationMs: 50, requests: 1, tokens: 5 }
  const mixedOff = report('off'), mixedOn = report('on')
  mixedOff.attempts.push({ ...structuredClone(extra) }); mixedOn.attempts.push({ ...structuredClone(extra) })
  const mixed = compareReports(mixedOff, mixedOn, 'lessons')
  assert.equal(mixed.pairs.length, 2, 'пары уроков потеряны')
  assert.deepEqual(mixed.excluded, [{ scenario: 'file-result', repeat: 1, reason: 'no lessons metadata' }], 'задача без уроков исчезла молча')
  assert.equal(mixed.totals.a.attempts, 2, 'итоги считают только пары уроков')

  const rejects = (mutate, pattern) => { const other = report('on'); mutate(other); assert.throws(() => compareReports(off, other, 'lessons'), pattern) }
  rejects(value => { value.attempts[0].lessons.profile = 'off' }, /off then on/)
  rejects(value => { value.attempts[0].lessons.projectId = 'other' }, /project/)
  rejects(value => { value.attempts[0].lessons.expected = [{ key: 'l1', inPrompt: false }] }, /expectations/)
  rejects(value => { delete value.attempts[0].lessons }, /metadata/)
  rejects(value => { value.attempts[0].verdict = 'bench-error'; value.attempts[0].check.ok = false }, /infrastructure/)
  rejects(value => { value.attempts[0].params.timeoutMs = 1 }, /conditions/)
  rejects(value => { value.attempts[0].model = 'other/model' }, /model/)
  rejects(value => { value.source.commit = 'c'.repeat(40) }, /source/)
  rejects(value => { value.suiteDigest = 'c'.repeat(64) }, /suite/)
  rejects(value => { value.attempts.pop() }, /pairs/)
  const otherOn = report('on', value => { value.attempts[0].verdict = 'provider-error'; value.attempts[0].check = { ok: false, detail: 'x' } })
  assert.throws(() => compareReports(on, otherOn, 'aa'), /infrastructure/, 'A/A не должен молча принимать ошибку провайдера')
  assert.throws(() => compareReports(off, report('off'), 'lessons'), /off then on/)

  console.log('PASS bench lessons: human-only seed, applied/ignored/isolation/corrected/stale criteria, off/on comparison keeps spend and failures, provider error is its own outcome')
} finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }) }
