// Инициатива 7 (11.10.2026): агент проверяет собственную вёрстку, не прося снимка. После browse_page / browse_click /
// browse_input приложение само снимает страницу — но только локальную (localhost, 127.0.0.1, file:), только модели с
// картинками и не больше шести кадров за ход: картинка стоит токенов, а чужие сайты агент читает текстом.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const from = main.indexOf('const AUTO_SHOT_TOOLS')
const to = main.indexOf('async function releaseAgentPage(', from)

let failed = 0
const check = async (name, fn) => { try { await fn() } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message); return } console.log('ok', name) }

;(async () => {
  await check('main.js: блок автоснимка на месте и подключён в цикл инструментов', () => {
    assert.ok(from > 0 && to > from, 'нет блока автоснимка в main.js')
    assert.ok(/AUTO_SHOT_TOOLS\.has\(toolName\)/.test(main), 'цикл инструментов не зовёт автоснимок')
    assert.ok(/takesShotImages && AUTO_SHOT_TOOLS/.test(main) || /AUTO_SHOT_TOOLS\.has\(toolName\)[^\n]*takesShotImages/.test(main), 'автоснимок не проверяет, что модель принимает картинки')
  })
  if (!(from > 0 && to > from)) { process.exit(1) }

  const build = (stub = {}) => new Function('agentAct', 'browserShotForTurn',
    main.slice(from, to) + '\nreturn { isLocalPageUrl, autoShotForTurn, AUTO_SHOT_TOOLS, AUTO_SHOTS_PER_TURN, autoShotCounts }')(
    stub.agentAct || (async () => ({ success: true, ref: 'r', url: 'http://localhost:5173/' })),
    stub.browserShotForTurn || ((_, taken) => ({ thumb: 't', message: { role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: `Кадр страницы ${taken.url}, который ты только что снял. Смотри.` }] } })))

  await check('локальные адреса — да, чужие сайты и пустое — нет', () => {
    const { isLocalPageUrl } = build()
    for (const ok of ['http://localhost:3000/', 'http://localhost', 'https://127.0.0.1:8443/a?b=1', 'http://[::1]:80/', 'file:///D:/site/index.html']) assert.equal(isLocalPageUrl(ok), true, ok)
    for (const no of ['https://example.com/', 'http://localhost.evil.com/', 'http://127.0.0.1.evil.com/', 'https://evil.com/?u=http://localhost/', '', null, undefined, 'about:blank']) assert.equal(isLocalPageUrl(no), false, String(no))
  })

  await check('снимает после действия на локальной странице; текст назван снимком приложения', async () => {
    const { autoShotForTurn, autoShotCounts } = build()
    const shot = await autoShotForTurn({}, 'req-1', undefined)
    assert.ok(shot && shot.thumb === 't')
    const text = shot.message.content[1].text
    assert.ok(/после твоего действия/.test(text) && !/ты только что снял/.test(text), text)
    assert.equal(autoShotCounts.get('req-1'), 1)
  })

  // 12.10.2026: после клика и ввода агент видит результат и на чужом сайте (поиск, форма, меню); простая загрузка чужой
  // страницы читается текстом — картинка там стоила бы токенов впустую.
  await check('чужая страница после загрузки: кадр не прикладывается и в счёт не идёт', async () => {
    const { autoShotForTurn, autoShotCounts } = build({ agentAct: async () => ({ success: true, ref: 'r', url: 'https://example.com/' }) })
    assert.equal(await autoShotForTurn({}, 'req-2', undefined, 'browse_page'), null)
    assert.equal(autoShotCounts.get('req-2') || 0, 0)
  })

  await check('чужая страница после клика и ввода: кадр есть', async () => {
    const { autoShotForTurn, autoShotCounts } = build({ agentAct: async () => ({ success: true, ref: 'r', url: 'https://example.com/search?q=x' }) })
    assert.ok(await autoShotForTurn({}, 'req-2b', undefined, 'browse_click'), 'после клика')
    assert.ok(await autoShotForTurn({}, 'req-2b', undefined, 'browse_input'), 'после ввода')
    assert.equal(autoShotCounts.get('req-2b'), 2)
  })

  await check('локальная страница после загрузки: кадр есть', async () => {
    const { autoShotForTurn } = build()
    assert.ok(await autoShotForTurn({}, 'req-2c', undefined, 'browse_page'))
  })

  await check('не больше шести кадров за ход', async () => {
    let taken = 0
    const { autoShotForTurn, AUTO_SHOTS_PER_TURN } = build({ agentAct: async () => { taken++; return { success: true, ref: 'r', url: 'http://localhost/' } } })
    assert.equal(AUTO_SHOTS_PER_TURN, 6)
    for (let i = 0; i < 6; i++) assert.ok(await autoShotForTurn({}, 'req-3', undefined), 'кадр ' + (i + 1))
    assert.equal(await autoShotForTurn({}, 'req-3', undefined), null)
    assert.equal(taken, 6, 'после предела страницу даже не снимают')
    assert.ok(await autoShotForTurn({}, 'req-4', undefined), 'у другого хода свой счёт')
  })

  await check('сбой снимка не роняет ход', async () => {
    const { autoShotForTurn } = build({ agentAct: async () => { throw new Error('страница закрыта') } })
    assert.equal(await autoShotForTurn({}, 'req-5', undefined), null)
    const none = build({ agentAct: async () => ({ success: false, error: 'нет' }) })
    assert.equal(await none.autoShotForTurn({}, 'req-6', undefined), null)
  })

  await check('автоснимок только после действий с браузером', () => {
    const { AUTO_SHOT_TOOLS } = build()
    assert.deepEqual([...AUTO_SHOT_TOOLS].sort(), ['browse_click', 'browse_input', 'browse_page'])
  })

  if (failed) process.exit(1)
  console.log('Зрение в ход мысли после действия: проверки пройдены')
})()
