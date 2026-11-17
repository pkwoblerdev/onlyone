// fetch_url: агент читает страницу по ссылке.
//
// Проверяется настоящий модуль на настоящих HTTP-серверах в loopback: разметка
// становится текстом, длинная страница отдаётся частями, перенаправление снова
// проходит через разрешение, бинарное не читается, огромное обрезается.
//
// Главное про локальные адреса: доказывается не ответ классификатора, а
// отсутствие соединения. Каждый сервер сам считает принятые запросы, и проверка
// требует, чтобы без разрешения человека сервер не увидел ни одного. Чужие
// серверы при этом не обсуждаются: публичный адрес даёт фикстура DNS, а где
// именно взять байты для такого адреса, решает подставленный транспорт — он
// записывает, куда модуль попросил подключиться, и идёт на свой локальный
// сервер. Всё остальное (разбор ответа, лимиты, перенаправления) остаётся
// настоящим.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const web = require('../src/main/web-fetch.js')

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try { await fn() } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// Висящая проверка остановкила бы весь набор, а не одну строку журнала.
const within = (ms, promise, what) => {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`больше ${ms} мс — ${what}`)), ms)
    timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

const PUBLIC_IP = '93.184.216.34'

const PAGE = `<!doctype html><html><head><title>Док &amp; справка</title>
<style>.x{color:red}</style><script>alert('нет')</script></head>
<body><nav><a href="/menu">Меню</a></nav>
<main>
  <h1>Установка</h1>
  <p>Скачайте &laquo;пакет&raquo; и запустите &#8212; всё.</p>
  <ul><li>Первый шаг</li><li>Второй <a href="/guide?x=1">шаг</a></li></ul>
  <p>${'Длинный текст абзаца. '.repeat(40)}</p>
  <img src="a.png" alt="схема">
  <a href="#top">наверх</a> <a href="javascript:void(0)">кнопка</a>
</main>
<footer>Подвал</footer></body></html>`

// Сервер считает запросы сам: счётчик ведётся до того, как ответ отправлен, и
// проверка читает именно его, а не то, что посчитал модуль.
function serve(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    handler(req, res)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    hits,
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => {
      server.closeAllConnections?.()
      server.close(done)
    })
  })))
}

const routes = map => (req, res) => {
  const hit = map[req.url] || (() => { res.writeHead(500); res.end() })
  hit(req, res)
}

