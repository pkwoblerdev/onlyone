// A model was declared unable to call tools on a single empty answer, and the
// verdict then followed it around: the composer showed «без инструментов», agent
// mode dropped to plain chat, and the chosen model was replaced everywhere.
//
// GLM 5.3 Flash was measured against a request the exact shape the app sends —
// twenty tool schemas, the full system prompt, reasoning off / high / enabled —
// and it answered and called list_files every time, four runs out of four. So
// the verdict that produced that badge was wrong about the model, and an empty
// stream is as often the provider having a bad minute.
//
// The evidence that actually points at tools already exists: the retry without
// them. Text without tools after silence with them convicts. Silence both ways
// convicts nobody.
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- the verdict needs evidence ---------------------------------------------

const emptyBranch = main.slice(
  main.indexOf('if (cameBackEmpty && toolsEnabled && !toolFallbackUsed) {'),
  main.indexOf('if (toolsEnabled && stepResult.toolCalls.length) markToolsWorking(model)')
)

check('пустой ответ сам по себе не выносит приговор',
  !emptyBranch.includes('markToolsBroken'), 'приговор всё ещё выносится сразу')
check('пустой ответ только запоминается',
  /emptyWithTools = true/.test(emptyBranch))
check('инструменты при этом снимаются на ход',
  /toolsEnabled = false/.test(emptyBranch))

check('приговор выносится после удачной попытки без инструментов',
  /if \(emptyWithTools && !toolsEnabled && !cameBackEmpty\) \{[\s\S]{0,120}markToolsBroken/.test(main))
check('флаг сбрасывается, чтобы не судить дважды',
  /emptyWithTools = false[\s\S]{0,60}markToolsBroken/.test(main))
check('флаг заводится на каждый прогон', /let emptyWithTools = false/.test(main))

// Two silences in a row are the provider, and must leave the model alone.
const verdictAt = main.indexOf('if (emptyWithTools && !toolsEnabled && !cameBackEmpty)')
check('молчание в обе стороны никого не осуждает',
  verdictAt > 0 && main.slice(verdictAt, verdictAt + 200).includes('!cameBackEmpty'),
  'условие не проверяет второй ответ')

// --- there is a way back ----------------------------------------------------

check('есть обработчик снятия пометки',
  /ipcMain\.handle\('clear-tool-capability'/.test(main))
check('снятие проверяет, что пометка вообще была',
  /if \(!\(id in map\)\) return \{ cleared: false \}/.test(main))
check('пометка удаляется из хранилища',
  /delete map\[id\][\s\S]{0,60}store\.set\('toolCapability', map\)/.test(main))

check('мост в рендерер проброшен',
  /clearToolCapability: modelId => ipcRenderer\.invoke\('clear-tool-capability', modelId\)/.test(preload))

check('выбор модели руками снимает пометку',
  /toolCapability\[model\.id\]\?\.works === false[\s\S]{0,200}clearToolCapability/.test(app))
check('после снятия состояние перечитывается',
  /clearToolCapability[\s\S]{0,160}refreshToolCapability\(\)/.test(app))
check('сбой снятия не роняет выбор модели',
  /clearToolCapability[\s\S]{0,200}catch\(\(\) => \{\}\)/.test(app))

// --- the verdict still expires ----------------------------------------------

check('приговор действует сутки, а не вечно',
  /TOOLS_BROKEN_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(main))
check('просроченная пометка снимается при чтении',
  /Date\.now\(\) - Number\(entry\.checkedAt \|\| 0\) > TOOLS_BROKEN_TTL_MS[\s\S]{0,120}delete map\[modelId\]/.test(main))

// --- and it is never passed on evidence the app itself contradicts -----------
// Run for real: the three functions, a fake store, the sequence that happened.

const store = new Map()
const fakeStore = {
  get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  set: (key, value) => store.set(key, value)
}

const verdictSrc = main.slice(
  main.indexOf('function toolsEverWorked(modelId) {'),
  main.indexOf('function findModelRecord(modelId) {')
)

// eslint-disable-next-line no-new-func
const verdict = new Function('store', 'LEAD_MODEL', 'TOOLS_BROKEN_TTL_MS',
  verdictSrc +
  '\nreturn { toolsKnownBroken, markToolsBroken, markToolsWorking, toolsEverWorked, clearToolsBroken }'
)(fakeStore, 'z-ai/glm-5.3-flash', 24 * 60 * 60 * 1000)

// The lead is the model agent mode is built on. Condemning it switches off
// files, MCP and the project tools in one go.
store.clear()
verdict.markToolsBroken('z-ai/glm-5.3-flash')
check('ведущую модель не осуждают',
  verdict.toolsKnownBroken('z-ai/glm-5.3-flash') === false,
  JSON.stringify(store.get('toolCapability')))

// A verdict already written to disk has to stop mattering as soon as the app is
// updated — otherwise the day it was condemned for still has to run out.
store.clear()
store.set('toolCapability', { 'z-ai/glm-5.3-flash': { works: false, checkedAt: Date.now() } })
check('уже записанный приговор ведущей снимается при чтении',
  verdict.toolsKnownBroken('z-ai/glm-5.3-flash') === false)
check('и стирается из хранилища, а не игнорируется молча',
  !store.get('toolCapability')['z-ai/glm-5.3-flash'])

// A model seen calling tools has answered this question already.
store.clear()
verdict.markToolsWorking('minimax/minimax-m3:free')
verdict.markToolsBroken('minimax/minimax-m3:free')
check('модель, которая уже вызывала инструменты, не осуждают',
  verdict.toolsKnownBroken('minimax/minimax-m3:free') === false,
  JSON.stringify(store.get('toolCapability')))
check('и запись о том, что она это умеет, сохраняется',
  verdict.toolsEverWorked('minimax/minimax-m3:free') === true)

// A model that has never shown anything is still condemned — that is the whole
// point of the mechanism, and dropping it would put tools on models that hang.
store.clear()
verdict.markToolsBroken('какая-то/модель')
check('незнакомую модель по-прежнему можно осудить',
  verdict.toolsKnownBroken('какая-то/модель') === true)

// And the day still runs out for it.
store.clear()
store.set('toolCapability', {
  'какая-то/модель': { works: false, checkedAt: Date.now() - 25 * 60 * 60 * 1000 }
})
check('через сутки приговор снимается',
  verdict.toolsKnownBroken('какая-то/модель') === false)

// --- the flattened tool call must not be handed over as the answer ----------
// What the user saw: «cmdcd /d D:\\… && dir /blist_filespath…» — three tool
// calls with their arguments, glued together, delivered as the answer. The
// nudge that catches this only ran while tools were on, which is precisely when
// it could not happen.

const restore = main.slice(
  main.indexOf('// Tools were switched off by a verdict'),
  main.indexOf('if (toolsEnabled && fakeCallNudges < 2 && looksLikeFakeToolCall')
)
check('без инструментов выдуманный вызов ловится',
  /!toolsEnabled && allTools\.length && looksLikeFakeToolCall/.test(restore), restore.slice(0, 200))
check('и инструменты возвращаются, а не отдаётся мусор',
  /toolsEnabled = true/.test(restore) && /clearToolsBroken\(model\)/.test(restore))
check('шаг повторяется с инструментами',
  /step--/.test(restore) && /continue/.test(restore))
check('возврат происходит один раз за ход',
  /!toolsRestored/.test(restore) && /toolsRestored = true/.test(restore))
check('человеку говорят, что произошло',
  /тянется к инструментам/.test(restore))
check('системная подсказка возвращается к обычной',
  /messages\[0\] = \{ role: 'system', content: systemPrompt \}/.test(restore))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
