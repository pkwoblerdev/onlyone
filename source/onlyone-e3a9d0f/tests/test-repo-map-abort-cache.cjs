'use strict'
// break-5b Н18: getIndex кэшировал ПРЕРВАННЫЙ первую индексацию навсегда. Обход,
// снятый сигналом, возвращал неполный индекс (truncated:false), он ложился в кэш
// по корню и жил до первой правки — find_symbol отвечал «символа нет» на
// существующую функцию. После правки прерванный обход в кэш не кладётся: следующий
// вызов строит полную карту. Контроль: непрерывный обход кэшируется и полон.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const repoMap = require('../src/main/repo-map.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-repo-map-'))
const N = 60
for (let i = 0; i < N; i++) {
  const nn = String(i).padStart(2, '0')
  fs.writeFileSync(path.join(dir, `f${nn}.js`), `function sym${nn}() {}\n`)
}
// Сигнал, который «снимается» после 5 проверок: обход детерминированно прерывается.
const abortingSignal = () => { let reads = 0; return { get aborted() { return ++reads > 5 } } }

let failed = 0
const check = async (name, fn) => { try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

async function main() {
  await check('Н18: прерванная первая индексация не кэшируется — вторая полная', async () => {
    repoMap.invalidateAll()
    const first = await repoMap.getIndex(dir, abortingSignal())
    assert.ok(first.files.length < N, `обход не прервался (files=${first.files.length}) — тест пустой`)
    const second = await repoMap.getIndex(dir)  // без сигнала: полная карта
    assert.equal(second.files.length, N, 'вторая индексация осталась обрезанной (кэш отравлен)')
    assert.ok(repoMap.findSymbols(second, 'sym59').length > 0, 'find_symbol не нашёл существующую функцию')
  })

  await check('контроль: непрерывный обход полон и кэшируется', async () => {
    repoMap.invalidateAll()
    const full = await repoMap.getIndex(dir)
    assert.equal(full.files.length, N)
    const again = await repoMap.getIndex(dir)
    assert.equal(again, full, 'полный индекс не кэшируется (перестроился)')
    assert.ok(repoMap.findSymbols(full, 'sym00').length > 0)
  })

  fs.rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('ok test-repo-map-abort-cache')
}
main()