// Оконный прогон U-6: наложение символов и текста в Ultra.
//
// Семь запусков настоящего окна на одном профиле прогона: посев диалога, вход
// Ultra, экран одного чата с блоками по-русски и по-английски, свёрнутый блок
// (пилюля), убранный блок (кнопка возврата) и узкое окно 1100×720. Наложение
// зависит от ширины, поэтому последний кадр — отдельный размер, а не тот же
// экран по-другому.
//
// Артефакты кладутся в профиль прогона ТЕМ ЖЕ модулем `src/main/artifacts.js`,
// которым их пишет живая программа, а диалог сеется штатным каналом окна
// (`setConversations`): экран собирается из настоящих данных, без подделки DOM.
//
// Запуск — асинхронный `spawn`: `spawnSync` заглушил бы цикл событий родителя,
// и окно не дождалось бы собственного отчёта. Каталог доказательств — СВОЁ
// ворктри: в общей папке дерева кадры не пишутся.
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const uiConfig = require('../src/main/ui-config.js')
const artifactStore = require('../src/main/artifacts.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-ultra-overlap-ui')
const profile = path.join(out, 'profile')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ultra-overlap'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) {
    throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}». Кадры пишутся сюда: ${path.join(root, 'audits', 'ultra-overlap')} — в общей папке дерева ничего не пишут`)
  }
  return wanted
}

const evidence = evidenceDir()
const chatId = '6b1c9d40-2f77-4a51-9c3e-0d5a1b7e2210'

// Три результата: у первого — версии, чтобы шапка блока была самой длинной
// строкой в слое. Самая длинная подпись и самая короткая кнопка рядом — тот
// случай, где наложение и появляется.
const ARTIFACTS = [
  { title: 'Лендинг для студии йоги с расписанием и формой записи', kind: 'page', content: '<h1>Поза</h1><p>Три карточки и запись.</p>', versions: 3 },
  { title: 'Тарифы', kind: 'table', content: 'план,цена\nстарт,0\nбизнес,9900', versions: 1 },
  { title: 'Смета по проекту «Поза»', kind: 'diff', content: '- было\n+ стало', versions: 2 }
]
const TITLES = ARTIFACTS.map(item => item.title)

const CONFIG = {
  ultra: { versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 },
  default: { versionPreset: 'default', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 }
}

const FRAMES = [
  { name: 'seed', mode: 'seed', lang: 'ru', preset: 'ultra' },
  { name: 'entry', mode: 'entry', lang: 'ru', preset: 'ultra' },
  { name: 'chat-ru', mode: 'chat', lang: 'ru', preset: 'ultra' },
  { name: 'chat-en', mode: 'chat', lang: 'en', preset: 'ultra' },
  { name: 'block-min', mode: 'min', lang: 'ru', preset: 'ultra' },
  { name: 'block-closed', mode: 'closed', lang: 'ru', preset: 'ultra' },
  { name: 'chat-narrow', mode: 'chat', lang: 'ru', preset: 'ultra', width: 1100, height: 720 },
  { name: 'chat-min', mode: 'chat', lang: 'ru', preset: 'ultra', width: 880, height: 600 },
  // Масштаб 150 % — отдельный кадр не по размеру окна, а по масштабу. На
  // Windows это штатная настройка «Масштаб и разметка», и жалоба владельца
  // («значки накладываются») на таком экране выглядит совсем иначе, чем на
  // 100 %: там, где CSS-пиксель один, физических пикселей полтора. Electron
  // принимает `--force-device-scale-factor`, и зонд проверяет, что раскладка
  // Ultra пережила масштаб, а не только смену ширины окна.
  { name: 'entry-scaled', mode: 'entry', lang: 'ru', preset: 'ultra', scale: 1.5 },
  { name: 'chat-scaled', mode: 'chat', lang: 'ru', preset: 'ultra', scale: 1.5 }
]

function pickFrames () {
  const want = String(process.env.ONECODE_OVERLAP_FRAMES || '')
    .split(',').map(name => name.trim()).filter(Boolean)
  if (!want.length) return FRAMES
  const unknown = want.filter(name => !FRAMES.some(frame => frame.name === name))
  if (unknown.length) throw new Error('Кадров нет в списке: ' + unknown.join(', '))
  const chosen = want.map(name => FRAMES.find(frame => frame.name === name))
  if (!chosen.some(frame => frame.mode === 'seed')) return [FRAMES[0], ...chosen]
  return chosen
}

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
  const shot = path.join(out, `ultra-overlap-${frame.name}.png`)
  const saved = uiConfig.save(profile, CONFIG[frame.preset])
  if (!saved.ok) throw new Error(`Профиль прогона не принял конфигурацию «${frame.preset}»: ${saved.error}`)
  const args = { mode: frame.mode, lang: frame.lang, chatId, titles: TITLES }
  if (frame.width) {
    args.width = frame.width
    args.height = frame.height
  }
  if (frame.scale) args.scale = frame.scale
  // Масштаб экрана задаётся переключателем самого окна, а не стилем: иначе
  // получится подделка, а проверка должна мерить то, что видит человек.
  const switches = ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`]
  if (frame.scale) switches.push(`--force-device-scale-factor=${frame.scale}`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), switches, {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'ultra-overlap-renderer.js'),
          ONECODE_SMOKE_OUT: resultFile,
          ONECODE_SHOT: shot,
          ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
        })
      })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Окно «${frame.name}» не отчиталось за 180 с`))
    }, 180000)
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
      if (report.measure) {
        console.log(`       замер ${frame.name}: dpr ${report.measure.dpr}, прямоугольников ${report.measure.items}, ` +
          `наложений ${report.measure.overlaps}, скрытых слоем ${report.measure.covered}, ` +
          `тесного интервала ${report.measure.leading}, запрещённых перекрытий ${report.measure.banned}, ` +
          `поверх ленты ${report.measure.overFeed}`)
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
  const frames = pickFrames()
  const results = []
  for (const frame of frames) {
    console.log(`-> кадр ${frame.name} (mode=${frame.mode}, lang=${frame.lang}, versionPreset=${frame.preset}` +
      (frame.width ? `, ${frame.width}×${frame.height}` : '') + ')')
    results.push([frame.name, await launch(frame)])
  }
  const total = results.reduce((sum, [, one]) => sum + (one.checks || []).length, 0)
  const passed = results.reduce((sum, [, one]) => sum + (one.checks || []).filter(item => item.pass).length, 0)
  const shots = results.filter(([, one]) => one.shot).length
  const red = results.reduce((sum, [, one]) =>
    sum + (one.checks || []).filter(item => !item.pass).length, 0)
  for (const [name, one] of results) {
    console.log(`кадр ${name}: проверок ${(one.checks || []).length}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  }
  const ok = results.every(([, one]) => one.ok) && total > 0 && shots === results.length
  console.log(`Наложения в Ultra — кадров ${results.length}, снимков ${shots}, проверок ${total}, успешно ${passed}`)
  console.log(`красных проверок: ${red}`)
  console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'U-6: наложения символов и текста в Ultra на всех кадрах не найдены'
    : 'U-6 не закрыт: в Ultra есть наложения символов, разбор — в красных строках выше')
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
})
