// 9.8, шаги 3–4 (проводка): агент разбирает референс, скачивает ссылку, собирает ролик.
//
// Сами разборщики и рендер проверены в test-video-render; здесь — что они подключены:
// инструменты заявлены и доходят до выполнения, каждое опасное действие идёт через
// подтверждение и режим «План», рендер виден в Центре задач с долей и кнопкой
// отмены, лист кадров уходит модели с глазами, готовый ролик сам появляется в панели.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
const main = read('src', 'main', 'main.js')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}
const fn = name => {
  const found = new RegExp(`async function ${name}\\([\\s\\S]*?\\r?\\n}\\r?\\n`).exec(main)
  assert.ok(found, `не найдена функция ${name}`)
  return found[0]
}

test('инструменты заявлены, подписаны и подключены', () => {
  for (const name of ['video_analyze', 'video_render', 'video_download', 'video_render_html']) {
    assert.ok(main.includes(`name: '${name}'`), `нет схемы ${name}`)
    assert.ok(new RegExp(`${name}: '`).test(main), `${name} без подписи в TOOL_VERBS`)
    assert.match(main, new RegExp(`if \\(name === '${name}'\\) return await`), `${name} не подключён`)
  }
})

test('ffmpeg_install умеет ставить и yt-dlp', () => {
  assert.match(main, /name: 'ffmpeg_install'[\s\S]{0,900}tool: \{ type: 'string', enum: \['ffmpeg', 'yt-dlp'\]/)
  assert.match(fn('installFfmpegTool'), /install\(tool\)/)
})

test('рендер: режим «План», подтверждение, Центр задач с долей и отменой, показ результата', () => {
  for (const name of ['renderVideoTool', 'renderHtmlVideoTool']) {
    const body = fn(name)
    assert.match(body, /planModeRefusal\(/, name)
    assert.match(body, /requireMutationApproval\(/, name)
    assert.match(body, /startRenderTask\(/, name)
    assert.match(body, /finishRenderTool\(/, name)
    assert.match(body, /assertSafeWorkspacePath\(/, name)
  }
  const task = /function startRenderTask\([\s\S]*?\r?\n}\r?\n/.exec(main)
  assert.ok(task, 'нет startRenderTask')
  assert.match(task[0], /taskManager\.add\(/)
  assert.match(task[0], /taskManager\.setProgress\(/)
  assert.match(task[0], /kill\(\)/, 'отмена из Центра задач снимает рендер')
  const finish = /async function finishRenderTool\([\s\S]*?\r?\n}\r?\n/.exec(main)
  assert.ok(finish, 'нет finishRenderTool')
  assert.match(finish[0], /showVideo\(/, 'готовый ролик сам появляется в панели')
})

test('рендер страницы: закрытое окно, часы, только файлы рабочих папок', () => {
  const body = fn('renderHtmlVideoTool')
  assert.match(body, /roots: workspaceRoots\(\)/)
  assert.match(body, /htmlVideoLib\.renderHtml\(/)
  const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'html-video.js'), 'utf8')
  assert.match(lib, /sandbox: true/)
  assert.match(lib, /nodeIntegration: false/)
  assert.match(lib, /contextIsolation: true/)
  assert.match(lib, /addScriptToEvaluateOnNewDocument/)
  assert.match(lib, /onBeforeRequest/)
})

test('скачивание: подтверждение, режим «План», только в рабочую папку', () => {
  const body = fn('downloadVideoTool')
  assert.match(body, /planModeRefusal\(/)
  assert.match(body, /requireMutationApproval\(/)
  assert.match(body, /assertSafeWorkspacePath\(/)
  assert.match(body, /ffmpegTools\(\)\.download\(/)
})

test('разбор: путь только из рабочей папки, кэш листа — вне проекта', () => {
  const body = fn('analyzeVideoTool')
  assert.match(body, /assertSafeWorkspacePath\(/)
  assert.match(body, /video-analysis/, 'лист кадров лежит в userData, а не в проекте человека')
  assert.match(body, /sheetDataUrl/)
})

test('лист кадров уходит следующей репликой модели с глазами и вырезается из результата', () => {
  assert.match(main, /toolName === 'video_analyze' && result\.success \? result\.sheetDataUrl/)
  assert.match(main, /sheetDataUrl: undefined/)
  assert.match(main, /if \(sheetUrl\) \{[\s\S]{0,900}inputModalities/)
})

test('в дизайн-ходе видеоинструменты недоступны (барьер — белый список)', () => {
  const guard = /if \(design && !\[([^\]]*)\]\.includes\(name\)\) throw/.exec(main)
  assert.ok(guard)
  for (const name of ['video_analyze', 'video_render', 'video_render_html', 'video_download', 'show_video', 'ffmpeg_info', 'ffmpeg_install']) {
    assert.ok(!guard[1].includes(name), `${name} просочился в дизайн-ход`)
  }
})

test('подсказка режима называет весь путь: скачать → разобрать → собрать → показать', () => {
  const { build } = require('../src/main/mode-prompts/artifacts')
  const text = build({ toolNames: ['show_artifact', 'show_video', 'ffmpeg_info', 'video_analyze', 'video_render', 'video_render_html', 'video_download', 'run_command'] })
  for (const word of ['video_download', 'video_analyze', 'video_render', 'video_render_html', 'show_video']) assert.match(text, new RegExp(word))
})

if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
console.log('\nВсе проверки проводки видео пройдены')
