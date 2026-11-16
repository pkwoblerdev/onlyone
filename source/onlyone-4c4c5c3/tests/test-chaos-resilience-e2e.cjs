// Сквозной интеграционный стресс-тест устойчивости Onlyone (Chaos & Resilience E2E).
//
// Проверяет выживаемость приложения при экстремальных сбоях:
// 1. Шторм IPC-событий (flood) и отмена на лету без утечек и зомби.
// 2. Изоляция необработанных промисов (unhandledRejection) в асинхронных обработчиках IPC.
// 3. Перехват глобальных исключений (uncaughtException) без аварийного падения.
// 4. Повреждение / исчезновение рабочей директории (Chaos FS) при запуске процессов.
// 5. Защита от зомби-процессов: полный реестр и принудительная зачистка при аварии/сигналах (SIGINT/SIGTERM/quit).
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const root = path.join(__dirname, '..')
const commandRunner = require('../src/main/command-runner')

let resilienceGuard = null
try {
  resilienceGuard = require('../src/main/resilience-guard.cjs')
} catch {
  // Будет реализован на шаге TDD Green
}

const failures = []
let checks = 0

async function check(name, fn) {
  try {
    await fn()
    checks++
    console.log('ok ' + name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.error('FAIL ' + name + ' — ' + error.message)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-chaos-'))
const script = (name, body) => {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, body)
  return `"${process.execPath}" "${file}"`
}

// Создаёт процесс, пишущий пульс (heartbeat) в файл каждые 80 мс
function createHeartbeat(name, stopAfterMs = 30000) {
  const mark = path.join(tmpDir, `${name}.beat`)
  const body = `const fs=require('fs');const t=setInterval(()=>fs.appendFileSync('${mark.replace(/\\/g, '\\\\')}','x'),80);`
    + `setTimeout(()=>{clearInterval(t);process.exit(0)},${stopAfterMs});`
  return { command: script(`${name}.js`, body), mark }
}

async function isProcessWriting(mark, waitMs = 400) {
  const initial = fs.existsSync(mark) ? fs.statSync(mark).size : 0
  await new Promise(r => setTimeout(r, waitMs))
  const after = fs.existsSync(mark) ? fs.statSync(mark).size : 0
  return after > initial
}

function createFakeIpc() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle(channel, fn) { handlers.set(channel, fn) },
    handleOnce(channel, fn) { handlers.set(channel, fn) },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(fn)
    },
    once(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(fn)
    },
    async invoke(channel, event, ...args) {
      const h = handlers.get(channel)
      if (!h) throw new Error(`Канал ${channel} не зарегистрирован`)
      return h(event, ...args)
    },
    emit(channel, event, ...args) {
      const list = listeners.get(channel) || []
      const results = []
      for (const fn of list) {
        results.push(fn(event, ...args))
      }
      return results
    }
  }
}

function mockWindowEvent(url = 'file:///app/src/renderer/index.html') {
  const mainFrame = { url }
  const sender = {
    getType: () => 'window',
    mainFrame,
    isDestroyed: () => false,
    send: () => {}
  }
  return { sender, senderFrame: mainFrame }
}

