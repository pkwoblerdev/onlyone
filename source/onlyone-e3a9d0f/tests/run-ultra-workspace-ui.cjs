// U-7: Workspace Ultra — крафт, выгрузка и разворот живым окном.
//
// Слово владельца 01.10: человек крафтит Workspace и может им поделиться; у
// другого человека в Ultra разворачивается в точности такое же рабочее
// пространство. Слово «в точности» здесь и проверяется.
//
// КАК ПРОВЕРЯЕТСЯ «В ТОЧНОСТИ». Не сравнением двух файлов на диске — это сделал бы
// набор без окна. Здесь проверяется то, что видит человек: у контейнера есть
// кнопки, нажатие выгружает файл, а на ЧИСТОМ профиле тот же файл разворачивает
// экран — блоки на тех же местах, с теми же размерами.
//
// ЧЕСТНОСТЬ ПРИБОРА. Три проверки состояния стоят ОТДЕЛЬНО от проверок
// поведения, и падают они сами по себе: кнопок нет, слой блоков пуст, файл не
// выгружен. Иначе девять красных строк выдали бы за девять ошибок одну —
// неверную посылку, что уже случилось дважды за этот пункт.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const uiConfig = require('../src/main/ui-config.js')
const artifactStore = require('../src/main/artifacts.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-ultra-workspace-ui')
const profile = path.join(out, 'profile')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ultra-workspace'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}»`)
  return wanted
}

const evidence = evidenceDir()
const chatId = '7c3e9b28-1d64-4f52-9a70-5b8d2c1e4f39'
const ARTIFACTS = [
  { title: 'Лендинг', kind: 'page', content: '<h1>Поза</h1>', versions: 1 },
  { title: 'Тарифы', kind: 'table', content: 'план,цена\nстарт,0', versions: 1 }
]
const TITLES = ARTIFACTS.map(item => item.title)

// Пресет `ultra` ставится файлом конфигурации, а не кликом по карточке: здесь
// проверяется Workspace, а выбор версии меряет `run-ultra-shell-ui.cjs`.
const CONFIG = {
  ultra: { versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 }
}

const FRAMES = [
  { name: 'seed', mode: 'seed', lang: 'ru' },
  { name: 'craft', mode: 'craft', lang: 'ru' },
  { name: 'craft-en', mode: 'craft', lang: 'en' }
]

async function seedArtifacts () {
  const store = artifactStore.create({ dir: path.join(profile, 'artifacts') })
  for (const item of ARTIFACTS) {
    await store.add({ chatId, title: item.title, kind: item.kind, content: item.content })
  }
  if ((await store.list({ chatId })).length !== ARTIFACTS.length) {
    throw new Error('профиль прогона принял не столько артефактов, сколько заказано')
  }
}

function launch (frame) {
  const resultFile = path.join(out, `${frame.name}.json`)
  const shot = path.join(out, `ultra-workspace-${frame.name}.png`)
  const saved = uiConfig.save(profile, CONFIG.ultra)
  if (!saved.ok) throw new Error(`профиль не принял конфигурацию: ${saved.error}`)
  const args = { mode: frame.mode, lang: frame.lang, chatId, titles: TITLES }
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'ultra-workspace-renderer.js'),
          ONECODE_SMOKE_OUT: resultFile,
          ONECODE_SHOT: shot,
          ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
        })
      })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`окно «${frame.name}» не отчиталось за 240 с`))
    }, 240000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (!fs.existsSync(resultFile)) {
        console.error(`ПРОВАЛ [${frame.name}]: окно не отчиталось (status ${code})`)
        resolve({ ok: false, checks: [], shot: false })
        return
      }
      const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      if (report.error) console.error(`${frame.name}: окно сообщило об ошибке — ${report.error}`)
      for (const item of report.checks || []) {
        console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + frame.name + ' · ' + item.name +
          (item.detail ? ' — ' + item.detail : ''))
      }
      fs.mkdirSync(evidence, { recursive: true })
      for (const file of [shot, resultFile]) {
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
      }
      resolve({ ...report, shot: fs.existsSync(shot) })
    })
  })
}

async function main () {
  fs.mkdirSync(profile, { recursive: true })
  await seedArtifacts()
  const results = []
  for (const frame of FRAMES) {
    console.log(`-> кадр ${frame.name} (mode=${frame.mode}, lang=${frame.lang})`)
    results.push([frame.name, await launch(frame)])
  }
  const total = results.reduce((sum, [, one]) => sum + (one.checks || []).length, 0)
  const passed = results.reduce((sum, [, one]) => sum + (one.checks || []).filter(item => item.pass).length, 0)
  const shots = results.filter(([, one]) => one.shot).length
  const ok = results.every(([, one]) => one.ok) && total > 0 && shots === results.length
  for (const [name, one] of results) {
    console.log(`кадр ${name}: проверок ${(one.checks || []).length}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  }
  console.log(`Workspace Ultra — кадров ${results.length}, снимков ${shots}, проверок ${total}, успешно ${passed}`)
  console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'U-7: Workspace собирается, выгружается и разворачивается в Ultra живым окном'
    : 'U-7 не закрыт: разбор — в красных строках выше')
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
})
