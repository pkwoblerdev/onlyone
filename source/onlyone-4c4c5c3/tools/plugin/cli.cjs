'use strict'
// Command line for plugin installs, the trust store, signing and one sandboxed
// host run. Prints JSON; install never enables a plugin. Signing reads the owner
// key only from the --key file it is given and never creates or prints one.
const fs = require('node:fs')
const manifest = require('./manifest.cjs')
const install = require('./install.cjs')
const sign = require('./sign.cjs')
const trust = require('./trust.cjs')
const { startHost } = require('./host.cjs')

function parseArgs(argv) {
  const args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { args._.push(token); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args.flags[token.slice(2)] = true
    } else {
      args.flags[token.slice(2)] = next
      i++
    }
  }
  return args
}

function need(value, name) {
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function flagOn(value) {
  return value === true || value === 'true'
}

async function hostCommand(pluginDir, options) {
  const host = startHost({
    pluginDir,
    timeoutMs: options.timeoutMs,
    sandbox: options.sandbox,
    maxMemoryBytes: options.maxMemoryBytes,
    maxProcesses: options.maxProcesses
  })
  try {
    const ping = await host.ping()
    let selftest = null
    try {
      selftest = await host.selftest()
    } catch (error) {
      selftest = { error: error.message }
    }
    return {
      ok: true,
      id: host.manifest.id,
      sandboxed: host.sandboxed,
      sandboxReason: host.sandboxReason,
      ping,
      selftest
    }
  } finally {
    host.killSwitch()
    await host.exited
  }
}

function run(argv) {
  const { _, flags } = parseArgs(argv)
  const command = _[0]
  const profileDir = flags.profile
  switch (command) {
    case 'verify': {
      const dir = need(_[1], 'plugin dir')
      const data = manifest.loadManifest(dir)
      return { ok: true, id: data.id, version: data.version, hash: manifest.treeHash(dir) }
    }
    case 'install':
      return install.installPlugin(need(_[1], 'plugin dir'), { profileDir: need(profileDir, '--profile') })
    case 'list':
      return install.listPlugins(need(profileDir, '--profile'))
    case 'disable':
      return install.disablePlugin(need(profileDir, '--profile'), need(_[1], 'plugin id'))
    case 'approve':
      return install.approvePlugin(need(profileDir, '--profile'), need(_[1], 'plugin id'))
    case 'rollback':
      return install.rollbackPlugin(need(profileDir, '--profile'), need(_[1], 'plugin id'), need(_[2], 'version'))
    case 'remove':
      return install.removePlugin(need(profileDir, '--profile'), need(_[1], 'plugin id'))
    case 'trust': {
      const sub = _[1]
      const profile = need(profileDir, '--profile')
      if (sub === 'add') {
        const pem = fs.readFileSync(need(_[2], 'pem file'), 'utf8')
        const added = trust.addKey(profile, pem)
        return { ok: true, ...added, short: trust.shortFingerprint(added.fingerprint) }
      }
      if (sub === 'list') {
        return trust.loadKeys(profile).map((entry) => ({ ...entry, short: trust.shortFingerprint(entry.fingerprint) }))
      }
      if (sub === 'remove') {
        return trust.removeKey(profile, trust.resolveFingerprint(profile, need(_[2], 'fingerprint')))
      }
      throw new Error('unknown trust command: ' + (sub || '(none)'))
    }
    case 'sign':
      return sign.signPlugin(need(_[1], 'plugin dir'), flags.key)
    case 'host':
      return hostCommand(need(_[1], 'plugin dir'), {
        sandbox: flagOn(flags.sandbox),
        timeoutMs: flags.timeout ? Number(flags.timeout) : 10000,
        maxMemoryBytes: flags.memory ? Number(flags.memory) : 0,
        maxProcesses: flags.processes ? Number(flags.processes) : 0
      })
    default:
      throw new Error(`unknown command: ${command || '(none)'}`)
  }
}

if (require.main === module) {
  Promise.resolve()
    .then(() => run(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result))
    })
    .catch((error) => {
      console.log(JSON.stringify({ ok: false, error: error.message }))
      process.exitCode = 1
    })
}

module.exports = { run, parseArgs }
