// Скилл-пакет: папка с SKILL.md и соседними файлами.
//
// Проверяется то, из-за чего пакет может тихо испортить работу: заголовок
// разобран неверно, файл прочитан мимо папки скилла, двоичный файл ушёл в
// переписку, пакет остался лежать по чужому пути.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const packs = require('../src/main/skill-packs.js')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  return Promise.resolve().then(fn).catch(error => {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  })
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-packs-'))
const source = path.join(base, 'ui-ux-pro-max')
fs.mkdirSync(path.join(source, 'references'), { recursive: true })
fs.mkdirSync(path.join(source, 'data'), { recursive: true })
fs.writeFileSync(path.join(source, 'SKILL.md'), `---
name: ui-ux-pro-max
description: >-
  Searchable local UI/UX guidance: 79 styles,
  192 palettes and 119 guidelines.
license: MIT
---

# UI/UX Pro Max

Читай references/quick-reference.md по необходимости.
`, 'utf8')
fs.writeFileSync(path.join(source, 'references', 'quick-reference.md'), '# Правила\n1. Контраст 4.5:1\n', 'utf8')
fs.writeFileSync(path.join(source, 'data', 'colors.csv'), 'name,hex\nterracotta,#e08c62\n', 'utf8')
fs.writeFileSync(path.join(source, 'data', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x1a]))
fs.mkdirSync(path.join(source, '.git'), { recursive: true })
fs.writeFileSync(path.join(source, '.git', 'config'), 'ignored', 'utf8')

async function main() {
  await check('заголовок разбирается, свёрнутое описание склеивается', () => {
    const parsed = packs.parseSkillMd(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'))
    assert.equal(parsed.meta.name, 'ui-ux-pro-max')
    assert.equal(parsed.meta.license, 'MIT')
    assert.match(parsed.meta.description, /79 styles, 192 palettes/)
    assert.match(parsed.body, /^# UI\/UX Pro Max/)
    assert.doesNotMatch(parsed.body, /^---/)
  })

  await check('текст без заголовка остаётся инструкцией целиком', () => {
    const parsed = packs.parseSkillMd('Просто инструкция без заголовка.')
    assert.deepEqual(parsed.meta, {})
    assert.equal(parsed.body, 'Просто инструкция без заголовка.')
  })

  await check('папка признаётся скиллом и видит свои файлы', () => {
    const info = packs.inspectPack(source)
    assert.equal(info.name, 'ui-ux-pro-max')
    const names = info.files.map(file => file.path)
    assert(names.includes('references/quick-reference.md'), names.join(', '))
    assert(names.includes('data/colors.csv'))
    // Служебные папки внутрь скилла не попадают: они не инструкция.
    assert(!names.some(name => name.startsWith('.git/')), names.join(', '))
  })

  await check('папка без SKILL.md отвергается', () => {
    const plain = path.join(base, 'not-a-skill')
    fs.mkdirSync(plain, { recursive: true })
    fs.writeFileSync(path.join(plain, 'readme.txt'), 'nope', 'utf8')
    assert.throws(() => packs.inspectPack(plain), /SKILL\.md/)
  })

  const root = path.join(base, 'store')
  fs.mkdirSync(root, { recursive: true })
  const imported = await packs.importPack(source, root, [])

  await check('пакет копируется к себе, а не остаётся по чужому пути', () => {
    assert.equal(imported.dir, path.join(root, 'ui-ux-pro-max'))
    assert(fs.existsSync(path.join(imported.dir, 'SKILL.md')))
    assert(fs.existsSync(path.join(imported.dir, 'references', 'quick-reference.md')))
    assert(!fs.existsSync(path.join(imported.dir, '.git')))
  })

  await check('второй пакет с тем же именем не затирает первый', async () => {
    const again = await packs.importPack(source, root, [imported.slug])
    assert.notEqual(again.slug, imported.slug)
    assert(fs.existsSync(path.join(imported.dir, 'SKILL.md')))
  })

  await check('файл скилла читается по относительному пути', () => {
    const text = packs.readPackFile(imported.dir, 'references/quick-reference.md')
    assert.match(text, /Контраст 4\.5:1/)
  })

  await check('путь наружу отвергается', () => {
    for (const bad of ['../SKILL.md', '../../etc/passwd', '/etc/passwd', 'references/../../outside.txt']) {
      assert.throws(() => packs.readPackFile(imported.dir, bad), /за пределы скилла|ENOENT/, 'прошёл: ' + bad)
    }
  })

  await check('двоичный файл в переписку не отдаётся', () => {
    assert.throws(() => packs.readPackFile(imported.dir, 'data/logo.bin'), /Двоичный/)
  })

  // Инструмент агента — на настоящем коде main.js: он читает файл пакета и не
  // выходит за его пределы, что бы модель ни написала в аргументах.
  await check('инструмент skill_file читает файл пакета и держит границу', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
    const from = main.indexOf("    if (name === 'skill_file') {")
    const to = main.indexOf("    if (name === 'update_skill'", from)
    assert(from > 0 && to > from, 'ветка skill_file не найдена в main.js')
    const branch = main.slice(from, to)

    const run = new Function('packSkill', 'skillPacks', 'event', 'requestId', 'args', 'name',
      // Настоящая точка отправки хода: ветка `skill_file` пишет в ленту через неё.
      `${main.slice(main.indexOf('function sendToWindow(event, channel, body) {'), main.indexOf('async function runAgentMode('))}
${branch}
 return { success: false, error: 'ветка не сработала' }`)

    const skill = { id: 'pack_x', pack: { dir: imported.dir } }
    const event = { sender: { send() {} } }
    const good = await run(() => skill, packs, event, 'r1',
      { id: 'pack_x', path: 'references/quick-reference.md' }, 'skill_file')
    assert.equal(good.success, true, JSON.stringify(good))
    assert.match(good.content, /Контраст 4\.5:1/)

    const outside = await run(() => skill, packs, event, 'r1',
      { id: 'pack_x', path: '../../secret.txt' }, 'skill_file')
    assert.equal(outside.success, false)
    assert.match(String(outside.error), /за пределы скилла|ENOENT/)

    const missing = await run(() => null, packs, event, 'r1', { id: 'nope', path: 'SKILL.md' }, 'skill_file')
    assert.equal(missing.success, false)
  })

  fs.rmSync(base, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
