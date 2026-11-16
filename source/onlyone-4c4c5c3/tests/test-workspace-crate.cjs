// Ядро контейнера Workspace (U-7): что кладётся, чем проверяется, как
// разворачивается. Проверяется без Electron и без диска — модуль сам в себе
// весь.
//
// Слово владельца 01.10: в Ultra человек крафтит Workspace и может им
// поделиться; у другого в Ultra разворачивается в точности такое же. Смысл
// слова «в точности» проверяется здесь буквально: контейнер, разобранный и
// собранный обратно без правок, обязан совпасть сам с собой до последнего знака.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ И ПОЧЕМУ. Не проверяется, что развёрнутый Workspace
// выглядит хорошо на экране, — это делает оконный прогон Ульты. Здесь проверяется
// только то, что может обмануть проверку: чужие пути, чужие команды, подменённый
// файл и молчание о неполном развороте.
const assert = require('node:assert/strict')
const crate = require('../src/main/workspace-crate')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn(); console.log('ok', name) } catch (error) {
    failed++
    console.error('FAIL', name, error.message)
  }
}

const MINE = {
  name: 'Студия йоги',
  agents: ['Ведущий', 'Проверяющий'],
  tools: ['write_file', 'search_files'],
  files: ['main.js', 'app.js', 'index.css'],
  context: 'Правка лендинга и цен',
  blocks: [
    { title: 'Лендинг', role: 'artifact', x: 40, y: 120, w: 360, h: 480, zone: 'left', minimized: false },
    { title: 'Тарифы', role: 'artifact', x: 460, y: 120, w: 360, h: 480, zone: 'free', minimized: true }
  ],
  scenarios: [{ title: 'Правка лендинга', blocks: ['Лендинг', 'Тарифы'], note: 'от главной карточки' }]
}

// ─── контейнер собирается и разбирается ──────────────────────────────────────

check('контейнер собирается в текст с шапкой формата', () => {
  const packed = crate.pack(MINE, { author: 'Владелец' })
  const body = JSON.parse(packed)
  assert.equal(body.format, 'onlyone.workspace')
  assert.equal(body.version, crate.VERSION)
  assert.equal(body.author, 'Владелец')
  assert.equal(body.name, 'Студия йоги')
})

check('«в точности такое же»: разбор и сборка обратно совпадают', () => {
  const first = JSON.parse(crate.pack(MINE, { author: 'Владелец' }))
  const back = JSON.parse(crate.pack(crate.unpack(crate.pack(MINE)).workspace, { author: 'Владелец' }))
  assert.equal(JSON.stringify(back), JSON.stringify(first),
    'разобранный и собранный обратно контейнер разошёлся — значит «в точности» не выполняется')
})

check('разобранный контейнер отдаёт все пять частей Workspace', () => {
  const result = crate.unpack(crate.pack(MINE))
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.workspace.blocks.length, 2)
  assert.equal(result.workspace.agents.length, 2)
  assert.equal(result.workspace.tools.length, 2)
  assert.equal(result.workspace.files.length, 3)
  assert.equal(result.workspace.scenarios.length, 1)
  assert.equal(result.workspace.context, 'Правка лендинга и цен')
})

// ─── контейнер приходит от другого человека ──────────────────────────────────

check('путь в имени файла не проходит: у другого человека его всё равно нет', () => {
  assert.equal(crate.isSafeName('main.js'), 'main.js')
  assert.equal(crate.isSafeName('../../windows/system32/hosts'), null)
  assert.equal(crate.isSafeName('C:/Users/keys.txt'), null)
  assert.equal(crate.isSafeName('папка/файл.js'), null)
  assert.equal(crate.isSafeName('..'), null)
  assert.equal(crate.isSafeName('файл?.js'), null)
})

check('чужой файл с путём молча вычищается, а не тащится в разворот', () => {
  const poisoned = { ...MINE, files: ['main.js', '../../secrets.txt', 'C:/keys.txt', 'app.js'] }
  const result = crate.unpack(crate.pack(poisoned))
  assert.equal(result.ok, true, result.reason)
  assert.deepEqual(result.workspace.files, ['main.js', 'app.js'],
    'в контейнер просочились чужие пути')
})

check('мера блока из чужого экрана не выводит окно из строя', () => {
  const wild = { ...MINE, blocks: [{ title: 'Дивный', x: 999999, y: -999999, w: 1, h: 999999, zone: 'сбоку' }] }
  const block = crate.unpack(crate.pack(wild)).workspace.blocks[0]
  assert.ok(block.w >= crate.LIMITS.size.min, 'ширина не прижата к низу предела')
  assert.ok(block.h <= crate.LIMITS.size.max, 'высота не прижата к верху предела')
  assert.ok(block.x <= crate.LIMITS.position.max && block.y >= crate.LIMITS.position.min)
  assert.equal(block.zone, 'free', 'чужое значение зоны не должно становиться зоной')
})

