// Оконная проверка центра задач (план, 3.4): два запуска на одном профиле.
//
// Первый — пустой раздел и посев двух диалогов с записями о ходе агентов. Между
// запусками кладётся контрольная точка оборванного хода (тот же формат, что у
// `run-checkpoints`), чтобы второй запуск нашёл её честно, через главный
// процесс. Второй запуск открывает раздел и проверяет список, поиск, фильтры,
// метку навигации, переход из карточки и то, что чужой текст не становится
// разметкой. Снимки — доказательство того, что экран выглядит как экран.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-task-center')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

// Идентификаторы — вида UUID: главный процесс по нему узнаёт запись хода, и
// произвольные строки он в список оборванных не пускает.
const chatA = '11111111-2222-3333-4444-555555555501'
const chatB = '11111111-2222-3333-4444-555555555502'
const runId = '11111111-2222-3333-4444-555555555503'
const answerAt = Date.now() - 3000

function launch(name, mode, extra = {}) {
  const resultFile = path.join(out, name + '.json')
  const args = { mode, chatA, chatB, answerAt, ...extra }
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, timeout: 180000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, 'task-center-renderer.js'),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: path.join(out, `task-center-${name}.png`),
        // Аргументы — base64: в тексте просьбы есть кавычки и угловые скобки.
        ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
      })
    })
  if (child.error) throw child.error
  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${name} (status ${child.status})`)
    return { ok: false, checks: [] }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`${name}: окно сообщило об ошибке — ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name +
      (item.detail ? ' — ' + item.detail : ''))
  }
  const shot = path.join(out, `task-center-${name}.png`)
  if (evidence && fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, `task-center-${name}.png`))
  }
  return report
}

function main() {
  const seed = launch('seed', 'seed')
  const at = Date.now()
  // Так выглядит ход, оборванный закрытием приложения: запись файла закончилась,
  // сборка — нет.
  fs.mkdirSync(path.join(profile, 'runs'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'runs', runId + '.json'), JSON.stringify({
    schemaVersion: 1, runId, requestId: 'tc-request', chatId: chatA, surface: 'chat',
    ask: 'Дочитать лог <img src=x> и сказать, что не так', startedAt: at, updatedAt: at, droppedActions: 0,
    actions: [
      { seq: 1, tool: 'read_file', target: 'src/main/main.js', agentIndex: 0, status: 'done', at },
      { seq: 2, tool: 'run_command', target: 'npm test', agentIndex: 0, status: 'started', at }
    ]
  }))

  const main = launch('main', 'main')
  const ok = seed.ok && main.ok
  console.log(ok ? 'Центр задач работает в окне' : 'Есть ошибки в центре задач')
  if (evidence) console.log('снимки: ' + ['seed', 'main'].map(n => `task-center-${n}.png`).join(', '))
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

try {
  main()
} catch (error) {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
}
