'use strict'

// 3.10 — команды и режимы компактным списком над «/»: КРАСНЫЙ узловой набор.
//
// Что здесь проверяется и чего здесь нет
// --------------------------------------
// Ведущий заморозил контракт: один модуль окна `src/renderer/composer-menu.js`,
// `create(deps) → Object.freeze({ open, close, move, accept, isOpen, dispose })`,
// `open({ anchor, items, selected, ariaLabel, onPick })`, `items = [{ id, name,
// hint }]`. Список встаёт НАД якорем, описания в строке нет — описание живёт
// своей подсказкой справа от выбранной строки. Наборов команд и режимов модуль
// не знает: их приносят вызывающие (команды — `app.js`, режимы — пилюля).
//
// Этот файл гоняет модуль на подставном DOM (образец — подставной DOM
// других оконных тестов) и требует ПОВЕДЕНИЯ, а не конкретной
// реализации: размеры, отступы и радиусы берутся из реально отрисованной
// раскладки — подставной раскладчик читает и инлайн-стиль модуля, и настоящие
// правила из всех `src/renderer/*.css`, разворачивая `var(--токен)`. Модулю
// поэтому всё равно, посадить ли зазор в 6 px правилом CSS или числами в style:
// засчитывается любое, что действительно даёт нужную раскладку.
//
// Что честно перенесено в окно (`tests/run-composer-menu-ui.cjs`), потому что
// без Chromium не измерить:
//   — пиксели настоящего шрифта (формула ширины «самое длинное имя + 24 px»
//     считается здесь по подставному шрифту, где символ равен 7 px);
//   — что открытое состояние видно человеку (кадры) и что кадр не остался
//     приветственным экраном вместо списка;
//   — что подсказка при реальном наведении мыши не прыгает на чужую строку;
//   — что выбор режима доходит до `setWorkspace`, а подпись `#permModeLabel`
//     осталась на месте;
//   — поведение ↑↓/Tab/Esc внутри живого поля ввода (здесь проверяется сам
//     модуль: move/accept/close и его собственная проводка на документе).
// `prefers-reduced-motion` остался здесь: оконный харнесс (`ONECODE_SMOKE`) не
// умеет подменять системную настройку, а CDP-эмуляция доступна только прогонам,
// которые сами создают окно.
//
// Ключи deps сверх контракта (`now`) и способы измерить текст — выдуманы этим
// набором: контракт их не задал. Проверки намеренно не требуют ничего, кроме
// перечисленного в контракта, а где вынуждены додумывать форму API — это
// отмечено в комментарии у самой проверки.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
// Путь модуля можно подменить ТОЛЬКО для самопроверки этого набора: красные
// проверки обязаны быть выполнимыми, поэтому эталонную реализацию держат вне
// репозитория и прогоняют набор по ней. В общем прогоне переменные не заданы, и
// набор смотрит на настоящий `src/renderer/composer-menu.js`.
const MODULE_FILE = process.env.ONECODE_COMPOSER_MENU || 'src/renderer/composer-menu.js'
const MODULE_PATH = path.isAbsolute(MODULE_FILE) ? MODULE_FILE : path.join(root, MODULE_FILE)

// Мягкий require: набор обязан краснеть по отсутствию ПОВЕДЕНИЯ, а не падать на
// `Cannot find module` — иначе вместо списка проверок человек получает строку
// стека и ничего не видно.
let composerMenu = null
let moduleLoadError = ''
if (fs.existsSync(MODULE_PATH)) {
  try { composerMenu = require(MODULE_PATH) } catch (error) {
    moduleLoadError = (error && error.message) || String(error)
  }
}

const NO_MODULE = 'модуль «' + MODULE_FILE + '» ещё не написан (пункт 3.10: команды и режимы компактным списком над «/»)' +
  ' — все проверки ниже красные по этой причине'
const readModule = () => fs.readFileSync(MODULE_PATH, 'utf8')
function needModule () {
  assert.ok(composerMenu && typeof composerMenu.create === 'function',
    NO_MODULE + (moduleLoadError ? ', причём файл есть, но require упал: ' + moduleLoadError : ''))
  return composerMenu
}

// Каждый сценарий получает СВЕЖИЙ экземпляр модуля: состояние вида живёт то ли в
// замыкании create(), то ли на уровне файла, и в окне `create()` зовут один раз.
// Без пересборки require-кэша второй сценарий в одном процессе наследовал бы DOM
// первого, и проверки краснели бы по вине харнесса.
function freshModule () {
  needModule()
  try { delete require.cache[require.resolve(MODULE_PATH)] } catch { /* путь мог быть относительным */ }
  return require(MODULE_PATH)
}

