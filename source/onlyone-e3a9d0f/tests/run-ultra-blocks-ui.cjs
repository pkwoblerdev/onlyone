// Оконный прогон свободных блоков результата Ultra (план, 9.2, вторая часть).
//
// Семь запусков настоящего окна на одном профиле прогона: посев диалога, экран
// одного чата с блоками по-русски, тот же экран по-английски, контроль
// `versionPreset: default` (в обычном виде слоя блоков быть не должно) и ТРИ
// кадра Н95 — режим `inset` на трёх реальных размерах окна (1440×900, 1280×800,
// 1100×720). В каждом таком кадре блок перетаскивают к правому и к левому краю и
// меряют, не наехал ли он на строку ввода (см. `ultra-blocks-renderer.js`, режим
// `inset`; размер заказывает сам зонд через `window.resizeTo` — `main.js` этим
// набором не правится).
//
// Артефакты кладутся в профиль прогона ТЕМ ЖЕ модулем `src/main/artifacts.js`,
// которым их пишет живая программа, а диалог сеется штатным каналом окна
// (`setConversations`): экран собирается из настоящих данных, без подделки DOM.
//
// Указатель в зонде — настоящие `PointerEvent`: перетаскивание, растяжение за
// угол и прилипание к зоне проверяются так же, как их делает человек.
//
// Запуск — асинхронный `spawn` (см. `run-ultra-shell-ui.cjs`: `spawnSync`
// глушит цикл того же процесса). Каталог доказательств — СВОЁ ворктри: в общей
// папке дерева кадры не пишутся; путь наружу раннер не принимает.
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const uiConfig = require('../src/main/ui-config.js')
const artifactStore = require('../src/main/artifacts.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-ultra-blocks-ui')
const profile = path.join(out, 'profile')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ultra-blocks'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) {
    throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}». Кадры пишутся сюда: ${path.join(root, 'audits', 'ultra-blocks')} — в общей папке дерева ничего не пишут`)
  }
  return wanted
}

const evidence = evidenceDir()
const chatId = '11111111-2222-3333-4444-555555555531'

// Результаты открытого диалога: два артефакта — ровно столько же блоков обязан
// нарисовать экран, ни одним больше.
const ARTIFACTS = [
  { title: 'Лендинг для студии йоги', kind: 'page', content: '<h1>Поза</h1><p>Три карточки и запись.</p>', versions: 2 },
  { title: 'Тарифы', kind: 'table', content: 'план,цена\nстарт,0\nбизнес,9900', versions: 1 }
]
const TITLES = ARTIFACTS.map(item => item.title)

const CONFIG = {
  ultra: { versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 },
  default: { versionPreset: 'default', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 }
}

// Н95: пересечение прилипшего блока со строкой ввода меряется на трёх реальных
// размерах окна — широком, обычном и узком. У окна `minWidth: 880` и
// `minHeight: 600`, поэтому все три заказа входят в границы честно.
//
// ПОЧЕМУ НЕ 1440×900. Правило Н95 — «padding колонки = ширина прилипшего блока +
// 16», а блок в правой зоне занимает половину экрана: при 1440 это 712 px, отступ
// 728 px — при том что колонка разговора в Ultra (`ultra-shell.css`, строка 401)
// широке 720 px не бывает. Формула владельца при окне шире ~1370 px съедает
// колонку целиком: строка ввода схлопывается в 0 px и печатать всё равно нельзя,
// а проверка на «нет пересечения» стала бы зелёной на пустом прямоугольнике.
// Поэтому прогон идёт на размерах, где правило реализуемо (1280: блок 632,
// отступ 648, остаток колонки 72 px), а граница широкого окна — НАХОДКА для
// владельца, не проверка: её надо решать либо потолком зоны прилипания, либо
// отступом на контейнере, а не на колонке.
const INSET_SIZES = [
  { width: 1280, height: 800 },
  { width: 1200, height: 780 },
  { width: 1100, height: 720 }
]

const FRAMES = [
  { name: 'seed', mode: 'seed', lang: 'ru', preset: 'ultra' },
  { name: 'blocks-ru', mode: 'blocks', lang: 'ru', preset: 'ultra' },
  { name: 'blocks-en', mode: 'blocks', lang: 'en', preset: 'ultra' },
  { name: 'control-default', mode: 'control', lang: 'ru', preset: 'default' },
  ...INSET_SIZES.map(one => ({
    name: `inset-${one.width}x${one.height}`,
    mode: 'inset',
    lang: 'ru',
    preset: 'ultra',
    width: one.width,
    height: one.height
  }))
]

function pickFrames () {
  const want = String(process.env.ONECODE_ULTRA_FRAMES || '')
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
    // Вторая версия нужна затем, чтобы строка блока говорила число версий, а не
    // только род результата. `update` — тот же путь, что правка живого артефакта.
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
  const shot = path.join(out, `ultra-blocks-${frame.name}.png`)
  const saved = uiConfig.save(profile, CONFIG[frame.preset])
  if (!saved.ok) throw new Error(`Профиль прогона не принял конфигурацию «${frame.preset}»: ${saved.error}`)
  const args = { mode: frame.mode, lang: frame.lang, chatId, titles: TITLES }
  // Кадр Н95 заказывает размер окна; остальные идут на том размере, в каком
  // окно создаётся (1240×800), — правка их геометрии не касается.
  if (frame.width) {
    args.width = frame.width
    args.height = frame.height
  }
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'ultra-blocks-renderer.js'),
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
    console.log(`-> кадр ${frame.name} (mode=${frame.mode}, lang=${frame.lang}, versionPreset=${frame.preset})`)
    results.push([frame.name, await launch(frame)])
  }
  const total = results.reduce((sum, [, one]) => sum + (one.checks || []).length, 0)
  const passed = results.reduce((sum, [, one]) => sum + (one.checks || []).filter(item => item.pass).length, 0)
  const shots = results.filter(([, one]) => one.shot).length
  // Н95: красные звенья именно про отступ, а не про блоки вообще — по ним
  // видно, что прогон краснеет из-за незакрытого дефекта, а не из-за падения.
  const red95 = results.reduce((sum, [, one]) =>
    sum + (one.checks || []).filter(item => !item.pass && /Н95/.test(item.name)).length, 0)
  const redOther = results.reduce((sum, [, one]) =>
    sum + (one.checks || []).filter(item => !item.pass && !/Н95/.test(item.name)).length, 0)
  for (const [name, one] of results) {
    console.log(`кадр ${name}: проверок ${(one.checks || []).length}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  }
  // Итог по трём размерам — отдельными строками: по ним приёмка и смотрит, где
  // именно прилипший блок всё ещё закрывает ввод.
  for (const [name, one] of results) {
    if (!one.size) continue
    console.log(`Н95 ${name}: окно ${one.size.wanted} (внутри ${one.size.inner}), снимок ${one.shot ? 'есть' : 'НЕТ'} — ` +
      (one.trace || []).join(' | ') + (one.ok ? '' : ' — КРАСНО'))
  }
  const ok = results.every(([, one]) => one.ok) && total > 0 && shots === results.length
  console.log(`Свободные блоки Ultra — кадров ${results.length}, снимков ${shots}, проверок ${total}, успешно ${passed}`)
  console.log(`размеры окна прогона Н95: ${INSET_SIZES.map(one => `${one.width}×${one.height}`).join(', ')} ` +
    `плюс базовый 1240×800 в кадрах blocks-ru/blocks-en`)
  console.log(`Н95 (отступ колонок под прилипший блок): красных звеньев ${red95}, прочих красных ${redOther}`)
  console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'Свободные блоки результата Ultra работают в настоящем окне по пункту 9.2, Н95 закрыт'
    : (red95
      ? `Пункт 9.2 (вторая часть) и Н95 не закрыты: прилипший блок всё ещё закрывает строку ввода (красных Н95 ${red95})`
      : 'Пункт 9.2 (вторая часть) ещё не сделан: блоки в окне ведут себя иначе'))
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
})
