// 5 МБ в одном сообщении (аудит 31.10, Н23).
//
// Почему это дефект, а не «просто долго»: renderMarkdownHtml разбирал и
// раскладывал весь блок на каждой перерисовке, а живая лента перерисовывает
// растущий блок десятки раз за ответ. Замер в Chromium 31.10: один проход
// 5 МБ — 0,28 с разбора, 0,85 с раскладки, итого ~1,15 с заблокированного
// кадра; двенадцать перерисовок растущего буфера — 6,9 с. Отсюда 2,2-с
// задачи окна в журнале.
//
// Проверяем настоящий renderMarkdownHtml из app.js (как test-queued-cross-chat):
// длинный блок рисуется головой с кнопкой «Показать целиком», весь текст остаётся
// доступен по кнопке, а перерисовки укладываются в бюджет.
//
// Бюджет не на глаз: после правки двенадцать перерисовок 5-МБ буфера занимают
// ~8 мс (замер этого же теста на этой машине); до правки — ~700 мс. Порог 350 мс
// вдвое ниже красного и в сорок раз выше зелёного — запас на медленную машину.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const appJs = require('./renderer-code.cjs').rendererCode(ROOT)

const SLOW_PAINT_BUDGET_MS = 350
const GROWING_PAINTS = 12

// Настоящий marked из окна: цена разбора — половина дефекта, подменять её заглушкой нельзя.
const markedContext = vm.createContext({ console })
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/vendor/marked.min.js'), 'utf8'), markedContext)
const marked = markedContext.marked
assert.ok(marked && typeof marked.parse === 'function', 'marked.min.js не загрузился')

// Тот же вход, что слал мок-провайдер в аудите: стена текста с инлайн-разметкой
// и сырым <script> в теле.
const piece = 'Я'.repeat(2000) + ' `code` **bold** _em_ <scr' + 'ipt>alert(1)</scr' + 'ipt> '
const TAIL = '\n\nХВОСТ-523-КОНЕЦ'

function hugeSource(bytes = 5 * 1024 * 1024) {
  const source = piece.repeat(Math.ceil(bytes / piece.length))
  return source + TAIL
}

// Код окна целиком: renderMarkdownHtml берётся из него куском, как в других
// renderer-тестах. Разметку и санитайзер изображают заглушки: их цена в Chromium,
// а здесь важны разбор, ветка потолка и сохранность текста.
function createRenderer() {
  const cStart = appJs.indexOf('  const MARKDOWN_CACHE_MAX =')
  const cEnd = appJs.indexOf('  // Flattens segments', cStart)
  assert.ok(cStart >= 0 && cEnd > cStart, 'renderMarkdownHtml не найден в коде окна')

  const parsedLengths = []
  const sandbox = {
    marked: {
      parse(source) { parsedLengths.push(source.length); return marked.parse(source) }
    },
    DOMParser: class { parseFromString(html) { return { body: { innerHTML: html } } } },
    markTaskBoxes() {},
    linkifyImages() {},
    scrubElement() {},
    markInlinePaths() {},
    highlightCodeBlocks() {},
    wrapCodeBlocks() {},
    wrapTables() {},
    formatWithEmoji: text => text,
    t: (text, ...args) => args.reduce((out, arg) => out.replace('%s', String(arg)), text),
    escapeHtml: text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    console
  }
  vm.createContext(sandbox)
  vm.runInContext(
    appJs.slice(cStart, cEnd) +
    '\nthis.render = renderMarkdownHtml; this.limit = MARKDOWN_INLINE_LIMIT;' +
    '\nthis.sources = cappedSources; this.cache = markdownCache;',
    sandbox
  )
  return { render: sandbox.render, limit: sandbox.limit, sources: sandbox.sources, cache: sandbox.cache, parsedLengths }
}

let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log('ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ  ' + name + ' — ' + error.message)
  }
}

test('5 МБ рисуются головой с кнопкой «Показать целиком», без хвоста', () => {
  const r = createRenderer()
  const source = hugeSource()
  const html = r.render(source)
  assert.ok(r.limit > 0 && r.limit < source.length, 'потолок блока должен быть меньше сообщения')
  assert.ok(r.parsedLengths.length === 1, 'один проход — один разбор')
  assert.ok(r.parsedLengths[0] <= r.limit, `в marked ушло ${r.parsedLengths[0]} знаков при потолке ${r.limit}`)
  assert.ok(html.includes('data-md-more='), 'нет кнопки раскрытия')
  assert.ok(html.includes('Показать целиком'), 'нет подписи кнопки')
  assert.ok(!html.includes('ХВОСТ-523-КОНЕЦ'), 'хвост не должен рисоваться в голове')
})

test('за кнопкой лежит весь текст, а не обрезанный кусок', () => {
  const r = createRenderer()
  const source = hugeSource()
  const html = r.render(source)
  const id = html.match(/data-md-more="([^"]+)"/)?.[1]
  assert.ok(id, 'у кнопки нет ключа источника')
  assert.equal(r.sources.get(id), source, 'по кнопке должен открываться исходный текст целиком')
  const full = r.render(source, { full: true })
  assert.ok(full.includes('ХВОСТ-523-КОНЕЦ'), 'полный рендер потерял хвост')
  assert.ok(full.length > source.length * 0.9, 'полный рендер короче исходника')
})

test('на повторе подпись считает текущий текст, а не первый', () => {
  const r = createRenderer()
  const first = hugeSource()
  const second = first + 'Я'.repeat(1000)
  const total = html => Number(html.match(/из ([\d\s\u00a0]+) знаков/)?.[1].replace(/[^\d]/g, ''))
  assert.equal(total(r.render(first)), first.length)
  assert.equal(total(r.render(second)), second.length, 'подпись застыла на длине первой перерисовки')
})

test('короткое сообщение рисуется как раньше, без кнопки', () => {
  const r = createRenderer()
  const html = r.render('Привет, **мир**')
  assert.ok(!html.includes('md-capped'), 'потолок задел обычный ответ')
  assert.ok(html.includes('<strong>мир</strong>'), 'разметка обычного ответа не разобрана')
})

test('перерисовки растущего 5-МБ буфера укладываются в бюджет', () => {
  const r = createRenderer()
  const source = hugeSource()
  const started = process.hrtime.bigint()
  for (let i = 1; i <= GROWING_PAINTS; i++) {
    r.render(source.slice(0, Math.round(source.length * i / GROWING_PAINTS)))
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`    ${GROWING_PAINTS} перерисовок: ${ms.toFixed(1)} мс (порог ${SLOW_PAINT_BUDGET_MS} мс)`)
  assert.ok(ms < SLOW_PAINT_BUDGET_MS, `${GROWING_PAINTS} перерисовок заняли ${ms.toFixed(0)} мс при пороге ${SLOW_PAINT_BUDGET_MS}`)
  assert.ok(r.parsedLengths.every(n => n <= r.limit), 'в разбор уходил кусок больше потолка')
})

if (failed) {
  console.error(`\n${failed} проверок провалено`)
  process.exitCode = 1
} else {
  console.log('\nОгромные сообщения: все проверки пройдены')
}
