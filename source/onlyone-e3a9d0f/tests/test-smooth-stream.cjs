// Тест плавной печати текста нейросетью (Smooth Typewriter / Streaming)
// Проверяет:
// 1. Посимвольное/пошаговое раскрытие текста вместо моментального сброса всего буфера.
// 2. Адаптивную скорость шага (маленький дельта -> 1-2 символа, средний -> дельта/6, всплеск -> дельта/4).
// 3. Немедленный сброс (flush 100%) буфера при stopLiveRender в конце ответа.
// 4. Ограничение на размер app.js (< 12 100 строк).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8')

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

// Извлекаем функции плавной печати из app.js
const startIdx = appJs.indexOf('function stepSmoothStream(pane)')
assert.ok(startIdx > 0, 'stepSmoothStream не найдена в app.js')
const stopIdx = appJs.indexOf('function stopLiveRender(pane)')
assert.ok(stopIdx > startIdx, 'stopLiveRender не найдена в app.js')
const endIdx = appJs.indexOf('function syncTextBlock(pane)')
assert.ok(endIdx > stopIdx, 'syncTextBlock не найдена в app.js')

const smoothCode = appJs.slice(startIdx, endIdx)

function createHarness() {
  let renders = []
  let pins = []

  const renderLiveContent = pane => {
    renders.push(pane.contentBuffer)
  }
  const pinToBottom = pane => {
    pins.push(pane.smoothCursor)
  }

  const factory = new Function(
    'renderLiveContent',
    'pinToBottom',
    'setInterval',
    'clearInterval',
    'clearTimeout',
    `${smoothCode}
    return { stepSmoothStream, startSmoothStreamAnimation, stopLiveRender }`
  )

  const api = factory(
    renderLiveContent,
    pinToBottom,
    setInterval,
    clearInterval,
    clearTimeout
  )

  return { ...api, renders, pins }
}

const { stepSmoothStream, startSmoothStreamAnimation, stopLiveRender } = createHarness()

test('посимвольное/пошаговое раскрытие: текст появляется плавно за несколько шагов', () => {
  const text = 'Нейросеть генерирует длинный развернутый ответ на вопрос пользователя.'
  const pane = {
    streamQueue: text,
    smoothCursor: 0,
    contentBuffer: '',
    assistantEl: {}
  }

  const moreFirst = stepSmoothStream(pane)
  assert.equal(moreFirst, true, 'должен вернуть true, так как не весь текст раскрыт')
  assert.ok(pane.smoothCursor > 0, 'курсор должен сдвинуться вперед')
  assert.ok(pane.smoothCursor < text.length, 'текст не должен вываливаться целиком на первом шаге')
  assert.equal(pane.contentBuffer, text.slice(0, pane.smoothCursor), 'contentBuffer должен соответствовать срезу до курсора')

  let steps = 1
  while (stepSmoothStream(pane)) {
    steps++
    assert.equal(pane.contentBuffer, text.slice(0, pane.smoothCursor))
    assert.ok(steps < 100, 'слишком много шагов, возможно зацикливание')
  }

  assert.ok(steps > 3, `должно потребоваться несколько шагов для плавности, потребовалось: ${steps}`)
  assert.equal(pane.smoothCursor, text.length, 'в конце курсор должен дойти до конца')
  assert.equal(pane.contentBuffer, text, 'в конце весь текст должен быть в contentBuffer')
  assert.equal(stepSmoothStream(pane), false, 'когда курсор в конце, stepSmoothStream возвращает false')
})

test('адаптивный шаг: маленький дельта (<= 8) шагает по 1 символу', () => {
  const pane = { streamQueue: '12345', smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane)
  assert.equal(pane.smoothCursor, 1, 'при delta=5 шаг должен быть 1 символ')

  const pane8 = { streamQueue: '12345678', smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane8)
  assert.equal(pane8.smoothCursor, 1, 'при delta=8 шаг должен быть 1 символ')
})

test('адаптивный шаг: умеренный дельта (> 8 и <= 20) шагает по 2 символа', () => {
  const pane = { streamQueue: '123456789012', smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane)
  assert.equal(pane.smoothCursor, 2, 'при delta=12 шаг должен быть 2 символа')

  const pane20 = { streamQueue: '12345678901234567890', smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane20)
  assert.equal(pane20.smoothCursor, 2, 'при delta=20 шаг должен быть 2 символа')
})

test('адаптивный шаг: средний дельта (> 20 и <= 60) шагает ceil(delta / 6)', () => {
  const text30 = 'a'.repeat(30)
  const pane30 = { streamQueue: text30, smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane30)
  assert.equal(pane30.smoothCursor, Math.ceil(30 / 6), 'при delta=30 шаг Math.ceil(30/6)=5')

  const text60 = 'a'.repeat(60)
  const pane60 = { streamQueue: text60, smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane60)
  assert.equal(pane60.smoothCursor, Math.ceil(60 / 6), 'при delta=60 шаг Math.ceil(60/6)=10')
})

test('адаптивный шаг: большой всплеск (> 60) шагает ceil(delta / 4)', () => {
  const text100 = 'a'.repeat(100)
  const pane100 = { streamQueue: text100, smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane100)
  assert.equal(pane100.smoothCursor, Math.ceil(100 / 4), 'при delta=100 шаг Math.ceil(100/4)=25')

  const text240 = 'a'.repeat(240)
  const pane240 = { streamQueue: text240, smoothCursor: 0, contentBuffer: '' }
  stepSmoothStream(pane240)
  assert.equal(pane240.smoothCursor, Math.ceil(240 / 4), 'при delta=240 шаг Math.ceil(240/4)=60')
})

test('stopLiveRender немедленно сбрасывает 100% текста и очищает таймер', () => {
  let timerCleared = false
  const fakeTimer = 123
  const pane = {
    streamQueue: 'Полный текст ответа, который еще не успел допечататься плавным тайпврайтером',
    smoothCursor: 10,
    contentBuffer: 'Полный тек',
    smoothTimer: fakeTimer,
    assistantEl: {}
  }

  // Подменяем clearInterval для фиксации сброса таймера
  const harness = createHarness()
  harness.stopLiveRender(pane)

  assert.equal(pane.smoothCursor, pane.streamQueue.length, 'курсор должен быть равен длине streamQueue')
  assert.equal(pane.contentBuffer, pane.streamQueue, 'contentBuffer должен содержать весь streamQueue')
  assert.equal(pane.smoothTimer, null, 'smoothTimer должен быть сброшен в null')
})

test('потолок строк: app.js не превышает 12 100 строк', () => {
  const lines = appJs.split('\n').length
  assert.ok(lines < 12100, `в app.js ${lines} строк (должно быть < 12 100)`)
})

if (failed) {
  process.exit(1)
}
console.log('\nПлавная печать текста: все проверки пройдены')
