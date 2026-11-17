// Оконный прогон Н79: ряд кнопок артефакта перестраивается под чат события, а
// не под открытый чат (план работ, узел «Н79»). Три запуска одним профилем:
//  1. 'setup'   — штатным путём окна заводит два диалога с фиксированными id;
//  2. 'bg'      — правка артефакта в ФОНОВОМ диалоге: ряд открытого обязан
//                 остаться прежним. Это красное звено дефекта;
//  3. 'open'    — новый артефакт открытого диалога ложится на диск во время
//                 прогона: ряд обязан вырасти. Кадр — в конечном состоянии.
// Артефакты заводятся настоящим хранилищем в папке профиля до прогона (как у
// соседей `run-artifacts-ui.cjs` и `run-artifact-gallery-ui.cjs`); сеть и ключи
// прогону не нужны — ход модели не отправляется, ряд наполняется каналами
// правки артефакта и выбором чата.
// Снимки и вердикты копируются в ONECODE_EVIDENCE_DIR (путь вида D:/…).
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { create } = require('../src/main/artifacts')

const out = runDir('onlyone-artifact-chips')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

const OPEN_ID = 'n79-open-chip'
const BG_ID = 'n79-bg-chip'
const GROW_TITLE = 'Сводка прогона'
// Через сколько после подъёма окна водитель дописывает на диск новый артефакт
// открытого диалога: к этому времени проверка уже стоит на базовом ряде.
const GROW_AFTER_MS = 12000

const store = create({ dir: path.join(profile, 'artifacts') })

function toPosix (p) { return p.split(path.sep).join('/') }

function copyEvidence (files) {
  if (!evidence) return
  fs.mkdirSync(evidence, { recursive: true })
  const copied = []
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const target = path.join(evidence, path.basename(file))
    fs.copyFileSync(file, target)
    copied.push(toPosix(target))
  }
  if (copied.length) console.error('ДОКАЗАТЕЛЬСТВА: ' + copied.join(', '))
}

// Один запуск окна; отчёт читается после выхода. retry — свойства старта на
// занятой машине (образец: сосед `run-artifact-gallery-ui.cjs`).
function launchSync ({ name, script, args, shot, attempt = 1 }) {
  const report = path.join(out, name + '.json')
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
      cwd: root, timeout: 240000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, script),
        ONECODE_SMOKE_OUT: report,
        ...(shot ? { ONECODE_SHOT: shot } : {}),
        ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
      })
    })
  if (child.error?.code === 'ETIMEDOUT' && !fs.existsSync(report)) {
    console.error('Старт окна не уложился в срок — попытка ' + attempt + ' повторяется')
    return launchSync({ name, script, args, shot, attempt: attempt + 1 })
  }
  if (child.error) throw child.error
  if (!fs.existsSync(report)) throw new Error('Нет отчёта прогона: ' + path.basename(report))
  const result = JSON.parse(fs.readFileSync(report, 'utf8'))
  for (const item of result.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''))
  }
  if (shot) copyEvidence([report, shot])
  else copyEvidence([report])
  return { ok: Boolean(result.ok) && child.status === 0, result }
}

// Запуск с работой посредине: окно открыто, водитель дописывает артефакт на
// диск, проверка ждёт роста ряда. spawnSync тут не годится — он блокирует
// водителя ровно до выхода окна.
function launchAsync ({ name, script, args, shot, mid }) {
  const report = path.join(out, name + '.json')
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, script),
          ONECODE_SMOKE_OUT: report,
          ...(shot ? { ONECODE_SHOT: shot } : {}),
          ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
        })
      })
    const growTimer = setTimeout(() => {
      mid().catch(error => console.error('посев середины прогона не вышел: ' + error.message))
    }, GROW_AFTER_MS)
    const watchdog = setTimeout(() => {
      console.error('окно не вышло за 240 с — прогон прерван')
      try { child.kill() } catch { /* уже вышел */ }
    }, 240000)
    child.on('error', error => { clearTimeout(growTimer); clearTimeout(watchdog); reject(error) })
    child.on('close', code => {
      clearTimeout(growTimer); clearTimeout(watchdog)
      if (!fs.existsSync(report)) {
        console.error('Окно не отчиталось: ' + name + ' (status ' + code + ')')
        resolve({ ok: false, result: { checks: [] } })
        return
      }
      const result = JSON.parse(fs.readFileSync(report, 'utf8'))
      for (const item of result.checks || []) {
        console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''))
      }
      if (shot) copyEvidence([report, shot])
      else copyEvidence([report])
      resolve({ ok: Boolean(result.ok) && code === 0, result })
    })
  })
}

async function main () {
  // Артефакты открытого диалога — три, как в замере аудита; фоновый — один,
  // со своим заголовком, чтобы подмену ряда было видно по содержимому кнопки.
  const a1 = await store.add({ chatId: OPEN_ID, title: 'Заявка', kind: 'code', content: 'const a = 1' })
  const a2 = await store.add({ chatId: OPEN_ID, title: 'Тарифы', kind: 'code', content: 'const b = 2' })
  const a3 = await store.add({ chatId: OPEN_ID, title: 'Смета', kind: 'code', content: 'const c = 3' })
  const b1 = await store.add({ chatId: BG_ID, title: 'Фоновый отчёт', kind: 'code', content: 'const bg = 1' })
  const ids = { openId: OPEN_ID, bgId: BG_ID, ids: [a1.id, a2.id, a3.id], b1: b1.id }

  const script = 'artifact-chips-renderer.js'
  const runs = []

  runs.push(launchSync({ name: 'setup', script, args: { mode: 'setup', ...ids } }))

  runs.push(launchSync({
    name: 'bg', script, args: { mode: 'bg', ...ids },
    shot: path.join(out, 'artifact-chips-bg-event.png')
  }))

  const openRun = await launchAsync({
    name: 'open', script, args: { mode: 'open', ...ids },
    shot: path.join(out, 'artifact-chips-open-event.png'),
    mid: () => store.add({ chatId: OPEN_ID, title: GROW_TITLE, kind: 'code', content: 'итог прогона' })
  })
  runs.push(openRun)

  const ok = runs.every(run => run && run.ok)
  const checks = runs.map(run => (run && run.result && run.result.checks ? run.result.checks.length : 0))
  console.log(JSON.stringify({ ok, checks, output: toPosix(out), evidence: evidence ? toPosix(evidence) : null }, null, 2))
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error('ПРОВАЛ', (error && error.stack) || error)
  settleRun(out, false)
  process.exit(1)
})
