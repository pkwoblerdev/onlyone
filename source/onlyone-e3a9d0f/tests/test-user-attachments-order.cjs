// Проверка порядка отображения вложений в сообщении пользователя:
// скриншоты и плитки вложений должны отображаться сверху сообщения, а не под текстом.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8')
const OnlyonePasteTiles = require(path.join(ROOT, 'src/renderer/paste-tiles.js'))

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

// Извлекаем функцию createMessageElement из app.js
const startIdx = appJs.indexOf('function createMessageElement(')
const endIdx = appJs.indexOf('// Send Message Flow', startIdx)
assert.ok(startIdx > 0 && endIdx > startIdx, 'createMessageElement не найдена в app.js')
const code = appJs.slice(startIdx, endIdx)

function createHarness() {
  const mockDoc = {
    createElement: () => ({
      className: '',
      dataset: {},
      set innerHTML(val) { this._html = val },
      get innerHTML() { return this._html || '' }
    })
  }

  const escapeHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const formatWithEmoji = s => s
  const t = (s, ...args) => {
    let i = 0
    return String(s).replace(/%s/g, () => args[i++])
  }
  const ATTACH_KIND_LABEL = {
    image: 'Картинка',
    text: 'Текст',
    pdf: 'PDF'
  }
  const sentQuotesHtml = msg => {
    if (!msg.quotes || !msg.quotes.length) return ''
    return `<blockquote class="msg-quote">${escapeHtml(msg.quotes[0].text)}</blockquote>`
  }

  const factory = new Function(
    'document',
    'sentQuotesHtml',
    'formatWithEmoji',
    'escapeHtml',
    'OnlyonePasteTiles',
    'ATTACH_KIND_LABEL',
    't',
    'window',
    code + '\nreturn createMessageElement;'
  )

  const createMessageElement = factory(
    mockDoc,
    sentQuotesHtml,
    formatWithEmoji,
    escapeHtml,
    OnlyonePasteTiles,
    ATTACH_KIND_LABEL,
    t,
    {}
  )

  return { createMessageElement }
}

const { createMessageElement } = createHarness()

test('вложения (картинки) в сообщении пользователя отображаются ДО текста сообщения', () => {
  const msg = {
    role: 'user',
    content: 'Привет, посмотри картинку',
    attachments: [{ kind: 'image', path: 'screenshot.png', name: 'screenshot.png' }]
  }
  const el = createMessageElement({}, msg)
  const html = el.innerHTML

  assert.ok(html.includes('attachment-strip'), 'должен быть блок вложений attachment-strip')
  assert.ok(html.includes('<p>Привет, посмотри картинку</p>'), 'должен быть параграф с текстом')

  const tilesPos = html.indexOf('attachment-strip')
  const textPos = html.indexOf('<p>Привет, посмотри картинку</p>')

  assert.ok(
    tilesPos < textPos,
    `Вложения должны быть перед текстом сообщения: tilesPos=${tilesPos}, textPos=${textPos}`
  )
})

test('вложения (вставленный текст) отображаются ДО текста сообщения', () => {
  const msg = {
    role: 'user',
    content: 'Основной текст',
    attachments: [{ kind: 'text', path: 'pasted.txt', pasted: true, preview: 'Длинная вставка...' }]
  }
  const el = createMessageElement({}, msg)
  const html = el.innerHTML

  const tilesPos = html.indexOf('attachment-strip')
  const textPos = html.indexOf('<p>Основной текст</p>')

  assert.ok(tilesPos !== -1, 'должен быть блок attachment-strip')
  assert.ok(textPos !== -1, 'должен быть текст')
  assert.ok(
    tilesPos < textPos,
    `Вставленный текст должен быть перед текстом: tilesPos=${tilesPos}, textPos=${textPos}`
  )
})

test('цитата идёт первой, затем вложения, затем текст сообщения', () => {
  const msg = {
    role: 'user',
    content: 'Мой ответ на цитату',
    quotes: [{ text: 'Предыдущее сообщение' }],
    attachments: [{ kind: 'image', path: 'img.png' }]
  }
  const el = createMessageElement({}, msg)
  const html = el.innerHTML

  const quotePos = html.indexOf('msg-quote')
  const tilesPos = html.indexOf('attachment-strip')
  const textPos = html.indexOf('<p>Мой ответ на цитату</p>')

  assert.ok(quotePos !== -1, 'должна быть цитата')
  assert.ok(tilesPos !== -1, 'должны быть плитки')
  assert.ok(textPos !== -1, 'должен быть текст')
  assert.ok(quotePos < tilesPos, 'цитата должна быть перед плитками')
  assert.ok(tilesPos < textPos, 'плитки должны быть перед текстом')
})

test('сообщение без вложений корректно выводит только текст', () => {
  const msg = {
    role: 'user',
    content: 'Просто текст без файлов'
  }
  const el = createMessageElement({}, msg)
  const html = el.innerHTML

  assert.ok(!html.includes('attachment-strip'), 'не должно быть блока вложений')
  assert.ok(html.includes('<p>Просто текст без файлов</p>'), 'должен быть текст сообщения')
})

test('сообщение с пустым списком вложений корректно выводит только текст', () => {
  const msg = {
    role: 'user',
    content: 'Текст с пустым attachments',
    attachments: []
  }
  const el = createMessageElement({}, msg)
  const html = el.innerHTML

  assert.ok(!html.includes('attachment-strip'), 'не должно быть блока вложений')
  assert.ok(html.includes('<p>Текст с пустым attachments</p>'), 'должен быть текст сообщения')
})

if (failed) {
  process.exit(1)
}
console.log('\nПорядок вложений пользователя: проверки пройдены')
