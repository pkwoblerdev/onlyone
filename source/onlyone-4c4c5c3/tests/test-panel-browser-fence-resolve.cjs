// test-panel-browser-fence-resolve.cjs — находка Н8 ломающего разбора break-5 (11.11):
// ограда partition встроенного браузера судила адрес ТОЛЬКО по форме. Публичное имя
// с приватной A-записью (`rebind.test` → 127.0.0.1) проходило: загруженная публичная
// страница через <iframe>/<img>/fetch/WebSocket читала домашний сервис.
//
// Резолв подставной (сети нет), ограда настоящая — та, что install вешает на
// partition.webRequest.onBeforeRequest. Тот же seam `lookup`, что у browsePage.
'use strict'

const assert = require('node:assert/strict')
const { install } = require('../src/main/panel-browser.js')

const PUBLIC_IP = '93.184.216.34'
const fakeLookup = async (host) => {
  const h = String(host).toLowerCase()
  if (h === 'rebind.test') return [{ address: '127.0.0.1', family: 4 }]
  if (h === 'nx.test') throw new Error('ENOTFOUND nx.test')
  return [{ address: PUBLIC_IP, family: 4 }]
}

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try {
    await fn()
    console.log(`ok     ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

function harness () {
  let handler = null
  const ses = {
    getUserAgent: () => 'Mozilla/5.0 Electron/44.0.0',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    on: () => {},
    webRequest: { onBeforeRequest: (_filter, fn) => { handler = fn } }
  }
  install({ app: { on: () => {} }, session: { fromPartition: () => ses }, lookup: fakeLookup })
  assert.equal(typeof handler, 'function', 'ограда не повешена на onBeforeRequest')

  return (url, topURL, resourceType = 'subFrame') => new Promise(resolve => {
    let calls = 0
    const details = {
      url,
      resourceType,
      webContents: { getURL: () => { if (topURL === null) throw new Error('окно уничтожено'); return topURL } }
    }
    handler(details, answer => {
      calls += 1
      if (calls === 1) resolve({ cancel: Boolean(answer && answer.cancel), calls: () => calls })
    })
  })
}

async function main () {
  const ask = harness()
  const PUBLIC_PAGE = 'https://example.test/story'
  const HOME_PAGE = 'http://127.0.0.1:5173/'

  await check('публичная страница → приватный литерал: отмена', async () => {
    const r = await ask('http://127.0.0.1:8080/secret', PUBLIC_PAGE)
    assert.equal(r.cancel, true)
  })

  await check('публичная страница → имя с приватной A-записью: отмена (Н8)', async () => {
    const r = await ask('https://rebind.test/admin', PUBLIC_PAGE)
    assert.equal(r.cancel, true, 'rebind.test резолвится в 127.0.0.1, ограда обязана отменить')
  })

  await check('публичная страница → WebSocket в приватный литерал: отмена', async () => {
    const r = await ask('ws://127.0.0.1:8080/live', PUBLIC_PAGE)
    assert.equal(r.cancel, true)
  })

  await check('публичная страница → публичный CDN: не блокируем', async () => {
    const r = await ask('https://cdn.test/pic.png', PUBLIC_PAGE)
    assert.equal(r.cancel, false)
  })

  await check('отказ DNS у имени подкадра: fail-closed, отмена', async () => {
    const r = await ask('https://nx.test/x', PUBLIC_PAGE)
    assert.equal(r.cancel, true, 'нерезолвящееся имя в «Авто» не должно проходить оградой')
  })

  await check('человек сам переходит на домашний адрес (mainFrame): не блокируем', async () => {
    const r = await ask('http://127.0.0.1:5173/', PUBLIC_PAGE, 'mainFrame')
    assert.equal(r.cancel, false)
  })

  await check('человек сам переходит на имя с приватной A-записью (mainFrame): не блокируем', async () => {
    const r = await ask('https://rebind.test/', PUBLIC_PAGE, 'mainFrame')
    assert.equal(r.cancel, false)
  })

  await check('страница сама приватная → своя сеть: не блокируем (dev-серверы)', async () => {
    const r = await ask('http://127.0.0.1:8080/api', HOME_PAGE)
    assert.equal(r.cancel, false)
  })

  await check('страница приватна по резолву → своя сеть: не блокируем', async () => {
    const r = await ask('http://127.0.0.1:8080/api', 'https://rebind.test/')
    assert.equal(r.cancel, false, 'страница на rebind.test живёт в привате и видит свою сеть')
  })

  await check('сведений о странице нет → приватный подкадр: отмена', async () => {
    const r = await ask('http://127.0.0.1:8080/secret', null)
    assert.equal(r.cancel, true)
  })

  await check('обработчик отвечает ровно один раз', async () => {
    const r = await ask('https://rebind.test/admin', PUBLIC_PAGE)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.calls(), 1)
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error(error); process.exit(1) })