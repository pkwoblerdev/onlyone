// 9.8, шаг 2: ffmpeg под рукой у агента.
//
// Агент рендерит ролики через run_command, поэтому ему нужны три вещи: чтобы
// ffmpeg нашёлся, где бы он ни лежал (наш каталог, ресурсы приложения, PATH,
// winget), чтобы команда `ffmpeg` работала без длинного пути (каталог
// добавляется в PATH команды), и чтобы он знал, какой кодер здесь РАБОТАЕТ, а не
// просто значится в списке: h264_nvenc есть в сборке и на машине без видеокарты.
// Файловая система и запуск внедряются — проверка идёт без настоящего ffmpeg;
// последний блок гоняет настоящий, если он есть на машине.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { create, TIKTOK } = require('../src/main/ffmpeg-tools')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const win = p => p.replace(/\//g, '\\')
// Файловая «система» из списка путей: каталоги выводятся из файлов.
function fakeFs(files) {
  const set = new Set(files.map(win))
  const dirs = new Set()
  for (const file of set) { let d = path.win32.dirname(file); while (d && !dirs.has(d) && d !== path.win32.dirname(d)) { dirs.add(d); d = path.win32.dirname(d) } }
  return {
    exists: p => set.has(win(p)) || dirs.has(win(p)),
    listDir: p => {
      const base = win(p).replace(/\\$/, '') + '\\'
      const names = new Set()
      for (const entry of [...set, ...dirs]) if (entry.startsWith(base) && entry.length > base.length) names.add(entry.slice(base.length).split('\\')[0])
      return [...names]
    }
  }
}
const base = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\U\\AppData\\Local', PATH: 'C:\\Windows' }, userDataDir: 'C:\\Users\\U\\AppData\\Roaming\\onlyone', resourcesDir: 'C:\\Apps\\onlyone\\resources' }
const bin = dir => [`${dir}\\ffmpeg.exe`, `${dir}\\ffprobe.exe`]

const ENCODERS = ` V....D libx264              libx264 H.264
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 V....D h264_qsv             H.264 (Intel Quick Sync)
 V....D h264_amf             AMD AMF H.264 Encoder
 V....D libvpx-vp9           libvpx VP9
 A....D aac                  AAC
`
// Запуск: версия и список кодеров отвечают, «пробный кадр» — только на тех кодерах, что «работают».
const runner = ({ working = ['libx264', 'h264_nvenc'], calls = [] } = {}) => async (cmd, args) => {
  calls.push([cmd, ...args])
  if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026\nbuilt with gcc', stderr: '' }
  if (args.includes('-encoders')) return { code: 0, stdout: ENCODERS, stderr: '' }
  const encoder = args[args.indexOf('-c:v') + 1]
  if (encoder) return working.includes(encoder) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Cannot load nvcuda.dll' }
  return { code: 0, stdout: '', stderr: '' }
}