let failed = 0
let total = 0
const pending = []
function check (name, fn) {
  total++
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => console.log('  ok  ' + name),
        error => { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }))
      return
    }
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error && error.message}`)
  }
}

const RU = /[а-яё]/i

// ─── токены и правила: то, что модуль мог описать стилями ────────────────────
// Правила ищутся во ВСЕХ `src/renderer/*.css`: куда лягут новые классы (в
// `index.css` или в свой файл), решает реализатор, а контракт на них один.
function stripComments (text) {
  // Блочные комментарии, HTML-комментарии и строки, целиком занятые `//`: без
  // последнего проверка «кириллица только через t()» краснела бы на русском
  // комментария в шапке модуля.
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CSS_FILES = fs.readdirSync(path.join(root, 'src/renderer')).filter(name => name.endsWith('.css')).sort()
// Второй самопроверочный хук: стили эталонной реализации (файлы через «;»). В
// общем прогоне переменная не задана, и набор видит только настоящие CSS окна.
const EXTRA_CSS = String(process.env.ONECODE_COMPOSER_MENU_CSS || '').split(';').filter(Boolean)
// Блок @supports (corner-shape: squircle) — суперэллипс макета: там радиусы × 1,4 под другую
// форму угла. Подставной DOM формы угла не знает, поэтому блок в разбор не идёт.
function dropSquircle (css) {
  const at = css.indexOf('@supports (corner-shape: squircle)')
  if (at < 0) return css
  let i = css.indexOf('{', at) + 1, depth = 1
  while (i < css.length && depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++ }
  return dropSquircle(css.slice(0, at) + css.slice(i))
}
const CSS_ALL = CSS_FILES.map(name => dropSquircle(stripComments(read('src/renderer', name))))
  .concat(EXTRA_CSS.map(file => stripComments(fs.readFileSync(file, 'utf8')))).join('\n')

const TOKENS = new Map()
for (const [, block] of CSS_ALL.matchAll(/(?::root|html)\s*\{([^}]*)\}/g)) {
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
    if (!TOKENS.has(name)) TOKENS.set(name, value.trim())
  }
}

function resolveVars (value) {
  let text = String(value ?? '')
  for (let i = 0; i < 8; i++) {
    const match = /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*))?\s*\)/i.exec(text)
    if (!match) break
    const replacement = TOKENS.has(match[1]) ? TOKENS.get(match[1]) : (match[2] || '')
    text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
  }
  return text.trim()
}

// Число из значения свойства: `12px`, `12`, `var(--r-lg)` → 12. Проценты и
// `calc` разбирает раскладчик, здесь им не место.
function px (value) {
  const text = resolveVars(value)
  const match = /^(-?\d+(?:\.\d+)?)px$|^(-?\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  return Number(match[1] ?? match[2])
}

function splitDeclarations (body) {
  const out = []
  let current = ''
  let depth = 0
  for (const ch of String(body)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { out.push(current); current = ''; continue }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out.map(one => one.trim()).filter(Boolean)
}

// Правила вида «селектор → объявления», включая вложенные в @media/@supports.
// У правила запоминается условие @media: проверка prefers-reduced-motion обязана
// смотреть ВСЕ блоки с этим условием во всех файлах, а не первый найденный.
function parseRules (css, media = '') {
  const rules = []
  const walk = (text, start, end, inside) => {
    let i = start
    let buffer = ''
    while (i < end) {
      const ch = text[i]
      if (ch === '{') {
        const selector = buffer.trim()
        buffer = ''
        let depth = 1
        let j = i + 1
        while (j < end && depth > 0) {
          if (text[j] === '{') depth++
          else if (text[j] === '}') depth--
          j++
        }
        const body = text.slice(i + 1, j - 1)
        if (/^@(media|supports|layer|container)/i.test(selector)) walk(body, 0, body.length, `${inside} ${selector}`.trim())
        else if (!/^@/.test(selector)) {
          const decls = new Map()
          for (const part of splitDeclarations(body)) {
            const at = part.indexOf(':')
            if (at < 1) continue
            decls.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).replace(/\s*!important\s*$/i, '').trim())
          }
          for (const one of selector.split(',')) if (one.trim()) rules.push({ selector: one.trim(), decls, media: inside })
        }
        i = j
        continue
      }
      if (ch === '}') { i++; buffer = ''; continue }
      buffer += ch
      i++
    }
  }
  walk(css, 0, css.length, media)
  return rules
}

const CSS_RULES = parseRules(CSS_ALL)

// Индекс правил по классам: эффективное значение свойства спрашивается тысячи раз
// за прогон раскладчика, а полный перебор всех правил на каждый вопрос превратил
// бы проверку в минутное ожидание.
const RULE_BY_CLASS = new Map()
const bucketFor = name => {
  if (!RULE_BY_CLASS.has(name)) RULE_BY_CLASS.set(name, [])
  return RULE_BY_CLASS.get(name)
}
CSS_RULES.forEach((rule, order) => {
  rule.order = order
  const classes = [...rule.selector.matchAll(/\.([-\w]+)/g)].map(m => m[1])
  if (!classes.length) bucketFor('*').push(rule)
  else classes.forEach(name => bucketFor(name).push(rule))
})

// Правила-кандидаты: все, где хоть один класс встречается на элементе или на его
// предках (селектор `.menu [role="option"]` относится и к строке). Полный
// отбор делает selectorMatches, здесь только грубый отсев ради скорости.
function candidateRules (el) {
  const names = new Set()
  for (let one = el; one; one = one.parentNode) {
    for (const name of String(one.className || '').split(/\s+/).filter(Boolean)) names.add(name)
  }
  const out = new Set(bucketFor('*'))
  for (const name of names) {
    for (const rule of bucketFor(name) || []) out.add(rule)
  }
  return [...out].sort((a, b) => a.order - b.order)
}

function compoundMatch (el, raw) {
  let compound = String(raw).trim()
  if (!compound || compound === '*') return true
  // Псевдоэлементы не рисуются, а служебные псевдоклассы в тесте без мыши и
  // фокуса не существуют: такое правило считаем неподходящим.
  if (/::/.test(compound) || /:/.test(compound)) return false
  const attrs = [...compound.matchAll(/\[([^\]]+)\]/g)].map(m => m[1])
  compound = compound.replace(/\[[^\]]+\]/g, '')
  const ids = [...compound.matchAll(/#([\w-]+)/g)].map(m => m[1])
  compound = compound.replace(/#[\w-]+/g, '')
  const classes = [...compound.matchAll(/\.([-\w]+)/g)].map(m => m[1])
  compound = compound.replace(/\.[-\w]+/g, '')
  // Что осталось — только имя тега. Всё остальное (`%`, `+`, опечатка) значит, что
  // селектор мы разобрать не умеем, и правило не применяется: безопаснее промах
  // по правилу, чем притвориться, что чужая строка подошла.
  if (compound && !/^[a-zA-Z][\w-]*$/.test(compound)) return false
  if (compound && el.tagName !== compound.toUpperCase()) return false
  if (ids.some(id => el.id !== id)) return false
  if (classes.some(name => !el.classList.contains(name))) return false
  return attrs.every(one => {
    const at = one.indexOf('=')
    if (at < 0) return el.getAttributeName(one) !== null
    const want = one.slice(at + 1).replace(/^["']|["']$/g, '')
    const got = el.getAttributeName(one.slice(0, at))
    return got !== null && String(got) === want
  })
}

// Селектор считается подходящим, если его последняя составная часть подходит
// элементу, а остальные встретились где-то выше (порядок — вверх по дереву).
function selectorMatches (el, selector) {
  const compounds = String(selector).split(/[\s>+~]+/).filter(Boolean)
  if (!compounds.length) return false
  if (!compoundMatch(el, compounds[compounds.length - 1])) return false
  let one = el.parentNode
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false
    for (let walk = one; walk; walk = walk.parentNode) {
      if (compoundMatch(walk, compounds[i])) { found = true; one = walk.parentNode; break }
    }
    if (!found) return false
  }
  return true
}

function matchesSelector (el, selector) {
  return String(selector).split(',').some(part => selectorMatches(el, part))
}

// Эффективное значение свойства: инлайн-стиль важнее правила, правило — то,
// что позже в файле (порядок CSS_RULES = порядок файлов и строк в них).
// Кэша нет: класс и aria-состояния меняются прямо во время проверки, и
// устаревшее значение показал бы зелёным там, где поведения нет.
// Правила из блока prefers-reduced-motion действуют только когда сценарий объявил
// этот режим: иначе «анимации нет» стало бы видно в обычной раскладке.
let reducedMotionActive = false
const ruleApplies = rule => !/prefers-reduced-motion/.test(rule.media || '') || reducedMotionActive

function effective (el, prop) {
  if (!el || !el.style) return null
  const inline = el.style.getPropertyValue(prop)
  if (inline) return inline
  let value = null
  for (const rule of candidateRules(el)) {
    if (ruleApplies(rule) && rule.decls.has(prop) && selectorMatches(el, rule.selector)) value = rule.decls.get(prop)
  }
  return value
}

// Первое непустое объявление среди узлов списка: модуль может держать ширину,
// радиус и анимацию как на корне списка, так и на его обёртке.
function declFrom (nodes, prop) {
  for (const one of nodes) {
    const value = one && effective(one, prop)
    if (value) return { node: one, value }
  }
  return { node: null, value: null }
}

const isNone = el => Boolean(el.hidden) || /none/.test(String(effective(el, 'display') || ''))

// ─── подставной DOM с раскладкой ─────────────────────────────────────────────
const CHAR = 7    // «ширина символа» подставного шрифта
const LINE = 16   // подставная высота строки
const VIEW = { x: 0, y: 0, w: 1280, h: 800 }

const dashName = key => String(key).replace(/[A-Z]/g, m => '-' + m.toLowerCase())

function makeStyle () {
  const map = new Map()
  const api = {
    getPropertyValue: key => String(map.get(String(key).toLowerCase()) || '').replace(/\s*!important\s*$/i, '').trim(),
    setProperty: (key, value) => { map.set(String(key).toLowerCase(), String(value)) },
    removeProperty: key => { map.delete(String(key).toLowerCase()) }
  }
  return new Proxy(api, {
    get (target, prop) {
      if (prop === 'cssText') return [...map].map(([k, v]) => `${k}: ${v}`).join('; ')
      if (typeof target[prop] === 'function') return target[prop].bind(target)
      if (typeof prop !== 'string') return undefined
      return target.getPropertyValue(dashName(prop))
    },
    set (target, prop, value) {
      if (prop === 'cssText') {
        map.clear()
        for (const decl of splitDeclarations(String(value))) {
          const at = decl.indexOf(':')
          if (at > 0) map.set(decl.slice(0, at).trim().toLowerCase(), decl.slice(at + 1).trim())
        }
        return true
      }
      target.setProperty(dashName(prop), value)
      return true
    }
  })
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'path', 'circle', 'rect', 'line'])

function parseMarkup (markup, parent) {
  const out = []
  const shell = { children: out, _text: '', parentNode: parent }
  const stack = [shell]
  const here = () => stack[stack.length - 1]
  for (const match of String(markup).matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g)) {
    const [, closing, tag, rawAttrs, selfClosed, text] = match
    if (text !== undefined) {
      const clean = text.replace(/\s+/g, ' ').trim()
      if (clean) here()._text = `${here()._text} ${clean}`.trim()
      continue
    }
    if (closing) { if (stack.length > 1) stack.pop(); continue }
    const el = makeEl(tag)
    el.parentNode = here() === shell ? parent : here()
    here().children.push(el)
    for (const attr of String(rawAttrs).matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g)) {
      const name = attr[1]
      const value = attr[2] === undefined ? '' : attr[2]
      if (name === 'class') for (const one of value.split(/\s+/).filter(Boolean)) el.classList.add(one)
      else if (name === 'style') el.style.cssText = value
      else if (name === 'hidden') el.hidden = true
      else el.setAttribute(name, value)
    }
    if (!selfClosed && !VOID.has(tag.toLowerCase())) stack.push(el)
  }
  return out
}

function makeEl (tagName = 'DIV') {
  const classes = new Set()
  const attrs = new Map()
  const listeners = new Map()
  const el = {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    _text: '',
    _rect: null,
    _fragment: String(tagName).toLowerCase() === 'fragment',
    // `hidden` — атрибут, а не поле: `el.hidden = false` в настоящем DOM снимает
    // атрибут, и правило `[hidden] { display: none }` перестаёт действовать.
    get hidden () { return attrs.has('hidden') },
    set hidden (value) { if (value) attrs.set('hidden', ''); else attrs.delete('hidden') },
    listeners,
    id: '',
    style: null,
    dataset: new Proxy({}, {
      get: (t, prop) => (typeof prop === 'string' ? el.getAttributeName('data-' + dashName(prop)) : null),
      set: (t, prop, value) => { el.setAttribute('data-' + dashName(prop), value); return true }
    }),
    classList: {
      add: (...names) => names.forEach(name => classes.add(String(name))),
      remove: (...names) => names.forEach(name => classes.delete(String(name))),
      contains: name => classes.has(String(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(String(name)) : Boolean(force)
        if (on) classes.add(String(name)); else classes.delete(String(name))
        return on
      }
    },
    get className () { return [...classes].join(' ') },
    set className (value) {
      classes.clear()
      for (const one of String(value).split(/\s+/).filter(Boolean)) classes.add(one)
    },
    setAttribute (name, value) {
      const key = String(name).toLowerCase()
      if (key === 'id') { el.id = String(value); attrs.set(key, String(value)); return }
      if (key === 'class') { el.className = String(value); return }
      if (key === 'hidden') { el.hidden = true; attrs.set(key, ''); return }
      attrs.set(key, String(value))
    },
    getAttribute (name) { const got = el.getAttributeName(name); return got === null ? null : String(got) },
    getAttributeName (name) {
      const key = String(name).toLowerCase()
      if (key === 'id') return el.id || null
      if (key === 'class') return el.className || null
      return attrs.has(key) ? attrs.get(key) : null
    },
    hasAttribute (name) { return el.getAttributeName(name) !== null },
    removeAttribute (name) {
      const key = String(name).toLowerCase()
      if (key === 'id') el.id = ''
      if (key === 'hidden') el.hidden = false
      attrs.delete(key)
    },
    set innerHTML (markup) { el.setInner(String(markup)) },
    get innerHTML () { return el.children.map(one => one.outerHTML).join('') },
    get outerHTML () {
      return `<${el.tagName.toLowerCase()} class="${el.className}">` +
        `${el._text}${el.children.map(one => one.outerHTML).join('')}</${el.tagName.toLowerCase()}>`
    },
    get textContent () {
      return [el._text, ...el.children.map(one => one.textContent)].join(' ').replace(/\s+/g, ' ').trim()
    },
    set textContent (value) { el._text = String(value ?? ''); el.children = [] },
    get childNodes () { return el.children },
    get firstChild () { return el.children[0] || null },
    get lastChild () { return el.children[el.children.length - 1] || null },
    get parentElement () { return el.parentNode },
    get offsetWidth () { return Math.round(box(el).w) },
    get offsetHeight () { return Math.round(box(el).h) },
    get clientWidth () { return Math.max(0, Math.round(box(el).w - insets(el).padX)) },
    get clientHeight () { return Math.max(0, Math.round(box(el).h - insets(el).padY)) },
    get scrollWidth () { return Math.round(flow(el).w + insets(el).padX) },
    get scrollHeight () { return Math.round(flow(el).h + insets(el).padY) },
    scrollTop: 0,
    scrollLeft: 0,
    focused: 0,
    scrolledIntoView: 0,
    focus () { el.focused++; if (doc) doc.activeElement = el },
    blur () { el.focused = 0 },
    scrollIntoView () { el.scrolledIntoView++ },
    setInner (markup) {
      el.children = parseMarkup(markup, el)
      el._text = ''
      const at = markup.indexOf('>')
      if (!el.children.length && at < 0) el._text = String(markup).replace(/\s+/g, ' ').trim()
      return el.children
    },
    appendChild (child) { return el.insert(child, el.children.length) },
    append (...kids) { kids.forEach(kid => el.insert(kid)) },
    prepend (...kids) { kids.slice().reverse().forEach(kid => el.insert(kid, 0)) },
    insertBefore (child, before) { el.insert(child, Math.max(0, el.children.indexOf(before))) },
    replaceChildren (...kids) { el.children = []; kids.forEach(kid => el.insert(kid)) },
    removeChild (child) { el.detach(child); return child },
    insert (child, at = el.children.length) {
      if (!child) return child
      if (child._fragment) { child.children.slice().forEach(one => el.insert(one, at++)); child.children = []; return child }
      if (child.parentNode) child.parentNode.detach(child)
      child.parentNode = el
      el.children.splice(at, 0, child)
      invalidate()
      return child
    },
    detach (child) {
      const at = el.children.indexOf(child)
      if (at >= 0) { el.children.splice(at, 1); invalidate() }
      child.parentNode = null
    },
    remove () { if (el.parentNode) el.parentNode.detach(el) },
    querySelector (selector) { return el.querySelectorAll(selector)[0] || null },
    querySelectorAll (selector) {
      const found = []
      const walk = parent => {
        for (const child of parent.children) {
          if (matchesSelector(child, selector)) found.push(child)
          walk(child)
        }
      }
      walk(el)
      return found
    },
    closest (selector) {
      let one = el
      while (one) { if (matchesSelector(one, selector)) return one; one = one.parentNode }
      return null
    },
    matches (selector) { return matchesSelector(el, selector) },
    contains (other) {
      let one = other
      while (one) { if (one === el) return true; one = one.parentNode }
      return false
    },
    addEventListener (type, fn) {
      const list = listeners.get(String(type)) || []
      if (!list.includes(fn)) list.push(fn)
      listeners.set(String(type), list)
    },
    removeEventListener (type, fn) {
      const list = listeners.get(String(type)) || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    listenerCount (type) { return (listeners.get(String(type)) || []).length },
    getBoundingClientRect () { return toRect(box(el)) },
    // События идут по тому же пути, что в браузере: элемент, потом предки,
    // потом документ — на нём и держится закрытие по клику вне.
    fire (type, event = {}) {
      let prevented = false
      const path = []
      for (let one = el; one; one = one.parentNode) path.push(one)
      if (doc) path.push(doc)
      for (const one of path) {
        const list = one === doc ? doc._list(String(type)) : (one.listeners.get(String(type)) || [])
        for (const fn of list.slice()) {
          fn({ type: String(type), target: el, currentTarget: one, clientX: 0, clientY: 0, key: '', code: '',
            button: 0, bubbles: true, relatedTarget: null, preventDefault () { prevented = true },
            stopPropagation () {}, ...event })
        }
      }
      return prevented
    }
  }
  el.style = makeStyle()
  if (String(tagName).toLowerCase() === 'canvas') {
    el.getContext = () => ({ measureText: text => ({ width: String(text).length * CHAR }), fillText () {}, font: '' })
  }
  if (String(tagName).toLowerCase() === 'template') {
    const content = makeEl('fragment')
    const setInner = el.setInner
    el.setInner = markup => { const kids = setInner.call(el, markup); content.children = kids.slice(); kids.forEach(one => { one.parentNode = content }); el.children = []; return kids }
    Object.defineProperty(el, 'innerHTML', {
      get: () => content.children.map(one => one.outerHTML).join(''),
      set: markup => { el.setInner(String(markup)) }
    })
    el.content = content
  }
  return el
}

const toRect = one => ({ x: one.x, y: one.y, left: one.x, top: one.y, width: one.w, height: one.h,
  right: one.x + one.w, bottom: one.y + one.h })

const sideValue = (raw, side) => {
  const text = resolveVars(raw)
  if (!text) return null
  const single = px(text)
  if (single !== null) return single
  const nums = (text.match(/-?\d+(?:\.\d+)?px|-?\d+(?:\.\d+)?(?=\s|$)/g) || []).map(Number)
  if (!nums.length) return null
  if (nums.length === 1) return nums[0]
  if (nums.length === 2) return side === 'top' || side === 'bottom' ? nums[0] : nums[1]
  const order = { top: 0, right: 1, bottom: 2, left: 3 }
  return nums[Math.min(order[side], nums.length - 1)]
}

const padX = (pad, border) => pad.left + pad.right + border.left + border.right
const padY = (pad, border) => pad.top + pad.bottom + border.top + border.bottom

function insets (el) {
  const pad = { top: 0, right: 0, bottom: 0, left: 0 }
  const border = { top: 0, right: 0, bottom: 0, left: 0 }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const single = px(effective(el, `padding-${side}`))
    const fromShorthand = sideValue(effective(el, 'padding'), side)
    pad[side] = single !== null ? single : (fromShorthand || 0)
    const bSingle = px(effective(el, `border-${side}-width`))
    const bShort = sideValue(effective(el, 'border-width'), side)
    border[side] = bSingle !== null ? bSingle : (bShort || 0)
    // `border: 1px solid …` — ширина живёт в короткой форме рамки.
    const shorthand = String(effective(el, 'border') || '')
    const match = /^(-?\d+(?:\.\d+)?)px/.exec(resolveVars(shorthand))
    if (match && !bSingle && !bShort) border[side] = Number(match[1])
  }
  return {
    padX: pad.left + pad.right, padY: pad.top + pad.bottom,
    borderX: border.left + border.right, borderY: border.top + border.bottom,
    totalX: padX(pad, border), totalY: padY(pad, border),
    x: pad.left + border.left, y: pad.top + border.top,
    borderLeft: border.left, borderTop: border.top
  }
}

// Длина для раскладчика: px, %, rem, calc(100% + 6px). `null` — не разобрано
// (`auto`, `fit-content`): тогда размер считается по содержимому.
function length (raw, base) {
  const text = resolveVars(raw)
  if (!text || /^(auto|none|fit-content|max-content|min-content|normal)$/i.test(text.trim())) return null
  const calc = /^calc\((.+)\)$/i.exec(text.trim())
  if (calc) {
    let total = 0
    for (const atom of calc[1].match(/[+-]?[^+-]+/g) || []) {
      const one = atom.trim()
      const sign = one.startsWith('-') ? -1 : 1
      const value = length(one.replace(/^[+-]\s*/, ''), base)
      if (value === null) return null
      total += sign * value
    }
    return total
  }
  const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text)
  if (percent) return Number(percent[1]) / 100 * base
  const direct = /^(-?\d+(?:\.\d+)?)(px|rem|em|vh|vw)?$/i.exec(text)
  if (direct) {
    const value = Number(direct[1])
    const unit = (direct[2] || 'px').toLowerCase()
    if (unit === 'px') return value
    if (unit === 'rem' || unit === 'em') return value * 16
    if (unit === 'vh') return value / 100 * VIEW.h
    return value / 100 * VIEW.w
  }
  return null
}

