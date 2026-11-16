// «Один thinking на весь ответ — простыня, внутри которой надо копаться.»
//
// Поток размышления приходил кусками, и все куски сливались в один блок: чтобы
// понять, что модель делала, приходилось разворачивать одну простыню и читать
// её целиком. Здесь проверяется разделение: мысль режется там, где её режет
// сама модель — пустой строкой и заголовком, — и заголовок каждого куска
// становится его названием.
//
// Функции берутся из настоящего исходника окна, а не пересказываются.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Разбор мысли делает модуль блоков ленты (план, 2d); берём весь код окна,
// чтобы проверка не зависела от того, в каком файле лежит функция.
const src = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдено: ' + from)
  return src.slice(a, b)
}

// Настоящее слияние блоков из pushBlock: без него разделение проверять нечего.
const pushBlock = (pane, kind, text, agent = '') => {
  if (!text) return
  pane.blocks = pane.blocks || []
  const last = pane.blocks[pane.blocks.length - 1]
  if (last && last.kind === kind && last.agent === agent && !last.closed) {
    last.text += text
    return
  }
  pane.blocks.push({ kind, agent, text, closed: false })
}

// Interleaving must be tested with the production merger, not the stub above.
require('./test-interleaved-stream.cjs')

const splitter = new Function('pushBlock',
  cut('  const THOUGHT_MIN = 260', '  function pushBlock(pane, kind') +
  '; return { pushThinking, thoughtBreak }')(pushBlock)

const headline = new Function('t',
  cut('  function thinkingHeadline(text)', '  function pushBlock(pane, kind') +
  '; return thinkingHeadline')(x => x)

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const stream = pieces => {
  const pane = { blocks: [] }
  for (const piece of pieces) splitter.pushThinking(pane, piece, '')
  return pane.blocks.filter(b => b.kind === 'thinking')
}

// --- размеченная мысль делится по заголовкам ---------------------------------

const titled = stream([
  'Разбираю задачу. Надо понять, откуда берётся пустой блок и почему он один на ',
  'весь ответ. Смотрю обработчик потока размышления: он складывает всё в один блок, ',
  'потому что соседние куски одного вида сливаются.\n\n',
  '**Проверяю разделение.** Нужна граница по пустой строке и по заголовку, иначе ',
  'куски будут рваться посреди фразы. Порог не даёт плодить крошки.\n\n',
  '## Итог\nДелю поток и закрываю блок, чтобы следующий кусок начал новый.'
])

check('размеченная мысль делится', titled.length === 3, 'блоков ' + titled.length)
check('первый кусок — про разбор задачи', /Разбираю задачу/.test(titled[0]?.text || ''))
check('второй начинается со своего заголовка', /^\*\*Проверяю разделение/.test(titled[1]?.text || ''),
  (titled[1]?.text || '').slice(0, 40))
check('третий — тоже', /^## Итог/.test(titled[2]?.text || ''), (titled[2]?.text || '').slice(0, 40))

// --- заголовок пишет модель, а не приложение ---------------------------------

check('заголовок берётся из разметки модели',
  headline('**Проверяю разделение.** Нужна граница по пустой строке.') === 'Проверяю разделение',
  headline('**Проверяю разделение.** Нужна граница по пустой строке.'))
check('решётки тоже считаются заголовком',
  headline('## Итог\nДелю поток и закрываю блок.') === 'Итог',
  headline('## Итог\nДелю поток и закрываю блок.'))
check('без разметки заголовок берётся из первой фразы',
  headline('Читаю src/main/main.js. Потом проверю тесты.') === 'Читаю src/main/main.js.',
  headline('Читаю src/main/main.js. Потом проверю тесты.'))
check('пустая мысль заголовка не получает', headline('') === '')

// --- крошки не плодятся ------------------------------------------------------

const tiny = stream(['Так.\n\n', 'Ага.\n\n', 'Понятно.\n\n', 'Теперь смотрю дальше.'])
check('короткие обрывки не режутся на блоки', tiny.length === 1, 'блоков ' + tiny.length)

// --- длинная мысль без разметки всё равно делится ----------------------------

const long = stream([('Проверяю поведение отмены в цикле вызовов инструментов. ').repeat(40)])
check('простыня без разметки тоже делится', long.length >= 2, 'блоков ' + long.length)
check('делится по концу предложения, а не посреди фразы',
  long.every(block => /[.!?…]\s*$/.test(block.text.trim()) || block === long[long.length - 1]),
  long.map(b => b.text.trim().slice(-24)).join(' | '))

// --- окно действительно пользуется разделением -------------------------------

check('поток размышления идёт через разделитель', /pushThinking\(pane, chunk\.text, agent\)/.test(src))
check('закрытый блок не принимает продолжение',
  /last\.agent === agent && !last\.closed/.test(src))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