const text = (res, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

// Фикстура DNS: имя -> адреса. Вызовы считаются, чтобы видеть, сколько раз
// модуль заглянул в разрешение имени.
function resolver(table) {
  const calls = []
  const lookup = async (host, options) => {
    calls.push({ host, options })
    const entry = table[host]
    if (!entry) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    const addresses = typeof entry === 'function' ? entry(calls.length) : entry
    return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { lookup, calls }
}

// Транспорт-свидетель: записывает адрес, куда модуль попросил подключиться.
// Локальный адрес обслуживает по-настоящему; публичный — либо тоже ведет на
// свой локальный сервер (serve), либо сообщает об отказе, как отказал бы
// недоступный адрес в сети. Наружу тест не ходит ни в каком виде.
function witness({ serve: servePublic = false } = {}) {
  const calls = []
  const transport = async ({ url, addresses, signal }) => {
    calls.push({ host: url.hostname, port: url.port, addresses: [...addresses] })
    const loopback = addresses.includes('127.0.0.1')
    if (!loopback && !servePublic) {
      throw Object.assign(new Error(`подключение к ${addresses.join(', ')} в тесте не выполняется`), { code: 'ECONNREFUSED' })
    }
    return within(8000, web.requestVerified({ url, addresses: ['127.0.0.1'], signal }), 'локальный запрос завис')
  }
  return { calls, transport }
}

const localAllow = () => {
  const asked = []
  const allow = async (url, ctx) => {
    asked.push({ host: url.host, path: url.pathname, local: ctx && ctx.local, addresses: ctx && ctx.addresses, hop: ctx && ctx.hop })
    return true
  }
  return { asked, allow }
}

// close() у сервера завершается только тогда, когда закрыты все соединения.
// Если модуль оставил сокет висеть, этот промис не разрешится — так проверка
// ловит «зависший процесс» без счёта внутренних ручек Node.
const closeWithin = (server, ms = 3000) => within(ms, new Promise((resolve, reject) =>
  server.close(error => (error && !/not running/i.test(String(error.code || error.message)) ? reject(error) : resolve()))),
'сервер не дождался закрытия соединений — сокет остался открыт')

const neverResolves = () => new Promise(() => {})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  await check('разметка становится текстом', () => {
    const { title, text: body } = web.htmlToText(PAGE, 'https://site.test/docs/')
    assert.equal(title, 'Док & справка')
    assert.match(body, /^# Установка/m, 'заголовок должен стать #: ' + body.slice(0, 80))
    assert.match(body, /«пакет»/, 'сущности декодируются')
    assert.match(body, /запустите — всё/)
    assert.match(body, /^- Первый шаг$/m, 'пункты списка')
    assert.match(body, /\[шаг\]\(https:\/\/site\.test\/guide\?x=1\)/, 'ссылки абсолютные')
    assert.match(body, /\[изображение: схема\]/)
    assert(!/alert|color:red/.test(body), 'скрипт и стиль выброшены')
    assert(!/Меню|Подвал/.test(body), 'меню и подвал не попадают, когда есть main')
    assert(!/\[наверх\]|javascript:/.test(body), 'якоря и javascript: без ссылок')
  })

  await check('опасные адреса отвергаются', () => {
    for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ftp://x.test/', 'https://user:pass@x.test/', 'просто текст']) {
      assert.throws(() => web.parseTarget(bad), undefined, bad)
    }
    assert.equal(web.parseTarget('https://x.test/a#frag').href, 'https://x.test/a')
  })

  await check('нормализованные формы приватных адресов узнаются', () => {
    // WHATWG URL приводит IPv4-mapped в шестнадцатеричную форму: проверку
    // надо держать на той записи, что осталась в адресной строке запроса.
    assert.equal(new URL('http://[::ffff:127.0.0.1]/p').hostname, '[::ffff:7f00:1]')
    const mapped = ['::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1']
    const linkLocal = ['fe80::1', 'fe81::1', 'fe9f::1', 'febf::1', 'fe80:1234:5678:9abc:def0:1234:5678:9abc']
    const embedded = ['::7f00:1', '2002:7f00:1::', '64:ff9b::7f00:1', '2001:0:7f00:1::ffff:ffff:ffff:ffff']
    const privateV4 = ['127.0.0.1', '127.1.2.3', '10.1.2.3', '192.168.0.1', '172.16.0.5', '172.31.9.9',
      '169.254.1.1', '100.64.0.1', '100.127.5.5', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      // RFC 6890: диапазоны, которым не положено иметь публичный маршрут.
      // На них держатся служебные порты локальных приложений.
      '192.0.0.1', '192.0.0.254', '198.18.0.1', '198.19.255.254']
    const uniqueLocal = ['::1', '::', 'fc00::1', 'fd00::1', 'ff02::1']
    for (const ip of [...mapped, ...linkLocal, ...embedded, ...privateV4, ...uniqueLocal]) {
      assert.equal(web.isPrivateAddress(ip), true, 'посчитан внешним: ' + ip)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.253.0.1', 'fe7f::1', 'fec0::1',
      'fbff::1', '2606:4700:4747::1111', '::ffff:8.8.8.8', '::ffff:0:7f00:1']) {
      assert.equal(web.isPrivateAddress(ip), false, 'посчитан локальным: ' + ip)
    }
    // Ошибка прошлого кода была именно здесь: диапазон /10 накрывался
    // сравнением строк, и последний адрес диапазона проходил как внешний.
    assert.equal(web.isPrivateAddress('febf::1'), true)
    assert.equal(web.isPrivateAddress('fec0::1'), false)
    // Экзотические записи IPv4 разбирает WHATWG URL, и к проверке уже приходит
    // каноническая форма в точках — это сверяется здесь, а не на глаз.
    for (const [raw, canonical] of [['http://0177.0.0.1/', '127.0.0.1'], ['http://2130706433/', '127.0.0.1'],
      ['http://0x7f.0.0.1/', '127.0.0.1'], ['http://127.1/', '127.0.0.1'], ['http://000.1/', '0.0.0.1'],
      ['http://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]'], ['http://[::ffff:192.168.0.1]/', '[::ffff:c0a8:1]']]) {
      assert.equal(new URL(raw).hostname, canonical, raw)
      assert.equal(web.isPrivateAddress(web.canonicalAddress(canonical.replace(/^\[|\]$/g, ''))), true, raw)
    }
  })

  await check('адрес подключения — та же запись, что проверена', () => {
    assert.equal(web.canonicalAddress('::ffff:7f00:1'), '127.0.0.1')
    assert.equal(web.canonicalAddress('[::ffff:7f00:1]'), '127.0.0.1')
    assert.equal(web.canonicalAddress('127.0.0.1'), '127.0.0.1')
    assert.equal(web.canonicalAddress('::1'), '0:0:0:0:0:0:0:1')
    assert.equal(web.canonicalAddress('2002:7f00:1::'), '2002:7f00:1:0:0:0:0:0')
    assert.equal(web.canonicalAddress('example.test'), null)
  })

  await check('локальные имена и имена в домашнюю сеть', async () => {
    for (const name of ['localhost', 'router.local', 'printer.local.', 'nas.internal', 'x.localhost', '']) {
      assert.equal(web.isLocalName(name), true, name)
    }
    assert.equal(web.isLocalName('example.com'), false)
    assert.equal(await web.isLocalHost('localhost'), true)
    assert.equal(await web.isLocalHost('router.local'), true)
    assert.equal(await web.isLocalHost('[::ffff:7f00:1]'), true, 'mapped loopback как хост имени — локальный')
    assert.equal(await web.isLocalHost('febf::1'), true, 'конец FE80::/10 — локальный')
    const table = { 'evil.test': ['192.168.1.1'], 'example.test': [PUBLIC_IP], 'both.test': [PUBLIC_IP, '127.0.0.1'] }
    const fake = resolver(table).lookup
    assert.equal(await web.isLocalHost('evil.test', fake), true, 'имя, ведущее в домашнюю сеть, — локальное')
    assert.equal(await web.isLocalHost('example.test', fake), false)
    assert.equal(await web.isLocalHost('both.test', fake), true, 'один приватный ответ из двух — уже локальное имя')
    assert.equal(await web.isLocalHost('net.net.net', fake), false, 'нерезolvable имя не считается локальным')
  })

  await check('проверка идёт по фактическому списку ответов имени', async () => {
    const dnsFixture = resolver({ 'site.test': [PUBLIC_IP] })
    const target = await web.classifyTarget('http://site.test/p', dnsFixture.lookup)
    assert.deepEqual(target.addresses, [PUBLIC_IP])
    assert.equal(target.local, false)
    assert.equal(dnsFixture.calls.length, 1, 'одно разрешение на хоп')
    const mapped = await web.classifyTarget('http://[::ffff:7f00:1]:8080/p')
    assert.equal(mapped.local, true)
    assert.deepEqual(mapped.addresses, ['127.0.0.1'], 'проверяется и закрепляется развёрнутая форма')
  })

  const victim = await serve(routes({
    '/secret': (req, res) => text(res, 'СЕКРЕТ ЛОКАЛЬНОЙ СЕТИ')
  }))

  const site = await serve(routes({
    '/page': (req, res) => text(res, PAGE, 'text/html; charset=utf-8'),
    '/moved': (req, res) => { res.writeHead(302, { location: '/page' }); res.end() },
    '/to-local': (req, res) => { res.writeHead(302, { location: `http://[::ffff:7f00:1]:${victim.port}/secret` }); res.end() },
    '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end() },
    '/image': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(100)) },
    '/data': (req, res) => text(res, '{"a":1,"b":[1,2]}', 'application/json'),
    '/huge': (req, res) => text(res, 'x'.repeat(web.MAX_BYTES + 500000)),
    '/slow': (req, res) => { setTimeout(() => text(res, 'поздно'), 3000) },
    '/missing': (req, res) => { res.writeHead(404); res.end('нет такой') },
    '/gz': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(require('node:zlib').gzipSync(Buffer.from('сжатая страница')))
    }
  }))

  try {
    await check('страница читается, длинная — частями', async () => {
      const first = await within(8000, web.fetchPage(site.base + '/page', { allow: async () => true, maxChars: 1000 }), 'чтение зависло')
      assert.equal(first.success, true)
      assert.equal(first.title, 'Док & справка')
      assert.equal(first.text.length, 1000)
      assert.equal(first.nextOffset, 1000)
      assert.match(first.hint, /offset=1000/)
      const second = await web.fetchPage(site.base + '/page', { allow: async () => true, maxChars: 1000, offset: first.nextOffset })
      assert.equal(second.offset, 1000)
      assert.equal(second.text, (await web.fetchPage(site.base + '/page', { allow: async () => true, maxChars: 60000 })).text.slice(1000, 2000))
    })

    await check('сжатый ответ раскладывается', async () => {
      const page = await web.fetchPage(site.base + '/gz', { allow: async () => true })
      assert.equal(page.text, 'сжатая страница')
    })

    await check('https не тихо падает на http', async () => {
      // Транспорт переписан с глобального fetch на node:http и node:https,
      // поэтому надо видеть, что https-ветка действительно говорит по TLS и
      // по закреплённому адресу. Отвечаем ей открытым текстом: рукопожатие
      // обязано сорваться. Наружу при этом ничего не идёт.
      await assert.rejects(
        web.fetchPage(`https://127.0.0.1:${site.port}/page`, { allow: async () => true }),
        error => /EPROTO|wrong version|WRONG_VERSION|handshake|SSL/i.test(`${error.code} ${error.message}`)
      )
    })

    await check('проверка сертификата не отключена', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/web-fetch.js'), 'utf8')
      assert(!/rejectUnauthorized/.test(source), 'в web-fetch появился rejectUnauthorized')
      assert(!/checkServerIdentity/.test(source), 'в web-fetch появился checkServerIdentity')
      assert(!/require\(.node:tls.\)|require\('tls'\)/.test(source), 'ручное TLS не нужно: проверка должна оставаться штатной')
    })

    await check('разрешение спрашивается до подключения, на каждом хопе', async () => {
      const { asked, allow } = localAllow()
      const result = await web.fetchPage(site.base + '/moved', { allow })
      assert.equal(result.success, true, 'редирект дочитан')
      assert.deepEqual(asked.map(entry => entry.path), ['/moved', '/page'])
      assert.deepEqual(asked.map(entry => entry.hop), [0, 1])
      assert.equal(asked[0].local, true, '127.0.0.1 — локальный, спрашивается всегда')
      assert.deepEqual(asked[0].addresses, ['127.0.0.1'])
    })

    await check('отказ не делает ни одного запроса', async () => {
      const before = site.hits.length
      const result = await web.fetchPage(site.base + '/page', { allow: async () => false })
      assert.equal(result.denied, true)
      assert.equal(result.local, true)
      assert.equal(site.hits.length, before, 'сервер не должен был получить запрос: ' + JSON.stringify(site.hits.slice(before)))
    })

    await check('бинарное не читается, JSON — красиво', async () => {
      const image = await web.fetchPage(site.base + '/image', { allow: async () => true })
      assert.equal(image.success, false)
      assert.match(image.error, /не текстовая/)
      const data = await web.fetchPage(site.base + '/data', { allow: async () => true })
      assert.equal(data.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    })

    await check('огромное обрезается, 404 — ошибка с кодом', async () => {
      const huge = await web.fetchPage(site.base + '/huge', { allow: async () => true })
      assert.equal(huge.truncatedBytes, true)
      assert(huge.length <= web.MAX_BYTES, 'прочитано больше предела: ' + huge.length)
      const missing = await web.fetchPage(site.base + '/missing', { allow: async () => true })
      assert.equal(missing.success, false)
      assert.equal(missing.status, 404)
      assert.match(missing.error, /404/)
    })

    await check('перенаправление по кругу обрывается', async () => {
      await assert.rejects(web.fetchPage(site.base + '/loop', { allow: async () => true }), /перенаправлений/)
    })

    await check('Stop обрывает чтение', async () => {
      const controller = new AbortController()
      const pending = web.fetchPage(site.base + '/slow', { allow: async () => true, signal: controller.signal })
      setTimeout(() => controller.abort(), 100)
      const started = Date.now()
      await assert.rejects(pending)
      assert(Date.now() - started < 2000, 'ожидание не оборвалось')
    })

    // ---- Локальные адреса: доказывается отсутствие соединения ----

    await check('IPv4-mapped в шестнадцатеричной форме не проходит без разрешения', async () => {
      // Прошлый обход: URL нормализует [::ffff:127.0.0.1] в [::ffff:7f00:1],
      // проверка знала только dotted-форму — и запрос долетал до loopback.
      const url = `http://[::ffff:7f00:1]:${victim.port}/secret`
      assert.equal(web.isPrivateAddress(new URL(url).hostname.replace(/^\[|\]$/g, '')), true)
      const before = victim.hits.length
      const asked = []
      const result = await web.fetchPage(url, {
        allow: async (target, ctx) => { asked.push({ path: target.pathname, local: ctx.local, addresses: ctx.addresses }); return false }
      })
      assert.equal(result.denied, true)
      assert.equal(asked[0].local, true, 'человеку показали, что адрес локальный')
      assert.deepEqual(asked[0].addresses, ['127.0.0.1'])
      assert.equal(victim.hits.length, before, 'без разрешения запрос до локального сервера не дошёл: ' + JSON.stringify(victim.hits.slice(before)))
    })

    await check('IPv4-mapped с точками и без скобок ведёт себя так же', async () => {
      const before = victim.hits.length
      for (const host of ['[::ffff:127.0.0.1]', '[0:0:0:0:0:ffff:7f00:1]', '127.0.0.1']) {
        const result = await web.fetchPage(`http://${host}:${victim.port}/secret`, { allow: async () => false })
        assert.equal(result.denied, true, host)
      }
      assert.equal(victim.hits.length, before, 'ни одного подключения к локальному серверу')
      const allowed = await web.fetchPage(`http://[::ffff:7f00:1]:${victim.port}/secret`, { allow: async () => true })
      assert.equal(allowed.success, true, 'после явного разрешения страница читается')
      assert.equal(allowed.local, true)
      assert.match(allowed.text, /СЕКРЕТ/)
      assert.equal(victim.hits.length, before + 1, 'запрос прошёл ровно один раз и только после разрешения')
    })

    await check('весь FE80::/10 требует разрешения', async () => {
      const asked = []
      const before = victim.hits.length
      for (const host of ['fe80::1', 'fe9f::1', 'febf::1']) {
        const result = await web.fetchPage(`http://[${host}]:1/secret`, {
          allow: async (url, ctx) => { asked.push({ host: url.hostname, local: ctx.local }); return false }
        })
        assert.equal(result.denied, true, host)
        assert.equal(asked[asked.length - 1].local, true, host + ' внутри FE80::/10')
      }
      assert.deepEqual(asked.map(entry => entry.local), [true, true, true])
      assert.equal(victim.hits.length, before, 'ни одного подключения к локальному серверу')
    })

    await check('имя, которое ведёт в локальную сеть, не читается без разрешения', async () => {
      const dnsFixture = resolver({ 'nas.example': ['127.0.0.1'] })
      const before = victim.hits.length
      const result = await web.fetchPage(`http://nas.example:${victim.port}/secret`, {
        allow: async () => false,
        lookup: dnsFixture.lookup
      })
      assert.equal(result.denied, true)
      assert.equal(dnsFixture.calls.length, 1, 'имя разрешилось ровно один раз')
      assert.equal(victim.hits.length, before, 'сервер не получил запрос')
    })

    await check('редирект с публичного сайта в локальную сеть спрашивается заново', async () => {
      const dnsFixture = resolver({ 'site.test': [PUBLIC_IP] })
      const eye = witness({ serve: true })
      const asked = []
      const before = victim.hits.length
      const result = await web.fetchPage(`http://site.test:${site.port}/to-local`, {
        allow: async (url, ctx) => {
          asked.push({ host: url.hostname, local: ctx.local, hop: ctx.hop })
          return ctx.hop === 0
        },
        lookup: dnsFixture.lookup,
        request: eye.transport
      })
      assert.equal(asked.length, 2, 'второй хоп спросили: ' + JSON.stringify(asked))
      assert.deepEqual(asked[0], { host: 'site.test', local: false, hop: 0 })
      assert.equal(asked[1].host, '[::ffff:7f00:1]', 'в локальную сеть редирект ведёт по нормализованному адресу')
      assert.equal(asked[1].local, true, 'и он же требует подтверждения')
      assert.equal(result.denied, true)
      assert.equal(dnsFixture.calls.length, 1, 'публичное имя разрешилось один раз')
      assert.deepEqual(eye.calls.map(call => call.addresses), [[PUBLIC_IP]], 'к локальному адресу не подключались')
      assert.equal(victim.hits.length, before, 'отказ на втором хопе — локальный сервер ничего не увидел')
    })

    await check('тот же редирект читается, когда человек разрешил оба хопа', async () => {
      const dnsFixture = resolver({ 'site.test': [PUBLIC_IP] })
      const eye = witness({ serve: true })
      const before = victim.hits.length
      const result = await web.fetchPage(`http://site.test:${site.port}/to-local`, {
        allow: async () => true,
        lookup: dnsFixture.lookup,
        request: eye.transport
      })
      assert.equal(result.success, true)
      assert.equal(result.local, true, 'итог помечен как локальный')
      assert.match(result.text, /СЕКРЕТ/)
      assert.equal(victim.hits.length, before + 1)
      assert.deepEqual(eye.calls.map(call => call.addresses), [[PUBLIC_IP], ['127.0.0.1']])
    })

    await check('адрес не меняется между проверкой и соединением', async () => {
      // Классический DNS rebinding: первый ответ имени — публичный, второй —
      // loopback. Проверять надо по первому и по первому же подключаться;
      // тогда до локального сервера дело не доходит.
      const dnsFixture = resolver({ 'rebind.test': attempt => (attempt === 1 ? [PUBLIC_IP] : ['127.0.0.1']) })
      const eye = witness()
      const asked = []
      const before = victim.hits.length
      await assert.rejects(web.fetchPage(`http://rebind.test:${victim.port}/secret`, {
        allow: async (url, ctx) => { asked.push(ctx.addresses); return true },
        lookup: dnsFixture.lookup,
        request: eye.transport
      }))
      assert.equal(dnsFixture.calls.length, 1, 'второго разрешения имени не было: ' + JSON.stringify(dnsFixture.calls))
      assert.deepEqual(asked, [[PUBLIC_IP]], 'человеку показали и закрепили публичный ответ')
      assert.deepEqual(eye.calls.map(call => call.addresses), [[PUBLIC_IP]])
      assert.equal(victim.hits.length, before, 'в локальный сервер не подключались')
    })

    await check('публичный адрес по-прежнему читается', async () => {
      const dnsFixture = resolver({ 'example.test': [PUBLIC_IP, '2606:4700:4747::1111'] })
      const eye = witness({ serve: true })
      const { asked, allow } = localAllow()
      const before = victim.hits.length
      const result = await web.fetchPage(`http://example.test:${site.port}/page`, {
        allow, lookup: dnsFixture.lookup, request: eye.transport
      })
      assert.equal(result.success, true)
      assert.equal(result.title, 'Док & справка')
      assert.equal(asked[0].local, false, 'публичный адрес не стал локальным')
      assert.deepEqual(eye.calls[0].addresses, [PUBLIC_IP, '2606:4700:4747:0:0:0:0:1111'], 'подключение только по проверенным адресам')
      assert.equal(victim.hits.length, before, 'публичный ход не задел локальный сервер')
    })

    await check('проверенный адрес не подменяется соединением', async () => {
      // Здесь транспорт честный, но адрес подставлен: модуль обязан это
      // заметить и не отдавать ответ.
      const before = victim.hits.length
      await assert.rejects(
        web.requestVerified({ url: new URL(`http://127.0.0.1:${victim.port}/secret`), addresses: ['8.8.4.4'] }),
        /непроверенный адрес/
      )
      assert.equal(victim.hits.length, before + 1, 'сервер увидел попытку — и она отклонена после подключения')
      const good = await web.requestVerified({ url: new URL(`http://127.0.0.1:${victim.port}/secret`), addresses: ['127.0.0.1'] })
      assert.equal(good.status, 200)
      assert.equal(good.header('content-type'), 'text/plain; charset=utf-8')
      await good.discard()
    })

    // ---- Отмена и срок: промис обязан завершиться в каждой из четырёх фаз ----

    await check('фаза DNS: Stop во время разрешения имени завершает чтение', async () => {
      // Прежний дефект: разрешение имени ждалось неограниченно, и «стоп»,
      // нажатый до ответа DNS, промис не завершал вовсе.
      const trap = await serve(() => {})
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      const started = Date.now()
      await assert.rejects(web.fetchPage(`http://slow-dns.test:${trap.port}/page`, {
        allow: async () => true, lookup: neverResolves, signal: controller.signal
      }), error => error.name === 'AbortError')
      assert(Date.now() - started < 2000, 'отмена до DNS не подействовала')
      assert.equal(trap.hits.length, 0, 'соединение начато не было')
      await closeWithin(trap.server)
    })

    await check('фаза DNS: срок чтения сам по себе завершает чтение', async () => {
      // То же без человеческой отмены — по внутреннему сроку модуля. Проверка
      // идёт реальные ~20 с: это единственное честное доказательство, что фаза
      // разрешения имени ограничена общим бюджетом, а не висит вечно.
      const trap = await serve(() => {})
      const started = Date.now()
      await assert.rejects(web.fetchPage(`http://slow-dns.test:${trap.port}/page`, { allow: async () => true, lookup: neverResolves }))
      const elapsed = Date.now() - started
      assert(elapsed > 15000, 'слишком ранний отказ — значит сработало не время ожидания: ' + elapsed + ' мс')
      assert(elapsed < 26000, 'бюджет чтения не соблюдён: ' + elapsed + ' мс')
      assert.equal(trap.hits.length, 0)
      await closeWithin(trap.server)
    })

    await check('между проверкой и подключением: Stop не создаёт соединения', async () => {
      // allow() здесь намеренно не слушает сигнал: это худший случай — человек
      // уже сказал «да» после того, как ход отменили. Подключаться всё равно
      // нельзя.
      const trap = await serve(routes({ '/page': (req, res) => text(res, 'не должно быть прочитано') }))
      const dnsFixture = resolver({ 'site.test': ['127.0.0.1'] })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      await assert.rejects(web.fetchPage(`http://site.test:${trap.port}/page`, {
        allow: async () => { await sleep(600); return true },
        lookup: dnsFixture.lookup,
        signal: controller.signal
      }), error => error.name === 'AbortError')
      assert.equal(trap.hits.length, 0, 'запрос ушёл после отмены: ' + JSON.stringify(trap.hits))
      await closeWithin(trap.server)
    })

    await check('фаза заголовков: Stop обрывает и отпускает сокет', async () => {
      const trap = await serve(() => {})
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 200)
      const started = Date.now()
      await assert.rejects(web.fetchPage(`http://127.0.0.1:${trap.port}/page`, { allow: async () => true, signal: controller.signal }))
      assert(Date.now() - started < 2500, 'ожидание заголовков не оборвалось')
      assert.equal(trap.hits.length, 1, 'запрос был ровно один')
      await closeWithin(trap.server)
    })

    await check('фаза тела: Stop обрывает и обычное, и сжатое чтение', async () => {
      for (const kind of ['обычное', 'сжатое']) {
        const trap = await serve((req, res) => {
          if (kind === 'сжатое') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' })
            res.write(zlib.gzipSync(Buffer.from('начало страницы')))
          } else {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.write('начало страницы')
          }
          // и молчим: оборвать чтение должен сигнал отмены, а не ожидание вечно
        })
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 250)
        const started = Date.now()
        await assert.rejects(web.fetchPage(`http://127.0.0.1:${trap.port}/page`, { allow: async () => true, signal: controller.signal }))
        assert(Date.now() - started < 2500, kind + ' тело: чтение не оборвалось')
        assert.equal(trap.hits.length, 1, kind + ' тело: повторный запрос')
        await closeWithin(trap.server)
      }
    })

    await check('сжатое тело при обрыве соединения — ошибка, а не вечное ожидание', async () => {
      // pipe не переносит беду источника в распаковщик; без явной передачи
      // for await по gzipped-потоку висит, даже когда соединение уже закрыто.
      const trap = await serve((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' })
        const body = zlib.gzipSync(Buffer.from('длинная сжатая страница'))
        res.write(body.subarray(0, body.length - 4))
        setTimeout(() => res.destroy(), 120)
      })
      const started = Date.now()
      await assert.rejects(web.fetchPage(`http://127.0.0.1:${trap.port}/page`, { allow: async () => true }))
      assert(Date.now() - started < 3000, 'обрыв сжатого тела повис: ' + (Date.now() - started) + ' мс')
      await closeWithin(trap.server)
    })

    await check('обрыв обычного тела при обрыве соединения — ошибка, а не обрезок', async () => {
      const trap = await serve((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.write('оборвано на середине')
        setTimeout(() => res.destroy(), 120)
      })
      await assert.rejects(web.fetchPage(`http://127.0.0.1:${trap.port}/page`, { allow: async () => true }))
      await closeWithin(trap.server)
    })

    await check('после Stop повторного запроса нет', async () => {
      const controller = new AbortController()
      const trap = await serve(routes({ '/page': (req, res) => {
        text(res, PAGE, 'text/html; charset=utf-8')
        controller.abort()
      } }))
      try {
        await web.fetchPage(`http://127.0.0.1:${trap.port}/page`, { allow: async () => true, signal: controller.signal }).catch(() => {})
        await sleep(600)
        assert.equal(trap.hits.length, 1, 'модуль повторил запрос после отмены: ' + JSON.stringify(trap.hits))
      } finally { await closeWithin(trap.server) }
    })
  } finally {
    await site.close()
    await victim.close()
  }

  await check('нерезolvable имя не превращается в запрос', async () => {
    const dnsFixture = resolver({})
    const result = await web.fetchPage('http://net-imya-x.test/page', { allow: async () => true, lookup: dnsFixture.lookup })
      .then(() => 'нет отказа').catch(error => error.message)
    assert.match(result, /не разрешилось/)
    assert.equal(dnsFixture.calls.length, 1)
  })

  await check('main.js подключил инструмент с разрешением на каждый сайт', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
    assert.match(main, /require\('\.\/web-fetch'\)/)
    assert.match(main, /name: 'fetch_url'/)
    const branch = main.slice(main.indexOf("if (name === 'fetch_url')"), main.indexOf("if (name === 'fetch_url')") + 1500)
    assert(branch.length > 100, 'нет ветки fetch_url в executeTool')
    assert.match(branch, /risk: 'network'/)
    assert.match(branch, /force: local/, 'локальные адреса подтверждаются всегда')
    assert.match(branch, /signal/)
    const resets = main.match(/^\s+sessionApprovalGranted = false/gm).length
    const hostResets = (main.match(/networkHostsGranted\.clear\(\)/g) || []).length
    assert.equal(hostResets, resets, 'разрешения сайтов сбрасываются там же, где сессионное разрешение')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
