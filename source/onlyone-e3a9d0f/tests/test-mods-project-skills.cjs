'use strict'
// M-4: моды берут навыки из того же источника, что и ход, — allSkills (глобальные
// плюс проектные из .onlyone/skills активной папки). Проверяется договор mods-ipc:
// проектный id проходит sample/preview/action; выключенный навык и путь под видом
// id отказывают тем же кодом skill-unavailable; инструкция остаётся в главном
// процессе. Без проектного навыка тот же пример и действие отказывают — контроль.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createMods, samplePackage } = require('../src/main/mods.cjs')
const { register } = require('../src/main/mods-ipc.cjs')

const main = { mainFrame: {} }
const event = wc => ({ sender: wc, senderFrame: wc.mainFrame })
const PROJECT = 'proj_0123456789abcdef_checks'
const OFF = 'proj_0123456789abcdef_off'
const globalSkill = { id: 'diagnostics', name: 'Diagnostics', enabled: true, systemPrompt: 'GLOBAL instruction' }
const projectSkill = { id: PROJECT, name: 'Project checks', enabled: true, systemPrompt: 'PROJECT instruction', category: 'project' }
const offSkill = { id: OFF, name: 'Off checks', enabled: false, systemPrompt: 'OFF instruction', category: 'project', error: 'В шапке нет поля description' }

// mods-ipc получает тот же список, что и ход: enabled-флаг и systemPrompt — как у allSkills.
function bridge (skills) {
  const service = createMods({ storage: { load: () => null, save: () => {} } })
  const handlers = {}
  const api = register({ ipcMain: { handle: (id, fn) => { handlers[id] = fn } }, getService: () => service,
    isMain: e => e.sender === main && e.senderFrame === main.mainFrame, deskChat: () => null,
    skills: () => skills, openDesk: async () => ({ ok: true }), deliverDraft: () => true })
  return { service, handlers, api }
}
async function install (handlers, pack) {
  const preview = await handlers['mods:preview'](event(main), { package: pack })
  assert.equal(preview.ok, true, 'preview: ' + preview.code)
  assert.equal((await handlers['mods:commit'](event(main), { token: preview.token })).ok, true)
}
async function suggest (handlers, chatId, modId) {
  const rows = await handlers['mods:panels'](event(main), { chatId, surface: 'main' })
  const panel = rows.panels.find(item => item.modId === modId)
  assert.ok(panel && panel.status && panel.status.skillId, 'у мода нет предложения: ' + modId)
  return handlers['mods:action'](event(main), { chatId, modId, panelId: panel.id, suggestion: true,
    statusHash: panel.statusHash, revision: rows.revision })
}

;(async () => {
  const withProject = bridge([globalSkill, projectSkill, offSkill])

  // Прежний договор цел: глобальный навык по-прежнему принимается.
  assert.equal((await withProject.handlers['mods:sample'](event(main), { skillId: 'diagnostics' })).ok, true)

  // Проектный навык активной папки проходит пример и строит черновик с его id.
  const sample = await withProject.handlers['mods:sample'](event(main), { skillId: PROJECT })
  assert.equal(sample.ok, true, 'проектный навык не принят примером')
  assert.equal(sample.package.panels[0].buttons.find(button => button.id === 'test').action.skillId, PROJECT)
  await install(withProject.handlers, sample.package)
  withProject.service.event('chat-p', 'check.failed')
  const draft = await suggest(withProject.handlers, 'chat-p', 'onlyone.project-checks')
  assert.equal(draft.ok, true, 'action: ' + draft.code)
  assert.equal(draft.type, 'draft')
  assert.equal(draft.skillId, PROJECT)
  assert.equal(draft.skillName, 'Project checks')
  assert.equal(JSON.stringify(draft).includes('PROJECT instruction'), false, 'инструкция не уходит в окно с действием')
  const resolved = withProject.api.resolveSkill('chat-p', { chatId: 'chat-p', modId: 'onlyone.project-checks',
    panelId: 'checks', suggestion: true, statusHash: draft.context.statusHash, revision: draft.context.revision })
  assert.equal(resolved.ok, true, 'resolveSkill: ' + resolved.code)
  assert.equal(resolved.skill.systemPrompt, 'PROJECT instruction')

  // Список для окна показывает проектный id, имя и enabled, но не инструкцию.
  const listed = await withProject.handlers['mods:list'](event(main))
  assert.ok(listed.skills.some(item => item.id === PROJECT && item.name === 'Project checks' && item.enabled === true))
  assert.equal(JSON.stringify(listed.skills).includes('instruction'), false)

  // Отрицательный контроль: только глобальные навыки — тот же пример и действие отказывают.
  const globalOnly = bridge([globalSkill])
  assert.equal((await globalOnly.handlers['mods:sample'](event(main), { skillId: PROJECT })).code, 'invalid-package')
  await install(globalOnly.handlers, { ...samplePackage(PROJECT), id: 'onlyone.global-only', name: 'Global only' })
  globalOnly.service.event('chat-g', 'check.failed')
  assert.equal((await suggest(globalOnly.handlers, 'chat-g', 'onlyone.global-only')).code, 'skill-unavailable')

  // Выключенный проектный навык не проходит ни пример, ни действие.
  assert.equal((await withProject.handlers['mods:sample'](event(main), { skillId: OFF })).code, 'invalid-package')
  await install(withProject.handlers, { ...samplePackage(OFF), id: 'onlyone.off-skill', name: 'Off skill' })
  withProject.service.event('chat-off', 'check.failed')
  assert.equal((await suggest(withProject.handlers, 'chat-off', 'onlyone.off-skill')).code, 'skill-unavailable')

  // Пакет не может назвать путь: id — непрозрачная строка, ищется только точным
  // совпадением по каталогу навыков; файл по такому «id» никто не открывает.
  const evil = ['C:\\Windows\\System32\\cmd.exe', '../../.onlyone/skills/checks/SKILL.md']
  for (const [index, id] of evil.entries()) {
    const pack = { ...samplePackage(id), id: 'onlyone.path-' + index, name: 'Path ' + index }
    assert.equal(pack.rules.find(rule => rule.skillId).skillId, id)
    await install(withProject.handlers, pack)
  }
  withProject.service.event('chat-path', 'check.failed')
  const pathRows = await withProject.handlers['mods:panels'](event(main), { chatId: 'chat-path', surface: 'main' })
  for (const index of [0, 1]) {
    const modId = 'onlyone.path-' + index, panel = pathRows.panels.find(item => item.modId === modId)
    assert.ok(panel && panel.status, 'панель пути не наблюдает событие: ' + modId)
    const refused = await withProject.handlers['mods:action'](event(main), { chatId: 'chat-path', modId,
      panelId: panel.id, suggestion: true, statusHash: panel.statusHash, revision: pathRows.revision })
    assert.equal(refused.code, 'skill-unavailable', modId + ' назвал путь вместо навыка')
  }

  // Проводка в главном процессе: mods-ipc получает allSkills, а не одни глобальные.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  const at = source.indexOf("require('./mods-ipc.cjs').register(")
  assert.ok(at > 0, 'регистрация mods-ipc пропала из main.js')
  const wiring = source.slice(at, at + 600)
  assert.match(wiring, /skills:\s*\(\)\s*=>\s*allSkills\(\)/,
    'mods-ipc получает только loadSkills: проектные навыки хода недоступны модам')

  console.log('PASS Mods project skills: project skill accepted by sample/action, disabled and path-like ids refused, instruction stays in main, wiring uses allSkills')
})().catch(error => { console.error(error); process.exitCode = 1 })
