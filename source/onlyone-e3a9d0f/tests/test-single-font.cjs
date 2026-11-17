// Один шрифт во всём приложении (план, 1.14, часть 5).
//
// Боковая панель — эталон (план, «Главное»): к ней приводится всё остальное.
// Раньше текст ответа, строка ввода и заставка шли особой гарнитурой (Onest),
// а панель и подписи — Instrument Sans: на одном экране читались два шрифта.
// Теперь текст набран тем же стеком, что и интерфейс; отдельным остаётся только
// код (моноширинный). Проверка ловит возврат к отдельной «читаемой» гарнитуре.
const fs = require('node:fs')
const path = require('node:path')
const dir = path.join(__dirname, '..', 'src', 'renderer')
const read = name => fs.readFileSync(path.join(dir, name), 'utf8')

const tokens = read('tokens.css')
// Значение токена в корневом блоке (первое объявление).
// Псевдоним вида var(--font-ui) раскрывается до значения, на которое ведёт.
const token = (name, depth = 0) => {
  const m = tokens.match(new RegExp('^\\s*' + name + ':\\s*([^;]+);', 'm'))
  const value = m ? m[1].replace(/\s+/g, ' ').trim() : null
  const alias = value && value.match(/^var\((--[a-z0-9-]+)\)$/)
  return alias && depth < 5 ? token(alias[1], depth + 1) : value
}
const stack = value => (value || '').split(',').map(part => part.trim().replace(/^["']|["']$/g, ''))

let failed = 0
const check = (name, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok    ' : 'ПРОВАЛ'} ${name}${!pass && detail ? ' — ' + detail : ''}`)
}

const ui = token('--font-ui'), prose = token('--font-prose')
check('токены гарнитуры объявлены', Boolean(ui && prose), `ui=${ui} prose=${prose}`)
check('текст набран тем же стеком, что интерфейс', prose === ui, `ui: ${ui} | prose: ${prose}`)
check('первая гарнитура текста — Instrument Sans', stack(prose)[0] === 'Instrument Sans', stack(prose)[0])
check('в стеке текста нет отдельной «читаемой» гарнитуры', !/Onest|Golos|Literata|Newsreader/.test(prose || ''), prose)
check('эмодзи в стеке текста сохранены', /Twemoji/.test(prose || ''), prose)

// Ни одно правило не называет гарнитуру своим именем: только токены (ui, mono).
// Исключение — макет сайта в сцене «Дизайн» заставки (.ap-site*): это содержимое
// примера, а не шрифт приложения; у него своя, засечная, «вёрстка».
const SAMPLE_SITE = /^\.ap-site/
const offenders = []
for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.css') && name !== 'fonts.css' && name !== 'tokens.css')) {
  for (const [, selector, block] of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.split(',').every(part => SAMPLE_SITE.test(part.trim().split(/\s+/).pop()) || SAMPLE_SITE.test(part.trim()))) continue
    for (const [, family] of block.matchAll(/font-family:\s*([^;}]+)/g)) {
      if (/^\s*(var\(|inherit|initial|unset)/.test(family)) continue
      offenders.push(`${file} ${selector.trim().slice(0, 30)}: ${family.trim().slice(0, 40)}`)
    }
  }
}
check('гарнитуры в стилях задаются только токенами', offenders.length === 0, offenders.slice(0, 4).join('; '))

// Текст ответа и строка ввода идут через токен текста — значит, через тот же стек.
const css = read('index.css')
// Правила текста берут токен интерфейса (или его алиас --font-prose — тот же стек)
// либо наследуют, но не называют своей гарнитуры (это ловит проверка выше).
const usesUiStack = re => {
  const rules = [...css.matchAll(re)].map(m => m[1])
  return rules.length > 0 && rules.every(block => !/font-family:/.test(block) || /font-family:\s*var\(--font-(?:ui|prose)\)/.test(block))
}
check('текст ответа набран стеком интерфейса', usesUiStack(/\.msg-content \{([^}]*)\}/g))
check('строка ввода набрана стеком интерфейса', usesUiStack(/\.composer-textarea \{([^}]*)\}/g))
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
