'use strict'
// break-5b Н19: обход, упёршийся в maxFiles, отдавал truncated:false — «в проекте
// этого нет» вместо «не досмотрел». Две другие причины остановки (maxMatches,
// бюджет/стоимость) помечены, а maxFiles — нет. После правки обрыв по maxFiles
// помечен truncated:true. Контроли: maxMatches и бюджет помечены, полный обход — нет.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { search } = require('../src/main/workspace-search')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-search-maxfiles-'))
for (let i = 0; i < 12; i++) {
  fs.writeFileSync(path.join(root, `a${String(i).padStart(2, '0')}.js`), 'const needle = 1\n')
}
const roots = [{ root, label: '' }]

let failed = 0
const test = async (name, fn) => { try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

async function main() {
  await test('Н19: обрыв по maxFiles помечен truncated', async () => {
    const found = await search({ roots, query: 'needle', maxFiles: 3, maxMatches: 200 })
    assert.equal(found.files, 3, 'обход не упёрся в maxFiles — тест пустой')
    assert.ok(found.matches.length < 12, 'найдено не всё (иначе обрыв не при чём)')
    assert.equal(found.truncated, true, 'обрыв по maxFiles reads as «в проекте этого нет»')
  })

  await test('контроль: обрыв по maxMatches помечен', async () => {
    const found = await search({ roots, query: 'needle', maxMatches: 3 })
    assert.equal(found.truncated, true)
  })

  await test('контроль: обрыв по бюджету помечен', async () => {
    const found = await search({ roots, query: 'needle', deadlineAt: Date.now() - 1000 })
    assert.equal(found.truncated, true)
    assert.equal(found.stopped, 'budget')
  })

  await test('контроль: полный обход не помечен truncated', async () => {
    const found = await search({ roots, query: 'needle', maxFiles: 20000 })
    assert.equal(found.matches.length, 12)
    assert.equal(found.truncated, false, 'полный обход ложно помечен неполным')
  })

  fs.rmSync(root, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('ok test-search-maxfiles-truncated')
}
main()