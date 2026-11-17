'use strict'
// Вкладка «Провайдеры и ключи» без накладок (план, 2.8б; поручение 28.09 11:45).
//
// ТЕСТЫ ДО КОДА: раскладки, которую требует владелец, в разметке нет — набор
// обязан быть красным и говорить, чего не хватает.
//
// Проверяется то, что нельзя увидеть глазами по одному снимку: какие группы
// существуют, что скрыто ЦЕЛИКОМ при выбранном OpenRouter, есть ли у каждого
// поля подпись, сколько действий стоит в ряд, где живёт состояние пути и как
// показываются ограничения. Поведение (что реально прячется при выборе пути)
// доказывает оконный прогон `run-providers-tab-ui.cjs`, а не этот файл.
//
// Ещё одна строка этого набора — подписи: в блоке не должно быть русской строки
// без `t()` и без английской пары. Владелец сказал прямо: «ни одной подписи на
// русском при английском интерфейсе».
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const html = read('src', 'renderer', 'index.html')
const app = read('src', 'renderer', 'app.js')
const i18n = read('src', 'renderer', 'i18n.js')
const css = read('src', 'renderer', 'index.css')

const panelAt = html.indexOf('data-settings-panel="keys"')
const panel = panelAt >= 0 ? html.slice(panelAt, html.indexOf('<section', panelAt + 10)) : ''
assert.ok(panel.length > 200, 'в разметке нет панели настроек «Провайдеры и ключи» — проверять нечего')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}

// Группа по id — кусок разметки от её открытия до следующего `settings-group`
// или конца панели.
function group(id) {
  const at = panel.indexOf(`id="${id}"`)
  if (at < 0) return ''
  const rest = panel.slice(at)
  const next = rest.indexOf('class="settings-group"')
  return next > 0 ? rest.slice(0, next) : rest
}

// ─── 1. путь к моделям: одна строка «подпись слева — список справа» ─────────

check('путь к моделям — отдельная группа с одной строкой выбора', () => {
  const g = group('providerPathGroup')
  assert.ok(g.length > 40, 'нет группы `providerPathGroup`: путь к моделям снова смешан с ключами в одной карточке')
  assert.match(g, /<select id="providerSelect"/, 'в группе пути нет списка выбора провайдера')
  assert.match(g, /class="row-title"[^>]*>[^<]*Провайдер/, 'у строки пути нет подписи слева')
  assert.equal((g.match(/class="setting-row"/g) || []).length, 1,
    `в группе пути ${ (g.match(/class="setting-row"/g) || []).length } строк — путь должен занимать одну`)
})

// ─── 2. свои подключения при OpenRouter не показываются вовсе ───────────────

check('свои подключения — своя группа, и скрывается она целиком', () => {
  const g = group('customConnectionsGroup')
  assert.ok(g.length > 40, 'нет группы `customConnectionsGroup`: список подключений не отделён от ключей')
  assert.match(g, /id="btnNewConnection"/, 'над списком подключений нет кнопки «Новое подключение»')
  assert.match(g, /id="customConnectionsList"/, 'списка подключений нет — значит поля висят вперемешку с кнопками')
  // Прежняя строка выбора, которая оставалась висеть с пометкой «не используются».
  assert.equal(/id="customProviderPickRow"/.test(panel), false,
    'строка выбора подключения осталась в разметке: прятать её целиком нечем')
  assert.match(app, /customConnectionsGroup[\s\S]{0,160}\.hidden\s*=/,
    'группу своих подключений никто не скрывает целиком')
})

check('ключи OpenRouter — своя группа, и видна она только при OpenRouter', () => {
  const g = group('openrouterKeysGroup')
  assert.ok(g.length > 40, 'нет группы `openrouterKeysGroup`: пул ключей не отделён от своих подключений')
  assert.match(app, /openrouterKeysGroup[\s\S]{0,160}\.hidden\s*=/,
    'группу ключей OpenRouter никто не скрывает на других путях')
})

// ─── 3. поля пути: у каждого — подпись, действий — две в одной строке ───────

check('у каждого поля формы есть подпись слева, а не только подсказка в поле', () => {
  const fields = ['customProviderNameInput', 'customBaseUrlInput', 'customModelInput', 'customKeyInput', 'customToolsCheck']
  const block = group('providerFieldsGroup')
  assert.ok(block.length > 40, 'нет группы `providerFieldsGroup`: поля формы не собраны в одну группу')
  for (const id of fields) {
    const at = block.indexOf(`id="${id}"`)
    assert.ok(at > 0, `поля ${id} в группе нет`)
    const row = block.slice(Math.max(0, block.lastIndexOf('class="setting-row"', at)), at + 200)
    assert.match(row, /class="row-title"/, `у поля ${id} нет подписи — человек видит только серое слово в поле`)
  }
})

