// Хранилище артефактов и временная блокировка меты (находка Н78).
//
// На Windows переименование поверх цели, которую держит антивирус или поисковый
// индекс, отдаёт EPERM и через сотни миллисекунд отпускает само. Без терпения
// это выглядит как «версия не сохранилась» на целых данных: прогон проверяет,
// что запись меты переживает блокировку, а на вечной блокировке отказ не
// оставляет временных файлов и не трогает прежнюю мету.
'use strict'

const assert = require('node:assert')
const fsSync = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { create } = require('../src/main/artifacts')

let total = 0
let failed = 0

async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

const trash = []
function tempDir () {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'onlyone-art-lock-'))
  trash.push(dir)
  return dir
}

// Подмена одна на весь прогон: `artifacts.js` держит ссылку на модуль, а не на
// функцию, поэтому правка свойства доходит до записи меты. Блокируется только
// переименование меты — хранилище вправе двигать и другие файлы.
function lockMetaRename (store, { times }) {
  const real = fsp.rename
  const state = { blocked: 0, calls: 0 }
  let left = times
  fsp.rename = async (...args) => {
    state.calls++
    if (/meta\.json$/.test(String(args[1] || '')) && left > 0) {
      left--
      state.blocked++
      const error = new Error('locked')
      error.code = 'EPERM'
      throw error
    }
    return real(...args)
  }
  return {
    state,
    folder: id => store.folderOf(id),
    restore: () => { fsp.rename = real }
  }
}

function tmpLeftovers (folder) {
  return fsSync.readdirSync(folder).filter(name => name.includes('.tmp'))
}

async function main () {
  await check('мета переживает две временные блокировки подряд', async () => {
    const dir = tempDir()
    const store = create({ dir })
    const harness = lockMetaRename(store, { times: 2 })
    let meta = null
    try {
      meta = await store.add({ chatId: 'чат-1', kind: 'page', title: 'Пальмы', content: '<h1>раз</h1>' })
    } finally {
      harness.restore()
    }
    assert.equal(harness.state.blocked, 2, 'переименование не блокировалось — проверка не о том')
    assert.ok(meta?.id, 'артефакт не создан сквозь блокировку')
    const raw = JSON.parse(fsSync.readFileSync(path.join(store.folderOf(meta.id), 'meta.json'), 'utf8'))
    assert.equal(raw.versions.length, 1, `версия потеряна: ${JSON.stringify(raw.versions)}`)
    assert.deepEqual(tmpLeftovers(store.folderOf(meta.id)), [], 'после успеха на диске остались временные файлы')
  })

  await check('новая версия тоже записывается сквозь блокировку', async () => {
    const dir = tempDir()
    const store = create({ dir })
    const first = await store.add({ chatId: 'чат-1', kind: 'page', title: 'Пальмы', content: '<h1>раз</h1>' })
    const harness = lockMetaRename(store, { times: 3 })
    let next = null
    try {
      next = await store.update(first.id, '<h1>два</h1>')
    } finally {
      harness.restore()
    }
    assert.equal(harness.state.blocked, 3, 'переименование меты не блокировалось — проверка не о том')
    assert.equal(next.current, 2, `текущей осталась версия ${next.current}`)
    assert.equal(next.versions.length, 2, 'история версий не доехала до диска')
  })

  await check('вечная блокировка — отказ, а прежняя мета цела и мусора нет', async () => {
    const dir = tempDir()
    const store = create({ dir })
    const first = await store.add({ chatId: 'чат-1', kind: 'page', title: 'Пальмы', content: '<h1>раз</h1>' })
    const folder = store.folderOf(first.id)
    const before = fsSync.readFileSync(path.join(folder, 'meta.json'), 'utf8')
    const harness = lockMetaRename(store, { times: Infinity })
    let error = null
    try {
      await store.update(first.id, '<h1>два</h1>')
    } catch (caught) {
      error = caught
    } finally {
      harness.restore()
    }
    assert.ok(error, 'вторая версия прошла сквозь вечную блокировку меты')
    assert.equal(fsSync.readFileSync(path.join(folder, 'meta.json'), 'utf8'), before,
      'отказ переписал прежнюю мету')
    assert.deepEqual(tmpLeftovers(folder), [], 'временная оболочка осталась на диске после отказа')
  })

  await check('чужая ошибка записи не повторяется молча', async () => {
    const dir = tempDir()
    const store = create({ dir })
    const real = fsp.rename
    let calls = 0
    fsp.rename = async (...args) => {
      calls++
      if (/meta\.json$/.test(String(args[1] || ''))) {
        const error = new Error('disk full')
        error.code = 'ENOSPC'
        throw error
      }
      return real(...args)
    }
    let error = null
    try {
      await store.add({ chatId: 'чат-1', kind: 'page', title: 'Пальмы', content: '<h1>раз</h1>' })
    } catch (caught) {
      error = caught
    } finally {
      fsp.rename = real
    }
    assert.equal(String(error?.code || ''), 'ENOSPC', `отказ дошёл как ${error?.code}`)
    assert.equal(calls, 1, `переименование повторялось ${calls} раз там, где терпеть нечего`)
  })

  await check('переименование меты совершается ровно один раз на успехе', async () => {
    const dir = tempDir()
    const store = create({ dir })
    const real = fsp.rename
    let metaRenames = 0
    fsp.rename = async (...args) => {
      if (/meta\.json$/.test(String(args[1] || ''))) metaRenames++
      return real(...args)
    }
    try {
      await store.add({ chatId: 'чат-1', kind: 'page', title: 'Пальмы', content: '<h1>раз</h1>' })
    } finally {
      fsp.rename = real
    }
    assert.equal(metaRenames, 1, `мету переименовали ${metaRenames} раз за удачную запись`)
  })

  for (const dir of trash) {
    try { fsSync.rmSync(dir, { recursive: true, force: true }) } catch { /* временная папка — не доказательство */ }
  }
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('ПРОВАЛ НАБОРА: ' + (error && error.stack) || error)
  process.exit(1)
})
