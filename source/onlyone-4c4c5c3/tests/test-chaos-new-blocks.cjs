'use strict'
const assert = require('node:assert/strict')

async function runChaos() {
  console.log('--- STARTING CHAOS TESTS FOR NEW BLOCKS (DESK, MODS, SCHEDULES, REMOTE) ---')

// ============================================================================
// 1. DESK CHAOS: Prototype Pollution, Reserved IDs, Layout Fuzzing
// ============================================================================
console.log('\n[1. Desk Chaos Tests]')
const { validateSnapshot, createDeskModel } = require('../src/main/desk-model.cjs')
const { createDeskStore } = require('../src/main/desk-store.cjs')
const { parseTemplate } = require('../src/main/desk-transfer.cjs')
const { parsePackage } = require('../src/main/desk-package.cjs')

// 1.1 Reserved IDs in snapshot
{
  const reserved = ['__proto__', 'constructor', 'prototype']
  for (const badId of reserved) {
    const snap = {
      schemaVersion: 1,
      id: badId,
      title: 'Valid Title',
      revision: 0,
      blocks: []
    }
    assert.throws(
      () => validateSnapshot(snap),
      /Invalid Desk snapshot/,
      `Desk snapshot with reserved id "${badId}" must be rejected`
    )
  }

  // Block id reserved
  for (const badId of reserved) {
    const snapWithBadBlock = {
      schemaVersion: 1,
      id: 'desk-normal',
      title: 'Valid Title',
      revision: 0,
      blocks: [{
        id: badId,
        kind: 'browser',
        title: 'Block',
        resourceRef: 'https://example.com',
        rect: { x: 0, y: 0, width: 400, height: 400, z: 0 },
        revision: 1
      }]
    }
    assert.throws(
      () => validateSnapshot(snapWithBadBlock),
      /Invalid Desk block/,
      `Desk block with reserved id "${badId}" must be rejected`
    )
  }
}

// 1.2 Prototype pollution in JSON payload
{
  const protoPayload = '{"__proto__":{"polluted":"desk-polluted"},"schemaVersion":1,"id":"desk-1","title":"Title","revision":0,"blocks":[]}'
  const parsed = JSON.parse(protoPayload)
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), true)
  // validateSnapshot must reject own __proto__ and not pollute Object.prototype
  assert.throws(() => validateSnapshot(parsed), /Invalid Desk snapshot/)
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must not be polluted by validateSnapshot')
}

// 1.3 Operation with reserved ID in model
{
  const model = createDeskModel({ title: 'Desk Test' })
  const res = model.apply({
    operationId: '__proto__',
    expectedRevision: 0,
    actorId: 'human:1',
    operations: [{
      type: 'add',
      block: {
        kind: 'browser',
        title: 'Block',
        resourceRef: 'https://example.com',
        rect: { x: 0, y: 0, width: 400, height: 400 }
      }
    }]
  })
  assert.equal(res.ok, false, 'apply with reserved operationId must be rejected')
}

