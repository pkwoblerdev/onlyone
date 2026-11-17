'use strict'
// Значки вне боковой панели — по рисовке панели.
//
// Значки рисовались в поле `0 0 24 24`. Это не косметика: линия 1.5 в поле 24,
// показанная в 16 px, рендерится в 1.0 px (а в 12 px — в 0.75), поэтому
// «толщина гуляет» не из-за разных атрибутов, а из-за чужого поля. Эталон —
// семь значков панели и набор `design-system/onlyone/icons` (поле 16, линия
// 1.5, без заливки).
//
// Сознательно оставлены залитыми квадрат «стоп» и бренд-марки; стрелки
// холстов не трогаются вовсе. Всё, что вне этих исключений, обязано быть в
// поле 16, с явным `fill="none"` и без инлайновой толщины.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

// Служебные страницы каталога и предпросмотра интерфейсом не считаются.
const SKIP = new Set(['ui-catalog.html', '_preview.html'])
const files = fs.readdirSync(renderer)
  .filter(name => /\.(html|js)$/.test(name) && !SKIP.has(name))
  .map(name => ['src/renderer/' + name, read('src', 'renderer', name)])

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 400)}`)
  }
}

// Сознательные исключения и те, для чего эталона в наборе нет. Ключ — файл и
// начало рисунка, а не номер строки: перенос соседних значков сдвигает строки,
// и номерной список устарел бы молча. Каждый пункт — с причиной; проверка
// сверяет список с фактом в обе стороны.
const EXCEPT = new Map([
  ['index.html|<rect width="12" height="12" x="6"', 'квадрат «стоп» — залит намеренно'],
  ['index.html|<rect x="7" y="7" width="10"', 'квадрат «стоп» в панели Дизайна — залит намеренно'],
  ['index.html|<path d="M12 5v14M19 12l-7 7-7-7"', 'длинная стрелка вниз: в наборе только уголок chevron'],
  ['index.html|<path d="M7 7h13l-4-4M17 17H4l4 4"', 'встречные стрелки «поменять местами»: эталона нет'],
  ['index.html|<path d="M7 17 17 7M9 7h8v8"', 'стрелка наружу: expand.svg — четыре угла, не то'],
  ['work-panel.js|<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"', 'составная «история» (кольцо + возврат): композиции в наборе нет'],
  ['ui-config-view.js|<path d="m12 3-1.912', 'искра предложения: марка это или служебный значок — решает человек']
])

// Ключ исключения — начало рисунка, поэтому совпадение ищем как префикс.
function exceptionFor(key) {
  for (const [pattern, reason] of EXCEPT) if (key.startsWith(pattern)) return { pattern, reason }
  return null
}

const TAG = /<svg\b[\s\S]*?<\/svg>/g
function iconTags(source, file) {
  const name = file.split('/').pop()
  const out = []
  for (const match of source.matchAll(TAG)) {
    const tag = match[0]
    if (!/class="[^"]*icon/.test(tag.slice(0, tag.indexOf('>') + 1))) continue
    const line = source.slice(0, match.index).split('\n').length
    const inner = (tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</svg>')) || '').replace(/\s+/g, ' ').trim()
    out.push({ file: name, line, tag, key: `${name}|${inner.slice(0, 40)}` })
  }
  return out
}

const all = files.flatMap(([file, source]) => iconTags(source, file))

check('панель остаётся эталоном: её значки в поле 16', () => {
  const panel = all.filter(one => one.file === 'index.html' && one.line >= 50 && one.line <= 130) // панель и кнопка панели в заголовке окна
  assert.ok(panel.length >= 7, `найдено значков панели: ${panel.length}`)
  for (const one of panel) {
    assert.match(one.tag, /viewBox="0 0 16 16"/, `строка ${one.line} выпала из эталонного поля`)
  }
})

check('ни одного значка вне поля 16 — кроме поименованных исключений', () => {
  const offenders = all.filter(one => !/viewBox="0 0 16 16"/.test(one.tag))
  const unexpected = offenders.filter(one => !exceptionFor(one.key))
  const lost = [...EXCEPT.keys()].filter(pattern => !offenders.some(one => one.key.startsWith(pattern)))
  assert.deepEqual(
    unexpected.map(one => `${one.key} ${one.tag.slice(0, 60)}`).slice(0, 8),
    [],
    `значков вне поля 16 больше, чем разрешено: ${unexpected.length} сверх списка (всего вне поля ${offenders.length})`
  )
  assert.deepEqual(lost, [],
    'список исключений устарел: этих строк уже нет — убери их, и потолок опустится')
})

check('толщина не назначается инлайном: она идёт из токена `.icon`', () => {
  const inline = all
    .filter(one => !exceptionFor(one.key))
    .filter(one => /stroke-width="(?!(1\.5)")/.test(one.tag))
    .map(one => `${one.key} ${((/stroke-width="([^"]*)"/.exec(one.tag) || [])[1]) || ''}`)
  assert.deepEqual(inline.slice(0, 10), [], `инлайн-толщина осталась: ${inline.join(' | ')}`)
})

check('заливка выключена явно на каждом значке', () => {
  const missing = all
    .filter(one => !exceptionFor(one.key))
    .filter(one => !/fill="none"/.test(one.tag))
    .map(one => one.key)
  assert.deepEqual(missing.slice(0, 12), [],
    `без явного fill="none" (каскад решает за рисунок): ${missing.length} — ${missing.join(', ')}`)
})

check('эталоны переложены в код, а не нарисованы заново', () => {
  // The reference set is not shipped with the repository; point ONECODE_ICONS
  // at it to run this part, otherwise it is skipped on purpose.
  const iconsDir = process.env.ONECODE_ICONS || path.join(root, 'design-system', 'onlyone', 'icons')
  if (!fs.existsSync(iconsDir)) {
    console.log('  пропуск: набор эталонных файлов не виден на этом диске')
    return
  }
  const body = files.map(([, source]) => source).join('\n')
  const inner = name => {
    const svg = fs.readFileSync(path.join(iconsDir, name + '.svg'), 'utf8')
    return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+/g, ' ').trim()
  }
  const wanted = ['close', 'plus', 'chevron-down', 'chevron-right', 'send', 'trash', 'folder',
    'key', 'eye', 'search', 'retry', 'copy', 'quote', 'clock', 'check', 'fast', 'split',
    'sidebar', 'keyboard', 'update', 'user', 'tasks', 'expand', 'play', 'attach', 'pin']
  const placed = wanted.filter(name => {
    const content = inner(name)
    // Сопоставляем по первому пути эталона: порядок фигур и перенос строки в
    // исходнике могут отличаться, а геометрия — нет.
    const first = (/<path d="([^"]+)"/.exec(content) || [])[1]
    return first && body.includes(first)
  })
  assert.ok(placed.length >= wanted.length - 3,
    `из ${wanted.length} эталонных значков в коде geometrия ${placed.length}: не переложен ${wanted.filter(n => !placed.includes(n)).join(', ')}`)
})

console.log(`Значков с классом icon найдено: ${all.length}`)
console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed, icons: all.length }))
process.exitCode = failed ? 1 : 0
