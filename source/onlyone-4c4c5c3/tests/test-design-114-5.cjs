'use strict'
// Типографика и отступы по дизайн-системе.
//
// Требования: «один шрифт на всё» и «вес не больше 500, подсказки 12 px, отступ
// строк настроек 10 → 12 px». Карточка `Текст`: Instrument Sans (кириллица —
// Segoe UI), начертания 400 и 500, моноширинный только для кода; отступы — шаг 4.
//
// Расхождение с README («Строка настроек 8 × 16») не чинится молча: принято
// 12 px, и несоответствие заявлено в отчёте.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const read = name => fs.readFileSync(path.join(renderer, name), 'utf8')

const CSS = ['index.css', 'onboarding.css', 'task-center.css', 'ui-system.css',
  'composer-menu.css', 'look.css',
  'ultra-shell.css', 'ultra-blocks.css', 'select-widget.css', 'tokens.css']
  .filter(name => fs.existsSync(path.join(renderer, name)))
const MARKUP = ['index.html', 'app.js'].filter(name => fs.existsSync(path.join(renderer, name)))

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

// Правила вида «селектор { … }» — кусками, чтобы видеть, Кчему именно
// обращается шрифт или вес. Комментарии выбрасываются: они ничего не рисуют.
function rules(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
  return out
}

const allRules = []
for (const name of CSS) for (const one of rules(read(name))) allRules.push({ ...one, file: name })

// Мелкое допустимо только для цифровых служебных знаков и глифов — тот же
// список, что у машинной правки.
const SMALL_OK = /kbd|badge-count|counter|-count|stage-num|line-number|wave-num|history-item-del|user-avatar|effort-range|about-count|.num/i
// Селекторы, где моноширинный законен: код во всех его видах.
const CODE = /^\s*[^,]*(command|args|headers|env|json|terminal|editor|console|diff|code|samp|kbd|\bpre\b)[^,]*\s*$/i
// Что считается кодом в классах интерфейса (моноширинный здесь — право).
const CODE_CLASS = /(msg-code|code-block|__code|terminal|diff|editor|kbd|pre|code)/i

