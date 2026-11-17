// Несколько именованных подключений живым окном (план, 2.8, вторая поставка).
//
// `test-provider-profiles.cjs` меряет главный процесс. Здесь проверяется то, что
// видно человеку: два подключения заводятся мышкой, каждое проверяется на своём
// адресе, выбор переключает ход, и ответ приходит ОТ ТОГО эндпоинта, который
// выбран, — с своим ключом и своей моделью в шапке. Два «разных сервера» — один
// процесс-заглушка на 127.0.0.1 с двумя префиксами пути. Настоящих ключей,
// внешней сети и платных вызовов нет; красный прогон оставляет профиль и кадры.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-provider-profiles')
const profile = path.join(output, 'profile')
fs.mkdirSync(profile, { recursive: true })
// Кадры — в каталог улик: зелёный прогон убирает свой временный профиль, а
// доказательство должно пережить прогон и быть смотримым глазами.
const shots = path.join(root, 'audits', 'qoder-2-2026-09-25', 'provider-profiles-ui')
fs.mkdirSync(shots, { recursive: true })

const KEY_A = 'sk-EXAMPLE315aed97276'
const KEY_B = 'sk-EXAMPLE8918c925e20'
const MODEL_A = 'модель-окона-А'
const MODEL_B = 'модель-окона-Б'
const ANSWER_A = 'ОТВЕТ-ПОДКЛЮЧЕНИЯ-А'
const ANSWER_B = 'ОТВЕТ-ПОДКЛЮЧЕНИЯ-Б'

