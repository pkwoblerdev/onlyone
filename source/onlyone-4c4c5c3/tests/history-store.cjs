// tests/history-store.cjs — чтение состояния истории в профиле без знания формата.
//
// У набора переписки два формата: v1 — один `data/conversations.json`, v2 —
// `data/conversations/index.json` плюс файл на диалог (`feature/hist-v2-2026-11-01`).
// Оконные прогоны обязаны проверять поведение, а не раскладку, иначе при смене
// формата шесть звеньев краснеют на ровном месте. Архивы самого набора
// (`conversations.json.key-lost-<ts>`, `conversations.key-lost-<ts>/`,
// `.corrupt-`, `.migrated-`) тоже считаются частью набора: «не уничтожено»
// проверяется по байтам под любым именем.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const dataDir = profile => path.join(profile, 'data')
const ARCHIVE = /\.(key-lost|corrupt|migrated)-/

function filesUnder (dir, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else out.push(full)
  }
  return out
}

// Всё, что зовётся conversations: файл v1, каталог v2 и архивы любого из них.
function historyFiles (profile) {
  const dir = dataDir(profile)
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.name.startsWith('conversations')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, out)
    else if (entry.name === 'conversations.json' || entry.name.startsWith('conversations.json.')) out.push(full)
  }
  return out.sort()
}

const relative = (profile, file) => path.relative(dataDir(profile), file).split(path.sep).join('/')

function historyParts (profile) {
  return historyFiles(profile).map(file => ({ name: relative(profile, file), bytes: fs.readFileSync(file) }))
}

// Живой набор без архивов: то, что приложение считает своей перепиской сейчас.
const liveParts = profile => historyParts(profile).filter(part => !ARCHIVE.test(part.name))

function historyLayout (profile) {
  if (fs.existsSync(path.join(dataDir(profile), 'conversations', 'index.json'))) return 'v2'
  return fs.existsSync(path.join(dataDir(profile), 'conversations.json')) ? 'v1' : null
}

const historyPresent = profile => historyFiles(profile).length > 0
const historyBytes = profile => historyParts(profile).reduce((sum, part) => sum + part.bytes.length, 0)

// Отпечаток набора: имена и байты. Смена формата (v1 -> v2) его меняет, поэтому
// им мерят «не переписано поверх», а не «тот же файл».
function historyDigest (profile) {
  const parts = liveParts(profile)
  if (!parts.length) return null
  const hash = createHash('sha256')
  for (const part of parts) { hash.update(part.name); hash.update('\0'); hash.update(part.bytes) }
  return hash.digest('hex')
}

function envelopeIsWhole (bytes) {
  let envelope = null
  try { envelope = JSON.parse(bytes.toString('utf8')) } catch (error) { return { whole: false, why: 'JSON не разобран: ' + error.message } }
  const text = String(envelope?.data || '')
  const body = Buffer.from(text, 'base64')
  const decodes = (envelope?.enc === 'safeStorage' || envelope?.enc === 'plain') && body.length > 16 && !/[^A-Za-z0-9+/=]/.test(text)
  return { whole: decodes, why: decodes ? '' : `enc=${envelope?.enc} длина после base64=${body.length}` }
}

// Цел ли набор: в v1 это один конверт, в v2 — конверт индекса и конверты
// диалогов (индекс тоже шифруется). Обрезанная запись видна и там, и там.
function historyWholeParts (parts) {
  if (!parts || !parts.length) return { whole: false, why: 'файлов набора нет' }
  for (const part of parts) {
    const check = envelopeIsWhole(part.bytes)
    if (!check.whole) return { whole: false, why: part.name + ': ' + check.why }
  }
  return { whole: true, why: '' }
}

const historyWhole = profile => historyWholeParts(liveParts(profile))

function dataNames (profile) {
  const dir = dataDir(profile)
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), []).map(file => relative(profile, file)))
    else out.push(entry.name)
  }
  return out
}

// Лежат ли эти байты в профиле под любым именем: так мерят архивацию, не
// завязываясь на имя архива.
function findBytes (profile, bytes) {
  if (!bytes) return null
  for (const name of dataNames(profile)) {
    let candidate = null
    try { candidate = fs.readFileSync(path.join(dataDir(profile), name.split('/').join(path.sep))) } catch { continue }
    if (candidate.equals(bytes)) return name
  }
  return null
}

// Открытый текст переписки на диске: его быть не должно ни в одном формате.
function plaintextInData (profile, text) {
  for (const name of dataNames(profile)) {
    let candidate = ''
    try { candidate = fs.readFileSync(path.join(dataDir(profile), name.split('/').join(path.sep)), 'utf8') } catch { continue }
    if (candidate.includes(text)) return name
  }
  return null
}

module.exports = { dataDir, dataNames, historyFiles, historyParts, liveParts, historyLayout, historyPresent,
  historyBytes, historyDigest, historyWhole, historyWholeParts, envelopeIsWhole, findBytes, plaintextInData }
