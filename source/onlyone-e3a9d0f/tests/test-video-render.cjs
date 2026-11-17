// 9.8, шаги 3–4: разбор чужого ролика и рендер своего.
//
// Разбор — то, из чего агент делает «схему монтажа» по референсу: длина и кадровая
// частота, СМЕНЫ ПЛАНОВ (времена склеек), ритм (сколько склеек в минуту, какой план
// самый короткий), громкость и лист кадров, который модель с глазами видит
// целиком. Рендер — долгая работа: прогресс из `-progress`, отмена, проверка
// результата ffprobe (файл не пуст, размеры те, что просили), а не «ffmpeg вернул 0».
//
// Чистые разборщики проверяются на строках; остальное — настоящим ffmpeg, если он
// есть на машине (на машине, где его нет, блок пропускается громко).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const video = require('../src/main/video-render')
const ffmpegTools = require('../src/main/ffmpeg-tools')
const { createTaskManager } = require('../src/main/task-manager')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}
const near = (a, b, eps = 0.15) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`)

async function main() {
  // ── чистые разборщики ─────────────────────────────────────────────────────
  await test('времена склеек берутся из showinfo (pts_time), мусор игнорируется', () => {
    const text = `[Parsed_showinfo_1 @ 0000] n:   0 pts:  60000 pts_time:2.000 duration: 1 fmt:yuv420p
