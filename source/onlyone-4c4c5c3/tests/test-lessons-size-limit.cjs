'use strict'

// Аудит 31.10, Н4: файл уроков один на все проекты, а пределы — на проект. Без общего потолка
// запись уроков упирается в 8 МБ хранилища и молча превращается в storage-unavailable. Отказ
// обязан быть понятным (limit-total), не терять данные и не запирать файл: уменьшение проходит.
const assert = require('node:assert/strict')
const { createLessons, TOTAL_MAX, LIMITS } = require('../src/main/project-lessons.cjs')

let failed = 0

const FILLER = 'x'.repeat(LIMITS.evidence)
// Урок в форме, которую пишет служба; размер считается по байтам JSON, как и потолок.
function lesson(projectId, i, status = 'proposed') {
  return {
    id: `${projectId}-${i}`, projectId, status,
    text: 'Правило ' + i + ' ' + 'т'.repeat(LIMITS.text - 20),
    when: '', keywords: [], modes: [],
    source: { chatId: '', turnId: '', evidence: FILLER, by: 'human' },
    createdAt: 1, updatedAt: 1,
    history: [{ at: 1, action: status === 'revoked' ? 'revoked' : 'proposed' }],
    ...(status === 'revoked' ? { revokedAt: 1, reason: '' } : {})
  }
}

// Память вместо диска: считается число записей и размер того, что записали.
function storage(state) {
  let text = JSON.stringify({ format: 'onlyone-lessons', version: 1, lessons: state })
  const stats = { saves: 0 }
  return {
    stats, text: () => text, size: () => Buffer.byteLength(text),
    load: () => JSON.parse(text),
    save: next => { stats.saves++; text = JSON.stringify(next) }
  }
}

// Сеяное состояние: уроки раскладываются по проектам, p1 — предмет проверки и идёт последним.
function seeded(size, tail) {
  const lessons = []
  while (Buffer.byteLength(JSON.stringify({ format: 'onlyone-lessons', version: 1, lessons: [...lessons, ...tail] })) < size) {
    lessons.push(lesson('fill-' + Math.floor(lessons.length / 100), lessons.length))
  }
  return [...lessons, ...tail]
}

const draft = extra => ({
  text: 'Тесты запускаются через npm test', when: 'при запуске тестов', keywords: 'тест, npm',
  evidence: 'Ход 12.10: jest без конфигурации упал, npm test прошёл', chatId: 'chat-a', turnId: 'turn-7', ...extra
})

const cases = []
const check = (name, fn) => cases.push({ name, fn })

check('потолок объявлен и ниже предела хранилища (8 МБ на конверт)', () => {
  assert.equal(typeof TOTAL_MAX, 'number', 'TOTAL_MAX экспортируется')
  assert.ok(TOTAL_MAX > 0 && TOTAL_MAX <= 6 * 1024 * 1024, `потолок ${TOTAL_MAX} оставляет место шифртексту`)
})

check('на пределе предложение урока отказывает limit-total, ничего не записав', () => {
  const p1 = [lesson('p1', 'a'), lesson('p1', 'b', 'revoked')]
  const store = storage(seeded(TOTAL_MAX - 400, p1))
  const before = store.text()
  const lessons = createLessons({ storage: store })
  const r = lessons.propose('p1', draft())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'limit-total', 'понятный код, а не storage-unavailable')
  assert.equal(store.stats.saves, 0, 'на диск ничего не легло')
  assert.equal(store.text(), before, 'данные не тронуты')
  assert.equal(lessons.list('p1').lessons.length, 2, 'память прежняя')
})

check('исправление на пределе тоже отказывает limit-total', () => {
  const p1 = [lesson('p1', 'a'), lesson('p1', 'b')]
  const store = storage(seeded(TOTAL_MAX - 400, p1))
  const lessons = createLessons({ storage: store })
  const r = lessons.correct('p1', 'p1-a', { text: 'Другое правило ' + 'т'.repeat(LIMITS.text - 30) })
  assert.equal(r.code, 'limit-total')
  assert.equal(store.stats.saves, 0)
  assert.equal(lessons.list('p1').lessons.find(l => l.id === 'p1-a').status, 'proposed', 'старая версия не отозвана впустую')
})

check('ниже потолка запись проходит как обычно', () => {
  const p1 = [lesson('p1', 'a')]
  const store = storage(seeded(TOTAL_MAX - 8000, p1))
  const r = createLessons({ storage: store }).propose('p1', draft())
  assert.equal(r.ok, true)
  assert.equal(store.stats.saves, 1)
  assert.ok(store.size() <= TOTAL_MAX, 'записанное укладывается в потолок')
})

check('переполненный файл не запирается: отзыв вытесняет старое и уменьшает файл', () => {
  const revoked = []
  for (let i = 0; i < LIMITS.revoked + 5; i++) revoked.push(lesson('p1', 'r' + i, 'revoked'))
  const store = storage(seeded(TOTAL_MAX + 1000, [...revoked, lesson('p1', 'on')]))
  const lessons = createLessons({ storage: store })
  assert.ok(store.size() > TOTAL_MAX, 'сеяное состояние уже сверх потолка')
  const r = lessons.revoke('p1', 'p1-on', 'Устарел')
  assert.equal(r.ok, true, 'уменьшающая запись проходит, иначе из переполнения не выбраться')
  assert.equal(store.stats.saves, 1)
  assert.ok(store.size() <= TOTAL_MAX, 'после вытеснения файл в потолке')
  assert.equal(lessons.list('p1').lessons.filter(l => l.status === 'revoked').length, LIMITS.revoked)
})

for (const { name, fn } of cases) {
  try { fn(); console.log('ok -', name) } catch (error) { failed++; console.error('FAIL -', name, '\n', error) }
}
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
