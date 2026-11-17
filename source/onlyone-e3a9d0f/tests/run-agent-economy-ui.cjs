// Расход запросов агента на настоящих обработчиках (07.10.2026): окно запускается по-настоящему, настоящий `send-message`
// ведёт настоящий `runAgentLoop`, вместо сети отвечает файл-сценарий (`ONECODE_PROVIDER_FILE`, шов только в непособранном
// приложении), каждый запрос к модели складывается в `ONECODE_PROVIDER_DUMP`.
//
// Что проверяется:
//   edit      — edit_file правит один фрагмент и не трогает окончания строк CRLF; неоднозначная правка не применяется молча;
//   loop      — один и тот же вызов с тем же результатом не крутится до предела шагов: ход останавливается на пятом;
//   solo      — обычное сообщение: ведущий один, без assign_work и без брифа координатора;
//   team      — «работайте вместе»: assign_work на месте;
//   rules     — `node --version` идёт без карточки в режиме «спрашивать каждый раз», а запрещённая правилом команда — нет.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-agent-economy')

function launch (name, { turns, body, files = {}, permission = 'acceptEdits', settings = {}, dump = false }) {
  const base = path.join(out, name)
  const workspace = path.join(base, 'workspace')
  const profile = path.join(base, 'profile')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, file), content)
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission },
    ...settings
  }))
  const providerFile = path.join(base, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({ turns }))
  const dumpDir = path.join(base, 'dump')
  fs.mkdirSync(dumpDir, { recursive: true })
  const script = path.join(base, 'renderer.js')
  const resultFile = path.join(base, 'result.json')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(120) }
      return false
    }
    const checks = []
    const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
    window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason?.message || e.reason).slice(0, 160)))
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(500)
    const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
    const sendChat = async text => {
      $('newChatBtn')?.click()
      await wait(400)
      const box = $('composerTextarea')
      box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      $('composerForm').requestSubmit()
    }
    const busy = () => $('sendBtn')?.classList.contains('is-stop')
    const runFinished = async (re, ms = 90000) => {
      const started = await until(() => busy(), 20000)
      const said = await until(() => re.test(feed()), ms)
      await wait(600)
      const idle = await until(() => !busy(), 20000)
      return { started, said, idle }
    }
