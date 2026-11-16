'use strict'
// Н6 аудита 31.10: содержимое артефактов и макетов Дизайна отдавалось с
// `Access-Control-Allow-Origin: *`. Схемы `onecode-artifact`/`onecode-design`
// нужны только окну приложения: у раздела браузера (`persist:onlyone-browser`)
// обработчика схемы нет вовсе, у рамок превью один и тот же источник, а
// `fetch` окна из `file://` читает ответ и без заголовка (проверено живьём на
// Electron 44: `Origin` до обработчика не доходит). Значит заголовок — только
// разрешение читать по случайному id тому, кому оно не нужно.
//
// Меряется исходник `main.js`: обработчики собирают заголовки объектами, и
// заголовок, добавленный в любую ветку (страница, файл, Range), сразу виден.
// Заодно проверяется, что «починка» не выключила саму схему: без
// `corsEnabled` панель артефактов перестаёт читать текст (тоже проверено живьём).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
// Комментарии называть заголовок могут — искать надо в коде, а не в прозе.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

check('ни один ответ main.js не отдаёт Access-Control-Allow-Origin', () => {
  const found = code.match(/access-control-allow-origin/gi) || []
  assert.deepEqual(found, [], `заголовок остался в ${found.length} месте(ах): схема отвечает чужой странице`)
})

check('обе схемы по-прежнему доступны окну (corsEnabled + fetch + stream)', () => {
  for (const scheme of ['onecode-design', 'onecode-artifact']) {
    const line = source.split('\n').find(item => item.includes(`scheme: '${scheme}'`))
    assert.ok(line, `схема ${scheme} пропала из registerSchemesAsPrivileged`)
    assert.match(line, /corsEnabled:\s*true/, `${scheme}: без corsEnabled панель не прочитает текст`)
    assert.match(line, /supportFetchAPI:\s*true/, `${scheme}: пропал supportFetchAPI`)
    assert.match(line, /stream:\s*true/, `${scheme}: пропал stream (ролик идёт потоком)`)
    assert.match(source, new RegExp(`protocol\\.handle\\('${scheme}'`), `${scheme}: обработчик не зарегистрирован`)
  }
})

check('ответы артефакта и макета сохранили свой тип содержимого', () => {
  assert.match(source, /'content-type': type, 'cache-control': 'no-store'/, 'артефакт: ответ без типа содержимого')
  assert.match(source, /'content-type': 'text\/html; charset=utf-8'/, 'страница макета: ответ без типа')
  assert.match(source, /headers: \{ 'content-type': mime \}/, 'файл макета: ответ без типа')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
