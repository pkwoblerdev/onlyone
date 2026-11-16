// Исполнение команды (план, 6.1) на настоящих процессах.
//
// У каждой проверки есть свой жёсткий дедлайн: runner обязан отчитываться, а не
// вешать набор. Без него висящий `run()` останавливает `npm test` молча, и
// непонятно, кто виноват.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { run, shapeOutput, createOutputDecoder } = require('../src/main/command-runner')

const failures = []

// Обещание с предельным временем: падение по дедлину отличается от зависания.
async function within(label, ms, promise) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`нет ответа за ${ms} мс`)), ms)
      })
    ])
  } catch (error) {
    throw new Error(`${label}: ${error.message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-runner-'))
const script = (name, body) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return `"${process.execPath}" "${file}"`
}
// Команда, которая отмечает своё существование в файле: по нему видно, что
// процесс действительно снят, а не только что обещание разрешилось.
const heartbeat = (name, ms = 100, stopAfter = 40000) => {
  const mark = path.join(dir, `${name}.beat`)
  const body = `const fs=require('fs');const t=setInterval(()=>fs.appendFileSync('${mark.replace(/\\/g, '\\\\')}','x'),${ms});`
    + `setTimeout(()=>{clearInterval(t);process.exit(0)},${stopAfter})`
  // cmd.exe does not treat backslash as a universal quote escape. Keep the
  // fixture in a file so the test measures timeout/abort, not -e quoting.
  return { command: script(`${name}.js`, body), mark }
}
// Главное в этом помощнике — не «не пиши», а «не ври, если всё-таки пишет».
// Снятие дерева на Windows делает `taskkill /T`; в среде, где он запрещён
// (ограничения песочницы, права), runner снимает только cmd.exe, а node-потомок
// живёт и дописывает в проект. Проверка обязана отличить эти два случая:
//   • процесс умер — хорошо;
//   • процесс жив И модуль сам об этом сказал (`killUnconfirmed`) — ограничение
//     среды, и оно называется вслух, а не выдаётся за поломку приложения;
//   • процесс жив, а модуль молчит или говорит `killed: true` — дефект кода.
async function assertStopped(mark, label, result) {
  const first = fs.existsSync(mark) ? fs.statSync(mark).size : 0
  await new Promise(resolve => setTimeout(resolve, 900))
  const after = fs.existsSync(mark) ? fs.statSync(mark).size : 0
  if (after === first) {
    // No writes observed is not proof that the whole process tree was killed:
    // a child may not have started yet. Accept the conservative unknown result,
    // but never accept a positive kill claim while writes continue.
    if (result && result.killUnconfirmed === true) {
      assert.notEqual(result.killed, true, `${label}: неподтверждённое снятие названо успешным`)
      console.log(`ok ${label}: новых записей не видно; снятие честно осталось неподтверждённым`)
      return
    }
    assert.equal(result && result.killed, true,
      `${label}: активности не видно, но runner не подтвердил и не описал исход`)
    return
  }
  assert.equal(result && result.killUnconfirmed, true,
    `${label}: процесс продолжает писать (${first} → ${after} знаков), а runner этого не заметил`)
  assert.notEqual(result && result.killed, true,
    `${label}: runner объявил остановленной команду, которая пишет (${first} → ${after} знаков)`)
  console.log(`ok ${label}: в этой среде дерево не снимается (${first} → ${after} знаков) — `
    + 'runner сообщает об этом, а не выдаёт «остановлено»')
}

async function main() {
  await test('UTF-8 символ, разделённый между чанками, остаётся целым', () => {
    const decoder = createOutputDecoder({ windows: true })
    const bytes = Buffer.from('Сборка завершена', 'utf8')
    const output = decoder.push(bytes.subarray(0, 3))
      + decoder.push(bytes.subarray(3, 8))
      + decoder.push(bytes.subarray(8))
      + decoder.end()
    assert.equal(output, 'Сборка завершена')
  })

  await test('OEM CP866 распознаётся отдельно от UTF-8', () => {
    const decoder = createOutputDecoder({ windows: true })
    const bytes = Buffer.from('afe0aea2a5e0aaa02daaaea4a8e0aea2aaa82e7478740d0a', 'hex')
    assert.equal(decoder.push(bytes) + decoder.end(), 'проверка-кодировки.txt\r\n')
  })

  await test('обычная команда возвращается выводом и нулевым кодом', async () => {
    const result = await within('обычная команда зависла', 20000,
      run({ command: script('ok.js', 'console.log("работа сделана")'), cwd: dir, timeoutMs: 20000 }))
    assert.equal(result.exitCode, 0)
    assert.equal(result.ok, true)
    assert.match(result.output, /работа сделана/)
  })

  await test('ненулевой код не считается успехом и остаётся виден', async () => {
    const result = await within('падение команды зависло', 20000,
      run({ command: script('fail.js', 'console.error("тест упал"); process.exit(3)'), cwd: dir, timeoutMs: 20000 }))
    assert.equal(result.exitCode, 3)
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, false)
    assert.match(result.output, /тест упал/)
  })

  await test('команда работает в указанной папке', async () => {
    const result = await within('команда в папке зависла', 20000,
      run({ command: script('cwd.js', 'console.log(process.cwd())'), cwd: dir, timeoutMs: 20000 }))
    assert.equal(result.output.trim().toLowerCase(), dir.toLowerCase())
  })

  await test('таймаут снимает процесс, а не ждёт до конца', async () => {
    const beat = heartbeat('timeout-beat')
    const started = Date.now()
    // Дедлайн = лимит хода + запас на снятие дерева. Codex замерил 30 637 мс
    // при timeoutMs 500: runner полагался только на `taskkill` и ждал, пока
    // чужой процесс сам закончится.
    const result = await within('таймаут завис', 6000,
      run({ command: beat.command, cwd: dir, timeoutMs: 500 }))
    const waited = Date.now() - started
    assert.equal(result.timedOut, true)
    assert.equal(result.ok, false)
    assert.ok(waited < 6000, `ожидание ${waited} мс — дерево процессов не снялось`)
    await assertStopped(beat.mark, 'после таймаута', result)
  })

  await test('снятие дерева не удерживает ход: есть жёсткий дедлайн', async () => {
    // Процесс, который не закрывает вывод и не реагирует на снятие: ровно то,
    // что Codex замерил как 30 637 мс при timeoutMs 500. `close` от такого не
    // приходит никогда, поэтому ход обязан закончиться по дедлайну runner-а.
    const cp = require('node:child_process')
    const { EventEmitter } = require('node:events')
    const { PassThrough } = require('node:stream')
    const savedSpawn = cp.spawn
    cp.spawn = () => {
      const child = new EventEmitter()
      child.pid = 424242
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => false
      child.unref = () => {}
      return child
    }
    delete require.cache[require.resolve('../src/main/command-runner')]
    const fresh = require('../src/main/command-runner')
    try {
      const started = Date.now()
      const result = await within('ход ждёт чужого конца', 4000,
        fresh.run({ command: 'что угодно', cwd: dir, timeoutMs: 400, killGraceMs: 700 }))
      const waited = Date.now() - started
      assert.equal(result.timedOut, true)
      assert.equal(result.truncated, true, 'ход завершился без честной отметки о неполном выводе')
      assert.ok(waited < 2500, `ожидание ${waited} мс — дедлайн не работает`)
    } finally {
      cp.spawn = savedSpawn
      delete require.cache[require.resolve('../src/main/command-runner')]
    }
  })

  await test('потомок вне дерева не удерживает ход', async () => {
    // То же на настоящих процессах: потомок `start /b` переживает снятие cmd.
    const exe = process.execPath.split('/').join('\\')
    const command = `start /b "" ${exe} -e "setInterval(()=>{},40000)" & "${exe}" -e "setInterval(()=>{},40000)"`
    const started = Date.now()
    const result = await within('потомок держит вывод', 5000,
      run({ command, cwd: dir, timeoutMs: 400, killGraceMs: 800 }))
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 5000, 'ход не завершился по дедлайну')
  })

  await test('остановка пользователем отличается от таймаута', async () => {
    const beat = heartbeat('abort-beat')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    const result = await within('отмена зависла', 6000,
      run({ command: beat.command, cwd: dir, timeoutMs: 20000, signal: controller.signal }))
    assert.equal(result.aborted, true)
    assert.equal(result.timedOut, false)
    assert.equal(result.ok, false)
    // Отмена обязана снять таймер: иначе по истечении `timeoutMs` runner убивает
    // уже чужой pid, который система перерадала.
    assert.ok(Date.now() - started < 20000, 'ход ждал своего таймаута, а не отмены')
    await assertStopped(beat.mark, 'после отмены', result)
  })

  // Прежний контракт врал: когда `taskkill` недоступен, runner снимал один
  // cmd.exe, node-потомок оставался живым, а результат говорил `killed: true`.
  // Владелец measured это как «после Stop процесс пишет дальше» (15→23 и 18→26
  // байт). Здесь то же самое воспроизводится намеренно, и проверяется, что
  // модуль больше этого не отрицает.
  await test('отказ снятия дерева не объявляется остановкой', async () => {
    const cp = require('node:child_process')
    const { EventEmitter } = require('node:events')
    const savedSpawn = cp.spawn
    let taskkillCalls = 0
    cp.spawn = (file, args, opts) => {
      if (String(file).toLowerCase().includes('taskkill')) {
        taskkillCalls++
        // Ровно то, что даёт ограниченная среда: процесс не запускается вовсе.
        const denied = new EventEmitter()
        denied.pid = 999999
        setImmediate(() => denied.emit('error', Object.assign(new Error('spawn taskkill EACCES'), { code: 'EACCES' })))
        return denied
      }
      return savedSpawn(file, args, opts)
    }
    delete require.cache[require.resolve('../src/main/command-runner')]
    const fresh = require('../src/main/command-runner')
    // Маркер живёт три секунды: если снятие не подтвердится, сирота умрёт сам,
    // и проверка не оставит за собой пишущий процесс.
    const beat = heartbeat('unconfirmed-beat', 100, 3000)
    try {
      const result = await within('отказанный runner завис', 8000,
        fresh.run({ command: beat.command, cwd: dir, timeoutMs: 500, killGraceMs: 400 }))
      assert.equal(result.timedOut, true)
      assert.equal(taskkillCalls, 1, 'снятие дерева даже не пыталось сработать')
      assert.equal(result.killed, false, 'runner назвал остановленным то, что не смог снять')
      assert.equal(result.killUnconfirmed, true, 'неподтверждённое снятие не помечено')
      const size = () => (fs.existsSync(beat.mark) ? fs.statSync(beat.mark).size : 0)
      const before = size()
      await new Promise(resolve => setTimeout(resolve, 700))
      const after = size()
      if (after > before) {
        console.log(`   (потомок пережил отказ снятия: ${before} → ${after} знаков — runner честно сообщил об этом)`)
      } else {
        console.log('   (после отказа новых записей не наблюдалось; runner всё равно не заявил, что дерево снято)')
      }
      assert.ok(result.output.includes(fresh.UNCONFIRMED_WARNING),
        'модель не получает предупреждение в выводе: «остановлено» прочитается как «можно заново»')
    } finally {
      cp.spawn = savedSpawn
      delete require.cache[require.resolve('../src/main/command-runner')]
    }
  })

  await test('настоящий taskkill подтверждает снятие или виден предел среды', async () => {
    // Реальный OS-вызов может быть запрещён тестовой песочницей. В этом случае
    // не объявляем функциональность проверенной: принимаем только явный
    // killUnconfirmed + предупреждение, без ложного killed=true.
    const beat = heartbeat('confirmed-beat', 100, 6000)
    const result = await within('подтверждённое снятие зависло', 8000,
      run({ command: beat.command, cwd: dir, timeoutMs: 500, killGraceMs: 1500 }))
    assert.equal(result.timedOut, true)
    if (result.killUnconfirmed === true) {
      assert.equal(result.killed, false, 'неподтверждённое снятие названо успешным')
      assert.ok(result.output.includes(require('../src/main/command-runner').UNCONFIRMED_WARNING),
        'ограничение среды не сообщено вызывающей стороне')
      console.log('   SKIP: ОС не подтвердила снятие дерева; warning сохранён, убийство процесса не заявлено')
      return
    }
    assert.equal(result.killed, true, 'снятие не подтверждено и не помечено как неизвестное')
    await assertStopped(beat.mark, 'после подтверждённого снятия', result)
  })

  await test('снятый до запуска сигнал не запускает команду', async () => {
    const mark = path.join(dir, 'never-ran.txt')
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = await within('отменённый запуск завис', 3000, run({
      command: `"${process.execPath}" -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(mark).replace(/\\/g, '\\\\')},'было')`).replace(/"/g, '\\"')}`,
      cwd: dir, timeoutMs: 8000, signal: controller.signal
    }))
    assert.equal(result.aborted, true)
    assert.equal(result.notStarted, true)
    assert.equal(fs.existsSync(mark), false, 'команда выполнилась после отмены')
    assert.ok(Date.now() - started < 1000, 'отменённый запуск ждал столько, сколько живёт команда')
  })

  await test('нельзя запустить того, чего нет', async () => {
    const result = await within('несуществующая команда зависла', 15000,
      run({ command: 'onlyone-no-such-tool-xyz --help', cwd: dir, timeoutMs: 10000 }))
    assert.equal(result.ok, false)
    assert.ok(result.exitCode !== 0)
  })

  await test('длинный вывод режется с честной отметкой', async () => {
    const body = 'for (let i = 0; i < 4000; i++) console.log("строка " + i + " " + "х".repeat(60))'
    const result = await within('длинный вывод завис', 40000,
      run({ command: script('long.js', body), cwd: dir, timeoutMs: 30000 }))
    assert.ok(result.dropped > 0, 'середина не помечена как выпавшая')
    assert.match(result.output, /выпало \d+ знаков середины/)
    assert.match(result.output, /строка 0 /)
    assert.match(result.output, /строка 3999 /)
    assert.ok(result.output.length < 60000, 'обрезка не сработала')
  })

  await test('кириллица доходит целой, а не кракозябрами', async () => {
    const result = await within('кириллица зависла', 25000,
      run({ command: script('cyr.js', 'console.log("Сборка завершена: 12 тестов")'), cwd: dir, timeoutMs: 20000 }))
    assert.match(result.output, /Сборка завершена: 12 тестов/)
    assert.ok(!/[°¦®±]/.test(result.output), 'похоже на CP866, прочитанный как UTF-8')
  })

  await test('на Windows консоль переключена в UTF-8 до команды', async () => {
    const probe = await within('chcp завис', 25000, run({ command: 'chcp', cwd: dir, timeoutMs: 20000 }))
    if (process.platform !== 'win32') { console.log('   (не Windows — проверка пропущена)'); return }
    assert.match(probe.output, /65001/, `активная страница не UTF-8: ${probe.output}`)
  })

  await test('dir сохраняет русские имена файлов в UTF-8', async () => {
    if (process.platform !== 'win32') { console.log('   (не Windows — проверка пропущена)'); return }
    const name = 'проверка-кодировки.txt'
    fs.writeFileSync(path.join(dir, name), 'ok', 'utf8')
    const result = await within('dir с кириллицей завис', 25000,
      run({ command: 'dir /b', cwd: dir, timeoutMs: 20000 }))
    assert.ok(result.ok, `dir завершился с ошибкой ${result.exitCode}: ${result.output}`)
    assert.ok(result.output.split(/\r?\n/).some(line => line.trim() === name),
      `имя не сохранилось: ${result.output}`)
  })

  // Б-5, перепроверка: встроенная команда cmd.exe пишет в CP866, а дочерний
  // процесс в той же команде — в UTF-8. Кодек не должен «залипать» на первом.
  await test('CP866 после UTF-8 и UTF-8 после CP866 в одном потоке', () => {
    const oem = Buffer.from('afe0aea2a5e0aaa02daaa8e0a8ababa8e6eb2e7478740d0a', 'hex') // проверка-кириллицы.txt
    const utf = Buffer.from('Сборка завершена ✓\n', 'utf8')
    const a = createOutputDecoder({ windows: true })
    assert.equal(a.push(oem) + a.push(utf) + a.end(), 'проверка-кириллицы.txt\r\nСборка завершена ✓\n')
    const b = createOutputDecoder({ windows: true })
    assert.equal(b.push(utf) + b.push(oem) + b.end(), 'Сборка завершена ✓\nпроверка-кириллицы.txt\r\n')
    const c = createOutputDecoder({ windows: true })
    assert.equal(c.push(Buffer.concat([oem, utf])) + c.end(), 'проверка-кириллицы.txt\r\nСборка завершена ✓\n')
  })

  await test('UTF-8 символ, разрезанный между чанками после CP866-строки', () => {
    const oem = Buffer.from('afe0aea2a5e0aaa02daaa8e0a8ababa8e6eb2e7478740d0a', 'hex')
    const utf = Buffer.from('Сборка ✓ готова\n', 'utf8')
    const d = createOutputDecoder({ windows: true })
    const out = d.push(oem) + d.push(utf.subarray(0, 3)) + d.push(utf.subarray(3, 11)) + d.push(utf.subarray(11)) + d.end()
    assert.equal(out, 'проверка-кириллицы.txt\r\nСборка ✓ готова\n')
  })

  await test('короткое CP866-имя, случайно похожее на UTF-8, не портится после CP866-строки', () => {
    // «раб.txt» в CP866: e0 a0 a1 — формально верная трёхбайтная UTF-8 последовательность.
    const first = Buffer.from('afe0aea2a5e0aaa02daaa8e0a8ababa8e6eb2e7478740d0a', 'hex')
    const rab = Buffer.from('e0a0a12e7478740d0a', 'hex')
    const d = createOutputDecoder({ windows: true })
    assert.equal(d.push(first) + d.push(rab) + d.end(), 'проверка-кириллицы.txt\r\nраб.txt\r\n')
  })

  await test('dir, затем дочерний Node с UTF-8 в одной команде: оба читаются правильно', async () => {
    if (process.platform !== 'win32') { console.log('   (не Windows — проверка пропущена)'); return }
    const name = 'смешанный-вывод.txt'
    fs.writeFileSync(path.join(dir, name), 'ok', 'utf8')
    const child = script('mixed.js', 'console.log("Сборка завершена ✓ 日本")')
    const result = await within('смешанный вывод завис', 25000,
      run({ command: `dir /b *.txt & ${child}`, cwd: dir, timeoutMs: 20000 }))
    const lines = result.output.split(/\r?\n/).map(line => line.trim())
    assert.ok(lines.includes(name), `имя не сохранилось: ${result.output}`)
    assert.ok(lines.includes('Сборка завершена ✓ 日本'), `UTF-8 потомка испорчен после dir: ${result.output}`)
  })

  // Б-5, перепроверка: «снимает всё дерево» — это и внуки, не только прямой потомок cmd.
  await test('таймаут и остановка снимают внука через промежуточный процесс', async () => {
    for (const mode of ['timeout', 'abort']) {
      const grandMark = path.join(dir, `grand-${mode}.beat`)
      const grand = path.join(dir, `grand-${mode}.js`)
      fs.writeFileSync(grand, `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(grandMark)},'g'),80);setTimeout(()=>process.exit(0),15000)`)
      const childBody = `require('child_process').spawn(${JSON.stringify(`"${process.execPath}" "${grand}"`)},{shell:true,stdio:'ignore'});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000)`
      const controller = new AbortController()
      if (mode === 'abort') setTimeout(() => controller.abort(), 2000)
      const result = await within(`внук (${mode}) завис`, 12000, run({
        command: script(`child-${mode}.js`, childBody), cwd: dir,
        timeoutMs: mode === 'timeout' ? 2000 : 20000, signal: controller.signal
      }))
      assert.equal(mode === 'timeout' ? result.timedOut : result.aborted, true)
      const size = () => (fs.existsSync(grandMark) ? fs.statSync(grandMark).size : 0)
      const before = size()
      await new Promise(resolve => setTimeout(resolve, 900))
      const after = size()
      if (after > before) {
        assert.equal(result.killUnconfirmed, true, `${mode}: внук пишет (${before} → ${after}), а runner этого не заметил`)
        assert.notEqual(result.killed, true, `${mode}: runner заявил остановку при живом внуке`)
      } else {
        assert.equal(result.killed, true, `${mode}: внук молчит, но снятие не подтверждено`)
      }
    }
  })

  await test('хвост вывода умещается в одну строку', async () => {
    const body = 'console.log("шаг 1"); console.log("ошибка: expected true"); console.error("FAIL smoke: 3 из 112")'
    const result = await within('хвост вывода завис', 25000,
      run({ command: script('tail.js', body), cwd: dir, timeoutMs: 20000 }))
    const { lastLines } = require('../src/main/command-runner')
    const line = lastLines(result.output)
    assert.match(line, /FAIL smoke/)
    assert.ok(!line.includes('\n'), 'в ленту должна пойти одна строка')
  })

  await test('короткий вывод не трогается', () => {
    const shaped = shapeOutput('ровно одна строка')
    assert.deepEqual(shaped, { text: 'ровно одна строка', dropped: 0 })
  })

  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
}

main().finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
