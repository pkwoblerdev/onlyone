// Read-only repository inventory and syntax/IPC checks. Not a proof of correctness.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
const source = files(path.join(root, 'src'))
const tests = files(path.join(root, 'tests'))
const code = [...source, ...tests, path.join(root, 'electron-builder.config.cjs')].filter(f => /\.(?:[cm]?js)$/.test(f))
const syntax = code.map(file => {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
  return { file: path.relative(root, file), ok: result.status === 0, ...(result.status !== 0 ? { error: result.stderr || result.error?.message } : {}) }
})
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8')
const handlers = new Set([...main.matchAll(/ipcMain\.handle\(['"]([^'"]+)/g)].map(m => m[1]))
const invokes = new Set([...preload.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)/g)].map(m => m[1]))
const missing = [...invokes].filter(name => !handlers.has(name))
const inventory = source.filter(f => !f.includes(path.sep + 'vendor' + path.sep) && /\.(?:js|cjs|css|html|md)$/.test(f)).map(file => {
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8')
  return { file: path.relative(root, file), lines: text.split('\n').length, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), nulBytes: bytes.filter(b => b === 0).length }
})
console.log(JSON.stringify({ syntaxFiles: code.length, syntaxFailures: syntax.filter(x => !x.ok), ipcInvokes: invokes.size, ipcHandlers: handlers.size, missingHandlers: missing, inventory }, null, 2))
process.exitCode = syntax.some(x => !x.ok) || missing.length ? 1 : 0
