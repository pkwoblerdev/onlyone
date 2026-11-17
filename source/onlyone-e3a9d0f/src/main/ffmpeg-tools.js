'use strict'

// ffmpeg под рукой у агента (план, 9.8).
//
// Ролики агент собирает через `run_command`, а значит ему нужны три вещи:
//  1. чтобы ffmpeg нашёлся, где бы он ни лежал — свой каталог приложения,
//     ресурсы установщика, PATH, установка winget, привычные каталоги;
//  2. чтобы в команде работало короткое `ffmpeg` (каталог встаёт впереди PATH
//     команды: приложение, запущенное из проводника, PATH установщика не видит);
//  3. чтобы он знал, какой кодер здесь РАБОТАЕТ. h264_nvenc значится в списке любой
//     полной сборки, в том числе на машине без видеокарты, — поэтому аппаратный
//     кодер проверяется пробным кадром, а не строкой списка.
//
// Файловая система и запуск процессов внедряются: модуль проверяется без
// настоящего ffmpeg. Ничего не скачивает сам — установка идёт только через
// winget и только когда её позвали (в приложении — через подтверждение).

const fssync = require('fs')
const nodePath = require('path')
const { spawn } = require('child_process')

// Вертикальный ролик под TikTok/Reels/Shorts.
const TIKTOK = Object.freeze({ width: 1080, height: 1920, fps: 30, maxFps: 60, audioRate: 48000 })

// Порядок «кто лучше»: аппаратные кодеры быстрее в разы, libx264 — всегда есть.
const HARDWARE = ['h264_nvenc', 'h264_qsv', 'h264_amf']
const WATCHED = [...HARDWARE, 'libx264', 'libx265', 'libvpx-vp9']
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_TIMEOUT_MS = 20 * 1000

// Обычный запуск: вывод целиком в память (ffmpeg -encoders — килобайты), таймаут,
// без окна консоли. Для долгих рендеров этот запуск не годится — они идут через
// `run_command`, у которого есть очередь задач и обрезка вывода.
function defaultRun(command, args = [], { timeoutMs = 30000, cwd, signal } = {}) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let done = false
    let child
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result) } }
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message || error) })
      return
    }
    const killTree = () => {
      // У yt-dlp и winget есть дети (ffmpeg, установщик): без /T они переживут родителя.
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* уже ушёл */ }
      } else {
        try { child.kill() } catch { /* уже завершился */ }
      }
    }
    const timer = setTimeout(() => {
      killTree()
      finish({ code: -2, stdout, stderr: stderr + '\n[таймаут]' })
    }, timeoutMs)
    if (signal) {
      const onAbort = () => { killTree(); finish({ code: -3, stdout, stderr: stderr + '\n[остановлено]' }) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000) })
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000) })
    child.on('error', error => finish({ code: -1, stdout, stderr: stderr + String(error.message || error) }))
    child.on('close', code => finish({ code: code === null ? -1 : code, stdout, stderr }))
  })
}

