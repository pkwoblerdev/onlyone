'use strict'

// Tool presence is measured, never assumed: `where`/`command -v` finds the binary,
// `<tool> --version` proves it runs. A missing tool is `available: false`, which
// route and mutate turn into not_run — never into a silent green.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const NAME = /^[\w.+-]+$/
const cache = new Map()

function projectRoot () {
  return path.resolve(__dirname, '..', '..')
}

function localBins (name, root) {
  const bin = path.join(root, 'node_modules', '.bin')
  const candidates = process.platform === 'win32' ? [name + '.cmd', name + '.exe', name] : [name]
  return candidates.map(file => path.join(bin, file)).filter(file => fs.existsSync(file))
}

// `pip install --user` puts console scripts outside PATH on Windows. Looking in the
// user-level script directories is still a measured lookup: the file must exist.
function userBinDirs () {
  const dirs = []
  if (process.env.PYTHONUSERBASE) dirs.push(path.join(process.env.PYTHONUSERBASE, 'Scripts'), path.join(process.env.PYTHONUSERBASE, 'bin'))
  if (process.platform === 'win32') {
    const root = process.env.APPDATA && path.join(process.env.APPDATA, 'Python')
    let versions = []
    try { versions = fs.readdirSync(root) } catch {}
    for (const version of versions) dirs.push(path.join(root, version, 'Scripts'))
  } else {
    dirs.push(path.join(require('node:os').homedir(), '.local', 'bin'))
  }
  return dirs
}

function userBins (name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const found = []
  for (const dir of userBinDirs()) {
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix)
      if (fs.existsSync(file)) found.push(file)
    }
  }
  return found
}

function which (name) {
  const run = process.platform === 'win32'
    ? spawnSync('where', [name], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    : spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8', timeout: 10000 })
  if (!run || run.status !== 0) return null
  const lines = String(run.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  // `where` on Windows also lists extensionless Git-Bash shims that cannot be spawned.
  const preferred = process.platform === 'win32'
    ? lines.find(line => /\.(?:exe|cmd|bat)$/i.test(line))
    : lines[0]
  return preferred || lines[0] || null
}

function versionOf (name, command) {
  const isShim = /\.(?:cmd|bat)$/i.test(command)
  // A tool's own directory goes first on PATH: .cmd shims need cmd to resolve them,
  // and launchers such as semgrep.exe call a sibling binary (pysemgrep) by name.
  const env = { ...process.env, PATH: path.dirname(command) + path.delimiter + (process.env.PATH || '') }
  const run = isShim
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `${name} --version`], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env
    })
    : spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false, env })
  if (!run || run.error) return null
  if (run.status !== 0) return null
  const text = [run.stdout, run.stderr].filter(part => typeof part === 'string').join('\n')
  const lines = text.split(/\r?\n/).map(part => part.trim()).filter(Boolean)
  const line = lines.find(part => /\d+\.\d+/.test(part)) || lines[0]
  return line ? line.slice(0, 120) : null
}

function probe ({ name, root = projectRoot(), version = true } = {}) {
  if (!name || !NAME.test(name)) throw new Error('tool name must be a plain binary name, got: ' + JSON.stringify(name))
  const key = [name, root, version ? 'v' : 'n'].join('|')
  if (cache.has(key)) return { ...cache.get(key) }
  const command = localBins(name, root)[0] || which(name) || userBins(name)[0] || null
  const result = command
    ? { name, available: true, version: version ? versionOf(name, command) : null, command }
    : { name, available: false, version: null, command: null }
  cache.set(key, result)
  return { ...result }
}

function probeMany (names, options = {}) {
  const out = {}
  for (const name of names) out[name] = probe({ ...options, name })
  return out
}

// Some Python entry points answer --version with a refusal (mutmut on Windows), so the
// installed distribution version is read from pip metadata instead of guessed.
function pipVersions (names) {
  const python = probe({ name: 'python', version: false })
  if (!python.available) return {}
  const run = spawnSync(python.command, ['-m', 'pip', 'show', ...names], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (!run || run.status !== 0) return {}
  const out = {}
  let current = null
  for (const line of String(run.stdout || '').split(/\r?\n/)) {
    const name = /^Name:\s*(.+)$/.exec(line)
    if (name) { current = name[1].trim(); continue }
    const version = /^Version:\s*(.+)$/.exec(line)
    if (version && current) { out[current] = version[1].trim(); current = null }
  }
  return out
}

module.exports = { probe, probeMany, pipVersions, projectRoot }

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd !== 'probe' || !rest.length) { console.error('usage: node tools/safety/tools.cjs probe <name>...'); process.exit(2) }
  console.log(JSON.stringify(rest.length === 1 ? probe({ name: rest[0] }) : probeMany(rest), null, 2))
}
