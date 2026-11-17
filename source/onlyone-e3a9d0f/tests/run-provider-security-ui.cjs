// Маска ключа и заголовок панели — живым окном (блок «безопасность и понятность
// подключения», 25.09.2026).
//
// Юнит-наборы меряют главный процесс. Здесь смотрим то, что видит человек: как
// называется вкладка и шапка модалки, что написано о ключе вместо его хвоста,
// и есть ли где-нибудь в окне четыре символа из ключа — в разметке, в подсказке
// и в диалоге. Английский экран проверяется отдельно: прежний атрибут
// data-settings-title словарём не переводился, и шапка оставалась русской; там
// же меряются диалог удаления ключа и переименование прежнего автоимени пула.
// Модель — локальная заглушка, ключи — выдуманные.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-provider-security')
const profile = path.join(output, 'profile')
fs.mkdirSync(profile, { recursive: true })
const shots = path.join(root, 'audits', 'qoder-2-2026-09-25', 'provider-security-ui')
fs.mkdirSync(shots, { recursive: true })

const KEY = 'sk-EXAMPLE93ad09d94302c4c28f24c14a'
const MODEL = 'модель-окона-безопасность'
const ANSWER = 'ОТВЕТ-ЗАГЛУШКИ-БЕЗОПАСНОСТЬ'

const report = []
const observations = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const observe = text => observations.push(String(text))
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: MODEL, name: MODEL }] }))
      return
    }
    const frames = [
      { choices: [{ delta: { content: ANSWER + ' ' } }] },
      { choices: [{ delta: { content: '— ответ локальной заглушки' }, finish_reason: 'stop' }] }
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n')
  })
})
const ready = new Promise(resolve => stub.listen(0, '127.0.0.1', resolve()))
const stubUrl = () => 'http://127.0.0.1:' + stub.address().port + '/v1'

// Фрагменты ключа, которые нельзя показывать человеку: весь ключ, начало,
// хвост, середина. Прежняя маска выдавала ровно четыре последних символа.
// LEGACY_TAIL — хвост из прежнего автоимени пула: он обязан исчезнуть с диска
// и изо окна после перечитывания списка.
const LEGACY_TAIL = 'Zq9W'
const FRAGMENTS = [KEY, KEY.slice(0, 4), KEY.slice(-4), KEY.slice(-6), KEY.slice(8, 16), LEGACY_TAIL]

const PRELUDE = () => `
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const byId = id => document.getElementById(id)
    const text = id => (byId(id)?.textContent || '').replace(/\\s+/g, ' ').trim()
    const until = async (fn, ms = 30000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { let value = false; try { value = fn() } catch {}; if (value) return true; await wait(150) }
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
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const pageText = () => document.documentElement.innerText || ''
    const pageHtml = () => document.documentElement.innerHTML || ''
    const fragmentsSeen = () => ${JSON.stringify(FRAGMENTS)}.filter(one => pageHtml().includes(one))
    const openKeys = async () => {
      byId('openSettingsBtn')?.click()
      await wait(700)
      byId('tab-keys')?.click()
      await wait(500)
    }
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(1500)
`

function launch(name, scriptBody, extraEnv = {}) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  const shot = path.join(shots, name + '.png')
  fs.writeFileSync(script, '(async () => {' + PRELUDE() + scriptBody +
    '\n      return { ok: checks.every(item => item.pass), checks } })()')
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, stdio: 'inherit',
        env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: shot, ...extraEnv }) })
    const timer = setTimeout(() => {
      observe(name + ': окно не вернулось за 300 с — снимаю дерево ' + child.pid)
      commandRunner.killTree(child.pid, () => {})
    }, 300000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      const verdict = readJson(out)
      const list = verdict?.checks || []
      if (!list.length) list.push({ name: 'окно вернулось без единой проверки', pass: false,
        detail: (verdict?.error || 'код выхода ' + code) })
      for (const check of list) line(name, check.name, check.pass, check.detail)
      line(name, 'кадр сохранён', fs.existsSync(shot) && fs.statSync(shot).size > 10000, shot)
      resolve(verdict)
    })
  })
}