;(async () => {
  console.log('--- СТАРТ CHAOS & RESILIENCE E2E ТЕСТОВ ---')

  // 1. Реестр активных процессов и зачистка зомби
  await check('реестр дочерних процессов: commandRunner отслеживает активные процессы и очищает их', async () => {
    assert.ok(typeof commandRunner.getActiveProcessCount === 'function', 'commandRunner обязан экспортировать getActiveProcessCount')
    assert.ok(typeof commandRunner.killAllActiveProcesses === 'function', 'commandRunner обязан экспортировать killAllActiveProcesses')

    const initialCount = commandRunner.getActiveProcessCount()
    const hb1 = createHeartbeat('zombie_check_1')
    const hb2 = createHeartbeat('zombie_check_2')

    // Запускаем два долгоживущих процесса в фоне
    const p1 = commandRunner.run({ command: hb1.command, cwd: tmpDir, timeoutMs: 20000 })
    const p2 = commandRunner.run({ command: hb2.command, cwd: tmpDir, timeoutMs: 20000 })

    // Даем им стартовать
    await new Promise(r => setTimeout(r, 600))
    assert.ok(commandRunner.getActiveProcessCount() >= initialCount + 2, 'Запущенные процессы должны быть учтены в реестре')
    assert.equal(await isProcessWriting(hb1.mark), true, 'Процесс 1 должен активно писать')
    assert.equal(await isProcessWriting(hb2.mark), true, 'Процесс 2 должен активно писать')

    // Принудительно зачищаем все процессы (симуляция аварийной остановки / SIGINT)
    commandRunner.killAllActiveProcesses()

    await new Promise(r => setTimeout(r, 800))
    assert.equal(await isProcessWriting(hb1.mark), false, 'После killAllActiveProcesses процесс 1 не должен писать (зомби убит)')
    assert.equal(await isProcessWriting(hb2.mark), false, 'После killAllActiveProcesses процесс 2 не должен писать (зомби убит)')
    assert.equal(commandRunner.getActiveProcessCount(), initialCount, 'Реестр должен быть очищен')

    await Promise.allSettled([p1, p2])
  })

  // 2. Повреждение рабочей директории (Chaos FS)
  await check('устойчивость к повреждённой или несуществующей рабочей директории (Chaos FS)', async () => {
    const nonExistentDir = path.join(tmpDir, 'corrupted_dir_' + Date.now(), 'missing_sub')
    
    // Запуск команды в несуществующей / поврежденной папке не должен приводить к падению или неперехваченному исключению
    const result = await commandRunner.run({
      command: `"${process.execPath}" -e "process.exit(0)"`,
      cwd: nonExistentDir,
      timeoutMs: 3000
    })

    assert.equal(result.ok, false, 'Команда в несуществующей папке не может быть успешной')
    assert.equal(result.failedToStart, true, 'Должен быть выставлен флаг failedToStart')
    assert.ok(result.error && result.error.length > 0, 'Должно быть внятное сообщение об ошибке')
  })

  // 3. Барьер необработанных промисов и исключений (Resilience Guard)
  await check('модуль resilience-guard: корректный перехват и изоляция unhandledRejection и uncaughtException', async () => {
    assert.ok(resilienceGuard, 'resilience-guard.cjs должен быть доступен')
    
    const logs = []
    const guard = resilienceGuard.createResilienceGuard({
      onLog: msg => logs.push(msg),
      isProduction: false
    })

    guard.install()

    try {
      // Симуляция выброса unhandledRejection
      const fakeError = new Error('Симуляция хаоса: необработанное отклонение промиса')
      process.emit('unhandledRejection', fakeError, Promise.resolve())

      const rejections = guard.getCapturedRejections()
      assert.equal(rejections.length, 1, 'Unhandled rejection должен быть зафиксирован барьером')
      assert.ok(logs.some(l => l.includes('unhandledRejection')), 'Должна быть запись в журнал о перехваченном промисе')

      // Симуляция некритичного uncaughtException
      const nonFatalError = new Error('Симуляция хаоса: некритичный сбой таймера')
      process.emit('uncaughtException', nonFatalError, 'timerCallback')

      const exceptions = guard.getCapturedExceptions()
      assert.equal(exceptions.length, 1, 'Uncaught exception должен быть зафиксирован барьером')
      assert.ok(logs.some(l => l.includes('uncaughtException')), 'Должна быть запись в журнал об исключении')
    } finally {
      guard.uninstall()
    }
  })

  // 4. Симуляция IPC Flood & Storm с отменой на лету
  await check('IPC flood & storm: шквал 50 параллельных запросов и отмен не роняет систему', async () => {
    assert.ok(resilienceGuard, 'resilience-guard.cjs должен быть доступен')
    
    const ipc = createFakeIpc()
    const activeControllers = new Map()

    // Защищенный мост обработки
    const bridge = resilienceGuard.createIpcFloodBarrier({
      activeControllers,
      maxBurst: 100
    })

    let completed = 0
    let aborted = 0

    // Регистрируем mock send-message
    ipc.handle('send-message', async (event, payload) => {
      const { requestId } = payload
      const controller = bridge.registerRequest(requestId, event)
      
      try {
        // Симулируем работу шага
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve('done:' + requestId), 200)
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t)
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          }, { once: true })
        })
        completed++
        return { ok: true, requestId }
      } catch (err) {
        if (err.name === 'AbortError') {
          aborted++
          return { ok: false, aborted: true, requestId }
        }
        throw err
      } finally {
        bridge.finishRequest(requestId)
      }
    })

    // Регистрируем abort-message
    ipc.handle('abort-message', async (_event, requestId) => {
      return bridge.abortRequest(requestId)
    })

    const winEv = mockWindowEvent()
    const tasks = []

    // Запускаем шторм из 50 запросов
    for (let i = 0; i < 50; i++) {
      const id = `storm_req_${i % 10}` // Повторяющиеся ID для провокации гонок и замещения
      tasks.push(ipc.invoke('send-message', winEv, { requestId: id }))
      if (i % 3 === 0) {
        // Каждый третий запрос тут же пытаемся отменить на лету
        tasks.push(ipc.invoke('abort-message', winEv, id))
      }
    }

    const results = await Promise.allSettled(tasks)
    assert.equal(results.every(r => r.status === 'fulfilled'), true, 'Все запросы шторма должны благополучно разрешиться без падений')
    assert.ok(completed + aborted > 0, 'Запросы должны распределиться между завершенными и отмененными')
    assert.equal(activeControllers.size, 0, 'В конце шторма не должно остаться зависших контроллеров')
  })

  // 5. Изоляция асинхронных ошибок в ipcMain.on
  await check('изоляция асинхронных сбоев в ipcMain.on: ошибки слушателей не превращаются в unhandledRejection', async () => {
    const mainPath = path.join(root, 'src', 'main', 'main.js')
    const mainSource = fs.readFileSync(mainPath, 'utf8')
    const guardStart = mainSource.indexOf('function installIpcSenderGuard(')
    assert.ok(guardStart >= 0, 'installIpcSenderGuard должен присутствовать в main.js')
    const guardEnd = mainSource.indexOf('\ninstallIpcSenderGuard(ipcMain', guardStart)
    assert.ok(guardEnd > guardStart, 'граница installIpcSenderGuard должна быть найдена')

    const installGuard = new Function('require', mainSource.slice(guardStart, guardEnd) + '\nreturn installIpcSenderGuard')(require)

    const ipc = createFakeIpc()
    const refusedLogs = []
    installGuard(ipc, path.join(root, 'src', 'renderer'), (channel, from) => refusedLogs.push(`${channel}:${from}`))

    const { pathToFileURL } = require('node:url')
    const winEv = mockWindowEvent(pathToFileURL(path.join(root, 'src', 'renderer', 'index.html')).href)

    let unhandledTriggered = false
    const tempHandler = () => { unhandledTriggered = true }
    process.once('unhandledRejection', tempHandler)

    // Регистрируем асинхронный listener on, который намеренно бросает ошибку
    ipc.on('test-async-crash', async () => {
      await new Promise(r => setTimeout(r, 10))
      throw new Error('Крах внутри асинхронного события IPC on')
    })

    // Вызываем событие
    ipc.emit('test-async-crash', winEv)

    // Ждем выполнения промиса
    await new Promise(r => setTimeout(r, 100))
    process.removeListener('unhandledRejection', tempHandler)

    assert.equal(unhandledTriggered, false, 'Асинхронная ошибка в ipcMain.on не должна попадать в unhandledRejection процесса')
  })

  // 6. Симуляция аварийных сигналов SIGINT/SIGTERM и очистки
  await check('сигналы SIGINT/SIGTERM: перехват и безопасная очистка процессов и ходов', async () => {
    let turnsAborted = false
    let procsKilled = false
    let shutdownCalled = false

    const guard = resilienceGuard.createResilienceGuard({
      abortTurns: () => { turnsAborted = true },
      terminateProcesses: () => { procsKilled = true },
      onShutdown: () => { shutdownCalled = true },
      isProduction: false
    })

    guard.install()
    try {
      // Имитируем получение SIGINT
      process.emit('SIGINT')

      assert.equal(turnsAborted, true, 'Активные ходы должны быть отменены при SIGINT')
      assert.equal(procsKilled, true, 'Дочерние процессы должны быть зачищены при SIGINT')
      assert.equal(shutdownCalled, true, 'Коллбек завершения должен быть вызван при SIGINT')
    } finally {
      guard.uninstall()
    }
  })

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}

  console.log(`\nИТОГ: проверок=${checks}, провалов=${failures.length}`)
  if (failures.length > 0) {
    console.error('Провалы:\n' + failures.join('\n'))
    process.exit(1)
  }
  process.exit(0)
})()
