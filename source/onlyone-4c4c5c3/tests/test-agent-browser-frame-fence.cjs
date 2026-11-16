// test-agent-browser-frame-fence.cjs — находка Н2 аудита sec-net 2026-11-01:
// ограда browse_page обязана судить КАЖДЫЙ запрос partition, а не только навигацию
// главного кадра. `will-navigate`/`will-redirect` в Electron 44 видят только главный
// кадр, поэтому загруженная публичная страница через <iframe>, <img>, fetch или
// WebSocket молча ходила в локальную сеть (домашние сервисы, роутер, метаданные).
//
// Репро без живого окна: настоящий http-мок на 127.0.0.1 отдаёт «публичную страницу»
// с iframe на локальный сервис; тест роль Chromium — каждый адрес подкадра из
// разметки гонит через слушатель, который browsePage повесил на
// partition.webRequest.onBeforeRequest, и решает по его ответу, прочитан ли адрес.
// Вердикт человека — тот же хук `allow`, которым main.js подставляет карточку.
'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { browsePage } = require('../src/main/agent-browser.js')

const HOME_SECRET = 'ДОМАШНИЙ-СЕРВИС-ТАЙНА'

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

// Подстановка разрешений DNS: example.test и cdn.test — публичные адреса,
// rebind.test — имя, которое резолвится в 127.0.0.1 (DNS rebinding).
const PUBLIC_IP = '93.184.216.34'
const fakeLookup = async (host) => {
  if (String(host).toLowerCase() === 'rebind.test') return [{ address: '127.0.0.1', family: 4 }]
  return [{ address: PUBLIC_IP, family: 4 }]
}

// Адреса подкадров, которые «страница» просит загрузить: приватный литерал,
// WebSocket в приват, публичный CDN и имя с подменой на loopback.
const subTargets = port => [
  `http://127.0.0.1:${port}/secret`,
  `ws://127.0.0.1:${port}/live`,
  'https://cdn.test/pic.png',
  'https://rebind.test/admin'
]