function create(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix
  const exists = options.exists || (p => { try { return fssync.existsSync(p) } catch { return false } })
  const listDir = options.listDir || (p => { try { return fssync.readdirSync(p) } catch { return [] } })
  const run = options.run || defaultRun
  const exe = name => (platform === 'win32' ? `${name}.exe` : name)
  const delimiter = platform === 'win32' ? ';' : ':'
  const envValue = key => {
    const hit = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase())
    return hit ? env[hit] : undefined
  }

  // Каталог, где лежат оба исполняемых файла. ffmpeg без ffprobe не годится:
  // разбор чужого ролика начинается с ffprobe.
  const hasBoth = dir => Boolean(dir) && exists(P.join(dir, exe('ffmpeg'))) && exists(P.join(dir, exe('ffprobe')))

  // Каталог распаковки: сам он, его `bin`, или `<версия>/bin` (так лежат сборки
  // gyan.dev и BtbN) — на глубину одного вложенного каталога.
  function binDirsUnder(root) {
    if (!root || !exists(root)) return []
    const found = [root, P.join(root, 'bin')]
    for (const name of listDir(root)) {
      if (/\.[a-z0-9]{1,4}$/i.test(name)) continue
      found.push(P.join(root, name, 'bin'), P.join(root, name))
    }
    return found
  }

  function candidates() {
    const list = []
    const add = (source, dirs) => { for (const dir of dirs) list.push({ source, dir }) }
    if (options.userDataDir) add('onlyone', binDirsUnder(P.join(options.userDataDir, 'tools', 'ffmpeg')))
    if (options.resourcesDir) add('bundled', binDirsUnder(P.join(options.resourcesDir, 'ffmpeg')))
    add('path', String(envValue('PATH') || '').split(delimiter).map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean))
    if (platform === 'win32') {
      const local = envValue('LOCALAPPDATA')
      if (local) {
        const packages = P.join(local, 'Microsoft', 'WinGet', 'Packages')
        for (const name of listDir(packages)) {
          if (/ffmpeg/i.test(name)) add('winget', binDirsUnder(P.join(packages, name)))
        }
        add('winget', [P.join(local, 'Microsoft', 'WinGet', 'Links')])
      }
      const choco = envValue('ChocolateyInstall') || 'C:\\ProgramData\\chocolatey'
      add('common', ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', P.join(choco, 'bin'), P.join(envValue('USERPROFILE') || '', 'scoop', 'shims')])
    } else {
      add('common', ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'])
    }
    return list
  }

  function locate() {
    for (const candidate of candidates()) {
      if (hasBoth(candidate.dir)) {
        return { source: candidate.source, dir: candidate.dir, ffmpeg: P.join(candidate.dir, exe('ffmpeg')), ffprobe: P.join(candidate.dir, exe('ffprobe')) }
      }
    }
    return null
  }

  // Что предложить, когда ffmpeg нет.
  const installHint = platform === 'win32'
    ? 'winget install --id Gyan.FFmpeg -e (ставится одной кнопкой в Настройках или инструментом ffmpeg_install)'
    : platform === 'darwin'
      ? 'brew install ffmpeg'
      : 'sudo apt install ffmpeg (или менеджер пакетов вашего дистрибутива)'

  // Проба: список кодеров + пробный кадр на каждом аппаратном. Результат держится
  // в памяти до `refresh`: три запуска — секунды, повторять их на каждый вызов не за чем.
  let cache = null

  async function probe(found) {
    const version = await run(found.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: PROBE_TIMEOUT_MS })
    const listed = await run(found.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: PROBE_TIMEOUT_MS })
    const text = String(listed.stdout || '')
    const inList = name => new RegExp(`^\\s*[VAS][A-Z.]{5}\\s+${name.replace(/[-.]/g, '\\$&')}\\s`, 'm').test(text)
    const encoders = {}
    for (const name of WATCHED) encoders[name] = false
    for (const name of WATCHED) {
      if (!inList(name)) continue
      if (!HARDWARE.includes(name)) { encoders[name] = true; continue }
      const frame = await run(found.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2',
        '-c:v', name, '-pix_fmt', 'yuv420p', '-frames:v', '3', '-f', 'null', '-'], { timeoutMs: PROBE_TIMEOUT_MS })
      encoders[name] = frame.code === 0
    }
    const match = /ffmpeg version (\S+)/i.exec(String(version.stdout || ''))
    const number = match ? (/^\d+(?:\.\d+)*/.exec(match[1]) || [match[1]])[0] : ''
    const best = [...HARDWARE, 'libx264'].find(name => encoders[name]) || ''
    return { version: number, encoders, best }
  }

  async function status({ refresh = false } = {}) {
    const found = locate()
    if (!found) {
      cache = null
      return { found: false, canInstall: platform === 'win32', installHint }
    }
    if (refresh || !cache || cache.dir !== found.dir) cache = { dir: found.dir, ...(await probe(found)) }
    return {
      found: true, source: found.source, dir: found.dir, ffmpeg: found.ffmpeg, ffprobe: found.ffprobe,
      version: cache.version, encoders: cache.encoders, best: cache.best,
      canInstall: platform === 'win32', installHint
    }
  }

  // Каталог ffmpeg — в начало PATH команды. Нет ffmpeg — окружение не трогаем.
  function envWithTools(base = {}) {
    const found = locate()
    const next = { ...base }
    if (!found) return next
    const key = Object.keys(next).find(name => name.toLowerCase() === 'path') || 'PATH'
    const current = String(next[key] || '')
    const has = current.split(delimiter).some(item => item.replace(/[\\/]+$/, '').toLowerCase() === found.dir.replace(/[\\/]+$/, '').toLowerCase())
    // Каталог уже в PATH — порядок сохраняем: человек мог поставить его так нарочно.
    if (!has) next[key] = current ? `${found.dir}${delimiter}${current}` : found.dir
    return next
  }

  // Аргументы кодера. Значения — обычные для вертикального ролика в соцсети:
  // достаточно высокое качество, чтобы не «мылило» после перекодирования площадкой.
  const ENCODER_ARGS = {
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', '25M', '-bufsize', '50M', '-profile:v', 'high'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '21', '-profile:v', 'high'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-profile:v', 'high'],
    libx264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']
  }

  // Кодер, частота, формат пикселей, faststart и звук — без масштабирования: размер кадра
  // задаёт вызывающий (рендер страницы отдаёт кадр уже нужного размера).
  function videoArgs({ encoder = 'libx264', fps = TIKTOK.fps, noAudio = false } = {}) {
    const rate = Math.min(Math.max(Math.round(Number(fps) || TIKTOK.fps), 1), TIKTOK.maxFps)
    const video = ENCODER_ARGS[encoder] || ENCODER_ARGS.libx264
    return [
      ...video,
      '-r', String(rate), '-g', String(rate * 2), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      ...(noAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', String(TIKTOK.audioRate)])
    ]
  }

  function tiktokArgs(options = {}) {
    return [
      '-vf', `scale=${TIKTOK.width}:${TIKTOK.height}:force_original_aspect_ratio=decrease,pad=${TIKTOK.width}:${TIKTOK.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      ...videoArgs(options)
    ]
  }

  const quote = value => (/[\s()&|^]/.test(value) ? `"${value}"` : value)

  // Что читает агент: пути, рабочий кодер, готовая команда под TikTok.
  async function advice() {
    const state = await status()
    if (!state.found) {
      return {
        found: false,
        canInstall: state.canInstall,
        installHint: state.installHint,
        next: 'ffmpeg не найден. Вызови ffmpeg_install (человек подтвердит установку одной кнопкой), потом снова ffmpeg_info.'
      }
    }
    const encoder = state.best || 'libx264'
    const command = ['ffmpeg', '-y', '-i', 'input.mp4', ...tiktokArgs({ encoder, fps: 30 }), 'renders/out.mp4'].map(quote).join(' ')
    return {
      found: true,
      ffmpeg: state.ffmpeg,
      ffprobe: state.ffprobe,
      version: state.version,
      source: state.source,
      encoder,
      encoders: state.encoders,
      tiktok: {
        width: TIKTOK.width, height: TIKTOK.height, fps: [30, 60], container: 'mp4 (h264 + aac)',
        command,
        args: tiktokArgs({ encoder, fps: 30 })
      },
      notes: [
        'В run_command короткое `ffmpeg` и `ffprobe` работает: каталог добавлен в PATH команды.',
        'Долгий рендер — поднимай timeout_seconds (до 600) и клади результат в рабочую папку, потом show_video с путём.',
        'Разобрать чужой ролик: ffprobe -v error -show_format -show_streams -of json <файл>; смены планов: ffmpeg -i <файл> -vf "select=gt(scene\\,0.3),showinfo" -f null -'
      ]
    }
  }

  // yt-dlp: референс чаще ссылка, чем файл. Ищется там же, где ffmpeg, но по своему
  // имени; установка — тем же winget.
  function locateYtDlp() {
    const dirs = []
    const add = (source, list) => { for (const dir of list) dirs.push({ source, dir }) }
    if (options.userDataDir) add('onlyone', [P.join(options.userDataDir, 'tools', 'yt-dlp')])
    add('path', String(envValue('PATH') || '').split(delimiter).map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean))
    if (platform === 'win32') {
      const local = envValue('LOCALAPPDATA')
      if (local) {
        const packages = P.join(local, 'Microsoft', 'WinGet', 'Packages')
        for (const name of listDir(packages)) if (/yt-dlp/i.test(name)) add('winget', [P.join(packages, name)])
        add('winget', [P.join(local, 'Microsoft', 'WinGet', 'Links')])
      }
    } else {
      add('common', ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
    }
    for (const { source, dir } of dirs) {
      const file = P.join(dir, exe('yt-dlp'))
      if (exists(file)) return { source, dir, file }
    }
    return null
  }

  const ytDlpHint = platform === 'win32' ? 'winget install --id yt-dlp.yt-dlp -e' : 'brew install yt-dlp (или pip install yt-dlp)'

  // Скачивание референса: только http(s) — file:, javascript: и путь на диске сюда
  // не относятся. Лучшее качество до 1080p, в mp4; итоговый путь берётся из вывода
  // самого yt-dlp (после перемещения), а не угадывается по шаблону имени.
  async function download(url, dir, { signal } = {}) {
    const link = String(url || '').trim()
    if (!/^https?:\/\/\S+$/i.test(link)) return { ok: false, error: 'Скачать можно только ссылку http(s).' }
    const found = locateYtDlp()
    if (!found) return { ok: false, error: `yt-dlp не найден. Поставь его: ffmpeg_install с tool «yt-dlp» (${ytDlpHint}).` }
    const withFfmpeg = locate()
    const args = ['--no-playlist', '--no-warnings', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
      ...(withFfmpeg ? ['--ffmpeg-location', withFfmpeg.dir] : []),
      '--restrict-filenames', '-o', P.join(dir, '%(title).80B [%(id)s].%(ext)s'), '--print', 'after_move:filepath', link]
    const done = await run(found.file, args, { timeoutMs: 20 * 60 * 1000, signal })
    if (done.code === -3) return { ok: false, aborted: true, error: 'Скачивание остановлено.' }
    const lines = String(done.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const file = lines[lines.length - 1]
    if (done.code !== 0 || !file) {
      const tail = String(done.stderr || done.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
      return { ok: false, error: `yt-dlp не скачал (код ${done.code}): ${tail || 'нет ответа'}` }
    }
    return { ok: true, file }
  }

  async function install(tool = 'ffmpeg') {
    if (tool === 'yt-dlp') {
      if (platform !== 'win32') return { ok: false, error: `Автоматическая установка есть только на Windows (winget). Здесь: ${ytDlpHint}.` }
      if (locateYtDlp()) return { ok: true, already: true }
      const done = await run('winget', ['install', '--id', 'yt-dlp.yt-dlp', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { timeoutMs: INSTALL_TIMEOUT_MS })
      if (!locateYtDlp()) {
        const tail = String(done.stderr || done.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
        return { ok: false, error: `winget не поставил yt-dlp (код ${done.code}): ${tail || 'нет ответа'}. Поставьте вручную: ${ytDlpHint}.` }
      }
      return { ok: true }
    }
    if (platform !== 'win32') {
      return { ok: false, error: `Автоматическая установка есть только на Windows (winget). Здесь: ${installHint}.` }
    }
    const before = locate()
    if (before) return { ok: true, already: true, status: await status({ refresh: true }) }
    const done = await run('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { timeoutMs: INSTALL_TIMEOUT_MS })
    const found = locate()
    if (!found) {
      const tail = String(done.stderr || done.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
      return { ok: false, error: `winget не поставил ffmpeg (код ${done.code}): ${tail || 'нет ответа'}. Поставьте вручную: ${installHint}.` }
    }
    return { ok: true, status: await status({ refresh: true }) }
  }

  return Object.freeze({ locate, locateYtDlp, download, status, envWithTools, tiktokArgs, videoArgs, advice, install, exec: run, candidates, TIKTOK })
}

module.exports = { create, TIKTOK, HARDWARE }
