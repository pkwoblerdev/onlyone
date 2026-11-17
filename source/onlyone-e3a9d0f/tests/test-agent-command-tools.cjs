// 6.1: run_command и search_files должны быть подключены, а не просто существовать.
// Сам механизм проверки — в test-command-guard.cjs и test-workspace-search.cjs;
// здесь — проводка: схема, диспетчер, права, подпись в ленте.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agent-quality.js'), 'utf8')
// Подписи вызовов рисует модуль блоков ленты (план, 2d): берём весь код окна.
const renderer = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))

test('оба инструмента заявлены модели', () => {
  for (const name of ['run_command', 'search_files']) {
    assert.ok(main.includes(`name: '${name}'`), `нет схемы ${name}`)
  }
})

test('вызов доходит до реализации', () => {
  assert.match(main, /if \(name === 'search_files'\) return await searchWorkspaceFiles/, 'search_files не подключён в executeTool')
  assert.match(main, /if \(name === 'run_command'\) return await runWorkspaceCommand/, 'run_command не подключён в executeTool')
  for (const name of ['run_command', 'search_files']) {
    assert.ok(new RegExp(`${name}: '`).test(main), `${name} без человеческой подписи в TOOL_VERBS`)
  }
})

test('поиск — чтение, команда — нет', () => {
  const readOnly = /function toolAllowedForAssignment[\s\S]*?return new Set\(\[([\s\S]*?)\]\)\.has/.exec(quality)
  assert.ok(readOnly, 'не найден список разрешённого для части только на чтение')
  const allowed = readOnly[1]
  assert.ok(allowed.includes("'search_files'"), 'search_files должен быть доступен проверяющему без права записи')
  assert.ok(!allowed.includes("'run_command'"), 'run_command обязан оставаться у тех, кому разрешено изменение')
})

test('команда не обходит режим плана и спрашивает как запись файла', () => {
  const body = /async function runWorkspaceCommand\([\s\S]*?\n}\n/.exec(main)
  assert.ok(body, 'не найден runWorkspaceCommand')
  const code = body[0]
  assert.match(code, /planModeRefusal\('запуск команды'\)/, 'в режиме «План» команда обязана отклоняться')
  assert.match(code, /assertSafeWorkspacePath/, 'папка запуска обязана проходить те же ворота, что файлы')
  assert.match(code, /commandGuard\.checkCommand/, 'правила владельца не подключены')
  assert.match(code, /requireMutationApproval\([\s\S]*?'edit'/, 'подтверждение — как у записи файла, не тише')
  assert.match(code, /commandRunner\.run\(/, 'исполнение не делегировано модулю, который проверяется отдельно')
})

test('процесс снимается целиком, а не только cmd', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'command-runner.js'), 'utf8')
  assert.match(runner, /'\/T', '\/F'/, 'на Windows надо снимать всё дерево: без /T npm остаётся и продолжает писать в проект')
})

test('в ленте чата — русская подпись, а не имя из протокола', () => {
  for (const name of ['run_command', 'search_files']) {
    assert.ok(renderer.includes(`tool === '${name}'`), `${name}: в ленте попадёт сырое имя инструмента`)
  }
})

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
