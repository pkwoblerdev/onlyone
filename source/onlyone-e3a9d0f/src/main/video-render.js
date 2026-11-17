'use strict'

// Разбор чужого ролика и рендер своего (план, 9.8, шаги 3–4).
//
// Разбор даёт агенту факты, из которых строится «схема монтажа» по референсу:
// длительность, кадровая частота, ориентация, звук, СМЕНЫ ПЛАНОВ, ритм и лист
// кадров (по кадру с каждого плана), который модель с глазами видит целиком.
// Модуль ничего не «понимает» про содержание — он измеряет; понимание — дело модели.
//
// Рендер — долгая работа: ffmpeg запускается с `-progress pipe:1`, доля идёт в
// Центр задач, отмена снимает процесс, а итог проверяется ffprobe: «код 0» ещё не
// значит, что ролик есть и он тех размеров, что просили.
//
// Запуск процессов внедряется (`exec`, `spawnFn`), чтобы разборщики проверялись
// строками; настоящий ffmpeg гоняется в tests/test-video-render.cjs.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])
// Склейка ближе к краю — это не смена плана, а прогрев кодека или хвост.
const EDGE_SECONDS = 0.25
const SCENE_THRESHOLD = 0.3
const MAX_SHOTS = 400
const SHEET_FRAME_WIDTH = 360
const SHEET_COLUMNS = 4

const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ── чистые разборщики ───────────────────────────────────────────────────────

function parseSceneTimes(text) {
  const times = []
  for (const match of String(text || '').matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 0) times.push(value)
  }
  return times
}

function buildShots(cuts, duration) {
  const total = Number(duration) || 0
  const inner = [...new Set((cuts || []).map(Number).filter(Number.isFinite))]
    .sort((a, b) => a - b)
    .filter(time => time >= EDGE_SECONDS && time <= total - EDGE_SECONDS)
    .slice(0, MAX_SHOTS)
  const bounds = [0, ...inner, total]
  const shots = []
  for (let i = 0; i < bounds.length - 1; i++) {
    shots.push({ index: i + 1, start: round(bounds[i]), end: round(bounds[i + 1]), duration: round(bounds[i + 1] - bounds[i]) })
  }
  return shots
}

function shotStats(shots, duration) {
  const list = Array.isArray(shots) ? shots : []
  const lengths = list.map(shot => shot.duration).sort((a, b) => a - b)
  const total = Number(duration) || lengths.reduce((sum, value) => sum + value, 0)
  if (!lengths.length) return { count: 0, averageSeconds: 0, medianSeconds: 0, shortestSeconds: 0, longestSeconds: 0, cutsPerMinute: 0, rhythm: [] }
  const middle = Math.floor(lengths.length / 2)
  const median = lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2
  // Ритм по отрезкам: где ролик ускоряется, а где выдыхает. Отрезок — пятая часть
  // ролика, но не короче трёх секунд: на коротком ролике пять «корзин» — шум.
  const bucket = Math.max(3, total / 5)
  const rhythm = []
  for (let from = 0; from < total - 0.001; from += bucket) {
    const to = Math.min(from + bucket, total)
    const cuts = list.filter(shot => shot.index > 1 && shot.start >= from && shot.start < to).length
    rhythm.push({ from: round(from), to: round(to), cuts })
  }
  return {
    count: lengths.length,
    averageSeconds: round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
    medianSeconds: round(median),
    shortestSeconds: lengths[0],
    longestSeconds: lengths[lengths.length - 1],
    cutsPerMinute: total > 0 ? round(((lengths.length - 1) / total) * 60) : 0,
    rhythm
  }
}

function parseFraction(text) {
  const match = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(String(text || '').trim())
  if (!match) return Number.isFinite(Number(text)) && String(text || '').trim() ? Number(text) : 0
  const denominator = Number(match[2])
  return denominator ? Number(match[1]) / denominator : 0
}

// Вывод `-progress pipe:1` приходит кусками: строка может оборваться на границе.
function progressParser() {
  let rest = ''
  let seconds = 0
  let done = false
  return {
    push(chunk) {
      rest += String(chunk || '')
      const lines = rest.split(/\r?\n/)
      rest = lines.pop()
      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const number = Number(value)
          // out_time_ms у ffmpeg — тоже микросекунды (историческая путаница названия).
          if (Number.isFinite(number) && number >= 0) seconds = number / 1e6
        } else if (key === 'progress' && String(value).trim() === 'end') done = true
      }
      return { seconds: round(seconds, 3), done }
    }
  }
}

function clockSeconds(text) {
  const parts = String(text || '').trim().split(':').map(Number)
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0
  return parts.reduce((sum, part) => sum * 60 + part, 0)
}