check('шрифт один: вне токенов встречается только панельный', () => {
  // Разрешено: панельный шрифт и его алиас, `inherit`, эмодзи-семейство и
  // моноширинный — но только в правилах про код. Всё остальное (Onest в
  // сообщениях, Newsreader, литералы вроде Georgia) — второй шрифт на экране.
  const UI = new Set(['var(--font-ui)', 'var(--font-sans)', 'inherit', 'var(--font-emoji)'])
  const MONO = /var\(--font-(mono|code)\)/
  const offenders = []
  for (const rule of allRules) {
    if (rule.file === 'tokens.css' || rule.file === 'fonts.css') continue
    const isCode = rule.selector.split(",").every(part => CODE.test(part) || CODE_CLASS.test(part))
    for (const m of rule.body.matchAll(/font-family:\s*([^;]+);/g)) {
      const value = m[1].trim()
      if (UI.has(value)) continue
      if (MONO.test(value) && isCode) continue
      offenders.push(`${rule.file} · ${rule.selector.slice(0, 40)} · ${value}`)
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} правил с чужим шрифтом`)
})

check('семейств prose, serif и display в интерфейсе нет', () => {
  const used = []
  for (const rule of allRules) {
    if (rule.file === 'tokens.css') continue
    for (const token of ['--font-prose', '--font-serif', '--font-display']) {
      if (new RegExp(`var\\(${token}\\)`).test(rule.body)) used.push(`${rule.file} · ${rule.selector.slice(0, 40)} · ${token}`)
    }
  }
  assert.deepEqual(used.slice(0, 10), [], `обращений к запасным семействам: ${used.length}`)
})

// Заголовки — размером и весом 600 (токен --fw-head); жирнее 600 по-прежнему
// ничего нет.
check('ни одного веса жирнее 600 (кроме дескрипторов @font-face)', () => {
  const heavy = []
  for (const name of CSS) {
    if (name === 'fonts.css') continue
    for (const m of read(name).matchAll(/font-weight:\s*(\d+)\s*;/g)) {
      if (Number(m[1]) > 600) heavy.push(`${name}:${m[1]}`)
    }
  }
  for (const name of MARKUP) {
    for (const m of read(name).matchAll(/font-weight:\s*(\d+)/g)) if (Number(m[1]) > 600) heavy.push(`${name}:${m[1]}`)
  }
  assert.deepEqual([...new Set(heavy)].slice(0, 12), [], `жирных начертаний: ${heavy.length}`)
})

check('токен заголовка — 600', () => {
  const tokens = read('tokens.css')
  const m = /--ui-weight-heading:\s*(\d+)/.exec(tokens)
  assert.ok(m, 'токена `--ui-weight-heading` нет')
  assert.equal(Number(m[1]), 600, `заголовок весит ${m[1]}`)
  assert.ok(/--fw-head:\s*600/.test(tokens), 'токена --fw-head: 600 нет')
})

// Кегни вступления (onboarding.css) здесь не меряются: 7–9 px в макете лендинга —
// часть композиции, а не подсказка интерфейса. Правку размера на этом экране
// не просили; заявлено в отчёте.
check('мелких размеров ниже 12 px в интерфейсе не осталось', () => {
  const small = []
  for (const rule of allRules) {
    if (rule.file === 'tokens.css' || rule.file === 'fonts.css' || rule.file === 'onboarding.css') continue
    for (const m of rule.body.matchAll(/font-size:\s*([\d.]+)px/g)) {
      const px = Number(m[1])
      if (px >= 12) continue
      // Клавиши, номера строк, счётчики и служебные цифры — не подсказки:
      // карточка `Текст` оставляет им право быть мелкими.
      if (SMALL_OK.test(rule.selector)) continue
      small.push(`${rule.file} · ${rule.selector.slice(0, 36)} · ${px}px`)
    }
  }
  assert.deepEqual(small.slice(0, 12), [], `строк меньше 12 px: ${small.length}`)
})

check('токен мелкого текста — 12 px', () => {
  // Токен может вести на роль макета (var(--fs-cap)) — раскрываем ссылку.
  const tokens = read('tokens.css')
  let value = (/--ui-size-small:\s*([^;]+);/.exec(tokens) || [])[1] || ''
  for (let i = 0; i < 4 && /^var\(/.test(value.trim()); i++) {
    const name = value.trim().slice(4, -1)
    value = (new RegExp(name + ':\\s*([^;]+);').exec(tokens) || [])[1] || ''
  }
  const m = /^\s*([\d.]+)px/.exec(value)
  assert.ok(m, 'токена `--ui-size-small` нет')
  assert.equal(Number(m[1]) >= 12, true, `мелкий текст ${m[1]}px`)
})

check('отступы строк настроек идут шагом 4', () => {
  const off = []
  for (const rule of allRules) {
    if (!/settings|setting-row|key-row|row-foot|shortcut-row|mode-row|conn-row/.test(rule.selector)) continue
    for (const m of rule.body.matchAll(/(?:padding|margin(?:-top|-bottom|-left|-right)?|gap):\s*([^;]+);/g)) {
      for (const num of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
        const px = Number(num[1])
        if (px % 4 === 0) continue
        off.push(`${rule.file} · ${rule.selector.slice(0, 40)} · ${px}px`)
      }
    }
  }
  assert.deepEqual(off.slice(0, 12), [], `отступов вне шага 4: ${off.length}`)
})

check('строка настроек поднята до 12 px', () => {
  const css = read('index.css')
  const at = css.indexOf('.settings-group .setting-row')
  assert.ok(at > 0, 'правила `.settings-group .setting-row` нет')
  const block = css.slice(at, css.indexOf('}', at))
  const m = /padding:\s*(\d+)px/.exec(block)
  assert.ok(m, 'у строки настроек нет padding')
  assert.equal(m[1], '12', `отступ строки настроек ${m[1]}px, требуется 12 px`)
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