const inFlow = el => !isNone(el) &&
  !/^(absolute|fixed)$/.test(String(effective(el, 'position') || 'static'))

// Естественный размер: объявленное > содержимое > дети в потоке.
function natural (el, seen = new Set()) {
  if (seen.has(el)) return { w: 0, h: 0 }
  seen.add(el)
  const ins = insets(el)
  const declaredW = length(effective(el, 'width'), VIEW.w)
  const declaredH = length(effective(el, 'height'), VIEW.h)
  let contentW = 0
  let contentH = 0
  if (el._text && !el.children.length) {
    contentW = String(el._text).length * CHAR
    const leading = length(effective(el, 'line-height'), LINE)
    contentH = leading === null ? LINE : leading
  }
  for (const kid of el.children) {
    if (!inFlow(kid)) continue
    const size = natural(kid, new Set(seen))
    contentW = Math.max(contentW, size.w)
    contentH += size.h
  }
  let w = declaredW !== null ? declaredW : contentW + ins.totalX
  let h = declaredH !== null ? declaredH : contentH + ins.totalY
  for (const [prop, isWidth] of [['min-height', false], ['max-height', false], ['min-width', true], ['max-width', true]]) {
    const limit = length(effective(el, prop), isWidth ? VIEW.w : VIEW.h)
    if (limit === null) continue
    if (prop.startsWith('min')) { if (isWidth) w = Math.max(w, limit); else h = Math.max(h, limit) }
    else { if (isWidth) w = Math.min(w, limit); else h = Math.min(h, limit) }
  }
  return { w, h }
}

