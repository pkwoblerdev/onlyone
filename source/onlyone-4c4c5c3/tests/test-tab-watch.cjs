// Наблюдатель вкладки (волна 4): решения tab-watch без окна — когда будить, как собрать поручение.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tabWatch = require('../src/renderer/tab-watch.js')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

function harness(extra = {}) {
  let clock = 5_000_000
  const sent = []
  const injected = []
  const api = tabWatch.create({
    now: () => clock, t: value => value,
    send: (text, options) => sent.push({ text, options }),
    inject: (id, code) => injected.push({ id, code }),
    screenshot: async () => ({ path: 'onlyone-screens/page-1.png', attachment: { path: 'C:/p/page-1.png', kind: 'image' } }),
    canWake: () => true,
    ...extra
  })
  return { api, sent, injected, tick: ms => { clock += ms } }
}
const info = { url: 'http://localhost:3000/', title: 'Таймер' }
const change = (before, after) => ({ before, after, title: 'Таймер' })

;(async () => {
  await check('начало слежения вставляет наблюдателя в страницу', () => {
    const h = harness()
    h.api.start('t1', { instruction: 'Сними страницу' })
    assert.equal(h.injected.length, 1)
    assert.match(h.injected[0].code, /MutationObserver/)
    assert.ok(h.api.active('t1') && !h.api.active('t2'))
  })

  await check('любое изменение будит с «было / стало», поручением и снимком', async () => {
    const h = harness()
    h.api.start('t1', { instruction: 'Запиши цену в price.txt' })
    const answer = await h.api.onChange('t1', change('Цена 100', 'Цена 120'), info)
    assert.equal(answer, 'woke')
    const text = h.sent[0].text
    assert.match(text, /localhost:3000/)
    assert.match(text, /Было: Цена 10/)
    assert.match(text, /Стало: Цена 12/)
    assert.match(text, /Запиши цену в price\.txt/)
    assert.match(text, /onlyone-screens\/page-1\.png/)
    assert.equal(h.sent[0].options.attachments.length, 1)
  })

  await check('частые изменения (таймер) не будят чаще заданного промежутка', async () => {
    const h = harness()
    h.api.start('t1', { gapMs: 10000 })
    assert.equal(await h.api.onChange('t1', change('0:01', '0:02'), info), 'woke')
    h.tick(1000)
    assert.equal(await h.api.onChange('t1', change('0:02', '0:03'), info), 'gap')
    h.tick(10000)
    assert.equal(await h.api.onChange('t1', change('0:03', '0:04'), info), 'woke')
    assert.equal(h.sent.length, 2)
  })

  await check('условие по тексту: будит один раз, когда текст появился, и не повторяет, пока он на странице', async () => {
    const h = harness()
    h.api.start('t1', { mode: 'text', pattern: 'ГОТОВО', gapMs: 1000 })
    assert.equal(await h.api.onChange('t1', change('Осталось 3', 'Осталось 2'), info), 'no-match')
    assert.equal(await h.api.onChange('t1', change('Осталось 1', 'ГОТОВО'), info), 'woke')
    h.tick(5000)
    assert.equal(await h.api.onChange('t1', change('ГОТОВО', 'ГОТОВО 12:00'), info), 'no-match')
    h.tick(5000)
    assert.equal(await h.api.onChange('t1', change('ГОТОВО 12:00', 'Осталось 9'), info), 'no-match')
    h.tick(5000)
    assert.equal(await h.api.onChange('t1', change('Осталось 9', 'ГОТОВО'), info), 'woke')
    assert.equal(h.sent.length, 2)
  })

  await check('условие, упавшее на паузе между пробуждениями, не теряется', async () => {
    const h = harness()
    h.api.start('t1', { mode: 'text', pattern: 'ГОТОВО', gapMs: 10000 })
    assert.equal(await h.api.onChange('t1', change('a', 'ГОТОВО'), info), 'woke')
    h.tick(2000)
    assert.equal(await h.api.onChange('t1', change('ГОТОВО', 'ждём'), info), 'no-match')
    h.tick(2000)
    assert.equal(await h.api.onChange('t1', change('ждём', 'ГОТОВО'), info), 'gap')
    h.tick(10000)
    assert.equal(await h.api.onChange('t1', change('ГОТОВО', 'ждём'), info), 'no-match')
    assert.equal(await h.api.onChange('t1', change('ждём', 'ГОТОВО'), info), 'woke')
  })

  await check('остановленная вкладка молчит; чат без ключа не будится; лимит в час', async () => {
    const h = harness()
    assert.equal(await h.api.onChange('нет', change('a', 'b'), info), 'no-watch')
    h.api.start('t1', { gapMs: 1000 })
    h.api.stop('t1')
    assert.equal(await h.api.onChange('t1', change('a', 'b'), info), 'no-watch')
    const closed = harness({ canWake: () => false })
    closed.api.start('t1', {})
    assert.equal(await closed.api.onChange('t1', change('a', 'b'), info), 'cannot')
    const busy = harness()
    busy.api.start('t1', { gapMs: 1000 })
    let last
    for (let i = 0; i < tabWatch.HOUR_LIMIT + 2; i++) { busy.tick(1500); last = await busy.api.onChange('t1', change('a' + i, 'b' + i), info) }
    assert.equal(last, 'hour-limit')
  })

  await check('без скриншота и без картинки: сообщение уходит, снимок только файлом', async () => {
    const h = harness({ screenshot: async () => ({ path: 'onlyone-screens/x.png', attachment: null }) })
    h.api.start('t1', {})
    await h.api.onChange('t1', change('a', 'b'), info)
    assert.deepEqual(h.sent[0].options.attachments, [])
    assert.match(h.sent[0].text, /x\.png/)
    const off = harness()
    off.api.start('t1', { screenshot: false })
    await off.api.onChange('t1', change('a', 'b'), info)
    assert.ok(!/Снимок/.test(off.sent[0].text))
    const broken = harness({ screenshot: async () => { throw new Error('нет кадра') } })
    broken.api.start('t1', {})
    assert.equal(await broken.api.onChange('t1', change('a', 'b'), info), 'woke', 'сбой снимка не должен глушить пробуждение')
  })

  await check('разбор сообщения наблюдателя и вычисление изменённой середины', () => {
    const line = tabWatch.MARK + JSON.stringify({ before: 'Осталось 3 с', after: 'Осталось 2 с', title: 'T' })
    const parsed = tabWatch.parseChange(line)
    assert.equal(parsed.after, 'Осталось 2 с')
    assert.equal(tabWatch.parseChange('обычный лог'), null)
    assert.equal(tabWatch.parseChange(tabWatch.MARK + '{битый'), null)
    assert.deepEqual(tabWatch.diffOf('Осталось 3 с', 'Осталось 2 с'), { was: 'Осталось 3', now: 'Осталось 2' })
  })

  await check('слежения чата: список, остановка по id и по чату, счётчик пробуждений', async () => {
    const h = harness()
    const first = h.api.start('t1', { chatId: 'c1', url: 'http://localhost:3000/', instruction: 'запиши цену' })
    h.api.start('t2', { chatId: 'c2', url: 'http://localhost:4000/' })
    assert.equal(h.api.list('c1').length, 1)
    assert.equal(h.api.list().length, 2)
    assert.ok(first.id && first.chatId === 'c1')
    let notified = 0
    h.api.subscribe(() => { notified++ })
    await h.api.onChange('t1', change('a', 'b'), info)
    assert.equal(h.api.list('c1')[0].wakeCount, 1)
    assert.ok(notified >= 1, 'панель «Задачи» должна узнать о пробуждении')
    assert.equal(h.api.stopById(first.id), true)
    assert.equal(h.api.stopById(first.id), false)
    assert.equal(h.api.stopChat('c2'), 1)
    assert.equal(h.api.list().length, 0)
  })

  await check('пробуждение уходит в тот чат, где слежение начато', async () => {
    const h = harness()
    h.api.start('t1', { chatId: 'чат-7' })
    await h.api.onChange('t1', change('a', 'b'), info)
    assert.equal(h.sent[0].options.chatId, 'чат-7')
  })

  await check('проводка: инструмент watch_page, запрос окну, панель «Задачи», снимок в проект', () => {
    const root = path.join(__dirname, '..')
    const read = file => fs.readFileSync(path.join(root, file), 'utf8')
    const main = read('src/main/main.js')
    assert.match(main, /name: 'watch_page'/)
    assert.match(main, /name: 'stop_watching'/)
    assert.match(main, /'watch-tab-request'/)
    assert.ok(main.includes("ipcMain.handle('watch-tab-reply'"))
    assert.match(main, /'save-page-screenshot'/)
    assert.match(read('src/preload/preload.js'), /onWatchTabRequest/)
    assert.match(read('src/renderer/browser-panel.js'), /'console-message'/)
    assert.match(read('src/renderer/browser-panel.js'), /OnlyonePageWatches/)
    assert.match(read('src/renderer/work-panel.js'), /data-watch-stop/)
    assert.ok(read('src/renderer/index.html').includes('tab-watch.js'))
    // Никаких лишних кнопок и окошек: слежение — по просьбе в чате.
    const html = read('src/renderer/index.html')
    assert.ok(!/id="browserTabWatch"/.test(html) && !/id="tabWatchPopover"/.test(html) && !/id="browserWatch"/.test(html))
  })

  if (failed) process.exit(1)
  console.log('\nНаблюдатель вкладки: проверки пройдены')
})()

