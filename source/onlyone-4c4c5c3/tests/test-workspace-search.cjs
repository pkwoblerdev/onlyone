// Поиск по рабочей папке (план, 6.1) на настоящем дереве во временном каталоге.
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('node:os')
const path = require('node:path')
const { search, globToRegExp, assertSafePattern, MAX_REGEX_LINE_CHARS } = require('../src/main/workspace-search')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-'))
const write = (rel, text) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
write('src/main.js', 'const needle = 1\nдругая строка\nNEEDLE в верхнем регистре\n')
write('src/deep/nested/util.js', 'тут тоже needle\n')
write('src/readme.md', 'needle в markdown\n')
write('node_modules/pkg/index.js', 'needle который нельзя найти\n')
write('.git/config', 'needle из .git\n')
write('src/twemoji.ttf', 'needle в шрифте\n')
write('data/blob.dat', Buffer.concat([Buffer.from('needle тут\n'), Buffer.alloc(32, 0)]))
fs.mkdirSync(path.join(root, 'img'), { recursive: true })
fs.writeFileSync(path.join(root, 'img', 'pic.png'), Buffer.concat([Buffer.from('needle'), Buffer.alloc(64, 0)]))

const roots = [{ root, label: '' }]
const filesOf = found => [...new Set(found.matches.map(item => item.file.replace(/\\/g, '/')))].sort()

