// 1code → onlyone.
//
// Сменить название — дело на пять строк, а потерять из-за него всю переписку
// человека — на одну. Electron кладёт данные в папку, названную по имени
// приложения, и обновление, сменившее имя, открылось бы пустым: без чатов, без
// ключей, без дизайнов. Здесь проверяется, что имя сменилось везде, где его видят,
// и не сменилось там, где от него зависят данные и обновления.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const CR = String.fromCharCode(13)
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').split(CR).join('')
const main = read('src', 'main', 'main.js')
const html = read('src', 'renderer', 'index.html')
const builder = require(path.join(root, 'electron-builder.config.cjs'))
const pkg = JSON.parse(read('package.json'))

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- данные остаются на месте ---------------------------------------------------

const pin = main.indexOf("app.setPath('userData', chosen)")
check('папка данных называется onlyone', pin > 0 && /join\(appData, 'onlyone'\)/.test(main))
check('прежняя папка 1code переезжает одним переименованием, без копий и удаления',
  /renameSync\(legacy, fresh\)/.test(main) && /join\(appData, '1code'\)/.test(main) && !/rmSync\(legacy|rmdirSync\(legacy/.test(main))
check('не вышло переименовать — работа идёт в старой папке, данные не теряются', /catch \{ chosen = require\('fs'\)\.existsSync\(legacy\) \? legacy : fresh \}/.test(main))
check('папка закреплена раньше хранилища настроек', pin > 0 && pin < main.indexOf("new Store({ name: '1code-settings' })"))
check('папка закреплена раньше блокировки второго экземпляра', pin > 0 && pin < main.indexOf('app.requestSingleInstanceLock()'))
let explicitProfilePreserved = false
try {
  require('node:vm').runInNewContext(main.slice(0, main.indexOf("app.setName('onlyone')")), {
    require: name => {
      if (name !== 'electron') throw Error('explicit profile must not run migration')
      return { app: { commandLine: { hasSwitch: flag => flag === 'user-data-dir' },
        getPath: () => { throw Error('explicit profile must not be read as default') },
        setPath: () => { throw Error('explicit profile must not be replaced') } } }
    }
  })
  explicitProfilePreserved = true
} catch (error) { console.error(error.message) }
check('явный профиль тестов не перебивается', explicitProfilePreserved)
check('имя приложения задаётся после закрепления папки',
  main.indexOf("app.setName('onlyone')") > pin)
check('файл настроек не переименован', /new Store\(\{ name: '1code-settings' \}\)/.test(main))

// --- обновления находят установленную программу ----------------------------------

check('внутреннее имя пакета в исходниках прежнее — по нему узнаются исходники', pkg.name === '1code', pkg.name)
check('в сборке имя пакета onlyone: папка загрузок обновления называется onlyone-updater', builder.extraMetadata && builder.extraMetadata.name === 'onlyone')
check('идентификатор установщика прежний — обновление ставится поверх, а не рядом',
  builder.nsis.guid === '4EB839B2-2DAB-4DA7-9E3B-F2E884BBD9A1')
check('идентификатор приложения прежний', builder.appId === 'com.onecode.workspace')
check('без настроенного адреса канал обновлений не встроен', process.env.ONECODE_FEED_URL ? builder.publish.length === 1 : builder.publish.length === 0)

// --- имя, которое видят, — новое ----------------------------------------------------

check('имя продукта в сборке', builder.productName === 'onlyone')
check('ярлык', builder.nsis.shortcutName === 'onlyone')
check('переносная сборка', /^onlyone-/.test(builder.portable.artifactName))
check('заголовок окна', /const APP_TITLE = 'onlyone'/.test(main) && /<title>onlyone<\/title>/.test(html))
check('имя в шапке', /<span class="brand-name">onlyone<\/span>/.test(html))
// Имя продукта модель узнаёт из текста режима (план, 6.2): промпты лежат
// данными в ./mode-prompts, и проверка смотрит на настоящий собранный текст,
// а не на строку в главном процессе.
const modePrompts = require('../src/main/mode-prompts')
check('модель знает, как называется приложение', () => {
  for (const mode of ['conversation', 'agent']) {
    const prompt = modePrompts.buildModePrompt(mode, { toolNames: [], personal: '', language: '' })
    assert.match(prompt, /Ты — onlyone, инженерный ассистент/, 'режим ' + mode)
  }
  assert.match(modePrompts.buildModePrompt('design', { toolNames: [], personal: '', language: '' }), /Ты — onlyone в разделе «Дизайн»/)
})
check('в видимых строках окна старого имени нет',
  !/>1code<|1code studio|Знак 1code/.test(html + read('src', 'renderer', 'app.js')))
// Промпты Дизайна и памятки агента читает модель, и старое имя в них — тоже
// имя, которое видят: оно уходило в ответы как название программы.
check('промпты Дизайна и памятки называют приложение onlyone',
  !/1code/.test(read('src', 'main', 'design', 'prompt.js') + read('src', 'main', 'design', 'review-contract.js') +
    read('src', 'main', 'work-guides.js')))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