function expectedSeconds(args) {
  const list = Array.isArray(args) ? args.map(String) : []
  for (const flag of ['-t', '-to']) {
    const at = list.indexOf(flag)
    if (at >= 0 && list[at + 1] !== undefined) {
      const seconds = clockSeconds(list[at + 1])
      if (seconds > 0) return seconds
    }
  }
  return 0
}

const tail = (text, lines = 6) => String(text || '').trim().split(/\r?\n/).slice(-lines).join('\n').slice(-800)

// ── разбор ролика ───────────────────────────────────────────────────────────

async function probe(tools, file, exec) {
  const done = await exec(tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeoutMs: 60000 })
  if (done.code !== 0) return { error: `Не удалось прочитать файл как видео: ${tail(done.stderr, 3) || 'ffprobe не ответил'}` }
  let data
  try { data = JSON.parse(done.stdout) } catch { return { error: 'Не удалось прочитать файл как видео: ffprobe вернул не JSON.' } }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const stream = streams.find(item => item.codec_type === 'video' && item.disposition?.attached_pic !== 1)
  if (!stream) return { error: 'В файле нет видеопотока — это не видео.' }
  return { data, stream, audio: streams.find(item => item.codec_type === 'audio') || null }
}

function orientationOf(width, height) {
  if (width === height) return 'square'
  return height > width ? 'vertical' : 'horizontal'
}