async function main() {
  // Мок «интернета»: и страница агента, и домашний сервис живут на 127.0.0.1
  // (единственная сеть, в которой этот набор вообще ходит).
  const server = http.createServer((request, response) => {
    if (request.url === '/secret') { response.writeHead(200); response.end(HOME_SECRET); return }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>публичная страница</title>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  // Прогон одной «страницы»: возвращает решения ограды и что реально прочиталось.
  const run = async ({ allow } = {}) => {
    const asked = []
    const decisions = {}
    const read = []
    let fenceHandler = null
    const frameEvents = {}

    const partition = {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => false,
      webRequest: {
        onBeforeRequest: (filter, handler) => { fenceHandler = handler; partition.filter = filter },
        onBeforeRedirect: () => {}
      },
      on: () => {},
      clearStorageData: async () => {}
    }

    class MockWindow {
      constructor() {
        this.destroyed = false
        this.webContents = {
          setWindowOpenHandler: () => {},
          on: (event, handler) => { frameEvents[event] = handler },
          executeJavaScript: async () => ({ title: 'публичная страница', text: 'текст', links: [] })
        }
      }
      // Роль Chromium: страница получена, её подкадровые адреса идут через
      // слушатель partition; прочитывается только то, что ограда не отменила.
      async loadURL () {
        assert.ok(String(arguments[0]).includes('example.test'), 'loadURL должен грузить целевую страницу')
        for (const url of subTargets(port)) {
          let cancel = false
          if (fenceHandler) {
            const answer = await new Promise(resolve => fenceHandler({ url, method: 'GET', resourceType: 'subFrame' }, resolve))
            cancel = Boolean((answer && answer.cancel) !== undefined ? answer.cancel : (answer && answer.defaultPrevented))
          }
          decisions[url] = cancel
          if (!cancel && url.includes('127.0.0.1') && url.startsWith('http')) {
            read.push(await new Promise((resolve, reject) => {
              http.get(url, response => { let body = ''; response.setEncoding('utf8'); response.on('data', c => { body += c }); response.on('end', () => resolve(body)) }).on('error', reject)
            }))
          }
        }
      }
      destroy() { this.destroyed = true }
      isDestroyed() { return this.destroyed }
    }

    const result = await browsePage(`https://example.test/home`, {
      BrowserWindow: MockWindow,
      session: { fromPartition: () => partition },
      lookup: fakeLookup,
      allow: allow ? (url, ctx) => { asked.push(String(url && url.href || url)); return allow(url, ctx) } : undefined,
      timeoutMs: 5000
    })

    return { result, asked, decisions, read, frameEvents, filter: partition.filter, fenceSeen: Boolean(fenceHandler) }
  }

  await check('ограда висит на webRequest.onBeforeRequest partition (каждый запрос, не только главный кадр)', async () => {
    const { fenceSeen } = await run({ allow: async () => false })
    assert.ok(fenceSeen, 'слушатель onBeforeRequest не зарегистрирован: подкадры судить нечем')
  })

  await check('iframe в 127.0.0.1: человека СПРАШИВАЮТ и без его «да» адрес не читается', async () => {
    const { asked, decisions, read } = await run({ allow: async () => false })
    assert.ok(asked.some(a => a.includes(`127.0.0.1:${port}/secret`)), 'спроса о приватном подкадре не было: ' + JSON.stringify(asked))
    assert.equal(decisions[`http://127.0.0.1:${port}/secret`], true, 'отказанный приватный запрос не отменён')
    assert.equal(read.join(''), '', 'домашний сервис прочитан без решения человека: ' + read.join(''))
  })

  await check('WebSocket в 127.0.0.1 отменён, решения человека нет — прохода нет', async () => {
    const { decisions } = await run({ allow: async () => false })
    assert.equal(decisions[`ws://127.0.0.1:${port}/live`], true, 'ws-запрос в приват прошёл без отмены')
  })

  await check('без allow-хука приватный подкадр отменяется по умолчанию (отказ, не молчание)', async () => {
    const { decisions, read } = await run({})
    assert.equal(decisions[`http://127.0.0.1:${port}/secret`], true, 'без карточки человека приватный адрес прошёл молча')
    assert.equal(read.join(''), '', 'адрес прочитан без всякого решения человека')
  })

  await check('имя с DNS-подменой на 127.0.0.1 (rebind) тоже спрашивается и отменяется', async () => {
    const { asked, decisions } = await run({ allow: async () => false })
    assert.ok(asked.some(a => a.includes('rebind.test')), 'имя, резолвящееся в loopback, не спросили')
    assert.equal(decisions['https://rebind.test/admin'], true, 'rebind-подкадр не отменён')
  })

  await check('публичный CDN-подкадр проходит без спроса (ограда не ломает обычные страницы)', async () => {
    const { asked, decisions } = await run({ allow: async () => false })
    assert.equal(decisions['https://cdn.test/pic.png'], false, 'публичный подкадр отменён')
    assert.equal(asked.some(a => a.includes('cdn.test')), false, 'публичный адрес спрошен без нужды: ' + JSON.stringify(asked))
  })

  await check('решение человека «да» открывает проход: сервис читается после спроса', async () => {
    const { asked, decisions, read } = await run({ allow: async () => true })
    assert.ok(asked.length >= 1, 'разрешение должно спрашиваться, а не молча проходить')
    assert.equal(decisions[`http://127.0.0.1:${port}/secret`], false, 'разрешённый адрес всё равно отменён')
    assert.ok(read.some(body => body.includes(HOME_SECRET)), 'после «да» человека ответ не прочитан')
  })

  await check('фильтр слушателя накрывает http, https, ws и wss', async () => {
    const { filter } = await run({ allow: async () => false })
    const urls = (filter && filter.urls) || []
    for (const scheme of ['http://', 'https://', 'ws://', 'wss://']) {
      assert.ok(urls.some(u => String(u).startsWith(scheme)), `фильтр не накрывает ${scheme}: ${JSON.stringify(urls)}`)
    }
  })

  await check('will-frame-navigate зарегистрирован и режет подкадр вне http(s)', async () => {
    const { frameEvents } = await run({ allow: async () => false })
    assert.equal(typeof frameEvents['will-frame-navigate'], 'function', 'обработчик на каждый кадр не зарегистрирован')
    let prevented = false
    const event = { preventDefault: () => { prevented = true }, url: 'file:///C:/Windows/win.ini', isMainFrame: false }
    frameEvents['will-frame-navigate'](event, { url: event.url, isMainFrame: false })
    assert.ok(prevented, 'подкадр на file:// не отменён')
    prevented = false
    frameEvents['will-frame-navigate'](event, { url: 'https://example.test/next', isMainFrame: false })
    assert.equal(prevented, false, 'обычный http-подкадр не должен резаться на уровне кадра — решение у ограды запросов')
  })

  server.close()
  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed > 0) process.exit(1)
}

main()
