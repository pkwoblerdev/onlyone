// Инициатива 2 (11.10.2026): агент не знал структуры проекта и тратил 5–7 шагов на слепые search_files/list_files. Лёгкая
// карта символов (функции, классы, константы, экспорты, IPC) и инструмент find_symbol — по требованию, а не 1200 токенов в
// каждый запрос: на моделях без кэша префикса постоянный блок платился бы на каждом шаге.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const repoMap = require('../src/main/repo-map.cjs')

let failed = 0
const check = async (name, fn) => { try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-repomap-'))
  const w = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  w('src/auth.js', [
    "const { app } = require('electron')",
    'const SESSION_TTL = 3600',
    'async function verifySession(token) { return Boolean(token) }',
    'function login(user, pass) { return user + pass }',
    'const hashPassword = async (pass) => pass',
    'class AuthRouter { handle() {} }',
    "ipcMain.handle('auth-login', async () => ({}))",
    'module.exports = { login, verifySession, AuthRouter }'
  ].join('\n'))
  w('src/util.mjs', 'export function slugify(text) { return text }\nexport const clamp = (n, a, b) => Math.min(b, Math.max(a, n))\nexport default class Cache {}\n')
  w('tools/job.py', 'class Job:\n    def run(self):\n        pass\n\nasync def main_loop():\n    pass\n')
  w('svc/server.go', 'package svc\n\nfunc Serve(addr string) error { return nil }\nfunc (s *Server) Close() {}\ntype Server struct{}\n')
  w('node_modules/lib/index.js', 'function hidden() {}\n')
  w('dist/bundle.js', 'function bundled() {}\n')
  fs.writeFileSync(path.join(dir, 'src', 'blob.js'), Buffer.from([0, 1, 2, 3, 0, 0, 255, 254]))
  return dir
}

;(async () => {
  const dir = project()

  await check('находит функции, классы, стрелочные функции, константы, экспорты и IPC', async () => {
    const index = await repoMap.buildIndex({ root: dir })
    const kinds = name => repoMap.findSymbols(index, name, { limit: 5 }).map(m => m.kind + ':' + m.name + '@' + m.file + ':' + m.line)
    assert.deepEqual(kinds('verifySession').slice(0, 1), ['function:verifySession@src/auth.js:3'])
    assert.match(kinds('login')[0], /^function:login@src\/auth\.js:4$/)
    assert.match(kinds('hashPassword')[0], /^function:hashPassword@src\/auth\.js:5$/)
    assert.match(kinds('AuthRouter')[0], /^class:AuthRouter@src\/auth\.js:6$/)
    assert.match(kinds('SESSION_TTL')[0], /^const:SESSION_TTL@src\/auth\.js:2$/)
    assert.match(kinds('auth-login')[0], /^ipc:auth-login@src\/auth\.js:7$/)
    assert.match(kinds('slugify')[0], /^function:slugify@src\/util\.mjs:1$/)
    assert.match(kinds('clamp')[0], /^function:clamp@src\/util\.mjs:2$/)
    assert.match(kinds('Cache')[0], /^class:Cache@src\/util\.mjs:3$/)
  })

  await check('Python и Go', async () => {
    const index = await repoMap.buildIndex({ root: dir })
    const one = n => repoMap.findSymbols(index, n)[0]
    assert.equal(one('Job').kind, 'class'); assert.equal(one('main_loop').kind, 'function')
    assert.equal(one('Serve').kind, 'function'); assert.equal(one('Close').kind, 'function'); assert.equal(one('Server').kind, 'class')
  })

  await check('node_modules, dist и двоичные файлы пропускаются', async () => {
    const index = await repoMap.buildIndex({ root: dir })
    assert.deepEqual(repoMap.findSymbols(index, 'hidden'), [])
    assert.deepEqual(repoMap.findSymbols(index, 'bundled'), [])
    assert.ok(!index.files.includes('src/blob.js'), 'двоичный файл прочитан как текст')
  })

  await check('порядок: точное имя, затем начало, затем часть; фильтр kind и limit', async () => {
    const index = await repoMap.buildIndex({ root: dir })
    const names = repoMap.findSymbols(index, 'login').map(m => m.name)
    assert.equal(names[0], 'login', 'точное имя раньше части')
    assert.ok(names.indexOf('auth-login') > 0, 'часть имени — после точного')
    const starts = repoMap.findSymbols(index, 'auth').map(m => m.name)
    assert.ok(starts.slice(0, 2).every(n => /^auth/i.test(n)), 'начало имени раньше середины')
    assert.deepEqual(repoMap.findSymbols(index, 'login', { kind: 'ipc' }).map(m => m.name), ['auth-login'])
    assert.equal(repoMap.findSymbols(index, 'a', { limit: 2 }).length, 2)
    assert.equal(repoMap.findSymbols(index, 'verifysession')[0].name, 'verifySession', 'регистр не важен')
    assert.deepEqual(repoMap.findSymbols(index, 'нет-такого'), [])
  })

  await check('скелет: файл → символы, в пределах размера и без мусора', async () => {
    const index = await repoMap.buildIndex({ root: dir })
    const text = repoMap.skeleton(index, { maxChars: 4000 })
    assert.match(text, /src\/auth\.js: .*verifySession/)
    assert.match(text, /src\/util\.mjs: .*slugify/)
    assert.ok(!/node_modules|bundled/.test(text))
    assert.ok(text.length <= 4000)
    assert.equal(repoMap.skeleton(index, { maxChars: 4000 }), text, 'детерминирован')
    assert.ok(repoMap.skeleton(index, { maxChars: 120 }).length <= 120, 'жёсткий потолок')
  })

  await check('кэш: повторный вызов берёт то же, invalidate перечитывает', async () => {
    const first = await repoMap.getIndex(dir)
    assert.equal(await repoMap.getIndex(dir), first)
    fs.appendFileSync(path.join(dir, 'src', 'auth.js'), '\nfunction addedLater() {}\n')
    assert.equal(repoMap.findSymbols(await repoMap.getIndex(dir), 'addedLater').length, 0, 'до сброса — прежняя карта')
    repoMap.invalidateAll()
    assert.equal(repoMap.findSymbols(await repoMap.getIndex(dir), 'addedLater').length, 1)
  })

  await check('собственный src/main этого проекта: быстро и компактно', async () => {
    const t0 = Date.now()
    const index = await repoMap.buildIndex({ root: path.join(__dirname, '..', 'src') })
    const ms = Date.now() - t0
    assert.ok(ms < 3000, 'карта строилась ' + ms + ' мс')
    assert.ok(repoMap.findSymbols(index, 'runAgentLoop').length >= 1, 'runAgentLoop не найден в main.js')
    const text = repoMap.skeleton(index, { maxChars: 4000 })
    assert.ok(text.length <= 4000 && text.length > 500, 'скелет ' + text.length)
    console.log('   (' + index.files.length + ' файлов, ' + ms + ' мс, скелет ' + text.length + ' знаков)')
  })

  await check('main.js: инструмент find_symbol объявлен и исполняется', async () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
    assert.ok(/name: 'find_symbol'/.test(main), 'нет описания инструмента')
    assert.ok(/name === 'find_symbol'/.test(main), 'нет исполнения инструмента')
    assert.ok(/require\('\.\/repo-map\.cjs'\)/.test(main), 'main.js не подключает repo-map')
    assert.ok(/repoMap\.invalidateAll\(\)/.test(main), 'карта не сбрасывается после правок')
  })

  fs.rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('Карта символов: проверки пройдены')
})()
