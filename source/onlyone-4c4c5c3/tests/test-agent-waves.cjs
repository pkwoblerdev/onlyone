// Кто может работать одновременно и кто из-за кого простаивает.
//
// Сначала помощники шли строго по очереди: трое по четверти часа — сорок пять
// минут, и всё это время человек смотрел на одну работающую модель, хотя
// «прочитать одно и описать» и «прочитать другое и описать» не мешают друг
// другу ничем. Потом появились волны, и стало лучше, но между волнами остался
// барьер: кто закончил за минуту, ждал того, кто работает двадцать.
//
// Теперь барьера нет: часть уходит в работу ровно тогда, когда стала возможной.
// Правило совместимости одно и живёт в readyFor — здесь проверяется и оно само,
// и то, что диспетчер из него следует.
//
// Осторожность несимметрична, и тесты про это. Лишняя очередь стоит времени.
// Лишняя одновременность стоит испорченного файла, и вернуть его нельзя.
const fs = require('node:fs')
const path = require('node:path')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const cut = (from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return source.slice(a, b)
}

const readyFor = new Function(
  cut('function readyFor(item, state)', 'function assignWorkSchema') + '; return readyFor')()

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const part = (agent, extra = {}) => ({
  agent, task: 'часть ' + agent, readOnly: true, after: [], files: [], ...extra
})

// Точная копия расписания диспетчера, но со временем вместо моделей: части
// «работают» столько тактов, сколько сказано. Так видно не только кто с кем
// совместим, но и кто кого ждёт зря.
function simulate(items, durations = {}) {
  const pending = items.slice()
  const state = { done: new Set(), held: new Set(), blind: false, busy: 0 }
  const inflight = []
  const started = new Map()
  let clock = 0
  let guard = 0

  const launch = item => {
    state.busy += 1
    if (item.readOnly === false) {
      if (!item.files.length) state.blind = true
      for (const file of item.files) state.held.add(file)
    }
    started.set(item.agent, clock)
    inflight.push({ item, endsAt: clock + (durations[item.agent] ?? 1) })
  }

  while ((pending.length || inflight.length) && guard++ < 64) {
    for (let i = 0; i < pending.length;) {
      if (!readyFor(pending[i], state)) { i += 1; continue }
      launch(pending.splice(i, 1)[0])
    }
    if (!inflight.length) {
      if (!pending.length) break
      launch(pending.shift())
      if (!inflight.length) break
    }
    const soonest = Math.min(...inflight.map(one => one.endsAt))
    clock = soonest
    for (const one of inflight.filter(one => one.endsAt === soonest)) {
      inflight.splice(inflight.indexOf(one), 1)
      state.busy -= 1
      state.done.add(one.item.agent)
      if (one.item.readOnly === false) {
        if (!one.item.files.length) state.blind = false
        for (const file of one.item.files) state.held.delete(file)
      }
    }
  }
  return { started, finishedAt: clock }
}

const startsOf = (items, durations) => {
  const { started } = simulate(items, durations)
  return [...started.entries()].map(([agent, at]) => agent + '@' + at).join(' ')
}

for (const [file, held] of [
  ['src/a.js', 'SRC\\a.js'], ['src/a.js', 'src/other/../a.js'],
  ['src/a.js', 'src'], ['src', 'src/a.js'], ['src/a.js', 'src/*.js']
]) {
  check('пересечение путей: ' + file + ' / ' + held,
    !readyFor(part(3, { readOnly: false, files: [file] }),
      { done: new Set(), held: new Set([held]), blind: false, busy: 1 }))
}
check('похожее имя папки не конфликтует', readyFor(part(3, { readOnly: false, files: ['src-old/a.js'] }),
  { done: new Set(), held: new Set(['src']), blind: false, busy: 1 }))

// --- независимое идёт вместе ---------------------------------------------------

check('три чтения начинаются одновременно',
  startsOf([part(2), part(3), part(4)]) === '2@0 3@0 4@0',
  startsOf([part(2), part(3), part(4)]))

check('пустой список ничего не запускает', simulate([]).started.size === 0)

// --- главное: никто не ждёт зря -------------------------------------------------
//
// Ровно то, ради чего барьер убирали. Короткая часть, ставшая возможной, не ждёт
// конца длинной соседки: при барьере она начиналась бы на такте 20.

const noBarrier = simulate(
  [part(2), part(3), part(4, { after: [2] })],
  { 2: 1, 3: 20, 4: 1 })
check('короткая часть не ждёт длинную соседку',
  noBarrier.started.get(4) === 1, 'началась на такте ' + noBarrier.started.get(4))
check('круг кончается по самой длинной, а не по сумме',
  noBarrier.finishedAt === 20, String(noBarrier.finishedAt))

