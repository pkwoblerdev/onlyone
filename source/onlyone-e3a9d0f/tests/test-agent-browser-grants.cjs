// test-agent-browser-grants.cjs — КРАСНЫЕ проверки пункта 3.6б (вариант 2):
// `browse_page` уважает список сайтов, разрешённых человеком (`networkHostsGranted`,
// как `fetch_url`); граница при этом не ослабляется.
//
// Набор написан ДО продуктового кода и обязан краснеть ПО ОТСУТСТВИЮ ПОВЕДЕНИЯ,
// а не падать на загрузке модуля: шапка делает мягкий `try/require`, первая
// проверка объявляет «хука `allow` ещё нет», остальные идут списком и каждая
// печатает свою причину. Так ведущий видит, какого именно звена не хватает,
// вместо одного `Cannot find module` на весь прогон.
//
// Что здесь заморожено контрактом (придумано этим набором, потому что в коде
// этого ещё нет — в докладе это названо отдельным списком):
//  - форма хука — та же, что у `fetch_url` (`src/main/web-fetch.js:508`):
//    `await allow(target, ctx)`, где `target` — объект адреса (у него есть
//    `href` и `hostname`), а `ctx.local` — признак локального адреса; ответ
//    `true` значит «можно», всё остальное — «нельзя»;
//  - хук принимается опцией `allow` и в `validateBrowserUrl(rawUrl, { lookup, allow })`,
//    и в `browsePage(rawUrl, { …, allow })`: одно имя на оба входа, второе
//    придумывать незачем;
//  - хук спрашивается ТОЛЬКО там, где граница сегодня и отказывает (локальный или
//    частный адрес, в том числе порезолв). Публичный адрес хука не видит: иначе
//    человек получил бы два спроса на один сайт — один от `validateBrowserUrl`,
//    второй от своего же списка разрешённых;
//  - отказ человека оформляется ответом инструмента `{ ok:false, error }`. В
//    текущем коде поле называется `success:false` — принимаем обе формы: поле не
//    наш, а вот «не исключение и не пустая прочитанная страница» — наше требование;
//  - сторож редиректов обязан получить тот же хук, а отказ на редиректе обязан
//    отменить переход (`preventDefault`), а не только писаться в журнал. Это
//    находка Н87, она закрыта проверкой 12.
//
// Electron этому набору не нужен: `BrowserWindow` и `session` подставляются
// заглушками, `dns.lookup` — подставкой `{ lookup }`, локальный адрес берётся у
// настоящего `http.createServer` на `127.0.0.1` со случайным портом. Настоящей
// сети в прогоне нет и быть не может.

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
// Пути к чужим файлам выводятся переменными — тот же приём, что
// `ONECODE_MAIN_UNDER_TEST` в tests/test-run-checkpoint-main-wiring.cjs.
const MAIN_SOURCE = process.env.ONECODE_MAIN_UNDER_TEST || path.join(ROOT, 'src', 'main', 'main.js')

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + ((error && error.message) || error).split('\n')[0].slice(0, 400))
  }
}

// --- мягкая загрузка подопытного модуля ---------------------------------------

let agentBrowser = null
let moduleError = null
try {
  agentBrowser = require('../src/main/agent-browser.js')
} catch (error) {
  moduleError = error
}

const missing = reason => async () => {
  throw new Error('модуль agent-browser.js не догрузился (' + ((moduleError && moduleError.message) || 'неизвестно') + '): ' + reason)
}
const validate = (agentBrowser && typeof agentBrowser.validateBrowserUrl === 'function')
  ? agentBrowser.validateBrowserUrl
  : missing('validateBrowserUrl не экспортируется')
const browsePage = (agentBrowser && typeof agentBrowser.browsePage === 'function')
  ? agentBrowser.browsePage
  : missing('browsePage не экспортируется')

// --- подставные разрешения имён -----------------------------------------------