async function extractSheet(tools, file, shots, outDir, exec, maxFrames) {
  const chosen = shots.length <= maxFrames ? shots
    : Array.from({ length: maxFrames }, (_, i) => shots[Math.round((i * (shots.length - 1)) / (maxFrames - 1))])
  fs.mkdirSync(outDir, { recursive: true })
  const frames = []
  for (let i = 0; i < chosen.length; i++) {
    const shot = chosen[i]
    const target = path.join(outDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`)
    const at = shot.start + shot.duration / 2
    const done = await exec(tools.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(round(at, 3)), '-i', file,
      '-frames:v', '1', '-vf', `scale=${SHEET_FRAME_WIDTH}:-2`, '-q:v', '4', target], { timeoutMs: 60000 })
    if (done.code === 0 && fs.existsSync(target)) frames.push({ shot: shot.index, at: round(at), file: target })
  }
  if (!frames.length) return null
  const columns = Math.min(SHEET_COLUMNS, frames.length)
  const rows = Math.ceil(frames.length / columns)
  const sheet = path.join(outDir, 'sheet.jpg')
  const done = await exec(tools.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1',
    '-i', path.join(outDir, 'frame_%02d.jpg'), '-vf', `tile=${columns}x${rows}`, '-frames:v', '1', '-q:v', '4', sheet], { timeoutMs: 60000 })
  if (done.code !== 0 || !fs.existsSync(sheet)) return null
  return { file: sheet, frames: frames.length, columns, rows, items: frames }
}

async function analyze(tools, file, options = {}) {
  const exec = options.exec
  if (typeof exec !== 'function') throw new Error('analyze: нужен exec')
  const known = await probe(tools, file, exec)
  if (known.error) return { ok: false, error: known.error }
  const { data, stream, audio } = known

  let width = Number(stream.width) || 0
  let height = Number(stream.height) || 0
  // Снято на телефон «лёжа», но с флагом поворота: показывается наоборот.
  const rotation = Math.abs(Number(stream.tags?.rotate ?? (stream.side_data_list || []).find(item => item.rotation !== undefined)?.rotation ?? 0)) % 180
  if (rotation === 90) [width, height] = [height, width]
  const duration = Number(data.format?.duration) || Number(stream.duration) || 0
  const fps = round(parseFraction(stream.avg_frame_rate) || parseFraction(stream.r_frame_rate), 3)

  // Смены планов: уменьшенный поток и порог сцены — на длинном ролике это разница
  // между секундами и минутами.
  const scene = await exec(tools.ffmpeg, ['-hide_banner', '-i', file, '-an', '-vf',
    `scale=320:-2,select=gt(scene\\,${options.sceneThreshold || SCENE_THRESHOLD}),showinfo`, '-f', 'null', '-'], { timeoutMs: 10 * 60 * 1000 })
  const shots = buildShots(parseSceneTimes(scene.stderr), duration)

  const sound = { present: Boolean(audio) }
  if (audio) {
    Object.assign(sound, { codec: audio.codec_name, sampleRate: Number(audio.sample_rate) || 0, channels: Number(audio.channels) || 0 })
    const loud = await exec(tools.ffmpeg, ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 5 * 60 * 1000 })
    const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(String(loud.stderr))
    const peak = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(String(loud.stderr))
    if (mean) sound.meanVolumeDb = Number(mean[1])
    if (peak) sound.peakVolumeDb = Number(peak[1])
  }

  let sheet = null
  if (options.outDir) {
    // Своя папка на разбор: кадры прежнего разбора того же файла в лист не попадают.
    const runDir = path.join(options.outDir, String(Date.now()))
    try { sheet = await extractSheet(tools, file, shots, runDir, exec, options.maxSheetFrames || 12) } catch { sheet = null }
  }

  return {
    ok: true,
    file,
    duration: round(duration),
    width, height,
    orientation: orientationOf(width, height),
    fps,
    videoCodec: stream.codec_name || '',
    bitrateKbps: Math.round((Number(data.format?.bit_rate) || 0) / 1000),
    sizeBytes: Number(data.format?.size) || 0,
    audio: sound,
    shots,
    stats: shotStats(shots, duration),
    sheet
  }
}

// ── рендер ──────────────────────────────────────────────────────────────────

async function render(tools, options = {}) {
  const { args, output, onProgress, signal } = options
  const spawnFn = options.spawnFn || spawn
  const cwd = options.cwd
  if (!Array.isArray(args) || !args.length) return { ok: false, error: 'Не переданы аргументы ffmpeg.' }
  const extension = path.extname(String(output || '')).toLowerCase()
  if (!VIDEO_EXTENSIONS.has(extension)) return { ok: false, error: `Результат должен быть видеофайлом: mp4, webm или mov; получено «${extension || 'без расширения'}».` }
  if (signal?.aborted) return { ok: false, aborted: true, error: 'Остановлено пользователем.' }

  const expected = Number(options.expectSeconds) || expectedSeconds(args)
  const fullArgs = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', ...args.map(String), output]
  const started = Date.now()
  const parser = progressParser()
  let stderr = ''
  let aborted = false

  const result = await new Promise(resolve => {
    let child
    try {
      child = spawnFn(tools.ffmpeg, fullArgs, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, error: String(error.message || error) })
      return
    }
    const stop = () => {
      aborted = true
      // taskkill /T — ffmpeg может держать дочерние процессы (фильтры, скрипты).
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* уже ушёл */ }
      } else {
        try { child.kill('SIGKILL') } catch { /* уже ушёл */ }
      }
    }
    if (signal) signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      const state = parser.push(chunk)
      if (typeof onProgress === 'function' && expected > 0) {
        try { onProgress(Math.min(state.seconds / expected, 0.99)) } catch { /* окно не должно ронять рендер */ }
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200000) stderr = stderr.slice(-100000) })
    child.on('error', error => resolve({ code: -1, error: String(error.message || error) }))
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', stop)
      resolve({ code: code === null ? -1 : code })
    })
  })

  const seconds = round((Date.now() - started) / 1000, 1)
  if (aborted) return { ok: false, aborted: true, seconds, error: 'Рендер остановлен. Файл на диске мог остаться недописанным — не открывай его как готовый.' }
  if (result.error) return { ok: false, seconds, error: `ffmpeg не запустился: ${result.error}` }
  if (result.code !== 0) return { ok: false, seconds, error: `ffmpeg завершился с кодом ${result.code}: ${tail(stderr)}`, tail: tail(stderr, 12) }

  // Проверка результата: файл есть, не пуст и читается как видео.
  const verified = await verifyOutput(tools, output, seconds, options.exec)
  if (verified.ok && typeof onProgress === 'function') { try { onProgress(1) } catch { /* окно не должно ронять рендер */ } }
  return verified
}

// Проверка готового ролика: он есть, не пуст, читается ffprobe и имеет длительность.
// Общая для рендера по аргументам ffmpeg и рендера страницы.
async function verifyOutput(tools, output, seconds, execGiven) {
  let bytes = 0
  try { bytes = fs.statSync(output).size } catch { /* нет файла */ }
  if (!bytes) return { ok: false, seconds, error: 'ffmpeg вернул успех, но ролика нет или он пуст.' }
  const exec = execGiven || (async (command, list) => new Promise(resolve => {
    let out = ''
    let err = ''
    const child = spawn(command, list, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('error', e => resolve({ code: -1, stdout: out, stderr: String(e.message || e) }))
    child.on('close', code => resolve({ code, stdout: out, stderr: err }))
  }))
  const known = await probe(tools, output, exec)
  if (known.error) return { ok: false, seconds, bytes, error: `Ролик записан, но не читается: ${known.error}` }
  const duration = Number(known.data.format?.duration) || Number(known.stream.duration) || 0
  if (!(duration > 0)) return { ok: false, seconds, bytes, error: 'Ролик записан, но его длительность нулевая.' }
  return {
    ok: true, output, seconds, bytes,
    duration: round(duration),
    width: Number(known.stream.width) || 0,
    height: Number(known.stream.height) || 0,
    fps: round(parseFraction(known.stream.avg_frame_rate), 3),
    codec: known.stream.codec_name || '',
    audio: Boolean(known.audio)
  }
}

module.exports = {
  analyze, render, verifyOutput, parseSceneTimes, buildShots, shotStats, parseFraction, progressParser, expectedSeconds,
  VIDEO_EXTENSIONS, SCENE_THRESHOLD
}
