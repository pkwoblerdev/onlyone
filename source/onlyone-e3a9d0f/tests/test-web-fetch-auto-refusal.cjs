// break-5b Н15: autoLocalRefusal fail-open при отказе DNS; yt-dlp/MCP-клиент
// следует редиректам, которых проверка не видела. Тест гоняет настоящий
// web-fetch.js с подставными резолвером и транспортом — наружу ничего не ходит.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const webFetch = require('../src/main/web-fetch.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]
const publicLookup = async () => PUBLIC
const throwingLookup = async () => { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e }
const emptyLookup = async () => []
const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }]

// Подставной транспорт: карта href → {status, location}; считает вызовы.
const transport = (map, calls = []) => async ({ url }) => {
  calls.push(url.href)
  const entry = map[url.href]
  if (!entry) throw new Error('ECONNREFUSED (стенд): ' + url.href)
  return {
    status: entry.status,
    header: name => (String(name).toLowerCase() === 'location' ? entry.location : undefined),
    discard() {}
  }
}

async function main() {
  await asyncCheck('userinfo URL is refused in auto', async () => {
    assert.ok(await webFetch.autoRedirectRefusal('https://user:pass@example.com/x', 'auto', { lookup: publicLookup }))
  })

  // --- fail-closed на отказе резолва ---
  await asyncCheck('отказ DNS в «Авто» — запрет, а не «публичный»', async () => {
    const refusal = await webFetch.autoLocalRefusal('http://flip.example/promo', 'auto', throwingLookup)
    assert.ok(refusal && refusal.trim(), 'fail-open: имя не разрешилось, а проверка пропустила')
  })
  await asyncCheck('пустой ответ DNS в «Авто» — запрет', async () => {
    const refusal = await webFetch.autoLocalRefusal('http://flip.example/promo', 'auto', emptyLookup)
    assert.ok(refusal && refusal.trim(), 'пустой список адресов прошёл')
  })
  await asyncCheck('контроль: стабильный публичный адрес проходит (без сети)', async () => {
    assert.equal(await webFetch.autoLocalRefusal('https://example.com/v.mp4', 'auto', publicLookup), '')
  })
  await asyncCheck('контроль: стабильный приватный адрес запрещён', async () => {
    assert.ok(await webFetch.autoLocalRefusal('http://nas.home/x', 'auto', privateLookup))
  })
  await asyncCheck('контроль: ручные режимы не тронуты даже при отказе DNS', async () => {
    for (const permission of ['manual', 'acceptEdits', 'plan']) {
      assert.equal(await webFetch.autoLocalRefusal('http://flip.example/x', permission, throwingLookup), '')
    }
  })

  // --- редиректы: проверка цепи до запуска чужого загрузчика ---
  await asyncCheck('редирект публичного входа в loopback запрещён', async () => {
    const calls = []
    const request = transport({
      'https://public.example/promo': { status: 302, location: 'http://127.0.0.1:52684/SECRET.mp4' }
    }, calls)
    const refusal = await webFetch.autoRedirectRefusal('https://public.example/promo', 'auto', { lookup: publicLookup, request })
    assert.ok(refusal && refusal.trim(), 'редирект в loopback не проверен')
    assert.equal(calls.length, 1, 'запрос ушёл дальше первого хопа')
  })
  await asyncCheck('контроль: публичная цепь редиректов проходит', async () => {
    const request = transport({
      'https://public.example/promo': { status: 302, location: 'https://cdn.example/v.mp4' },
      'https://cdn.example/v.mp4': { status: 200 }
    })
    assert.equal(await webFetch.autoRedirectRefusal('https://public.example/promo', 'auto', { lookup: publicLookup, request }), '')
  })
  await asyncCheck('контроль: вход без редиректа проходит', async () => {
    const request = transport({ 'https://public.example/v.mp4': { status: 200 } })
    assert.equal(await webFetch.autoRedirectRefusal('https://public.example/v.mp4', 'auto', { lookup: publicLookup, request }), '')
  })
  await asyncCheck('отказ DNS на втором хопе — запрет (fail-closed)', async () => {
    const request = transport({
      'https://public.example/promo': { status: 302, location: 'https://flip.example/v.mp4' }
    })
    const lookup = async host => { if (host === 'flip.example') return throwingLookup(host); return PUBLIC }
    const refusal = await webFetch.autoRedirectRefusal('https://public.example/promo', 'auto', { lookup, request })
    assert.ok(refusal && refusal.trim(), 'отказ резолва на хопе пропущен')
  })
  await asyncCheck('редирект на file:// запрещён', async () => {
    const request = transport({
      'https://public.example/promo': { status: 302, location: 'file:///C:/Windows/win.ini' }
    })
    assert.ok(await webFetch.autoRedirectRefusal('https://public.example/promo', 'auto', { lookup: publicLookup, request }))
  })
  await asyncCheck('сетевая ошибка проверки — запрет (fail-closed)', async () => {
    const request = transport({}) // любой вызов бросает ECONNREFUSED
    assert.ok(await webFetch.autoRedirectRefusal('https://public.example/promo', 'auto', { lookup: publicLookup, request }))
  })
  await asyncCheck('контроль: в ручном режиме цепь не ходит вовсе', async () => {
    const calls = []
    const request = transport({}, calls)
    assert.equal(await webFetch.autoRedirectRefusal('https://public.example/promo', 'manual', { lookup: publicLookup, request }), '')
    assert.equal(calls.length, 0, 'ручной режим начал ходить в сеть без спроса')
  })

  check('в Auto загрузка видео и HTTP MCP требуют подтверждения', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
    const video = src.slice(src.indexOf('async function downloadVideoTool('), src.indexOf('async function analyzeVideoTool('))
    const mcp = src.slice(src.indexOf("if (name === 'add_mcp_server')"), src.indexOf("if (name === 'list_mcp_servers')"))
    assert.match(video, /signal, workspace\.permission === 'auto'/)
    assert.match(mcp, /workspace\.permission === 'auto' && config\.type === 'http'/)
  })

  // --- проводка: оба потребителя зовут проверку цепи до запуска ---
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  check('video_download проверяет редиректы до скачивания', () => {
    const from = mainSrc.indexOf('async function downloadVideoTool(')
    const branch = mainSrc.slice(from, mainSrc.indexOf('async function analyzeVideoTool(', from))
    const at = branch.indexOf('autoRedirectRefusal(')
    assert.ok(at > 0, 'проверки цепи нет в ветке video_download')
    assert.ok(at < branch.indexOf('.download('), 'проверка стоит после скачивания')
  })
  check('add_mcp_server (http) проверяет редиректы до подключения', () => {
    const from = mainSrc.indexOf("if (name === 'add_mcp_server')")
    const branch = mainSrc.slice(from, mainSrc.indexOf("if (name === 'list_mcp_servers')"))
    const at = branch.indexOf('autoRedirectRefusal(')
    assert.ok(at > 0, 'проверки цепи нет в ветке add_mcp_server')
    assert.ok(at < branch.indexOf('mcpManager.connect'), 'проверка стоит после подключения')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })