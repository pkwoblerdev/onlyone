// Правила команд агента: «разрешить / спрашивать / запретить» по маске, как у opencode.
// Осторожность важнее удобства: разрешение действует только на простую команду внутри рабочих папок, без перенаправлений
// и подстановок, и только когда разрешён КАЖДЫЙ её кусок; запрет и «спрашивать» срабатывают на любом куске.
const assert = require('node:assert/strict')
const path = require('node:path')
const { parseRules, evaluateCommand, formatRules, DEFAULT_RULES } = require('../src/main/command-rules.cjs')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

const root = path.resolve('D:/проект')
const ev = (command, rules = []) => evaluateCommand(command, { rules, cwd: root, roots: [root] }).action

test('разбор правил: три действия, русские и английские слова, комментарии и пустые строки', () => {
  const { rules, errors } = parseRules('# мои правила\nallow git status*\nспрашивать git push*\n\nzапретить rm *\ndeny rm *\nask npm publish*')
  assert.deepEqual(rules.map(r => [r.action, r.pattern]), [['allow', 'git status*'], ['ask', 'git push*'], ['deny', 'rm *'], ['ask', 'npm publish*']])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 5)
})

test('форматирование правил возвращает то, что разобрали', () => {
  const { rules } = parseRules('allow git status*\ndeny rm *')
  assert.equal(formatRules(rules), 'allow git status*\ndeny rm *')
})

test('по умолчанию без вопросов только чтение: статус git, список файлов, версии', () => {
  for (const command of ['git status', 'git status -s', 'git diff HEAD~1', 'git log --oneline -5', 'ls', 'dir', 'dir src', 'node --version', 'npm -v', 'npm ls --depth=0']) {
    assert.equal(ev(command), 'allow', command)
  }
})

test('по умолчанию остальное — решает режим прав: правила молчат', () => {
  for (const command of ['npm test', 'git push origin main', 'git commit -m x', 'rm -rf build', 'node script.js']) {
    assert.equal(ev(command), null, command)
  }
})

test('перенаправление, подстановка и вывод в файл отменяют разрешение', () => {
  for (const command of ['git log > out.txt', 'echo hi > a.txt', 'ls $(whoami)', 'ls `whoami`', 'git diff --output=x.patch']) {
    assert.equal(ev(command), null, command)
  }
})

test('составная команда разрешена, только если разрешён каждый кусок', () => {
  assert.equal(ev('git status && git diff'), 'allow')
  assert.equal(ev('git status && npm test'), null)
  assert.equal(ev('git log | ls'), 'allow')
  assert.equal(ev('git status; rm -rf x'), null)
})

test('кавычки не режутся на куски: разделитель внутри строки — не граница команды', () => {
  assert.equal(ev('echo "a && b"'), 'allow')
})

test('путь за пределами рабочих папок отменяет разрешение', () => {
  assert.equal(ev('ls C:\\Users'), null)
  assert.equal(ev('dir ..\\..\\секреты'), null)
  assert.equal(ev('ls ' + path.join(root, 'src').replace(/\\/g, '/')), 'allow')
})

test('запрет срабатывает на любом куске и сильнее разрешения', () => {
  const rules = parseRules('allow git *\ndeny git push*').rules
  assert.equal(ev('git status', rules), 'allow')
  assert.equal(ev('git push origin main', rules), 'deny')
  assert.equal(ev('git status && git push', rules), 'deny')
})

test('«спрашивать» сильнее разрешения и действует на любом куске', () => {
  const rules = parseRules('ask npm publish*').rules
  assert.equal(ev('npm publish', rules), 'ask')
  assert.equal(ev('git status && npm publish --tag x', rules), 'ask')
})

test('последнее подходящее правило побеждает: свои правила переопределяют умолчания', () => {
  assert.equal(ev('git status', parseRules('deny git status*').rules), 'deny')
  assert.equal(ev('npm test', parseRules('allow npm test').rules), 'allow')
  assert.equal(ev('npm test -- --watch', parseRules('allow npm test').rules), null, 'маска без звёздочки — точная')
  assert.equal(ev('npm test -- --watch', parseRules('allow npm test*').rules), 'allow')
})

test('маска с « *» на конце подходит и к голой команде', () => {
  assert.equal(ev('make', parseRules('allow make *').rules), 'allow')
  assert.equal(ev('make build', parseRules('allow make *').rules), 'allow')
})

test('регистр и лишние пробелы не мешают', () => {
  assert.equal(ev('  GIT   Status  '), 'allow')
})

test('умолчания — это правила allow, и ни одного разрушающего', () => {
  assert.ok(DEFAULT_RULES.every(rule => rule.action === 'allow'))
  assert.ok(!DEFAULT_RULES.some(rule => /rm|del|push|commit|reset|clean|install|publish|checkout/.test(rule.pattern)))
})

test('путь после пробела виден охране: «rm ../x» и «> /etc/x» больше не пропускаются как слишком короткие', () => {
  const { pathCandidates } = require('../src/main/command-guard.js')
  assert.equal(pathCandidates('rm ../x', root, process.env).length, 1)
  assert.equal(pathCandidates('echo a > /tmp/x', root, process.env).length, 1)
  assert.equal(pathCandidates('rm ./x', root, process.env).length, 1)
})

test('подключено: команда проходит правила после политики и до карточки подтверждения', () => {
  const fs = require('node:fs')
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
  const run = main.slice(main.indexOf('async function runWorkspaceCommand('))
  const guard = run.indexOf('commandGuard.checkCommand')
  const rule = run.indexOf('commandRules.evaluateCommand')
  const card = run.indexOf("requireMutationApproval(event, 'Выполнить команду'")
  assert.ok(guard > 0 && rule > guard && card > rule, 'порядок: политика, правила, карточка')
  assert.match(run.slice(rule, card + 400), /denied_by_rule/)
  assert.match(run.slice(rule, card + 600), /rule\.action === 'ask'/)
})

if (failed) process.exit(1)
console.log('\nПравила команд: проверки пройдены')
