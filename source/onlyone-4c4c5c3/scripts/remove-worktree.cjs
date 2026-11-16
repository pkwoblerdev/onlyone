// Удаляет git worktree так, чтобы не стереть общий `node_modules`.
//
// Однажды общий каталог зависимостей в исходниках опустел: ворктри снимали
// цепочкой «`cmd /c rmdir <ворктри>\node_modules` && `git worktree remove`»,
// первая команда в git bash напечатала баннер Windows и ссылку не сняла, а
// `git worktree remove` пошёл удалять дерево, провалился внутрь неснятой ссылки
// и вычистил каталог-цель. Поэтому: снимать ссылку, ПРОВЕРЯТЬ, что её больше
// нет, и только потом удалять ворктри. Настоящий каталог `node_modules` внутри
// ворктри — не ссылка: удалять его должен человек, а не скрипт.
//
// Запуск: node scripts/remove-worktree.cjs <путь к ворктри> [--only-unlink] [--force]
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))
const target = args.find(arg => !arg.startsWith('--'))
if (!target) {
  console.error('Не передан путь к ворктри. Пример: node scripts/remove-worktree.cjs worktrees/<ветка>/<задача>')
  process.exit(2)
}

const wt = path.resolve(target)
const fail = message => { console.error('Отказ: ' + message); process.exit(1) }

if (!fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) fail(`ворктри не найден: ${wt}`)

const modules = path.join(wt, 'node_modules')
const isLink = target => {
  try { return fs.lstatSync(target).isSymbolicLink() } catch { return false }
}

if (fs.existsSync(modules)) {
  if (!isLink(modules)) {
    fail(`«${modules}» — настоящий каталог, а не ссылка на общий. Скрипт его не удаляет: `
      + 'в этом ворктри что-то устанавливали, решение за человеком')
  }
  // `rmdir` наjunction снимает именно ссылку; рекурсивного удаления здесь нет
  // ни в одном варианте.
  const throughCmd = spawnSync('cmd', ['/c', 'rmdir', modules], { encoding: 'utf8' })
  if (isLink(modules)) {
    // Баннер вместо результата — тот самый случай, на котором всё и потеряли.
    try { fs.rmdirSync(modules) } catch { /* пусть скажет ниже */ }
  }
  if (isLink(modules) || fs.existsSync(modules)) {
    fail(`ссылку снять не удалось (${throughCmd.stderr || throughCmd.stdout || 'без вывода'}). `
      + `Удалять ворктри нельзя: \`git worktree remove\` пройдёт внутрь и вычистит общий каталог.`)
  }
  console.log('ссылка `node_modules` снята, общий каталог не тронут')
} else {
  console.log('ссылки `node_modules` в ворктри нет — снимать нечего')
}

if (flags.has('--only-unlink')) {
  console.log('режим `--only-unlink`: ворктри не удаляется')
  process.exit(0)
}

let root = ''
try {
  root = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: wt, encoding: 'utf8' }).trim()
} catch { /* скажет git ниже */ }
const repo = root ? path.dirname(root) : process.cwd()

const removeArgs = ['worktree', 'remove']
if (flags.has('--force')) removeArgs.push('--force')
removeArgs.push(wt)
try {
  execFileSync('git', removeArgs, { cwd: repo, encoding: 'utf8', stdio: 'inherit' })
} catch (error) {
  console.error('git worktree remove отказал (обычно — незакоммиченные изменения). '
    + 'Ссылка `node_modules` уже снята, общий каталог в безопасности.')
  process.exit(error.status || 1)
}
if (fs.existsSync(modules)) fail('после удаления ворктри на месте снова есть `node_modules` — проверьте руками')
console.log('ворктри удалён:', wt)