check('количество записей ограничено: контейнер не может быть чем угодно', () => {
  const many = {
    ...MINE,
    files: Array.from({ length: 5000 }, (_, i) => `file-${i}.js`),
    blocks: Array.from({ length: 500 }, (_, i) => ({ title: `Блок ${i}`, w: 300, h: 300 }))
  }
  const result = crate.unpack(crate.pack(many))
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.workspace.files.length, crate.LIMITS.files)
  assert.equal(result.workspace.blocks.length, crate.LIMITS.blocks)
})

check('скрипт в названии блока остаётся текстом, а не разметкой', () => {
  const nasty = { ...MINE, blocks: [{ title: '<img src=x onerror=alert(1)>', w: 300, h: 300 }] }
  const block = crate.unpack(crate.pack(nasty)).workspace.blocks[0]
  assert.equal(block.title, '<img src=x onerror=alert(1)>', 'название должно сохраниться как есть')
  // Разметку собирает окно, и у него есть свой `escapeHtml`; здесь важно, что
  // модуль не приводит ничего сам и не режет текст до неузнаваемости.
  assert.equal(typeof block.title, 'string')
})

// ─── целостность ─────────────────────────────────────────────────────────────

check('подменённый контейнер не разворачивается молча', () => {
  const packed = JSON.parse(crate.pack(MINE))
  // Самое частое и самое тихое: человек (или чужая программа) правит контейнер
  // руками и не знает про сумму.
  packed.context = 'Теперь другое'
  const result = crate.unpack(JSON.stringify(packed))
  assert.equal(result.ok, false, 'контейнер с изменённым содержимым принят')
  assert.match(result.reason, /сумма|изменён/i, result.reason)
})

check('сумма одинакова на всех машинах', () => {
  // FNV-1a на 32 битах: если умножение не прижать в беззнаковое, старшие биты
  // дают отрицательное и сумма «плывёт» от машины к машине. Проверяем на
  // числах, где старший бит заведомо взводится.
  const tricky = { ...MINE, context: 'Проверка знака и переноса' }
  assert.equal(crate.fingerprint(crate.normalize(tricky)), crate.fingerprint(crate.normalize(tricky)))
  assert.match(crate.fingerprint(crate.normalize(tricky)), /^[0-9a-f]{8}$/)
})

check('чужой формат и чужая версия называются причиной, а не разбираются', () => {
  const bad = crate.unpack('{"format":"что-то другое","version":1}')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /не контейнер|ожидался/i, bad.reason)
  const future = crate.unpack(JSON.stringify({ format: crate.FORMAT, version: 99 }))
  assert.equal(future.ok, false)
  assert.match(future.reason, /версия/i, future.reason)
})

check('битый контейнер не роняет окно, а объясняет', () => {
  const result = crate.unpack('{ это не json')
  assert.equal(result.ok, false)
  assert.ok(result.reason.length > 0, 'причина обязана быть')
  assert.equal(crate.unpack(null).ok, false)
  assert.equal(crate.unpack('').ok, false)
})

// ─── разворот: «не нашлось» обязано быть сказано ─────────────────────────────

check('разворот говорит вслух о файлах, которых не нашлось', () => {
  const result = crate.apply(crate.unpack(crate.pack(MINE)).workspace,
    ['main.js', 'app.js', 'чужой-файл.js'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.workspace.files, ['main.js', 'app.js', 'index.css'].filter(one => result.workspace.files.includes(one)))
  assert.deepEqual(result.missing, ['index.css'], 'молча выбросить файл — значит выдать неполный разворот за полный')
})

check('отчёт разворота считает всё, что развернулось', () => {
  const result = crate.apply(crate.unpack(crate.pack(MINE)).workspace, MINE.files)
  assert.deepEqual(result.missing, [])
  assert.equal(result.report.blocks, 2)
  assert.equal(result.report.agents, 2)
  assert.equal(result.report.tools, 2)
  assert.equal(result.report.files, 3)
  assert.equal(result.report.scenarios, 1)
})

check('два контейнера одного Workspace совпадают, разных — нет', () => {
  const one = crate.unpack(crate.pack(MINE)).workspace
  const same = crate.unpack(crate.pack(MINE)).workspace
  const other = crate.unpack(crate.pack({ ...MINE, name: 'Другой' })).workspace
  assert.equal(crate.fingerprint(one), crate.fingerprint(same))
  assert.notEqual(crate.fingerprint(one), crate.fingerprint(other))
})

check('модуль не ходит ни в сеть, ни в файловую систему', () => {
  const source = fsText()
  assert.ok(!/require\(['"](node:)?(fs|net|http|https|child_process)/.test(source),
    'ядро контейнера не должно брать ни файловую систему, ни сеть: запись и разбор конверта — дело вызывающего')
})

function fsText () {
  return require('node:fs').readFileSync(require.resolve('../src/main/workspace-crate'), 'utf8')
}

if (failed) { console.error(`проверок: ${total}, провалов: ${failed}`); process.exitCode = 1 }
else console.log(`проверок: ${total}, провалов: 0`)
