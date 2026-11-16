const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), { spawn } = require('node:child_process')
const app = path.resolve(process.argv[2] || 'release/win-unpacked'), exe = path.join(app, 'onlyone.exe'), entry = path.join(app, 'resources/cli/onlyone.cjs')
const { acquireWindowLock, runDir, settleRun } = require('./app-launch.cjs')
acquireWindowLock()
const expectedVersion = require('../package.json').version
assert.ok(fs.existsSync(exe), 'Build release/win-unpacked first or pass its directory')
const dir = runDir('installed-cli-pack'), profile = path.join(dir, 'profile'), folder = path.join(dir, 'проект & spaces')
const sessionRoot = path.join(dir, 'sessions'), sealedProfile = path.join(dir, 'encrypted-profile')
fs.mkdirSync(sessionRoot); fs.mkdirSync(sealedProfile)
fs.mkdirSync(profile); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'notes.txt'), 'пальма')
let mode = 'read', issued = false; const hits = []
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', data => { raw += data }); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}; hits.push({ url: req.url, messages: body.messages })
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'cli-fixture' }] })) }
    if (req.headers.authorization !== 'Bearer sk-fixture-not-real') { res.writeHead(401); return res.end('{"error":{"message":"fixture key unavailable"}}') }
    if (mode === 'error') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'fixture refused' } })) }
    let frame
    if (!issued && (mode === 'write' || body.tools?.some(tool => tool.function?.name === 'read_file'))) {
      issued = true
      frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: mode === 'read' ? 'read_file' : 'write_file', arguments: JSON.stringify(mode === 'read' ? { path: 'notes.txt' } : { path: 'answer.txt', content: 'пальма из packaged CLI' }) } }] }, finish_reason: 'tool_calls' }] }
    } else frame = { choices: [{ delta: { content: 'Готово: пальма, CLI fixture.' }, finish_reason: 'stop' }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n')
  })
})
function run(args, throughCmd = false) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: process.env.SystemRoot + '\\System32', TEMP: sessionRoot, TMP: sessionRoot, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of Object.keys(env)) if (/^ONECODE_/.test(key)) delete env[key]
    const command = throughCmd ? process.env.ComSpec : exe
    const argv = throughCmd ? ['/d', '/s', '/c', '""' + path.join(app, 'resources/cli/onlyone.cmd') + '" ' + args.map(value => '"' + value.replace(/"/g, '\\"') + '"').join(' ') + '"'] : [entry, ...args]
    const child = spawn(command, argv, { env, windowsHide: true, windowsVerbatimArguments: throughCmd, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      const killer = spawn(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => { child.kill(); reject(Error('CLI timed out; process tree cleanup failed')) })
      killer.once('close', () => reject(Error('CLI timed out')))
    }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1'
  const settings = JSON.stringify({ activeProvider: 'openai-compatible', defaultModel: 'cli-fixture', legacyStoragePurged: true,
    customProvider: { baseUrl, model: 'cli-fixture', keyEncrypted: Buffer.from('sk-fixture-not-real').toString('base64'), keyEnc: 'plain', capabilities: { tools: true, streaming: true } },
    customModelCache: { provider: 'openai-compatible', updatedAt: Date.now(), models: [{ id: 'cli-fixture', name: 'CLI fixture', supportsTools: true, contextLength: 64000, supportedEfforts: ['low'] }] },
    workspace: { path: 'D:/do-not-change', permission: 'auto' } })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), settings)
  const help = await run(['--help'], true); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /onlyone run/); console.log('PASS packaged cmd help with no Node in PATH')
  const version = await run(['--version'], true); assert.equal(version.code, 0, version.stderr); assert.equal(version.stdout.trim(), 'onlyone ' + expectedVersion)
  const args = ['run', 'Прочитай notes.txt и ответь словом из файла.', '--folder', folder, '--profile', profile]
  const read = await run(args, true); assert.equal(read.code, 0, read.stderr); assert.match(read.stdout, /пальма/); assert.equal(issued, true, 'real read_file call'); console.log('PASS packaged real read through local API')
  assert.ok(hits.some(hit => hit.messages?.some(item => item.role === 'tool' && String(item.content).includes('пальма'))), 'model receives file contents')
  const seed = path.join(dir, 'encrypt-fixture.cjs')
  fs.writeFileSync(seed, `const {app,safeStorage}=require('electron');const fs=require('fs');
app.whenReady().then(()=>{const settings=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(profile,'1code-settings.json'))},'utf8'));
if(!safeStorage.isEncryptionAvailable())throw Error('Windows encryption unavailable');
settings.customProvider.keyEncrypted=safeStorage.encryptString('sk-fixture-not-real').toString('base64');settings.customProvider.keyEnc='safeStorage';
fs.writeFileSync(${JSON.stringify(path.join(sealedProfile,'1code-settings.json'))},JSON.stringify(settings));app.quit();}).catch(()=>app.exit(1));`)
  await new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [seed, '--user-data-dir=' + sealedProfile], { env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(Error('Windows encryption fixture timed out')) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Windows encryption fixture failed')) })
  })
  assert.ok(fs.existsSync(path.join(sealedProfile, 'Local State')), 'encryption key must be persisted before copying profile')
  const encryptedSettings = fs.readFileSync(path.join(sealedProfile, '1code-settings.json'))
  issued = false
  const encryptedArgs = [...args]; encryptedArgs[encryptedArgs.length - 1] = sealedProfile
  const decrypted = await run(encryptedArgs)
  assert.equal(decrypted.code, 0, decrypted.stderr); assert.equal(issued, true)
  assert.deepEqual(fs.readFileSync(path.join(sealedProfile, '1code-settings.json')), encryptedSettings, 'encrypted source profile stays unchanged')
  console.log('PASS packaged Windows safeStorage profile copy/decryption with fixture authorization')
  mode = 'write'; issued = false
  const denied = await run(['run', 'Запиши answer.txt со словом пальма.', '--folder', folder, '--profile', profile]); assert.equal(issued, true, 'fixture must attempt the write'); assert.equal(denied.code, 3, denied.stderr); assert.equal(fs.existsSync(path.join(folder,'answer.txt')), false); console.log('PASS packaged read-only refusal')
  issued = false
  const written = await run(['run', 'Запиши answer.txt со словом пальма.', '--folder', folder, '--profile', profile, '--allow-write']); assert.equal(written.code, 0, written.stderr); assert.equal(fs.readFileSync(path.join(folder,'answer.txt'),'utf8'),'пальма из packaged CLI'); console.log('PASS packaged explicit write')
  mode = 'error'
  const failed = await run(args); assert.equal(failed.code, 1, failed.stderr); console.log('PASS packaged provider failure')
  assert.equal(fs.readFileSync(path.join(profile,'1code-settings.json'),'utf8'),settings,'source profile unchanged')
  fs.writeFileSync(path.join(dir,'packaged-result.json'), JSON.stringify({ok:true, app, version:expectedVersion, requests:hits.length, noExternalNode:true, sourceProfileUnchanged:true},null,2))
  console.log('PASS installed CLI package: embedded runtime, wrapper arguments, tools, permissions, provider error, profile preserved')
  settleRun(dir, true)
})().catch(error => { console.error(error); process.exitCode=1; settleRun(dir, false) }).finally(() => { server.closeAllConnections(); server.close() })
