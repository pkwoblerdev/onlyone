// Стенд для экранов телефона: статика mobile/www, посредник и «компьютер» с настоящим ядром удалённого управления,
// но с придуманными чатами. Запуск вручную: node tests/mobile-harness.cjs — печатает адрес и код спаривания.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const { createRelay } = require('../server/relay/relay.js')
const { createRemoteControl } = require('../src/main/remote-control.js')

const WWW = path.join(__dirname, '..', 'mobile', 'www')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }

// 1×1 PNG-снимок для проверки экрана снимков (настоящая картинка, не заглушка текста).
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function demoChats() {
  const now = Date.now()
  return [
    {
      id: 'pc1', title: 'Рефакторинг модуля оплаты', remote: true, updatedAt: now - 60000,
      messages: [
        { role: 'user', content: 'Разбей модуль оплаты на две части и добавь тесты' },
        {
          role: 'assistant', content: 'Готово: payments.js разделён.',
          blocks: [
            { kind: 'thinking', text: '**Смотрю структуру модуля.**\nНужно понять, что можно вынести без изменения поведения.' },
            { kind: 'tool', parts: { verb: 'Прочитал', target: 'src/payments.js', tone: 'read', tool: 'read_file' } },
            { kind: 'tool', parts: { verb: 'Искал', target: 'calcTotal', tone: 'read', tool: 'search_files' } },
            { kind: 'plan', title: 'План', text: JSON.stringify([{ title: 'Вынести расчёт суммы', status: 'done' }, { title: 'Вынести работу с провайдером', status: 'doing' }, { title: 'Написать тесты', status: 'todo' }]) },
            { kind: 'tool', parts: { verb: 'Записал', target: 'src/payments/total.js', tone: 'ok', tool: 'write_file', meta: '+42 −0' } },
            { kind: 'tool', parts: { verb: 'Выполнил', target: 'npm test', tone: 'ok', tool: 'run_command' } },
            { kind: 'text', text: 'Готово: `payments.js` разделён на **две части**.\n\n- `total.js` — расчёт суммы\n- `gateway.js` — обращение к провайдеру\n\nТесты проходят: 14 из 14.' },
            { kind: 'tool', parts: { verb: 'Показал', target: 'превью', tone: 'ok', tool: 'show_artifact' }, shot: PIXEL }
          ]
        }
      ]
    },
    { id: 'pc2', title: 'Сайт студии: главная страница', remote: true, updatedAt: now - 3600000, messages: [{ role: 'user', content: 'Сделай главную' }, { role: 'assistant', content: 'Главная готова, открыл превью.' }] },
    { id: 'pc3', title: 'Личные заметки', remote: false, updatedAt: now - 7200000, messages: [{ role: 'user', content: 'секрет' }] }
  ]
}

