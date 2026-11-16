// Свой OpenAI-compatible endpoint живым окном (план, 2.8).
//
// Unit-проверок (`test-provider-custom-wiring`, `test-provider-openai-stub`) для
// закрытия пункта мало: там нет ни DOM настроек, ни настоящего хода. Здесь
// человек кликом набирает адрес, модель и ключ, жмёт «Проверить эндпоинт»,
// переключает путь и отправляет сообщение — а запросы идут на HTTP-заглушку
// 127.0.0.1. Настоящих ключей, внешней сети и платной модели нет; красные
// прогоны оставляют профиль и кадры.
//
// Два окна подряд на одном профиле: первое настраивает и показывает панель,
// второе делает ход — так кадр настроек не перекрывается ответом.
const { spawn } = require('node:child_process')
const commandRunner = require('../src/main/command-runner')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-provider-custom')
const profile = path.join(output, 'profile')
// Кадры уходят в каталог улик, а не в временный профиль: зелёный прогон убирает
// свой каталог, а доказательство должно пережить прогон и быть смотримым глазами.
const shots = path.join(root, 'audits', 'qoder-2-2026-09-25', 'provider-ui')
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(profile, { recursive: true })

const SECRET = 'sk-EXAMPLE1afc93fb706'
const ENDPOINT_MODEL = 'моя-оконная-модель'
const ANSWER_MARK = 'МАРМЕЛАД-ОКОННЫЙ-ОТВЕТ'

const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// ---------------------------------------------------------------------------
// Заглушка эндпоинта: `/v1/models` и `/v1/chat/completions` в openai-диалекте
// ---------------------------------------------------------------------------
const hits = []
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    hits.push({ url: req.url, method: req.method, headers: req.headers, body })
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: ENDPOINT_MODEL, name: ENDPOINT_MODEL }, { id: 'вторая-оконная' }] }))
      return
    }
    const frames = [
      { choices: [{ delta: { content: ANSWER_MARK + ' ' } }] },
      { choices: [{ delta: { content: '— ответ локальной заглушки' }, finish_reason: 'stop' }] }
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
  })
})

const ready = new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve()))

const PRELUDE = `
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const byId = id => document.getElementById(id)
    const text = id => (byId(id)?.textContent || '').replace(/\\s+/g, ' ').trim()
    const until = async (fn, ms = 30000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { let value = false; try { value = fn() } catch {}; if (value) return true; await wait(120) }
      return false
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(1500)
`

// Ребёнок живёт в отдельном процессе, а сервер заглушки — в этом. `spawnSync`
// замораживает цикл событий родителя, соединение от окна висит в листене и не
// обслуживается: прогон честил бы «эндпоинт недоступен» на исправном коде.
function launch (name, scriptBody, extraEnv = {}) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(shots, name + '.png')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${scriptBody}\n      return { ok: checks.every(c => c.pass), checks } })()`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, stdio: 'inherit',
        env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot,
          ...extraEnv,
          ONECODE_ARG: `http://127.0.0.1:${stub.address().port}/v1` }) })
    const timer = setTimeout(() => {
      observe(`${name}: окно не вернулось за 240 с — снимаю дерево ${child.pid}`)
      commandRunner.killTree(child.pid, () => {})
    }, 240000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      const verdict = readJson(out)
      const list = verdict?.checks || []
      if (!list.length) list.push({ name: 'окно вернулось без единой проверки', pass: false,
        detail: (verdict?.error || `код выхода ${code}`) })
      for (const check of list) line(name, check.name, check.pass, check.detail)
      line(name, 'кадр сохранён', fs.existsSync(shot) && fs.statSync(shot).size > 10000, shot)
      resolve({ verdict, shot, code })
    })
  })
}