${body}
    note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
    return { ok: checks.every(item => item.pass), checks }
  })()`)
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 240000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_DUMP: dumpDir,
      ONECODE_PROVIDER_LOG: path.join(base, 'requests.log'), ONECODE_SHOT: path.join(base, 'shot.png')
    })
  })
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
  if (report.error) console.error(`ПРОВАЛ ${name}: ${report.error}`)
  for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + `${name} · ${c.label}` + (c.detail ? ' — ' + c.detail.slice(0, 200) : ''))
  report.name = name
  report.workspace = workspace
  report.requests = fs.existsSync(path.join(base, 'requests.log')) ? fs.readFileSync(path.join(base, 'requests.log'), 'utf8').split('\n').filter(Boolean).length : 0
  report.dumpDir = dumpDir
  return report
}

const outside = []
function expect (label, pass, detail = '') {
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + label + (detail ? ' — ' + String(detail).slice(0, 220) : ''))
  if (!pass) outside.push(label)
}
const requestOf = (report, n) => JSON.parse(fs.readFileSync(path.join(report.dumpDir, `request-${String(n).padStart(3, '0')}.json`), 'utf8')).body
const toolNames = body => (body.tools || []).map(tool => tool.function.name)
const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')).join('\n')

const reports = []

// 1. edit_file: правка фрагмента, CRLF цел, неоднозначный фрагмент не заменяется молча.
const edit = launch('edit', {
  files: { 'a.txt': 'one\r\ntwo\r\nthree\r\n', 'dup.txt': 'x\nfoo\nfoo\n' },
  turns: [
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'dup.txt' } }], text: 'Читаю файлы.' },
    { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_str: 'two', new_str: 'TWO' } }, { name: 'edit_file', args: { path: 'dup.txt', old_str: 'foo', new_str: 'bar' } }], text: 'Правлю.' },
    { toolCalls: [{ name: 'edit_file', args: { path: 'dup.txt', old_str: 'x\nfoo', new_str: 'x\nbar' } }], text: 'Уточняю фрагмент.' },
    { text: 'Поправил a.txt и dup.txt.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  body: `
    await sendChat('Поправь two на TWO в a.txt и первый foo на bar в dup.txt.')
    const r = await runFinished(/Поправил a\\.txt и dup\\.txt/)
    note('ход дошёл до конца', r.said && r.idle, JSON.stringify(r))
    document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
    await wait(300)
    const rows = [...document.querySelectorAll('#messagesList .tool')].map(node => node.innerText.replace(/\\s+/g, ' '))
    note('в ленте есть строки «Изменил»', rows.filter(line => /Изменил/.test(line)).length >= 2, rows.join(' | ').slice(0, 300))
    note('неоднозначная правка видна как невыполненная', rows.some(line => /Не выполнено/.test(line) && /dup\\.txt/.test(line)), rows.join(' | ').slice(0, 300))
  `
})
reports.push(edit)
const aTxt = fs.readFileSync(path.join(edit.workspace, 'a.txt'), 'utf8')
const dupTxt = fs.readFileSync(path.join(edit.workspace, 'dup.txt'), 'utf8')
expect('edit · a.txt: заменено только «two», окончания CRLF на месте', aTxt === 'one\r\nTWO\r\nthree\r\n', JSON.stringify(aTxt))
expect('edit · dup.txt: неоднозначная правка не применилась, уточнённая — применилась', dupTxt === 'x\nbar\nfoo\n', JSON.stringify(dupTxt))

// 2. Зацикливание: один и тот же вызов — ход останавливается, а не идёт до предела шагов.
const sameCall = { toolCalls: [{ name: 'read_file', args: { path: 'nope.txt' } }], text: 'Читаю.' }
const loop = launch('loop', {
  turns: [sameCall, sameCall, sameCall, sameCall, sameCall, sameCall, sameCall, sameCall],
  body: `
    await sendChat('Прочитай nope.txt.')
    const r = await runFinished(/повторил один и тот же вызов/)
    note('ход остановлен на повторе', r.said && r.idle, JSON.stringify(r) + ' | ' + feed().slice(-240))
    note('об остановке сказано человеку', /не сдвинулся/.test(feed()), feed().slice(-240))
    // Вызовы, которые защита не исполнила, закрывают свои строки: «Читаю …» не висит до конца хода.
    document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
    await wait(300)
    const hanging = [...document.querySelectorAll('#messagesList .tool')].filter(node => /…\\s*$/.test(node.innerText.trim()))
    note('после остановки в ленте нет вечных строк «…»', hanging.length === 0, 'висит строк: ' + hanging.length)
  `
})
reports.push(loop)

// 2b. Обрезанные аргументы вызова (2026-10-11, stress-agent): инструмент не запускался, но строка «Читаю …» оставалась
// навсегда, а итог серии называл вызов выполненным («Прочитан файл»).
const cutCall = { frames: [
  { choices: [{ delta: { content: 'Читаю.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cut', function: { name: 'read_file', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": "a.txt"' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
] }
const badArgs = launch('badargs', {
  files: { 'a.txt': 'one\n' },
  turns: [cutCall, { text: 'Файл прочитать не удалось: вызов оборвался.' }, { content: 'ВЕРДИКТ: ГОТОВО' }],
  body: `
    await sendChat('Прочитай a.txt.')
    const r = await runFinished(/вызов оборвался/)
    note('ход дошёл до конца', r.said && r.idle, JSON.stringify(r))
    document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
    await wait(300)
    const rows = [...document.querySelectorAll('#messagesList .tool')].map(node => node.innerText.replace(/\\s+/g, ' ').trim())
    note('строка оборванного вызова закрыта, а не висит «…»', rows.length > 0 && rows.every(row => !/…$/.test(row)), rows.join(' | '))
    note('оборванный вызов назван невыполненным', rows.some(row => /Не выполнено/.test(row)), rows.join(' | '))
    note('итог серии не называет его прочитанным файлом', !/Прочитан файл|Прочитано/.test(feed()), feed().slice(0, 300))
  `
})
reports.push(badArgs)
// Пять обращений за ход плюс название чата и подсказка; без защиты ход шёл бы до предела шагов.
expect('loop · запросов к модели не больше девяти', loop.requests > 0 && loop.requests <= 9, 'запросов: ' + loop.requests)

// 3. Обычное сообщение: один агент, без assign_work и брифа координатора.
const solo = launch('solo', {
  turns: [{ text: 'Привет! Чем помочь?' }],
  body: `
    await sendChat('Привет')
    const r = await runFinished(/Чем помочь/)
    note('ответ получен', r.said && r.idle, JSON.stringify(r))
  `
})
reports.push(solo)
{
  const body = requestOf(solo, 1)
  expect('solo · assign_work не предлагается', !toolNames(body).includes('assign_work'), toolNames(body).join(','))
  expect('solo · брифа координатора нет', !/координируешь команду/.test(systemOf(body)))
  expect('solo · раздела о команде в контракте качества нет', !/<collaboration>/.test(systemOf(body)))
  expect('solo · визуальный контракт не нужен обычной просьбе', !/Качество визуальной работы/.test(systemOf(body)))
  expect('solo · правок файлов предлагается точечная: edit_file на месте', toolNames(body).includes('edit_file'))
}

// 4. Просьба о команде: assign_work на месте.
const team = launch('team', {
  turns: [{ text: 'Готов работать с командой.' }],
  body: `
    await sendChat('Работайте вместе: придумайте название проекту.')
    const r = await runFinished(/Готов работать с командой|команд/, 60000)
    note('ход начался', r.started, JSON.stringify(r))
  `
})
reports.push(team)
{
  const body = requestOf(team, 1)
  expect('team · по просьбе ведущему дан assign_work', toolNames(body).includes('assign_work'), toolNames(body).join(','))
}

// 5. Правила команд: чтение идёт без карточки в ручном режиме, запрещённое — отклоняется.
const rules = launch('rules', {
  permission: 'manual',
  settings: { commandRules: 'deny echo secret*' },
  turns: [
    { toolCalls: [{ name: 'run_command', args: { command: 'node --version' } }, { name: 'run_command', args: { command: 'echo secret' } }], text: 'Проверяю команды.' },
    { text: 'Версия получена, секрет запрещён правилом.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  body: `
    await sendChat('Покажи версию node и выведи secret.')
    const r = await runFinished(/секрет запрещён правилом/)
    note('ход дошёл до конца без единого вопроса человеку', r.said && r.idle && !document.querySelector('#messagesList .approval-card'), JSON.stringify(r))
    document.querySelectorAll('#messagesList .thought-group').forEach(group => { group.open = true })
    await wait(300)
    const rows = [...document.querySelectorAll('#messagesList .tool')].map(node => node.innerText.replace(/\\s+/g, ' '))
    // Строка команды в ленте без самой команды: первая строка — node --version, вторая — echo secret.
    note('node --version выполнена без вопроса', /^Выполнил/.test(rows[0] || ''), rows.join(' | ').slice(0, 300))
    note('echo secret отклонена правилом', /^Не выполнено/.test(rows[1] || ''), rows.join(' | ').slice(0, 300))
  `
})
reports.push(rules)

const ok = reports.every(report => report && report.ok !== false) && !outside.length
console.log(ok ? 'Расход запросов агента проходит настоящими обработчиками' : 'Есть провалы в сквозной проверке расхода')
settleRun(out, ok)
process.exitCode = ok ? 0 : 1
