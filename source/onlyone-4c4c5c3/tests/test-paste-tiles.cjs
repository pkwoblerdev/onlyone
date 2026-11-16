// Вставка в строку ввода: картинка и длинный текст ложатся плиткой над полем, а не словом «paste-1787.png» и не простынёй
// в самом поле. Плитка — квадрат с картинкой или карточка с началом текста и меткой «Вставлено», крестик появляется под рукой.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

// Мини-DOM: хватает createElement, классов, атрибутов, дерева и обработчика клика.
function fakeDoc () {
  const make = tag => ({
    tag, children: [], className: '', dataset: {}, attrs: {}, listeners: {}, _text: '', style: {},
    appendChild (child) { this.children.push(child); return child },
    setAttribute (name, value) { this.attrs[name] = String(value) },
    addEventListener (name, fn) { this.listeners[name] = fn },
    querySelector (selector) { return find(this, selector) },
    set textContent (value) { this._text = String(value) },
    get textContent () { return this._text + this.children.map(child => child.textContent).join('') },
    set innerHTML (value) { this._html = String(value); this.children = []; for (const cls of [...String(value).matchAll(/class="([^"]+)"/g)].map(m => m[1])) { const el = make('span'); el.className = cls; this.children.push(el) } },
    get innerHTML () { return this._html || '' }
  })
  const find = (node, selector) => {
    const cls = selector.replace(/^\./, '')
    for (const child of node.children) {
      if (String(child.className).split(/\s+/).includes(cls)) return child
      const deep = find(child, selector)
      if (deep) return deep
    }
    return null
  }
  return { createElement: make }
}
const t = (text, ...args) => { let i = 0; return String(text).replace(/%s/g, () => args[i++]) }

const tiles = require('../src/renderer/paste-tiles.js')

test('короткая вставка идёт в поле как обычно, длинная — плиткой', () => {
  assert.equal(tiles.isLongPaste('привет'), false)
  assert.equal(tiles.isLongPaste('x'.repeat(tiles.LONG_CHARS - 1)), false)
  assert.equal(tiles.isLongPaste('x'.repeat(tiles.LONG_CHARS)), true)
  assert.equal(tiles.isLongPaste(Array.from({ length: tiles.LONG_LINES }, (_, i) => 'строка ' + i).join('\n')), true)
  assert.equal(tiles.isLongPaste(Array.from({ length: tiles.LONG_LINES - 1 }, () => 'a').join('\n')), false)
  assert.equal(tiles.isLongPaste(''), false)
  assert.equal(tiles.isLongPaste(null), false)
})

test('плиткой показываются картинки и вставленный текст, остальные файлы — прежней полосой', () => {
  assert.equal(tiles.isTile({ kind: 'image', path: 'a.png' }), true)
  assert.equal(tiles.isTile({ kind: 'text', path: 'a.txt', pasted: true }), true)
  assert.equal(tiles.isTile({ kind: 'text', path: 'a.txt' }), false)
  assert.equal(tiles.isTile({ kind: 'pdf', path: 'a.pdf' }), false)
})

test('плитка картинки: слот под миниатюру и крестик; плитка текста: начало текста и метка «Вставлено»', () => {
  const doc = fakeDoc()
  const image = tiles.buildTile(doc, { kind: 'image', path: 'p.png', name: 'p.png' }, { t, onRemove () {} })
  assert.ok(/attachment-tile/.test(image.className) && /kind-image/.test(image.className))
  assert.ok(image.querySelector('.attachment-thumb'), 'нет слота под миниатюру')
  assert.ok(image.querySelector('.tile-remove'), 'нет крестика')
  assert.ok(!image.querySelector('.tile-badge'), 'у картинки не должно быть метки текста')

  const text = tiles.buildTile(doc, { kind: 'text', path: 'p.txt', pasted: true, preview: 'первая\nвторая', lines: 42, size: 3000 }, { t, onRemove () {} })
  assert.ok(/is-pasted/.test(text.className))
  assert.equal(text.querySelector('.tile-text').textContent, 'первая\nвторая')
  assert.equal(text.querySelector('.tile-badge').textContent, 'Вставлено')
  assert.match(text.dataset.tooltip, /42/, 'в подсказке нет числа строк')
})

test('крестик у плитки зовёт удаление и не отдаёт клик дальше', () => {
  const doc = fakeDoc()
  let removed = 0
  const tile = tiles.buildTile(doc, { kind: 'image', path: 'p.png', name: 'p.png' }, { t, onRemove: () => { removed++ } })
  let stopped = false
  tile.querySelector('.tile-remove').listeners.click({ stopPropagation: () => { stopped = true }, preventDefault () {} })
  assert.equal(removed, 1)
  assert.equal(stopped, true)
})

test('главный процесс сохраняет вставленный текст как вложение и описывает его для плитки', () => {
  const main = read('src/main/main.js')
  const at = main.indexOf("ipcMain.handle('save-pasted-text'")
  assert.ok(at > 0, 'канала save-pasted-text нет')
  const body = main.slice(at, at + 1800)
  assert.match(body, /MAX_TEXT_ATTACHMENT_BYTES/)
  assert.match(body, /pasted: true/)
  assert.match(body, /preview:/)
  assert.match(body, /\.txt/)
  assert.match(read('src/preload/preload.js'), /savePastedText: text => ipcRenderer\.invoke\('save-pasted-text', \{ text \}\)/)
})

test('окно подключает модуль, ловит вставку текста и рисует плитки в строке ввода и в отправленном сообщении', () => {
  const html = read('src/renderer/index.html')
  assert.match(html, /<script src="paste-tiles\.js"><\/script>/)
  assert.match(html, /<link rel="stylesheet" href="paste-tiles\.css" \/>/)
  const app = read('src/renderer/app.js')
  assert.match(app, /OnlyonePasteTiles\.isLongPaste\(/)
  assert.match(app, /savePastedText\(/)
  assert.match(app, /OnlyonePasteTiles\.isTile\(item\)/)
})

test('стили плитки: токены дизайн-системы, крестик виден на касании и при фокусе, а не только по наведению', () => {
  const css = read('src/renderer/paste-tiles.css')
  assert.match(css, /\.attachment-tile\b/)
  assert.match(css, /\.tile-remove\b/)
  assert.match(css, /focus-within|:focus-visible/)
  assert.match(css, /hover: none/)
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'в стилях плитки сырые цвета вместо токенов')
})

test('английские пары для новых подписей на месте', () => {
  const win = {}
  new Function('window', read('src/renderer/i18n.js'))(win)
  const en = win.__I18N__.en
  for (const key of ['Вставлено', 'Вставленный текст, строк: %s', 'Убрать вложение']) assert.ok(en[key], 'нет пары: ' + key)
})

test('сообщение из одной плитки (без текста в поле) отправляется', () => {
  const app = read('src/renderer/app.js')
  assert.match(app, /if \(text \|\| pane\.attachments\.length\) handleSendMessage\(pane, text \|\| t\('Посмотри вложение\.'\)\)/,
    'Enter и кнопка отправки молчат, если в поле только плитка вставки: submit требует текст')
})

if (failed) process.exit(1)
console.log('\nПлитки вставки: проверки пройдены')