async function main() {
  await test('находит ffmpeg в нашем каталоге раньше всех прочих', async () => {
    const files = [...bin('C:\\Users\\U\\AppData\\Roaming\\onlyone\\tools\\ffmpeg\\bin'), ...bin('C:\\Windows'), ...bin('C:\\Apps\\onlyone\\resources\\ffmpeg')]
    const tools = create({ ...base, ...fakeFs(files), run: runner() })
    const found = tools.locate()
    assert.equal(found.source, 'onlyone')
    assert.equal(win(found.dir), 'C:\\Users\\U\\AppData\\Roaming\\onlyone\\tools\\ffmpeg\\bin')
  })

  await test('вшитый в приложение ffmpeg — вторым, PATH — третьим', async () => {
    const one = create({ ...base, ...fakeFs([...bin('C:\\Apps\\onlyone\\resources\\ffmpeg'), ...bin('C:\\Windows')]), run: runner() })
    assert.equal(one.locate().source, 'bundled')
    const two = create({ ...base, ...fakeFs(bin('C:\\Windows')), run: runner() })
    assert.equal(two.locate().source, 'path')
  })

  await test('находит установку winget в каталоге с версией в имени', async () => {
    const dir = 'C:\\Users\\U\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin'
    const tools = create({ ...base, ...fakeFs(bin(dir)), run: runner() })
    const found = tools.locate()
    assert.equal(found.source, 'winget')
    assert.equal(win(found.dir), dir)
  })

  await test('ffmpeg без ffprobe за найденный не считается', async () => {
    const tools = create({ ...base, ...fakeFs(['C:\\Windows\\ffmpeg.exe']), run: runner() })
    assert.equal(tools.locate(), null)
  })

  await test('нигде нет — locate() пуст, status() говорит, что делать', async () => {
    const tools = create({ ...base, ...fakeFs([]), run: runner() })
    assert.equal(tools.locate(), null)
    const status = await tools.status()
    assert.equal(status.found, false)
    assert.equal(status.canInstall, true, 'на Windows есть winget-путь установки')
    assert.match(status.installHint, /winget|Gyan\.FFmpeg/)
  })

  await test('status: версия, кодеры и рабочий кодер проверены пробным кадром', async () => {
    const dir = 'C:\\Windows'
    const calls = []
    const tools = create({ ...base, ...fakeFs(bin(dir)), run: runner({ working: ['libx264', 'h264_nvenc'], calls }) })
    const status = await tools.status()
    assert.equal(status.found, true)
    assert.equal(status.version, '8.1.1')
    assert.equal(status.encoders.h264_nvenc, true)
    assert.equal(status.encoders.h264_qsv, false, 'значится в списке, но пробный кадр не прошёл')
    assert.equal(status.encoders.libx264, true)
    assert.equal(status.best, 'h264_nvenc')
    assert.ok(calls.some(call => call.includes('h264_qsv')), 'каждый аппаратный кодер проверяется кадром')
  })

  await test('нет работающего аппаратного кодера — берётся libx264', async () => {
    const tools = create({ ...base, ...fakeFs(bin('C:\\Windows')), run: runner({ working: ['libx264'] }) })
    assert.equal((await tools.status()).best, 'libx264')
  })

  await test('кодера, которого нет в списке, кадром не проверяют', async () => {
    const calls = []
    const tools = create({ ...base, ...fakeFs(bin('C:\\Windows')), run: async (cmd, args) => {
      calls.push(args)
      if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' }
      if (args.includes('-encoders')) return { code: 0, stdout: ' V....D libx264 x\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    } })
    await tools.status()
    assert.ok(!calls.some(args => args.includes('h264_nvenc')))
  })

  await test('окружение команды: каталог ffmpeg впереди PATH, остальное цело', async () => {
    const tools = create({ ...base, ...fakeFs(bin('C:\\Ff\\bin')), env: { ...base.env, PATH: 'C:\\Windows;C:\\Ff\\bin' }, run: runner() })
    const env = tools.envWithTools({ PATH: 'C:\\Windows', TEMP: 'C:\\t' })
    assert.ok(env.PATH.startsWith('C:\\Ff\\bin;') || env.PATH === 'C:\\Ff\\bin;C:\\Windows', env.PATH)
    assert.equal(env.TEMP, 'C:\\t')
    const none = create({ ...base, ...fakeFs([]), run: runner() }).envWithTools({ PATH: 'C:\\Windows' })
    assert.equal(none.PATH, 'C:\\Windows', 'нет ffmpeg — окружение не трогаем')
  })

  await test('окружение: ключ PATH любого регистра (Path в Windows)', async () => {
    const tools = create({ ...base, ...fakeFs(bin('C:\\Ff\\bin')), env: { ...base.env, PATH: 'C:\\Ff\\bin' }, run: runner() })
    const env = tools.envWithTools({ Path: 'C:\\Windows' })
    assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1)
  })

  await test('установка: winget с согласием на условия, потом ffmpeg находится', async () => {
    const dir = 'C:\\Users\\U\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_x\\ffmpeg-8-full_build\\bin'
    let installed = false
    const calls = []
    const files = { list: [] }
    const tools = create({
      ...base,
      exists: p => installed ? fakeFs(bin(dir)).exists(p) : false,
      listDir: p => installed ? fakeFs(bin(dir)).listDir(p) : [],
      run: async (cmd, args) => {
        calls.push([cmd, ...args])
        if (cmd === 'winget') { installed = true; return { code: 0, stdout: 'Successfully installed', stderr: '' } }
        return runner()(cmd, args)
      }
    })
    const done = await tools.install()
    assert.equal(done.ok, true, JSON.stringify(done))
    const winget = calls.find(call => call[0] === 'winget')
    assert.ok(winget.includes('Gyan.FFmpeg') && winget.includes('--accept-package-agreements') && winget.includes('--accept-source-agreements') && winget.includes('-e'))
    assert.equal(done.status.found, true)
  })

  await test('установка: отказ winget доходит словами, ffmpeg не выдуман', async () => {
    const tools = create({ ...base, ...fakeFs([]), run: async () => ({ code: 1, stdout: '', stderr: 'No package found' }) })
    const done = await tools.install()
    assert.equal(done.ok, false)
    assert.match(done.error, /winget/i)
  })

  await test('установка не на Windows не притворяется: путь назван словами', async () => {
    const tools = create({ ...base, platform: 'linux', ...fakeFs([]), run: runner() })
    const status = await tools.status()
    assert.equal(status.canInstall, false)
    assert.match(status.installHint, /apt|brew|ffmpeg/i)
    const done = await tools.install()
    assert.equal(done.ok, false)
  })

  await test('пресет TikTok: 1080×1920, вертикально, yuv420p, faststart, звук AAC', async () => {
    assert.equal(TIKTOK.width, 1080)
    assert.equal(TIKTOK.height, 1920)
    const tools = create({ ...base, ...fakeFs(bin('C:\\Windows')), run: runner() })
    const args = tools.tiktokArgs({ encoder: 'h264_nvenc', fps: 60 })
    const line = args.join(' ')
    assert.match(line, /-c:v h264_nvenc/)
    assert.match(line, /-pix_fmt yuv420p/)
    assert.match(line, /-movflags \+faststart/)
    assert.match(line, /-c:a aac/)
    assert.match(line, /-r 60/)
    assert.match(line, /scale=1080:1920/)
    assert.match(tools.tiktokArgs({ encoder: 'libx264' }).join(' '), /-c:v libx264 .*-crf/)
  })

  await test('подсказка агенту: пути, кодер, готовая команда, без выдумок при отсутствии', async () => {
    const tools = create({ ...base, ...fakeFs(bin('C:\\Windows')), run: runner() })
    const info = await tools.advice()
    assert.equal(info.found, true)
    assert.match(info.ffmpeg, /ffmpeg\.exe$/)
    assert.match(info.ffprobe, /ffprobe\.exe$/)
    assert.equal(info.encoder, 'h264_nvenc')
    assert.match(info.tiktok.command, /ffmpeg/)
    const none = await create({ ...base, ...fakeFs([]), run: runner() }).advice()
    assert.equal(none.found, false)
    assert.ok(none.next && /ffmpeg_install/.test(none.next))
  })

  // yt-dlp: референсы приходят ссылками, а «изучи вот эти видео» начинается со скачивания.
  await test('yt-dlp находится в PATH и в установке winget', async () => {
    const one = create({ ...base, ...fakeFs(['C:\\Windows\\yt-dlp.exe']), run: runner() })
    assert.equal(win(one.locateYtDlp().file), 'C:\\Windows\\yt-dlp.exe')
    const dir = 'C:\\Users\\U\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_x'
    const two = create({ ...base, ...fakeFs([`${dir}\\yt-dlp.exe`]), run: runner() })
    assert.equal(two.locateYtDlp().source, 'winget')
    assert.equal(create({ ...base, ...fakeFs([]), run: runner() }).locateYtDlp(), null)
  })

  await test('скачивание: только http(s), лучшее до 1080p, mp4, путь файла из вывода', async () => {
    const calls = []
    const tools = create({ ...base, ...fakeFs(['C:\\Windows\\yt-dlp.exe', ...bin('C:\\Ff\\bin')]), env: { ...base.env, PATH: 'C:\\Windows;C:\\Ff\\bin' },
      run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'C:\\refs\\clip [abc].mp4\n', stderr: '' } } })
    for (const bad of ['file:///C:/x.mp4', 'ftp://x/y.mp4', 'javascript:alert(1)', 'C:\\x.mp4', '']) {
      const refused = await tools.download(bad, 'C:\\refs')
      assert.equal(refused.ok, false, bad)
    }
    const done = await tools.download('https://www.tiktok.com/@a/video/1', 'C:\\refs')
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.equal(done.file, 'C:\\refs\\clip [abc].mp4')
    const line = calls[0].join(' ')
    assert.match(line, /--no-playlist/)
    assert.match(line, /--merge-output-format mp4/)
    assert.match(line, /height<=1080/)
    assert.match(line, /--ffmpeg-location C:\\Ff\\bin/)
    assert.ok(calls[0].includes('https://www.tiktok.com/@a/video/1'))
  })

  await test('скачивание без yt-dlp говорит, как его поставить', async () => {
    const done = await create({ ...base, ...fakeFs([]), run: runner() }).download('https://example.com/v', 'C:\\refs')
    assert.equal(done.ok, false)
    assert.match(done.error, /yt-dlp/)
  })

  await test('установка yt-dlp: winget yt-dlp.yt-dlp', async () => {
    const calls = []
    let installed = false
    const tools = create({ ...base, exists: p => installed && win(p) === 'C:\\Windows\\yt-dlp.exe', listDir: () => [],
      run: async (cmd, args) => { calls.push([cmd, ...args]); installed = true; return { code: 0, stdout: 'ok', stderr: '' } } })
    const done = await tools.install('yt-dlp')
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.ok(calls[0].includes('yt-dlp.yt-dlp'))
  })

  // Настоящий ffmpeg — если он на машине, то работает не только «в теории».
  const real = create({})
  if (real.locate()) {
    await test('настоящий ffmpeg: статус, пробный кадр и один секундный ролик в 1080×1920', async () => {
      const status = await real.status()
      assert.equal(status.found, true)
      assert.ok(status.encoders.libx264 || status.best, 'хоть один кодер работает')
      const out = path.join(require('node:os').tmpdir(), `onlyone-ffmpeg-${process.pid}.mp4`)
      const args = ['-y', '-f', 'lavfi', '-i', 'color=c=0x1d1b17:s=1080x1920:r=30:d=1', ...real.tiktokArgs({ encoder: status.best, fps: 30, noAudio: true }), out]
      const done = await real.exec(status.ffmpeg, args, { timeoutMs: 60000 })
      assert.equal(done.code, 0, done.stderr.slice(-400))
      const probe = await real.exec(status.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt', '-of', 'csv=p=0', out])
      assert.match(probe.stdout, /1080,1920/)
      assert.match(probe.stdout, /yuv420p/)
      try { fs.unlinkSync(out) } catch { /* временный файл теста */ }
    })
  } else {
    console.log('пропущено: настоящего ffmpeg на машине нет — блок с ним не гонялся')
  }

  if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
  console.log('\nВсе проверки ffmpeg-инструментов пройдены')
}

main().catch(error => { console.error(error); process.exit(1) })
