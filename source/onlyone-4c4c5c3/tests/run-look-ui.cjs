// Вид по макету (audits/ui-2026-10-18/onlyone-mockup.html) в настоящем окне:
// проверки устройства экранов и снимки каждого экрана в тёмной и светлой теме.
// Использование:  node tests/run-look-ui.cjs [папка для снимков] [ширинаxвысота] [раздел,раздел]
// Без папки — только проверки. Сценарный провайдер даёт настоящий ход без сети.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const shots = process.argv[2] ? path.resolve(process.argv[2]) : ''
const size = process.argv[3] || '1360x860'
const only = process.argv[4] || ''
// Папки кадров заводим здесь: окно пишет кадр, но каталогов не создаёт
if (shots) for (const theme of ['dark', 'light']) fs.mkdirSync(path.join(shots, theme + '-' + size.split('x')[0]), { recursive: true })

const dir = runDir('onlyone-look')
const profile = path.join(dir, 'profile')
const workspace = path.join(dir, 'workspace')
fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'src', 'settings-store.js'), 'export function save (data) {\n  return write(JSON.stringify(data))\n}\n')

// ── Скиллы: проект (рабочая папка), пакет для импорта, источники для «Нового скилла» ──
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const ps = path.join(workspace, '.onlyone', 'skills')
put(path.join(ps, 'cart-tests', 'SKILL.md'), '---\nname: Тесты корзины\ndescription: Как запускать тесты корзины на Windows и что делать с нестабильным checkout.spec\n---\n\n# Тесты корзины\n\nТесты гоняются через npm run test:cart.\n\n- checkout.spec нестабилен из-за таймера оплаты: перезапусти один раз\n- Базу не трогай: тесты поднимают свою\n')
put(path.join(ps, 'deploy.md'), '---\nname: Деплой на сервер\n---\n\nВыкатывает main на сервер через scp и перезапускает pm2.\n')
const pack = path.join(dir, 'packs', 'review')
put(path.join(pack, 'SKILL.md'), '---\nname: Ревью перед коммитом\ndescription: Проверяет изменения: ключи и пароли в коде, отладочный вывод, TODO без задачи\n---\n\n# Ревью перед коммитом\n\nПеред коммитом пройди по изменениям в ветке.\n\n- Ключи, пароли и токены в коде: остановить коммит и показать строку\n- console.log и отладочный вывод: убрать\n')
put(path.join(pack, 'reference.md'), '# Справка\n\nКуда смотреть, если проверка упала.\n')
put(path.join(pack, 'scripts', 'run-checks.ps1'), 'git diff --cached --name-only\n')
// .docx: zip с word/document.xml (заголовок, абзац, два пункта, таблица)
const zlib = require('node:zlib')
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function zip (files) {
  const locals = [], centrals = []; let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), packed = zlib.deflateRawSync(data), nb = Buffer.from(name, 'utf8')
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nb.length, 26)
    locals.push(head, nb, packed)
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc32(data), 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(offset, 42)
    centrals.push(cen, nb); offset += 30 + nb.length + packed.length
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const P = (text, style = '', list = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
const docx = path.join(dir, 'src-files', 'release-checklist.docx')
fs.mkdirSync(path.dirname(docx), { recursive: true })
fs.writeFileSync(docx, zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document xmlns:w="w"><w:body>' +
  P('Чек-лист релиза', 'Heading1') + P('Перед выпуском версии: пройти проверки и собрать заметки к релизу.') +
  P('Тесты зелёные: npm test', '', true) + P('Версия поднята в package.json', '', true) + P('Ссылка на сборку проверена скачиванием', '', true) +
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Шаг</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Кто</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' }))
const staging = path.join(dir, 'src-files', 'staging-deploy')
put(path.join(staging, 'SKILL.md'), '---\nname: Выкатка на staging\n---\n\n# Выкатка на staging\n\n- Собери ветку\n- Запусти scripts/deploy.ps1\n- Проверь /health\n')
put(path.join(staging, 'scripts', 'deploy.ps1'), 'echo deploy\n')
// Проекты: файл базы знаний и папка, которой нет на диске (проект с потерянной папкой)
const kbFile = path.join(dir, 'src-files', 'latency-report.md')
put(kbFile, '# Задержки\n\np95 по ручкам за неделю.\n')
const lostDir = path.join(dir, 'нет-такой-папки', 'old-crm')
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))

