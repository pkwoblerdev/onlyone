// Снимки страницы, которые делает модель (и следилка за вкладкой), идут сразу в её ход мысли: модель видит кадр, а человек —
// его уменьшенную копию прямо в строке шага. Раньше кадр браузера модели не отдавался вовсе (только ссылка для живого вида), а
// снимок следилки клался в строку ввода как вложение — человек видел «своё» вложение, которого не прикладывал.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

const shots = require('../src/main/agent-shots.cjs')

// Поддельный nativeImage: размеры и цепочка resize → toJPEG.
function fakeNative (width, height) {
  const calls = []
  const image = (w, h) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: ({ width: nw }) => image(nw, Math.round(h * nw / w)),
    toJPEG: quality => { calls.push({ w, h, quality }); return Buffer.from(`jpeg-${w}x${h}-q${quality}`) }
  })
  return { calls, createFromBuffer: () => image(width, height) }
}

test('кадр для модели ужимается по длинной стороне, миниатюра — по ширине; оба — data: URL картинки', () => {
  const native = fakeNative(2560, 1440)
  const prepared = shots.prepareShot(Buffer.from('png'), native)
  assert.match(prepared.model, /^data:image\/jpeg;base64,/)
  assert.match(prepared.thumb, /^data:image\/jpeg;base64,/)
  const model = native.calls.find(call => call.quality === shots.MODEL_QUALITY)
  const thumb = native.calls.find(call => call.quality === shots.THUMB_QUALITY)
  assert.equal(model.w, shots.MODEL_WIDTH)
  assert.equal(thumb.w, shots.THUMB_WIDTH)
  assert.equal(prepared.width, 2560)
  assert.equal(prepared.height, 1440)
})

test('узкий кадр не растягивается, а высокий ужимается по высоте', () => {
  const native = fakeNative(600, 400)
  shots.prepareShot(Buffer.from('png'), native)
  assert.equal(native.calls.find(call => call.quality === shots.MODEL_QUALITY).w, 600, 'маленький кадр растянули')
  const tall = fakeNative(1000, 6000)
  shots.prepareShot(Buffer.from('png'), tall)
  const model = tall.calls.find(call => call.quality === shots.MODEL_QUALITY)
  assert.ok(model.h <= shots.MODEL_WIDTH, 'высокий кадр не ужат по высоте: ' + model.h)
})

test('нечитаемые байты — null, а не падение хода', () => {
  assert.equal(shots.prepareShot(Buffer.from('x'), { createFromBuffer: () => ({ isEmpty: () => true }) }), null)
  assert.equal(shots.prepareShot(null, fakeNative(10, 10)), null)
  assert.equal(shots.prepareShot(Buffer.from('x'), { createFromBuffer: () => { throw new Error('bad') } }), null)
})

test('миниатюра в ленте принимается, только если это data: URL картинки умеренного размера', () => {
  assert.equal(shots.validThumb('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA')
  assert.equal(shots.validThumb('https://evil.example/x.png'), '')
  assert.equal(shots.validThumb('javascript:alert(1)'), '')
  assert.equal(shots.validThumb('data:text/html;base64,AAAA'), '')
  assert.equal(shots.validThumb('data:image/jpeg;base64,' + 'A'.repeat(shots.THUMB_MAX_CHARS + 1)), '')
})

// browserShotForTurn — настоящая функция из main.js: её вырезают и зовут с поддельной страницей агента и поддельной картинкой.
function shotFn (bytes) {
  const main = read('src/main/main.js')
  const start = main.indexOf('function browserShotForTurn(')
  const end = main.indexOf('async function releaseAgentPage(', start)
  assert.ok(start > 0 && end > start, 'browserShotForTurn не найдена')
  const native = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), resize: () => ({ toJPEG: () => Buffer.from('small') }), toJPEG: () => Buffer.from('full') }) }
  const pages = new Map([['r1', { interaction: { shot: ref => (ref === 'agent-browser-shot://one' ? bytes : null) } }]])
  return new Function('agentPages', 'agentShotTools', 'require', main.slice(start, end) + '; return browserShotForTurn')(
    pages, shots, name => (name === 'electron' ? { nativeImage: native } : require(name)))
}

