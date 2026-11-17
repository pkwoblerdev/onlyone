'use strict'
// Н4 (аудит 31.10): move_path терял цель — TARGET_FIELDS не знал source и
// destination. Итог: в карточке продолжения «- move_path» без файлов, а
// неизвестный исход перемещения одного файла закрывался повтором перемещения
// совсем другого. Цель действия обязана различать вызовы, даже если полей
// инструмента опись не знает.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskState } = require('../src/main/task-state.cjs')
const { createCheckpointStore, describeTarget, continuationPrompt } = require('../src/main/run-checkpoints.js')

let checks = 0
const failures = []
const check = (name, fn) => {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-target-move-'))

try {
  check('перемещение называет источник и назначение', () => {
    const target = describeTarget({ source: 'docs/a.txt', destination: 'archive/a.txt' })
    assert.match(target, /docs\/a\.txt/)
    assert.match(target, /archive\/a\.txt/)
  })

  check('незнакомые поля различаются хешем аргументов, а не пустой строкой', () => {
    const first = describeTarget({ widget: 'one', count: 2 })
    const second = describeTarget({ widget: 'two', count: 2 })
    assert.ok(first, 'цель снова пустая')
    assert.notEqual(first, second, 'разные вызовы склеились в одну цель')
    assert.equal(first, describeTarget({ widget: 'one', count: 2 }), 'хеш нестабилен')
    assert.equal(first.includes('one'), false, 'аргументы попали в цель открытым текстом')
  })

  check('чужое перемещение не закрывает неизвестный исход', () => {
    const task = createTaskState({ idPrefix: 'run' })
    const move = target => task.beginAction({ tool: 'move_path', target })
    const started = move(describeTarget({ source: 'docs/a.txt', destination: 'archive/a.txt' }))
    const afterCrash = createTaskState({ idPrefix: 'run', restored: task.snapshot() })
    assert.equal(afterCrash.action(started.id).status, 'unknown')
    // Другой файл — другая цель: повтора здесь нет, предупреждать не о чем.
    const otherTarget = describeTarget({ source: 'docs/c.txt', destination: 'archive/c.txt' })
    assert.equal(afterCrash.admit({ tool: 'move_path', target: otherTarget }).allowed, true)
    const other = afterCrash.beginAction({ tool: 'move_path', target: otherTarget })
    assert.equal(afterCrash.action(started.id).resolution, undefined, 'чужое перемещение сверило исход')
    assert.equal(afterCrash.remainder().unknownActions.length, 1)
    assert.notEqual(other.id, started.id)
  })

  check('повтор того же перемещения по-прежнему просит сначала проверить', () => {
    const task = createTaskState({ idPrefix: 'run' })
    const target = describeTarget({ source: 'docs/a.txt', destination: 'archive/a.txt' })
    task.beginAction({ tool: 'move_path', target })
    const afterCrash = createTaskState({ idPrefix: 'run', restored: task.snapshot() })
    assert.equal(afterCrash.admit({ tool: 'move_path', target }).allowed, false)
    assert.equal(afterCrash.admit({ tool: 'move_path', target }).allowed, true, 'после предупреждения решение за моделью')
  })

  check('карточка продолжения показывает, что и куда перемещали', () => {
    const runId = 'dddddddd-eeee-ffff-0000-111111111111'
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId, ask: 'Разложи файлы' })
    run.begin('move_path', { source: 'docs/a.txt', destination: 'archive/a.txt' }, 0)
    const [resumed] = createCheckpointStore({ dir }).interrupted()
    const prompt = continuationPrompt(resumed)
    assert.match(prompt, /- move_path: docs\/a\.txt → archive\/a\.txt/)
    store.dismiss(runId)
  })

  if (failures.length) {
    console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
