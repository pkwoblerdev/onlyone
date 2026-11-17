// Состояния панели артефактов в настоящем окне (план, 3.2): загрузка, готово,
// список версий, правка, таблица, ошибка, закрытие по Escape с возвратом фокуса.
// Первый прогон проверяет поведение, дальше — по одному снимку на состояние:
// проверка структуры не говорит, как панель выглядит, а без снимков нечем это
// сверять (правило 5). Снимки можно сохранить через ONECODE_EVIDENCE_DIR.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { create } = require('../src/main/artifacts')

const root = path.join(__dirname, '..')
const evidence = process.env.ONECODE_EVIDENCE_DIR
const out = runDir('1code-artifacts-ui')
const profile = path.join(out, 'profile')

const LONG_TITLE = 'Страница «Пальмы» — заголовок, три карточки и подвал с источниками данных'
// Диалог, под который заводятся артефакты. Ряд кнопок артефакта принадлежит
// открытому диалогу (Н79), поэтому этого же id диалог засевается в историю окна
// и открывается там кликом — иначе каждый прогон стоял бы с пустым рядом.
const CHAT_ID = 'ui'

// Один запуск окна: скрипт, его аргументы и снимок в конце проверки.
function launch(name, script, args, shot) {
  const resultFile = path.join(out, name + '.json')
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, timeout: 180000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: path.join(__dirname, script),
      ONECODE_SMOKE_OUT: resultFile,
      ...(shot ? { ONECODE_SHOT: shot } : {}),
      // Аргументы — base64: подстановка JSON прямо в строковый литерал скрипта
      // ломается на кавычках и переводах строк в содержимом артефактов.
      ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
    })
  })
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось: ' + name + ' (status ' + child.status + ')')
    return { ok: false, checks: [] }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error('ПРОВАЛ ' + name + ': окно сообщило об ошибке — ' + report.error)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''))
  }
  if (evidence && shot && fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, path.basename(shot)))
  }
  return report
}

async function main() {
  const store = create({ dir: path.join(profile, 'artifacts') })
  const page = await store.add({ chatId: CHAT_ID, title: 'Пальмы', kind: 'page', content: '<h1>до правки</h1>' })
  const table = await store.add({ chatId: CHAT_ID, title: 'Тарифы', kind: 'table', content: 'план,цена\nстарт,0' })
  const chart = await store.add({ chatId: CHAT_ID, title: 'Заказы по неделям', kind: 'chart', content: JSON.stringify({
    type: 'bar', title: 'Заказы по неделям', xLabel: 'Неделя', yLabel: 'Заказы',
    categories: ['1', '2', '3', '4'], series: [{ name: 'Факт', values: [4, 7, 5, 9] }]
  }) })
  const broken = await store.add({ chatId: CHAT_ID, title: 'Потерянный', kind: 'code', content: 'x' })
  const note = await store.add({ chatId: CHAT_ID, title: 'Заметка', kind: 'code', content: 'const a = 1\nconsole.log(a)' })
  const long = await store.add({ chatId: CHAT_ID, title: LONG_TITLE, kind: 'page', content: '<p>длинное имя</p>' })
  // Версия, которой на диске нет: панель обязана сказать это словами, а не
  // показать пустоту.
  fs.rmSync(path.join(store.folderOf(broken.id), '1-source'))

  const ids = { page: page.id, table: table.id, chart: chart.id, broken: broken.id, note: note.id, long: long.id }
  // Ряд кнопок наполняется под ОТКРЫТЫЙ диалог (Н79), поэтому первым запуском
  // прогон заводит в историю диалог `CHAT_ID` штатным каналом окна и открывает
  // его кликом: с подъёма окна открыт свой, свежий, и его ряд пуст.
  let ok = launch('посев диалога', 'artifact-chat-seed.js',
    { chatId: CHAT_ID, artifactIds: Object.values(ids) }, path.join(out, 'artifact-chat-seed.png')).ok
  ok = launch('проверки', 'artifacts-smoke-renderer.js', { ...ids, chatId: CHAT_ID },
    path.join(out, 'artifacts-panel.png')).ok && ok

  const made = []
  // Вид артефакта указывается для каждого состояния: ряд наполняется событием,
  // и без ожидания «нужного» артефакта проверка успевает щёлкнуть по тому, что
  // показался первым.
  for (const [mode, file, extra] of [
    ['page', 'artifacts-state-page.png', { id: ids.page, kind: 'page', content: '<h1 style="font-family:Georgia">Пальмы</h1><p>Заголовок и три карточки.</p>' }],
    ['table', 'artifacts-state-table.png', { id: ids.table, kind: 'table', content: 'план,цена,что входит\nстарт,0,три карточки\nбизнес,9900,всё выше плюс поддержка' }],
    ['chart', 'artifacts-state-chart.png', { id: ids.chart, kind: 'chart', content: JSON.stringify({
      type: 'line', title: 'Выручка по неделям', xLabel: 'Неделя', yLabel: 'Рубли', unit: '₽',
      categories: ['1', '2', '3', '4', '5', '6', '7'],
      series: [{ name: 'Факт', values: [120, 180, 160, 240, 310, 290, 420] },
        { name: 'План', values: [100, 150, 200, 220, 270, 330, 380] }]
    }) }],
    ['text', 'artifacts-state-text.png', { id: ids.note, kind: 'code' }],
    ['error', 'artifacts-state-error.png', { id: ids.broken, kind: 'code' }],
    // Правка — по текстовым видам; страница ей не правится (её правят в
    // самом документе), поэтому состояние собирается на таблице.
    ['edit', 'artifacts-state-edit.png', { id: ids.table, kind: 'table', content: 'план,цена\nстарт,0\nбизнес,9900' }],
    ['menu', 'artifacts-state-menu.png', { id: ids.page, kind: 'page', content: '<h1>Пальмы</h1><p>Заголовок и три карточки.</p>' }],
    ['expanded', 'artifacts-state-expanded.png', { id: ids.page, kind: 'page', content: '<h1>Пальмы</h1><p>Заголовок и три карточки.</p>' }]
  ]) {
    const shot = path.join(out, file)
    ok = launch(mode, 'artifacts-state-renderer.js', { ...ids, chatId: CHAT_ID, mode, ...extra }, shot).ok && ok
    if (fs.existsSync(shot)) made.push(file)
  }
  console.log('снимки состояний: ' + (made.length ? made.join(', ') : 'не созданы'))

  console.log((ok ? 'Панель артефактов работает' : 'Есть ошибки в панели артефактов'))
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => { console.error('ПРОВАЛ', error.message); settleRun(out, false); process.exitCode = 1 })
