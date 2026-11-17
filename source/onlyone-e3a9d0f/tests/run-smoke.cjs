// Boots the real app, drives the real DOM, prints the verdict.
// Necessary because an Electron GUI build's stdout never reaches the parent
// shell on Windows: the app can be completely dead and the terminal stays clean.
const { spawnSync } = require('child_process')
const { readFileSync, existsSync, unlinkSync } = require('fs')
const { join } = require('path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = join(__dirname, '..')
const script = join(__dirname, 'smoke-renderer.js')
// Оба пути — наши, и удаляем мы ровно их, а не всё подряд по префиксу.
const outDir = runDir('onecode-smoke')
const out = join(outDir, 'result.json')
if (existsSync(out)) unlinkSync(out)

const electron = electronBinary()

// A throwaway profile. Without it the test typed into the user's real chats and
// left its own conversations in their history — it shares userData with the
// installed app otherwise.
const profile = runDir('onecode-profile')

// The managed Windows test host blocks Chromium's GPU sandbox helper. This is
// an isolated local profile with no remote content; production stays sandboxed.
spawnSync(electron, ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root,
  stdio: 'ignore',
  timeout: 120000,
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out,
    ONECODE_SMOKE_FIXTURE: join(__dirname, 'smoke-fixture.json'),
    // Папка нового проекта (форма «Новый проект» требует её) — свой каталог прогона
    ONECODE_TEST_PICK_FOLDER: outDir })
})

if (!existsSync(out)) {
  // Путь печатается здесь же: без вердикта это единственное место, где можно
  // понять, что смотреть профиль и лог. Раньше выход молчал.
  console.error('окно не отчиталось — приложение не догрузилось')
  console.error('улики: ' + outDir + ' | профиль: ' + profile)
  process.exit(1)
}

const result = JSON.parse(readFileSync(out, 'utf8'))
const checks = result.checks || []
const failed = checks.filter(c => !c.pass && !c.skipped)
const skipped = checks.filter(c => c.skipped)

if (process.env.ONECODE_SMOKE_VERBOSE) {
  for (const c of checks) {
    console.log((c.pass ? '  ok  ' : c.skipped ? 'ПУСТО ' : 'ПРОВАЛ') + ' ' + c.name + (c.detail ? ' — ' + c.detail : ''))
  }
}
for (const c of failed) console.error('ПРОВАЛ: ' + c.name + (c.detail ? ' — ' + c.detail : ''))
// Пропуск — не успех и не нейтральность: это то, что проверка не состоялась.
// Раньше такие проверки просто исчезали из счёта, и «проверок N» гуляло между
// запусками, а набор оставался зелёным.
for (const c of skipped) console.error('НЕ СОСТОЯЛОСЬ: ' + c.name + (c.detail ? ' — ' + c.detail : ''))
console.log(
  (result.ok ? 'интерфейс в порядке' : 'интерфейс сломан') +
  ' — проверок ' + checks.length +
  ', успешно ' + (checks.length - failed.length - skipped.length) +
  ', не прошло ' + failed.length +
  (skipped.length ? ', не состоялись ' + skipped.length : '')
)

// Убирает общий helper: свой каталог, только на зелёном, только тот, что
// заведён этим прогоном. Чужие каталоги в %TEMP% не трогаем никогда — ни по
// префиксу, ни маской: в этом наборе один прогон уже лишился чужого профиля.
const green = result.ok && !skipped.length
if (result.ok && skipped.length) {
  // Код выхода даёт result.ok, а уборку решает `green`: пропуск — не провал, но
  // и не «всё состоялось», поэтому каталог остаётся. Расхождение говорим вслух,
  // чтобы «код 0» не читался как «приложение зелёное и временных файлов нет».
  console.error('КАТАЛОГ ОСТАВЛЕН: проверок не состоялось ' + skipped.length + ' — код 0 означает «не провал», а не «полный прогон»')
}
settleRun(outDir, green)
settleRun(profile, green)
process.exit(result.ok ? 0 : 1)
