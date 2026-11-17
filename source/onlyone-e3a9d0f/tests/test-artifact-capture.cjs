// Съёмка растра артефакта: окно-помощник и его границы (план, 1.4).
//
// Проверка по тексту, а не по поведению: окно живёт в главном процессе, и в
// узлом прогоне его не поднять. Так же устроен `tests/test-audit.cjs` — он
// требует обработчика окон и изоляции именно по исходнику. Смысл проверок не в
// форме, а в том, чем оборвано окно, которое рисует чужой html.
'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const file = path.join(root, 'src', 'main', 'artifact-capture.js')
const mainFile = path.join(root, 'src', 'main', 'main.js')

let total = 0
let failed = 0
async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

async function main () {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  let api = null
  let loadError = null
  if (source) {
    try { api = require(file) } catch (error) { loadError = error }
  }

  await check('модуль съёмки существует и отдаёт обещанный контракт', async () => {
    assert.ok(source, 'нет src/main/artifact-capture.js')
    assert.equal(loadError, null, 'модуль не загружается в узком прогоне: ' + (loadError && loadError.message))
    assert.equal(typeof api.capturePng, 'function', 'нет capturePng')
    assert.equal(typeof api.ownPrefix, 'function', 'нет ownPrefix')
  })

  await check('своё начало у ссылки хранилища — папка этого артефакта, не весь диск', async () => {
    assert.equal(api.ownPrefix('onecode-artifact://a1b2/3-index.html'), 'onecode-artifact://a1b2/')
    assert.equal(api.ownPrefix('onecode-artifact://a1b2'), 'onecode-artifact://a1b2')
    assert.equal(api.ownPrefix('onecode-artifact://a1b2/x').length, 'onecode-artifact://a1b2/'.length,
      'префикс уехал дальше папки артефакта')
  })

  await check('обёртка графика в data: не ломает границу съёмки', async () => {
    const wrapper = 'data:text/html;base64,PHN2Zz48L3N2Zz4='
    assert.equal(api.ownPrefix(wrapper), 'data:')
    assert.equal(api.ownPrefix(''), '')
    assert.equal(api.ownPrefix(null), '')
  })

  await check('окно съёмки не показывает себя и не оставляет его после себя', async () => {
    assert.match(source, /show:\s*false/, 'окно съёмки может быть видимым')
    assert.match(source, /new BrowserWindow\(/, 'окно не создаётся вовсе')
    assert.match(source, /destroy\(\)/, 'окно не уничтожается')
    assert.match(source, /finally\s*\{[\s\S]*destroy\(\)[\s\S]*\}/,
      'уничтожение окна не в `finally`: неудачная съёмка оставит окно висеть')
  })

  await check('окно съёмки живёт в своей сессии и без прав', async () => {
    assert.match(source, /fromPartition\(/, 'съёмка делит сессию основного окна')
    assert.match(source, /setPermissionRequestHandler/, 'запросы прав не отсекаются')
    assert.match(source, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/,
      'проверка прав отвечает разрешением')
    assert.match(source, /sandbox:\s*true/, 'окно не в песочнице')
    assert.match(source, /nodeIntegration:\s*false/, 'у окна есть доступ к node')
    assert.match(source, /clearStorageData/, 'данные съёмки остаются в профиле')
  })

  await check('окно съёмки не открывает окон и не уходит с адресов', async () => {
    assert.match(source, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/,
      'страница артефакта может открыть своё окно')
    assert.match(source, /'will-navigate'[\s\S]{0,120}preventDefault/, 'страница может увести окно с адреса')
    assert.match(source, /'will-redirect'[\s\S]{0,120}preventDefault/, 'редирект не удержан')
    assert.match(source, /onBeforeRequest/, 'содержимое артефакта тянет ресурсы наружу')
    assert.match(source, /ownPrefix/, 'граница запросов не выведена из адреса, который рисуем')
  })

  await check('съёмка имеет срок, а не висит до закрытия приложения', async () => {
    assert.match(source, /setTimeout\([\s\S]{0,160}reject/, 'таймера нет — зависшая страница блокирует выгрузку')
    assert.match(source, /clearTimeout/, 'таймер не снимается')
  })

  await check('в главном процессе окно по-прежнему одно', async () => {
    const main = fs.readFileSync(mainFile, 'utf8')
    const count = (main.match(/new BrowserWindow\(/g) || []).length
    assert.equal(count, 1, `в main.js окон ${count}: правило «окно ровно одно» держится только если помощник живёт своим модулем`)
    assert.equal(/captureArtifactPng/.test(main), false, 'съёмка всё ещё реализована в главном процессе')
    assert.match(main, /require\('\.\/artifact-capture\.js'\)/, 'главный процесс не зовёт модуль съёмки')
  })

  await check('экспорт зовёт съёмку одним объектом и не передаёт ему чужих путей', async () => {
    const exporter = fs.readFileSync(path.join(root, 'src', 'main', 'artifact-export.js'), 'utf8')
    assert.match(exporter, /capturePage\(\{[^}]*url[^}]*width[^}]*height/,
      'контракт съёмки — один объект с адресом и размером')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('ПРОВАЛ НАБОРА: ' + (error && error.stack || error))
  process.exit(1)
})
