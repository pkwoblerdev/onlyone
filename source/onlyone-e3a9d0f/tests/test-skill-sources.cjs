// Источники скиллов (макет 21.10, «Новый скилл»): файл → инструкция, проверка папки и .zip
// до импорта, скиллы проекта в .onlyone/skills. Без окна: модуль главного процесса напрямую.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const src = require('../src/main/skill-sources.js')

let failed = 0, total = 0
const check = async (name, fn) => {
  total++
  try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '—', e.message) }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-skill-src-'))

// Маленький zip-писатель для проверок: deflate или store, crc32 честный
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function zip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), packed = zlib.deflateRawSync(data), nameBuf = Buffer.from(name, 'utf8')
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26)
    locals.push(head, nameBuf, packed)
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(crc32(data), 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42)
    centrals.push(cen, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
const docx = paras => zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': `<w:document xmlns:w="w"><w:body>${paras}</w:body></w:document>`
})
const P = (text, style = '', list = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

;(async () => {
  await check('zip читается: deflate, имена в UTF-8', async () => {
    const entries = src.readZip(zip({ 'SKILL.md': 'привет', 'scripts/run.ps1': 'echo 1' }))
    assert.deepEqual(entries.map(e => e.name), ['SKILL.md', 'scripts/run.ps1'])
    assert.equal(entries[0].data.toString('utf8'), 'привет')
  })

  await check('.md с шапкой: название и «когда брать» из шапки, тело без шапки', async () => {
    const dir = tmp(), f = path.join(dir, 'review.md')
    fs.writeFileSync(f, '---\nname: Ревью SQL\ndescription: Перед миграцией проверить индексы\n---\n\n# Ревью SQL\n\n- EXPLAIN на каждый запрос\n')
    const r = await src.fileToSkill(f)
    assert.equal(r.name, 'Ревью SQL')
    assert.equal(r.description, 'Перед миграцией проверить индексы')
    assert.match(r.body, /^# Ревью SQL/)
    assert.ok(!/^---/.test(r.body))
    assert.equal(r.kind, 'md')
  })

  await check('.txt без шапки: название — первая строка, «когда брать» — первый абзац, что распознано — списком', async () => {
    const dir = tmp(), f = path.join(dir, 'release.txt')
    fs.writeFileSync(f, 'Чек-лист релиза\n\nПеред выпуском версии пройти проверки.\n\n- Тесты зелёные\n- Версия поднята\n')
    const r = await src.fileToSkill(f)
    assert.equal(r.name, 'Чек-лист релиза')
    assert.equal(r.description, 'Перед выпуском версии пройти проверки.')
    assert.ok(r.found.length >= 2)
    assert.ok(r.found.some(x => /2 пункт/.test(x.b + ' ' + x.t)), JSON.stringify(r.found))
  })

  await check('.docx: заголовок → название, абзац → описание, пункты → список, таблица → список с предупреждением', async () => {
    const dir = tmp(), f = path.join(dir, 'release-checklist.docx')
    fs.writeFileSync(f, docx(P('Чек-лист релиза', 'Heading1') + P('Перед выпуском версии пройти проверки.') +
      P('Тесты зелёные', '', true) + P('Сборка подписана', '', true) +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Шаг</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Кто</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'))
    const r = await src.fileToSkill(f)
    assert.equal(r.kind, 'docx')
    assert.equal(r.name, 'Чек-лист релиза')
    assert.equal(r.description, 'Перед выпуском версии пройти проверки.')
    assert.match(r.body, /- Тесты зелёные\n- Сборка подписана/)
    assert.match(r.body, /- Шаг: Кто|- Шаг, Кто|- Шаг — Кто|- Шаг \| Кто/)
    assert.ok(r.found.some(x => x.s === 'warn' && /Таблиц/.test(x.b)), JSON.stringify(r.found))
  })

  await check('.pdf: разбор только моделью — модуль так и говорит', async () => {
    const dir = tmp(), f = path.join(dir, 'guide.pdf')
    fs.writeFileSync(f, '%PDF-1.4\n')
    const r = await src.fileToSkill(f)
    assert.equal(r.kind, 'pdf')
    assert.equal(r.needsModel, true)
  })

  await check('чужое расширение — понятная ошибка', async () => {
    const dir = tmp(), f = path.join(dir, 'x.exe')
    fs.writeFileSync(f, 'MZ')
    await assert.rejects(() => src.fileToSkill(f), /\.md, \.txt, \.pdf или \.docx/)
  })

  await check('проверка папки: SKILL.md, name, нет description — ошибка со строкой, скрипт — согласие', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Выкатка на staging\n---\n\n# Выкатка\n\n- Запусти scripts/deploy.ps1\n')
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(path.join(dir, 'scripts', 'deploy.ps1'), 'echo deploy')
    const r = src.checkPackDir(dir)
    const bad = r.items.filter(x => x.s === 'bad')
    assert.equal(r.name, 'Выкатка на staging')
    assert.equal(bad.length, 1)
    assert.match(bad[0].t, /description/)
    assert.match(bad[0].t, /строка 3/)
    assert.ok(r.items.some(x => x.s === 'info' && /scripts\/deploy\.ps1/.test(x.b)), JSON.stringify(r.items))
    assert.equal(r.ready, false)
  })

  await check('проверка папки без SKILL.md — одна ошибка, импорт невозможен', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'readme.md'), '# нет')
    const r = src.checkPackDir(dir)
    assert.equal(r.ready, false)
    assert.ok(r.items.some(x => x.s === 'bad' && /SKILL\.md/.test(x.b + x.t)))
  })

  await check('проверка .zip: распаковывается во временную папку и проверяется так же', async () => {
    const dir = tmp(), f = path.join(dir, 'staging-deploy.zip')
    fs.writeFileSync(f, zip({ 'staging-deploy/SKILL.md': '---\nname: Выкатка\ndescription: Выкатывает ветку\n---\n\nШаги', 'staging-deploy/scripts/deploy.ps1': 'echo' }))
    const r = await src.checkPackPath(f)
    assert.equal(r.ready, true, JSON.stringify(r.items))
    assert.ok(fs.existsSync(path.join(r.dir, 'SKILL.md')), 'папка скилла внутри архива найдена')
  })

  await check('дописать description в шапку — перед закрывающей чертой', async () => {
    const out = src.withDescription('---\nname: X\n---\n\nтело', 'Когда нужно X')
    assert.equal(out, '---\nname: X\ndescription: Когда нужно X\n---\n\nтело')
    assert.equal(src.withDescription('без шапки', 'Д'), '---\ndescription: Д\n---\n\nбез шапки')
  })

  await check('скиллы проекта: папки со SKILL.md и одиночные .md в .onlyone/skills', async () => {
    const ws = tmp(), root = path.join(ws, '.onlyone', 'skills')
    fs.mkdirSync(path.join(root, 'cart-tests'), { recursive: true })
    fs.writeFileSync(path.join(root, 'cart-tests', 'SKILL.md'), '---\nname: Тесты корзины\ndescription: Как запускать тесты корзины\n---\n\nnpm run test:cart')
    fs.writeFileSync(path.join(root, 'code-style.md'), '---\nname: Стиль кода\ndescription: Именование и импорты\n---\n\nПравила')
    fs.writeFileSync(path.join(root, 'deploy.md'), '---\nname: Деплой\n---\n\nscp')
    const list = src.projectSkills(ws, [src.projectSkillId(ws, 'code-style')])
    const byName = Object.fromEntries(list.map(s => [s.name, s]))
    assert.equal(list.length, 3)
    assert.equal(byName['Тесты корзины'].category, 'project')
    assert.equal(byName['Тесты корзины'].enabled, true)
    assert.equal(byName['Стиль кода'].enabled, false, 'выключенный в настройках')
    assert.match(byName['Деплой'].error, /description/)
    assert.equal(byName['Тесты корзины'].project.rel, '.onlyone/skills/cart-tests/')
    assert.deepEqual(byName['Тесты корзины'].pack.files, ['SKILL.md'])
  })

  await check('новый скилл в проекте: папка с SKILL.md, имя не затирает соседа', async () => {
    const ws = tmp()
    const a = src.writeProjectSkill(ws, { name: 'Ревью', description: 'Перед коммитом', body: '- ключи' })
    const b = src.writeProjectSkill(ws, { name: 'Ревью', description: 'Ещё', body: '- x' })
    assert.notEqual(a, b)
    assert.match(fs.readFileSync(path.join(a, 'SKILL.md'), 'utf8'), /^---\nname: Ревью\ndescription: Перед коммитом\n---\n\n- ключи/)
    assert.ok(path.resolve(a).startsWith(path.resolve(ws, '.onlyone', 'skills')))
  })

  console.log(failed ? `ПРОВАЛ: ${failed} из ${total}` : `источники скиллов: всё прошло (${total})`)
  process.exit(failed ? 1 : 0)
})()