(async () => {
await ready

// ---------------------------------------------------------------------------
// A. Настройка своего пути мышкой: панель, сохранение, проверка, переключение
// ---------------------------------------------------------------------------
await launch('settings', `
  byId('openSettingsBtn')?.click()
  await wait(600)
  byId('tab-keys')?.click()
  await wait(400)
  note('группа пути видна', Boolean(byId('providerPathGroup')) && Boolean(byId('providerSelect')))
  const select = byId('providerSelect')
  note('по умолчанию выбран встроенный путь', select?.value !== 'openai-compatible', select?.value)
  // Раскладка 2.8б: поля своего пути скрыты, пока выбран OpenRouter — чтобы их
  // заполнить, путь надо выбрать. Прежний экран показывал их всегда.
  note('на OpenRouter полей пути нет', byId('providerFieldsGroup')?.hidden === true)
  select.value = 'openai-compatible'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(700)
  note('на своём пути поля и список подключений показаны',
    byId('providerFieldsGroup')?.hidden !== true && byId('customConnectionsGroup')?.hidden !== true)

  byId('customBaseUrlInput').value = '__ONECODE_ARG__'
  byId('customModelInput').value = '${ENDPOINT_MODEL}'
  byId('customKeyInput').value = '${SECRET}'
  byId('btnSaveCustomProvider')?.click()
  note('сохранение принято', await until(() => /Сохранено/.test(text('customProviderMessage'))), text('customProviderMessage'))
  note('поле ключа очищено сразу после сохранения', byId('customKeyInput').value === '', byId('customKeyInput').value)
  // С 25.09 окно не получает из ключа ничего: ни хвоста, ни длины. Состояние
  // называется словами, а различает подключения адрес и модель.
  note('о ключе сказано состоянием, а не символами',
    /Ключ защищён системой Windows/.test(text('customProviderKeyState')), text('customProviderKeyState'))
  note('в окне нет ни ключа, ни его хвоста',
    !document.documentElement.innerHTML.includes('${SECRET}') &&
    !document.documentElement.innerHTML.includes('${SECRET.slice(-4)}'))

  byId('btnCheckCustomProvider')?.click()
  note('проверка эндпоинта ответила списком моделей',
    await until(() => /Эндпоинт отвечает, моделей в каталоге: 2/.test(text('customProviderMessage'))), text('customProviderMessage'))
  const options = [...(byId('customModelList')?.options || [])].map(item => item.value)
  note('список моделей взят у эндпоинта, а не из каталога OpenRouter',
    options.includes('${ENDPOINT_MODEL}') && !options.some(id => id.includes('openrouter')), options.join(', '))
  note('адрес помечен локальным', /локальн/i.test(text('customProviderMessage')) || /локальн/i.test(text('providerPathNote')),
    text('providerPathNote'))
  note('сказано, чего этот путь не даёт', /не даёт/i.test(text('customProviderUnsupported')), text('customProviderUnsupported'))

  select.value = 'openai-compatible'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  note('переключение принято и названо вслух',
    await until(() => /Ход идёт на/.test(text('providerPathNote'))), text('providerPathNote'))
  note('ни один уголок DOM не содержит открытого ключа',
    !document.documentElement.innerHTML.includes('${SECRET}'), 'в innerHTML найден ключ')
`)

// ---------------------------------------------------------------------------
// B. Ход через свой путь на том же профиле
// ---------------------------------------------------------------------------
await launch('chat', `
  const pill = await until(() => /${ENDPOINT_MODEL}/.test(text('pillModelName')), 20000)
  note('шапка называет модель эндпоинта, а не модель OpenRouter', pill, text('pillModelName'))
  byId('newChatBtn')?.click()
  await wait(900)
  const box = byId('composerTextarea')
  box.value = 'Повтори одно слово: МАРМЕЛАД'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  byId('composerForm')?.requestSubmit()
  note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 20000))
  note('ответ свойственного эндпоинта появился в ленте',
    await until(() => /${ANSWER_MARK}/.test(document.querySelector('#messagesList')?.innerText || ''), 60000),
    (document.querySelector('#messagesList')?.innerText || '').slice(-160))
  note('ход дошёл до конца', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  const feed = document.querySelector('#messagesList')?.innerText || ''
  note('в ленте нет отказа пула OpenRouter', !/пуле нет активных ключей/i.test(feed), feed.slice(-200))
`, // ONECODE_E2E: без него `send-message` отвечает заготовкой (`replyForSmokeTest`),
   // и «ход» не доходил бы до сети — проверялся бы не провайдер, а fixture.
  { ONECODE_E2E: '1' })

// ---------------------------------------------------------------------------
// C. Что легло на диск: настройки и журнал этого профиля
// ---------------------------------------------------------------------------
{
  const settingsFile = path.join(profile, '1code-settings.json')
  const settings = readJson(settingsFile) || {}
  // После второй поставки подключение живёт в списке: берём первое (оно и есть
  // то, что окно завело без id).
  const record = (Array.isArray(settings.customProviders) ? settings.customProviders : [])[0] || null
  line('C профиль на диске', 'запись своего пути появилась в настройках', Boolean(record),
    JSON.stringify(Object.keys(settings)))
  line('C профиль на диске', 'ключ зашифрован и упакован safeStorage',
    Boolean(record?.keyEncrypted) && record?.keyEnc === 'safeStorage', JSON.stringify({ keyEnc: record?.keyEnc }))
  line('C профиль на диске', 'открытого ключа нет ни в одном месте файла настроек',
    !JSON.stringify(settings).includes(SECRET))
  line('C профиль на диске', 'имена ключей без точки (dot-prop)',
    !Object.keys(settings).some(key => key.includes('.')), Object.keys(settings).join(', '))
  const logs = fs.existsSync(path.join(profile, 'logs'))
    ? fs.readdirSync(path.join(profile, 'logs')).map(name => {
        try { return fs.readFileSync(path.join(profile, 'logs', name), 'utf8') } catch { return '' }
      }).join('\n') : ''
  observe(`журналов профиля: ${logs.length} знаков`)
  line('C профиль на диске', 'ключа нет в журналах главного процесса',
    !logs.includes(SECRET), logs.includes(SECRET) ? 'утечка в журнал' : '')
  const completions = hits.filter(hit => hit.url.endsWith('/chat/completions'))
  line('C профиль на диске', 'запросы ходили только на адрес заглушки',
    completions.length > 0 && completions.every(hit => hit.headers.authorization === 'Bearer ' + SECRET),
    `${completions.length} обращений`)
  line('C профиль на диске', 'на чужой сервер не уезжали OpenRouter-заголовки и поля',
    completions.every(hit => !hit.headers['http-referer'] && hit.body && hit.body.models === undefined),
    JSON.stringify(completions[0]?.body ? Object.keys(completions[0].body) : null))
}

let failed = 0
for (const group of [...new Set(report.map(item => item.group))]) {
  console.log('\n# ' + group)
  for (const item of report.filter(entry => entry.group === group)) {
    if (!item.pass) failed++
    console.log((item.pass ? 'ok     ' : 'ПРОВАЛ ') + item.name +
      (!item.pass && item.detail ? ' — ' + item.detail.slice(0, 300) : ''))
  }
}
console.log('\n# видно сейчас')
for (const text of observations) console.log('· ' + text)
console.log(`\nпроверок: ${report.length}, провалов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, output }))
stub.close()
settleRun(output, failed === 0)
process.exit(failed === 0 ? 0 : 1)
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(output, false)
  process.exit(2)
})