// То, что уходит за край и достаётся прокруткой.
function flow (el) {
  let h = 0
  let w = 0
  if (el._text && !el.children.length) { h = String(el._text).length ? LINE : 0; w = String(el._text).length * CHAR }
  for (const kid of el.children) {
    if (!inFlow(kid)) continue
    const size = natural(kid)
    h += size.h
    w = Math.max(w, size.w)
  }
  return { w, h }
}

let memo = new WeakMap()
const invalidate = () => { memo = new WeakMap() }

function box (el, depth = 0) {
  if (el._rect) return el._rect
  if (memo.has(el)) return memo.get(el)
  if (depth > 40) return { x: 0, y: 0, w: 0, h: 0 }
  const position = String(effective(el, 'position') || 'static')
  const free = position === 'fixed' || position === 'absolute'
  const containerEl = position === 'fixed' ? null : el.parentNode
  const container = containerEl ? box(containerEl, depth + 1) : { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h }
  // Начало координат потомка: для потокового элемента — содержимое родителя
  // (его рамка + отступ), для absolutely positioned —padding-бокс родителя.
  const cbox = containerEl ? insets(containerEl) : { x: 0, y: 0, borderX: 0, borderY: 0, w: VIEW.w, h: VIEW.h }
  const size = natural(el)
  if (free) {
    const baseW = container.w - cbox.borderX
    const baseH = container.h - cbox.borderY
    const top = length(effective(el, 'top'), baseH)
    const bottom = length(effective(el, 'bottom'), baseH)
    const left = length(effective(el, 'left'), baseW)
    const right = length(effective(el, 'right'), baseW)
    const x = left !== null ? container.x + cbox.borderX + left
      : (right !== null ? container.x + container.w - cbox.borderX - right - size.w : container.x + cbox.borderX)
    const y = top !== null ? container.y + cbox.borderY + top
      : (bottom !== null ? container.y + container.h - cbox.borderY - bottom - size.h : container.y + cbox.borderY)
    const out = { x, y, w: size.w, h: size.h }
    memo.set(el, out)
    return out
  }
  let flowY = container.y + cbox.y
  if (containerEl) {
    for (const sib of containerEl.children) {
      if (sib === el) break
      if (!inFlow(sib)) continue
      flowY += natural(sib).h
    }
  }
  const shiftY = length(effective(el, 'top'), size.h) || 0
  const out = { x: container.x + cbox.x, y: flowY + shiftY, w: size.w, h: size.h }
  memo.set(el, out)
  return out
}

function visible (el) {
  for (let one = el; one; one = one.parentNode) if (isNone(one)) return false
  const rect = box(el)
  return rect.w > 0 && rect.h > 0
}

