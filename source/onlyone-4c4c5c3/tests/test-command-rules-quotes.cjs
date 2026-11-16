// break-5 Н3: одинарные кавычки не кавычки в cmd.exe, а split() считал их
// кавычками — «echo 'ok & ren keep.txt pwned.txt'» получал авто-allow без карточки.
const assert = require('node:assert/strict')
const { evaluateCommand } = require('../src/main/command-rules.cjs')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const ev = (command, extra = {}) => evaluateCommand(command, { cwd: 'C:/work', roots: ['C:/work'], env: {}, ...extra }).action

check('вторая команда под одинарными кавычками не получает allow', () => {
  assert.notEqual(ev("echo 'ok & ren keep.txt pwned.txt'"), 'allow',
    'мутация спрятана под одинарными кавычками и разрешена без карточки')
})
check('произвольный код под одинарными кавычками не получает allow', () => {
  assert.notEqual(ev('echo \'ok & node -e "require(String.fromCharCode(102,115)).writeFileSync(\'x\',\'y\')"\''), 'allow')
})
check('пользовательский deny не обходится одинарными кавычками', () => {
  const verdict = ev("echo 'ok & del victim.js'", { rules: [{ pattern: 'del *', action: 'deny' }] })
  assert.equal(verdict, 'deny', 'deny обойдён кавычечной обёрткой: ' + verdict)
})
check('перенаправление под одинарными кавычками делает команду unsafe', () => {
  assert.notEqual(ev("echo 'ok > out.txt'"), 'allow')
})

check('контроль: двойные кавычки по-прежнему защищают разделитель', () => {
  assert.equal(ev('echo "a && b"'), 'allow')
})
check('контроль: одиночная кавычка без разделителя — обычный echo', () => {
  assert.equal(ev("echo 'hello world'"), 'allow')
  assert.equal(ev("echo it's fine"), 'allow')
})
check('контроль: голая мутация спрашивает (action null)', () => {
  assert.equal(ev('del victim.js'), null)
  assert.equal(ev('ren keep.txt pwned.txt'), null)
})
check('контроль: чтение разрешено', () => {
  assert.equal(ev('git status'), 'allow')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0