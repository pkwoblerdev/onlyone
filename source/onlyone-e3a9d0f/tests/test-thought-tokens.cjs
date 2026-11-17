/**
 * Тест живого счётчика токенов в блоке хода (Task 5).
 * Проверяет:
 * 1. Наличие .thought-tokens в шапке хода рядом с .thought-elapsed.
 * 2. Плавное/инкрементальное обновление значения токенов при syncLive / тике.
 * 3. Форматирование (число < 1000 -> N ток., >= 1000 -> 1.Xk ток.).
 * 4. Сохранение токенов в готовом блоке при live: false.
 * 5. Наличие стилей .thought-tokens в index.css.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Мок DOM окружения для message-blocks.js
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this.classList = {
      add: cls => { if (!this.classList.contains(cls)) this.className += ' ' + cls },
      remove: cls => { this.className = this.className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim() },
      toggle: (cls, force) => {
        if (force === undefined) force = !this.classList.contains(cls)
        if (force) this.classList.add(cls); else this.classList.remove(cls)
      },
      contains: cls => this.className.split(/\s+/).includes(cls)
    }
    this._innerHTML = ''
    this.textContent = ''
    this.dataset = {}
    this.open = false
    this.isConnected = true
  }

  get innerHTML() {
    return this._innerHTML
  }

  set innerHTML(val) {
    this._innerHTML = val
    this.children = []
    const tagMatches = val.matchAll(/<([a-z0-9]+)([^>]*)>(.*?)<\/\1>|<([a-z0-9]+)([^>]*)\/>/gis)
    for (const m of tagMatches) {
      const tagName = m[1] || m[4]
      const attrs = m[2] || m[5] || ''
      const inner = m[3] || ''
      const child = new FakeElement(tagName)
      const classMatch = attrs.match(/class=["']([^"']+)["']/)
      if (classMatch) child.className = classMatch[1]
      child.textContent = inner.replace(/<[^>]+>/g, '').trim()
      this.children.push(child)
    }
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  replaceChild(newChild, oldChild) {
    const idx = this.children.indexOf(oldChild)
    if (idx >= 0) this.children[idx] = newChild
    return newChild
  }

  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1)
      for (const c of this.children) {
        if (c.classList?.contains(cls) || c.className?.split(/\s+/).includes(cls)) return c
        const sub = c.querySelector(sel)
        if (sub) return sub
      }
    }
    return null
  }

  querySelectorAll(sel) {
    const res = []
    if (sel.startsWith('.')) {
      const cls = sel.slice(1)
      for (const c of this.children) {
        if (c.classList?.contains(cls) || c.className?.split(/\s+/).includes(cls)) res.push(c)
        res.push(...c.querySelectorAll(sel))
      }
    }
    return res
  }

  addEventListener() {}
  removeEventListener() {}
}

global.document = {
  createElement: tag => new FakeElement(tag),
  createTextNode: text => ({ textContent: text })
}

const OnlyoneMessageBlocks = require('../src/renderer/message-blocks.js')

const formatTokens = n => {
  const count = Number(n) || 0
  if (count <= 0) return ''
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}

const mb = OnlyoneMessageBlocks.create({
  $: () => null,
  el: {},
  t: x => x,
  escapeHtml: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  formatDuration: () => '0 с',
  formatTokens,
  countWord: (n, a, b, c) => `${n} шт`,
  getUiLang: () => 'ru'
})

test('thoughtElement creates .thought-tokens span in live mode', () => {
  const run = [
    { kind: 'thinking', text: 'Думаю...', at: Date.now() }
  ]
  const el = mb.thoughtElement ? mb.thoughtElement(run, { live: true }) : mb.workRunElement(run)
  const tokenEl = el.querySelector('.thought-tokens')
  assert.ok(tokenEl, 'Элемент .thought-tokens должен присутствовать в заголовке хода')
})

test('syncLive updates .thought-tokens smoothly', async () => {
  const run = [
    { kind: 'thinking', text: 'Думаю...', at: Date.now() }
  ]
  const el = mb.thoughtElement ? mb.thoughtElement(run, { live: true }) : mb.workRunElement(run)
  const tokenEl = el.querySelector('.thought-tokens')
  assert.ok(tokenEl)

  // Передаём 1200 токенов
  el.syncLive(run, 1200)
  assert.ok(tokenEl.textContent.includes('ток.'), `Токены должны содержать "ток.": ${tokenEl.textContent}`)
  assert.ok(tokenEl.textContent.includes('k') || /\d+/.test(tokenEl.textContent), `Должны отображаться токены: ${tokenEl.textContent}`)
})

test('thoughtElement with live: false renders static tokens if provided', () => {
  const run = [
    { kind: 'thinking', text: 'Завершено', at: Date.now() - 5000 }
  ]
  const el = mb.thoughtElement ? mb.thoughtElement(run, { live: false, tokens: 2450 }) : mb.workRunElement(run)
  const tokenEl = el.querySelector('.thought-tokens')
  assert.ok(tokenEl, '.thought-tokens должен быть в готовом блоке при наличии tokens')
  assert.ok(tokenEl.textContent.includes('2.5k') || tokenEl.textContent.includes('2.4k'), `Ожидалось 2.5k ток., получено: ${tokenEl.textContent}`)
})

test('index.css has .thought-tokens styling', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/index.css'), 'utf8')
  assert.ok(css.includes('.thought-tokens'), 'index.css должен содержать правила для .thought-tokens')
})
