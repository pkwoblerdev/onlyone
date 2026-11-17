// 9.8, шаг 2 (проводка): ffmpeg доходит до агента и до человека.
//
// Сам поиск и проба кодеров проверены в test-ffmpeg-tools; здесь — что модуль
// подключён: агент видит `ffmpeg_info` и `ffmpeg_install`, короткое `ffmpeg` в
// его командах работает (PATH), окно показывает состояние и умеет поставить.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const main = read('src', 'main', 'main.js')
const preload = read('src', 'preload', 'preload.js')
const html = read('src', 'renderer', 'index.html')
const app = read('src', 'renderer', 'app.js') + read('src', 'renderer', 'video-settings.js')
const checkpoints = read('src', 'main', 'run-checkpoints.js')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

test('инструменты заявлены, подписаны и подключены в executeTool', () => {
  for (const name of ['ffmpeg_info', 'ffmpeg_install']) {
    assert.ok(main.includes(`name: '${name}'`), `нет схемы ${name}`)
    assert.ok(new RegExp(`${name}: '`).test(main), `${name} без подписи в TOOL_VERBS`)
    assert.match(main, new RegExp(`if \\(name === '${name}'\\) return await`), `${name} не подключён`)
  }
})

test('установка ffmpeg идёт через подтверждение человека и отказывает в режиме «План»', () => {
  const body = /async function installFfmpegTool\([\s\S]*?\r?\n}\r?\n/.exec(main)
  assert.ok(body, 'не найдена функция installFfmpegTool')
  assert.match(body[0], /planModeRefusal\(/)
  assert.match(body[0], /requireMutationApproval\(/)
  assert.match(body[0], /ffmpegTools\(\)\.install\(/)
})

test('run_command получает каталог ffmpeg в PATH', () => {
  const body = /async function runWorkspaceCommand\([\s\S]*?\r?\n}\r?\n/.exec(main)
  assert.ok(body)
  assert.match(body[0], /ffmpegTools\(\)\.envWithTools\(env\)/)
})

test('ffmpeg_info в списке инструментов без последствий', () => {
  assert.match(checkpoints, /'ffmpeg_info'/)
})

test('мост окна и обработчики главного процесса совпадают', () => {
  for (const [method, channel] of [['getFfmpegStatus', 'ffmpeg-status'], ['installFfmpeg', 'ffmpeg-install']]) {
    assert.match(preload, new RegExp(`${method}:[^\\n]*ipcRenderer\\.invoke\\('${channel}'`), `нет моста ${method}`)
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `нет обработчика ${channel}`)
    assert.ok(app.includes(method), `окно не зовёт ${method}`)
  }
})

test('в Настройках есть блок «Видео» с состоянием и кнопкой установки', () => {
  assert.match(html, /id="videoToolsStatus"/)
  assert.match(html, /id="btnFfmpegInstall"/)
})

test('подсказка режима объясняет путь «отрендерил → показал»', () => {
  const { build } = require('../src/main/mode-prompts/artifacts')
  const text = build({ toolNames: ['show_artifact', 'show_video', 'ffmpeg_info', 'run_command'] })
  assert.match(text, /show_video/)
  assert.match(text, /ffmpeg_info/)
  assert.match(text, /1080/)
})

if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
console.log('\nВсе проверки проводки ffmpeg пройдены')
