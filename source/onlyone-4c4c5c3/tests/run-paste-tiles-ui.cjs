// Вставка в строку ввода и снимок в ходе мысли — в настоящем окне (07.10.2026).
//   плитки   — длинный текст из буфера ложится плиткой «Вставлено», а не в поле; короткий идёт в поле как обычно;
//              картинка из буфера — квадратной плиткой с миниатюрой; крестик убирает плитку;
//   сообщение — после отправки плитки стоят в самом сообщении, а модель получила вставленный текст целиком;
//   снимок   — вложение «только для хода» (так приходит снимок следилки за вкладкой) не рисуется ни в строке ввода,
//              ни в сообщении, а в ходе мысли агента появляется строка «Снимок страницы» с миниатюрой.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-paste-tiles')
const workspace = path.join(out, 'workspace')
const profile = path.join(out, 'profile')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model',
  legacyStoragePurged: true,
  workspace: { path: workspace, permission: 'acceptEdits' }
}))
const dump = path.join(out, 'dump')
fs.mkdirSync(dump, { recursive: true })
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: [{ text: 'Вижу вставленное. Ответ тестового провайдера.' }, { text: 'Снимок получен.' }] }))

const MARKER = 'УНИКАЛЬНАЯ-МЕТКА-ВСТАВКИ-7431'
const script = path.join(out, 'renderer.js')
const resultFile = path.join(out, 'result.json')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) } return false }
  const checks = []
  const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
  window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason?.message || e.reason).slice(0, 160)))
  await until(() => document.documentElement.dataset.appReady === '1', 60000)
  await wait(600)
  $('newChatBtn')?.click()
  await wait(500)
  const box = $('composerTextarea')
  const strip = $('attachmentStrip')
  const paste = dt => { const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); box.focus(); box.dispatchEvent(event); return event }
  const textOf = node => (node?.textContent || '').replace(/\\s+/g, ' ').trim()

  // 1. Короткий текст — обычная вставка: событие не гасится.
  const shortData = new DataTransfer(); shortData.setData('text/plain', 'короткая строка')
  const shortEvent = paste(shortData)
  note('короткий текст вставляется в поле как обычно', shortEvent.defaultPrevented === false)

  // 2. Длинный текст — плитка «Вставлено», поле остаётся пустым.
  const longText = '${MARKER}\\n' + Array.from({ length: 40 }, (_, i) => 'строка вставленного текста номер ' + (i + 1)).join('\\n')
  const longData = new DataTransfer(); longData.setData('text/plain', longText)
  const longEvent = paste(longData)
  note('длинный текст перехвачен', longEvent.defaultPrevented === true)
  const pastedShown = await until(() => strip.querySelector('.attachment-tile.is-pasted'))
  note('появилась плитка вставленного текста', pastedShown, strip.innerHTML.slice(0, 160))
  const pastedTile = strip.querySelector('.attachment-tile.is-pasted')
  note('поле ввода не засорено длинным текстом', box.value === '', JSON.stringify(box.value.slice(0, 60)))
  note('на плитке начало текста и метка «Вставлено»', textOf(pastedTile?.querySelector('.tile-text')).startsWith('${MARKER}') && textOf(pastedTile?.querySelector('.tile-badge')) === 'Вставлено', textOf(pastedTile))
  note('плитка — квадрат нужного размера', Math.abs((pastedTile?.getBoundingClientRect().width || 0) - (pastedTile?.getBoundingClientRect().height || 1)) < 1 && (pastedTile?.getBoundingClientRect().width || 0) >= 100, JSON.stringify(pastedTile?.getBoundingClientRect()))

  // 3. Картинка из буфера — плитка с миниатюрой.
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2a6f97'; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = '#f6c177'; ctx.fillRect(40, 40, 160, 90)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  const imageData = new DataTransfer(); imageData.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  const imageEvent = paste(imageData)
  note('картинка из буфера перехвачена', imageEvent.defaultPrevented === true)
  const imageShown = await until(() => strip.querySelector('.attachment-tile.kind-image'))
  note('появилась плитка картинки', imageShown)
  const imageTile = strip.querySelector('.attachment-tile.kind-image')
  const thumbFilled = await until(() => /data:image/.test(imageTile?.querySelector('.attachment-thumb')?.style.backgroundImage || ''))
  note('на плитке миниатюра, а не имя файла', thumbFilled && !/paste-/.test(textOf(imageTile)), textOf(imageTile))
  note('обе плитки в одной строке над полем', strip.querySelectorAll('.attachment-tile').length === 2)

  // Кадр с плитками — для глаз.
  document.title = 'SNAP:${out.replace(/\\/g, '/')}/composer-tiles.png'
  await wait(900)

  // 4. Крестик убирает плитку (проверяется на лишней картинке).
  const extra = new DataTransfer(); extra.items.add(new File([blob], 'extra.png', { type: 'image/png' }))
  paste(extra)
  await until(() => strip.querySelectorAll('.attachment-tile').length === 3)
  strip.querySelectorAll('.attachment-tile')[2].querySelector('.tile-remove').click()
  const removed = await until(() => strip.querySelectorAll('.attachment-tile').length === 2)
  note('крестик убирает плитку', removed, strip.querySelectorAll('.attachment-tile').length)

  // 5. Снимок «только для хода»: в строке ввода его нет.
  const shotCanvas = document.createElement('canvas'); shotCanvas.width = 640; shotCanvas.height = 400
  const sctx = shotCanvas.getContext('2d'); sctx.fillStyle = '#264653'; sctx.fillRect(0, 0, 640, 400); sctx.fillStyle = '#e9c46a'; sctx.fillRect(60, 60, 300, 120)
  const shotUrl = shotCanvas.toDataURL('image/png')
  const described = await window.electronAPI.savePastedImage(shotUrl)
  window.__modelOnlyAttach(described)
  await wait(300)
  note('снимок «только для хода» не рисуется в строке ввода', strip.querySelectorAll('.attachment-tile').length === 2, strip.querySelectorAll('.attachment-tile').length)

  // 6. Отправка: плитки в сообщении, текст ушёл модели, снимок — строкой в ходе мысли.
  box.value = 'Посмотри на вставленное.'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  $('composerForm').requestSubmit()
  await until(() => $('sendBtn')?.classList.contains('is-stop'), 20000)
  await until(() => /Вижу вставленное/.test($('messagesList').innerText), 60000)
  await until(() => !$('sendBtn')?.classList.contains('is-stop'), 30000)
  await wait(600)
  const sent = document.querySelector('#messagesList .msg-item.user')
  note('в отправленном сообщении стоят плитки', (sent?.querySelectorAll('.attachment-tile').length || 0) === 2, sent?.innerHTML.slice(0, 200))
  note('в отправленном сообщении виден текст вставки и нет снимка «только для хода»', !!sent?.querySelector('.attachment-tile.is-pasted') && (sent?.querySelectorAll('.attachment-tile.kind-image').length || 0) === 1)
  note('строка ввода после отправки пуста', strip.hidden === true || strip.querySelectorAll('.attachment-tile').length === 0)
  document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
  await wait(300)
  const shotRow = [...document.querySelectorAll('#messagesList .tool')].find(row => row.querySelector('.rail-shot'))
  note('в ходе мысли есть строка «Снимок страницы» с миниатюрой', !!shotRow && /Снимок страницы/.test(textOf(shotRow)) && /^data:image\\//.test(shotRow.querySelector('.rail-shot').src), shotRow ? textOf(shotRow) : 'строки нет')

  document.title = 'SNAP:${out.replace(/\\/g, '/')}/sent-message.png'
  await wait(900)
  note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
  return { ok: checks.every(item => item.pass), checks }
})()`)

spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 240000, stdio: 'inherit',
  env: guiEnv({
    ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
    ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_DUMP: dump, ONECODE_SHOT: path.join(out, 'tiles.png')
  })
})

const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
if (report.error) console.error('ПРОВАЛ: ' + report.error)
for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + c.label + (c.detail ? ' — ' + c.detail.slice(0, 200) : ''))

// Модель получила вставленный текст целиком, а не плитку: первое обращение содержит метку из начала вставки.
const first = fs.existsSync(path.join(dump, 'request-001.json')) ? fs.readFileSync(path.join(dump, 'request-001.json'), 'utf8') : ''
const gotText = first.includes(MARKER) && first.includes('строка вставленного текста номер 40')
console.log((gotText ? '  ok     ' : '  ПРОВАЛ ') + 'модель получила вставленный текст целиком')
const ok = report.ok !== false && gotText
console.log(ok ? 'Плитки вставки и снимок в ходе мысли проходят в настоящем окне' : 'Есть провалы в сквозной проверке плиток')
if (process.env.ONECODE_EVIDENCE_DIR) {
  fs.mkdirSync(process.env.ONECODE_EVIDENCE_DIR, { recursive: true })
  for (const name of ['composer-tiles', 'sent-message']) {
    const shot = path.join(out, name + '.png')
    if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(process.env.ONECODE_EVIDENCE_DIR, 'paste-' + name + '.png'))
  }
}
settleRun(out, ok)
process.exitCode = ok ? 0 : 1