check('действий в строке два: «Проверить» вторичная и «Сохранить» основная', () => {
  const block = group('providerFieldsGroup')
  const actionsAt = block.indexOf('id="providerActions"')
  assert.ok(actionsAt > 0, 'нет строки действий `providerActions`: кнопки снова стоят в ряд с полями')
  const actions = block.slice(actionsAt, block.indexOf('</div>', actionsAt))
  assert.match(actions, /id="btnCheckCustomProvider"[^>]*class="[^"]*btn-secondary/, '«Проверить» не вторичная кнопка')
  assert.match(actions, /id="btnSaveCustomProvider"[^>]*class="[^"]*btn-primary/, '«Сохранить» не основная кнопка')
  assert.equal(/btnDeleteCustomProvider/.test(actions), false,
    '«Удалить» вернулась в ряд действий: удаление живёт в меню подключения')
  assert.equal((actions.match(/<button/g) || []).length, 2,
    `в строке действий ${(actions.match(/<button/g) || []).length} кнопок — просили две`)
})

check('состояние пути — чипом в заголовке группы, а не строкой под полями', () => {
  const block = group('providerFieldsGroup')
  const headAt = block.indexOf('settings-group-head')
  assert.ok(headAt >= 0, 'у группы полей нет заголовка, в котором можно показать состояние')
  // Заголовок кончается там, где начинается тело группы: первый `</div>` внутри
  // него закрывает сам титул, и чип за его пределами cutting терялся.
  const bodyAt = block.indexOf('id="customProviderFields"', headAt)
  const head = bodyAt > headAt ? block.slice(headAt, bodyAt) : block.slice(headAt, headAt + 600)
  assert.match(head, /id="providerPathState"[^>]*class="[^"]*section-badge/, 'в заголовке нет чипа состояния')
})

// ─── 4. ограничения пути — строкой с раскрытием ─────────────────────────────

check('ограничения пути прячутся в раскрытие, а не лежат абзацем', () => {
  const block = group('providerFieldsGroup') || panel
  assert.match(block, /<details[\s\S]{0,400}id="customProviderUnsupported"/,
    'ограничения пути не убраны в `<details>`: они снова простыня под полями')
  assert.match(block, /<summary[^>]*>[^<]*Что этот путь не умеет/, 'у раскрытия нет подписи «Что этот путь не умеет»')
})

// ─── 5. состояние пути — три вида, которые обещаны владельцем ───────────────

check('чип состояния знает три вида: подключён, нет ключа, ошибка', () => {
  const block = app.slice(app.indexOf('function providerPathStateText'), app.indexOf('function renderCustomProvider'))
  assert.ok(block.length > 40, 'состояние пути никто не вычисляет')
  for (const label of ['Подключено', 'Нет ключа', 'Ошибка: %s']) {
    assert.match(block, new RegExp(`t\\('${label}'`), `чип не знает вида «${label}»`)
  }
  assert.match(app, /\$\('providerPathState'\)[\s\S]{0,240}providerPathStateText\(shown\)/,
    'состояние вычисляется, но в чип группы не попадает')
})

