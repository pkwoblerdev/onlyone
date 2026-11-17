'use strict'
const { randomUUID } = require('node:crypto')
const { configurationRecord } = require('./agent-run-context')

// Two parameters only: archived instructions, providers and credentials are never restored.
function register ({ ipcMain, trusted, readRecords, getSettings, getModels, writeParameters, isBusy, now = Date.now }) {
  let pending = null
  const fail = code => ({ ok: false, code })
  const baseline = () => {
    const s = getSettings()
    return JSON.stringify([s.defaultModel, s.thinkingEffort, s.activeProvider, s.activeCustomProvider, s.providerVersion])
  }
  function parameters (selection) {
    const records = readRecords()
    const record = Array.isArray(records) && records.map(configurationRecord).find(row => row?.runId === selection?.runId)
    const configuration = record?.configurations.find(item => item.id === selection?.configurationId)
    if (!configuration) return fail('missing')
    const model = getModels()?.find(item => item.id === configuration.model && !item.unavailable)
    if (!model) return fail('unavailable')
    const efforts = Array.isArray(model.supportedEfforts) ? model.supportedEfforts : []
    const selectable = efforts.filter(value => !['none', 'off', 'minimal'].includes(value))
    const allowed = selectable.length ? selectable : efforts
    const effort = configuration.reasoningEffort
    if (effort === 'none' && !efforts.length && !model.reasoningMandatory) {
      return { ok: true, parameters: { defaultModel: model.id, thinkingEffort: 'off' } }
    }
    if (!allowed.includes(effort)) return fail('effort')
    return { ok: true, parameters: { defaultModel: model.id, thinkingEffort: effort } }
  }
  ipcMain.handle('preview-run-parameters', (event, selection) => {
    if (!trusted(event)) return fail('forbidden')
    pending = null
    if (isBusy()) return fail('busy')
    try {
      const result = parameters(selection)
      if (!result.ok) return result
      const settings = getSettings()
      pending = { token: randomUUID(), sender: event.sender, selection: { runId: selection.runId, configurationId: selection.configurationId },
        baseline: baseline(), after: result.parameters, expires: now() + 300000 }
      return { ok: true, token: pending.token, before: { defaultModel: settings.defaultModel, thinkingEffort: settings.thinkingEffort }, after: pending.after }
    } catch { return fail('read_failed') }
  })
  ipcMain.handle('apply-run-parameters', (event, input) => {
    if (!trusted(event)) return fail('forbidden')
    const intent = pending
    if (!intent || input?.token !== intent.token || event.sender !== intent.sender) return fail('expired')
    pending = null
    if (now() > intent.expires) return fail('expired')
    if (isBusy()) return fail('busy')
    try {
      if (baseline() !== intent.baseline) return fail('changed')
      const result = parameters(intent.selection)
      if (!result.ok) return result
      if (JSON.stringify(result.parameters) !== JSON.stringify(intent.after)) return fail('changed')
      // One config transaction through the existing electron-store write policy.
      writeParameters(result.parameters)
      return { ok: true, parameters: result.parameters }
    } catch { return fail('write_failed') }
  })
}
module.exports = { register }
