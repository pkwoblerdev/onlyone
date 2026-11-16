// Каталог провайдеров живым окном (план, каталог 25.09).
//
// Главный процесс меряют `test-provider-catalog.cjs` и
// `test-provider-anthropic-stub.cjs`. Здесь то, что видит человек: список
// путей, отказ переключаться на ненстроенный путь, адрес по умолчанию,
// сохранение модели и ключа, проверка соединения и НАСТОЯЩИЙ ход через
// нативный диалект Anthropic — ответ в ленте приходит от локальной заглушки,
// которая говорит `/v1/messages` и `content_block_delta`, а не OpenAI-видом.
// Настоящих ключей, внешней сети и платных вызовов нет: всё на 127.0.0.1.
// Красный прогон оставляет профиль и кадры.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-provider-catalog')
const profile = path.join(output, 'profile')
fs.mkdirSync(profile, { recursive: true })
const shots = path.join(root, 'audits', 'qoder-1-2026-09-25', 'provider-catalog-ui')
fs.mkdirSync(shots, { recursive: true })

const KEY_ANTHROPIC = 'sk-ant-TEST-catalog-a1b2c3'
const KEY_OPENAI = 'sk-TEST-catalog-openai-9f3c'
const MODEL_ANTHROPIC = 'модель-окна-anthropic'
const MODEL_OLLAMA = 'модель-окна-ollama'
const ANSWER_ANTHROPIC = 'ОТВЕТ-ANTHROPIC-ЗАГЛУШКИ'
const ANSWER_OLLAMA = 'ОТВЕТ-OLLAMA-ЗАГЛУШКИ'