check('список своих подключений рисует строки с меню «⋯»', () => {
  const at = app.indexOf('function connectionRow')
  assert.ok(at > 0, 'нет функции, которая рисует строку своего подключения')
  const block = app.slice(at, app.indexOf('function shortAddress'))
  for (const label of ['Изменить', 'Проверить', 'Удалить']) {
    assert.match(block, new RegExp(`t\\('${label}'`), `в меню строки нет пункта «${label}»`)
  }
  // Имя подключения пишет человек — в разметку его вести нельзя.
  assert.equal(/innerHTML\s*=/.test(block), false, 'строки подключения собираются через innerHTML')
  // Удаление просят подтвердить: карточка подключения дорогая, а ход на ней.
  assert.match(app, /askConfirm\([\s\S]{0,200}?removeConnection\(/,
    'подключение снимается без подтверждения человеком')
})

check('имя нового подключения даётся через t(), а не русским словом из кода', () => {
  assert.match(app, /t\('Подключение %s'/, 'имени по умолчанию нет перевода — на английском экране оно останется русским')
})

// ─── 6. подписи: ни одной русской строки этого блока без пары ───────────────

// Код вкладки лежит в двух местах `app.js`: рисование групп и обработчики её
// кнопок. Надзор над подписями обязан идти по обоим — иначе строки, выросшие в
// обработчиках, оставались бы невидимыми.
const REGIONS = [
  ['function renderCustomConnections', 'const ATTACH_KIND_LABEL'],
  ['const customProviderPatch = withKey', '// MCP Add Server Modal']
]

function tabCode() {
  let text = ''
  for (const [start, stop] of REGIONS) {
    const from = app.indexOf(start)
    const to = app.indexOf(stop, from)
    assert.ok(from > 0 && to > from, `не найдена часть кода вкладки (${start} … ${stop}) — проверять нечего`)
    text += app.slice(from, to) + '\n'
  }
  return text
}

check('в блоке провайдеров нет русской строки, нарисованной мимо t()', () => {
  const block = tabCode().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // Литерал переведён, только если он стоит внутри вызова `t(`. Прямой взгляд на
  // два символа перед кавычкой не видел форму `t(cond ? 'да' : 'нет')` — второй
  // вариант выглядит голым, хотя он переведен. Поэтому один проход стеком
  // скобок, по которому видно, чей вызов окружает литерал.
  const stack = []
  const openAt = new Array(block.length).fill(-1)
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (ch === '(') stack.push(i)
    else if (ch === ')' && stack.length) stack.pop()
    openAt[i] = stack.length ? stack[stack.length - 1] : -1
  }
  const inTranslate = index => {
    if (/\bt\($/.test(block.slice(Math.max(0, index - 2), index))) return true
    const at = openAt[index]
    return at > 1 && block[at - 1] === 't' && !/[A-Za-z0-9_$.]/.test(block[at - 2] || '')
  }
  const bare = []
  for (const m of block.matchAll(/(['"`])([^'"`\n]*[а-яёА-ЯЁ][^'"`\n]*)\1/g)) {
    if (inTranslate(m.index)) continue
    // Значение сравнения — не подпись, а протокольное слово главного процесса
    // (`ending === 'не читается'`): перевести его здесь — перестать его узнавать.
    // Язык таких слов — пункт 2.6б, а не этот набор.
    const lineStart = block.lastIndexOf('\n', m.index - 1) + 1
    if (/===\s*$|!==\s*$|\bcase\s+$/.test(block.slice(lineStart, m.index))) continue
    bare.push(m[2].slice(0, 60))
  }
  assert.deepEqual(bare, [], 'русские литералы без t(): ' + bare.slice(0, 8).join(' | '))
})

check('каждая русская подпись вкладки имеет английскую пару', () => {
  const labels = [...panel.matchAll(/>([^<>]*[а-яё][^<>]*)</g)].map(m => m[1].trim()).filter(one => one.length > 1)
  // Первый аргумент каждого `t()` кода вкладки — тоже подпись, и английская
  // пара к ней обязательна: проверка по разметке видела бы только статичные
  // слова, а их в новой раскладке меньшинство.
  labels.push(...[...tabCode().matchAll(/\bt\(\s*(['"`])([^'"`\n]+)\1/g)].map(m => m[2].trim()))
  const missing = [...new Set(labels)]
    .filter(one => /[а-яё]/.test(one))
    .filter(one => !i18n.includes(`'${one}'`))
  // Полный список печатается отдельно: сообщение отказа обрезается, а пары
  // надо добавить все — выборка из десяти заставила бы гонять набор повторно.
  if (missing.length) console.log('  без пары: ' + missing.join(' | '))
  assert.deepEqual(missing, [], 'без английской пары: ' + missing.slice(0, 10).join(' | '))
})

// ─── 7. вид по приёмке Claude 28.09 19:40: одна колонка имён и акцент ───────

// Правило по селектору — его тело до первого `}`. Грубо, но ровно то, что
// здесь и проверяется: одно объявление, а не разбор каскада.
function cssRule(selector) {
  const at = css.indexOf(selector + ' {')
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1)
}
// То же для селектора с придатком (`:hover:not(:disabled)`), который дом
// пишет по-разному в разных местах файла.
function cssRuleFrom(pattern) {
  const m = pattern.exec(css)
  if (!m) return ''
  return css.slice(m.index, css.indexOf('}', m.index) + 1)
}

check('имена строк списка стоят в одной колонке, флаг их не сдвигает', () => {
  const rule = cssRule('.conn-main')
  assert.ok(rule.length > 10, 'нет правила `.conn-main` — строка списка собрана не им')
  // Глобальное `button { justify-content: center }` центрирует содержимое
  // растянутой кнопки: строка с флагом «ход идёт здесь» и строка без флага
  // ставили имя в разных колонках (465 и 486 px на кадре приёмки).
  assert.match(rule, /justify-content:\s*flex-start/,
    '`.conn-main` наследует центрирование кнопки — имена строк встанут в разные колонки')
})

check('«Сохранить» в панели — акцентная кнопка по карточке `Button`', () => {
  const rule = cssRule('#panel-keys .btn-primary')
  assert.ok(rule.length > 10, 'в панели «Провайдеры и ключи» нет акцентного вида у главной кнопки')
  assert.match(rule, /background:\s*var\(--accent\)/, 'главная кнопка не залита акцентом')
  assert.match(rule, /color:\s*var\(--accent-ink\)/, 'текст на акценте не взят из токена `--accent-ink`')
  assert.match(cssRuleFrom(/#panel-keys \.btn-primary:hover[^{]*\{/), /background:\s*var\(--accent-hover\)/,
    'цвет главной кнопки при наведении не описан токеном `--accent-hover`')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
