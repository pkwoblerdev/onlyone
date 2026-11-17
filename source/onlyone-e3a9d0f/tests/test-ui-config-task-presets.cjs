// test-ui-config-task-presets.cjs: наборы рабочих зон интерфейса
// («дизайн», «код», «исследование») поверх базовой конфигурации.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const SCHEMA_FILE = path.join(ROOT, 'src', 'main', 'ui-config.schema.json')
const MODULE_FILE = path.join(ROOT, 'src', 'main', 'ui-config.js')

let total = 0
let failed = 0

function check(name, fn) {
  total++
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${err?.message || err}`)
  }
}

console.log('=== наборы интерфейса под человека («дизайн», «код», «исследование») ===\n')

let uiConfig = null
let loadError = null
try {
  uiConfig = require(MODULE_FILE)
} catch (err) {
  loadError = err
}

check('модуль ui-config подключается и экспортирует TASK_PRESETS, getTaskPreset, applyTaskPreset', () => {
  assert.equal(loadError, null, `ошибка подключения модуля: ${loadError?.message}`)
  assert.ok(uiConfig.TASK_PRESETS && typeof uiConfig.TASK_PRESETS === 'object', 'TASK_PRESETS обязан быть объектом')
  assert.equal(typeof uiConfig.getTaskPreset, 'function', 'getTaskPreset обязан быть функцией')
  assert.equal(typeof uiConfig.applyTaskPreset, 'function', 'applyTaskPreset обязан быть функцией')
})

check('TASK_PRESETS содержит наборы design, code, research с корректной геометрией', () => {
  assert.equal(loadError, null)
  const p = uiConfig.TASK_PRESETS
  assert.ok(p.design, 'пресет design отсутствует')
  assert.ok(p.code, 'пресет code отсутствует')
  assert.ok(p.research, 'пресет research отсутствует')

  // Пресет «дизайн»: фокус на визуале макета
  assert.equal(p.design.showWorkPanel, true, 'design: панель работы должна быть открыта для макета')
  assert.ok(p.design.workPanelWidth >= 440, `design: workPanelWidth должен быть просторным (>= 440), получено ${p.design.workPanelWidth}`)
  assert.ok(p.design.sidebarWidth <= 220, `design: sidebarWidth должен быть компактным (<= 220), получено ${p.design.sidebarWidth}`)

  // Пресет «код»: фокус на редакторе и коде
  assert.ok(p.code.codeFontSize >= 15, `code: codeFontSize должен быть увеличенным для читаемости (>= 15), получено ${p.code.codeFontSize}`)
  assert.equal(p.code.showWorkPanel, true, 'code: рабочая панель открыта')

  // Пресет «исследование»: развернутая боковая панель с контекстом/проектами
  assert.ok(p.research.sidebarWidth >= 300, `research: sidebarWidth должен быть развёрнут для контекста (>= 300), получено ${p.research.sidebarWidth}`)
  assert.equal(p.research.showSidebar, true, 'research: боковая панель должна быть видна')
  assert.equal(p.research.showWorkPanel, false, 'research: рабочая панель скрыта для максимальной ширины диалога')
})

check('getTaskPreset поддерживает как английские, так и русские названия пресетов', () => {
  assert.equal(loadError, null)
  const dEn = uiConfig.getTaskPreset('design')
  const dRu = uiConfig.getTaskPreset('дизайн')
  assert.ok(dEn, 'пресет design не найден')
  assert.deepEqual(dEn, dRu, 'псевдоним «дизайн» должен возвращать тот же пресет, что и «design»')

  const cEn = uiConfig.getTaskPreset('code')
  const cRu = uiConfig.getTaskPreset('код')
  assert.ok(cEn, 'пресет code не найден')
  assert.deepEqual(cEn, cRu, 'псевдоним «код» должен возвращать тот же пресет, что и «code»')

  const rEn = uiConfig.getTaskPreset('research')
  const rRu = uiConfig.getTaskPreset('исследование')
  assert.ok(rEn, 'пресет research не найден')
  assert.deepEqual(rEn, rRu, 'псевдоним «исследование» должен возвращать тот же пресет, что и «research»')

  assert.equal(uiConfig.getTaskPreset('unknown'), null, 'неизвестный пресет должен возвращать null')
  assert.equal(uiConfig.getTaskPreset(null), null, 'null должен возвращать null')
})

check('applyTaskPreset применяет набор задачи, сохраняя версию оболочки versionPreset', () => {
  assert.equal(loadError, null)
  const baseUltra = {
    ...uiConfig.DEFAULT_UI_CONFIG,
    versionPreset: 'ultra'
  }

  const res = uiConfig.applyTaskPreset(baseUltra, 'code')
  assert.equal(res.ok, true, `applyTaskPreset вернул ошибку: ${res.error}`)
  assert.equal(res.config.codeFontSize, uiConfig.TASK_PRESETS.code.codeFontSize, 'размер шрифта кода должен примениться из пресета code')
  assert.equal(res.config.versionPreset, 'ultra', 'versionPreset: "ultra" обязан сохраниться!')
})

check('схема ui-config.schema.json содержит свойство taskPreset со списком допустимых значений', () => {
  assert.ok(fs.existsSync(SCHEMA_FILE), 'файл схемы ui-config.schema.json не найден')
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  const tp = schema.properties?.taskPreset
  assert.ok(tp, 'в схеме отсутствует свойство taskPreset')
  assert.equal(tp.type, 'string', 'taskPreset должен быть строкой')
  assert.ok(Array.isArray(tp.enum), 'taskPreset должен иметь enum')
  assert.ok(tp.enum.includes('design'), 'enum должен содержать design')
  assert.ok(tp.enum.includes('code'), 'enum должен содержать code')
  assert.ok(tp.enum.includes('research'), 'enum должен содержать research')
})

check('validate валидирует свойство taskPreset и применяет геометрию пресета', () => {
  assert.equal(loadError, null)
  const res = uiConfig.validate({ taskPreset: 'design' })
  assert.equal(res.ok, true, `валидация taskPreset: 'design' не прошла: ${res.error}`)
  assert.equal(res.config.taskPreset, 'design')
  assert.equal(res.config.workPanelWidth, uiConfig.TASK_PRESETS.design.workPanelWidth)
  assert.equal(res.config.showWorkPanel, true)

  const badRes = uiConfig.validate({ taskPreset: 'invalid_preset' })
  assert.equal(badRes.ok, false, 'недопустимый taskPreset должен быть отклонён валидатором')
})

check('toCssVariables НЕ генерирует никаких CSS-переменных для пресетов', () => {
  assert.equal(loadError, null)
  const conf = uiConfig.validate({ taskPreset: 'research' }).config
  const vars = uiConfig.toCssVariables(conf)
  const keys = Object.keys(vars)
  assert.equal(keys.some(k => /preset/i.test(k)), false, `в CSS-переменные не должны попадать пресеты: ${keys.join(', ')}`)
})

check('пресет переживает сохранение в профиле и чтение через load', () => {
  assert.equal(loadError, null)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '1code-task-preset-test-'))
  try {
    const saveRes = uiConfig.save(tmpDir, { taskPreset: 'code' })
    assert.equal(saveRes.ok, true, `save вернул ошибку: ${saveRes.error}`)

    const loaded = uiConfig.load(tmpDir)
    assert.equal(loaded.taskPreset, 'code', 'taskPreset должен сохраниться и загрузиться')
    assert.equal(loaded.codeFontSize, uiConfig.TASK_PRESETS.code.codeFontSize, 'геометрия пресета должна сохраниться')
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
})

console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
process.exit(failed ? 1 : 0)
