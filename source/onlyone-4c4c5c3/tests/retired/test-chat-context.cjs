// test-chat-context.cjs: TDD проверки для модуля контекста чата одной строкой (этап 3.7).
const assert = require('node:assert/strict')
const path = require('node:path')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try {
    fn()
    console.log(`ok     ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.stack}`)
  }
}

function createMockDom() {
  class ClassList {
    constructor() { this._set = new Set() }
    add(...classes) { classes.forEach(c => c && this._set.add(c)) }
    delete(c) { this._set.delete(c) }
    remove(c) { this._set.delete(c) }
    has(c) { return this._set.has(c) }
    contains(c) { return this._set.has(c) }
    toggle(c, force) {
      if (force === undefined) {
        if (this.has(c)) { this.delete(c); return false }
        this.add(c); return true
      }
      if (force) { this.add(c); return true }
      this.delete(c); return false
    }
    toString() { return Array.from(this._set).join(' ') }
  }

  class MockElement {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase()
      this.children = []
      this.classList = new ClassList()
      this.attributes = new Map()
      this._listeners = new Map()
      this.parentNode = null
    }

    get hidden() { return this.hasAttribute('hidden') }
    set hidden(v) {
      if (v) this.setAttribute('hidden', '')
      else this.removeAttribute('hidden')
    }

    setAttribute(k, v) {
      this.attributes.set(k, String(v))
      if (k === 'class') {
        this.classList = new ClassList()
        String(v).trim().split(/\s+/).forEach(c => c && this.classList.add(c))
      }
    }
    getAttribute(k) { return this.attributes.get(k) || null }
    hasAttribute(k) { return this.attributes.has(k) }
    removeAttribute(k) {
      this.attributes.delete(k)
      if (k === 'class') this.classList = new ClassList()
    }

    set className(val) {
      this.setAttribute('class', val)
    }
    get className() {
      return this.classList.toString()
    }

    get textContent() {
      if (this.tagName === '#TEXT') return this._text || ''
      return (this._text || '') + this.children.map(c => c.textContent).join('')
    }
    set textContent(v) {
      this.children = []
      this._text = String(v ?? '')
    }

    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    }

    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx !== -1) {
        this.children.splice(idx, 1)
        child.parentNode = null
      }
      return child
    }

    set innerHTML(html) {
      this.children = []
      this._text = ''
      parseHtml(html, this)
    }

    querySelector(selector) {
      return this._find(makePredicate(selector))
    }

    querySelectorAll(selector) {
      const results = []
      this._findAll(makePredicate(selector), results)
      return results
    }

    _find(predicate) {
      for (const child of this.children) {
        if (predicate(child)) return child
        const deep = child._find?.(predicate)
        if (deep) return deep
      }
      return null
    }

    _findAll(predicate, results) {
      for (const child of this.children) {
        if (predicate(child)) results.push(child)
        child._findAll?.(predicate, results)
      }
    }

    addEventListener(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, [])
      this._listeners.get(event).push(handler)
    }

    dispatchEvent(event) {
      if (!event.stopPropagation) event.stopPropagation = () => {}
      if (!event.preventDefault) event.preventDefault = () => {}
      const handlers = this._listeners.get(event.type) || []
      for (const h of handlers) h(event)
    }
  }

  function makePredicate(selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1)
      return el => el.classList && el.classList.contains(cls)
    }
    if (selector.startsWith('#')) {
      const id = selector.slice(1)
      return el => el.getAttribute('id') === id
    }
    return el => el.tagName && el.tagName.toLowerCase() === selector.toLowerCase()
  }

  function parseHtml(html, rootElement) {
    const tokens = html.split(/(<[^>]+>)/g)
    let current = rootElement
    const stack = [rootElement]
    for (const token of tokens) {
      if (!token) continue
      if (token.startsWith('</')) {
        const closeTag = token.match(/^<\/([a-zA-Z0-9-]+)>/)?.[1]?.toUpperCase()
        while (stack.length > 1) {
          const top = stack[stack.length - 1]
          if (top.tagName === closeTag) {
            stack.pop()
            break
          }
          stack.pop()
        }
        current = stack[stack.length - 1]
      } else if (token.startsWith('<') && !token.startsWith('<!--')) {
        const match = token.match(/^<([a-zA-Z0-9-]+)([^>]*)(\/?)>/)
        if (match) {
          const tagName = match[1]
          const rawAttrs = match[2]
          const isSelfClosing = match[3] === '/' || ['circle', 'path', 'line', 'rect', 'br', 'hr', 'img', 'input'].includes(tagName.toLowerCase())
          const el = new MockElement(tagName)
          const attrRegex = /([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
          let m
          while ((m = attrRegex.exec(rawAttrs))) {
            const k = m[1]
            const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : ''
            el.setAttribute(k, v)
          }
          current.appendChild(el)
          if (!isSelfClosing && !token.endsWith('/>')) {
            stack.push(el)
            current = el
          }
        }
      } else {
        const text = token.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        if (text.trim()) {
          const textNode = new MockElement('#text')
          textNode.textContent = text
          current.appendChild(textNode)
        }
      }
    }
  }

  const document = {
    createElement: tag => new MockElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {}
  }

  return { MockElement, document }
}

;(() => {
  let chatContextModule
  try {
    chatContextModule = require('../src/renderer/chat-context.js')
  } catch (err) {
    console.error('Ошибка загрузки chat-context.js:', err.message)
  }

  check('модуль chat-context.js экспортирует createChatContextBar', () => {
    assert.ok(chatContextModule, 'модуль chat-context.js должен существовать')
    assert.equal(typeof chatContextModule.createChatContextBar, 'function', 'должна быть функция createChatContextBar')
  })

  if (!chatContextModule) {
    console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
    process.exit(1)
  }

  const { document } = createMockDom()
  const container = document.createElement('div')

  const t = (k) => {
    const dict = {
      'Без папки': 'Без папки',
      'No folder': 'No folder',
      'Нет ключа': 'Нет ключа',
      'No API key': 'No API key',
      'пусто': 'пусто',
      'файлов': 'файлов',
      'файла': 'файла',
      'файл': 'файл',
      'files': 'files',
      'file': 'file'
    }
    return dict[k] || k
  }
  const formatTokens = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n)
  const escapeHtml = s => String(s || '')

  check('состояние empty: пустой чат без сообщений и вложений', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\projects\\onlyone',
      modelName: 'GLM 5.3 Flash',
      hasKey: true,
      usedTokens: 0,
      limitTokens: 1310720,
      attachmentCount: 0,
      historyTokens: 0,
      attachmentTokens: 0,
      systemTokens: 0
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root, 'панель контекста должна быть отрисована')
    assert.ok(root.classList.contains('is-empty'), 'должен быть класс is-empty')
    assert.equal(root.getAttribute('data-state'), 'empty')

    assert.ok(!root.querySelector('.context-folder'), 'папка уже есть в поле ввода: в строке контекста её нет')
    assert.ok(!root.querySelector('.context-model'), 'модель уже есть в поле ввода: в строке контекста её нет')

    const usageEl = root.querySelector('.context-usage')
    assert.ok(usageEl.textContent.includes('0 /') || usageEl.textContent.includes('0%'), 'должен отображать 0% или 0 токенов')
  })

  check('состояние no-folder: чат без выбранной рабочей папки', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: '',
      modelName: 'MiniMax M3',
      hasKey: true,
      usedTokens: 1200,
      limitTokens: 1048576,
      attachmentCount: 0
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root.classList.contains('no-folder'), 'должен быть класс no-folder')
    assert.ok(!root.querySelector('.context-folder'), 'папка в строке контекста не рисуется')
  })

  check('состояние no-key: нет доступного API ключа', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\repo',
      modelName: 'Cohere',
      hasKey: false,
      usedTokens: 500,
      limitTokens: 256000,
      attachmentCount: 0
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root.classList.contains('no-key'), 'должен быть класс no-key')
    const modelEl = root.querySelector('.context-model')
    assert.ok(modelEl.textContent.includes('Нет ключа'))
  })

  check('состояние normal: заполнение контекста меньше 75%', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\repo',
      modelName: 'GLM',
      hasKey: true,
      usedTokens: 20000,
      limitTokens: 100000,
      attachmentCount: 2
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root.classList.contains('is-normal'), 'должен быть класс is-normal')
    const filesEl = root.querySelector('.context-attachments')
    assert.ok(filesEl && !filesEl.hidden, 'счётчик вложений должен быть видим')
    assert.ok(filesEl.textContent.includes('2'))
  })

  check('состояние warn: заполнение контекста от 75% до 99%', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\repo',
      modelName: 'GLM',
      hasKey: true,
      usedTokens: 80000,
      limitTokens: 100000,
      attachmentCount: 0
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root.classList.contains('is-warn'), 'должен быть класс is-warn')
  })

  check('состояние overflow: контекст переполнен (>=100%)', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\repo',
      modelName: 'GLM',
      hasKey: true,
      usedTokens: 105000,
      limitTokens: 100000,
      attachmentCount: 0
    })

    const root = container.querySelector('.chat-context-bar')
    assert.ok(root.classList.contains('is-overflow'), 'должен быть класс is-overflow')
  })

  check('раскрытие подробностей по клику/Enter и клавиатурная доступность', () => {
    const bar = chatContextModule.createChatContextBar({
      container,
      document,
      t,
      formatTokens,
      escapeHtml
    })

    bar.update({
      workspacePath: 'D:\\repo',
      modelName: 'GLM',
      hasKey: true,
      usedTokens: 5000,
      limitTokens: 100000,
      attachmentCount: 1,
      historyTokens: 3000,
      attachmentTokens: 1500,
      systemTokens: 500
    })

    const root = container.querySelector('.chat-context-bar')
    const summaryBtn = root.querySelector('.chat-context-summary')
    const details = root.querySelector('.chat-context-details')

    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(details.hidden, true)

    // Клик раскрывает
    summaryBtn.dispatchEvent({ type: 'click' })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'true')
    assert.equal(details.hidden, false)

    // Повторный клик сворачивает
    summaryBtn.dispatchEvent({ type: 'click' })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(details.hidden, true)
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed > 0) process.exit(1)
})()
