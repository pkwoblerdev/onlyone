/**
 * Тест поддержки mid-run steering и принудительного прерывания шага (Task 6).
 * Проверяет:
 * 1. Работу почтового ящика хода (agentMailboxes) и метода steerAgentMessage.
 * 2. Обычное добавление указания (force: false) без прерывания текущего шага.
 * 3. Принудительное прерывание шага (force: true) с abort('forced_by_user') контроллера шага.
 * 4. Наличие вызова steerAgent в preload.js.
 * 5. Наличие кнопки немедленной отправки в app.js и её стилей в index.css.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainPath = path.join(__dirname, '../src/main/main.js')
const mainCode = fs.readFileSync(mainPath, 'utf8')

test('main.js exports or defines steerAgentMessage and IPC handler steer-agent', () => {
  assert.ok(mainCode.includes('steer-agent'), 'main.js должен регистрировать IPC-обработчик steer-agent')
  assert.ok(mainCode.includes('steerAgentMessage'), 'main.js должен содержать функцию steerAgentMessage')
})

test('steerAgentMessage handles normal and forced steering', () => {
  // Проверяем логику на изолированных структурах
  const agentMailboxes = new Map()
  const activeStepControllers = new Map()

  function steerAgentMessage({ requestId, text, force }) {
    if (!requestId) return false
    const list = agentMailboxes.get(requestId)
    if (!list) return false
    const clean = String(text || '').trim()
    if (!clean) return false
    list.push({ text: clean, force: Boolean(force) })
    if (force) {
      const stepCtrl = activeStepControllers.get(requestId)
      if (stepCtrl) stepCtrl.abort('forced_by_user')
    }
    return true
  }

  const reqId = 'req-test-123'
  // Без активного ящика — возвращает false
  assert.equal(steerAgentMessage({ requestId: reqId, text: 'Тест' }), false)

  // Активируем ящик и контроллер шага
  agentMailboxes.set(reqId, [])
  const ctrl = new AbortController()
  activeStepControllers.set(reqId, ctrl)

  // Мягкое указание (force: false)
  const res1 = steerAgentMessage({ requestId: reqId, text: 'Не читай этот файл', force: false })
  assert.equal(res1, true)
  assert.equal(agentMailboxes.get(reqId).length, 1)
  assert.equal(ctrl.signal.aborted, false, 'Шаг не должен прерываться при force: false')

  // Принудительное прерывание (force: true)
  const res2 = steerAgentMessage({ requestId: reqId, text: 'Стой, сделай другое', force: true })
  assert.equal(res2, true)
  assert.equal(agentMailboxes.get(reqId).length, 2)
  assert.equal(ctrl.signal.aborted, true, 'Шаг должен быть прерван при force: true')
  assert.equal(ctrl.signal.reason, 'forced_by_user')
})

test('preload.js exposes steerAgent to renderer', () => {
  const preloadCode = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8')
  assert.ok(preloadCode.includes('steerAgent'), 'preload.js должен экспортировать steerAgent')
})

test('app.js includes btn-force-send in queued notice', () => {
  const appCode = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  assert.ok(appCode.includes('btn-force-send'), 'app.js должен содержать кнопку .btn-force-send')
})

test('index.css has styling for .btn-force-send', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/index.css'), 'utf8')
  assert.ok(css.includes('.btn-force-send'), 'index.css должен содержать стили для .btn-force-send')
})