const LOCAL = '127.0.0.1'
const lookupLocal = async () => [{ address: LOCAL, family: 4 }]
const lookupPrivate = async () => [{ address: '10.0.0.5', family: 4 }]
const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }]

// --- шпион хука allow ----------------------------------------------------------

function hookSpy (answer = true) {
  const calls = []
  const fn = async (target, ctx) => {
    calls.push({ target, ctx })
    return typeof answer === 'function' ? await answer(target, ctx) : answer
  }
  fn.calls = calls
  fn.addresses = () => calls.map(call => String((call.target && call.target.href) || call.target || ''))
  return fn
}

// --- заглушки Electron ---------------------------------------------------------

// `session` и `BrowserWindow` подставляются вместо настоящих: здесь проверяется
// решение об адресе, а не отрисовка Chromium — за ней стоит оконный прогон
// `tests/run-agent-browser-ui.cjs`.
function stubRuntime () {
  const calls = { windows: 0, loadURL: [], partitions: [], redirects: [], destroyed: 0, cleared: 0, permissions: [] }
  const handlers = {}
  const partition = {
    setPermissionRequestHandler: fn => { calls.permissions.push(fn) },
    setPermissionCheckHandler: () => false,
    webRequest: {
      onBeforeRequest: () => {},
      onBeforeRedirect: fn => { calls.redirects.push(fn) }
    },
    on: (event, fn) => { if (event === 'will-download') fn({ preventDefault () {} }) },
    clearStorageData: async () => { calls.cleared++ }
  }
  const session = { fromPartition: id => { calls.partitions.push(id); return partition } }
  class StubWindow {
    constructor () {
      calls.windows++
      this.dead = false
      this.webContents = {
        setWindowOpenHandler: () => {},
        on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn) },
        executeJavaScript: async () => ({ title: 'Заглушка', text: 'Текст прочитанной страницы', links: [] }),
        getURL: () => 'about:blank'
      }
    }
    async loadURL (url) { calls.loadURL.push(String(url)) }
    destroy () { this.dead = true; calls.destroyed++ }
    isDestroyed () { return this.dead }
  }
  return { calls, handlers, partition, session, BrowserWindow: StubWindow }
}

// Открыть страницу заглушки и вернуть всё, что наколотила заглушка рантайма.
async function openWith (url, options = {}) {
  const stub = stubRuntime()
  const result = await browsePage(url, Object.assign({
    BrowserWindow: stub.BrowserWindow,
    session: stub.session,
    lookup: lookupLocal,
    timeoutMs: 4000
  }, options))
  return { stub, result }
}

// Постучаться в навигационных сторожей скрытого окна и дождаться их решения.
// Резолв адреса асинхронный, поэтому «preventDefault» приходит и позже вызова:
// ждём тик, иначе проверка судила бы только по синхронной половине правила.
async function fireNavigation (stub, url, method) {
  const handlers = Object.keys(stub.handlers)
    .filter(name => /navigat|redirect/i.test(name))
    .reduce((all, name) => all.concat(stub.handlers[name]), [])
  assert.ok(handlers.length >= 1, 'у скрытого окна нет навигационного слушателя')
  let prevented = false
  for (const handler of handlers) await handler({ preventDefault () { prevented = true } }, url, { method })
  await new Promise(resolve => setTimeout(resolve, 60))
  return prevented
}

// --- исходник главного процесса ------------------------------------------------

let main = ''
try {
  main = fs.readFileSync(MAIN_SOURCE, 'utf8')
} catch (error) {
  console.error('не читается main.js: ' + error.message)
}

// Тело верхнеуровневой функции по имени: проверки по исходнику работают с
// участком, а не со всем файлом, — иначе «имя встречается в файле» посчиталось
// бы проводкой.
function topLevelFn (name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `в ${path.basename(MAIN_SOURCE)} нет функции ${name}: проводку искать негде`)
  const end = main.indexOf('\n}', start)
  assert.ok(end > start, `функция ${name} не закрылась на уровне файла: участок не выделить`)
  return main.slice(start, end + 2)
}

