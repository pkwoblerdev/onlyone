'use strict'
// Demo plugin worker: line-delimited JSON-RPC, no imports so it survives being
// copied into a profile plugins directory.
const readline = require('node:readline')

const handlers = {
  ping: () => ({ ok: true }),
  selftest: () => ({ ok: true }),
  scan: () => ({
    findings: [
      { id: 'demo-1', severity: 'low', title: 'Demo finding', evidence: { file: 'app.js', line: 1 } }
    ]
  })
}

function reply(id, result, error) {
  const message = error === undefined ? { id, result } : { id, error }
  process.stdout.write(JSON.stringify(message) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    reply(null, undefined, 'invalid json')
    return
  }
  const handler = handlers[request && request.method]
  if (!handler) {
    reply(request.id, undefined, `unknown method: ${request && request.method}`)
    return
  }
  try {
    reply(request.id, handler(request.params || {}))
  } catch (error) {
    reply(request.id, undefined, error.message)
  }
})
