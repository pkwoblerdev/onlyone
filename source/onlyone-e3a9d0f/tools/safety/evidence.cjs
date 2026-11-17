'use strict'

// A finding is a claim plus records. No record, no finding (docs/os/EVIDENCE.md).
const fs = require('node:fs')
const path = require('node:path')

const KINDS = new Set(['static', 'runtime', 'test', 'screenshot'])
const CONF = new Set(['confirmed', 'observed', 'hypothesis'])

function files (dir) {
  return { findings: path.join(dir, 'findings.jsonl'), records: path.join(dir, 'records.jsonl') }
}
function append (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}
function read (file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function addFinding (dir, finding) {
  if (!finding.id || !finding.title || !CONF.has(finding.confidence)) throw new Error('finding needs id, title, confidence')
  if (!finding.kind) throw new Error('finding needs kind')
  append(files(dir).findings, finding)
  return finding
}

function addRecord (dir, record) {
  if (!record.findingId || !KINDS.has(record.kind)) throw new Error('record needs findingId and a valid kind')
  if (!record.command || !Array.isArray(record.command) || !record.command.length) throw new Error('record needs command argv')
  if (!Number.isInteger(record.exit)) throw new Error('record needs measured exit code')
  append(files(dir).records, record)
  return record
}

function verify (dir) {
  const problems = []
  const findings = read(files(dir).findings)
  const records = read(files(dir).records)
  for (const f of findings) {
    if (f.confidence === 'hypothesis') { problems.push(f.id + ': hypothesis is not a finding'); continue }
    const own = records.filter(r => r.findingId === f.id)
    if (!own.length) { problems.push(f.id + ': no record'); continue }
    if (f.confidence === 'confirmed') {
      const kinds = new Set(own.map(r => r.kind))
      if (kinds.size < 2) problems.push(f.id + ': confirmed needs two record kinds')
    }
  }
  return { ok: problems.length === 0, findings: findings.length, records: records.length, problems }
}

if (require.main === module) {
  const [cmd, dir, json] = process.argv.slice(2)
  try {
    if (cmd === 'add-finding') console.log(JSON.stringify(addFinding(dir, JSON.parse(json))))
    else if (cmd === 'add-record') console.log(JSON.stringify(addRecord(dir, JSON.parse(json))))
    else if (cmd === 'verify') { const r = verify(dir); console.log(JSON.stringify(r)); if (!r.ok) process.exitCode = 1 }
    else { console.error('usage: evidence.cjs add-finding|add-record|verify <run-dir> [json]'); process.exit(2) }
  } catch (e) { console.error(e.message); process.exit(2) }
}

module.exports = { addFinding, addRecord, verify }
