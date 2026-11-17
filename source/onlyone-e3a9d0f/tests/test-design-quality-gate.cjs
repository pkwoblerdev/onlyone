// Промпт Design: ворота качества интерфейса и честный список инструментов.
//
// Две вещи. Первая — правила «сначала прочитай компонент, потом пиши; снимок
// экрана существует, описание без него — выдумка» раньше выдавались только
// моделям с подсказкой размера в имени (пункт 6.2). Модель без них верила
// последнему, что прочла, и не смотрела на собственный результат. Теперь они
// сказаны всем. Вторая — у Design не было требований к состояниям экранов,
// доступности и движению, и сайты выходили с одним «красивым» состоянием, без
// пустого, загрузки и ошибки.
const assert = require('node:assert/strict')
const { buildDesignPrompt } = require('../src/main/design/prompt')
const { designToolSchemas } = require('../src/main/design/tools')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const ALL = designToolSchemas().map(tool => tool.function.name)
const strong = buildDesignPrompt({ designName: 'Лендинг', toolNames: ALL })
// Отдельного текста «для слабой модели» больше нет: проверка на месте и у того,
// кому рельсы раньше не доставались, и у того, кому они шли всегда.
const weak = buildDesignPrompt({ designName: 'Лендинг', toolNames: ALL })

check('правила среды не отрицают снимок экрана', () => {
  assert.match(strong, /dc_screenshot/)
  assert.doesNotMatch(strong, /You have no screenshot tool|no screenshot/)
  assert.match(strong, /read it\s*\n?\s*with `dc_read` before replacing|dc_read` before replacing/i)
})

check('ворота качества есть и у сильной, и у слабой модели', () => {
  for (const prompt of [strong, weak]) assert.match(prompt, /## Interface quality gate/)
})

check('каждый экран — во всех состояниях', () => {
  assert.match(strong, /empty \(a helpful sentence and the action that fills it\), loading,/)
  assert.match(strong, /error \(what happened and what to do next/)
})

check('доступность измеримая: контраст, фокус, размер целей, имя у иконок', () => {
  assert.match(strong, /contrast at least\s+4\.5:1/)
  assert.match(strong, /visible focus state on every interactive/)
  assert.match(strong, /at least 44×44px/)
  assert.match(strong, /accessible name on every icon-only button/)
})

check('движение по делу и с путём для reduced motion', () => {
  assert.match(strong, /prefers-reduced-motion path/)
  assert.match(strong, /pulsing indicators everywhere/)
})

check('перед сдачей — разбор с приоритетами', () => {
  assert.match(strong, /P0 — broken, unreadable, inaccessible or missing a requested\s+screen or state/)
})

check('имя приложения новое', () => {
  assert.match(strong, /Additional onlyone tools/)
  assert.doesNotMatch(strong, /Additional 1code tools/)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
