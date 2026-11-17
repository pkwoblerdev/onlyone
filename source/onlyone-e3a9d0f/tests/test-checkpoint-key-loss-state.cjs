'use strict'
// Н2 (аудит 31.10): чужой или сменившийся ключ профиля молча стирал требования
// задачи и просьбу. Текст не прочитан — это не «требований не было»: требование
// остаётся в состоянии «устарело», остаётся в остатке, а карточка продолжения
// говорит об этом прямо. Исходный шифр сохраняется рядом: вернётся ключ —
// вернётся и текст.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCheckpointStore, continuationPrompt } = require('../src/main/run-checkpoints.js')
const { createTaskState } = require('../src/main/task-state.cjs')

let checks = 0
const failures = []
const check = (name, fn) => {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-key-loss-'))
const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ask = 'Сделай кнопку отмены и проверь её'
const requirement = 'Кнопка отмены прерывает запрос'

const keyA = text => 'A' + Buffer.from(text, 'utf8').toString('base64')
const unA = body => Buffer.from(body.slice(1), 'base64').toString('utf8')
// «Другой ключ»: расшифровать нечем — safeStorage.decryptString бросает.
const keyB = text => 'B' + Buffer.from(text, 'utf8').toString('base64')
const unB = () => { throw new Error('decrypt failed') }

const resumeTask = task => createTaskState({
  restored: task, idPrefix: runId.slice(0, 8),
  budgetLimits: task.budget.limits, budgetDeadlineAt: task.budget.deadlineAt
})

try {
  {
    const store = createCheckpointStore({ dir, protect: keyA, unprotect: unA })
    const run = store.start({ runId, ask, budgetLimits: { requests: 10, tokens: 1000 }, budgetDeadlineAt: null })
    run.syncPlan([{ id: 'cancel', title: requirement, detail: 'проверить вручную', status: 'done' }], 0)
    run.begin('write_file', { path: 'src/button.js' }, 0).end('done')
  }

  const [control] = createCheckpointStore({ dir, protect: keyA, unprotect: unA }).interrupted()
  const [foreign] = createCheckpointStore({ dir, protect: keyB, unprotect: unB }).interrupted()

  check('свой ключ: просьба и требование читаются как раньше', () => {
    assert.equal(control.ask, ask)
    assert.equal(control.askUnreadable, false)
    assert.equal(control.task.requirements.length, 1)
    assert.equal(control.task.requirements[0].expected, requirement)
    assert.equal(control.task.requirements[0].unreadable, undefined)
  })

  check('чужой ключ: файл читается, просьба помечена нечитаемой, а не пустой', () => {
    assert.ok(foreign, 'ход с чужим ключом не найден')
    assert.equal(foreign.askUnreadable, true)
    assert.match(String(foreign.ask), /не прочитан/i, 'просьба исчезла без следа')
  })

  check('требование остаётся в остатке и не считается сделанным', () => {
    assert.equal(foreign.task.requirements.length, 1, 'требование выброшено при пустом тексте')
    const item = foreign.task.requirements[0]
    assert.equal(item.state, 'stale')
    assert.equal(item.unreadable, true)
    assert.ok(item.expected.trim(), 'у требования нет даже заглушки')
    assert.match(item.expected, /не прочитан/i)
    assert.equal(item.required, true)
    const resumed = resumeTask(foreign.task)
    assert.equal(resumed.complete(), false, '«готово» при нечитаемом требовании')
    assert.deepEqual(resumed.remainder().open.map(entry => entry.id), [item.id])
  })

  check('карточка продолжения говорит, что состояние задачи прочитано не полностью', () => {
    const prompt = continuationPrompt(foreign)
    assert.match(prompt, /не прочитан/i)
    assert.match(prompt, /Требования задачи:/, 'требования пропали из карточки')
    assert.match(prompt, /устарело/i)
    assert.equal(prompt.includes('Исходная просьба: «»'), false)
  })

  check('исходный шифр сохранён: с рабочим ключом текст возвращается', () => {
    const item = foreign.task.requirements[0]
    assert.match(String(item.expectedSealed), /^enc:v1:/, 'шифр требования потерян')
    // Продолжение хода с чужим ключом: заглушка уходит на диск, шифр остаётся рядом.
    const store = createCheckpointStore({ dir, protect: keyB, unprotect: unB })
    const resumed = store.start({ runId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', ask: 'продолжай',
      carriedTask: foreign.task, budgetLimits: foreign.task.budget.limits, budgetDeadlineAt: foreign.task.budget.deadlineAt })
    assert.equal(resumed.saved(), true)
    const [again] = createCheckpointStore({ dir, protect: keyB, unprotect: unB }).interrupted()
      .filter(entry => entry.runId === 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
    assert.match(again.task.requirements[0].expectedSealed, /^enc:v1:/, 'шифр затёрт заглушкой')
    const [restored] = createCheckpointStore({ dir, protect: keyA, unprotect: unA }).interrupted()
      .filter(entry => entry.runId === 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
    assert.equal(restored.task.requirements[0].expected, requirement, 'текст требования не вернулся')
    assert.equal(restored.task.requirements[0].unreadable, undefined)
  })

  if (failures.length) {
    console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
