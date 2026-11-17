// Проверка снимателя ссылки `node_modules` — того места, на котором 28.09
// потеряли общий каталог зависимостей: `cmd /c rmdir` в git bash молча не
// снял ссылку, `git worktree remove` провалился внутрь и вычистил каталог-цель.
//
// Тест не трогает репозиторий: он заводит временный «общий каталог» с файлами,
// делает на него ссылку как в ворктри и требует, чтобы после работы скрипта
// файлы остались. Это и есть та проверка, которой не хватило в тот вечер.
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const script = path.join(__dirname, '..', 'scripts', 'remove-worktree.cjs')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-remove-wt-'))

let failed = 0
const check = (name, fn) => {
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const link = (target, where) => {
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', where, target], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`система не дала создать ссылку: ${result.stderr || result.stdout}`)
}
const isJunction = target => {
  try { return fs.lstatSync(target).isSymbolicLink() } catch { return false }
}

// — «общий node_modules» с содержимым и «ворктри» со ссылкой на него.
const shared = path.join(base, 'shared-modules')
const wt = path.join(base, 'worktree')
fs.mkdirSync(path.join(shared, 'electron-store'), { recursive: true })
fs.writeFileSync(path.join(shared, 'electron-store', 'index.js'), 'маркер')
fs.writeFileSync(path.join(shared, 'marker.txt'), 'не трогать')
fs.mkdirSync(wt, { recursive: true })
link(shared, path.join(wt, 'node_modules'))

check('исходная картина собрана: ссылка есть, цель видна сквозь неё', () => {
  assert.equal(isJunction(path.join(wt, 'node_modules')), true)
  assert.equal(fs.existsSync(path.join(wt, 'node_modules', 'marker.txt')), true)
})

check('скрипт существует и снимает ссылку, не трогая общий каталог', () => {
  assert.equal(fs.existsSync(script), true, `нет файла ${script}`)
  const run = spawnSync(process.execPath, [script, wt, '--only-unlink'], { encoding: 'utf8' })
  assert.equal(run.status, 0, `код ${run.status}: ${run.stderr || run.stdout}`)
  assert.equal(isJunction(path.join(wt, 'node_modules')), false, 'ссылка осталась на месте')
  assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false, 'на месте ссылки что-то осталось')
  assert.equal(fs.readFileSync(path.join(shared, 'electron-store', 'index.js'), 'utf8'), 'маркер',
    'общий каталог пострадал')
  assert.equal(fs.readdirSync(shared).length, 2, 'из общего каталога что-то удалили')
})

check('без ссылки скрипт не считает каталог снятым и не лезет в него', () => {
  // Обычный каталог `node_modules` внутри ворктри — это чужая установка, а не
  // ссылка: удалять его должен человек, а не скрипт.
  fs.mkdirSync(path.join(wt, 'node_modules', 'обычный'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'node_modules', 'обычный', 'файл.txt'), 'x')
  const run = spawnSync(process.execPath, [script, wt, '--only-unlink'], { encoding: 'utf8' })
  assert.notEqual(run.status, 0, 'молча согласился снять настоящий каталог')
  assert.match(String(run.stderr || run.stdout), /не ссылк|не явля/,
    'отказ не объяснён: ' + String(run.stderr || run.stdout).slice(0, 160))
  assert.equal(fs.existsSync(path.join(wt, 'node_modules', 'обычный', 'файл.txt')), true,
    'файлы настоящего каталога удалены')
})

check('несуществующий путь — отказ, а не тихий успех', () => {
  const run = spawnSync(process.execPath, [script, path.join(base, 'нет-такого-ворктри'), '--only-unlink'],
    { encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(String(run.stderr || run.stdout), /не найден|нетsuch|не существует/i)
})

fs.rmSync(base, { recursive: true, force: true })
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