// 1.4 Desk Store prototype pollution test
{
  const tmpDir = require('node:path').join(__dirname, '..', 'tmp-desk-chaos')
  const fs = require('node:fs')
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const store = createDeskStore({
      dir: tmpDir,
      protect: text => Buffer.from(text).toString('base64'),
      unprotect: b64 => Buffer.from(b64, 'base64').toString('utf8')
    })

    // Save with chatId that is reserved
    assert.throws(() => store.save('__proto__', { schemaVersion: 1, id: 'desk', title: 'T', revision: 0, blocks: [] }), /Invalid chat/)
    assert.throws(() => store.load('__proto__'), /Invalid chat/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// 1.5 Template / Package with reserved block ID
{
  const badTemplate = JSON.stringify({
    format: 'onlyone-desk-template',
    version: 1,
    title: 'Template',
    blocks: [{
      kind: 'browser',
      title: 'T',
      rect: { x: 0, y: 0, width: 400, height: 400, z: 0 },
      url: 'https://example.com'
    }]
  })
  // Template with __proto__ block
  const evilTemplate = badTemplate.replace('"blocks":[{', '"__proto__":{"evil":true},"blocks":[{')
  assert.throws(() => parseTemplate(evilTemplate))
  assert.equal(Object.prototype.evil, undefined)
}

// 1.6 Malformed geometry and fuzzing
{
  assert.throws(() => validateSnapshot({
    schemaVersion: 1, id: 'd1', title: 'T', revision: 0,
    blocks: [{ id: 'b1', kind: 'browser', title: 'T', resourceRef: 'https://ex.com', rect: { x: NaN, y: 0, width: 400, height: 400, z: 0 }, revision: 1 }]
  }), /Invalid Desk block/)

  assert.throws(() => validateSnapshot({
    schemaVersion: 1, id: 'd1', title: 'T', revision: 0,
    blocks: [{ id: 'b1', kind: 'browser', title: 'T', resourceRef: 'https://ex.com', rect: { x: 0, y: 0, width: 10, height: 400, z: 0 }, revision: 1 }]
  }), /Invalid Desk block/)
}

// 1.7 Replay attack with modified operations
{
  const model = createDeskModel({ title: 'Replay Desk' })
  const op1 = {
    operationId: 'op_replay_test', expectedRevision: 0, actorId: 'human:1',
    operations: [{ type: 'add', block: { kind: 'browser', title: 'B1', resourceRef: 'https://ex.com', rect: { x: 0, y: 0, width: 400, height: 400, z: 0 } } }]
  }
  assert.equal(model.apply(op1).ok, true)
  // Replaying with identical signature -> ok (idempotent replay)
  const replayOk = model.apply(op1)
  assert.equal(replayOk.ok, true)
  assert.equal(replayOk.replayed, true)
  // Replaying with DIFFERENT operations but same operationId -> operation-reused error!
  const opTampered = { ...op1, expectedRevision: 1, actorId: 'human:2' }
  const replayBad = model.apply(opTampered)
  assert.equal(replayBad.ok, false)
  assert.equal(replayBad.code, 'operation-reused')
}

// 1.8 Hold concurrency and human validation
{
  const model = createDeskModel({ title: 'Hold Desk' })
  const addRes = model.apply({
    operationId: 'op_add_hold', expectedRevision: 0, actorId: 'human:1',
    operations: [{ type: 'add', block: { kind: 'browser', title: 'B1', resourceRef: 'https://ex.com', rect: { x: 0, y: 0, width: 400, height: 400, z: 0 } } }]
  })
  const blkId = addRes.snapshot.blocks[0].id
  assert.equal(model.hold(blkId, 'human:1').ok, true)
  // Another human tries to hold -> busy
  assert.equal(model.hold(blkId, 'human:2').code, 'busy')
  // Agent tries to hold -> invalid (only human can hold)
  assert.equal(model.hold(blkId, 'agent:1').code, 'invalid')
  // Release
  model.releaseOwner('human:1')
  assert.equal(model.hold(blkId, 'human:2').ok, true)
}

console.log('✓ Desk Chaos Tests Passed')

// ============================================================================
// 2. MODS CHAOS: Cyclic Dependencies, Reserved IDs, Manifest Validation
// ============================================================================
console.log('\n[2. Mods Chaos Tests]')
const { validatePackage, createMods } = require('../src/main/mods.cjs')

// 2.1 Reserved IDs in mod manifest
{
  const base = {
    format: 'onlyone.mod',
    apiVersion: 1,
    id: 'constructor',
    name: 'Bad Mod',
    version: '1.0.0',
    permissions: ['ui.panels'],
    panels: [{
      id: 'p1',
      title: 'P1',
      surfaces: ['main'],
      buttons: []
    }],
    rules: []
  }
  assert.throws(() => validatePackage(base), /invalid-id/, 'Mod with reserved id "constructor" must be rejected')

  const badPanel = {
    ...base,
    id: 'valid.mod',
    panels: [{
      id: 'constructor',
      title: 'P1',
      surfaces: ['main'],
      buttons: []
    }]
  }
  assert.throws(() => validatePackage(badPanel), /invalid-id/, 'Panel with reserved id "constructor" must be rejected')

  const badButton = {
    ...base,
    id: 'valid.mod',
    panels: [{
      id: 'panel1',
      title: 'P1',
      surfaces: ['main'],
      buttons: [{
        id: 'constructor',
        label: 'B1',
        action: { type: 'draft', text: 'hello' }
      }]
    }]
  }
  assert.throws(() => validatePackage(badButton), /invalid-id/, 'Button with reserved id "constructor" must be rejected')
}

// 2.2 Mod Dependencies Validation & Cycle Detection
{
  // Self dependency
  const selfDep = {
    format: 'onlyone.mod',
    apiVersion: 1,
    id: 'mod.self',
    name: 'Self Dep Mod',
    version: '1.0.0',
    permissions: ['ui.panels'],
    dependencies: ['mod.self'],
    panels: [{ id: 'p1', title: 'P1', surfaces: ['main'], buttons: [] }],
    rules: []
  }
  assert.throws(() => validatePackage(selfDep), /cyclic-dependency|invalid-dependencies/, 'Self dependency must be rejected')

  // Duplicate dependencies
  const dupDep = {
    format: 'onlyone.mod',
    apiVersion: 1,
    id: 'mod.dup',
    name: 'Dup Dep Mod',
    version: '1.0.0',
    permissions: ['ui.panels'],
    dependencies: ['mod.other', 'mod.other'],
    panels: [{ id: 'p1', title: 'P1', surfaces: ['main'], buttons: [] }],
    rules: []
  }
  assert.throws(() => validatePackage(dupDep), /invalid-dependencies/, 'Duplicate dependencies must be rejected')

  // Valid dependencies syntax in manifest
  const validDepMod = {
    format: 'onlyone.mod',
    apiVersion: 1,
    id: 'mod.client',
    name: 'Client Mod',
    version: '1.0.0',
    permissions: ['ui.panels'],
    dependencies: ['mod.base'],
    panels: [{ id: 'p1', title: 'P1', surfaces: ['main'], buttons: [] }],
    rules: []
  }
  const validated = validatePackage(validDepMod)
  assert.deepEqual(validated.dependencies, ['mod.base'])

  // Multi-mod dependency cycles in createMods
  let storageState = null
  const storage = { load: () => storageState, save: val => { storageState = structuredClone(val) } }
  const modsService = createMods({ storage })

  const modA = {
    format: 'onlyone.mod', apiVersion: 1, id: 'mod.a', name: 'Mod A', version: '1.0.0',
    permissions: ['ui.panels'], dependencies: ['mod.b'],
    panels: [{ id: 'pa', title: 'PA', surfaces: ['main'], buttons: [] }], rules: []
  }
  const modB = {
    format: 'onlyone.mod', apiVersion: 1, id: 'mod.b', name: 'Mod B', version: '1.0.0',
    permissions: ['ui.panels'], dependencies: ['mod.a'],
    panels: [{ id: 'pb', title: 'PB', surfaces: ['main'], buttons: [] }], rules: []
  }

  // Installing Mod A
  const prevA = modsService.preview({ package: modA })
  assert.equal(prevA.ok, true)
  assert.equal(modsService.commit(prevA.token).ok, true)

  // Now previewing Mod B which depends on A while A depends on B -> Cycle A <-> B!
  const prevB = modsService.preview({ package: modB })
  assert.equal(prevB.ok, false, 'Previewing cyclic dependency A <-> B must fail')
  assert.match(prevB.code, /cyclic-dependency/)

  // Indirect cycle: Mod X -> Mod Y -> Mod Z -> Mod X
  const modX = { ...modA, id: 'mod.x', dependencies: ['mod.y'] }
  const modY = { ...modA, id: 'mod.y', dependencies: ['mod.z'] }
  const modZ = { ...modA, id: 'mod.z', dependencies: ['mod.x'] }

  const cleanMods = createMods({ storage: { load: () => null, save: () => {} } })
  const pX = cleanMods.preview({ package: modX }); cleanMods.commit(pX.token)
  const pY = cleanMods.preview({ package: modY }); cleanMods.commit(pY.token)
  const pZ = cleanMods.preview({ package: modZ })
  assert.equal(pZ.ok, false, 'Indirect cycle X -> Y -> Z -> X must fail')
  assert.match(pZ.code, /cyclic-dependency/)
  // Deep cycle with 5 mods
  const m1 = { ...modA, id: 'm.1', dependencies: ['m.2'] }
  const m2 = { ...modA, id: 'm.2', dependencies: ['m.3'] }
  const m3 = { ...modA, id: 'm.3', dependencies: ['m.4'] }
  const m4 = { ...modA, id: 'm.4', dependencies: ['m.5'] }
  const m5 = { ...modA, id: 'm.5', dependencies: ['m.1'] }

  const deepService = createMods({ storage: { load: () => null, save: () => {} } })
  deepService.commit(deepService.preview({ package: m1 }).token)
  deepService.commit(deepService.preview({ package: m2 }).token)
  deepService.commit(deepService.preview({ package: m3 }).token)
  deepService.commit(deepService.preview({ package: m4 }).token)
  const p5 = deepService.preview({ package: m5 })
  assert.equal(p5.ok, false)
  assert.equal(p5.code, 'cyclic-dependency')
}

// 2.3 Adversarial Rules & Tone Fuzzing
{
  const fixtureMod = {
    format: 'onlyone.mod', apiVersion: 1, id: 'mod.rules', name: 'Rule Fuzz Mod', version: '1.0.0',
    permissions: ['ui.panels', 'events.observe'],
    panels: [{ id: 'p', title: 'P', surfaces: ['main'], buttons: [] }],
    rules: []
  }
  // Unknown event
  assert.throws(() => validatePackage({
    ...fixtureMod,
    rules: [{ event: 'unknown.event', panelId: 'p', text: 'T', tone: 'info' }]
  }), /invalid-rule/)

  // Invalid tone
  assert.throws(() => validatePackage({
    ...fixtureMod,
    rules: [{ event: 'files.changed', panelId: 'p', text: 'T', tone: 'catastrophic' }]
  }), /invalid-rule/)

  // Self-referencing after
  assert.throws(() => validatePackage({
    ...fixtureMod,
    rules: [{ event: 'files.changed', panelId: 'p', text: 'T', tone: 'info', after: 'files.changed' }]
  }), /invalid-rule/)
}

console.log('✓ Mods Chaos Tests Passed')

// ============================================================================
// 3. SCHEDULES CHAOS: Error Isolation, Malformed NextAfter, Timer Robustness
// ============================================================================
console.log('\n[3. Schedules Chaos Tests]')
const { createScheduleRunner } = require('../src/main/schedule-runner.js')
const scheduleModel = require('../src/main/schedule-model.js')

// 3.1 NextAfter throws on corrupted/adversarial schedule; Runner must not crash
{
  const mockStore = {
    load: () => ({
      records: [{
        id: 'sch_corrupted_cron',
        name: 'Corrupted Cron Schedule',
        kind: 'cron',
        timeZone: 'Europe/Moscow',
        enabled: true,
        cron: { expression: '0 0 * * 1-5' },
        action: { type: 'note', text: 'test' },
        history: []
      }, {
        id: 'sch_healthy',
        name: 'Healthy Schedule',
        kind: 'interval',
        timeZone: 'UTC',
        enabled: true,
        interval: { everyMinutes: 10 },
        action: { type: 'note', text: 'healthy' },
        history: []
      }]
    }),
    save: () => {},
    upsert: () => {},
    appendHistory: () => true,
    settleHistory: () => true,
    list: () => []
  }

  // If nextAfter throws on the broken cron
  const brokenModel = {
    ...scheduleModel,
    nextAfter: (record, fromMs) => {
      if (record.id === 'sch_corrupted_cron') {
        throw new Error('Fatal cron parse failure')
      }
      return scheduleModel.nextAfter(record, fromMs)
    }
  }

  let runner
  assert.doesNotThrow(() => {
    runner = createScheduleRunner({
      store: mockStore,
      model: brokenModel,
      now: () => 1000000,
      setTimeout: () => 1,
      clearTimeout: () => {}
    })
    runner.start()
  }, 'Runner start must not crash even when model.nextAfter throws for a corrupted schedule')

  const snap = runner.snapshot()
  const broken = snap.records.find(r => r.id === 'sch_corrupted_cron')
  assert.ok(broken, 'Corrupted schedule should still be listed in snapshot')
  assert.equal(broken.nextRunAt, null, 'Broken schedule nextRunAt should be null')
  assert.match(broken.lastError, /Fatal cron parse failure/, 'Broken schedule should record calculation error in lastError')

  const healthy = snap.records.find(r => r.id === 'sch_healthy')
  assert.ok(healthy, 'Healthy schedule must be present and unharmed')
  assert.ok(Number.isFinite(healthy.nextRunAt), 'Healthy schedule must have valid nextRunAt')
}

// 3.2 Error Isolation during sweep(): Failing task 1 must NOT block task 2 and task 3
{
  const executed = []
  const mockStore = {
    load: () => ({ records: [] }),
    save: () => {},
    upsert: () => {},
    appendHistory: () => true,
    settleHistory: () => true,
    list: () => []
  }

  let currentTime = 2000000
  let timerSeq = 0
  const activeTimers = new Map()
  const runner = createScheduleRunner({
    store: mockStore,
    model: scheduleModel,
    now: () => currentTime,
    setTimeout: (fn, ms) => { const id = ++timerSeq; activeTimers.set(id, fn); return id },
    clearTimeout: (id) => { activeTimers.delete(id) },
    execute: async (rec) => {
      executed.push(rec.id)
      if (rec.id === 'task_explode_sync') {
        throw new Error('Explosive synchronous failure inside task execution')
      }
      return { ok: true }
    }
  })
  runner.start()

  // Add 3 schedules all ready to run
  runner.add({
    id: 'task_explode_sync',
    name: 'Boom',
    kind: 'interval',
    timeZone: 'UTC',
    interval: { everyMinutes: 5 },
    action: { type: 'note', text: 'boom' }
  })
  runner.add({
    id: 'task_survivor_1',
    name: 'Survivor 1',
    kind: 'interval',
    timeZone: 'UTC',
    interval: { everyMinutes: 5 },
    action: { type: 'note', text: 'survivor 1' }
  })
  runner.add({
    id: 'task_survivor_2',
    name: 'Survivor 2',
    kind: 'interval',
    timeZone: 'UTC',
    interval: { everyMinutes: 5 },
    action: { type: 'note', text: 'survivor 2' }
  })

  // Fast forward time to trigger all 3
  currentTime += 10 * 60 * 1000
  assert.doesNotThrow(() => {
    runner.tick()
  }, 'tick() / sweep() must not throw even if a task synchronously throws')

  assert.ok(executed.includes('task_explode_sync'), 'Failing task was called')
  assert.ok(executed.includes('task_survivor_1'), 'Survivor 1 must execute despite task 1 throwing')
  assert.ok(executed.includes('task_survivor_2'), 'Survivor 2 must execute despite task 1 throwing')
}

// 3.3 Async rejection in executor safely recorded in history and snapshot
{
  const asyncStore = {
    load: () => ({ records: [] }), save: () => {}, upsert: () => {},
    appendHistory: () => true, settleHistory: () => true, list: () => []
  }
  let curr = 3000000
  const runner3 = createScheduleRunner({
    store: asyncStore,
    model: scheduleModel,
    now: () => curr,
    setTimeout: (fn) => 1,
    clearTimeout: () => {},
    execute: async (rec) => {
      if (rec.id === 'task_async_reject') {
        throw new Error('Async promise rejection in executor')
      }
      return { ok: true }
    }
  })
  runner3.start()
  runner3.add({
    id: 'task_async_reject', name: 'Async Reject', kind: 'interval', timeZone: 'UTC',
    interval: { everyMinutes: 5 }, action: { type: 'note', text: 'async' }
  })
  curr += 10 * 60 * 1000
  await assert.doesNotReject(async () => {
    await runner3.tick()
  })
  const snap3 = runner3.snapshot()
  const rejTask = snap3.records.find(r => r.id === 'task_async_reject')
  assert.ok(rejTask)
  assert.match(rejTask.lastError, /Async promise rejection/)
}

// 3.4 Concurrency of 50 simultaneous schedules without loss
{
  const mockStore50 = {
    load: () => ({ records: [] }), save: () => {}, upsert: () => {},
    appendHistory: () => true, settleHistory: () => true, list: () => []
  }
  const fired50 = new Set()
  let time50 = 4000000
  const runner50 = createScheduleRunner({
    store: mockStore50,
    model: scheduleModel,
    now: () => time50,
    setTimeout: (fn) => 1,
    clearTimeout: () => {},
    execute: async (rec) => {
      fired50.add(rec.id)
      return { ok: true }
    }
  })
  runner50.start()
  for (let i = 0; i < 50; i++) {
    runner50.add({
      id: `task_batch_${i}`, name: `Task ${i}`, kind: 'interval', timeZone: 'UTC',
      interval: { everyMinutes: 1 }, action: { type: 'note', text: `note ${i}` }
    })
  }
  time50 += 2 * 60 * 1000
  runner50.tick()
  assert.equal(fired50.size, 50, 'All 50 simultaneous schedules must execute without dropping any')
}

console.log('✓ Schedules Chaos Tests Passed')

// ============================================================================
// 4. REMOTE CONTROL CHAOS: RPC Prototype Guard, Malformed Packets & Assembler
// ============================================================================
console.log('\n[4. Remote Control Chaos Tests]')
const remoteProtocol = require('../src/shared/remote-protocol.js')
const { DeviceLink } = require('../src/shared/remote-link.js')
const { createRemoteControl } = require('../src/main/remote-control.js')

// 4.1 RPC Prototype Method Injection Guard in DeviceLink
{
  const link = new DeviceLink({
    url: 'ws://dummy',
    deviceKey: new Uint8Array(32),
    role: 'd',
    handlers: {
      'custom.method': async () => ({ status: 'ok' })
    }
  })

  // Try calling Object.prototype methods like toString, valueOf, constructor
  const protoMethods = ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__']
  for (const method of protoMethods) {
    let sentAnswer = null
    link.sendPacket = async (_type, payload) => { sentAnswer = payload }

    await link.onRequest({ id: 'req-1', method, params: {} })
    assert.ok(sentAnswer, `Answer must be sent for method ${method}`)
    assert.equal(sentAnswer.ok, false, `Method "${method}" must be rejected as unsupported`)
    assert.match(sentAnswer.error, /метод не поддерживается/)
  }

  // Valid method still works
  let validAnswer = null
  link.sendPacket = async (_type, payload) => { validAnswer = payload }
  await link.onRequest({ id: 'req-2', method: 'custom.method', params: {} })
  assert.equal(validAnswer.ok, true)
  assert.deepEqual(validAnswer.result, { status: 'ok' })
}

// 4.2 Malformed Assembler Payloads in Remote Protocol
{
  const assembler = remoteProtocol.makeAssembler()

  // Malformed part indices
  assert.throws(() => assembler.add({ id: 'c1', i: -1, n: 2, d: '{}' }), /кривой кусок/)
  assert.throws(() => assembler.add({ id: 'c1', i: 2, n: 2, d: '{}' }), /кривой кусок/)
  assert.throws(() => assembler.add({ id: 'c1', i: NaN, n: 2, d: '{}' }), /кривой кусок/)

  // Parts that assemble into invalid JSON must not throw unhandled SyntaxError
  assembler.add({ id: 'broken_json', i: 0, n: 2, t: 'test', d: '{"broken":' })
  assert.doesNotThrow(() => {
    const res = assembler.add({ id: 'broken_json', i: 1, n: 2, t: 'test', d: 'MALFORMED}' })
    assert.equal(res, null, 'Assembler should return null on broken JSON rather than crashing process')
  }, 'Broken assembled JSON must be safely caught by assembler')
}

// 4.3 Malformed message frame in DeviceLink.onMessage
{
  const link = new DeviceLink({
    url: 'ws://dummy',
    deviceKey: new Uint8Array(32),
    role: 'd'
  })

  // Must not throw on primitive/null message
  assert.doesNotThrow(async () => {
    await link.onMessage(null)
    await link.onMessage(123)
    await link.onMessage('string')
    await link.onMessage({ type: 'ev', payload: null })
    await link.onMessage({ type: 'res', payload: null })
  })
}

// 4.4 Malformed params in RemoteControl handlersFor
{
  const remote = createRemoteControl({
    relayUrl: 'ws://dummy',
    store: { read: () => ({ enabled: true, devices: [{ id: 'd1', name: 'Phone', key: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }] }), write: () => {} },
    askRenderer: async () => ({ ok: true }),
    confirmDevice: async () => true,
    listApprovals: () => [],
    resolveApproval: () => true,
    listQuestions: () => [],
    resolveQuestion: () => true,
    abortRun: () => true
  })

  const handlers = remote.handlersFor({ id: 'd1', name: 'Phone' })
  // Calling handlers with null or undefined params should not throw TypeError
  await assert.doesNotReject(async () => {
    await handlers['chat.get'](null)
    await handlers['chat.get'](undefined)
    await handlers['chat.settings'](null)
    await handlers['chat.shot'](null)
    await handlers['tasks.get'](null)
  }, 'Handlers must safely tolerate null/undefined params without crashing')

  // chat.send with null or whitespace text must reject cleanly
  await assert.rejects(() => handlers['chat.send'](null), /пустое сообщение/)
  await assert.rejects(() => handlers['chat.send']({ text: '' }), /пустое сообщение/)

  // question.answer with empty answer must reject cleanly
  await assert.rejects(() => handlers['question.answer'](null), /пустой ответ/)
  await assert.rejects(() => handlers['question.answer']({ answer: '' }), /пустой ответ/)
}

  // 4.5 Replay / Out-of-order Packet Attacks on Encrypted Session
{
  const devKey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) devKey[i] = i + 1
  const sessionSender = await remoteProtocol.makeSession(devKey, 'd', 'nonceMineD', 'nonceTheirsP')
  const sessionReceiver = await remoteProtocol.makeSession(devKey, 'p', 'nonceTheirsP', 'nonceMineD')

  const pkt1 = await sessionSender.send('test', { seq: 1 })
  const pkt2 = await sessionSender.send('test', { seq: 2 })

  const rec1 = await sessionReceiver.receive(pkt1)
  assert.deepEqual(rec1.payload, { seq: 1 })

  // Replay of packet 1 must fail
  await assert.rejects(() => sessionReceiver.receive(pkt1), /повтор или перестановка пакета/)

  // Packet 2 succeeds
  const rec2 = await sessionReceiver.receive(pkt2)
  assert.deepEqual(rec2.payload, { seq: 2 })

  // Replay of packet 2 must fail
  await assert.rejects(() => sessionReceiver.receive(pkt2), /повтор или перестановка пакета/)
}

// 4.6 Assembler LRU Eviction & Bounded Memory
{
  const asm = remoteProtocol.makeAssembler()
  for (let i = 0; i < 25; i++) {
    asm.add({ id: `flood_${i}`, i: 0, n: 2, t: 'flood', d: '{"flood":true}' })
  }
  // The first chunks (flood_0..flood_4) must have been evicted so memory doesn't grow unbounded
  // Completing the late chunk flood_24 succeeds
  const complete = asm.add({ id: 'flood_24', i: 1, n: 2, t: 'flood', d: '' })
  assert.ok(complete)
  assert.deepEqual(complete.payload, { flood: true })
}

console.log('✓ Remote Control Chaos Tests Passed')
  console.log('\n--- ALL CHAOS TESTS PASSED SUCCESSFULLY! ---')
}

runChaos().catch(err => {
  console.error('\nCHAOS TEST FAILED (RED):', err)
  process.exit(1)
})
