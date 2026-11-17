// Н22: шторм переподключений MCP в обход лестницы пауз.
//
// В журнале враждебного сервера: 20 × GET за 231 мс — по ~11 мс между
// попытками, хотя `MCP_RETRY_STEPS` начинается с 2000 мс. Лестница менеджера
// тут ни при чём: транспорт SDK сам переподключает закрытый GET-поток и берёт
// паузу из поля `retry:` сервера дословно. Сервер, который просит `retry: 0`,
// превращает поток в цикл, которого менеджер не видит.
//
// Здесь поднимается настоящий HTTP-сервер: initialize и tools/list отвечают,
// GET открывает SSE-поток, просит `retry: 0` и закрывается. Проверяется, что
// повтор идёт не раньше шага лестницы, а не через миллисекунды.
'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { McpManager, MCP_RETRY_STEPS } = require('../src/main/mcp-manager')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function stormServer () {
  const gets = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      gets.push(Date.now())
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      // Просим переподключаться без паузы и закрываем поток, когда соединение
      // уже установлено (иначе гонка с initialize: статус ещё «connecting»).
      res.write('retry: 0\n\n')
      setTimeout(() => res.end(), 200)
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let message = null
      try { message = JSON.parse(body) } catch { /* не наш запрос */ }
      const one = Array.isArray(message) ? message[0] : message
      if (one?.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: one.id,
          result: {
            protocolVersion: one.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'storm', version: '1' }
          }
        }))
        return
      }
      if (one?.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, result: { tools: [] } }))
        return
      }
      res.writeHead(202)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, gets, url: `http://127.0.0.1:${server.address().port}/mcp` }
}

let checks = 0
const failures = []
async function check (name, fn) {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

async function main () {
  const { server, gets, url } = await stormServer()
  const manager = new McpManager()
  manager.setConfigs([{ id: 'storm', name: 'Storm', type: 'http', url }])
  try {
    await check('сервер, просящий retry: 0, не устраивает шторм', async () => {
      await manager.connect('storm')
      await wait(900)
      assert.ok(gets.length <= 2, `GET за 900 мс: ${gets.length} — поток переподключается без паузы`)
    })

    await check('повтор идёт по лестнице менеджера, а не сразу', async () => {
      const before = gets.length
      assert.ok(before >= 1, 'ни одного GET: соединение не состоялось')
      const stop = Date.now() + MCP_RETRY_STEPS[0] + 2500
      while (gets.length <= before && Date.now() < stop) await wait(50)
      assert.ok(gets.length > before, 'менеджер так и не переподключился')
      const gap = gets[before] - gets[before - 1]
      assert.ok(gap >= MCP_RETRY_STEPS[0] - 200,
        `повтор через ${gap} мс, первый шаг лестницы ${MCP_RETRY_STEPS[0]} мс`)
    })
  } finally {
    await manager.disconnectAll().catch(() => {})
    server.close()
  }

  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

main().catch(error => { console.error('харнесс упал: ' + (error?.stack || error)); process.exit(2) })