// Цвет так, как его отдаёт браузер: токен развёрнут, hex сведён к `rgb(…)`.
function colorLiteral (text) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(String(text).trim())
  if (!hex) return String(text).trim()
  let value = hex[1]
  if (value.length === 3) value = value.split('').map(c => c + c).join('')
  return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`
}

function colorOf (el, kind) {
  for (const prop of kind === 'background' ? ['background-color', 'background'] : ['color']) {
    const raw = effective(el, prop)
    if (!raw) continue
    const text = resolveVars(raw)
    if (/^(none|transparent|inherit|currentcolor|initial)$/i.test(text)) continue
    return colorLiteral(text)
  }
  return kind === 'background' ? 'rgba(0, 0, 0, 0)' : 'rgb(0, 0, 0)'
}

// Значение токена в том же виде, что выдаёт colorOf: сравниваем «равен ли фон
// выбранной строки токену bg-raised», а не конкретную котову темы.
const tokenColor = name => colorLiteral(resolveVars(TOKENS.get(name) || `var(${name})`))

// ─── документ и окно ─────────────────────────────────────────────────────────
let doc = null

function makeDocument () {
  const body = makeEl('BODY')
  const html = makeEl('HTML')
  body.parentNode = html
  html.children = [body]
  const own = new Map()
  const api = {
    body,
    documentElement: html,
    readyState: 'complete',
    activeElement: body,
    createElement: tag => makeEl(tag),
    createTextNode (text) { const el = makeEl('#text'); el._text = String(text); return el },
    createDocumentFragment () { return makeEl('fragment') },
    createRange () {
      let node = null
      const target = () => (node && node.nodeType === 1 ? node : (node && node.parentNode) || body)
      return {
        setStart (one) { node = one }, setEnd (one) { node = node || one },
        selectNode (one) { node = one }, selectNodeContents (one) { node = one },
        getBoundingClientRect () { return toRect(box(target())) },
        getClientRects () { return [this.getBoundingClientRect()] },
        collapse () {}, detach () {}
      }
    },
    getElementById (id) {
      let found = null
      const walk = parent => {
        for (const child of parent.children) {
          if (child.id === String(id)) found = found || child
          walk(child)
        }
      }
      walk(html)
      return found
    },
    querySelector (selector) { return api.querySelectorAll(selector)[0] || null },
    querySelectorAll (selector) {
      const found = []
      const walk = parent => {
        for (const child of parent.children) {
          if (matchesSelector(child, selector)) found.push(child)
          walk(child)
        }
      }
      walk(html)
      return found
    },
    _list (type) {
      if (!own.has(type)) own.set(type, [])
      return own.get(type)
    },
    addEventListener (type, fn) {
      const list = api._list(String(type))
      if (!list.includes(fn)) list.push(fn)
    },
    removeEventListener (type, fn) {
      const list = api._list(String(type))
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    fire (type, event = {}) {
      let prevented = false
      for (const fn of api._list(String(type)).slice()) {
        fn({ type: String(type), target: event.target || body, key: '', code: '', button: 0, clientX: 0,
          clientY: 0, bubbles: true, relatedTarget: null, preventDefault () { prevented = true },
          stopPropagation () {}, ...event })
      }
      return prevented
    }
  }
  return api
}

function makeWindow (document, state) {
  const own = new Map()
  const win = {
    document,
    innerWidth: VIEW.w,
    innerHeight: VIEW.h,
    devicePixelRatio: 1,
    scrollY: 0,
    scrollTo () {},
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame (cb) { state.frames++; cb(Date.now()); return state.frames },
    cancelAnimationFrame () {},
    matchMedia: query => ({
      media: String(query),
      get matches () { return /prefers-reduced-motion/.test(String(query)) ? state.reducedMotion : false },
      addEventListener () {}, removeEventListener () {}, addListener () {}, removeListener () {}
    }),
    getComputedStyle: el => ({
      getPropertyValue: prop => resolveVars(effective(el, prop)) || (prop === 'display' ? (isNone(el) ? 'none' : 'block') : ''),
      getPropertyPriority: () => '',
      display: isNone(el) ? 'none' : (resolveVars(effective(el, 'display')) || 'block'),
      position: resolveVars(effective(el, 'position')) || 'static',
      width: `${Math.round(box(el).w)}px`,
      height: `${Math.round(box(el).h)}px`,
      fontSize: resolveVars(effective(el, 'font-size')) || '16px',
      fontFamily: resolveVars(effective(el, 'font-family')) || '',
      fontWeight: resolveVars(effective(el, 'font-weight')) || '400',
      lineHeight: resolveVars(effective(el, 'line-height')) || 'normal',
      color: colorOf(el, 'color'),
      backgroundColor: colorOf(el, 'background'),
      borderRadius: resolveVars(effective(el, 'border-radius')) || '0px',
      overflowY: resolveVars(effective(el, 'overflow-y') || effective(el, 'overflow')) || 'visible'
    }),
    addEventListener (type, fn) {
      const list = own.get(String(type)) || []
      list.push(fn)
      own.set(String(type), list)
    },
    removeEventListener (type, fn) {
      const list = own.get(String(type)) || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    fire (type, event = {}) {
      for (const fn of (own.get(String(type)) || []).slice()) fn({ type: String(type), preventDefault () {}, ...event })
    },
    Event: class Event { constructor (type, init = {}) { this.type = type; Object.assign(this, init) } },
    KeyboardEvent: class KeyboardEvent { constructor (type, init = {}) { this.type = type; Object.assign(this, init) } },
    MouseEvent: class MouseEvent { constructor (type, init = {}) { this.type = type; Object.assign(this, init) } }
  }
  return win
}

// ─── сценарий ────────────────────────────────────────────────────────────────
const RU_ITEMS = [
  { id: 'self', name: '/self', hint: 'Направить агента на исходники приложения' },
  { id: 'effort', name: '/effort', hint: 'Открыть настройку глубины рассуждений' },
  { id: 'review', name: '/review', hint: 'Комплексный аудит качества кода' },
  { id: 'security', name: '/security', hint: 'Аудит безопасности и поиск утечек' },
  { id: 'fix', name: '/fix', hint: 'Починить падение' },
  { id: 'clear', name: '/clear', hint: 'Очистить диалог' }
]

const RU_MODES = [
  { id: 'plan', name: 'Plan', hint: 'Только чтение: агент ничего не изменит' },
  { id: 'manual', name: 'Manual', hint: 'Спрашивать перед каждым изменением' },
  { id: 'acceptEdits', name: 'Accept Edits', hint: 'Запись без вопросов' },
  { id: 'auto', name: 'Auto', hint: 'Без вопросов; удаление — с вопросом' }
]

const EN_MAP = {
  'Направить агента на исходники приложения': 'Point the agent at this app sources',
  'Открыть настройку глубины рассуждений': 'Open the reasoning depth setting',
  'Комплексный аудит качества кода': 'Full code quality audit',
  'Аудит безопасности и поиск утечек': 'Security audit and leak hunt',
  'Починить падение': 'Fix the failure',
  'Очистить диалог': 'Clear the chat',
  'Только чтение: агент ничего не изменит': 'Read only: the agent changes nothing',
  'Спрашивать перед каждым изменением': 'Ask before every change',
  'Запись без вопросов': 'Write without asking',
  'Без вопросов; удаление — с вопросом': 'No questions, deleting always asks'
}

// Ключи deps, которые виду-списку неоткуда просить: мост, сеть, настройки.
const BRIDGE_KEYS = /electron|api|ipc|bridge|network|fetch|http|socket|settings|store|workspace|permission|secret|model|command/i

function makeDeps (state, lang) {
  const document = makeDocument()
  doc = document
  const win = makeWindow(document, state)
  const accessed = new Set()
  const t = key => (lang === 'en' ? EN_MAP[key] || key : key)
  const base = {
    document,
    window: win,
    t,
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    now: () => Date.now()
  }
  const deps = new Proxy(base, {
    get (target, prop) {
      if (typeof prop !== 'string') return target[prop]
      accessed.add(prop)
      return target[prop]
    }
  })
  // Правила проекта: экран не лезет в мост напрямую. В окне `window` — это
  // подставка без electronAPI, поэтому любая попытка достучаться до него падает
  // здесь, а не молча проходит на тесте.
  global.window = win
  global.document = document
  return { document, win, deps, accessed, t }
}

// Поле ввода и пилюля режимов — как в окне, с позиционированным родителем (в
// `index.html` это `.composer-col` и `.perm-wrap`, обе `position: relative`).
function scenario (opts = {}) {
  const module = freshModule()
  const state = { reducedMotion: Boolean(opts.reducedMotion), frames: 0 }
  reducedMotionActive = Boolean(opts.reducedMotion)
  const { document, win, deps, accessed, t } = makeDeps(state, opts.lang)
  invalidate()

  const field = document.createElement('DIV')
  field.id = 'composerField'
  field.className = 'composer-input-box'
  field.style.position = 'relative'
  field._rect = { x: 218, y: 500, w: 762, h: 84 }
  document.body.appendChild(field)

  const pill = document.createElement('BUTTON')
  pill.id = 'permModeBtn'
  pill.className = 'btn-bar btn-bar-text'
  pill.style.position = 'relative'
  pill._rect = { x: 96, y: 620, w: 104, h: 30 }
  document.body.appendChild(pill)

  const picks = []
  const api = module.create(deps)
  const items = opts.items || (opts.anchor === 'pill' ? RU_MODES : RU_ITEMS)
  const anchor = opts.anchor === 'pill' ? pill : field
  api.open({
    anchor,
    items,
    selected: opts.selected === undefined ? 0 : opts.selected,
    ariaLabel: opts.ariaLabel || (opts.anchor === 'pill' ? 'Режим разрешений' : 'Команды'),
    onPick: item => picks.push(item)
  })
  invalidate()
  return { api, document, win, deps, accessed, t, field, pill, picks, items, state }
}

function menuOf (run) {
  const found = run.document.querySelectorAll('[role="listbox"]').filter(visible)
  assert.ok(found.length, 'открытого списка нет: в DOM нет видимого элемента с role="listbox"')
  return found[0]
}

const rowsOf = (run, menu = menuOf(run)) => menu.querySelectorAll('[role="option"]')

// Обёртка, корень списка и его дети — где модуль мог объявить ширину, радиус,
// анимацию и прокрутку.
function layers (run, menu = menuOf(run)) {
  return [menu, ...(menu.children || []), menu.parentNode].filter(Boolean)
}

// Подсказка: видимый элемент СНАРУЖИ строк, несущий ровно текст описания.
function hintNode (run, text, menu = menuOf(run)) {
  if (!text) return null
  const rows = rowsOf(run, menu)
  return run.document.querySelectorAll('*').filter(visible)
    .find(one => !rows.some(row => row.contains(one)) && one.textContent.replace(/\s+/g, ' ').trim() === text) || null
}

const hover = el => ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'].forEach(type => el.fire(type, { target: el }))
const press = el => ['pointerdown', 'mousedown', 'click'].forEach(type => el.fire(type, { target: el }))

// ─── проверки ────────────────────────────────────────────────────────────────

check('модуль composer-menu.js написан и отдан окну', () => {
  const source = needModule() && readModule()
  assert.match(source, /OnlyoneComposerMenu\s*=/,
    'модуль не отдаёт себя окну через window.OnlyoneComposerMenu — app.js его не найдёт')
})

check('модуль подключён в index.html до app.js', () => {
  needModule()
  const markup = read('src/renderer/index.html').replace(/\r/g, '')
  const at = markup.indexOf('<script src="composer-menu.js"></script>')
  assert.ok(at >= 0, 'в index.html нет строки подключения composer-menu.js')
  assert.ok(at < markup.indexOf('<script src="app.js"></script>'),
    'composer-menu.js подключён после app.js — окно не соберётся')
})

check('create(deps) отдаёт замороженный набор из шести методов', () => {
  const module = freshModule()
  assert.equal(typeof module.create, 'function', 'у модуля нет create(deps)')
  const state = { reducedMotion: false, frames: 0 }
  const { deps } = makeDeps(state, 'ru')
  const api = module.create(deps)
  assert.ok(api && typeof api === 'object', 'create не вернул объект')
  assert.ok(Object.isFrozen(api), 'create вернул незащищённый объект: контракт требует Object.freeze')
  for (const name of ['open', 'close', 'move', 'accept', 'isOpen', 'dispose']) {
    assert.equal(typeof api[name], 'function', `контракт обещает «${name}», в модуле его нет`)
  }
})

check('модуль не знает ни о мосте, ни о сети, ни о настройках: всё через deps', () => {
  const source = needModule() && stripComments(readModule())
  const banned = [
    [/electronAPI/, 'window.electronAPI'],
    [/\bfetch\s*\(/, 'fetch'],
    [/XMLHttpRequest/, 'XMLHttpRequest'],
    [/WebSocket/, 'WebSocket'],
    [/sendBeacon/, 'navigator.sendBeacon'],
    [/ipcRenderer/, 'ipcRenderer'],
    [/setWorkspace|getWorkspace/, 'сохранение рабочей папки'],
    [/getSettings|setSettings/, 'настройки'],
    [/localStorage|sessionStorage/, 'хранилище браузера'],
    [/\brequire\s*\(/, 'require (в окне его нет)']
  ]
  const hit = banned.filter(([re]) => re.test(source)).map(([, label]) => label)
  assert.deepEqual(hit, [], `модуль лезет в чужие зоны напрямую: ${hit.join(', ')}`)
  const run = scenario()
  const leaked = [...run.accessed].filter(key => BRIDGE_KEYS.test(key))
  assert.deepEqual(leaked, [], `модуль попросил у окна ключи, которых у вида быть не должно: ${leaked.join(', ')}`)
})

check('список рисует ровно то, что принесли: по строке на пункт, в том же порядке', () => {
  const run = scenario()
  const rows = rowsOf(run)
  assert.equal(rows.length, run.items.length, `строк ${rows.length}, а принесли ${run.items.length}`)
  const names = rows.map(one => one.textContent.replace(/\s+/g, ' ').trim())
  assert.deepEqual(names, run.items.map(one => one.name), `в строках не те имена: ${names.join(' | ')}`)
})

check('у открытого списка есть role="listbox", aria-label и aria-activedescendant на выбранную строку', () => {
  const run = scenario()
  const menu = menuOf(run)
  assert.equal(menu.getAttribute('aria-label'), 'Команды', `aria-label открытого списка не тот: ${menu.getAttribute('aria-label')}`)
  const active = menu.getAttribute('aria-activedescendant')
  assert.ok(active, 'у открытого списка нет aria-activedescendant')
  const row = run.document.getElementById(active)
  assert.ok(row, `aria-activedescendant ссылается на несуществующий id «${active}»`)
  assert.ok(menu.contains(row), 'aria-activedescendant ссылается на строку вне списка')
  const selected = rowsOf(run).filter(one => one.getAttribute('aria-selected') === 'true')
  assert.equal(selected.length, 1, `строк с aria-selected="true": ${selected.length}, должна быть одна`)
})

check('в строке только имя: описания в строке нет', () => {
  const run = scenario()
  const rows = rowsOf(run)
  for (const [index, row] of rows.entries()) {
    const text = row.textContent.replace(/\s+/g, ' ').trim()
    assert.equal(text, run.items[index].name, `в строке «${text}» читается что-то кроме имени`)
    assert.equal(RU.test(text), false, `в строке «${text}» затесалось русское описание`)
  }
})

check('шапки «Доступные команды»/«Commands» над списком больше нет', () => {
  const run = scenario()
  const menu = menuOf(run)
  const texts = [menu, ...menu.querySelectorAll('*')].map(one => one.textContent.replace(/\s+/g, ' ').trim())
  const header = texts.find(text => /^(доступные команды|commands|available commands)\b/i.test(text))
  assert.equal(header, undefined, `список начинается с шапки «${header}»`)
})

check('у строк нет title; описание не подписано data-tooltip (глобальная подсказка встала бы сверху или снизу)', () => {
  const run = scenario()
  const rows = rowsOf(run)
  assert.equal(rows.some(one => one.hasAttribute('title')), false, 'на строке появился title= — в проекте он под запретом')
  assert.equal(rows.some(one => one.hasAttribute('data-tooltip')), false,
    'строка подписана data-tooltip: глобальные подсказки ставятся над/под якорем, а контракт требует подсказку справа')
})

check('move(±1) сдвигает выбор, ведёт за собой aria-activedescendant и не выпускает выбор за края', () => {
  const run = scenario()
  assert.equal(rowsOf(run)[0].getAttribute('aria-selected'), 'true', 'после open выбранная строка не помечена aria-selected')
  run.api.move(1)
  invalidate()
  const rows = rowsOf(run)
  const down = rows.findIndex(one => one.getAttribute('aria-selected') === 'true')
  assert.equal(down, 1, `move(1) не сдвинул выбор: выбрана строка ${down}`)
  assert.equal(menuOf(run).getAttribute('aria-activedescendant'), rows[1].getAttribute('id'),
    'aria-activedescendant не поехал за выбором')
  for (let i = 0; i < run.items.length + 2; i++) run.api.move(1)
  invalidate()
  assert.equal(rowsOf(run).filter(one => one.getAttribute('aria-selected') === 'true').length, 1,
    'после серии ходов вниз выбранная строка не одна')
  for (let i = 0; i < run.items.length + 2; i++) run.api.move(-1)
  invalidate()
  assert.equal(rowsOf(run).filter(one => one.getAttribute('aria-selected') === 'true').length, 1,
    'после серии ходов вверх выбранная строка не одна')
})

check('accept() отдаёт выбранный пункт, а после close() — ничего', () => {
  const run = scenario()
  run.api.move(2)
  const picked = run.api.accept()
  assert.ok(picked, 'accept() вернул пустое при открытом списке')
  const id = typeof picked === 'number' ? (run.items[picked] || {}).id : (picked.id || picked)
  assert.equal(id, run.items[2].id, `accept() отдал «${id}», а выбран «${run.items[2].id}»`)
  run.api.close()
  assert.equal(run.api.isOpen(), false, 'isOpen() не сказал, что список закрыт')
  assert.equal(run.api.accept(), null, 'после close() accept() обязан вернуть null')
})

check('клик вне списка, Escape и dispose() закрывают список и снимают проводку', () => {
  const run = scenario()
  const outside = run.document.createElement('DIV')
  run.document.body.appendChild(outside)
  press(outside)
  run.document.fire('click', { target: outside })
  assert.equal(run.api.isOpen(), false, 'клик вне списка не закрыл его')

  run.api.open({ anchor: run.field, items: run.items, selected: 0, ariaLabel: 'Команды', onPick () {} })
  assert.equal(run.api.isOpen(), true, 'список не открылся вторично — дальше проверять нечего')
  run.document.fire('keydown', { key: 'Escape' })
  assert.equal(run.api.isOpen(), false, 'Escape не закрыл список')

  run.api.open({ anchor: run.field, items: run.items, selected: 0, ariaLabel: 'Команды', onPick () {} })
  run.api.dispose()
  assert.equal(run.api.isOpen(), false, 'dispose() оставил список открытым')
  assert.equal(run.document.querySelectorAll('[role="listbox"]').filter(visible).length, 0,
    'после dispose() в DOM остался видимый список')
  run.document.fire('keydown', { key: 'Escape' })
  run.document.fire('click', { target: run.document.body })
  assert.equal(run.api.isOpen(), false, 'после dispose() проводка всё ещё реагирует на события документа')
})

check('клик по строке отдаёт её в onPick и закрывает список', () => {
  const run = scenario()
  const row = rowsOf(run)[3]
  row.fire('click', { target: row })
  if (!run.picks.length) press(row)
  assert.equal(run.picks.length, 1, `onPick вызван ${run.picks.length} раз, ожидался один`)
  const picked = run.picks[0]
  const id = picked && (picked.id || picked)
  assert.equal(id, run.items[3].id, `в onPick ушёл «${id}», а кликали «${run.items[3].id}»`)
  assert.equal(run.api.isOpen(), false, 'после выбора строки список остался открытым')
})

check('подсказки нет, пока ничего не выбрано мышью или стрелками', () => {
  const run = scenario()
  for (const item of run.items) {
    assert.equal(hintNode(run, run.t(item.hint)), null,
      `сразу после open показана подсказка «${run.t(item.hint)}»`)
  }
})

check('стрелки и наведение мышью показывают подсказку нужной строки', () => {
  const run = scenario()
  run.api.move(2)
  invalidate()
  assert.ok(hintNode(run, run.t(run.items[2].hint)),
    `после move(2) нет подсказки «${run.t(run.items[2].hint)}»`)
  const rows = rowsOf(run)
  hover(rows[4])
  invalidate()
  assert.ok(hintNode(run, run.t(run.items[4].hint)), 'при наведении мышью подсказка строки не появилась')
})

check('подсказка стоит справа от выбранной строки, а не над списком и не под ним', () => {
  const run = scenario()
  run.api.move(1)
  invalidate()
  const row = rowsOf(run)[1]
  const hint = hintNode(run, run.t(run.items[1].hint))
  assert.ok(hint, 'подсказка выбранной строки не найдена')
  const rowBox = box(row)
  const hintBox = box(hint)
  assert.ok(hintBox.x >= rowBox.x + rowBox.w - 1,
    `подсказка не справа: её левый край ${Math.round(hintBox.x)}, правый край строки ${Math.round(rowBox.x + rowBox.w)}`)
  const overlap = Math.min(hintBox.y + hintBox.h, rowBox.y + rowBox.h) - Math.max(hintBox.y, rowBox.y)
  assert.ok(overlap > 0, `подсказка не на уровне своей строки: пересечение по вертикали ${Math.round(overlap)}`)
})

check('подсказка: текст 12/16 и ширина не больше 280 px', () => {
  const run = scenario()
  run.api.move(1)
  invalidate()
  const hint = hintNode(run, run.t(run.items[1].hint))
  assert.ok(hint, 'подсказка не появилась')
  assert.equal(px(effective(hint, 'font-size')), 12, `размер текста подсказки ${px(effective(hint, 'font-size'))}, контракт требует 12`)
  assert.equal(px(effective(hint, 'line-height')), 16, `высота строки подсказки ${px(effective(hint, 'line-height'))}, контракт требует 16`)
  const maxWidth = px(effective(hint, 'max-width'))
  assert.ok(maxWidth !== null && maxWidth <= 280, `у подсказки нет max-width в пределах 280 px (найдено ${maxWidth})`)
  assert.ok(box(hint).w <= 281, `подсказка вышла за 280 px: ${Math.round(box(hint).w)}`)
})

check('подсказка идёт через t(): на английском — английская строка', () => {
  const run = scenario({ lang: 'en' })
  run.api.move(0)
  invalidate()
  const english = run.t(run.items[0].hint)
  assert.equal(RU.test(english), false, 'проверка сломана: английский эталон содержит кириллицу')
  assert.ok(hintNode(run, english), `на английском подсказка не переведена: ждали «${english}»`)
  const anyRussian = run.document.querySelectorAll('*').filter(one => visible(one) && !one.children.length && RU.test(one.textContent))
  assert.equal(anyRussian.length, 0,
    `на английском экране читается кириллица: ${anyRussian.map(one => one.textContent.trim()).join(' | ').slice(0, 160)}`)
})

check('список встаёт над якорем: нижний край на 6 px выше поля ввода', () => {
  const run = scenario()
  const menu = menuOf(run)
  const menuBox = box(menu)
  const anchorBox = box(run.field)
  const gap = anchorBox.y - (menuBox.y + menuBox.h)
  assert.ok(menuBox.y + menuBox.h < anchorBox.y + 1,
    'список встал под полем ввода — контракт требует над полем')
  assert.ok(Math.abs(gap - 6) <= 0.6,
    `зазор над полем ${Math.round(gap * 10) / 10} px, контракт требует 6 px (низ списка ${Math.round(menuBox.y + menuBox.h)}, верх поля ${Math.round(anchorBox.y)})`)
})

check('левый край списка — по левому краю текста поля, у режимов — по левому краю пилюли', () => {
  const commands = scenario()
  const menuBox = box(menuOf(commands))
  const anchor = box(commands.field)
  assert.ok(Math.abs(menuBox.x - anchor.x) <= 0.6,
    `у команд левый край ${Math.round(menuBox.x)} px, у поля ${Math.round(anchor.x)} px`)
  const modes = scenario({ anchor: 'pill' })
  const modesBox = box(menuOf(modes))
  const pill = box(modes.pill)
  assert.ok(Math.abs(modesBox.x - pill.x) <= 0.6,
    `у режимов левый край ${Math.round(modesBox.x)} px, у пилюли ${Math.round(pill.x)} px`)
  const gap = pill.y - (modesBox.y + modesBox.h)
  assert.ok(Math.abs(gap - 6) <= 0.6, `список режимов встал на ${Math.round(gap * 10) / 10} px над пилюлей, ждали 6`)
})

check('ширина списка = самое длинное имя + 24 px, но не уже 160 и не шире 240', () => {
  const cases = [
    { names: ['/a', '/bb'], expect: 160, why: 'короткие имена: пол не уже 160' },
    { names: ['/verylongcommandname'], expect: 20 * CHAR + 24, why: 'среднее имя: ровно ширина имени + 24' },
    { names: ['/a'.padEnd(60, 'b')], expect: 240, why: 'длинное имя: потолок 240' }
  ]
  for (const one of cases) {
    const items = one.names.map((name, index) => ({ id: `c${index}`, name, hint: `Описание ${index}` }))
    const run = scenario({ items })
    const menu = menuOf(run)
    const found = declFrom([menu, ...menu.children, menu.parentNode].filter(Boolean), 'width')
    const declared = length(found.value, VIEW.w)
    assert.ok(declared !== null,
      `ширина списка не задана числом (найдено «${found.value}») — ${one.why}: без числа сверять формулу не с чем`)
    assert.ok(Math.abs(declared - one.expect) <= 1, `${one.why}: ширина ${Math.round(declared)} px, ждали ${one.expect} px`)
  }
})

check('строка 28 px, внутренний отступ списка 10 px', () => {
  const run = scenario()
  const menu = menuOf(run)
  const rows = rowsOf(run)
  for (const row of rows) {
    const declared = length(effective(row, 'height'), VIEW.h) ?? length(effective(row, 'min-height'), VIEW.h)
    const height = declared === null ? box(row).h : declared
    assert.ok(Math.abs(height - 28) <= 0.6, `высота строки ${Math.round(height * 10) / 10} px, контракт требует 28`)
  }
  const menuBox = box(menu)
  const frame = insets(menu)
  const first = box(rows[0])
  assert.ok(Math.abs(first.x - menuBox.x - frame.borderLeft - 10) <= 0.7,
    `внутренний отступ слева ${Math.round((first.x - menuBox.x - frame.borderLeft) * 10) / 10} px, контракт требует 10`)
  assert.ok(Math.abs(first.y - menuBox.y - frame.borderTop - 10) <= 0.7,
    `внутренний отступ сверху ${Math.round((first.y - menuBox.y - frame.borderTop) * 10) / 10} px, контракт требует 10`)
})

// Радиусы и цвета списка — по макету 19.10 (меню --r-md 14, пункт --r-sm 10);
// размеры строки, отступа и коридора ширины — прежний контракт владельца.
check('радиусы: у списка 14 px, у пункта 10 px', () => {
  const run = scenario()
  const menu = menuOf(run)
  const menuRadius = px(declFrom(layers(run, menu), 'border-radius').value)
  assert.equal(menuRadius, 14, `скругление списка ${menuRadius}, макет требует 14`)
  const rowRadius = px(declFrom([rowsOf(run)[0]], 'border-radius').value)
  assert.equal(rowRadius, 10, `скругление пункта ${rowRadius}, макет требует 10`)
})

check('имя команды набрано --font-ui 13/400: не моноширинным и не акцентным цветом', () => {
  const run = scenario()
  const row = rowsOf(run)[2]
  const name = [row, ...row.querySelectorAll('*')].find(one => one.textContent.trim() === run.items[2].name && !one.children.length)
  assert.ok(name, 'в строке не нашлось элемента с именем команды — непонятно, чем оно набрано')
  const rawFamily = String(effective(name, 'font-family') || '')
  const family = resolveVars(rawFamily)
  const ui = resolveVars(TOKENS.get('--font-ui') || '')
  const mono = resolveVars(TOKENS.get('--font-mono') || '')
  assert.ok(/--font-ui|--font-sans/.test(rawFamily) || (ui && family === ui),
    `имя набрано шрифтом «${rawFamily || 'не задан'}» — контракт требует --font-ui`)
  // Моноширинного в приложении нет вовсе (макет 19.10): --font-mono — псевдоним
  // интерфейсного стека, поэтому сверяется имя, которым правило назвало шрифт.
  assert.equal(/--font-mono|--font-code|monospace/i.test(rawFamily) || Boolean(mono && family === mono && !/--font-ui|--font-sans/.test(rawFamily) && ui !== mono), false,
    `имя команды уехало в моноширинный шрифт: ${rawFamily}`)
  assert.equal(px(effective(name, 'font-size')), 13, `размер имени ${px(effective(name, 'font-size'))}, макет требует 13`)
  assert.equal(px(effective(name, 'font-weight')), 400, `начертание имени ${px(effective(name, 'font-weight'))}, контракт требует 400`)
  const color = colorOf(name, 'color')
  for (const token of ['--accent-primary', '--accent', '--accent-strong']) {
    if (!TOKENS.has(token)) continue
    assert.notEqual(color, tokenColor(token), `имя команды подкрашено акцентом ${token}`)
  }
})

check('выбранная строка: фон bg-hover, текст ink', () => {
  const run = scenario()
  const selected = rowsOf(run).find(one => one.getAttribute('aria-selected') === 'true')
  assert.ok(selected, 'нет выбранной строки — проверять нечего')
  assert.equal(colorOf(selected, 'background'), tokenColor('--bg-hover'),
    `фон выбранной строки ${colorOf(selected, 'background')}, макет требует bg-hover (${tokenColor('--bg-hover')})`)
  // Токена `--ink` в проекте нет; «ink» в контракте — обычный текст, `--text`.
  assert.equal(colorOf(selected, 'color'), tokenColor(TOKENS.has('--ink') ? '--ink' : '--text'),
    `текст выбранной строки ${colorOf(selected, 'color')}, контракт требует ink (${tokenColor('--text')})`)
})

check('больше 8 строк — прокрутка внутри списка, а не растущий в высоту блок', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({ id: `c${index}`, name: `/cmd${index}`, hint: `Описание ${index}` }))
  const run = scenario({ items })
  const menu = menuOf(run)
  const nodes = layers(run, menu)
  const scroller = nodes.find(one => /auto|scroll/.test(String(effective(one, 'overflow-y') || effective(one, 'overflow') || '')))
  assert.ok(scroller, 'при 13 строках ни у чего нет прокрутки (overflow-y: auto|scroll) — список растёт в высоту')
  const limit = length(effective(scroller, 'max-height'), VIEW.h) ?? length(effective(scroller, 'height'), VIEW.h)
  assert.ok(limit !== null, 'у прокручиваемого блока нет ни max-height, ни height: высота ничем не ограничена')
  assert.ok(limit <= 8 * 28 + 2 * 10 + 2,
    `прокрутка включится только после ${Math.round(limit)} px — это больше восьми строк по 28 px`)
  assert.ok(scroller.scrollHeight > scroller.clientHeight,
    `список не прокручивается: содержимое ${scroller.scrollHeight} px, видно ${scroller.clientHeight} px`)
  const anchored = box(run.field).y - (box(menu).y + box(menu).h)
  assert.ok(Math.abs(anchored - 6) <= 1,
    `с 13 строками список держит над полем ${Math.round(anchored)} px, ждали те же 6`)
})

check('появление: снизу на 4 px и из прозрачности за 140 ms (макет 19.10)', () => {
  const run = scenario()
  const menu = menuOf(run)
  const found = declFrom(layers(run, menu), 'animation')
  const animation = resolveVars(found.value)
  assert.ok(animation, 'у открытого списка нет анимации появления')
  const duration = /(\d+(?:\.\d+)?)(ms|s)\b/.exec(animation)
  assert.ok(duration, `в анимации не читается длительность: ${animation}`)
  const ms = duration[2] === 's' ? Number(duration[1]) * 1000 : Number(duration[1])
  assert.equal(ms, 140, `появление идёт ${ms} ms, макет требует 140`)
  const name = animation.split(/\s+/).find(one => CSS_ALL.includes(`@keyframes ${one}`))
  assert.ok(name, `анимация ссылается на неизвестные кадры: ${animation}`)
  const bodyMatch = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(CSS_ALL)
  assert.ok(bodyMatch, `не найден блок @keyframes ${name}`)
  const body = bodyMatch[1]
  assert.match(body, /translateY\(\s*4px\s*\)/, `кадры появления не стартуют с 4 px ниже: ${body.replace(/\s+/g, ' ').slice(0, 120)}`)
  assert.doesNotMatch(body, /scale\(/, 'в кадрах появления масштаб — на Windows он размывает шрифт')
  assert.match(body, /opacity:\s*0\b/, 'кадры появления не стартуют из прозрачности')
})

check('при prefers-reduced-motion — без масштаба', () => {
  const run = scenario()
  const menu = menuOf(run)
  const blanket = CSS_RULES.filter(rule => /prefers-reduced-motion/.test(rule.media || ''))
  assert.ok(blanket.length, 'в стилях окна нет ни одного блока prefers-reduced-motion')
  const covered = blanket.filter(rule => selectorMatches(menu, rule.selector)).filter(rule =>
    [...rule.decls.entries()].some(([key, value]) =>
      (/^(transform|animation|animation-name|scale|translate)$/.test(key) && /none/.test(value)) ||
      /^(animation|transition)-duration$/.test(key) ||
      /^animation$/.test(key) && /0(.d+)?m?s/.test(value)))
  assert.ok(covered.length,
    `под prefers-reduced-motion список не снят с масштаба: элементу ${menu.className} не отвечает ни одно правило этого блока`)
})

check('включённый prefers-reduced-motion снимает анимацию появления', () => {
  const run = scenario({ reducedMotion: true })
  const menu = menuOf(run)
  const animation = resolveVars(declFrom(layers(run, menu), 'animation').value)
  assert.ok(!animation || /(^|\s)(none|0(\.\d+)?m?s)(\s|$)/.test(animation),
    `при включённом prefers-reduced-motion появление всё ещё анимировано: «${animation}»`)
})

check('стили нового списка не анимируют раскладку, не пишут transition: all и красятся токенами', () => {
  const run = scenario()
  run.api.move(1)
  invalidate()
  const nodes = [menuOf(run), ...rowsOf(run), ...rowsOf(run).flatMap(one => one.querySelectorAll('*'))]
  const hint = hintNode(run, run.t(run.items[1].hint))
  if (hint) nodes.push(hint, ...hint.querySelectorAll('*'))
  // Берём ПРАВИЛА, КОТОРЫЕ ДЕЙСТВИТЕЛЬНО подходят этим узлам: классы состояния
  // (`is-selected`) в окне общие, и фильтр по имени класса притащил бы чужие
  // карточки и загнал бы проверку в красное без всякой вины нового списка.
  const own = []
  for (const node of nodes.filter(Boolean)) {
    for (const rule of candidateRules(node)) if (selectorMatches(node, rule.selector) && !own.includes(rule)) own.push(rule)
  }
  assert.ok(own.length, `узлам нового списка (${nodes.filter(Boolean).map(one => one.className).join(', ')}) не отвечает ни одно правило CSS`)
  const problems = []
  for (const rule of own) {
    for (const [prop, value] of rule.decls) {
      if (prop === 'transition' || prop.startsWith('transition-')) {
        if (/all/.test(value)) problems.push(`${rule.selector}: transition: all`)
        for (const part of value.replace(/cubic-bezier([^)]*)/g, 'ease').split(',')) {
          const one = part.trim().split(/s+/)[0]
          if (['width', 'height', 'margin', 'padding', 'left', 'right', 'top', 'bottom', 'inset', 'font-size', 'line-height', 'border-width'].includes(one)) {
            problems.push(`${rule.selector}: анимируется раскладочное свойство ${one}`)
          }
        }
      }
      // Буква цвета в самом объявлении — нарушение; токен, цвет-mix из токенов и
      // var(...) с запасом — нет (развёрнутое значение ловило бы и их).
      if (/(^|[-])(color|background|border-color|outline-color|box-shadow)$|^background$/.test(prop) &&
        (/#([0-9a-f]{2}){1,4}\b/i.test(value) || value.includes('rgb(') || value.includes('rgba('))) {
        problems.push(`${rule.selector}: ${prop} задан цветом литералом, а не токеном (${value})`)
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

check('видимый фокус нового списка описан через :focus-visible, а не :focus', () => {
  const run = scenario()
  const names = new Set()
  for (const el of [menuOf(run), ...rowsOf(run)]) for (const cls of el.className.split(/\s+/).filter(Boolean)) names.add(cls)
  const bare = CSS_RULES.filter(rule => /:focus(?!-)/.test(rule.selector) &&
    [...names].some(cls => new RegExp(`\\.${cls.replace(/-/g, '\\-')}\\b`).test(rule.selector)))
  assert.deepEqual(bare.map(one => one.selector), [], 'фокус стилизуется по :focus — обводка останется и при мыши')
})

check('русские строки модуля идут через t() (английская пара обязательна)', () => {
  const source = needModule() && stripComments(readModule())
  const withoutT = String(source).replace(/\bt\(\s*(['"`])(?:(?!\1)[\s\S])*?\1\s*(?:,[^)]*)?\)/g, '')
  const left = [...withoutT.matchAll(/(['"`])(?:(?!\1)[^\r\n])*[а-яёА-ЯЁ](?:(?!\1)[^\r\n]*)\1/g)].map(m => m[0].slice(0, 60))
  assert.deepEqual(left, [], `кириллица вне t(): ${left.join(' | ').slice(0, 200)}`)
})

check('модуль переживает повторное open без вторых строк и без висящей проводки', () => {
  const run = scenario()
  const before = rowsOf(run).length
  run.api.open({ anchor: run.pill, items: RU_MODES, selected: 1, ariaLabel: 'Режим разрешений', onPick () {} })
  const after = run.document.querySelectorAll('[role="listbox"]').filter(visible)
  assert.equal(after.length, 1, `открытых списков ${after.length} — прежний не убран`)
  assert.equal(rowsOf(run, after[0]).length, RU_MODES.length,
    `повторное open нарисовало ${rowsOf(run, after[0]).length} строк вместо ${RU_MODES.length} (было ${before})`)
  assert.equal(after[0].getAttribute('aria-label'), 'Режим разрешений', 'повторное open не переставило aria-label')
})

Promise.all(pending).then(() => {
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed, modulePresent: Boolean(composerMenu) }))
  process.exitCode = failed ? 1 : 0
})
