// Представление onlyone Ultra (план, 9.2): договор по исходникам.
// Подключено в окне; только сдвиг и прозрачность; шрифт — веса 400 и 500;
// искра не вращается; без имён моделей, папок и людей; у каждой русской
// строки есть английская пара; правило показа «один раз»; есть пропуск.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..', 'src', 'renderer')
const js = fs.readFileSync(path.join(root, 'ultra-intro.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'ultra-intro.css'), 'utf8')
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
const box = { window: {} }
vm.createContext(box)
vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), box)
const en = box.window.__I18N__.en

const checks = []
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

check('стили и модуль подключены в окне', /<link rel="stylesheet" href="ultra-intro\.css"/.test(html) && /<script src="ultra-intro\.js"><\/script>/.test(html))
check('в Настройках есть «Показать» для представления', /id="showUltraIntroBtn"/.test(html) && /getElementById\('showUltraIntroBtn'\)/.test(js))

// Движение — только сдвиг, прозрачность, обрезка и прорисовка линии.
const LAYOUT = /\b(width|height|top|left|right|bottom|margin[\w-]*|padding[\w-]*|inset|font-size|line-height)\b/
const transitions = [...css.matchAll(/transition(?:-property)?\s*:\s*([^;]+);/g)].map(m => m[1])
const badTransitions = transitions.filter(value => value.split(',').some(part => LAYOUT.test(part.trim().split(/\s+/)[0])))
check('переходы не трогают раскладку', badTransitions.length === 0, badTransitions.join(' | '))
const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\}\s*\}/g)].map(m => m[1])
const badFrames = keyframes.filter(body => [...body.matchAll(/([\w-]+)\s*:/g)].some(m => LAYOUT.test(m[1])))
check('кадры анимаций не трогают раскладку', badFrames.length === 0, badFrames.join(' | ').slice(0, 200))

const weights = [...css.matchAll(/font-weight\s*:\s*([^;]+);/g), ...css.matchAll(/font\s*:\s*(\d{3})\s/g)].map(m => m[1].trim())
check('шрифт — только веса 400 и 500', weights.every(w => w === '400' || w === '500'), weights.join(', '))
check('искра не вращается', !/rotate/i.test(css) && !/rotate/i.test(js))
check('при «уменьшить движение» — без анимаций и сразу итог', /@media \(prefers-reduced-motion: reduce\)/.test(css) && /reducedMotion\(\)/.test(js) && /is-final/.test(js))

// Ничего личного и никаких имён моделей и папок.
const FORBIDDEN = /\b(GLM|GPT|Claude|Gemini|Qwen|Nemotron|DeepSeek|OpenRouter|Llama|pkwobler)\b|[A-Za-z]:\\|\/src\/|\.(json|html|js|py|csv)\b/i
const literals = [...js.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => m[1]).filter(s => /[а-яёa-z]{3}/i.test(s) && !/^[.#\[]|^onlyone\.|^\d|^(Escape|Tab|role|button|dialog|aria-|keydown|resize|DOMContentLoaded|loading|source-over|screen|is-|ux-|data-|#[0-9a-f]+)/i.test(s))
const leaked = literals.filter(s => FORBIDDEN.test(s))
check('в тексте нет моделей, папок и имён', leaked.length === 0, leaked.join(' | '))
check('подпись финала — «onlyone Ultra»', /onlyone <span>Ultra<\/span>/.test(js))

// Все русские строки модуля — с английскими парами.
const russian = [...js.matchAll(/'((?:[^'\\\n])*[а-яё](?:[^'\\\n])*)'/gi)].map(m => m[1])
  .filter(s => !/^\s*\/\//.test(s))
const missing = [...new Set(russian)].filter(s => !(s in en))
check('у каждой русской строки есть английская пара', missing.length === 0, missing.join(' | '))
const htmlStrings = ['Представление Ultra', 'Возможности версии Ultra — коротко и по порядку']
check('строка в Настройках переводится', htmlStrings.every(s => s in en), htmlStrings.filter(s => !(s in en)).join(' | '))

// Правило показа и управление.
check('показывается один раз: ключ onlyone.ultraIntro и номер версии', /SEEN_KEY = 'onlyone\.ultraIntro'/.test(js) && /const REV = '\d{4}-\d{2}-\d{2}'/.test(js) && /read\(SEEN_KEY\) !== REV/.test(js))
check('наружу: shouldShow, maybeShow, show', /window\.onlyoneUltraIntro = \{[^}]*shouldShow[^}]*maybeShow[^}]*show/.test(js))
check('есть «Пропустить», Escape и кнопка в конце', /class="ux-skip"/.test(js) && /event\.key === 'Escape'/.test(js) && /class="ux-cta"/.test(js))
check('это диалог с подписью', /setAttribute\('role', 'dialog'\)/.test(js) && /aria-modal/.test(js))

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'ok    ' : 'ПРОВАЛ'} ${c.name}${!c.pass && c.detail ? ' — ' + c.detail : ''}`)
}
console.log(JSON.stringify({ ok: failed === 0, checks: checks.length, failed }))
process.exit(failed ? 1 : 0)
