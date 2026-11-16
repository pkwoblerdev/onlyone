// Поле `versionPreset` в конфигурации интерфейса — выбор оболочки
// (`default` | `pro` | `ultra`), а не CSS-токен.
//
// Проверка значения — `default | pro | ultra`; для Pro — только само значение,
// без раскладки. Наборы пресетов («дизайн», «код», «исследование») работают
// внутри уже выбранной версии и это поле не трогают.
//
// Проверки построены так, чтобы падать по отсутствию поведения, а не
// разваливать набор целиком: первая проверка — зелёная опора («модуль
// подключается и отдаёт свой контракт»).

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SCHEMA_SOURCE = process.env.ONECODE_UI_SCHEMA_UNDER_TEST || path.join(ROOT, 'src', 'main', 'ui-config.schema.json')
const MODULE_SOURCE = process.env.ONECODE_UI_CONFIG_UNDER_TEST || path.join(ROOT, 'src', 'main', 'ui-config.js')

const PRESETS = ['default', 'pro', 'ultra']

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + ((error && error.message) || error))
  }
}

let uiConfig = null
let loadError = null
try {
  uiConfig = require(MODULE_SOURCE)
} catch (error) {
  loadError = error
}

check('зелёная опора: модуль конфигурации интерфейса подключается и отдаёт контракт', () => {
  assert.equal(loadError, null, `модуль не подключается: ${loadError && loadError.message}`)
  for (const name of ['DEFAULT_UI_CONFIG', 'validate', 'toCssVariables', 'load', 'save', 'reset']) {
    assert.ok(name in uiConfig, `из модуля пропало ${name} — проверять пресет не на чём`)
  }
})

check('схема описывает versionPreset тремя значениями и дефолтом default', () => {
  assert.ok(fs.existsSync(SCHEMA_SOURCE), 'файл схемы не найден')
  const schema = JSON.parse(fs.readFileSync(SCHEMA_SOURCE, 'utf8'))
  const preset = schema.properties && schema.properties.versionPreset
  assert.ok(preset, 'в схеме нет свойства versionPreset')
  assert.equal(preset.type, 'string', `versionPreset обязан быть строкой, а он ${preset.type}`)
  assert.deepEqual((preset.enum || []).slice().sort(), PRESETS.slice().sort(),
    `допустимые значения обязаны быть ровно ${PRESETS.join(' | ')}, а в схеме: ${JSON.stringify(preset.enum)}`)
  assert.equal(preset.default, 'default', 'по умолчанию обязан быть прежний вид: default')
  assert.equal(typeof preset.description, 'string', 'у свойства обязано быть описание (схема читается человеком)')
  assert.ok(/верси|оболочк/i.test(preset.description),
    `описание должно говорить, что это версия оболочки, а оно: «${preset.description}»`)
})

check('DEFAULT_UI_CONFIG содержит versionPreset = default', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  assert.equal(uiConfig.DEFAULT_UI_CONFIG.versionPreset, 'default',
    `в действующих значениях пресет равен «${uiConfig.DEFAULT_UI_CONFIG.versionPreset}» вместо «default»`)
})

check('validate принимает каждое из трёх значений и возвращает его в результате', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  for (const preset of PRESETS) {
    const result = uiConfig.validate({ versionPreset: preset })
    assert.equal(result.ok, true, `значение «${preset}» отклонено: ${result.error}`)
    assert.equal(result.config && result.config.versionPreset, preset,
      `значение «${preset}» не дошло до результата: ${JSON.stringify(result.config && result.config.versionPreset)}`)
  }
})

check('validate отсекает неизвестное значение, нестроку и пустую строку', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  for (const bad of ['max', 'ULTRA', '', 'default ', 7, null, true, {}, ['pro']]) {
    const result = uiConfig.validate({ versionPreset: bad })
    assert.equal(result.ok, false,
      `значение ${JSON.stringify(bad)} принято: интерфейс получил бы оболочку, которой не существует`)
    assert.match(String(result.error || ''), /versionPreset/,
      `отказ обязан называть свойство, а он: «${result.error}»`)
  }
})

