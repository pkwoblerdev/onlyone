// Список провайдеров по группам: агрегаторы и хостинги отдельно от разработчиков моделей и от своего адреса.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fill, ORDER } = require('../src/renderer/provider-groups.js')
const providers = require('../src/main/providers')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

// Мини-DOM: хватает createElement, appendChild и textContent.
const doc = {
  createElement: tag => ({ tag, children: [], appendChild (child) { this.children.push(child) }, set textContent (value) { if (value === '') this.children = [] ; else this._text = value }, get textContent () { return this._text || '' } })
}
const t = text => text

test('группы идут в порядке: агрегаторы, разработчики, локально, свой адрес; OpenRouter — первый среди агрегаторов', () => {
  const select = doc.createElement('select')
  fill(select, providers.knownProviders(), t, doc)
  assert.deepEqual(select.children.map(group => group.label), ['Агрегаторы и хостинги', 'Разработчики моделей', 'На этом компьютере', 'Свой адрес'])
  const gateways = select.children[0].children.map(option => option.value)
  assert.equal(gateways[0], 'openrouter')
  for (const id of ['together', 'groq', 'huggingface', 'vercel-ai-gateway', 'requesty', 'opencode-zen']) assert.ok(gateways.includes(id), id)
  assert.deepEqual(select.children[1].children.map(option => option.value), ['openai', 'anthropic', 'gemini'])
  assert.deepEqual(select.children[2].children.map(option => option.value), ['ollama', 'lmstudio'])
  assert.deepEqual(select.children[3].children.map(option => option.value), ['openai-compatible'])
})

test('путь без известной группы не теряется', () => {
  const select = doc.createElement('select')
  fill(select, [{ id: 'x', title: 'Х' }, { id: 'y', title: 'Y', kind: 'ghost' }], t, doc)
  assert.deepEqual(select.children.flatMap(group => group.children.map(option => option.value)), ['x', 'y'])
})

test('названия групп и путей идут через перевод', () => {
  const select = doc.createElement('select')
  fill(select, [{ id: 'g', title: 'Заглавие', kind: 'gateway' }], text => `EN:${text}`, doc)
  assert.equal(select.children[0].label, 'EN:Агрегаторы и хостинги')
  assert.equal(select.children[0].children[0].textContent, 'EN:Заглавие')
})

test('у групп есть английские пары, а окно подключает модуль и зовёт его из списка путей', () => {
  const root = path.join(__dirname, '..')
  const win = {}
  new Function('window', fs.readFileSync(path.join(root, 'src/renderer/i18n.js'), 'utf8'))(win)
  const en = win.__I18N__.en
  for (const label of Object.values(require('../src/renderer/provider-groups.js').LABEL)) assert.ok(en[label], 'нет пары: ' + label)
  assert.match(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'), /<script src="provider-groups\.js"><\/script>/)
  assert.match(fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8'), /OnlyoneProviderGroups\.fill\(select, view\.providers, t, document\)/)
  assert.deepEqual(ORDER, ['gateway', 'vendor', 'local', 'custom'])
})

if (failed) process.exit(1)
console.log('\nГруппы провайдеров: проверки пройдены')
