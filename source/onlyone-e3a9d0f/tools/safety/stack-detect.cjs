'use strict'

// Deterministic stack profile. Manifests confirm a stack; extensions only observe it.
const fs = require('node:fs')
const path = require('node:path')

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'out', '.cache', 'target', 'vendor', 'fixtures', 'audits'])
const EXT = {
  '.js': 'node', '.cjs': 'node', '.mjs': 'node', '.ts': 'node', '.tsx': 'node',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.php': 'php', '.cs': 'dotnet'
}
const MANIFEST = {
  'package.json': 'node', 'pnpm-lock.yaml': 'node', 'package-lock.json': 'node', 'yarn.lock': 'node',
  'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.py': 'python',
  'go.mod': 'go', 'Cargo.toml': 'rust', 'composer.json': 'php'
}

function detect (root, limit = 4000) {
  const manifests = new Map()
  const extensions = new Map()
  let seen = 0
  const walk = dir => {
    if (seen >= limit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (seen >= limit) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue }
      seen++
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (MANIFEST[e.name]) {
        if (!manifests.has(MANIFEST[e.name])) manifests.set(MANIFEST[e.name], [])
        manifests.get(MANIFEST[e.name]).push(rel)
      }
      if (/\.csproj$/i.test(e.name)) {
        if (!manifests.has('dotnet')) manifests.set('dotnet', [])
        manifests.get('dotnet').push(rel)
      }
      const stack = EXT[path.extname(e.name).toLowerCase()]
      if (stack) extensions.set(stack, (extensions.get(stack) || 0) + 1)
    }
  }
  walk(root)
  const stacks = []
  for (const [name, files] of manifests) stacks.push({ name, confidence: 'confirmed', evidence: files.slice(0, 5) })
  for (const [name, count] of extensions) {
    if (manifests.has(name)) continue
    stacks.push({ name, confidence: 'observed', evidence: [`${count} files with this extension`] })
  }
  stacks.sort((a, b) => a.name.localeCompare(b.name))
  return { root, filesSeen: seen, stacks, unknown: stacks.length === 0 }
}

if (require.main === module) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node tools/safety/stack-detect.cjs <dir>'); process.exit(2) }
  console.log(JSON.stringify(detect(require('node:path').resolve(dir)), null, 2))
}

module.exports = { detect }
