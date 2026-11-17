// The updater's own failures are stack traces with whole documents attached.
// Keep the user-facing diagnostic bounded and useful without exposing internals.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const start = src.indexOf('function describeUpdateError')
const end = src.indexOf('\n}\n', start) + 2
if (start < 0 || end < 2) throw new Error('describeUpdateError не найдена')

// Вырезанный кусок видит только глобальную область — живой главный процесс даёт
// ему переводчик фраз для окна (тот же порядок, что в test-approval-signal.cjs).
globalThis.tr = require('../src/main/ui-text.cjs').tr

// eslint-disable-next-line no-new-func
const describeUpdateError = new Function(src.slice(start, end) + '\nreturn describeUpdateError')()

const SPA_HTML = 'Cannot parse update info from latest.yml in the latest release artifacts ' +
  '(https://pkwobler.best/1code/latest.yml?noCache=1k0qmdpv2): YAMLException: end of the stream or ' +
  'a document separator is expected (14:59)\n rawData: <!doctype html><html lang="ru" class="dark"> ' +
  '<head><title>Platinum</title></head><body><div id="root"></div></body></html>'

// Находка Н8 аудита break-general 2026-11-01: «битый манифест» и «битый файл» —
// две разные беды, человек должен получать разные инструкции. Эхо разбора (V8-
// строки и англоязычный текст библиотеки с подмешанным содержимым ответа)
// человеку не показывается вовсе.
const noChecksum = Object.assign(
  new Error('Error: No file checksum header defined for file "onlyone Setup 1.3.99.exe"'),
  { code: 'ERR_UPDATER_NO_CHECKSUM' }
)
const emptyYml = new TypeError("Cannot read properties of undefined (reading 'files')")

const CASES = [
  { what: 'сайт отдаёт index.html вместо latest.yml', error: new Error(SPA_HTML), expect: /страницу сайта вместо latest\.yml/ },
  { what: 'битый YAML без HTML', error: new Error('YAMLException: bad indentation'), expect: /повреждён или это не YAML/ },
  { what: 'файла нет', error: new Error('HttpError: 404 Not Found'), expect: /нет файла latest\.yml/ },
  { what: 'домен не резолвится', error: new Error('getaddrinfo ENOTFOUND pkwobler.best'), expect: /не резолвится/ },
  { what: 'сервер недоступен', error: new Error('connect ECONNREFUSED'), expect: /недоступен/ },
  { what: 'закрыто авторизацией', error: new Error('HttpError: 403 Forbidden'), expect: /авторизацией/ },
  { what: 'запуск из исходников', error: new Error('Skip checkForUpdates because application is not packaged'), expect: /только в установленной версии/ },
  {
    what: 'в latest.yml нет sha512 — это метаданные, а не порча файла',
    error: noChecksum,
    expect: /latest\.yml/i,
    not: /Файл обновления повреждён/
  },
  {
    what: 'настоящее несовпадение контрольной суммы докачанного файла',
    error: new Error('sha512 checksum mismatch, sha512 value=aaa, expected=bbb'),
    expect: /Файл обновления повреждён — контрольная сумма не сошлась/
  },
  {
    what: 'пустой latest.yml (оборванная выкладка)',
    error: emptyYml,
    expect: /latest\.yml/,
    not: /Cannot read properties/
  },
  {
    what: 'не-yaml мусор вместо latest.yml',
    error: new Error('No files provided: привет, это не yaml {{{'),
    expect: /latest\.yml/,
    not: /привет/
  },
  { what: 'неизвестная ошибка', error: new Error('something odd happened'), expect: /Не удалось проверить обновления/, not: /something odd/ }
]

let failed = 0
for (const c of CASES) {
  const got = describeUpdateError(c.error)
  const ok = c.expect.test(got) && !(c.not && c.not.test(got))
  if (!ok) { failed++; console.error(`ПРОВАЛ [${c.what}]: ${got}`) }
  if (got.length > 260) { failed++; console.error(`ПРОВАЛ [${c.what}]: сообщение ${got.length} символов`) }
  if (/<!doctype|<html|node_modules/i.test(got)) { failed++; console.error(`ПРОВАЛ [${c.what}]: наружу просочилась разметка`) }
}
const huge = describeUpdateError(new Error('x'.repeat(40000)))
if (huge.length > 260) { failed++; console.error(`ПРОВАЛ: гигантский текст не обрезан — ${huge.length}`) }

console.log(JSON.stringify({ ok: failed === 0, cases: CASES.length + 1, failed }))
process.exit(failed ? 1 : 0)