test('кадр browse_screenshot: модели — картинкой служебной репликой, ленте — миниатюрой', () => {
  const fn = shotFn(Buffer.from('png'))
  const out = fn('r1', { ok: true, ref: 'agent-browser-shot://one', url: 'https://a.test/' }, true)
  assert.match(out.thumb, /^data:image\/jpeg;base64,/)
  assert.equal(out.message.role, 'user')
  assert.equal(out.message[Symbol.for('onlyone.synthetic')], true, 'реплика не помечена служебной: диета инструментов прочла бы её как слова человека')
  const image = out.message.content.find(part => part.type === 'image_url')
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/)
  assert.match(out.message.content.find(part => part.type === 'text').text, /только что снял/)
})

test('модель без зрения получает честную записку, а лента всё равно показывает кадр', () => {
  const out = shotFn(Buffer.from('png'))('r1', { ok: true, ref: 'agent-browser-shot://one' }, false)
  assert.ok(out.thumb)
  assert.equal(typeof out.message.content, 'string')
  assert.match(out.message.content, /не принимает изображения/)
})

test('нет кадра в памяти хода, отказ инструмента или чужая страница — ничего не придумывается', () => {
  assert.equal(shotFn(null)('r1', { ok: true, ref: 'agent-browser-shot://one' }, true), null)
  assert.equal(shotFn(Buffer.from('png'))('r1', { success: false, ref: 'agent-browser-shot://one' }, true), null)
  assert.equal(shotFn(Buffer.from('png'))('r1', { ok: true }, true), null)
  assert.equal(shotFn(Buffer.from('png'))('other', { ok: true, ref: 'agent-browser-shot://one' }, true), null)
})

test('цикл агента зовёт её после browse_screenshot: кадр — служебной репликой после ответов, миниатюра — в событие шага', () => {
  const main = read('src/main/main.js')
  assert.match(main, /require\('\.\/agent-shots\.cjs'\)/)
  assert.match(main, /toolName === 'browse_screenshot' && typeof browserShotForTurn === 'function'/)
  assert.match(main, /browserShotForTurn\(payload\.requestId, result, takesShotImages\)/)
  assert.match(main, /if \(browserShot\) afterTools\.push\(browserShot\.message\)/)
  assert.match(main, /thumb: browserShot \? browserShot\.thumb : undefined/)
})

test('описание инструмента не говорит, что кадр модели не отдаётся', () => {
  const main = read('src/main/main.js')
  const at = main.indexOf("name: 'browse_screenshot'")
  const description = main.slice(at, at + 700)
  assert.ok(!/Целые байты модели не отдаются/.test(description))
  assert.match(description, /картинк/)
  const interact = read('src/main/agent-interact.js')
  assert.ok(!/целые байты в модель не уходят|Байты в ответ не кладутся: кадр лежит в памяти процесса под ссылкой/.test(interact.slice(interact.indexOf('async function screenshot'))))
})

test('строка шага знает миниатюру: toolParts несёт thumb, лента рисует её под строкой, а не внутри раскрытия', () => {
  const blocks = read('src/renderer/message-blocks.js')
  assert.match(blocks, /thumb: /)
  assert.match(blocks, /rail-shot/)
  assert.match(blocks, /\^data:image\\\/\(jpeg\|png\);base64,/)
  const css = read('src/renderer/paste-tiles.css')
  assert.match(css, /\.rail-shot\b/)
})

test('снимок следилки за вкладкой не ложится в строку ввода: вложение помечено «только для хода», а окно его не рисует', () => {
  const app = read('src/renderer/app.js')
  const from = app.indexOf('sendToChatWithFiles: (text, opts) => {')
  const sendWith = app.slice(from, app.indexOf('sendFromUltra(text)', from) + 30)
  assert.match(sendWith, /modelOnly: true/)
  assert.match(app, /attachments: turnAttachments\.map\(a => \(\{ path: a\.path, modelOnly: a\.modelOnly === true \}\)\)/)
  assert.match(app, /pane\.attachments\.filter\(item => !item\.modelOnly\)/)
  const main = read('src/main/main.js')
  assert.match(main, /modelOnly/)
  assert.match(main, /tool: 'page_snapshot'/)
})

test('английские пары для новых подписей строки шага', () => {
  const win = {}
  new Function('window', read('src/renderer/i18n.js'))(win)
  const en = win.__I18N__.en
  for (const key of ['Снимок страницы', 'Снял кадр страницы']) assert.ok(en[key], 'нет пары: ' + key)
})

if (failed) process.exit(1)
console.log('\nСнимки модели в ход мысли: проверки пройдены')
