// Н34: очередь Дизайна не должна терять продолжение прерванного хода.
//
// Что было: отложенное продолжение ложилось в очередь одной строкой, и когда
// ход освобождался, оно уходило как обычное сообщение — без скрытой описи и
// без id хода. Агент начинал работу заново там, где человек нажал
// «Продолжить», а опись ещё и показывалась в полосе очереди как напечатанная.
//
// Проверка берёт настоящие функции окна (вырезаны из исполняемого кода), а не
// их пересказ.
const assert = require('node:assert/strict')
const path = require('node:path')
const { rendererCode } = require('./renderer-code.cjs')

const code = rendererCode(path.join(__dirname, '..'))
// Якоря ищутся по содержимому, а не по отступу: участок переехал вглубь на
// пару уровней — и проверка краснела без всякой поломки поведения.
const findAnchor = (text, fromIndex = 0) => {
  const body = String(text).trim().split(/\s+/)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]+')
  const found = new RegExp(`[ \\t]*${body}`).exec(code.slice(fromIndex))
  return found ? fromIndex + found.index : -1
}
const cut = (from, to) => {
  const a = findAnchor(from)
  const b = a >= 0 ? findAnchor(to, a + 1) : -1
  assert.ok(a >= 0 && b > a, `не найдена область: ${from}`)
  return code.slice(a, b)
}

const queue = new Map()
let painted = 0
const queueDesignMessage = new Function('designQueue', 'renderDesignQueue',
  cut('  function queueDesignMessage(designId, entry)', '  // ─── Блоки агентной ленты') +
  '; return queueDesignMessage')(queue, () => { painted++ })
const queuedFor = new Function('designQueue',
  cut('  function queuedFor(designId)', '  function renderDesignQueue(') +
  '; return queuedFor')(queue)

let failed = 0
let total = 0
function check(name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) }
  catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

check('отложенное продолжение сохраняет опись и id хода', () => {
  queue.clear()
  queueDesignMessage('d1', { text: 'Продолжить прерванную работу', hidden: 'ОПИСЬ: сделано 3 шага', resumeRunId: 'run-9' })
  assert.deepEqual(queue.get('d1'), {
    text: 'Продолжить прерванную работу', hidden: 'ОПИСЬ: сделано 3 шага', resumeRunId: 'run-9'
  })
  assert.equal(painted, 1, 'полоса очереди не перерисована')
})

check('в полосе очереди виден текст, а не скрытая опись', () => {
  assert.equal(queuedFor('d1'), 'Продолжить прерванную работу')
  assert.doesNotMatch(queuedFor('d1'), /ОПИСЬ/, 'скрытая опись показалась человеку')
})

check('набранный поверх текст не обрывает продолжение', () => {
  queueDesignMessage('d1', { text: 'и добавь тень под карточкой' })
  assert.equal(queuedFor('d1'), 'Продолжить прерванную работу\n\nи добавь тень под карточкой')
  assert.equal(queue.get('d1').resumeRunId, 'run-9', 'связь с прерванным ходом потерялась')
  // Точную формулировку скрытого запроса держит проводка, а не этот тест:
  // важно, что не потерялось ни опись, ни добавленное пожелание.
  const hidden = queue.get('d1').hidden
  assert.match(hidden, /ОПИСЬ: сделано 3 шага/, 'опись потерялась')
  assert.match(hidden, /добавь тень под карточкой/, 'набранное пожелание не доехало до хода')
})

check('второй прерванный ход не вытесняет уже поставленное продолжение', () => {
  const original = { ...queue.get('d1') }
  const accepted = queueDesignMessage('d1', {
    text: 'Продолжить другой ход', hidden: 'ДРУГАЯ ОПИСЬ', resumeRunId: 'run-10'
  })
  assert.equal(accepted, false, 'конфликтующие контрольные точки объединились')
  assert.deepEqual(queue.get('d1'), original, 'первое продолжение было потеряно')
})

check('у нового сообщения нет чужого хода', () => {
  queue.clear()
  queueDesignMessage('d2', { text: 'Просто просьба' })
  assert.deepEqual(queue.get('d2'), { text: 'Просто просьба', hidden: '', resumeRunId: '' })
  assert.equal(queuedFor(''), '', 'пустой id должен давать пустую строку')
})

// Дальше — что проводка действительно отдаёт очередь вместе с продолжением:
// иначе проверка выше верна, а окно всё равно шлёт сообщение с нуля.
check('очередь уходит следующим ходом с описью и id', () => {
  assert.match(code, /sendDesignMessage\(waiting\.text, \{[^}]*hidden: waiting\.hidden[^}]*resumeRunId: waiting\.resumeRunId/,
    'снятие очереди не передаёт ни опись, ни id хода')
})

check('занятый макет ставит в очередь продолжение, а не голую опись', () => {
  const busy = cut('          submit: (prompt, runId) => {', '        }))')
  assert.match(busy, /queueDesignMessage\(run\.designId,/, 'занятый макет не идёт через очередь-запись')
  assert.match(busy, /hidden: prompt, resumeRunId: runId/, 'в очередь не легли опись и id хода')
  assert.doesNotMatch(busy, /designQueue\.set\(/, 'опись вклеена в видимый текст очереди в обход записи')
})

check('прерванные ходы одного макета получают отдельные карточки', () => {
  const recovery = cut('  async function showInterruptedRuns() {', '  let commentPicking = false')
  assert.match(recovery, /designResumeCards\.has\(run\.runId\)/)
  assert.match(recovery, /designResumeCards\.set\(run\.runId, card\)/)
  assert.doesNotMatch(recovery, /designResumeCards\.has\(run\.designId\)/)
})

check('карточка продолжения остаётся доступной во время нового хода', () => {
  assert.match(code, /for \(const resume of designResumeCards\.values\(\)\)\s*\{\s*if \(resume\.dataset\.designId === activeDesign\?\.id\) host\.appendChild\(resume\)/)
  assert.doesNotMatch(code, /if \(resume && !designBusy\)/)
})

check('переход в макет обновляет только его очередь и продолжает отложенную работу', () => {
  const open = cut('  async function openDesign(id) {', '  function closeDesign()')
  assert.match(open, /renderDesignQueue\(\)/)
  assert.match(open, /startQueuedDesignIfReady\(\)/)
})

check('снятая с полосы очередь возвращает карточку прерванного хода', () => {
  assert.match(code, /if \(entry\?\.resumeRunId\) onDesignQueueDrop\?\.\(designId, entry\)/)
  assert.match(code, /onDesignQueueDrop: \(_designId, entry\) => \{\s*if \(entry\?\.resumeRunId\) void showInterruptedRuns\(\)/)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
