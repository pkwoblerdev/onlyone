// Поиск вынесен в отдельный поток (долг 6.1): главное окно не имеет права
// зависать на обходе дерева. Здесь проверяется настоящий worker и его таймаут.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { searchInWorker } = require('../src/main/search-service')
const direct = require('../src/main/workspace-search')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-worker-'))
for (let i = 0; i < 120; i++) {
  const file = path.join(root, 'src', `f${i}.js`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `const needle${i % 7} = ${i}\nвторая строка\n`)
}
fs.writeFileSync(path.join(root, 'src', 'target.js'), 'export const searchInWorker = true\n')
const cappedRoot = path.join(root, 'capped')
fs.mkdirSync(cappedRoot)
for (let i = 0; i < 251; i++) {
  fs.writeFileSync(path.join(cappedRoot, `match-${i}.txt`), 'needle-for-cap\n')
}
const roots = [{ root, label: '' }]

async function main() {
  await test('worker находит то же, что и прямой вызов', async () => {
    const inWorker = await searchInWorker({ roots, query: 'needle3' })
    const inline = await direct.search({ roots, query: 'needle3' })
    assert.deepEqual(inWorker.matches.map(m => `${m.file}:${m.line}`), inline.matches.map(m => `${m.file}:${m.line}`))
    assert.ok(inWorker.matches.length > 10, 'слишком мало совпадений для проверки')
    assert.equal(inWorker.stopped, null)
    assert.equal(inWorker.error, null)
  })

  await test('лимит совпадений сохраняет итоговые метаданные worker-а', async () => {
    const capped = await searchInWorker({
      roots: [{ root: cappedRoot, label: '' }], query: 'needle-for-cap', maxMatches: 200
    })
    assert.equal(capped.matches.length, 200)
    assert.equal(capped.files, 200)
    assert.equal(capped.truncated, true)
    assert.equal(capped.stopped, null)
    assert.equal(capped.error, null)
  })

  await test('таймаут обрывает обход, уже найденное остаётся', async () => {
    const started = Date.now()
    const result = await searchInWorker({ roots, query: 'searchInWorker', maxFiles: 20000 }, { timeoutMs: 1 })
    assert.equal(result.stopped, 'timeout')
    assert.equal(result.truncated, true, 'неполный ответ обязан быть помечен')
    assert.ok(Date.now() - started < 5000, `обход не оборвался: ${Date.now() - started} мс`)
  })

  await test('остановка части останавливает и поиск', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await searchInWorker({ roots, query: 'needle1' }, { signal: controller.signal })
    assert.equal(result.stopped, 'aborted')
  })

  await test('битое регулярное выражение возвращается причиной, а не молчанием', async () => {
    const result = await searchInWorker({ roots, query: '([unclosed', regex: true })
    assert.ok(result.error, 'ошибки нет')
    assert.match(result.error, /не разобрано/)
    assert.equal(result.matches.length, 0)
  })

  await test('поиск не держит главный поток занятым', async () => {
    // Если обход идёт в этом же потоке, таймер не сработает, пока он занят.
    let ticks = 0
    const ticker = setInterval(() => ticks++, 20)
    await searchInWorker({ roots, query: 'const', maxMatches: 500 })
    clearInterval(ticker)
    assert.ok(ticks >= 2, `поток был занят: тиков ${ticks}`)
  })

  // ── P1: цена патологического шаблона не должна доходить до таймаута ──────

  await test('патологический шаблон возвращен причиной за доли секунды, не за 25', async () => {
    // До правки такой шаблон исполнялся: одно ядро занято до истечения общего
    // таймаута (25 с), и модель могла позвать это снова. Теперь форма
    // отклоняется в рабочем потоке до обхода — проверке доступно только то,
    // что вызов вернулся быстро и с причиной.
    for (const query of ['(a+)+b', '(.*)*b', '(\\w+\\s?)+x']) {
      const started = Date.now()
      const result = await searchInWorker({ roots, query, regex: true })
      const ms = Date.now() - started
      assert.ok(result.error, `${query}: ошибки нет — значит перебор был`); assert.match(result.error, /не принято/)
      assert(ms < 5000, `${query}: вернулось через ${ms} мс — окно таймаута всё ещё жжётся`)
      assert.equal(result.matches.length, 0)
    }
  })

  await test('после обрыва по таймауту сервис отвечает и следующий поиск работает', async () => {
    let ticks = 0
    const ticker = setInterval(() => ticks++, 20)
    const stalled = await searchInWorker({ roots, query: 'const', maxFiles: 20000 }, { timeoutMs: 1 })
    assert.equal(stalled.stopped, 'timeout')
    const next = await searchInWorker({ roots, query: 'needle3' })
    assert.equal(next.error, null)
    assert.ok(next.matches.length > 10, `следующий поиск ничего не принёс: ${next.matches.length}`)
    clearInterval(ticker)
    assert.ok(ticks >= 3, `главный поток не отзывчив за время обрыва и следующего поиска: тиков ${ticks}`)
  })

  await test('сорванный на пробе шаблон возвращается причиной, а не молчанием', async () => {
    // Первые секунды поток занят проверкой чужого выражения, и срок у них
    // отдельный: иначе вызывающий получил бы пустой ответ без объяснения.
    const result = await searchInWorker({ roots, query: '(?:[a-z][0-9])+!', regex: true }, { timeoutMs: 1 })
    assert.equal(result.stopped, 'timeout')
    assert.ok(result.error, 'причины нет — модель увидит пустой ответ и решит, что совпадений нет')
    assert.match(result.error, /Шаблон не проверен/)
    assert.equal(result.matches.length, 0)
    const next = await searchInWorker({ roots, query: 'needle3' })
    assert.equal(next.error, null, 'после сора на пробе сервис должен снова искать')
    assert.ok(next.matches.length > 10)
  })

  await test('обрыв по таймауту не оставляет занятого потока', async () => {
    // Три поиска, оборванных на патологическом шаблоне, не должны сложиться в
    // три горящих ядра. Порог берётся не с потолка, а от собственного замера
    // простоя до издевательства: машина под нагрузкой не должна ронять
    // проверку, а живой поток добавил бы сюда все 400 мс.
    const idle = () => {
      const mark = process.cpuUsage()
      return new Promise(resolve => setTimeout(() => resolve(process.cpuUsage(mark).user / 1000), 400))
    }
    const baseline = await idle()
    for (let i = 0; i < 3; i++) {
      await searchInWorker({ roots, query: '(a+)+b', regex: true }, { timeoutMs: 40 })
    }
    const burned = await idle()
    assert(burned < baseline + 250,
      `после трёх обрывов процесс за 400 мс берёт ${burned.toFixed(0)} мс CPU против ${baseline.toFixed(0)} мс в покое — поток остался жив`)
  })

  // ── Надёжный потолок: у обхода два срока, и первый из них его собственный ──
  //
  // Убить поток можно, но убийством не отдашь `files` и `skipped`. Поэтому
  // сервис сообщает потоку бюджет — на запас короче таймера, — и обход обязан
  // остановиться сам. Проверки ниже различают два этих обрыва.

  const slowRoot = path.join(root, 'wide')
  fs.mkdirSync(slowRoot, { recursive: true })
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(slowRoot, `w${i}.txt`), `строка needle ${i}\n`)
  const slowRoots = [{ root: slowRoot, label: '' }]
  // Тот же каталог, названный несколько раз, — дешёвый способ сделать обход
  // длинным без раздувания проверочного дерева на диске.
  const longRoots = Array.from({ length: 40 }, () => ({ root: slowRoot, label: '' }))

  await test('обход останавливается сам и отдаёт найденное с метаданными, не дождавшись убийства', async () => {
    const full = await direct.search({ roots: longRoots, query: 'needle', maxMatches: 5000, budgetMs: Infinity })
    assert.equal(full.stopped, null, 'полный обход сам себя в бюджет не должен упирать')
    assert.ok(full.files > 3000, `дереву нужно быть заведомо длиннее бюджета: файлов ${full.files}`)

    const early = await searchInWorker({ roots: longRoots, query: 'needle', maxMatches: 5000, budgetMs: 300 }, { timeoutMs: 25000 })
    assert.equal(early.stopped, 'timeout', 'бюджетный обрыв наружу читается как таймаут: иного слова у главного процесса нет')
    assert(early.ms < 3000, `ответ пришёл через ${early.ms} мс — это убийство потоком, а не его собственный бюджет`)
    assert.equal(early.error, null)
    assert.equal(early.truncated, true)
    assert.ok(early.files > 0 && early.files < full.files,
      `файлов ${early.files} из ${full.files}: либо метаданные не дошли, либо обход не оборвался`)
    assert.ok(early.matches.length > 0, 'найденное обязано дойти до вызывающего')
    assert.deepEqual(early.matches, full.matches.slice(0, early.matches.length), 'отдано не начало полного ответа')
  })

  await test('запас между бюджетом и таймером работает без явного budgetMs', async () => {
    // Вызывающий (main.js) бюджет не передаёт — значит считать его обязан
    // сервис. Потолок 4 с, значит поток получает 1,5 с: идти 24 000 файлов
    // дольше шести секунд, поэтому выбора у него нет.
    const result = await searchInWorker({ roots: longRoots, query: 'нет-такого-слова' }, { timeoutMs: 4000 })
    assert.equal(result.stopped, 'timeout')
    assert(result.ms >= 1300 && result.ms < 3900,
      `бюджетный обрыв за 4000 мс таймера, получен ${result.ms} мс — запас не работает`)
    assert(result.files > 0, `бюджетный обрыв обязан принести файлы: ${result.files}`)
  })

  await test('таймер снаружи остаётся последним словом, когда бюджет длиннее', async () => {
    const result = await searchInWorker({ roots: slowRoots, query: 'needle', budgetMs: 20000 }, { timeoutMs: 20 })
    assert.equal(result.stopped, 'timeout')
    assert(result.ms < 5000, `поток не убит: ${result.ms} мс`)
    assert.equal(result.files, 0, 'kill метаданные не отдаёт — это и есть разница двух слоёв')
  })

  await test('счётчик обрезанных строк доживает до главного процесса через поток', async () => {
    // Semantics проверяются в test-workspace-search.cjs, здесь — что край-
    // чувствительный шаблон не начинает придумывать совпадения после перехода
    // в рабочий поток и что пропуск виден в ответе.
    const dir = path.join(root, 'anchors')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(1000) + 'needle\nconst q = 1\n')
    const result = await searchInWorker({ roots: [{ root: dir, label: '' }], query: 'x+$', regex: true })
    assert.equal(result.error, null)
    assert.deepEqual(result.matches.filter(m => m.file.endsWith('a.js') && m.line === 1), [],
      `поток придумал совпадение: ${JSON.stringify(result.matches.slice(0, 3))}`)
    assert.equal(result.skipped.long_regex_unchecked, 1, JSON.stringify(result.skipped))
    assert.equal(result.skipped.long_regex, 0, 'обрезка применена к шаблону, которому нельзя')
  })

  await test('«.*.*b» не держит поток боевые 25 с', async () => {
    // Тот самый шаблон из независимого аудита (cancel-cpu, C.1): фильтром он не
    // отклоняется, а один `re.test()` на длинной строке не прерывается ничем.
    // До правки цена вызова = весь потолок: 25 010 мс стены при 20 469 мс CPU
    // потока. Теперь строка целиком регулярке не отдаётся, а дорогой замер
    // обрывает обход — наружу это по-прежнему привычный 'timeout'.
    const heavy = path.join(root, 'minified')
    fs.mkdirSync(heavy, { recursive: true })
    const line = 'x'.repeat(3000) + '!'
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(heavy, `m${i}.js`), line + '\n')

    const started = Date.now()
    const result = await searchInWorker({
      roots: [{ root: heavy, label: '' }], query: '.*.*b', regex: true, maxMatches: 500
    })
    const ms = Date.now() - started
    assert.equal(result.stopped, 'timeout', 'обрыв есть, но назван он должен быть понятным главному процессу словом')
    assert(ms < 6000, `вызов занял ${ms} мс — потолок 25 с снова близко`)
    assert(result.files > 0, `обрыв штатный, метаданные обязаны дойти: файлов ${result.files}`)
    assert.equal(result.error, null)
    assert(result.skipped.slow_regex >= 1, `дорогих замеров не видно: ${JSON.stringify(result.skipped)}`)

    // И следом обычный поиск обязан работать как работал.
    const after = await searchInWorker({ roots, query: 'needle3' })
    assert.equal(after.error, null)
    assert.ok(after.matches.length > 10, `после обрыва сервис перестал искать: ${after.matches.length}`)
    assert.equal(after.stopped, null)
  })

  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
}

main().finally(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