async function main() {
  await test('находит текст и не лезет в служебное', async () => {
    const found = await search({ roots, query: 'needle' })
    assert.deepEqual(filesOf(found), ['src/deep/nested/util.js', 'src/main.js', 'src/readme.md'])
    assert.equal(found.matches.filter(item => /main\.js/.test(item.file)).length, 2, 'в main.js два совпадения, регистр не важен')
  })

  await test('учётный регистр находит только точные', async () => {
    const found = await search({ roots, query: 'NEEDLE', ignoreCase: false })
    assert.equal(found.matches.length, 1)
    assert.equal(found.matches[0].line, 3)
  })

  await test('фильтр по маске и по подпапке', async () => {
    const js = await search({ roots, query: 'needle', glob: '*.js' })
    assert.deepEqual([...new Set(js.matches.map(m => m.file.replace(/\\/g, '/')))].sort(), ['src/deep/nested/util.js', 'src/main.js'])
    const nested = await search({ roots, query: 'needle', in: 'src/deep' })
    assert.equal(nested.matches.length, 1)
  })

  await test('регулярное выражение и ошибка в нём', async () => {
    const re = await search({ roots, query: 'const\\s+\\w+\\s*=', regex: true })
    assert.equal(re.matches.length, 1)
    assert.match(re.matches[0].text, /const needle/)
    await assert.rejects(() => search({ roots, query: '([unclosed', regex: true }), /не разобрано/)
  })

  await test('двоичное и служебные расширения пропускаются', async () => {
    const found = await search({ roots, query: 'needle' })
    assert.ok(found.skipped.binary >= 1, 'файл с NUL внутри должен отвестись как двоичное')
    assert.ok(!found.matches.some(m => /\.(ttf|png|dat)$/.test(m.file)), 'в ответе их нет')
  })

  await test('потолок совпадений работает и помечен', async () => {
    const found = await search({ roots, query: 'needle', maxMatches: 1 })
    assert.equal(found.matches.length, 1)
    assert.equal(found.truncated, true)
  })

  await test('один glob ищет по имени файла и не читает содержимое', async () => {
    const found = await search({ roots, query: '', glob: 'util.js' })
    assert.deepEqual(filesOf(found), ['src/deep/nested/util.js'])
    assert.equal(found.matches[0].line, 0, 'line: 0 означает «совпало имя», а не строка')
    assert.equal(found.matches[0].text, '')
  })

  await test('без query и без glob — понятный отказ', async () => {
    await assert.rejects(() => search({ roots, query: '  ' }), /Нужен query или glob/)
  })

  await test('части приходят по дороге и ничего не теряется', async () => {
    const wide = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-batch-'))
    for (let i = 0; i < 260; i++) {
      fs.mkdirSync(path.join(wide, 'src'), { recursive: true })
      fs.writeFileSync(path.join(wide, 'src', `b${i}.js`), `needle ${i}\n`)
    }
    const batches = []
    const found = await search({ roots: [{ root: wide, label: '' }], query: 'needle', onBatch: part => batches.push(part.length) })
    fs.rmSync(wide, { recursive: true, force: true })
    assert.ok(batches.length >= 2, `частей всего ${batches.length}: отдаём всё одним куском`)
    assert.equal(batches.reduce((a, b) => a + b, 0), found.matches.length, 'часть частей потеряна')
  })

  await test('маска собирается в корректное выражение', () => {
    assert.ok(globToRegExp('*.js').test('src/deep/nested/util.js'))
    assert.ok(globToRegExp('src/**/*.cjs').test('src/main/a.cjs'))
    assert.ok(!globToRegExp('*.js').test('a.jsx'))
  })

  // ── P1: регулярное выражение от модели не должно вешать обход ────────────
  //
  // Замер до правки: `(a+)+b` по строке из 26 символов — 7,4 с на том потоке,
  // где идёт поиск; на 40 символах перебор не кончается. В приложении поиск
  // живёт в рабочем потоке с таймаутом, поэтому окно не замерзало, но ядро
  // держалось до 25 с на каждый вызов, и модель могла звать это снова.

  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-redos-'))
  fs.mkdirSync(path.join(evil, 'src'), { recursive: true })
  fs.writeFileSync(path.join(evil, 'src', 'evil.js'), 'a'.repeat(26) + 'c\n')
  const evilRoots = [{ root: evil, label: '' }]

  await test('патологический шаблон отклонён до обхода, а не исполняется', async () => {
    for (const query of ['(a+)+b', '(a*)*b', '(.*)*b', '(\\w+\\s?)+x', '(x+x+)+y', '(a|ab)+b', '(a|aa|aaa)+b']) {
      const started = Date.now()
      await assert.rejects(() => search({ roots: evilRoots, query, regex: true }), /не принято/, `пропущен опасный шаблон ${query}`)
      const ms = Date.now() - started
      assert(ms < 500, `${query}: отказ занял ${ms} мс — значит перебор всё-таки начался`)
    }
    // На том же дереве без защиты один такой шаблон стоил 7,4 с.
  })

  await test('обычные шаблоны модельных запросов проходят и находят', async () => {
    write('src/patterns.js', 'export function findMe(a) {\n  const v = 1\n  // TODO: здесь нужен тест\n}\n')
    const accepted = ['^export\\s+(function|const)\\s+\\w+', '\\d{3}-\\d{4}', '(get|post|put)+\\s+/api',
      '[\\w.-]+\\.(js|cjs|mjs)', '(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)', '(a|b|c){2}', 'search\\w*\\(', '(?:^|\\s)@\\w+']
    for (const query of accepted) assertSafePattern(query, 'i')
    const found = await search({ roots, query: '^\\s*(const|export)\\b', regex: true })
    assert.ok(found.matches.length >= 2, 'обычное выражение стало находить меньше: ' + found.matches.length)
    const todo = await search({ roots, query: '(TODO|FIXME):?\\s', regex: true })
    assert.equal(todo.matches.length, 1)
    fs.rmSync(evil, { recursive: true, force: true })
  })

  await test('длинное выражение отклоняется, а не разбирается', () => {
    assert.throws(() => assertSafePattern('a'.repeat(500) + '|b'), /длиннее 400 знаков/)
  })

  // ── Проба сама может быть тем перебором, который ловит ────────────────────
  //
  // Проба — это исполнение чужого выражения до первого файла. Замер 24.09:
  // «(a|a|a)+b» на 22 знаках — 218 с, «(a?){40,}b» на 14 не разбирался и за 4.
  // Такие формы теперь отсекаются по строению, и проверить это можно только
  // временем: если отказ вернулся за миллисекунды, перебор не начинался.

  await test('висящие на пробе формы отклоняются по строению, а не временем', () => {
    const hangs = ['(a?){40,}b', '(a?b?){30,}c', '(a|a|a)+b', '(?:\\s|\\s|\\s|\\s|\\s|\\s)+x',
      '(?:[a-z][a-z]?)+!', '(?:[a-z][a-z]?){100,}!', '(a?|a{8})+b']
    for (const query of hangs) {
      const started = Date.now()
      assert.throws(() => assertSafePattern(query), /не принято|группа|пустот|соседние|одинаковые/, `пропущен ${query}`)
      const ms = Date.now() - started
      assert(ms < 400, `${query}: отказ занял ${ms} мс — значит проба всё-таки исполняла шаблон`)
    }
  })

  await test('обычные последовательности новых правил не боятся', () => {
    for (const query of ['(?:ab)+', '(?:ab?c)+', '(?:[a-z]{2})+', '(?:\\d\\.){2,4}', '(a|b|c){2,3}',
      '(?:[a-z][0-9])+', 'colou?r', '(?:https?)://[^\\s"]+', '\\b(v\\d+\\.\\d+)\\b']) {
      assertSafePattern(query, 'i')
    }
  })

  await test('открытый риск записан исполняемо: «.*.*b» фильтром не отклоняется', () => {
    // Не победа, а граница, и пусть она будет видна в тесте, а не только в
    // комментариях. Выражение без групп вовсе: форма его не смотрит (правила
    // работают по группам), проба на 22 знаках его не чувствует. Независимый
    // аудит 24.09 (cancel-cpu, C.1): 800 знаков → 92 мс, 1600 → 755 мс,
    // 3200 → больше 6 с, показатель k≈2,9–3,1; экстраполяция на разрешённую
    // строку в 2 МиБ — 9,5·10⁵ часов. С тех пор держат два новых слоя: строка
    // целиком регулярке не отдаётся (MAX_REGEX_LINE_CHARS) и дорогой замер
    // обрывает обход (SLOW_TEST_MS) — см. две проверки ниже. Сам фильтр не
    // ослаблен и не усилен: этот тест просит убрать запись, только если
    // «.*.*b» начнёт отклоняться, — тогда изменится поведение для модели.
    assertSafePattern('.*.*b')
  })

  // ── Стоимость ОДНОГО вызова регулярки ────────────────────────────────────
  //
  // Прервать `re.test()` из своего потока нельзя, поэтому ограничивают вход и
  // следят за ценой: длинная строка отдаётся по начало, а замер дороже
  // SLOW_TEST_MS обрывает обход.

  const long = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-longline-'))
  const heavyLine = 'x'.repeat(3000) + '!'
  fs.writeFileSync(path.join(long, 'min.js'), [
    'const needle = 1', heavyLine, heavyLine, heavyLine, 'x'.repeat(5000) + 'needle'
  ].join('\n'))
  const longRoots = [{ root: long, label: '' }]

  await test('длинная строка целиком регулярке не отдаётся, и потеря посчитана', async () => {
    const found = await search({ roots: longRoots, query: 'needle', regex: true })
    assert.equal(found.matches.length, 1, 'совпадение в начале файла находить обязаны')
    assert.ok(found.skipped.long_regex >= 3, `строки-простыни не посчитаны: ${JSON.stringify(found.skipped)}`)
    assert.equal(found.skipped.long_regex_unchecked, 0, 'без привязки к правому краю ничего не пропускается')
    assert.equal(found.stopped, null, 'три дешёвых замера — не повод обрывать обход')
    // Тот же запрос подстрокой кап не трогает: линейный поиск дешёв, и резать
    // его не за что.
    const plain = await search({ roots: longRoots, query: 'needle' })
    assert.equal(plain.matches.length, 2, 'подстрока обязана видеть и хвост длинной строки')
    assert.equal(plain.skipped.long_regex, 0, 'подстроку капировать нельзя')
  })

  // ── Семантика на обрезанном входе: потерять можно, придумать — нельзя ─────
  //
  // Отрезок строки — это конец ввода для движка, и «$», «\b», «\B», look-around
  // про этот конец спрашивают. До правки `/x+$/` на строке из 1000 «x» и «needle»
  // в хвосте отвечал «совпало»: во всей строке совпадения нет, а на отрезке
  // «xxxx…» есть. Проверка начинается с этого факта, а не с него завершается.

  await test('якорь $ на обрезанной строке совпадения не придумывает', async () => {
    const line = 'x'.repeat(MAX_REGEX_LINE_CHARS) + 'needle'
    // Тот же тест на том же входе без движка: иначе проверка могла бы пройти
    // просто потому, что шаблон плохой.
    assert.equal(new RegExp('x+$').test(line), false, 'во всей строке совпадения быть не должно')
    assert.equal(new RegExp('x+$').test(line.slice(0, MAX_REGEX_LINE_CHARS)), true, 'на обрезке оно появляется — значит тест про это')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-anchor-'))
    fs.writeFileSync(path.join(dir, 'a.js'), line + '\nconst q = 1\n')
    try {
      for (const query of ['x+$', 'x+\\b', 'x+\\B', '(?=n)x+', '(?:x)+$', 'needle$']) {
        const found = await search({ roots: [{ root: dir, label: '' }], query, regex: true })
        assert.deepEqual(found.matches.filter(m => m.line === 1), [],
          `${query}: ложное совпадение в первой строке (${JSON.stringify(found.matches)})`)
        assert.equal(found.skipped.long_regex_unchecked, 1, `${query}: пропуск посчитан, а не потерян молча`)
        assert.equal(found.skipped.long_regex, 0, `${query}: обрезка применена к краю-чувствительному шаблону`)
        assert.ok(found.matches.length <= 1, `${query}: находить можно только то, что действительно есть`)
      }
      // Та же запись в дереве без простыней работает как раньше: запрет касается
      // только длинных строк, а не шаблонов с «$» вообще.
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-anchor-short-'))
      fs.writeFileSync(path.join(plainDir, 'b.js'), 'const q = 1\nxneedle\n')
      const plainRoots = [{ root: plainDir, label: '' }]
      const normal = await search({ roots: plainRoots, query: '1$', regex: true })
      assert.equal(normal.matches.length, 1, 'короткая строка с «$» обязана находиться')
      assert.equal(normal.skipped.long_regex_unchecked, 0, 'без простыней ничего не пропускается')
      const tail = await search({ roots: plainRoots, query: 'needle$', regex: true })
      assert.equal(tail.matches.length, 1, '«$» в конце настоящей строки находится')
      assert.equal(tail.skipped.long_regex_unchecked, 0)
      fs.rmSync(plainDir, { recursive: true, force: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('левый край на обрезке не врёт: ^ находит, класс [$] не мешает', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-anchor-left-'))
    fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(MAX_REGEX_LINE_CHARS) + 'needle\n')
    try {
      const roots = [{ root: dir, label: '' }]
      const caret = await search({ roots, query: '^x+', regex: true })
      assert.equal(caret.matches.length, 1, '«^» от обрезки слева не зависит — находить обязано')
      assert.equal(caret.skipped.long_regex, 1, 'строка всё равно посчитана обрезанной')
      assert.equal(caret.skipped.long_regex_unchecked, 0, '«^» не край правого края')
      const classed = await search({ roots, query: '[$]', regex: true })
      assert.equal(classed.skipped.long_regex_unchecked, 0, '«$» внутри класса — обычный знак')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('дорогой замер обрывает обход, а не растягивает его на потолок', async () => {
    const started = Date.now()
    const found = await search({ roots: longRoots, query: '.*.*b', regex: true, maxMatches: 500 })
    const ms = Date.now() - started
    assert.equal(found.stopped, 'costly', `обход дожил до конца за ${ms} мс — стража нет`)
    assert(ms < 5000, `обрыв стоил ${ms} мс — вместо потока с 25 с получился поток с ${ms} мс`)
    assert.equal(found.truncated, true, 'ответ неполный, и обязан этим быть помечен')
    assert.ok(found.skipped.slow_regex >= 1, `дорогих замеров не посчитано: ${JSON.stringify(found.skipped)}`)
    assert.ok(!found.error, 'это не ошибка: найденное и метаданные должны дойти')
    fs.rmSync(long, { recursive: true, force: true })
  })

  await test('цепочка ** в маске не раздувает перебор', () => {
    // Glob модель пишет звёздочками охотно; проверка нужна, чтобы не
    // оказалось, что защита на regex обходится маской.
    const re = globToRegExp('**/**/**/**/**/**/**/**')
    const started = process.hrtime.bigint()
    assert.equal(re.test('a/'.repeat(120) + 'zzz'), true)
    assert(Number(process.hrtime.bigint() - started) / 1e6 < 20, 'маска с восемью ** стоит дороже 20 мс')
  })

  // ── Маска — второй вход регулярки, и она была без охраны ─────────────────
  //
  // Замер до правки: «**/**/**/**/zzz» на пути из 150 знаков — 2,4 с, из 200 —
  // больше 8 с; «*a*a*a*a*a*a*a*a*z» на имени из 300 знаков не кончался и за 8.
  // Проверяется это внутри обхода на каждом файле, и остановить один такой
  // вызов из потока нельзя — ни бюджетом, ни сигналом.

  await test('несколько ** подряд дороже одиночной не становятся', async () => {
    for (const mask of ['**/**/**/**/zzz', '**/**/**/**/**/**/**/**/**/zzz', 'a/**/b/**/c/**/z', '**/**/*']) {
      const started = Date.now()
      const found = await search({ roots, query: '', glob: mask, maxMatches: 50 })
      assert(Date.now() - started < 400, `${mask}: обход занял ${Date.now() - started} мс`)
      assert.equal(found.error, undefined, `${mask}: обход вернул ошибку`)
      assert.equal(found.stopped, null, `${mask}: обход упёрся в бюджет — значит перебор всё-таки был`)
    }
    // Смысл при этом не должен испариться: «**» — про ноль и больше папок.
    assert.ok(globToRegExp('**/*.cjs').test('tests/a/b/x.cjs'))
    assert.ok(globToRegExp('src/**/*.js').test('src/deep/nested/util.js'))
    assert.ok(globToRegExp('src/**').test('src/main.js'))
    assert.ok(!globToRegExp('**/util.js').test('src/utils.js'))
  })

  await test('маска, которая перебирает имя файла, отклоняет его до обхода', async () => {
    for (const [mask, reason] of [['*a*a*a*a*a*z', /больше 3 «\*»/], ['a**b', /отдельный сегмент/],
      ['src/**js', /отдельный сегмент/], ['*'.repeat(130) + 'z', /длиннее 120 знаков/]]) {
      const started = Date.now()
      await assert.rejects(() => search({ roots, query: '', glob: mask }), reason, `пропущена маска ${mask}`)
      assert(Date.now() - started < 400, `${mask}: отказ занял ${Date.now() - started} мс`)
    }
  })

  await test('обычные маски модельных запросов проходят', () => {
    for (const mask of ['*.js', 'src/**/*.cjs', '**/*.test.cjs', 'tests/**', '?.js', '*-??*.test.cjs',
      'workspace-search.js', '**/node_modules/**', 'a{b,c}*.js', 'src/*/index.*']) {
      assert(globToRegExp(mask) instanceof RegExp, `маска ${mask} не собралась`)
    }
  })

  // ── Бюджет обхода: слой, который не даёт обходу дожить до убийства ───────

  await test('бюджет обрывает обход, и найденное остаётся', async () => {
    // Отдельное дерево: на шести файлах обход короче миллисекунды, и делить его
    // по времени нечего.
    const many = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-budget-'))
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(many, `b${i}.js`), `const needle = ${i}\n`)
    const deep = [{ root: many, label: '' }]
    try {
      const full = await search({ roots: deep, query: 'needle', maxMatches: 500, budgetMs: Infinity })
      assert.equal(full.stopped, null)
      assert.equal(full.files, 300)

      // Срок — доля от времени самого же обхода: на любой машине этого хватает,
      // чтобы встать в середине, но не на нулевом файле.
      let early = null
      for (const divisor of [3, 6, 12]) {
        const measured = Date.now()
        await search({ roots: deep, query: 'needle', maxMatches: 500, budgetMs: Infinity })
        early = await search({ roots: deep, query: 'needle', maxMatches: 500,
          budgetMs: Math.max(1, Math.round((Date.now() - measured) / divisor)) })
        if (early.stopped === 'budget') break
      }
      assert.equal(early.stopped, 'budget', `обход успел закончиться сам: ${early.files} файлов`)
      assert.equal(early.truncated, true, 'неполный обход обязан быть помечен')
      assert(early.files > 0 && early.files < full.files, `файлов ${early.files} из ${full.files}`)
      assert.deepEqual(early.matches, full.matches.slice(0, early.matches.length), 'отдано не начало полного ответа')
    } finally {
      fs.rmSync(many, { recursive: true, force: true })
    }
  })

  await test('истёкший срок не даёт обходу начаться', async () => {
    const found = await search({ roots, query: 'needle', deadlineAt: Date.now() - 1 })
    assert.equal(found.stopped, 'budget')
    assert.equal(found.files, 0, 'обход не должен успеть открыть хоть один файл')
    assert.equal(found.matches.length, 0)
    assert.equal(found.truncated, true, 'пустой ответ без пометки читался бы как «в проекте этого нет»')
  })

  await test('обычный поиск не помечен ни бюджетом, ни обрезкой', async () => {
    const found = await search({ roots, query: 'const\\sneedle', regex: true })
    assert.equal(found.stopped, null)
    assert.equal(found.truncated, false)
  })

  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
}

main().finally(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
