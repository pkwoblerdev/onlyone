// Очистка имени модели от префикса поставщика (Убрать "Anthropic: ", "OpenAI: ", "Google: " и т.д.)
//
// В выпадающем списке и плашке модели (model pill) OpenRouter отдаёт имена вида:
// "Anthropic: Claude Haiku 5.5", "OpenAI: GPT-4o mini", "Google: Gemini 2.0 Flash".
// Человек видит поставщика на теге/иконке рядом, а в имени модели дублировать "Anthropic: " не нужно.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
const popover = require('../src/renderer/model-popover.js')

function loadMainModelHelpers() {
  const start = mainSrc.indexOf('function getProviderFromId(')
  const end = mainSrc.indexOf('// A model only accepts the effort levels it advertises', start)
  if (start < 0 || end < 0) {
    throw new Error('Не удалось найти блок getProviderFromId / toModelRecord в src/main/main.js')
  }
  const code = mainSrc.slice(start, end)
  return new Function(`
    ${code}
    return {
      cleanModelName: typeof cleanModelName === 'function' ? cleanModelName : null,
      toModelRecord
    }
  `)()
}

const { cleanModelName, toModelRecord } = loadMainModelHelpers()

let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// 1. Модульные тесты cleanModelName
test('cleanModelName существует в src/main/main.js', () => {
  assert.equal(typeof cleanModelName, 'function', 'cleanModelName должна быть функцией в main.js')
})

test('cleanModelName удаляет префикс Anthropic: ', () => {
  assert.equal(cleanModelName ? cleanModelName('Anthropic: Claude Haiku 5.5') : '', 'Claude Haiku 5.5')
})

test('cleanModelName удаляет префикс OpenAI: ', () => {
  assert.equal(cleanModelName ? cleanModelName('OpenAI: GPT-4o mini') : '', 'GPT-4o mini')
})

test('cleanModelName удаляет префикс Google: ', () => {
  assert.equal(cleanModelName ? cleanModelName('Google: Gemini 2.0 Flash') : '', 'Gemini 2.0 Flash')
})

test('cleanModelName оставляет модель без двоеточия нетронутой', () => {
  assert.equal(cleanModelName ? cleanModelName('MiniMax M3 (free)') : '', 'MiniMax M3 (free)')
})

test('cleanModelName обрабатывает пустую строку, null и undefined', () => {
  assert.equal(cleanModelName ? cleanModelName('') : '', '')
  assert.equal(cleanModelName ? cleanModelName(null) : '', '')
  assert.equal(cleanModelName ? cleanModelName(undefined) : '', '')
})

// 2. Интеграционный тест: toModelRecord
test('toModelRecord очищает имя модели с префиксом поставщика', () => {
  const record = toModelRecord({
    id: 'anthropic/claude-3-5-haiku',
    name: 'Anthropic: Claude Haiku 5.5'
  })
  assert.equal(record.name, 'Claude Haiku 5.5')
})

test('toModelRecord использует сегмент id если name не передан', () => {
  const record = toModelRecord({
    id: 'anthropic/claude-3-5-haiku'
  })
  assert.equal(record.name, 'claude-3-5-haiku')
})

// 3. Тесты model-popover.js
test('model-popover.js экспортирует cleanModelName', () => {
  assert.equal(typeof popover.cleanModelName, 'function', 'model-popover.js должен экспортировать cleanModelName')
})

test('cleanModelName из model-popover.js очищает префикс поставщика', () => {
  assert.equal(popover.cleanModelName ? popover.cleanModelName('Anthropic: Claude Haiku 5.5') : '', 'Claude Haiku 5.5')
})

// 4. Проверка src/renderer/app.js на наличие cleanModelName
test('src/renderer/app.js содержит cleanModelName', () => {
  const appSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8')
  assert.ok(appSrc.includes('function cleanModelName'), 'app.js должен содержать функцию cleanModelName')
  assert.ok(appSrc.includes('el.pillModelName.textContent = cleanModelName(') ||
            appSrc.includes('el.pillModelName.textContent = cleanModelName(selectedModel.name)'),
    'app.js должен использовать cleanModelName для el.pillModelName')
})

if (failed > 0) {
  process.exit(1)
}
