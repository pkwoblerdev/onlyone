// Чистка скиллов (решение владельца 04.10.2026): ненужные скиллы тратили токены.
//
// Проверяется настоящий код из main.js, вырезанный по маркёрам: одноразовая чистка скиллов
// (снимает только ВЫКЛЮЧЕННЫЕ, не трогает включённые и пакеты, сначала пишет архив, один раз).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  assert.ok(a >= 0 && b > a, 'не найден участок main.js: ' + from)
  return main.slice(a, b)
}

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

function makeStore(initial = {}) {
  const data = { ...initial }
  return { get: (key, fallback) => (key in data ? data[key] : fallback), set: (key, value) => { data[key] = value }, data }
}

// ── скиллы ──────────────────────────────────────────────────────────────────
const skillsCode = (() => {
  const a = main.indexOf('const RETIRED_SKILL_IDS')
  const r = main.indexOf('return { removed: gone', a)
  assert.ok(a >= 0 && r > a, 'не найден retireSkills')
  const end = main.indexOf('}', main.indexOf('}', r) + 1)
  return main.slice(a, end + 1)
})()
function skillsWorld(skills, extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-prune-'))
  const store = makeStore(extra)
  const secure = { skills }
  const log = []
  const api = new Function('require', 'store', 'app', 'readSecure', 'writeSecure', 'latency', skillsCode + '\nreturn { retireSkills, RETIRED_SKILL_IDS }')(
    require, store, { getPath: () => userData }, (key, fallback) => (key in secure ? secure[key] : fallback),
    (key, value) => { secure[key] = value }, { write: line => log.push(line) })
  return { api, store, secure, userData, log }
}
const stock = id => ({ id, name: id, enabled: false, systemPrompt: 'x' })

test('выключенные прежние персоны и дубль Caveman снимаются, остальное цело', () => {
  const mine = { id: 'token-optimizer', name: 'Token Saver & Smart Diet', enabled: true, systemPrompt: 'y' }
  const analyst = { id: 'youtube-video-analysis', name: 'YouTube Video Analyst', enabled: false, systemPrompt: 'z' }
  const world = skillsWorld([stock('code-review'), stock('security-audit'), stock('refactor-architect'), stock('doc-generator'), stock('test-engineer'), stock('token-saver'), mine, analyst])
  const done = world.api.retireSkills()
  assert.deepEqual(done.removed.sort(), ['code-review', 'doc-generator', 'refactor-architect', 'security-audit', 'test-engineer', 'token-saver'])
  assert.deepEqual(world.secure.skills.map(skill => skill.id), ['token-optimizer', 'youtube-video-analysis'])
})

test('включённая персона остаётся: чистка снимает только то, что выключено', () => {
  const on = { ...stock('code-review'), enabled: true }
  const world = skillsWorld([on, stock('test-engineer')])
  const done = world.api.retireSkills()
  assert.deepEqual(done.removed, ['test-engineer'])
  assert.deepEqual(world.secure.skills.map(skill => skill.id), ['code-review'])
})

test('пакет с тем же id не снимается', () => {
  const pack = { ...stock('code-review'), pack: { dir: 'x' } }
  const world = skillsWorld([pack])
  assert.deepEqual(world.api.retireSkills().removed, [])
  assert.equal(world.secure.skills.length, 1)
})

test('снятое лежит в archive/ и читается обратно', () => {
  const world = skillsWorld([stock('code-review'), stock('doc-generator')])
  world.api.retireSkills()
  const file = path.join(world.userData, 'archive', 'skills-retired-2026-10-04.json')
  assert.ok(fs.existsSync(file), 'архива нет')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(skill => skill.id), ['code-review', 'doc-generator'])
})

test('чистка идёт один раз: вернувшийся вручную скилл второй раз не снимается', () => {
  const world = skillsWorld([stock('code-review')])
  world.api.retireSkills()
  world.secure.skills = [stock('code-review')]
  assert.deepEqual(world.api.retireSkills().removed, [], 'метка «сделано» обязана держаться')
  assert.equal(world.secure.skills.length, 1)
})

test('нет архива — нет и удаления', () => {
  const blocker = path.join(os.tmpdir(), 'onlyone-prune-file-' + process.pid)
  fs.writeFileSync(blocker, 'файл на месте каталога')
  const world = skillsWorld([stock('code-review')])
  const api = new Function('require', 'store', 'app', 'readSecure', 'writeSecure', 'latency', skillsCode + '\nreturn { retireSkills }')(
    require, world.store, { getPath: () => blocker }, (key, fallback) => world.secure[key] ?? fallback, (key, value) => { world.secure[key] = value }, { write: () => {} })
  assert.deepEqual(api.retireSkills().removed, [])
  assert.equal(world.secure.skills.length, 1, 'без архива скилл остаётся на месте')
  assert.ok(!world.store.get('skillsRetired'), 'и метка не ставится, чтобы чистка повторилась')
  fs.unlinkSync(blocker)
})

if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
console.log('\nВсе проверки чистки пройдены')
