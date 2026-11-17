'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')
const { verifyArchive } = require('../scripts/verify-packaged-runtime-dependencies.cjs')

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-package-check-'))
  try {
    const source = path.join(temp, 'app')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const missing = path.join(temp, 'missing.asar')
    await asar.createPackage(source, missing)
    assert.throws(() => verifyArchive(missing), /missing runtime file: tools\/plugin\/install\.cjs/)
    const plugin = path.join(source, 'tools', 'plugin')
    fs.mkdirSync(plugin, { recursive: true })
    for (const name of ['install', 'manifest', 'trust']) fs.writeFileSync(path.join(plugin, name + '.cjs'), '')
    for (const name of ['manifest', 'trust']) {
      const file = path.join(plugin, name + '.cjs')
      fs.unlinkSync(file)
      const incomplete = path.join(temp, 'missing-' + name + '.asar')
      await asar.createPackage(source, incomplete)
      assert.throws(() => verifyArchive(incomplete), new RegExp('missing runtime file: tools/plugin/' + name + '[.]cjs'))
      fs.writeFileSync(file, '')
    }
    const complete = path.join(temp, 'complete.asar')
    await asar.createPackage(source, complete)
    assert.equal(verifyArchive(complete).version, '1.0.0')
    console.log('PASS: archive verification rejects missing local runtime and accepts complete package')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