check('пресет не выезжает в CSS-переменные: это выбор оболочки, а не токен', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  const vars = uiConfig.toCssVariables(uiConfig.validate({ versionPreset: 'ultra' }).config)
  const keys = Object.keys(vars || {})
  assert.equal(keys.filter(key => /preset|version/i.test(key)).length, 0,
    `в токены уехало значение оболочки: ${keys.join(', ')} — окно читает его отдельным полем, а styles не плодит новых имён`)
})

check('пресет переживает сохранение и перечитывание профиля', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'onlyone-preset-'))
  try {
    const saved = uiConfig.save(dir, { versionPreset: 'ultra' })
    assert.equal(saved.ok, true, `сохранение отклонено: ${saved.error}`)
    const loaded = uiConfig.load(dir)
    assert.equal(loaded.versionPreset || (loaded.config && loaded.config.versionPreset), 'ultra',
      `после перечитывания пресет потерян: ${JSON.stringify(loaded)}`)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* профиль временный */ }
  }
})

check('неизвестное свойство по-прежнему отсекается (схема не раскрылась)', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  const result = uiConfig.validate({ versionPresett: 'ultra' })
  assert.equal(result.ok, false, 'опечатка в имени свойства прошла как разрешённое')
})

// ─── Дефолт обязан сохранять вид: панель «Работа» была видна всегда ───────────
// Панель «Работа» была видна всегда, а значение по умолчанию спрятало её:
// `run-smoke` краснеет на «панель действительно видна — 0x0». Ultra гасит панель
// СВОИМ значением (`--work-panel-display` ставит оболочка), поэтому общего
// выключателя в дефолте держать нечем.

check('Н94: пустая конфигурация оставляет панель «Работа» видимой', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  assert.equal(uiConfig.DEFAULT_UI_CONFIG.showWorkPanel, true,
    `в действующих значениях панель «Работа» ${uiConfig.DEFAULT_UI_CONFIG.showWorkPanel ? 'видна' : 'спрятана'}: раньше она была видна, и дефолт обязан сохранить вид`)
  const vars = uiConfig.toCssVariables(uiConfig.validate({}).config)
  assert.equal(vars['--work-panel-display'], 'flex',
    `при пустой конфигурации переменная панели «${vars['--work-panel-display']}» — панель не видна, и проверка окна падает на 0x0`)
  assert.ok(fs.existsSync(SCHEMA_SOURCE), 'файл схемы не найден')
  const schema = JSON.parse(fs.readFileSync(SCHEMA_SOURCE, 'utf8'))
  assert.equal(schema.properties.showWorkPanel.default, true,
    `схема объявляет дефолт панели «${schema.properties.showWorkPanel.default}» — он расходится с действующими значениями`)
})

check('Н94: профиль без файла конфигурации даёт видимую панель тем же путём, что окно', () => {
  assert.equal(loadError, null, 'модуль не подключается')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'onlyone-empty-profile-'))
  try {
    const loaded = uiConfig.load(dir)
    const config = loaded && loaded.config ? loaded.config : loaded
    assert.equal(config.showWorkPanel, true,
      `профиль без файла вернул панель скрытой (${JSON.stringify(config)}): человек, который ничего не менял, увидел бы исчезнувшую панель`)
    assert.equal(uiConfig.toCssVariables(uiConfig.validate(config).config)['--work-panel-display'], 'flex',
      'в настоящем окне пустой профиль обязан дать видимую панель')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* профиль временный */ }
  }
})

console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
if (failed) console.log(`КРАСНЫХ проверок: ${failed} — поля versionPreset в коде ещё нет или дефолт панели ещё прячет вид, так и задумано`)
process.exit(failed ? 1 : 0)
