// Вкладка «Провайдеры и ключи» без накладок (план, 2.8б; поручение 28.09
// 11:45) — девять настоящих окон: четыре состояния × два языка и один кадр при
// 125% масштабе Windows.
//
// Состояния ровно из spec владельца: выбран OpenRouter (только пул ключей),
// выбран именованный провайдер (его поля и чип), выбрано своё подключение
// (список строк с меню «⋯»), и «Изменить» из того меню (поля своего пути с
// именем и раскрытыми ограничениями).
//
// Живой сети и платных вызовов нет: профиль заранее содержит два своих
// подключения, учётную запись Anthropic и два ключа пула OpenRouter. Конверты
// ключей заранее НЕЧИТАЕМЫ (`keyEnc: 'unknown'`): экран обязан называть
// состояние словами и не показывать ни символа секрета — ни на экране, ни на
// диске после прогона.
//
// Зелёный прогон убирает свой каталог, красный оставляет; кадры копируются в
// `audits/…` до уборки — снимок обязан пережить прогон и смотреться глазами.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const commandRunner = require('../src/main/command-runner')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-providers-tab')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-28', 'providers-tab')
const ENVELOPE = 'Q1RFU1QtTkUtVVMt'   // конверт, который окно не имеет права показать
// Имена подключений — данные человека, а не подписи окна: в английском профиле
// они английские, иначе проверка «на экране нет кириллицы» ловила бы имя,
// которое человек сам набрал.
const NAMES = { ru: ['Домашняя', 'Рабочая'], en: ['Home', 'Work'] }
const KEY_NAMES = { ru: ['Основной', 'Запасной'], en: ['Primary', 'Backup'] }
const TURNS = { ru: 'ход идёт здесь', en: 'turns run here' }
const PATH_TITLE = { ru: 'Путь к моделям', en: 'Model path' }
const STATES = ['openrouter', 'named', 'connections', 'fields']

const notes = []
function claim(name, pass, detail) {
  notes.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail ? ` — ${detail}` : ''))
}

// Локальная заглушка каталога: переключение на свой путь по-настоящему тянет
// `/models`. Без ответа окно записало бы причиной «не удалось связаться» —
// русским словом главного процесса, и проверка меряла бы сеть, а не раскладку.
// Внешней сети и настоящих ключей нет: только 127.0.0.1.
const stub = http.createServer((req, res) => {
  const side = /^\/home\//.test(req.url || '') ? 'home' : /^\/work\//.test(req.url || '') ? 'work' : null
  const models = side === 'home' ? ['glm-home', 'glm-home-lite'] : side === 'work' ? ['glm-work'] : []
  res.writeHead(models.length ? 200 : 404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }))
})
const ready = new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve()))
const urlFor = side => `http://127.0.0.1:${stub.address().port}/${side}/v1`

function connection(extra = {}) {
  return {
    provider: 'openai-compatible', name: '', baseUrl: '', model: '',
    keyEncrypted: ENVELOPE + 'MTIzNDU2Nzg5MA==', keyEnc: 'unknown',
    capabilities: { streaming: true, tools: true, catalog: true },
    createdAt: 1, updatedAt: 1, lastCheck: null, ...extra
  }
}

// Один и тот же посев для обоих профилей: различается только `language`.
function seedSettings(language) {
  const home = connection({
    id: 'p-home', name: NAMES[language][0], baseUrl: urlFor('home'),
    model: 'glm-home', lastCheck: { at: 2, ok: true, reason: 'HTTP 200 · 2 модели' }
  })
  const work = connection({
    id: 'p-work', name: NAMES[language][1], baseUrl: urlFor('work'),
    model: 'glm-work', capabilities: { streaming: true, tools: false, catalog: true },
    lastCheck: { at: 3, ok: false, reason: 'HTTP 401' }
  })
  // Учётная запись именованного пути живёт в том же списке — так её видит
  // настоящий главный процесс (правило каталога 25.09).
  const anthropic = connection({
    id: 'p-anthropic', provider: 'anthropic', name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5',
    keyEncrypted: ''
  })
  return {
    language,
    // Стартовый путь — свой: он даёт строке списка право назваться ходящей.
    // Каждое состояние всё равно выбирает путь явно, так что посев тут не
    // подменяет проверку.
    activeProvider: 'openai-compatible',
    activeCustomProvider: home.id,
    openrouterKeys: [
      { id: 'k-one', name: KEY_NAMES[language][0], keyEncrypted: ENVELOPE + 'b25l', enabled: true, createdAt: 1 },
      { id: 'k-two', name: KEY_NAMES[language][1], keyEncrypted: ENVELOPE + 'dHdv', enabled: false, createdAt: 2 }
    ],
    customProviders: [home, work, anthropic]
  }
}