function lineWith (source, marker) {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `в участке нет «${marker}»`)
  const tail = source.slice(at)
  const cut = tail.indexOf('\n')
  return (cut > 0 ? tail.slice(0, cut) : tail).trim()
}

// --- локальная заглушка -------------------------------------------------------

let stubServer = null
let stubPort = 0
let localUrl = ''

;(async () => {
  stubServer = await new Promise((resolve, reject) => {
    const server = http.createServer((_req, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Заглушка</title><h1>Страница для проверок</h1>')
    })
    server.once('error', reject)
    server.listen(0, LOCAL, () => resolve(server))
  })
  stubPort = stubServer.address().port
  localUrl = `http://${LOCAL}:${stubPort}/`

  // 1. ПЕРВАЯ ПРОВЕРКА — красная по существу: хука `allow` в коде ещё нет,
  //    поэтому локальный адрес отвергается даже когда человек его разрешил.
  await check('хук allow в validateBrowserUrl: локальный адрес по разрешению человека проходит (КРАСНАЯ: хука allow ещё нет)', async () => {
    const allow = hookSpy(true)
    const url = await validate(localUrl, { lookup: lookupLocal, allow })
    assert.equal(String(url.hostname), LOCAL, 'должен вернуться проверенный адрес')
    assert.ok(allow.calls.length >= 1, 'хук не вызван ни разу: разрешения человека не спрашивают')
  })

  // 2. Заглушка действительно локальная: прогон не должен зависеть от сети.
  await check('заглушка живёт на 127.0.0.1 и отвечает без выхода наружу', async () => {
    const text = await new Promise((resolve, reject) => {
      http.get(localUrl, response => {
        let body = ''
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve(body))
      }).once('error', reject)
    })
    assert.match(text, /Страница для проверок/, 'заглушка не отдаёт страницу')
    assert.equal(stubServer.address().address, LOCAL, 'заглушка обязана слушать именно 127.0.0.1')
  })

  // 3. Хук, сказавший «нет», даёт ровно тот же отказ, что и отсутствие хука.
  await check('allow → false: отказ той же формулировкой SSRF, что и без хука', async () => {
    const withoutHook = await validate(localUrl, { lookup: lookupLocal }).then(() => null, error => error.message)
    const denied = await validate(localUrl, { lookup: lookupLocal, allow: hookSpy(false) }).then(() => null, error => error.message)
    assert.ok(withoutHook, 'без хука отказ обязан быть')
    assert.ok(denied, 'хук «нельзя» обязан дать отказ, а не пустую страницу')
    assert.match(denied, /локальн|частн|приватн|SSRF/i, 'отказ должен называть причину по-русски')
    assert.equal(denied, withoutHook, 'отказ по решению человека не должен менять формулировку границы')
  })

  // 4. Граница не ослабляется: без хука поведение ровно прежнее.
  await check('без allow локальный и частный адреса остаются запрещёнными (граница не ослаблена)', async () => {
    for (const url of [localUrl, 'http://localhost:3000/', 'http://10.0.0.5/admin', 'http://192.168.1.1/']) {
      await assert.rejects(() => validate(url, { lookup: lookupLocal }), /локальн|частн|приватн|SSRF/i, `${url} должен оставаться запрещён`)
    }
  })

  // 5. Хук вызывается ровно один раз на адрес и получает адрес + ctx.local.
  await check('allow вызывается ровно один раз на адрес и получает объект адреса и ctx.local', async () => {
    const allow = hookSpy(true)
    await validate(localUrl, { lookup: lookupLocal, allow })
    assert.equal(allow.calls.length, 1, `хук вызван ${allow.calls.length} раз на один адрес — должно быть ровно один`)
    const { target, ctx } = allow.calls[0]
    assert.equal(typeof (target && target.href), 'string', 'хук обязан получить объект адреса, а не строку или пустоту')
    assert.equal(String(target.hostname), LOCAL, 'хук получает именно тот адрес, о котором спрашивают')
    assert.ok(ctx && typeof ctx === 'object', 'хук обязан получить контекст вызова')
    assert.equal(ctx.local, true, 'для локального адреса ctx.local обязан быть true')
  })

  // 6. Публичный адрес хук не видит: иначе два спроса на один сайт.
  await check('публичный адрес хук allow НЕ спрашивает (один спрос на один сайт, не два)', async () => {
    const allow = hookSpy(true)
    const url = await validate('https://example.com/docs', { lookup: lookupPublic, allow })
    assert.equal(url.hostname, 'example.com', 'публичный адрес обязан проходить как раньше')
    assert.deepEqual(allow.calls, [], 'публичный адрес дошёл до хука: человек спрашивался бы дважды на один сайт')
  })

  // 7. Разрешение человека не отменяет правило протокола.
  await check('allow не обходит протокол: file:, data:, javascript: и пустой адрес — отказ до всякого спроса', async () => {
    for (const bad of ['file:///C:/Windows/win.ini', 'data:text/html,<h1>hi</h1>', 'javascript:alert(1)', '', '   ']) {
      const allow = hookSpy(true)
      await assert.rejects(() => validate(bad, { lookup: lookupLocal, allow }), /протокол|непустой|некорректн|http/i, `«${bad}» обязан быть отвергнут`)
      assert.deepEqual(allow.calls, [], `хук не должен вызываться для «${bad}»: вопрос об адресе задают после проверки протокола`)
    }
  })

  // 8. Разрешение не превращается в «разрешено всё»: хук спрашивают на каждый адрес.
  await check('хук спрашивается отдельно на каждый адрес: разрешение одного хоста не открывает второй', async () => {
    const allow = hookSpy(true)
    await validate(localUrl, { lookup: lookupLocal, allow })
    const other = `http://${LOCAL}:${stubPort + 1}/второй-адрес`
    await validate(other, { lookup: lookupLocal, allow })
    assert.equal(allow.calls.length, 2, `на два адреса хук вызван ${allow.calls.length} раз — внутри модуля кеша быть не должно`)
    assert.match(allow.addresses()[1], /127\.0\.0\.1/, 'второй вызов обязан быть именно про второй адрес')
  })

  // 9. DNS-подмена: имя, которое указывает в частную сеть, идёт через тот же хук.
  await check('имя, резолвящееся в приватный адрес, спрашивается по тому же хуку', async () => {
    const allow = hookSpy(true)
    const url = await validate('http://docs.example-host.local/', { lookup: lookupPrivate, allow })
    assert.equal(url.hostname, 'docs.example-host.local', 'разрешённый человеком адрес не обязан быть литералом IP')
    assert.equal(allow.calls.length, 1, 'хук обязан вызываться и по результату резолва, а не только по имени')
    assert.equal(allow.calls[0].ctx.local, true, 'частный порезолв обязан быть помечен как локальный')
  })

  // 10. browsePage передаёт хук в ПЕРВУЮ проверку.
  await check('browsePage(url, { allow }) передаёт хук в первую проверку и читает страницу', async () => {
    const allow = hookSpy(true)
    const { stub, result } = await openWith(localUrl, { allow })
    assert.ok(allow.calls.length >= 1, 'browsePage не передал хук в проверку начального адреса')
    assert.equal(result.success, true, `страница по разрешению человека должна прочитаться: ${result.error || ''}`)
    assert.equal(stub.calls.windows, 1, 'окно должно быть заведено ровно один раз')
    assert.ok(stub.calls.loadURL.includes(localUrl), `адрес не ушёл в загрузку: ${JSON.stringify(stub.calls.loadURL)}`)
  })

  // 11. Без хука — прежний честный отказ: ни окна, ни партиции.
  await check('browsePage без allow ведёт себя как раньше: отказ, окно не заведено, партиция не создана', async () => {
    const { stub, result } = await openWith(localUrl, {})
    assert.equal(result.success, false, 'без хука локальный адрес обязан быть отвергнут')
    assert.match(String(result.error), /локальн|частн|приватн|SSRF/i, 'причина обязана быть названа')
    assert.equal(stub.calls.windows, 0, 'отказ по адресу не должен заводить окно браузера')
    assert.equal(stub.calls.partitions.length, 0, 'отказ по адресу не должен создавать партицию')
  })

  // 12. Находка Н87: сторож редиректов обязан получить тот же хук И иметь силу
  //     отменить переход, а не только писать в журнал.
  await check('редирект в частную сеть не проходит мимо allow, а отказ на редиректе блокирует переход (Н87)', async () => {
    // Разрешён только адрес заглушки; редирект на порт 9001 человек не разрешал.
    const allow = hookSpy(target => !String((target && target.href) || '').includes(':9001'))
    const { stub, result } = await openWith(localUrl, { allow, hold: true })
    assert.equal(result.success, true, `базовая страница обязана открыться: ${result.error || ''}`)

    const redirect = `http://${LOCAL}:9001/в-приватную-сеть`
    const watchers = stub.calls.redirects
    assert.ok(watchers.length >= 1, 'сторож редиректов не навешен — хук до него тем более не доходит')
    for (const watcher of watchers) await watcher({ redirectURL: redirect, url: localUrl })
    assert.ok(allow.addresses().some(href => href.includes(':9001')),
      `хук не спросили про адрес редиректа; спросили только: ${allow.addresses().join(', ') || 'ничего'}`)

    // Отказ обязан отменить переход. `onBeforeRedirect` в Electron отменять не
    // умеет — значит блокировка живёт в `will-navigate`/`will-redirect`, туда мы
    // и стучимся: любой навигационный слушатель, сказавший «preventDefault» на
    // запрещённый адрес, засчитывается.
    const navigation = Object.keys(stub.handlers)
      .filter(name => /navigat|redirect/i.test(name))
      .reduce((all, name) => all.concat(stub.handlers[name]), [])
    assert.ok(navigation.length >= 1, 'у скрытого окна нет ни одного навигационного слушателя: отменять переход некому')
    let blocked = false
    let passed = false
    for (const handler of navigation) {
      let prevented = false
      await handler({ preventDefault () { prevented = true } }, redirect)
      if (prevented) blocked = true
      let preventedAgain = false
      await handler({ preventDefault () { preventedAgain = true } }, localUrl)
      if (!preventedAgain) passed = true
    }
    assert.ok(blocked, 'отказ человека на редиректе не отменил переход: сторож только пишет журнал (находка Н87)')
    assert.ok(passed, 'разрешённый адрес не должен блокироваться навигационным сторожем')
    try { await result.agentPage.release() } catch { /* страница заглушки уже снята */ }
  })

  // 12б. Находка Н103: первая загрузка судит адрес по РЕЗОЛВУ (`isLocalHost`
  //      смотрит, куда имя указывает), а сторож перехода сравнивал только строку
  //      хоста. `webFetch.isPrivateAddress` называет приватным любое не-IP
  //      значение («непонятное трактуем как локальное: спрашивается, а не
  //      проходит»), поэтому каждое имя — и публичный сайт, и роутер домашней
  //      сети — шло по одной ветке: переход отменялся, а человек получал спрос
  //      «локальный адрес» про обычный публичный клик. Резолв на переходе не
  //      выполнялся никогда, то есть граница на переходе не видит DNS rebinding.
  //      Проверка требует одного правила на обоих входах и сторожит оба края:
  //      публичное имя не имеет права ничего спрашивать, а приватное — обязано.
  await check('Н103: сторож перехода резолвит имя так же, как первая загрузка', async () => {
    const byHost = async host => (String(host || '').includes('inner') ? lookupPrivate() : lookupPublic())
    const pubAllow = hookSpy(false)
    const pub = await openWith('https://example.com/start', { allow: pubAllow, lookup: byHost, hold: true })
    assert.equal(pub.result.success, true, `публичная страница обязана прочитаться: ${pub.result.error || ''}`)
    assert.equal(pubAllow.calls.length, 0, 'на входе публичное имя не спрашивается — иначе следующий пункт ничего не стоит')

    // Переход внутри уже решённого хоста (редирект 308, клик по ссылке сайта) не отменяется и не спрашивает: отмена с
    // повтором роняла исходную загрузку с ERR_FAILED (-2) на любом сайте с редиректом.
    const sameHostBlocked = await fireNavigation(pub.stub, 'https://example.com/next-page', 'GET')
    assert.equal(sameHostBlocked, false, 'переход внутри решённого хоста отменён: страницы с редиректом перестанут открываться')
    assert.equal(pubAllow.calls.length, 0,
      'человека спрашивают про публичный переход: «локальный адрес» про обычный клик по ссылке (Н103)')
    // Другой публичный хост судится резолвом: отменяется и продолжается самим сторожем без спроса.
    await fireNavigation(pub.stub, 'https://news.example.org/story', 'GET')
    assert.equal(pubAllow.calls.length, 0, 'человека спрашивают про публичный переход на другой хост')
    assert.ok(pub.stub.calls.loadURL.includes('https://news.example.org/story'),
      `публичный переход на другой хост не состоялся: загружено ${pub.stub.calls.loadURL.join(', ') || 'ничего'}`)

    const privAllow = hookSpy(false)
    const priv = await openWith('https://example.com/start', { allow: privAllow, lookup: byHost, hold: true })
    const blocked = await fireNavigation(priv.stub, 'https://inner.example.com/admin', 'GET')
    assert.ok(blocked, 'имя, которое резолвится в 10.0.0.5, прошло переход без спроса — резолвинга на переходе нет (Н103)')
    assert.ok(privAllow.calls.length >= 1, 'переход в приватную сеть обязан спрашивать человека')
    assert.equal(privAllow.calls[0].ctx && privAllow.calls[0].ctx.local, true,
      'человеку показывают признак локального адреса — иначе он не отличит домашнюю сеть от сайта')
    assert.ok(!priv.stub.calls.loadURL.includes('https://inner.example.com/admin'),
      'отказ человека не отменил переход в приватную сеть')

    // Публичный IP-литерал и раньше не требовал ни резолва, ни спроса: проверка
    // сторожит регрессию — граница не должна превратиться в стену.
    const ipAllow = hookSpy(false)
    const ip = await openWith('https://93.184.216.34/start', { allow: ipAllow, hold: true })
    const ipBlocked = await fireNavigation(ip.stub, 'https://93.184.216.34/next-page', 'GET')
    assert.equal(ipBlocked, false, 'публичный IP-литерал отменён — сторож стал стеной')
    assert.equal(ipAllow.calls.length, 0, 'публичный IP-литерал спросился у человека без нужды')

    // Неразрешимое имя — худший случай: решение неизвестно, значит спрашиваем.
    // Стартует с публичного имени, а в неизвестность уходит уже переход.
    const failAllow = hookSpy(false)
    const unknownHost = async host => (String(host || '').includes('gone') ? Promise.reject(new Error('нет DNS')) : lookupPublic())
    const fail = await openWith('https://example.com/start', { allow: failAllow, lookup: unknownHost, hold: true })
    assert.equal(fail.result.success, true, `страница открылась иначе, чем ожидалось: ${fail.result.error || ''}`)
    await fireNavigation(fail.stub, 'https://gone.example.com/next-page', 'GET')
    assert.ok(failAllow.calls.length >= 1, 'имя без резолва пропущено молча: непонятный адрес обязан спрашиваться')
  })

  // 13. Удержание живой страницы по разрешённому адресу (нужно действиям).
  await check('hold и разрешённый адрес: страница остаётся живой и закрывается по release()', async () => {
    const { stub, result } = await openWith(localUrl, { allow: hookSpy(true), hold: true })
    assert.equal(result.success, true, `страница не открылась: ${result.error || ''}`)
    assert.ok(result.agentPage && result.agentPage.webContents, 'живая страница не возвращена: agentPage отсутствует')
    assert.equal(stub.calls.destroyed, 0, 'на hold окно не должно быть уничтожено до release()')
    await result.agentPage.release()
    assert.equal(stub.calls.destroyed, 1, 'release() обязан закрыть окно')
  })

  // 14. Отказ человека — честный ответ инструмента.
  await check('отказ человека = честный { ok:false, error } у browsePage, а не исключение и не пустая страница', async () => {
    const { stub, result } = await openWith(localUrl, { allow: hookSpy(false) })
    assert.ok(result && typeof result === 'object', 'browsePage обязан вернуть ответ, а не бросить исключение')
    assert.ok(result.ok === false || result.success === false, `отказ не помечен отказом: ${JSON.stringify(result).slice(0, 200)}`)
    assert.ok(String(result.error || '').trim().length > 8, 'причина обязана быть названа словами')
    assert.ok(!result.text, 'на отказе не должно быть прочитанного текста: пустая страница выглядела бы успехом')
    assert.equal(stub.calls.loadURL.length, 0, 'на отказе загрузка не начинается')
  })

  // 15…18. Проводка главного процесса по исходнику — как это делают наборы
  // `test-*-wiring-*`.
  await check('main.js: ветка browse_page передаёт в browsePage хук allow', async () => {
    assert.ok(main, 'исходник main.js не прочитан')
    const body = topLevelFn('agentBrowsePage')
    assert.match(body, /allow\s*:/, 'в вызове browsePage нет хука allow: разрешения человека не передаются')
  })

  await check("main.js: хук browse_page смотрит в networkHostsGranted и зовёт requestApproval с risk: 'network'", async () => {
    const body = topLevelFn('agentBrowsePage')
    assert.match(body, /networkHostsGranted/, 'хук не заглядывает в список сайтов, разрешённых человеком')
    assert.match(body, /requestApproval\(/, 'хук не спрашивает человека')
    assert.match(body, /risk:\s*'network'/, 'спрос обязан идти с тем же признаком риска, что у fetch_url')
  })

  await check('main.js: локальное разрешение не оседает в общем списке (граница не ослабляется)', async () => {
    const body = topLevelFn('agentBrowsePage')
    const adds = (body.match(/networkHostsGranted\.add\(/g) || []).length
    // Список разрешённых browse_page вправе только читать: локальный адрес
    // спрашивается каждый раз, как в `fetch_url`. Если запись в список всё-таки
    // есть, она обязана быть под тем же `!local` — иначе одно разрешение
    // открывает дорогу всей домашней сети.
    if (!adds) return
    assert.match(body, /if\s*\(allowed\s*&&\s*!local\)|!local[\s\S]{0,80}networkHostsGranted\.add/,
      'разрешение локального адреса не должно попадать в networkHostsGranted без охраны')
  })

  await check('main.js: движок действий получает validateUrl с ТЕМ ЖЕ хуком, иначе клик после редиректа строже входа', async () => {
    const body = topLevelFn('agentInteraction')
    const line = lineWith(body, 'validateUrl:')
    assert.match(line, /allow/, `движку передан сторож без хука разрешений: «${line}»`)
  })

  // 19. Соседняя граница не разъехалась: у fetch_url хук на месте и тот же список.
  await check('main.js: хук fetch_url не разъехался (тот же allow и тот же список сайтов)', async () => {
    assert.match(main, /allow:\s*async\s*\(target,\s*ctx\)/, 'у fetch_url хук allow обязан остаться в той же форме')
    assert.match(main, /networkHostsGranted\.has\(target\.host\)/, 'и в том же списке разрешённых')
  })

  // 20. Кадр переживает ход. Живой вид остаётся в панели после конца хода, а
  // iframe при каждой перестройке панели перечитывает свою ссылку: если байты
  // лежат только у открытой страницы, кадр гаснет на «Кадр не найден».
  await check('main.js: serveAgentShot держит последние кадры в памяти и после конца хода', async () => {
    const body = topLevelFn('serveAgentShot')
    assert.match(body, /agentShots/,
      'serveAgentShot читает только живую страницу хода: после освобождения страницы кадр недоступен')
    assert.match(body, /agentShots\.set\(/,
      'найденный кадр не сохраняется в память: второй запрос той же ссылки его уже не найдёт')
    assert.match(main, /AGENT_SHOTS_KEEP\s*=\s*\d+/,
      'число хранимых кадров не ограничено — память процесса растёт с каждым ходом')
  })

  // 21. Браузер человека: страница открывается в его разделе, с его входами. Раздел не
  // перенастраивается (разрешения и запрет скачивания уже стоят от браузера панели) и,
  // главное, не чистится в конце: иначе каждый ход агента выкидывал бы человека из аккаунтов.
  await check('sharedPartition: страница в разделе человека, раздел не трогается и не чистится', async () => {
    const { stub, result } = await openWith('https://example.com/', { sharedPartition: 'persist:onlyone-browser', lookup: lookupPublic })
    assert.equal(result.success, true)
    assert.deepEqual(stub.calls.partitions, ['persist:onlyone-browser'], 'открыт не раздел браузера человека')
    assert.equal(stub.calls.permissions.length, 0, 'у чужого раздела переставлены разрешения')
    assert.equal(stub.calls.redirects.length, 0, 'у чужого раздела повешен свой журнал редиректов')
    assert.equal(stub.calls.cleared, 0, 'раздел человека очищен: его входы потеряны')
    assert.equal(stub.calls.destroyed, 1, 'окно агента не закрыто')
  })

  await check('sharedPartition принимает только persist:-раздел, иначе — обычный одноразовый', async () => {
    const { stub } = await openWith('https://example.com/', { sharedPartition: 'default', lookup: lookupPublic })
    assert.match(stub.calls.partitions[0], /^agent-browser-/, 'чужое имя раздела принято')
    assert.equal(stub.calls.cleared, 1, 'одноразовый раздел не очищен')
  })

  await check('main.js: входы человека — только по параметру и с подтверждением один раз за ход', async () => {
    const body = topLevelFn('agentBrowsePage')
    assert.match(body, /args\.in_user_browser === true/, 'нет проверки параметра')
    assert.match(body, /requestApproval\(/, 'без вопроса человеку агент попал бы в его аккаунты')
    assert.match(body, /userBrowserTurns/, 'согласие не помнится на ход: спрашивалось бы на каждую страницу')
    assert.match(body, /sharedPartition = panelBrowser\.PARTITION/, 'раздел человека не передан в браузер агента')
    assert.match(main, /userBrowserTurns\.delete\(requestId\)/, 'согласие переживает ход')
  })

  await check('main.js: про необратимые действия в браузере человека сказано и модели, и человеку', async () => {
    assert.match(main, /перед оплатой, отправкой, публикацией или удалением[^']*ask_user/, 'в описании in_user_browser нет просьбы спрашивать')
    assert.match(main, /Оплату, отправку, публикацию и удаление он обязан сначала согласовать/, 'в карточке согласия нет предупреждения')
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (stubServer) stubServer.close()
  if (failed > 0) process.exit(1)
})().catch(error => {
  if (stubServer) stubServer.close()
  console.error('ПРОВАЛ харнесса: ' + ((error && error.stack) || error))
  process.exit(1)
})