// Ход агента: прочитать, исправить, ответить блоком кода — как сцена «Ход» макета
const turn = (text, calls) => {
  const frames = []
  if (text) frames.push({ choices: [{ delta: { content: text } }] })
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, id: 'call_' + (index + 1), function: { name: call.name, arguments: '' } }] } }] }))
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] }))
  frames.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  return { frames }
}
const provider = path.join(dir, 'provider.json')
const draftQuestions = { questions: [{ q: 'Где лежат тексты интерфейса?', options: ['src/locales/*.json', 'Прямо в компонентах'] }, { q: 'Что делать с найденной ошибкой?', options: ['Показать и предложить правку', 'Исправить сразу'] }] }
const draft = { name: 'Тексты перед релизом', description: 'Перед релизом: проверить тексты интерфейса', body: '# Тексты перед релизом\n\n- Тексты ищи в src/locales/*.json\n- Заглавная только в начале фразы\n- Найденную ошибку: показать и предложить правку' }
// Задачи: ход оставляет работать процесс (start_process) и прогоняет команду — консоль панели
const nodeBin = JSON.stringify(process.execPath)
const devCmd = nodeBin + ' -e "console.log(\'> shop-api dev\'); console.log(\'ready in 412 ms\'); setInterval(() => console.log(\'hmr update\'), 400)"'
const testCmd = nodeBin + ' -e "console.log(\'✓ settings-store.test.js (6)\'); console.log(\'Tests 6 passed\')"'
// Дизайн: первый ход записывает страницу через dc_write — в галерее у карточки живое превью
const landing = '<main style="padding:64px;font:16px system-ui"><h1>Пять минут тишины</h1><p>Короткие дыхательные практики, когда день не даёт выдохнуть.</p><button>Выбрать практику</button></main>'
fs.writeFileSync(provider, JSON.stringify({ keyed: [
  { match: 'Первый экран сервиса', once: true, frames: turn('Собираю первый экран.', [{ name: 'dc_write', args: { path: 'Landing.dc.html', b_dc_html: landing } }]).frames },
  { match: 'Первый экран сервиса', once: true, frames: turn('Собрал первый экран: заголовок, строка и кнопка «Выбрать практику».', []).frames },
  { match: 'Подними сервер', once: true, frames: turn('Подниму сервер и прогоню тесты.', [{ name: 'start_process', args: { command: devCmd } }, { name: 'run_command', args: { command: testCmd } }]).frames },
  { match: 'Подними сервер', once: true, frames: turn('Сервер работает, тесты зелёные.', []).frames },
  { match: 'Ответы на уточнения', content: JSON.stringify(draft) },
  { match: 'уточняющих вопроса', content: JSON.stringify(draftQuestions) }
], turns: [
  turn('Посмотрю, как сохраняются настройки.', [{ name: 'read_file', args: { path: 'src/settings-store.js' } }]),
  turn('Готово: настройки пишутся атомарно.\n\n```js\nexport function save (data) {\n  const tmp = path + \'.tmp\'\n  return write(tmp, JSON.stringify(data)).then(() => rename(tmp, path))\n}\n```\n\nПроверил: 12 из 12 тестов зелёные.', []),
  turn('Настройки не сохраняются', []), turn('Подсказка', []), turn('Подсказка', [])
] }))

const out = path.join(dir, 'result.json')
const [w, h] = size.split('x')
acquireWindowLock()
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, stdio: 'ignore', timeout: 300000,
  env: guiEnv({
    ONECODE_SMOKE: path.join(__dirname, 'look-renderer.js'), ONECODE_SMOKE_OUT: out, ONECODE_E2E: '1',
    ONECODE_PROVIDER_FILE: provider, ONECODE_VERSIONS: '0',
    ONECODE_TEST_PICK_FILE: [docx, staging].join(';'),
    ONECODE_TEST_PICK_FOLDER: [workspace, lostDir].join('|'),
    ONECODE_TEST_PICK_ATTACH: [kbFile, kbFile].join(';'),
    ONECODE_SHOT_SIZE: size, ONECODE_SHOT: shots ? path.join(shots, `_last-${w}.png`) : path.join(dir, 'last.png'),
    ONECODE_ARG: JSON.stringify({ shots: shots.replace(/\\/g, '/'), width: Number(w), height: Number(h), only, workspace: workspace.replace(/\\/g, '/'), pack: pack.replace(/\\/g, '/'), node: process.execPath.replace(/\\/g, '/'), mockMcp: path.join(__dirname, 'mock-mcp-server.mjs').replace(/\\/g, '/') })
  })
})

if (!fs.existsSync(out)) {
  console.error('окно не отчиталось — приложение не догрузилось; улики: ' + dir)
  process.exit(1)
}
const result = JSON.parse(fs.readFileSync(out, 'utf8'))
if (result.error) console.error('ОШИБКА СКРИПТА: ' + result.error)
const checks = result.checks || []
const failed = checks.filter(c => !c.pass)
for (const c of checks) if (process.env.ONECODE_SMOKE_VERBOSE || !c.pass) console.log((c.pass ? '  ok   ' : 'ПРОВАЛ ') + c.name + (c.detail && !c.pass ? ' — ' + c.detail : ''))
for (const e of result.thrown || []) console.error('ИСКЛЮЧЕНИЕ В ОКНЕ: ' + e)
const ok = Boolean(result.ok) && !failed.length && !(result.thrown || []).length
console.log((ok ? 'вид по макету в порядке' : 'вид по макету расходится') + ' — проверок ' + checks.length + ', не прошло ' + failed.length + (shots ? ', снимки: ' + shots : ''))
settleRun(dir, ok)
process.exit(ok ? 0 : 1)
