// «Показать целиком» обязан открывать СВОЙ текст, а карта источников — не расти
// бесконечно (аудит 01.11, Н4 и Н7).
//
// Ключ кнопки выводился из головы текста (первые 128 КБ). Два больших сообщения с
// одинаковым началом (повторяющиеся tool-выводы, логи) давали один и тот же ключ,
// второй рендер перезаписывал cappedSources, и кнопка первого сообщения показывала
// текст второго — утечка содержимого между сообщениями. Плюс вытеснение головы из
// cappedHeadIds не чистило cappedSources: ~МБ строк на каждый вытесненный блок.
//
// Проверяем настоящий renderMarkdownHtml из app.js (как test-render-huge-message),
// но с заглушкой marked: здесь важен ключ и сохранность источника, не разбор.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const appJs = require('./renderer-code.cjs').rendererCode(ROOT)

function createRenderer () {
  const cStart = appJs.indexOf('  const MARKDOWN_CACHE_MAX =')
  const cEnd = appJs.indexOf('  // Flattens segments', cStart)
  assert.ok(cStart >= 0 && cEnd > cStart, 'renderMarkdownHtml не найден в коде окна')

  const sandbox = {
    marked: { parse: source => `<p>${source}</p>` },
    DOMParser: class { parseFromString (html) { return { body: { innerHTML: html } } } },
    markTaskBoxes () {}, linkifyImages () {}, scrubElement () {}, markInlinePaths () {},
    highlightCodeBlocks () {}, wrapCodeBlocks () {}, wrapTables () {},
    formatWithEmoji: text => text,
    t: (text, ...args) => args.reduce((out, arg) => out.replace('%s', String(arg)), text),
    escapeHtml: text => String(text),
    console
  }
  vm.createContext(sandbox)
  vm.runInContext(
    appJs.slice(cStart, cEnd) +
    '\nthis.render = renderMarkdownHtml; this.limit = MARKDOWN_INLINE_LIMIT;' +
    '\nthis.sources = cappedSources;',
    sandbox
  )
  return { render: sandbox.render, limit: sandbox.limit, sources: sandbox.sources }
}

const keyOf = html => html.match(/data-md-more="([^"]+)"/)?.[1]

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok  ' + name) } catch (e) { failed++; console.error('ПРОВАЛ  ' + name + ' — ' + e.message) }
}

// Два разных сообщения с идентичной головой (первым 128 КБ) и разными хвостами.
function sameHeadSources (limit) {
  const shared = 'Я'.repeat(limit) // без переводов строки → голова = ровно этот кусок
  return {
    a: shared + '\nХВОСТ-А-ОТЛИЧАЕТСЯ',
    b: shared + '\nХВОСТ-Б-СОВСЕМ-ДРУГОЙ'
  }
}

test('разные сообщения с одинаковой головой получают разные ключи', () => {
  const r = createRenderer()
  const { a, b } = sameHeadSources(r.limit)
  assert.ok(a.length > r.limit && b.length > r.limit, 'источники должны превышать потолок головы')
  const headA = a.slice(0, r.limit)
  assert.equal(headA, b.slice(0, r.limit), 'головы обязано совпадать — это и есть условие коллизии')

  const idA = keyOf(r.render(a))
  const idB = keyOf(r.render(b))
  assert.ok(idA && idB, 'у кнопки нет ключа источника')
  assert.notEqual(idA, idB, 'коллизия: два разных сообщения дали один ключ кнопки')

  // И — главное — по каждому ключу открывается СВОЙ текст, а не чужой.
  assert.equal(r.sources.get(idA), a, 'по ключу сообщения A открывается чужой текст')
  assert.equal(r.sources.get(idB), b, 'по ключу сообщения B открывается не тот текст')
})

test('карта источников ограничена и вытесняет старые записи, а не растёт до бесконечности', () => {
  const r = createRenderer()
  const total = 300
  const ids = []
  for (let i = 0; i < total; i++) {
    // Каждое сообщение уникально по хвосту, голова общая для всех.
    const html = r.render('Я'.repeat(r.limit) + `\n#x${i}`)
    ids.push(keyOf(html))
  }
  assert.ok(r.sources.size <= 64, `cappedSources разрослась до ${r.sources.size} записей (ждём <= 64)`)
  // Живые (последние) ключи обязаны оставаться на месте.
  const stillThere = ids.slice(-50).filter(id => r.sources.has(id)).length
  assert.equal(stillThere, 50, 'из карты вытеснены свежие источники, которые ещё видны в ленте')
})

if (failed) { console.error(`\n${failed} проверок провалено`); process.exitCode = 1 }
else console.log('\nКлюч источника: все проверки пройдены')
