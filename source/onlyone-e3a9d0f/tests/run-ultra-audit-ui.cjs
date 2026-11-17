// U-5: полный проход Ultra живым окном, с таблицей найденных ошибок.
//
// Один запуск настоящего окна на отдельном профиле прогона, восемь сценариев
// по порядку, как человек: вход и «Сессии», новая сессия, чат с ходом,
// «Задачи», результаты-блоки, строка ввода, длинный ответ и полосы, смена версии
// туда и обратно. Кадры RU и EN.
//
// ГЛАВНОЕ — НЕ СЧЁТЧИК, А СПИСОК. Каждая найденная ошибка печатается строкой
// «где · что ждали · что вышло», потому что владелец читает список, а не код
// теста. Строка без имени сценария не считается находкой.
//
// Артефакты кладутся в профиль прогона ТЕМ ЖЕ модулем `src/main/artifacts.js`,
// которым их пишет живая программа, а диалог сеется штатным каналом окна
// (`setConversations`): экран собирается из настоящих данных, без подделки DOM.
//
// Каталог доказательств — СВОЁ ворктри: в общей папке дерева кадры не пишутся.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const uiConfig = require('../src/main/ui-config.js')
const artifactStore = require('../src/main/artifacts.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-ultra-audit')
const profile = path.join(out, 'profile')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ultra-audit'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) {
    throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}». Кадры пишутся сюда: ${path.join(root, 'audits', 'ultra-audit')}`)
  }
  return wanted
}

const evidence = evidenceDir()
const chatId = '4f2a7c19-5d63-4b0e-8a71-2c9e6f3b8d04'

const ARTIFACTS = [
  { title: 'Лендинг для студии йоги', kind: 'page', content: '<h1>Поза</h1><p>Три карточки и запись.</p>', versions: 2 },
  { title: 'Тарифы', kind: 'table', content: 'план,цена\nстарт,0\nбизнес,9900', versions: 1 }
]
const TITLES = ARTIFACTS.map(item => item.title)

const CONFIG = {
  ultra: { versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 }
}

const FRAMES = [
  { name: 'seed', mode: 'seed', lang: 'ru' },
  { name: 'audit-ru', mode: 'audit', lang: 'ru' },
  { name: 'audit-en', mode: 'audit', lang: 'en' }
]

async function seedArtifacts () {
  const store = artifactStore.create({ dir: path.join(profile, 'artifacts') })
  for (const item of ARTIFACTS) {
    const made = await store.add({ chatId, title: item.title, kind: item.kind, content: item.content })
    for (let at = 1; at < item.versions; at++) {
      await store.update(made.id, `${item.content}\n<!-- v${at + 1} -->`, { chatId })
    }
  }
  const listed = await store.list({ chatId })
  if (listed.length !== ARTIFACTS.length) {
    throw new Error(`Профиль прогона принял ${listed.length} артефактов вместо ${ARTIFACTS.length}`)
  }
}

function launch (frame) {
  const resultFile = path.join(out, `${frame.name}.json`)
  const shot = path.join(out, `ultra-audit-${frame.name}.png`)
  const saved = uiConfig.save(profile, CONFIG.ultra)
  if (!saved.ok) throw new Error(`Профиль прогона не принял конфигурацию: ${saved.error}`)
  const args = { mode: frame.mode, lang: frame.lang, chatId, titles: TITLES }
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'ultra-audit-renderer.js'),
          ONECODE_SMOKE_OUT: resultFile,
          ONECODE_SHOT: shot,
          ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
        })
      })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Окно «${frame.name}» не отчиталось за 240 с`))
    }, 240000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (!fs.existsSync(resultFile)) {
        console.error(`ПРОВАЛ [${frame.name}]: окно не отчиталось (status ${code})`)
        resolve({ ok: false, checks: [], found: [], shot: false })
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

// Таблица находок: одна строка на ошибку, колонки как в отчёте.
function printFindings (results) {
  const rows = []
  for (const [frame, one] of results) {
    for (const item of one.found || []) {
      rows.push({ frame, where: item.where, name: item.name, detail: item.detail })
    }
  }
  console.log('')
  console.log('НАХОДКИ U-5 — где · что · что вышло')
  console.log('================================')
  if (!rows.length) {
    console.log('Находок нет: все восемь сценариев Ultra прошли по RU и EN.')
    return rows
  }
  let lastFrame = ''
  for (const row of rows) {
    if (row.frame !== lastFrame) { console.log(''); console.log('кадр ' + row.frame); lastFrame = row.frame }
    console.log(`  где: ${row.where}`)
    console.log(`    что: ${row.name}`)
    console.log(`    вышло: ${row.detail}`)
  }
  console.log('')
  console.log(`всего находок: ${rows.length}`)
  return rows
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
  const rows = printFindings(results)
  const ok = results.every(([, one]) => one.ok) && total > 0 && shots === results.length && rows.length === 0
  console.log('')
  console.log(`Проход Ultra — сценариев 9, кадров ${results.length}, снимков ${shots}, проверок ${total}, успешно ${passed}`)
  console.log(`находок: ${rows.length}`)
  console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'U-5: полный проход Ultra живым окном пройден, ошибок не найдено'
    : `U-5 не закрыт: находок ${rows.length}, разбор — в таблице выше`)
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
})