const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// ---------------------------------------------------------------------------
// Заглушка: два эндпоинта на одном сервере, разные ключи и ответы
// ---------------------------------------------------------------------------
const hits = []
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    const side = /^\/a\//.test(req.url) ? 'a' : /^\/b\//.test(req.url) ? 'b' : null
    hits.push({ url: req.url, side, headers: req.headers, body })
    if (!side) { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}'); return }
    const model = side === 'a' ? MODEL_A : MODEL_B
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: model, name: model }, { id: `соседняя-${side}` }] }))
      return
    }
    if (req.headers.authorization !== `Bearer ${side === 'a' ? KEY_A : KEY_B}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'ключ этого подключения не подходит' } }))
      return
    }
    const text = side === 'a' ? ANSWER_A : ANSWER_B
    const frames = [
      { choices: [{ delta: { content: text + ' ' } }] },
      { choices: [{ delta: { content: '— ответ локальной заглушки' }, finish_reason: 'stop' }] }
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
  })
})
const ready = new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve()))
const urlFor = side => `http://127.0.0.1:${stub.address().port}/${side}/v1`

const PRELUDE = `
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const byId = id => document.getElementById(id)
    const text = id => (byId(id)?.textContent || '').replace(/\\s+/g, ' ').trim()
    const feed = () => (document.querySelector('#messagesList')?.innerText || '').replace(/\\s+/g, ' ')
    const until = async (fn, ms = 30000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { let value = false; try { value = fn() } catch {}; if (value) return true; await wait(120) }
      return false
    }
    const fill = async (id, value) => {
      const node = byId(id)
      if (!node) return false
      // Как настоящий ввод: поле в фокусе, потом значение и событие. Без фокуса
      // любой перерисованный экран затирает то, что человек уже набрал.
      node.focus?.()
      node.value = value
      node.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(1500)
    const openKeys = async () => {
      byId('openSettingsBtn')?.click()
      await wait(600)
      byId('tab-keys')?.click()
      await wait(400)
    }
    // Раскладка 2.8б: путь выбирается списком, а подключение — строкой.
    // Обратные кавычки внутри этого шаблона ломают скрипт, поэтому селектор
    // собирается склейкой.
    const choosePath = async id => {
      const select = byId('providerSelect')
      select.value = id
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(700)
    }
    const connRow = name => [...document.querySelectorAll('#customConnectionsList .conn-row')]
      .find(row => ((row.querySelector('.key-name') || {}).textContent || '').trim() === name)
    const connClick = async (name, action) => {
      const row = connRow(name)
      if (!row) return false
      if (!action) { row.querySelector('.conn-main')?.click(); await wait(500); return true }
      row.querySelector('.conn-more')?.click()
      await wait(200)
      row.querySelector('.conn-menu-item[data-action=' + action + ']')?.click()
      await wait(300)
      return true
    }
`

// Ребёнок живёт в отдельном процессе, а заглушка — в этом: `spawnSync` заморозил
// бы цикл событий родителя, и окно не дождлось бы ответа.
function launch (name, scriptBody, extraEnv = {}) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(shots, name + '.png')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${scriptBody}\n      return { ok: checks.every(c => c.pass), checks } })()`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, stdio: 'inherit',
        env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot, ...extraEnv }) })
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
      resolve({ verdict, shot })
    })
  })
}

(async () => {
  await ready

  // -------------------------------------------------------------------------
  // A. Два подключения заводятся и проверяются мышкой, выбор переключает ход
  // -------------------------------------------------------------------------
  await launch('setup', `
    await openKeys()
    note('на OpenRouter списка подключений нет вовсе',
      byId('customConnectionsGroup')?.hidden === true && byId('openrouterKeysGroup')?.hidden !== true)
    await choosePath('openai-compatible')
    note('свои подключения есть на своём пути, с кнопкой нового',
      byId('customConnectionsGroup')?.hidden !== true && Boolean(byId('btnNewConnection')))
    note('пока нет ни одного подключения', /ещё нет/i.test(text('customConnectionsList')), text('customConnectionsList'))

    await fill('customProviderNameInput', 'Домашняя')
    await fill('customBaseUrlInput', '${urlFor('a')}')
    await fill('customModelInput', '${MODEL_A}')
    await fill('customKeyInput', '${KEY_A}')
    byId('btnSaveCustomProvider')?.click()
    note('первое подключение сохранено', await until(() => /Сохранено/.test(text('customProviderMessage'))), text('customProviderMessage'))
    byId('btnCheckCustomProvider')?.click()
    note('первое проверено на своём адресе',
      await until(() => /моделей в каталоге: 2/.test(text('customProviderMessage'))), text('customProviderMessage'))
    note('чип состояния называет проверенный путь',
      /Подключено/.test(text('providerPathState')), text('providerPathState'))

    byId('btnNewConnection')?.click()
    note('второе подключение создано кнопкой «Новое подключение»',
      await until(() => /Подключение создано/.test(text('customProviderMessage'))), text('customProviderMessage'))
    await fill('customProviderNameInput', 'Рабочая')
    await fill('customBaseUrlInput', '${urlFor('b')}')
    await fill('customModelInput', '${MODEL_B}')
    await fill('customKeyInput', '${KEY_B}')
    await wait(200)
    await until(() => !byId('btnSaveCustomProvider')?.disabled)
    byId('btnSaveCustomProvider')?.click()
    note('второе сохранено', await until(() => /Сохранено/.test(text('customProviderMessage'))),
      'сообщение: ' + text('customProviderMessage') + ' | поля: ' + byId('customBaseUrlInput').value +
      ' / ' + byId('customModelInput').value)
    byId('btnCheckCustomProvider')?.click()
    note('второе проверено на своём адресе',
      await until(() => /моделей в каталоге: 2/.test(text('customProviderMessage'))), text('customProviderMessage'))

    const names = [...document.querySelectorAll('#customConnectionsList .key-name')].map(one => one.textContent.trim())
    note('в списке оба подключения по именам', names.includes('Домашняя') && names.includes('Рабочая'), names.join(', '))
    note('у строки списка есть меню и короткий адрес',
      Boolean(connRow('Рабочая')?.querySelector('.conn-more')) &&
      (connRow('Рабочая')?.querySelector('.conn-addr')?.textContent || '').includes('/b/v1'),
      (connRow('Рабочая')?.querySelector('.conn-addr')?.textContent || ''))
    // Из ключа окно не видит ничего (правило 25.09), поэтому «то ли это
    // подключение на экране» сверяется адресом и моделью — они и есть
    // различимые поля. (Внимательно: обратные кавычки внутри этого шаблона
    // ломают скрипт.)
    const shownState = text('customProviderKeyState')
    note('о ключе сказано состоянием, а не символами',
      /Ключ защищён системой Windows/.test(shownState), shownState)
    note('на экране то подключение, которое выбрано',
      byId('customBaseUrlInput').value.includes('/b/v1') && byId('customModelInput').value === '${MODEL_B}',
      byId('customBaseUrlInput').value + ' / ' + byId('customModelInput').value)
    note('ни в одном месте окна нет ни ключа, ни его хвоста',
      !['${KEY_A}', '${KEY_B}', '${KEY_A.slice(-4)}', '${KEY_B.slice(-4)}']
        .some(one => document.documentElement.innerHTML.includes(one)))

    await choosePath('openai-compatible')
    note('путь переключён и названо выбранное подключение',
      await until(() => /Ход идёт на подключение/.test(text('customProviderMessage'))), text('customProviderMessage'))

    connRow('Рабочая')?.querySelector('.conn-more')?.click()
    await wait(250)
    const menuItems = [...(connRow('Рабочая')?.querySelectorAll('.conn-menu-item') || [])]
      .map(one => one.textContent.trim())
    note('меню строки раскрывается и держит три пункта',
      menuItems.join(', ') === 'Изменить, Проверить, Удалить', menuItems.join(', '))
    note('раскрытое меню видно, а не спрятано под строкой',
      connRow('Рабочая')?.querySelector('.conn-menu')?.hidden === false)
    await connClick('Рабочая')
    note('нажатие на строку «Рабочая» переключило ход',
      await until(() => /Ход идёт на «Рабочая»/.test(text('customProviderMessage'))), text('customProviderMessage'))
    note('подсказка пути называет «Рабочая» и её адрес',
      /Рабочая/.test(text('providerPathNote')) && text('providerPathNote').includes('/b/v1'), text('providerPathNote'))
    note('поле адрес показалось адресом выбранного подключения',
      byId('customBaseUrlInput').value.includes('/b/v1'), byId('customBaseUrlInput').value)
  `)

  // -------------------------------------------------------------------------
  // B. Ход идёт на выбранное («Рабочая») подключение
  // -------------------------------------------------------------------------
  await launch('turn-b', `
    byId('newChatBtn')?.click()
    await wait(900)
    note('шапка называет модель выбранного подключения',
      await until(() => /${MODEL_B}/.test(text('pillModelName')), 20000), text('pillModelName'))
    const box = byId('composerTextarea')
    box.value = 'Повтори одно слово: Б'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    byId('composerForm')?.requestSubmit()
    note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 25000))
    note('ответ пришёл от «Рабочая»', await until(() => /${ANSWER_B}/.test(feed()), 60000), feed().slice(-200))
    note('хода от «Домашняя» нет', !/${ANSWER_A}/.test(feed()))
    note('ход дошёл до конца', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  `, { ONECODE_E2E: '1' })

  // -------------------------------------------------------------------------
  // C. Выбор другого подключения мышкой меняет отвечающий эндпоинт
  // -------------------------------------------------------------------------
  await launch('turn-a', `
    await openKeys()
    await choosePath('openai-compatible')
    note('строка «Домашняя» переключила ход', await connClick('Домашняя'), 'строка найдена')
    await until(() => /Ход идёт на «Домашняя»/.test(text('customProviderMessage')), 20000)
    note('выбор «Домашняя» переключил ход',
      /Ход идёт на «Домашняя»/.test(text('customProviderMessage')), text('customProviderMessage'))
    document.querySelector('#settingsModal [data-close=\\"settingsModal\\"]')?.click()
    await wait(500)
    byId('newChatBtn')?.click()
    await wait(900)
    note('шапка переставлена на модель «Домашняя»',
      await until(() => /${MODEL_A}/.test(text('pillModelName')), 20000), text('pillModelName'))
    const box = byId('composerTextarea')
    box.value = 'Повтори одно слово: А'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    byId('composerForm')?.requestSubmit()
    note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 25000))
    note('ответ пришёл от «Домашняя»', await until(() => /${ANSWER_A}/.test(feed()), 60000), feed().slice(-200))
    note('ход дошёл до конца', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  `, { ONECODE_E2E: '1' })

  // -------------------------------------------------------------------------
  // D. Что легло на диск и куда ходили запросы
  // -------------------------------------------------------------------------
  {
    const settings = readJson(path.join(profile, '1code-settings.json')) || {}
    const list = Array.isArray(settings.customProviders) ? settings.customProviders : []
    line('D профиль на диске', 'в настройках два подключения', list.length === 2,
      JSON.stringify(list.map(item => item.name)))
    const a = list.find(item => item.name === 'Домашняя')
    const b = list.find(item => item.name === 'Рабочая')
    line('D профиль на диске', 'адрес и модель у каждого свои',
      /\/a\/v1$/.test(a?.baseUrl || '') && a?.model === MODEL_A &&
      /\/b\/v1$/.test(b?.baseUrl || '') && b?.model === MODEL_B,
      JSON.stringify(list.map(item => [item.baseUrl, item.model])))
    line('D профиль на диске', 'ключи зашифрованы и не совпадают',
      Boolean(a?.keyEncrypted && b?.keyEncrypted) && a.keyEncrypted !== b.keyEncrypted &&
      a.keyEnc === 'safeStorage' && b.keyEnc === 'safeStorage')
    line('D профиль на диске', 'открытого ключа нет ни в настройках, ни в журналах',
      !JSON.stringify(settings).includes(KEY_A) && !JSON.stringify(settings).includes(KEY_B) &&
      !(fs.existsSync(path.join(profile, 'logs'))
        ? fs.readdirSync(path.join(profile, 'logs')).map(name => {
            try { return fs.readFileSync(path.join(profile, 'logs', name), 'utf8') } catch { return '' }
          }).join('\n') : '').includes(KEY_A))
    const caches = settings.customModelCaches || {}
    line('D профиль на диске', 'каталог моделей у каждого свой',
      (caches[a?.id]?.models || []).some(item => item.id === MODEL_A) &&
      (caches[b?.id]?.models || []).some(item => item.id === MODEL_B) &&
      !(caches[a?.id]?.models || []).some(item => item.id === MODEL_B),
      JSON.stringify(Object.keys(caches)))
    line('D профиль на диске', 'имена ключей настроек без точки',
      !Object.keys(settings).some(key => key.includes('.')), Object.keys(settings).join(', '))
    const completions = hits.filter(hit => hit.url.endsWith('/chat/completions'))
    const toA = completions.filter(hit => hit.side === 'a')
    const toB = completions.filter(hit => hit.side === 'b')
    observe(`обращений в ход: А — ${toA.length}, Б — ${toB.length}`)
    line('D профиль на диске', 'оба подключения доехали до своих адресов',
      toA.length > 0 && toB.length > 0)
    line('D профиль на диске', 'каждый ход шёл своим ключом',
      toA.every(hit => hit.headers.authorization === 'Bearer ' + KEY_A) &&
      toB.every(hit => hit.headers.authorization === 'Bearer ' + KEY_B))
    line('D профиль на диске', 'чужим заголовкам и полям хода не было',
      completions.every(hit => !hit.headers['http-referer'] && hit.body?.models === undefined))
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
  try { stub.close() } catch {}
  settleRun(output, false)
  process.exit(2)
})
