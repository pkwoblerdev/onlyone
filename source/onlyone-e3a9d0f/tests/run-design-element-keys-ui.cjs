// Клавиши живого превью Design: Delete/Backspace, Escape и Ctrl+Z.
//
// Узловые проверки (`test-design-element-undo.cjs`, `test-design-preview-engine.cjs`)
// отвечают за хранитель версий и за внедряемый в кадр движок. Этот прогон
// проверяет связку целиком на настоящем окне: сообщение из настоящего кадра,
// настоящее нажатие в настоящем документе и настоящее модальное подтверждение.
//
// Фикстура соседняя, `design-flow-fixture.json`: ход Дизайна в smoke-режиме
// исполняет настоящий `dc_write`, и на диске остаётся настоящий компонент.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const dir = runDir('onlyone-design-keys-ui')
const out = path.join(dir, 'checks.json')

// Сценарий поднимает настоящий Electron, и на занятой машине — когда сразу за
// ним идут остальные наборы — окно не всегда успевает подняться в срок. Это
// свойство запуска, а не проверок, поэтому таймаут даётся один раз повторно.
// Любой другой сбой пробрасывается сразу, а не превращается в «красный тест».
function launch (attempt) {
  return spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile' + attempt)], {
      cwd: root, timeout: 240000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_DESIGN_FLOW: '1',
        ONECODE_SMOKE: path.join(__dirname, 'design-element-keys-renderer.js'),
        ONECODE_SMOKE_FIXTURE: path.join(__dirname, 'design-flow-fixture.json'),
        ONECODE_SMOKE_OUT: out,
        ONECODE_SHOT: path.join(dir, 'design-keys.png')
      })
    })
}

let child = launch(1)
if (child.error?.code === 'ETIMEDOUT' && !fs.existsSync(out)) {
  console.error('Окно не успело отчитаться за 240 с — повторяю один раз.')
  child = launch(2)
}
if (child.error) {
  if (child.error.code === 'ETIMEDOUT') {
    console.error('Окно не отчиталось и со второй попытки. Это не провал проверок ' +
      'Design: сценарий поднимает настоящий Electron, и запуск не уложился в лимит.')
  }
  throw child.error
}
if (!fs.existsSync(out)) throw new Error('Нет отчёта клавиатурного прогона Design')

const report = JSON.parse(fs.readFileSync(out, 'utf8'))
const ok = report.ok && child.status === 0
console.log(JSON.stringify({ ...report, output: dir }, null, 2))
// Зелёный прогон по общему правилу репозитория не оставляет после себя гигабайт
// профиля. Кадр при этом остаётся доказательством: без него «проверки зелёные»
// неотличимо от «проверки смотрели не туда». Каталог для копии задаётся явно —
// обычно это audits/<кто>-<дата>/, и только там.
const keep = process.env.ONECODE_RUN_EVIDENCE
if (keep && fs.existsSync(dir)) {
  fs.mkdirSync(keep, { recursive: true })
  for (const artifact of ['checks.json', 'design-keys.png']) {
    const source = path.join(dir, artifact)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(keep, artifact))
  }
  console.error('ДОКАЗАТЕЛЬСТВА СОХРАНЕНЫ: ' + keep)
}
// Красный прогон оставляет каталог: без профиля, кадра и вердикта «плавающее»
// звено разбирается неделями.
settleRun(dir, ok)
process.exit(ok ? 0 : 1)