// --- объявленная зависимость соблюдается ---------------------------------------

const chained = simulate([part(2), part(3, { after: [2] }), part(4, { after: [3] })])
check('цепочка остаётся цепочкой',
  chained.started.get(2) === 0 && chained.started.get(3) === 1 && chained.started.get(4) === 2,
  JSON.stringify([...chained.started]))

const forked = simulate([part(2), part(3), part(4, { after: [2, 3] })], { 2: 1, 3: 5 })
check('общий потребитель ждёт обоих, а не первого',
  forked.started.get(4) === 5, 'началась на такте ' + forked.started.get(4))

const late = simulate([part(4, { after: [2] }), part(2), part(3)])
check('порядок в списке не решает, решают предпосылки',
  late.started.get(2) === 0 && late.started.get(3) === 0 && late.started.get(4) === 1,
  JSON.stringify([...late.started]))

// --- пишущие осторожнее --------------------------------------------------------

const twoWriters = simulate([
  part(2, { readOnly: false, files: ['src/a.js'] }),
  part(3, { readOnly: false, files: ['src/b.js'] })
])
check('пишущие в разные файлы идут вместе',
  twoWriters.started.get(2) === 0 && twoWriters.started.get(3) === 0)

const clashing = simulate([
  part(2, { readOnly: false, files: ['src/a.js', 'src/shared.js'] }),
  part(3, { readOnly: false, files: ['src/shared.js'] })
])
check('пишущие в общий файл расходятся во времени',
  clashing.started.get(3) === 1, 'началась на такте ' + clashing.started.get(3))

const blind = simulate([
  part(2, { readOnly: false, files: [] }),
  part(3, { readOnly: false, files: ['src/b.js'] }),
  part(4)
])
check('пишущий без объявленных границ идёт один',
  blind.started.get(2) === 0 && blind.started.get(3) === 1 && blind.started.get(4) === 1,
  JSON.stringify([...blind.started]))
check('к пишущему без границ не подсаживается даже читатель',
  readyFor(part(9), { done: new Set(), held: new Set(), blind: true, busy: 1 }) === false)

const readerWithWriter = simulate([
  part(2, { readOnly: false, files: ['src/a.js'] }),
  part(3),
  part(4)
])
check('чтение идёт вместе с записью в известные границы',
  readerWithWriter.started.get(3) === 0 && readerWithWriter.started.get(4) === 0)

// --- расписание не теряет и не зацикливается -----------------------------------

const cyclic = simulate([part(2, { after: [3] }), part(3, { after: [2] })])
check('круг зависимостей не вешает расписание', cyclic.started.size === 2,
  JSON.stringify([...cyclic.started]))

const many = simulate(Array.from({ length: 8 }, (_, i) => part(i + 2)))
check('восемь независимых частей стартуют разом',
  [...many.started.values()].every(at => at === 0))

const mixed = simulate([
  part(2), part(3, { after: [2] }), part(4), part(5, { readOnly: false, files: [] })
])
check('ничего не теряется при смешанном раскладе', mixed.started.size === 4,
  JSON.stringify([...mixed.started]))

// --- ход действительно так и работает -------------------------------------------

const mode = cut('async function runAgentMode(event', '\n// A tool call written')
check('диспетчер запускает всё, что стало возможным',
  /if \(!readyFor\(pending\[i\], state\)\) \{ i \+= 1; continue \}/.test(mode))
check('барьера между волнами больше нет',
  !/await Promise\.all\(running\)/.test(mode) && /await Promise\.race\(/.test(mode))
check('освободившиеся файлы возвращаются в оборот',
  /state\.held\.delete\(file\)/.test(mode) && /state\.blind = false/.test(mode))
check('упавшая часть не роняет остальные', /if \(error\) \{[\s\S]{0,900}continue/.test(mode))
check('отмена внутри доводится наверх', /if \(aborted \|\| signal\?\.aborted\)/.test(mode))
check('соседи считаются в момент запуска, а не заранее',
  /const neighbours = \[\.\.\.inflight\]/.test(mode))

// --- поручение умеет объявить зависимость и границы -----------------------------

const schema = cut('function assignWorkSchema(helperCount)', 'function recordAssignment')
check('в схеме есть зависимость', /after: \{/.test(schema))
check('в схеме есть границы файлов', /files: \{/.test(schema))
check('лишняя зависимость названа вредной',
  /лишняя превращает работу команды обратно в очередь/.test(schema))
check('зависимость на себя отбрасывается', /filter\(n => n !== agent\)/.test(source))
check('границы файлов приводятся к одному виду', /toLowerCase\(\)\)\.filter\(Boolean\)/.test(source))
check('мёртвого расписания волнами не осталось', !/planWaves/.test(source))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
require('./test-dispatch-runtime.cjs')
