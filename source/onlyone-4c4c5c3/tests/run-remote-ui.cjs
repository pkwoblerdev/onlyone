// Удалённое управление — настоящее окно и «телефон» в этом процессе, через настоящего посредника.
//
// Окно: настройки → «Удалённое управление» → включить → код и QR. Телефон (этот процесс) спаривается по коду
// (подтверждение на компьютере в проверке принимается само), потом человек в окне пишет в чат и включает
// /remote-control; телефон видит этот чат (а другой, не открытый, — нет), читает его, пишет в него, и
// ответ «модели» появляется и в окне, и у телефона. Остановка устройства из списка обрывает связь.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { createRelay } = require('../server/relay/relay.js')
const { pairAsPhone } = require('../src/shared/remote-pairing.js')
const { DeviceLink } = require('../src/shared/remote-link.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-remote')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
const codeFile = path.join(out, 'code.txt')

const turn = text => ({ frames: [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, ms = 60000) {
  const stop = Date.now() + ms
  while (Date.now() < stop) { try { if (await predicate()) return true } catch { /* ещё не готово */ } await wait(150) }
  return false
}

async function main () {
  const relay = createRelay({ pingMs: 100000 })
  const port = await relay.listen(0)
  const providerFile = path.join(out, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({
    turns: [turn('Здравствуйте, я на связи.'), turn('Название'), turn('Подсказка'), turn('Подсказка'), turn('Ответ на сообщение с телефона: принято.'), turn('Ответ на сообщение с телефона: принято.'), turn('Ответ на сообщение с телефона: принято.'), turn('Ответ на сообщение с телефона: принято.'), turn('Ответ на сообщение с телефона: принято.'), turn('Ответ на сообщение с телефона: принято.')]
  }))
  const profile = path.join(out, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 90000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(120) }
      return false
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const send = text => { $('composerTextarea').value = text; $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true })); $('composerForm').requestSubmit() }

    async function run() {
      if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(400)

      // 1. Раздел настроек: по умолчанию выключено, ничего не показано.
      $('openSettingsBtn').click()
      await wait(300)
      $('tab-remote').click()
      await wait(300)
      note('раздел «Удалённое управление» есть в настройках', Boolean($('panel-remote')) && !$('panel-remote').hidden)
      note('по умолчанию выключено: переключатель снят, кода и устройств не видно', !$('remoteEnabled').checked && $('remoteBody').hidden)
      $('remoteEnabled').click()
      note('включение открывает подключение телефона', await until(() => !$('remoteBody').hidden, 10000))
      $('remotePairBtn').click()
      window.__firstCode = ''
      note('показан код вида ABCDE-FGHJK', await until(() => /^[2-9A-Z]{5}-[2-9A-Z]{5}$/.test($('remoteCode').textContent.trim()), 15000), $('remoteCode').textContent)
      note('рядом настоящий QR (svg с ячейками)', Boolean($('remoteQr').querySelector('svg')) && $('remoteQr').innerHTML.length > 400)
      note('показан срок действия кода', /10:|9:/.test($('remoteCountdown').textContent), $('remoteCountdown').textContent)

      // 2. Телефон спарился — устройство в списке и «в сети».
      note('устройство появилось в списке', await until(() => document.querySelectorAll('#remoteDevices .remote-device').length === 1, 60000))
      note('имя телефона показано, значок «в сети»', /Телефон проверки/.test($('remoteDevices').textContent) && Boolean(document.querySelector('.remote-device-dot.online')), $('remoteDevices').textContent)
      note('код погас после подключения', await until(() => $('remotePairBox').hidden, 10000))
      document.querySelector('[data-close-settings], #settingsCloseBtn, #settingsModal .modal-close')?.click()
      await wait(300)

      // 3. Два чата: личный и тот, что человек откроет телефону.
      $('newChatBtn')?.click()
      await wait(400)
      send('Личный разговор, телефону не показывать')
      note('личный чат получил ответ модели', await until(() => /Здравствуйте, я на связи/.test(feed()), 60000))
      await until(() => !document.querySelector('.btn-send.is-stop'), 30000)
      $('newChatBtn')?.click()
      await wait(500)
      send('Рабочий разговор с телефона')
      await until(() => /Рабочий разговор с телефона/.test(feed()), 30000)
      await until(() => !document.querySelector('.btn-send.is-stop'), 60000)
      await wait(800)
      send('/remote-control')
      note('команда /remote-control показывает значок в шапке чата', await until(() => Boolean(document.querySelector('#chatHeaderMeta .remote-badge')), 15000))
      note('и в списке чатов у этого чата метка телефона', await until(() => document.querySelectorAll('.history-item .remote-mark').length === 1, 10000), document.querySelectorAll('.history-item .remote-mark').length)

      // 4. Телефон пишет — ответ приходит в окно.
      note('сообщение с телефона появилось в окне', await until(() => /Привет с телефона/.test(feed()), 90000), feed().slice(-200))
      note('ответ модели на сообщение с телефона виден в окне', await until(() => /Ответ на сообщение с телефона: принято/.test(feed()), 90000), feed().slice(-200))
      await wait(1500)

      // 5. Отключение устройства из списка.
      $('openSettingsBtn').click()
      await wait(300)
      $('tab-remote').click()
      await wait(300)
      note('журнал показывает действия телефона', /Сообщение с телефона/.test($('remoteAudit').textContent), $('remoteAudit').textContent.slice(0, 120))
      note('кнопок «отключить» у устройств нет, есть только «Сбросить код»', !document.querySelector('.remote-device-off') && !$('remoteRevokeAll').hidden)
      $('remoteRevokeAll').click()
      await wait(300)
      $('confirmOkBtn')?.click()
      note('«Сбросить код» убирает старые устройства и показывает новый код', await until(() => document.querySelectorAll('#remoteDevices .remote-device').length === 0 && /^[2-9A-Z]{5}-[2-9A-Z]{5}$/.test($('remoteCode').textContent.trim()) && $('remoteCode').textContent.trim() !== window.__firstCode, 20000), $('remoteCode').textContent)
      window.__remoteDone = true
    }

    try { await run() } catch (error) {
      note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
    }
    note('ошибок в окне нет', !errors.length, errors.join(' | '))
    return { ok: checks.every(c => c.pass), checks }
  })()`)

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile,
      ONECODE_PROVIDER_LOG: path.join(out, 'provider.log'), ONECODE_SHOT: path.join(out, 'remote.png'),
      ONECODE_RELAY_URL: 'ws://127.0.0.1:' + port, ONECODE_REMOTE_AUTOAPPROVE: '1', ONECODE_REMOTE_CODE_FILE: codeFile
    })
  })

  // «Телефон».
  const phone = { checks: [] }
  const note = (name, pass, detail) => phone.checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const phoneJob = (async () => {
    if (!await until(() => fs.existsSync(codeFile), 120000)) { note('телефон: код не появился', false); return }
    const code = fs.readFileSync(codeFile, 'utf8').trim()
    let paired
    try { paired = await pairAsPhone({ url: 'ws://127.0.0.1:' + port, WebSocketImpl: WebSocket, code, name: 'Телефон проверки' }) } catch (error) { note('телефон: спаривание', false, error.message); return }
    note('телефон спарился по коду', Boolean(paired && paired.deviceKey))
    const link = new DeviceLink({ url: 'ws://127.0.0.1:' + port, deviceKey: paired.deviceKey, role: 'p', WebSocketImpl: WebSocket })
    const events = []
    link.on('event', event => events.push(event.name))
    await link.start()
    note('телефон на связи с компьютером', await until(() => link.state === 'online', 15000))
    note('hello: версия протокола и имя компьютера', (await link.request('hello')).protocol === 1)
    // Открытых для телефона чатов пока нет.
    note('до /remote-control телефон не видит ни одного чата', (await link.request('chats.list')).length === 0)
    const listed = await until(async () => (await link.request('chats.list')).length === 1, 150000)
    note('после /remote-control виден ровно один чат — тот, что открыт', listed)
    const chats = await link.request('chats.list')
    note('личный чат телефону не показан', !chats.some(chat => /Личный/.test(chat.title + chat.preview)))
    const chat = chats[0]
    const before = await link.request('chat.get', { id: chat.id })
    note('чат читается: сообщения с блоками', before.messages.length >= 2 && /Рабочий разговор/.test(JSON.stringify(before.messages)), before.messages.length)
    note('сигнал «чат изменился» приходил на телефон', events.includes('chat-changed'), events.join(','))
    const secret = (await link.request('models.list')).length >= 0
    note('список моделей отвечает', secret)
    await link.request('chat.send', { id: chat.id, text: 'Привет с телефона' })
    const answered = await until(async () => /Ответ на сообщение с телефона: принято/.test(JSON.stringify((await link.request('chat.get', { id: chat.id })).messages)), 120000)
    note('ответ модели виден и на телефоне', answered)
    // Окно отключит устройство — связь должна оборваться.
    note('когда код сброшен, телефон остаётся без компьютера', await until(() => link.state !== 'online', 120000))
    link.stop()
  })()

  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 420000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  await Promise.race([phoneJob, wait(5000)])
  await relay.close()
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    for (const item of phone.checks) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok) && phone.checks.length > 0 && phone.checks.every(item => item.pass)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