async function startHarness(options = {}) {
  const chats = options.chats || demoChats()
  const approvals = []
  const questions = []
  const sent = []
  const stopped = []
  const resolved = []
  const state = { live: null }

  const files = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x')
    let file = path.join(WWW, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(response)
  })
  await new Promise(resolve => files.listen(options.port || 0, '127.0.0.1', resolve))

  // Провайдер для своих чатов телефона: совместимый с OpenAI, потоковый.
  const provider = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', '*')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (request.url.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Тестовая модель' }, { id: 'test/other', name: 'Другая модель' }] })); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      if (request.headers.authorization !== 'Bearer sk-test-phone') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'bad key' } })); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of ['Привет', ', это ', 'ответ с телефона.']) {
        response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n')
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))

  const relay = createRelay({ pingMs: 100000 })
  const relayPort = await relay.listen(0)
  const disk = { value: null }
  const core = createRemoteControl({
    WebSocketImpl: WebSocket, relayUrl: 'ws://127.0.0.1:' + relayPort, desktopName: 'Рабочий ПК', version: 'test',
    store: { read: () => disk.value, write: value => { disk.value = JSON.parse(JSON.stringify(value)) } },
    confirmDevice: async () => options.approve !== false,
    askRenderer: async (method, params) => {
      const remote = chats.filter(chat => chat.remote)
      const chat = chats.find(item => item.id === params.id)
      if (method === 'chats.list') return remote.map(item => ({ id: item.id, title: item.title, updatedAt: item.updatedAt, running: Boolean(state.live && state.live.chat === item.id), preview: String(item.messages[item.messages.length - 1].content || '').slice(0, 120) }))
      if (['chat.get', 'chat.send', 'chat.run', 'chat.settings', 'chat.shot', 'tasks.get'].includes(method) && (!chat || !chat.remote)) throw new Error('чат не открыт для телефона')
      if (method === 'chat.get') return { id: chat.id, title: chat.title, total: chat.messages.length, offset: 0, messages: chat.messages, live: state.live && state.live.chat === chat.id ? state.live.view : null, settings: { model: 'z-ai/glm-5.3', modelName: 'GLM 5.3', effort: 'high', stops: ['off', 'low', 'medium', 'high', 'max'] } }
      if (method === 'chat.send') { sent.push({ id: chat.id, text: params.text }); chat.messages.push({ role: 'user', content: params.text }); chat.messages.push({ role: 'assistant', content: 'Принято: ' + params.text }); chat.updatedAt = Date.now(); await core.broadcast('chat-changed', { id: chat.id, running: false }); return { ok: true, queued: false } }
      if (method === 'chat.run') return state.live && state.live.chat === chat.id ? { requestId: 'run1' } : null
      if (method === 'runs.owners') return { run1: 'pc1' }
      if (method === 'chat.settings') return { model: params.model || 'z-ai/glm-5.3', modelName: params.model || 'GLM 5.3', effort: params.effort || 'high', stops: ['off', 'low', 'medium', 'high', 'max'] }
      if (method === 'models.list') return [{ id: 'z-ai/glm-5.3', name: 'GLM 5.3' }, { id: 'openai/gpt-x', name: 'GPT X' }]
      if (method === 'chat.shot') return { image: PIXEL }
      if (method === 'tasks.get') return [{ id: 't1', title: 'Вынести расчёт суммы', status: 'done' }, { id: 't2', title: 'Написать тесты', status: 'todo', preview: 'после выноса' }]
      return null
    },
    listApprovals: () => approvals.filter(item => !resolved.includes(item.id)),
    resolveApproval: (id, ok) => { resolved.push(id); stopped.push(['approval', id, ok]); return true },
    listQuestions: () => questions.filter(item => !resolved.includes(item.id)),
    resolveQuestion: (id, answer) => { resolved.push(id); stopped.push(['answer', id, answer]); return true },
    abortRun: id => { stopped.push(['stop', id]); state.live = null; core.broadcast('chat-changed', { id: 'pc1', running: false }); return true }
  })
  await core.setEnabled(true)

  return {
    url: 'http://127.0.0.1:' + files.address().port + '/',
    relayUrl: 'ws://127.0.0.1:' + relayPort,
    providerUrl: 'http://127.0.0.1:' + provider.address().port,
    core, chats, approvals, questions, sent, stopped, resolved, state,
    async code() { return (await core.beginPairing()).code },
    async startLive() {
      state.live = { chat: 'pc1', view: { requestId: 'run1', content: 'Пишу тесты…', reasoning: '', blocks: [{ kind: 'tool', parts: { verb: 'Записал', target: 'tests/total.test.js', tone: 'ok', tool: 'write_file' } }, { kind: 'text', text: 'Пишу тесты для **total.js**…' }] } }
      await core.broadcast('chat-changed', { id: 'pc1', running: true })
    },
    async close() { core.stop(); await relay.close(); files.close(); provider.close() }
  }
}

module.exports = { startHarness, PIXEL, demoChats }

if (require.main === module) {
  startHarness({ port: Number(process.env.PORT) || 8099 }).then(async stand => {
    console.log('телефон:   ' + stand.url)
    console.log('посредник: ' + stand.relayUrl)
    console.log('провайдер: ' + stand.providerUrl + '  (ключ sk-test-phone)')
    console.log('код:       ' + await stand.code())
    stand.approvals.push({ id: 'a1', requestId: 'run1', summary: 'Записать файл src/payments/gateway.js', details: 'новый файл, 58 строк', risk: 'edit' })
    stand.approvals.push({ id: 'a2', requestId: 'run1', summary: 'Выполнить команду', details: 'rm -rf dist && npm run build', risk: 'external' })
    stand.questions.push({ id: 'q1', requestId: 'run1', question: 'Какой стиль тестов взять?', options: [{ label: 'node:test', detail: 'без зависимостей' }, { label: 'jest' }] })
    await stand.startLive()
    setInterval(() => {}, 1 << 30)
  })
}