(async () => {
  await ready

  // A. Панель: имя вкладки, шапка модалки, состояние ключа вместо хвоста
  await launch('panel', `
    await openKeys()
    const tab = byId('tab-keys')
    note('вкладка называется по содержимому, а не «Ключи OpenRouter»',
      /Провайдеры/.test(tab.textContent), tab.textContent.trim())
    note('шапка модалки повторяет вкладку',
      text('settingsTitle') === tab.textContent.trim(), text('settingsTitle'))
    // «Ключи OpenRouter» остаётся там, где это правда: подпись группы пула
    // ключей OpenRouter. Врёт только имя вкладки и шапки — их и сверяем.
    note('имя «Ключи OpenRouter» осталось ровно один раз — на группе пула',
      (document.querySelector('#panel-keys')?.innerText.match(/Ключи OpenRouter/g) || []).length === 1,
      String((document.querySelector('#panel-keys')?.innerText.match(/Ключи OpenRouter/g) || []).length))
    note('группа пула ключей OpenRouter осталась названа своим именем',
      /Ключи OpenRouter/.test(document.querySelector('#keysPoolList')?.parentElement?.innerText || ''),
      'подпись группы потерялась — её переименовывать было нельзя')

    await fill('customProviderNameInput', 'Безопасная')
    await fill('customBaseUrlInput', '${stubUrl()}')
    await fill('customModelInput', '${MODEL}')
    await fill('customKeyInput', '${KEY}')
    byId('btnSaveCustomProvider')?.click()
    note('подключение сохранено', await until(() => /Сохранено/.test(text('customProviderMessage'))),
      text('customProviderMessage'))
    note('поле ключа очищено сразу после сохранения', byId('customKeyInput').value === '')
    const state = text('customProviderKeyState')
    note('о ключе сказано состоянием, а не символами', /Ключ защищён системой Windows/.test(state), state)
    note('ни одного фрагмента ключа в окне — разметка, подсказки, диалоги',
      fragmentsSeen().length === 0, 'найдено: ' + fragmentsSeen().join(', '))
    const select = byId('providerSelect')
    select.value = 'openai-compatible'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    note('ход переключён на своё подключение',
      await until(() => /Ход идёт на подключение «Безопасная»/.test(text('customProviderMessage')),
        20000), text('customProviderMessage'))
    await wait(1500)
  `)

  // B. Английский экран: шапка модалки обязана переводиться
  //
  // Перед запуском в профиль подкладывается ключ с прежним автоименем
  // «Ключ (…Zq9W)»: так окном меряется и миграция имён (без неё четыре символа
  // секрета лежали рядом с зашифрованным блобом), и диалог удаления на
  // английском экране. Конверт здесь заведомо нечитаемый — имена окно читает и
  // без расшифровки, живые ключи и сеть тест не трогают.
  {
    const file = path.join(profile, '1code-settings.json')
    const settings = readJson(file) || {}
    settings.openrouterKeys = [
      { id: 'key_legacy', name: 'Ключ (…' + LEGACY_TAIL + ')',
        keyEncrypted: 'Q0lQSEVSLU5PLQ', enabled: true, createdAt: 1 }
    ]
    fs.writeFileSync(file, JSON.stringify(settings, null, 2))
  }
  await launch('english', `
    // Язык переключается тем же путём, которым его переключает окно: словарь
    // применяется на месте, без перезагрузки.
    await window.__setLanguage('en')
    await wait(700)
    byId('openSettingsBtn')?.click()
    await wait(900)
    byId('tab-keys')?.click()
    await wait(600)
    const tab = byId('tab-keys')
    note('вкладка переведена', /Providers/i.test(tab.textContent), tab.textContent.trim())
    note('шапка модалки переведена, а не осталась русской',
      /Providers/i.test(text('settingsTitle')), text('settingsTitle'))
    const panel = document.querySelector('#panel-keys')?.textContent || ''
    note('о состоянии ключа окно говорит на языке экрана',
      /protected by Windows/i.test(panel), panel.slice(0, 260))

    // Пул ключей OpenRouter: прежнее автоимя с хвостом и диалог удаления.
    // С 2.8б пул показан только на своём пути (раньше висел всегда), поэтому
    // путь сначала выбирается, как это делает человек.
    const pathSelect = byId('providerSelect')
    pathSelect.value = 'openrouter'
    pathSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => /OpenRouter/.test(text('providerPathNote')), 12000)
    await wait(400)
    const poolRow = document.querySelector('#keysPoolList .key-row')
    note('прежнее автоимя пула переименовано самим окном',
      Boolean(poolRow) && /Ключ 1/.test(poolRow.innerText),
      poolRow ? poolRow.innerText.replace(/\\s+/g, ' ').trim() : 'строки пула в окне нет')
    poolRow?.querySelector('.key-delete-btn')?.click()
    note('диалог удаления ключа переведён, а не остался русским',
      await until(() => /Delete key/i.test(text('confirmMessage')), 8000), text('confirmMessage'))
    byId('confirmCancelBtn')?.click()
    await wait(500)
    note('отмена не удалила ключ из пула',
      Boolean(document.querySelector('#keysPoolList .key-row')))
    // Имя и состояние ключа — два куска в одной строке; до правки стиля они
    // слипались в «Ключ 1ошибка», и на кадре это видно глазами. Строку берём
    // ЗАНОВО: пул перерисовывается своим обновлением, и снятая до диалога
    // ссылка указывала бы на выброшенный узел с нулевыми координатами.
    const liveRow = document.querySelector('#keysPoolList .key-row')
    const nameBox = liveRow?.querySelector('.key-name')?.getBoundingClientRect()
    const endBox = liveRow?.querySelector('.key-ending')?.getBoundingClientRect()
    note('имя и состояние ключа разделены, а не слиплись',
      Boolean(nameBox && endBox) && nameBox.right + 2 <= endBox.left,
      'имя: ' + (nameBox ? Math.round(nameBox.right) : 'нет') +
      ', состояние: ' + (endBox ? Math.round(endBox.left) : 'нет'))
    note('ни одного фрагмента ключа и на английском экране', fragmentsSeen().length === 0,
      'найдено: ' + fragmentsSeen().join(', '))
    // Кадр снимается после скрипта, поэтому строку пула подводим в поле
    // зрения: на нём видно переименованное автоимя, и это доказательство, а не
    // иллюстрация.
    document.querySelector('#keysPoolList .key-row')?.scrollIntoView({ block: 'center' })
    await wait(1500)
    // Путь возвращается на эндпоинт: следующий прогон меряет ход на заглушку и
    // ждёт, что действующим останется свой путь, а не OpenRouter.
    pathSelect.value = 'openai-compatible'
    pathSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => /Ход идёт на|Runs go to/.test(text('providerPathNote')), 12000)
    await wait(600)
  `)


  // C. Ход идёт на заглушку, и в ленте ключа нет
  await launch('turn', `
    const pill = text('pillModelName')
    note('шапка называет модель эндпоинта, а не OpenRouter',
      await until(() => new RegExp('${MODEL}').test(text('pillModelName')), 30000), pill)
    byId('newChatBtn')?.click()
    await wait(900)
    const box = byId('composerTextarea')
    box.value = 'Повтори одно слово'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    byId('composerForm')?.requestSubmit()
    note('ход начался', await until(() => Boolean(document.querySelector('.btn-send.is-stop') || document.querySelector('#messagesList .msg-item.assistant')), 40000))
    note('ответ заглушки пришёл', await until(() => new RegExp('${ANSWER}').test(pageText()), 90000),
      pageText().slice(-200))
    note('хода не остался запущенным', await until(() => !document.querySelector('.btn-send.is-stop'), 90000))
    note('в ленте и в панели работы ключа нет', fragmentsSeen().length === 0,
      'найдено: ' + fragmentsSeen().join(', '))
    await wait(1200)
  `, { ONECODE_E2E: '1' })

  // D. Что легло на диск
  {
    const settings = readJson(path.join(profile, '1code-settings.json')) || {}
    const list = Array.isArray(settings.customProviders) ? settings.customProviders : []
    const dump = JSON.stringify(settings)
    line('D диск', 'подключение одно и оно названо человеком',
      list.length === 1 && list[0].name === 'Безопасная', JSON.stringify(list.map(item => item.name)))
    line('D диск', 'значение ключа не лежит в настройках открытым текстом',
      !dump.includes(KEY), 'ключ найден в 1code-settings.json')
    line('D диск', 'ни фрагментов ключа, ни его базы64 в настройках нет',
      !FRAGMENTS.some(one => dump.includes(one)) &&
      !dump.includes(Buffer.from(KEY, 'utf8').toString('base64')),
      FRAGMENTS.filter(one => dump.includes(one)).join(', '))
    line('D диск', 'конверт помечен способом упаковки',
      ['safeStorage', 'plain', 'unknown'].includes(list[0]?.keyEnc), String(list[0]?.keyEnc))
    const pool = Array.isArray(settings.openrouterKeys) ? settings.openrouterKeys : []
    line('D диск', 'прежнее автоимя пула переименовано на диске, хвоста нет',
      pool.length === 1 && pool[0].name === 'Ключ 1' && !dump.includes(LEGACY_TAIL),
      JSON.stringify(pool.map(item => item.name)))
    const logs = fs.existsSync(path.join(profile, 'logs'))
      ? fs.readdirSync(path.join(profile, 'logs')).map(name => {
          try { return fs.readFileSync(path.join(profile, 'logs', name), 'utf8') } catch { return '' }
        }).join('\n') : ''
    line('D диск', 'в журнале программы нет ни ключа, ни его фрагментов',
      !FRAGMENTS.some(one => logs.includes(one)),
      FRAGMENTS.filter(one => logs.includes(one)).join(', '))
    observe('размеров журнала: ' + (fs.existsSync(path.join(profile, 'logs'))
      ? fs.readdirSync(path.join(profile, 'logs')).length : 0))
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
  console.log('\nпроверок: ' + report.length + ', провалов: ' + failed)
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
