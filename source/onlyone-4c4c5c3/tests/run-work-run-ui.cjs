// Ход работы ОДНИМ блоком — настоящим окном и настоящим ходом агента (сценарий провайдера).
//
// Слово владельца 04.10.2026 по образцу Claude: пока агент работает, это один блок с
// заголовком «что делаю сейчас» и временем («Выполняю команду · 3с»); когда закончил —
// блок сворачивается в итог одной фразой («Выполнено 2 команды (1 с ошибкой), создан файл,
// изменён файл, прочитан файл и ещё 1 действие»). Слова ассистента между вызовами лежат
// внутри блока, а не рвут его на куски; ответ после последнего вызова стоит снаружи.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-work-run')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const providerFile = path.join(out, 'provider.json')
// Как у настоящей модели: слова идут РАНЬШЕ вызова в том же ответе. Прежний сценарий слал текст
// после вызовов и скрывал ошибку, из-за которой всё сказанное за ход склеивалось в один кусок.
const turn = (text, calls, extra = {}) => {
  const frames = []
  if (text) frames.push({ choices: [{ delta: { content: text } }] })
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, id: 'call_' + (index + 1), function: { name: call.name, arguments: '' } }] } }] }))
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] }))
  frames.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  return { frames, ...extra }
}
fs.writeFileSync(providerFile, JSON.stringify({
  turns: [
    turn('Начну с проверки окружения.', [{ name: 'run_command', args: { command: 'node -e "setTimeout(() => {}, 4000)"', timeout_seconds: 30 } }]),
    turn('', [{ name: 'write_file', args: { path: 'a.txt', content: 'первая строка\n' } }]),
    turn('Теперь поправлю файл.', [{ name: 'write_file', args: { path: 'a.txt', content: 'первая строка\nвторая строка\n' } }]),
    turn('', [{ name: 'read_file', args: { path: 'a.txt' } }]),
    turn('', [{ name: 'run_command', args: { command: 'node -e "process.exit(3)"', timeout_seconds: 30 } }]),
    turn('', [{ name: 'list_files', args: { path: '.' } }]),
    turn('Готово: файл создан и исправлен, одна проверка упала.', [])
  ]
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
  const until = async (fn, ms = 60000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  const groups = () => [...document.querySelectorAll('#messagesList .thought-group')]
  const flat = el => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim()

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    $('newChatBtn')?.click()
    await wait(300)
    $('composerTextarea').value = 'Проверь окружение, создай файл и поправь его'
    $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    $('composerForm').requestSubmit()

    // 1. Живой блок: один, раскрыт, называет действие и показывает время.
    const live = await until(() => groups().some(g => g.classList.contains('is-live') && /Выполняю команду/.test(flat(g.querySelector('.thought-title')))), 90000)
    note('идёт ход: живой блок называет действие («Выполняю команду»)', live, groups().map(g => flat(g.querySelector('.thought-head'))).join(' || ').slice(0, 200))
    const first = groups()[0]
    note('живой блок раскрыт', Boolean(first && first.open))
    note('в заголовке — время хода', /\\d+с/.test(flat(first && first.querySelector('.thought-elapsed'))), flat(first && first.querySelector('.thought-elapsed')))
    const t1 = flat(first && first.querySelector('.thought-elapsed'))
    await wait(1600)
    const t2 = flat(groups()[0] && groups()[0].querySelector('.thought-elapsed'))
    note('время идёт само', Boolean(t2) && t1 !== t2, t1 + ' → ' + t2 + ' | ' + flat(groups()[0] && groups()[0].querySelector('.thought-head')).slice(0, 120))

    // 2. Ход идёт дальше блоками (В3-1): шаги → слова ассистента → следующий блок шагов.
    // Живой — только последний; предыдущий закончен и свёрнут до итога.
    const second = await until(() => groups().length >= 2, 60000)
    note('после слов ассистента начинается следующий блок', second, 'блоков: ' + groups().length)
    const early = groups()[0]
    note('предыдущий блок закончен: не живой, свёрнут, с итогом', Boolean(early) && !early.classList.contains('is-live') && !early.open && /Выполнена команда/.test(flat(early.querySelector('.thought-title'))), flat(early && early.querySelector('.thought-head')).slice(0, 80))
    // Строки внутри живого блока растут сами, пока ход идёт.
    const grew = await until(() => groups().some(g => g.classList.contains('is-live') && g.querySelectorAll('.rail-step').length >= 2), 60000)
    note('живой блок раскрыт и строки в нём прибавляются по ходу', grew, groups().map(g => g.querySelectorAll('.rail-step').length).join(','))

    // 3. Конец хода: блоки свёрнуты, у каждого заголовок — итог одной фразой.
    const done = await until(() => !document.querySelector('.btn-send.is-stop') && groups().length >= 1 && !groups().some(g => g.classList.contains('is-live')), 120000)
    note('ход закончился', done)
    await wait(600)
    const finalGroups = groups()
    note('после хода блоков два (два отрезка шагов), все свёрнуты', finalGroups.length === 2 && finalGroups.every(g => !g.open && !g.classList.contains('is-live')), 'блоков: ' + finalGroups.length)
    const lastGroup = finalGroups[finalGroups.length - 1]
    const title = flat(lastGroup && lastGroup.querySelector('.thought-title'))
    const expected = 'Выполнена команда (1 с ошибкой), изменён файл, прочитан файл и ещё 1 действие'
    note('итог последнего блока одной фразой, как в образце', title === expected, title)
    note('в заголовке итог правок файла', /\\+\\d/.test(flat(lastGroup && lastGroup.querySelector('.work-run-diff'))), flat(lastGroup && lastGroup.querySelector('.work-run-diff')))
    const holderKids = [...document.querySelectorAll('#messagesList .msg-blocks > *')].map(c => c.className.split(' ').slice(0, 2).join('.') + ':' + flat(c).slice(0, 40))
    note('раскладка ленты после хода', true, holderKids.join(' | '))
    note('ответ после последнего вызова стоит снаружи блоков', /Готово: файл создан/.test(flat($('messagesList'))) && !finalGroups.some(g => /Готово: файл создан/.test(flat(g))))

    // 4. Раскрыли: вызовы по порядку внутри блоков; слова ассистента стоят МЕЖДУ блоками.
    finalGroups.forEach(g => { g.open = true })
    await wait(300)
    const rows = lastGroup.querySelectorAll('.rail-step')
    note('внутри последнего блока его вызовы', rows.length >= 4, 'строк: ' + rows.length)
    const order = [...document.querySelectorAll('#messagesList .msg-blocks > *')].map(c => (c.classList.contains('thought-group') ? 'блок' : 'слова')).join(',')
    note('порядок ленты: слова, блок, слова, блок, слова (слова между блоками, не всё наверху)', order === 'слова,блок,слова,блок,слова', order)
    note('слов ассистента внутри блоков нет', !document.querySelector('#messagesList .work-run-note'))
  }

  try { await run() } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
  }
  note('ошибок в окне нет', !errors.length, errors.join(' | '))
  return { ok: checks.every(c => c.pass), checks }
})()`)

async function main () {
  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'work-run.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 280000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
