// Прогон галереи версий и выгрузки артефакта (план, 1.4).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { create } = require('../src/main/artifacts')

const out = runDir('onlyone-artifact-gallery')
const report = path.join(out, 'checks.json')
const profile = path.join(out, 'profile1')
// Диалог, под который заводятся артефакты. Ряд кнопок артефакта принадлежит
// открытому диалогу (Н79), поэтому этого же id диалог засевается в историю
// окна и открывается там кликом — иначе прогон стоял бы с пустым рядом.
const CHAT_ID = 'ui'

// Артефакты заводятся ДО запуска окна и в тот же профиль, что окно получит:
// так же делает соседний `run-artifacts-ui.cjs`. Окно не создаёт их через IPC —
// иначе прогон проверял бы только путь записи, а не галерею с историей.
async function seed () {
  const store = create({ dir: path.join(profile, 'artifacts') })
  const page = await store.add({ chatId: CHAT_ID, title: 'Галерея', kind: 'page', content: '<h1>Первая</h1>' })
  await store.update(page.id, '<h1>Вторая</h1>')
  const chart = await store.add({ chatId: CHAT_ID, title: 'Заказы по неделям', kind: 'chart', content: JSON.stringify({
    type: 'bar', title: 'Заказы по неделям', xLabel: 'Неделя', yLabel: 'Заказы',
    categories: ['1', '2', '3'], series: [{ name: 'Факт', values: [4, 7, 5] }]
  }) })
  // Артефакт, версии которого на диске нет: выгрузка обязана отказать ДО диалога
  // сохранения. Через него проверяется путь «клик → канал → главный процесс →
  // ответ в панель» — иначе прогон упёрся бы в модальное окно, которого машина
  // не видит.
  const broken = await store.add({ chatId: CHAT_ID, title: 'Потерянный файл', kind: 'code', content: 'const a = 1' })
  fs.rmSync(path.join(store.folderOf(broken.id), '1-source'), { force: true })
  return { chatId: CHAT_ID, page: page.id, chart: chart.id, broken: broken.id }
}
// Один запуск окна: свой скрипт, свой отчёт и свой снимок в конце. Снимок окно
// делает один — по завершении прогона, поэтому состояний ровно столько, сколько
// запусков.
async function launch ({ script, report, shot, ids, attempt }) {
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
      cwd: root, timeout: 240000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, script),
        ONECODE_SMOKE_OUT: report,
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify(ids), 'utf8').toString('base64')
      })
    })
  // Окно поднимается на занятой машине, и старт не всегда укладывается в срок —
  // это свойство запуска, а не проверок, поэтому он повторяется один раз.
  if (child.error?.code === 'ETIMEDOUT' && !fs.existsSync(report)) {
    console.error('Старт окна не уложился в срок — попытка ' + attempt + ' повторяется')
    return launch({ script, report, shot, ids, attempt: attempt + 1 })
  }
  if (child.error) throw child.error
  if (!fs.existsSync(report)) throw new Error('Нет отчёта прогона: ' + path.basename(report))
  const result = JSON.parse(fs.readFileSync(report, 'utf8'))
  for (const item of result.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + path.basename(script) + ' · ' + item.name +
      (item.detail ? ' — ' + item.detail : ''))
  }
  return { ok: Boolean(result.ok) && child.status === 0, result, report, shot }
}

async function main () {
  const ids = await seed()
  const runs = [
    // Диалог, под который подсечены артефакты, появляется в истории штатным
    // каналом окна и открывается кликом по строке: ряд кнопок принадлежит
    // открытому диалогу (Н79), а подъём окна приносит свой, пустой.
    await launch({
      script: 'artifact-chat-seed.js', report: path.join(out, 'seed.json'),
      shot: path.join(out, 'artifact-chat-seed.png'),
      ids: { ...ids, artifactIds: [ids.page, ids.chart, ids.broken] }, attempt: 1
    }),
    await launch({
      script: 'artifact-gallery-renderer.js', report,
      shot: path.join(out, 'artifact-gallery.png'), ids, attempt: 1
    }),
    // Отдельный запуск ради кадра: проверки заканчиваются отказом выгрузки, и на
    // снимке была бы пустая панель вместо галереи с меню форматов.
    await launch({
      script: 'artifact-gallery-shot.js',
      report: path.join(out, 'shot.json'),
      shot: path.join(out, 'artifact-gallery-menu.png'), ids, attempt: 1
    })
  ]
  const ok = runs.every(run => run.ok)
  console.log(JSON.stringify({ ok, checks: runs.map(run => run.result.checks?.length), output: out }, null, 2))
  // Зелёный прогон стирает свой каталог по общему правилу репозитория, но кадр и
  // вердикты остаются доказательством: без них «проверки зелёные» неотличимо от
  // «проверки смотрели не туда».
  const keep = process.env.ONECODE_RUN_EVIDENCE
  if (keep && fs.existsSync(out)) {
    fs.mkdirSync(keep, { recursive: true })
    for (const artifact of ['checks.json', 'shot.json', 'seed.json',
      'artifact-gallery.png', 'artifact-gallery-menu.png', 'artifact-chat-seed.png']) {
      const source = path.join(out, artifact)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(keep, artifact))
    }
    console.error('ДОКАЗАТЕЛЬСТВА СОХРАНЕНЫ: ' + keep)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('ПРОВАЛ', error?.message || error)
  settleRun(out, false)
  process.exit(1)
})