frame= 12 fps=0.0 q=-0.0 size=N/A
[Parsed_showinfo_1 @ 0000] n:   1 pts: 180000 pts_time:6.5   duration: 1
[Parsed_showinfo_1 @ 0000] n: 2 pts_time:abc`
    assert.deepEqual(video.parseSceneTimes(text), [2, 6.5])
  })

  await test('планы из склеек: границы, длительности, склейка у самого края отбрасывается', () => {
    const shots = video.buildShots([0.05, 2, 5, 9.98], 10)
    assert.deepEqual(shots.map(s => [s.start, s.end]), [[0, 2], [2, 5], [5, 10]], 'склейки у краёв (<0.25 с) — не планы')
    assert.deepEqual(shots.map(s => s.duration), [2, 3, 5])
    assert.deepEqual(shots.map(s => s.index), [1, 2, 3])
  })

  await test('без склеек — один план на весь ролик', () => {
    const shots = video.buildShots([], 7.5)
    assert.equal(shots.length, 1)
    assert.equal(shots[0].duration, 7.5)
  })

  await test('ритм: среднее, медиана, самый быстрый и самый долгий план, склеек в минуту', () => {
    const shots = video.buildShots([2, 5], 10)
    const stats = video.shotStats(shots, 10)
    assert.equal(stats.count, 3)
    near(stats.averageSeconds, 3.33, 0.01)
    assert.equal(stats.medianSeconds, 3)
    assert.equal(stats.shortestSeconds, 2)
    assert.equal(stats.longestSeconds, 5)
    near(stats.cutsPerMinute, 12, 0.01)
    assert.ok(Array.isArray(stats.rhythm) && stats.rhythm.length >= 1, 'ритм по отрезкам времени')
  })

  await test('кадровая частота из дроби ffprobe', () => {
    near(video.parseFraction('30000/1001'), 29.97, 0.01)
    assert.equal(video.parseFraction('60/1'), 60)
    assert.equal(video.parseFraction('0/0'), 0)
    assert.equal(video.parseFraction('abc'), 0)
  })

  await test('прогресс из -progress: секунды по out_time_us, конец по progress=end', () => {
    const parser = video.progressParser()
    assert.deepEqual(parser.push('frame=10\nout_time_us=1500000\nprogress=continue\n'), { seconds: 1.5, done: false })
    assert.deepEqual(parser.push('out_time_us=2000000\npro'), { seconds: 2, done: false }, 'обрезанная строка ждёт продолжения')
    assert.deepEqual(parser.push('gress=end\n'), { seconds: 2, done: true })
  })

  await test('ожидаемая длительность берётся из -t / -to, если её не назвали', () => {
    assert.equal(video.expectedSeconds(['-t', '12.5', '-i', 'a.mp4']), 12.5)
    assert.equal(video.expectedSeconds(['-i', 'a.mp4', '-to', '00:00:08']), 8)
    assert.equal(video.expectedSeconds(['-i', 'a.mp4']), 0)
  })

  await test('setProgress планировщика: карточка в окне получает долю, чужие состояния — нет', () => {
    const sent = []
    const manager = createTaskManager({ send: body => sent.push(body), setTimeout: fn => fn && 0, clearTimeout: () => {} })
    manager.start()
    const added = manager.add({ title: 'Рендер', kind: 'video', handle: { on() {}, kill() { return true } } })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.equal(manager.setProgress(added.id, 0.4), true)
    assert.equal(manager.get(added.id).progress, 0.4)
    assert.equal(manager.setProgress(added.id, 7), true)
    assert.equal(manager.get(added.id).progress, 1, 'выше единицы не бывает')
    assert.equal(manager.setProgress(added.id, 'abc'), false)
    assert.equal(manager.setProgress('нет-такой', 0.5), false)
    manager.stop()
  })

  // ── настоящий ffmpeg ──────────────────────────────────────────────────────
  const tools = ffmpegTools.create({})
  const found = tools.locate()
  if (!found) {
    console.log('пропущено: ffmpeg на машине нет — блок с настоящим разбором и рендером не гонялся')
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-video-render-'))
    const clip = path.join(dir, 'three-shots.mp4')
    const t = { ffmpeg: found.ffmpeg, ffprobe: found.ffprobe }

    await test('настоящий ролик из трёх планов по 2 с: две склейки найдены там, где они есть', async () => {
      // Три плана разной яркости подряд (детектор сцен смотрит на яркость: красный→зелёный он бы не заметил) — три плана ровно по 2 с; звук — тон, чтобы был поток аудио.
      const made = await tools.exec(found.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x568:r=30:d=2',
        '-f', 'lavfi', '-i', 'color=c=white:s=320x568:r=30:d=2',
        '-f', 'lavfi', '-i', 'color=c=0x707070:s=320x568:r=30:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { timeoutMs: 60000 })
      assert.equal(made.code, 0, made.stderr.slice(-300))
      const report = await video.analyze(t, clip, { outDir: path.join(dir, 'analysis'), exec: tools.exec, maxSheetFrames: 6 })
      assert.equal(report.ok, true, JSON.stringify(report).slice(0, 400))
      near(report.duration, 6, 0.2)
      assert.equal(report.width, 320)
      assert.equal(report.height, 568)
      assert.equal(report.orientation, 'vertical')
      near(report.fps, 30, 0.01)
      assert.equal(report.audio.present, true)
      assert.equal(report.shots.length, 3, JSON.stringify(report.shots))
      near(report.shots[1].start, 2, 0.1)
      near(report.shots[2].start, 4, 0.1)
      assert.equal(report.stats.count, 3)
      assert.ok(report.sheet && fs.existsSync(report.sheet.file), 'лист кадров лежит на диске')
      assert.ok(fs.statSync(report.sheet.file).size > 1000)
      assert.equal(report.sheet.frames, 3, 'кадр на план')
    })

    await test('разбор без звука: audio.present = false, остальное на месте', async () => {
      const silent = path.join(dir, 'silent.mp4')
      const made = await tools.exec(found.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=270x480:r=25:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent], { timeoutMs: 60000 })
      assert.equal(made.code, 0)
      const report = await video.analyze(t, silent, { outDir: path.join(dir, 'analysis2'), exec: tools.exec })
      assert.equal(report.ok, true)
      assert.equal(report.audio.present, false)
      assert.equal(report.shots.length, 1)
    })

    await test('не видео: разбор отказывает словами, а не зависает', async () => {
      const text = path.join(dir, 'note.txt')
      fs.writeFileSync(text, 'не видео')
      const report = await video.analyze(t, text, { outDir: path.join(dir, 'analysis3'), exec: tools.exec })
      assert.equal(report.ok, false)
      assert.match(report.error, /видео|прочита|не удалось/i)
    })

    await test('рендер: прогресс идёт, результат проверен ffprobe, размеры те, что просили', async () => {
      const output = path.join(dir, 'render-ok.mp4')
      const seen = []
      const done = await video.render(t, {
        args: ['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
        output, onProgress: ratio => seen.push(ratio)
      })
      assert.equal(done.ok, true, JSON.stringify(done))
      near(done.duration, 2, 0.2)
      assert.equal(done.width, 1080)
      assert.equal(done.height, 1920)
      assert.ok(done.bytes > 1000)
      assert.ok(seen.length >= 1 && seen.every(v => v >= 0 && v <= 1), `прогресс: ${seen}`)
      assert.equal(seen[seen.length - 1], 1, 'последнее значение — единица')
    })

    await test('рендер: ошибка ffmpeg доходит хвостом лога, ролика нет — ok=false', async () => {
      const output = path.join(dir, 'render-bad.mp4')
      const done = await video.render(t, { args: ['-i', path.join(dir, 'нет-такого-файла.mp4')], output })
      assert.equal(done.ok, false)
      assert.match(done.error, /нет-такого|No such file|не найден|код/i)
    })

    await test('рендер: отмена останавливает процесс и говорит об этом', async () => {
      const output = path.join(dir, 'render-cancel.mp4')
      const controller = new AbortController()
      // Длинный ролик на самой тяжёлой настройке — успеет быть снятым.
      const running = video.render(t, {
        args: ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=600', '-t', '600', '-c:v', 'libx264', '-preset', 'veryslow', '-pix_fmt', 'yuv420p'],
        output, signal: controller.signal
      })
      setTimeout(() => controller.abort(), 700)
      const done = await running
      assert.equal(done.ok, false)
      assert.equal(done.aborted, true)
    })

    await test('рендер: пустой результат не принимается за успех', async () => {
      const output = path.join(dir, 'render-empty.mp4')
      // Нулевая длительность: ffmpeg возвращает 0, а ролика по сути нет.
      const done = await video.render(t, { args: ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.001', '-frames:v', '0'], output })
      assert.equal(done.ok, false)
    })

    await test('рендер: выход по названному пути, а не по тому, что подсунули в args', async () => {
      const done = await video.render(t, { args: ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1', '-c:v', 'libx264', '-y'], output: path.join(dir, 'a.txt') })
      assert.equal(done.ok, false)
      assert.match(done.error, /mp4|webm|mov/i, 'расширение результата — видеоконтейнер')
    })

    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* временная папка теста */ }
  }

  if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
  console.log('\nВсе проверки разбора и рендера видео пройдены')
}

main().catch(error => { console.error(error); process.exit(1) })