const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// ---------------------------------------------------------------------------
// Заглушка: три пути на одном сервере, каждый своим диалектом
// ---------------------------------------------------------------------------
const hits = []
function anthropicStream() {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_win', type: 'message', role: 'assistant',
      model: MODEL_ANTHROPIC, content: [], usage: { input_tokens: 7, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: ANSWER_ANTHROPIC + ' ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: '— ответ локальной заглушки' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function openAiStream(text) {
  const frames = [
    { choices: [{ delta: { content: text + ' ' } }] },
    { choices: [{ delta: { content: '— ответ локальной заглушки' }, finish_reason: 'stop' }] }
  ]
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    const url = req.url || ''
    const side = /^\/anthropic\//.test(url) ? 'anthropic' : /^\/ollama\//.test(url) ? 'ollama'
      : /^\/openai\//.test(url) ? 'openai' : null
    hits.push({ url, side, headers: req.headers, body })
    const send = (status, type, payload) => {
      res.writeHead(status, { 'Content-Type': type })
      res.end(payload)
    }
    if (!side) { send(404, 'application/json', '{}'); return }
    if (side === 'anthropic') {
      // Нативная форма: ключ в `x-api-key`, версия обязательна, список — /v1/models.
      if (req.headers['x-api-key'] !== KEY_ANTHROPIC || req.headers['anthropic-version'] !== '2023-06-01') {
        send(401, 'application/json', JSON.stringify({ type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      if (url.endsWith('/v1/models')) {
        send(200, 'application/json', JSON.stringify({ data: [
          { type: 'model', id: MODEL_ANTHROPIC, display_name: 'Модель окна Anthropic' }] }))
        return
      }
      if (url.endsWith('/v1/messages')) {
        if (body && body.stream) send(200, 'text/event-stream', anthropicStream())
        else send(200, 'application/json', JSON.stringify({ id: 'msg_win', type: 'message', role: 'assistant',
          model: MODEL_ANTHROPIC, content: [{ type: 'text', text: ANSWER_ANTHROPIC }],
          stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 9 } }))
        return
      }
      send(404, 'application/json', JSON.stringify({ type: 'error',
        error: { type: 'not_found_error', message: 'не:path' } }))
      return
    }
    // openai-диалект: ollama игнорирует ключ, openai — требует.
    if (side === 'openai' && req.headers.authorization !== `Bearer ${KEY_OPENAI}`) {
      send(401, 'application/json', JSON.stringify({ error: { message: 'ключ не подошёл' } }))
      return
    }
    if (url.endsWith('/models') || url.endsWith('/v1/models')) {
      send(200, 'application/json', JSON.stringify({ data: [
        { id: MODEL_OLLAMA, name: MODEL_OLLAMA }, { id: 'соседняя-модель' }] }))
      return
    }
    const answer = openAiStream(side === 'ollama' ? ANSWER_OLLAMA : 'ОТВЕТ-OPENAI')
    // Ollama is a local stub and can answer before the renderer's 120 ms
    // polling interval observes the transient stop button. Keep this one
    // response open briefly so the UI assertion tests the running state,
    // rather than racing an unrealistically instant fixture.
    if (side === 'ollama') setTimeout(() => send(200, 'text/event-stream', answer), 600)
    else send(200, 'text/event-stream', answer)
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
      node.focus?.()
      node.value = value
      node.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    const chooseProvider = async id => {
      const select = byId('providerSelect')
      select.value = id
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(700)
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(1500)
    const openKeys = async () => {
      byId('openSettingsBtn')?.click()
      await wait(600)
      byId('tab-keys')?.click()
      await wait(500)
    }
    const closeSettings = async () => {
      document.querySelector('#settingsModal [data-close="settingsModal"]')?.click()
      await wait(500)
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
  // A. Каталог на экране: выбор пути, отказ переключаться, адрес по умолчанию
  // -------------------------------------------------------------------------
  await launch('catalog-picker', `
    await openKeys()
    const select = byId('providerSelect')
    const ids = [...(select?.options || [])].map(item => item.value)
    // 07.10.2026 к семи прежним путям добавлены агрегаторы и хостинги и LM Studio: всего 21, и они разложены по группам.
    note('список провайдеров — все пути реестра',
      ['openrouter', 'openai', 'anthropic', 'gemini', 'ollama', 'openai-compatible', 'together', 'groq', 'huggingface', 'vercel-ai-gateway', 'lmstudio']
        .every(id => ids.includes(id)) && ids.length === 21, ids.join(' | '))
    const groupLabels = [...(select?.querySelectorAll('optgroup') || [])].map(group => group.label)
    note('пути разложены по группам: агрегаторы, разработчики, на этом компьютере, свой адрес',
      groupLabels.join('|') === 'Агрегаторы и хостинги|Разработчики моделей|На этом компьютере|Свой адрес', groupLabels.join('|'))
    note('OpenRouter — первый в списке, а группа агрегаторов содержит Together и Groq',
      ids[0] === 'openrouter' && select.querySelector('optgroup')?.querySelector('option[value=together]') !== null &&
      select.querySelector('optgroup')?.querySelector('option[value=groq]') !== null)
    const labels = Object.fromEntries([...(select?.options || [])].map(item => [item.value, item.textContent]))
    note('названия путей приходят из реестра, а не из разметки окна',
      labels.anthropic === 'Anthropic' && labels.gemini === 'Google Gemini' &&
      /OpenAI-совместимый/.test(labels['openai-compatible'] || ''),
      JSON.stringify(labels))
    // Раскладка 2.8б: на OpenRouter остаётся только пул ключей, а свои
    // подключения не показываются вовсе — прежняя строка выбора с пометкой
    // «не используются» ушла вместе с ней.
    note('на OpenRouter виден один пул ключей, а не поля своего пути',
      byId('openrouterKeysGroup')?.hidden !== true &&
      byId('providerFieldsGroup')?.hidden === true &&
      byId('customConnectionsGroup')?.hidden === true &&
      /OpenRouter/.test(text('providerPathNote')), text('providerPathNote'))
    note('свои подключения открываются выбором своего пути в списке',
      [...(byId('providerSelect')?.options || [])].some(item => item.value === 'openai-compatible'))

    await chooseProvider('anthropic')
    note('у пути из каталога нет ни списка подключений, ни имени, ни кнопки удаления',
      byId('customConnectionsGroup')?.hidden === true &&
      byId('customProviderNameRow')?.hidden === true &&
      !byId('btnDeleteCustomProvider') &&
      byId('providerFieldsGroup')?.hidden !== true)

    await chooseProvider('anthropic')
    note('ненстроенный путь не переключается: отказ назван',
      /не настроен|не хватает/.test(text('customProviderMessage')), text('customProviderMessage'))
    note('отказ говорит про модель, а не про адрес: адрес по умолчанию уже в поле',
      byId('customBaseUrlInput').value === 'https://api.anthropic.com/v1' &&
      /модель/.test(text('customProviderMessage')),
      byId('customBaseUrlInput').value + ' | ' + text('customProviderMessage'))
    note('поле ключа называет провайдера',
      /Anthropic/.test(byId('customKeyInput').placeholder || ''), byId('customKeyInput').placeholder)
    note('подсказка пути называет «Anthropic»', /Anthropic/.test(text('providerPathNote')), text('providerPathNote'))
    note('ограничения показаны для того пути, что на экране, а не для активного',
      text('customProviderUnsupported').includes('/v1/messages'), text('customProviderUnsupported'))

    await fill('customBaseUrlInput', 'ftp://127.0.0.1:21/v1')
    await fill('customModelInput', 'модель-для-отказа')
    byId('btnCheckCustomProvider')?.click()
    note('адрес, которому адаптер не доверит запрос, не сохраняется',
      await until(() => /протокол/.test(text('customProviderMessage')), 20000), text('customProviderMessage'))
    note('отказ на неверном адресе не затирает набранное',
      byId('customBaseUrlInput').value === 'ftp://127.0.0.1:21/v1', byId('customBaseUrlInput').value)

    await chooseProvider('ollama')
    note('у Ollama ключ не обязателен — это сказано в состоянии ключа',
      /не нужен/.test(text('customProviderKeyState')), text('customProviderKeyState'))
    note('адрес Ollama — локальный порт по умолчанию',
      byId('customBaseUrlInput').value === 'http://127.0.0.1:11434/v1', byId('customBaseUrlInput').value)
    note('правка Anthropic не переехала на Ollama',
      byId('customModelInput').value === '', byId('customModelInput').value)
    // Кадр снимается в конце прогона: пусть на нём будет открытая панель с
    // учётной записью провайдера, а не приветственный экран.
    await chooseProvider('anthropic')
    await fill('customBaseUrlInput', '')
    note('пустой адрес возвращает подсказку с адресом по умолчанию каталога',
      byId('customBaseUrlInput').placeholder === 'https://api.anthropic.com/v1',
      byId('customBaseUrlInput').placeholder)
  `)
  // -------------------------------------------------------------------------
  // B. Настройка двух путей, проверка соединения, ход нативным диалектом
  // -------------------------------------------------------------------------
  await launch('anthropic-turn', `
    await openKeys()
    await chooseProvider('anthropic')
    await fill('customBaseUrlInput', '${urlFor('anthropic')}')
    await fill('customModelInput', '${MODEL_ANTHROPIC}')
    await fill('customKeyInput', '${KEY_ANTHROPIC}')
    byId('btnSaveCustomProvider')?.click()
    note('учётная запись провайдера сохранена',
      await until(() => /Сохранено/.test(text('customProviderMessage')), 20000), text('customProviderMessage'))
    note('ключ очищен сразу после сохранения', byId('customKeyInput').value === '')
    note('о ключе сказано состоянием, а не символами',
      /Ключ защищён системой Windows/.test(text('customProviderKeyState')) &&
      !text('customProviderKeyState').includes('${KEY_ANTHROPIC.slice(-4)}'), text('customProviderKeyState'))
    byId('btnCheckCustomProvider')?.click()
    note('проверка соединения прошла и назвала модель из каталога Anthropic',
      await until(() => /Эндпоинт отвечает, моделей в каталоге: 1/.test(text('customProviderMessage')), 30000),
      text('customProviderMessage'))
    note('подсказка модели показывает список самого сервера',
      [...(byId('customModelList')?.children || [])].some(item => item.value === '${MODEL_ANTHROPIC}'),
      [...(byId('customModelList')?.children || [])].map(item => item.value).join(','))
    await chooseProvider('anthropic')
    note('настроенный путь переключается',
      await until(() => /Ход идёт на «Anthropic»/.test(text('providerPathNote')), 20000), text('providerPathNote'))
    await closeSettings()

    byId('newChatBtn')?.click()
    await wait(900)
    note('шапка называет модель Anthropic, а не модель OpenRouter',
      await until(() => /модель-окна-anthropic|Модель окна Anthropic/.test(text('pillModelName')), 20000),
      text('pillModelName'))
    note('модель OpenRouter в шапке не осталась',
      !/dots-3|Dots3/i.test(text('pillModelName')), text('pillModelName'))
    const box = byId('composerTextarea')
    box.value = 'Повтори одно слово: АНТРА'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    byId('composerForm')?.requestSubmit()
    note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 25000))
    note('ответ пришёл из нативного потока Anthropic',
      await until(() => /${ANSWER_ANTHROPIC}/.test(feed()), 60000), feed().slice(-200))
    note('хода до конца не было обрыва', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  `, { ONECODE_E2E: '1' })

  // -------------------------------------------------------------------------
  // C. Ollama без ключа — своим ходом и без Authorization
  // -------------------------------------------------------------------------
  await launch('ollama-turn', `
    await openKeys()
    await chooseProvider('ollama')
    await fill('customBaseUrlInput', '${urlFor('ollama')}')
    await fill('customModelInput', '${MODEL_OLLAMA}')
    byId('btnSaveCustomProvider')?.click()
    note('Ollama сохраняется без ключа',
      await until(() => /Сохранено/.test(text('customProviderMessage')), 20000), text('customProviderMessage'))
    await chooseProvider('ollama')
    note('путь переключён без требования ключа',
      await until(() => /Ход идёт на «Ollama»/.test(text('providerPathNote')), 20000), text('providerPathNote'))
    await closeSettings()
    byId('newChatBtn')?.click()
    await wait(900)
    note('шапка переставлена на модель Ollama',
      await until(() => /${MODEL_OLLAMA}/.test(text('pillModelName')), 20000), text('pillModelName'))
    const box = byId('composerTextarea')
    box.value = 'Повтори одно слово: ОЛЛ'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    byId('composerForm')?.requestSubmit()
    note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 25000))
    note('ответ пришёл от Ollama', await until(() => /${ANSWER_OLLAMA}/.test(feed()), 60000), feed().slice(-200))
    note('ответа Anthropic в этом ходе не было', !/${ANSWER_ANTHROPIC}/.test(feed()))
    note('хода до конца не было обрыва', await until(() => !document.querySelector('.btn-send.is-stop'), 60000))
  `, { ONECODE_E2E: '1' })

  // -------------------------------------------------------------------------
  // D. Повторный запуск окна: учётные записи на месте, открытого ключа нет
  // -------------------------------------------------------------------------
  await launch('reopen', `
    await openKeys()
    const select = byId('providerSelect')
    note('путь переключился сам и не сбросился на OpenRouter', select.value === 'ollama', select.value)
    await chooseProvider('anthropic')
    note('адрес и модель Anthropic пережили перезапуск',
      byId('customBaseUrlInput').value === '${urlFor('anthropic')}' &&
      byId('customModelInput').value === '${MODEL_ANTHROPIC}',
      byId('customBaseUrlInput').value + ' / ' + byId('customModelInput').value)
    note('ключ не перенесён в поля: показано состояние, а не символы',
      byId('customKeyInput').value === '' &&
      /Ключ защищён системой Windows/.test(text('customProviderKeyState')),
      text('customProviderKeyState'))
    note('ни в одном узле окна нет ни ключа, ни его хвоста',
      !['${KEY_ANTHROPIC}', '${KEY_OPENAI}', '${KEY_ANTHROPIC.slice(-4)}', '${KEY_OPENAI.slice(-4)}']
        .some(one => document.documentElement.innerHTML.includes(one)))
    // Кадр в конце прогона должен показывать панель, а не приветственный экран;
    // и действующий путь остаётся Ollama — его сверяет проверка E ниже.
    await chooseProvider('anthropic')
    note('после перезапуска показана учётка Anthropic: адрес, модель и состояние ключа',
      byId('customBaseUrlInput').value === '${urlFor('anthropic')}' &&
      byId('customModelInput').value === '${MODEL_ANTHROPIC}' &&
      /Ключ защищён системой Windows/.test(text('customProviderKeyState')) &&
      !document.documentElement.innerHTML.includes('${KEY_ANTHROPIC.slice(-4)}'),
      byId('customBaseUrlInput').value + ' | ' + text('customProviderKeyState'))
    await chooseProvider('ollama')
    note('переключение обратно на Ollama принято',
      await until(() => /Ход идёт на «Ollama»/.test(text('providerPathNote')), 20000), text('providerPathNote'))
  `)

  // -------------------------------------------------------------------------
  // E. Что легло на диск и куда ходили запросы
  // -------------------------------------------------------------------------
  {
    const settings = readJson(path.join(profile, '1code-settings.json')) || {}
    const list = Array.isArray(settings.customProviders) ? settings.customProviders : []
    const anthropic = list.find(item => item.provider === 'anthropic')
    const ollama = list.find(item => item.provider === 'ollama')
    line('E диск', 'учётные записи именованных путей лежат в общем списке',
      Boolean(anthropic && ollama), JSON.stringify(list.map(item => [item.id, item.provider])))
    line('E диск', 'id учётных записей — acc-<путь>',
      anthropic?.id === 'acc-anthropic' && ollama?.id === 'acc-ollama',
      JSON.stringify([anthropic?.id, ollama?.id]))
    line('E диск', 'отказ на адресе с чужим протоколом не записался в настройки',
      !JSON.stringify(settings).includes('ftp://'))
    line('E диск', 'ключи упакованы safeStorage и не совпадают с открытым значением',
      anthropic?.keyEnc === 'safeStorage' && Boolean(anthropic?.keyEncrypted) &&
      !JSON.stringify(settings).includes(KEY_ANTHROPIC) && !JSON.stringify(settings).includes(KEY_OPENAI))
    line('E диск', 'у Ollama ключа нет, и путь считается настроенным',
      !ollama?.keyEncrypted && ollama?.model === MODEL_OLLAMA, ollama?.model || '')
    line('E диск', 'активный путь — ollama, а не подмена на OpenRouter',
      settings.activeProvider === 'ollama', String(settings.activeProvider))
    const caches = settings.customModelCaches || {}
    line('E диск', 'каталог моделей у каждого пути свой',
      (caches['acc-anthropic']?.models || []).some(item => item.id === MODEL_ANTHROPIC) &&
      !(caches['acc-anthropic']?.models || []).some(item => item.id === MODEL_OLLAMA) &&
      (caches['acc-ollama']?.models || []).some(item => item.id === MODEL_OLLAMA),
      JSON.stringify(Object.keys(caches)))
    line('E диск', 'имена ключей настроек без точки',
      !Object.keys(settings).some(key => key.includes('.')), Object.keys(settings).join(', '))
    const messages = hits.filter(hit => hit.side === 'anthropic' && hit.url.endsWith('/v1/messages'))
    const completions = hits.filter(hit => hit.side === 'ollama' && hit.url.endsWith('/chat/completions'))
    observe(`обращений: Anthropic /v1/messages — ${messages.length}, Ollama /chat/completions — ${completions.length}`)
    line('E диск', 'Anthropic ловил нативный вызов с своим ключом и версией',
      messages.length > 0 && messages.every(hit => hit.headers['x-api-key'] === KEY_ANTHROPIC &&
        hit.headers['anthropic-version'] === '2023-06-01'),
      JSON.stringify(messages[0]?.headers || {}).slice(0, 200))
    line('E диск', 'на Anthropic не ушли openai-only поля и чужие заголовки',
      messages.every(hit => hit.body?.models === undefined && hit.body?.plugins === undefined &&
        !hit.headers.authorization && !hit.headers['http-referer'] && !hit.headers['x-title']),
      JSON.stringify(messages[0]?.body || {}).slice(0, 200))
    line('E диск', 'Anthropic получил переписку в своей форме (system отдельно, роли чередуются)',
      messages.every(hit => typeof hit.body?.system === 'string' && Array.isArray(hit.body?.messages) &&
        hit.body.messages.length > 0 &&
        hit.body.messages.every((m, index, all) => index === 0 || m.role !== all[index - 1].role)))
    line('E диск', 'поток был запрошен по-настоящему',
      messages.some(hit => hit.body?.stream === true))
    line('E диск', 'Ollama ходил без Authorization',
      completions.length > 0 && completions.every(hit => !hit.headers.authorization),
      JSON.stringify(completions[0]?.headers || {}).slice(0, 200))
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
  for (const text of observations) console.log('# ' + text)
  console.log(`\nпроверок: ${report.length}, провалов: ${failed}`)
  await new Promise(resolve => stub.close(resolve))
  settleRun(output, failed === 0)
  process.exit(failed ? 1 : 0)
})().catch(error => {
  console.error('ПРОВАЛ прогона:', error)
  try { stub.close() } catch { /* уже закрыт */ }
  settleRun(output, false)
  process.exit(1)
})