function profileDir(language) {
  const dir = path.join(output, `profile-${language}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '1code-settings.json'), JSON.stringify(seedSettings(language), null, 2))
  return dir
}

// Запуск асинхронный: заглушка каталога живёт в этом же процессе, а
// `spawnSync` заморозил бы его цикл событий — окно не дождлось бы ответа.
function launch(name, profile, arg, extraArgs = []) {
  const resultFile = path.join(output, `${name}.json`)
  const shot = path.join(output, `${name}.png`)
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`, ...extraArgs], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'providers-tab-renderer.js'),
          ONECODE_SMOKE_OUT: resultFile,
          ONECODE_SHOT: shot,
          ONECODE_ARG: Buffer.from(JSON.stringify(arg), 'utf8').toString('base64')
        })
      })
    const timer = setTimeout(() => {
      console.error(`${name}: окно не вернулось за 240 с — снимаю дерево ${child.pid}`)
      commandRunner.killTree(child.pid, () => {})
    }, 240000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      fs.mkdirSync(evidence, { recursive: true })
      if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(evidence, `${name}.png`))
      if (!fs.existsSync(resultFile)) {
        console.error(`Окно не отчиталось: ${name} (код выхода ${code})`)
        resolve({ ok: false, checks: [], state: arg.state, name })
        return
      }
      const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      report.state = arg.state
      report.name = name
      if (report.error) console.error(`${name}: окно сообщило об ошибке — ${report.error}`)
      for (const item of report.checks || []) {
        console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name +
          (item.detail ? ' — ' + item.detail : ''))
      }
      for (const leak of report.leaks || []) console.log(`НАХОДКА · ${name} · не подпись вкладки: ${leak}`)
      console.log(`снимок: ${path.join(evidence, `${name}.png`)}`)
      resolve(report)
    })
  })
}

async function main() {
  await ready
  const ru = profileDir('ru')
  const en = profileDir('en')
  // Один прогон долгий (девять окон), а правку экрана хочется проверить на
  // одном кадре: `ONECODE_TAB_ONLY=connections-ru,fields-en` запускает только
  // названные состояния. Полный набор при этом остаётся полным.
  const only = (process.env.ONECODE_TAB_ONLY || '').split(',').map(one => one.trim()).filter(Boolean)
  const planned = []
  const results = []
  for (const language of ['ru', 'en']) {
    const profile = language === 'ru' ? ru : en
    for (const state of STATES) {
      const name = `${state}-${language}`
      planned.push(name)
      if (only.length && !only.includes(name)) continue
      results.push(await launch(name, profile, {
        state, lang: language, names: NAMES[language], secretMark: ENVELOPE,
        // По каким словам видно, что путь на экране переключился: строка пути
        // пишется тем же проходом рисования, что и видимость групп.
        noteOf: { openrouter: 'OpenRouter', anthropic: 'Anthropic', 'openai-compatible': 'OpenAI' },
        labels: { turnsHere: TURNS[language], pathTitle: PATH_TITLE[language] }
      }))
    }
  }
  // Тот же экран при 125% масштабировании Windows: наложения обязаны не быть и
  // там, где человек реально сидит чаще всего.
  planned.push('fields-scale125-ru')
  if (!only.length || only.includes('fields-scale125-ru')) {
    results.push(await launch('fields-scale125-ru', ru, {
      state: 'fields', lang: 'ru', names: NAMES.ru, secretMark: ENVELOPE,
      noteOf: { openrouter: 'OpenRouter', anthropic: 'Anthropic', 'openai-compatible': 'OpenAI' },
      labels: { turnsHere: TURNS.ru, pathTitle: PATH_TITLE.ru }
    }, ['--force-device-scale-factor=1.25']))
  }

  const failed = results.filter(one => !one.ok).map(one => one.name)
  claim(`все ${results.length} окон зелёные`, results.length === (only.length || planned.length) && failed.length === 0,
    failed.length ? 'красные прогоны: ' + failed.join(', ') : '')
  claim('каждый кадр пережил прогон',
    results.every(one => fs.existsSync(path.join(evidence, `${one.name}.png`))
      && fs.statSync(path.join(evidence, `${one.name}.png`)).size > 10000),
    evidence)

  // Диск после прогонов: конверты остались конвертами, список не разъехался.
  const stored = JSON.parse(fs.readFileSync(path.join(ru, '1code-settings.json'), 'utf8'))
  const dump = JSON.stringify(stored)
  claim('настройки не расшифровались в открытый ключ',
    !/sk-or-v1|sk-ant|TEST-KEY/.test(dump) && dump.includes(ENVELOPE), 'конверт на месте, секретного префикса нет')
  claim('прогон не оставил и не стёр подключений',
    (stored.customProviders || []).length === 3 && (stored.openrouterKeys || []).length === 2,
    `подключений: ${(stored.customProviders || []).length}, ключей: ${(stored.openrouterKeys || []).length}`)
  claim('язык профиля дожил до конца', stored.language === 'ru', String(stored.language))

  const ok = notes.every(one => one.pass) && failed.length === 0
  console.log(JSON.stringify({ ok, checks: notes.length + results.reduce((n, one) => n + (one.checks || []).length, 0),
    failed: notes.filter(one => !one.pass).length + failed.length }))
  settleRun(output, ok)
  process.exitCode = ok ? 0 : 1
}

main().then(() => {
  // Заглушка держит цикл событий: без её снятия прогон не вернулся бы с кодом.
  stub.close()
}, error => {
  console.error('СБОЙ прогона:', error && error.message)
  stub.close()
  settleRun(output, false)
  process.exitCode = 1
})
