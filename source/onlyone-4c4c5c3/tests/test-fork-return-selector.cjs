'use strict'
// break-2 Н4: mountCard строил CSS-селектор '[data-fork-return-key="' + messageKey + '"]'
// без экранирования. Повреждённая запись реестра (messageKey с кавычкой/скобкой,
// isRecord принимает любую непустую строку) давала невалидный CSS → querySelector
// бросал SyntaxError → renderMessages падал целиком, чат не рендерился. После правки
// селектор постоянный ('[data-fork-return-key]'), а ключ сверяется по dataset —
// любое содержимое ключа безопасно. Контроль: легитимный ключ дедуплируется.
const assert = require('node:assert/strict')
const api = require('../src/renderer/fork-return.js')

// Минимальный DOM: querySelector бросает на невалидном атрибутном селекторе —
// ровно контракт браузера (SyntaxError), который и ломал renderMessages.
function makeContainer() {
  const el = tag => ({
    tagName: String(tag).toUpperCase(), className: '', dataset: {}, children: [],
    textContent: '', type: '',
    setAttribute() {}, append(...n) { this.children.push(...n) },
    appendChild(n) { this.children.push(n); return n }, addEventListener() {}
  })
  const doc = { createElement: el }
  return {
    ownerDocument: doc, children: [],
    appendChild(c) { this.children.push(c); return c },
    querySelector(sel) {
      const m = /^\[data-fork-return-key="((?:[^"\\]|\\.)*)"\]$/.exec(sel)
      if (!m) throw new SyntaxError('Невалидный CSS-селектор: ' + sel)
      const key = m[1].replace(/\\(.)/g, '$1')
      return this.children.find(c => c.dataset.forkReturnKey === key) || null
    },
    querySelectorAll(sel) {
      if (sel === '[data-fork-return-key]') return this.children.filter(c => c.dataset && 'forkReturnKey' in c.dataset)
      throw new SyntaxError('Неожиданный селектор: ' + sel)
    }
  }
}
const record = (messageKey) => ({
  version: 1, operationId: 'fp_test12345', childChatId: 'child-1',
  messageKey, text: 'Итог работы', createdAt: 1
})

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

check('Н4: повреждённый messageKey не валит mountCard', () => {
  const corrupt = 't:1"]'
  // Данные доходят до mountCard: read принимает такую запись (isRecord терпит ключ).
  const chat = { forkReturns: [record(corrupt)] }
  const ledger = api.read(chat)
  assert.equal(ledger.ok, true)
  assert.equal(ledger.returns.length, 1, 'повреждённая запись не дошла до потребителя')
  const container = makeContainer()
  let card
  assert.doesNotThrow(() => { card = api.mountCard(container, ledger.returns[0], { t: x => x }) },
    'mountCard бросил на повреждённом ключе — renderMessages упал бы целиком')
  assert.ok(card, 'карточка не построена')
  assert.equal(card.dataset.forkReturnKey, corrupt)
})

check('Н4: ключ со скобкой и обратным слэшем безопасен', () => {
  const container = makeContainer()
  const card = api.mountCard(container, record('h:abc]\\'), { t: x => x })
  assert.ok(card)
  assert.equal(card.dataset.forkReturnKey, 'h:abc]\\')
})

check('контроль: легитимный ключ дедуплируется (вторая карточка не создаётся)', () => {
  const container = makeContainer()
  const first = api.mountCard(container, record('t:123'), { t: x => x })
  const second = api.mountCard(container, record('t:123'), { t: x => x })
  assert.equal(second, first, 'повторный ключ создал вторую карточку')
  assert.equal(container.children.length, 1)
})

if (failed) process.exit(1)
console.log('ok test-fork-return-selector')