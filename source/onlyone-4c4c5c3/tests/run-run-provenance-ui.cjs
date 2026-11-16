'use strict'
// Real main/preload, local scripted provider, real safeStorage and a profile restart.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..'), dir = runDir('onlyone-run-provenance')
const profile = path.join(dir, 'profile'), pack = path.join(dir, 'skill'), workspace = path.join(dir, 'workspace')
for (const folder of [profile, pack, workspace]) fs.mkdirSync(folder, { recursive: true })
const model = { id: 'fixture/model', name: 'Fixture model', isFree: true, supportsTools: true, supportedEfforts: ['low', 'high'], contextLength: 100000, inputModalities: ['text'] }
const instruction = 'PRIVATE exact skill instruction', content = 'PRIVATE exact reference content'
fs.writeFileSync(path.join(pack, 'reference.md'), content)
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Fixture', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: model.id, enabled: true }],
  defaultModel: model.id, thinkingEffort: 'high', legacyStoragePurged: true,
  openrouterModelCache: { updatedAt: Date.now(), models: [model, { ...model, id: 'fixture/other', name: 'Other model' }] },
  workspace: { path: workspace, permission: 'acceptEdits' },
  skills: [{ id: 'fixture-skill', name: 'Fixture skill', enabled: true, systemPrompt: instruction,
    pack: { dir: pack, entry: 'SKILL.md', files: ['reference.md'] } }]
}))
const provider = path.join(dir, 'provider.json')
fs.writeFileSync(provider, JSON.stringify({ turns: [
  { toolCalls: [{ name: 'use_skill', args: { id: 'fixture-skill' } }, { name: 'skill_file', args: { id: 'fixture-skill', path: 'reference.md' } }],
    frames: [
      { model: 'fixture/served', choices: [{ delta: { tool_calls: [
        { index: 0, id: 'skill', function: { name: 'use_skill', arguments: JSON.stringify({ id: 'fixture-skill' }) } },
        { index: 1, id: 'file', function: { name: 'skill_file', arguments: JSON.stringify({ id: 'fixture-skill', path: 'reference.md' }) } }
      ] }, finish_reason: 'tool_calls' }] }
    ] },
  { text: 'PROVENANCE_DONE' }, { content: 'ВЕРДИКТ: ГОТОВО' }
] }))
function launch(stage, body) {
  const script = path.join(dir, stage + '.js'), output = path.join(dir, stage + '.json')
  fs.writeFileSync(script, `(async () => {
    const ensure = (value, message) => { if (!value) throw Error(message) }
    const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw Error('UI readiness timeout') }
    await waitFor(() => document.documentElement.dataset.appReady === '1')
    ${body}
    return { ok: true }
  })()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 120000, windowsHide: true,
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: output, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: provider })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || 'No app verdict' }
  if (!result.ok || child.status !== 0) console.error(child.stderr?.toString().slice(-1500))
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(child.status, 0)
  console.log('PASS real application:', stage)
}
try {
  launch('capture-and-restore', `
    const api = window.electronAPI
    const result = await api.sendMessage({ requestId: 'provenance', chatId: 'fixture-chat', model: 'fixture/model', reasoningEffort: 'high',
      params: { useTools: true }, messages: [{ role: 'user', content: 'Прочитай fixture-skill и reference.md. Затем ответь PROVENANCE_DONE.' }] })
    ensure(result.ok, 'agent run failed: ' + JSON.stringify(result))
    const history = await api.getRunConfigurations()
    const record = history.records.find(item => item.skillReads.length === 2)
    ensure(record, 'real tool reads missing: ' + JSON.stringify(history))
    ensure(record.skillReads.some(item => item.source === 'instruction'), 'instruction missing')
    ensure(record.skillReads.some(item => item.source === 'file'), 'file missing')
    ensure(record.modelCalls.some(item => item.answeredModel === 'fixture/served'), 'served model not captured')
    ensure(record.modelCalls.some(item => item.kind === 'judge'), 'judge request not captured')
    ensure(!JSON.stringify(record).includes('PRIVATE'), 'raw content in archive')
    const configuration = record.configurations.find(item => item.model === 'fixture/model' && item.reasoningEffort === 'high')
    ensure(configuration, 'saved parameters missing')
    await api.setSettings({ defaultModel: 'fixture/other', thinkingEffort: 'low' })
    const selection = { runId: record.runId, configurationId: configuration.id }
    let preview = await api.previewRunParameters(selection)
    ensure(preview.ok && preview.before.defaultModel === 'fixture/other', 'preview failed')
    await api.setSettings({ defaultModel: 'fixture/model' })
    ensure((await api.applyRunParameters(preview.token)).code === 'changed', 'stale settings overwritten')
    preview = await api.previewRunParameters(selection)
    ensure((await api.applyRunParameters(preview.token)).ok, 'apply failed')
    ensure((await api.applyRunParameters(preview.token)).code === 'expired', 'token replay accepted')
    const settings = await api.getSettings()
    ensure(settings.defaultModel === 'fixture/model' && settings.thinkingEffort === 'high', 'parameters not persisted')
  `)
  const bulkFile = path.join(profile, 'data', 'runConfigurations.json')
  assert.equal(fs.existsSync(bulkFile), true, 'archive file exists')
  const encrypted = fs.readFileSync(bulkFile, 'utf8')
  assert.equal(JSON.parse(encrypted).enc, 'safeStorage')
  assert.equal(encrypted.includes('PRIVATE'), false)
  launch('restart', `
    const history = await window.electronAPI.getRunConfigurations()
    ensure(history.records.some(item => item.skillReads.length === 2 && item.modelCalls.some(call => call.answeredModel === 'fixture/served')), 'observations lost after restart')
    const settings = await window.electronAPI.getSettings()
    ensure(settings.defaultModel === 'fixture/model' && settings.thinkingEffort === 'high', 'restored settings lost after restart')
  `)
  settleRun(dir, true)
} catch (error) { console.error(error); settleRun(dir, false); process.exitCode = 1 }
