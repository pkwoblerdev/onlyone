// Окно о потере ключа профиля и архив нечитаемых секций — отдельным модулем
// (А-3, вынос из main.js).
//
// `noticeKeyLoss`, `bulkIntegrity`, `bulkKeyLost` и `archiveCorruptSettings`
// больше не живут в main.js: решение «что сказать человеку и когда» и куда
// отложить нечитаемые байты вынесено в `src/main/profile-notice.cjs`, а чтение
// настроек и наборы остаются в главном процессе. Здесь проверяется сам модуль:
// тексты, границы между «потерян ключ» и «секция настроек ушла в архив», одно
// окно на набор, архив одним файлом и отсутствие обратной зависимости от main.js.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const modulePath = path.join(root, 'src', 'main', 'profile-notice.cjs')
const { createProfileNotice } = require(modulePath)
const { tr } = require('../src/main/ui-text.cjs')

let checks = 0
const failures = []
function check (name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const dirs = []
const mkDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-profile-notice-'))
  dirs.push(dir)
  return dir
}

function build (options = {}) {
  const calls = []
  const log = []
  let bulkCalls = 0
  const integrity = options.integrity || (() => ({ keyLost: [], unreadable: [], blocked: [] }))
  const notice = createProfileNotice({
    bulk: () => { bulkCalls++; return { integrity } },
    bulkKeys: options.bulkKeys || new Set(['conversations', 'designs', 'runConfigurations']),
    dialog: {
      showMessageBox: message => {
        calls.push(message)
        return Promise.resolve({ response: 0 })
      }
    },
    app: { getPath: () => options.dir || 'C:\\profile' },
    join: path.join,
    tr: options.tr || tr,
    latency: { write: (text, info) => log.push(`${text} ${info === undefined ? '' : JSON.stringify(info)}`) },
    fs: options.fs || fs
  })
  return { ...notice, calls, log, bulkCalls: () => bulkCalls }
}

try {
  check('модуль есть и не тянет main.js через require', () => {
    assert.ok(fs.existsSync(modulePath), 'нет src/main/profile-notice.cjs')
    const source = fs.readFileSync(modulePath, 'utf8')
    assert.equal(/require\(['"][^'"]*main(\.js)?['"]\)/.test(source), false,
      'модуль подключает main.js — обратная зависимость')
    assert.equal(/require\(['"]electron['"]\)/.test(source), false, 'модуль сам берёт Electron вместо аргументов')
  })

  check('на целом профиле окон нет', () => {
    const ctx = build()
    ctx.noticeKeyLoss()
    assert.deepEqual(ctx.calls, [], 'пугающее окно на ровном месте')
  })

  check('потерянный набор объясняется один раз, а не на каждый запрос', () => {
    const ctx = build({ integrity: () => ({ keyLost: ['conversations'], unreadable: ['conversations'], blocked: [] }) })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1, 'о потере ключа не сказано')
    const text = ctx.calls[0].message + ' ' + ctx.calls[0].detail
    assert.match(text, /не открыл/i, 'формулировка не про отказ чтения: ' + text.slice(0, 80))
    assert.match(text, /не изменены/i, 'не сказано, что байты на месте')
    assert.match(text, /\.key-lost-<дата>/, 'не сказано, куда уедут нечитаемые файлы')
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1, 'окно повторяется на каждый запрос')
  })

  check('два потерянных набора названы вместе', () => {
    const ctx = build({ integrity: () => ({ keyLost: [], unreadable: ['conversations', 'designs'], blocked: [] }) })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1)
    assert.match(ctx.calls[0].message, /Переписка и дизайны/, 'оба набора не названы: ' + ctx.calls[0].message)
  })

  // Общий аудит 01.11, Н1: карантин битого файла не имел ни окна, ни статуса.
  check('битый набор описан порчей файла, а не потерянным ключом', () => {
    const ctx = build({ integrity: () => ({ keyLost: [], unreadable: ['conversations'], corrupt: ['conversations'], blocked: [] }) })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1, 'о битом файле молчат')
    const text = ctx.calls[0].message + ' ' + ctx.calls[0].detail
    assert.match(text, /не разобрал/, 'причина названа потерянным ключом: ' + text.slice(0, 120))
    assert.match(text, /\.corrupt-/, 'не сказано, куда уехали байты')
    assert.equal(/не подошёл/.test(text), false, 'ложная причина про ключ осталась в тексте: ' + text.slice(0, 120))
  })

  check('обе беды названы каждая на своём месте', () => {
    const ctx = build({ integrity: () => ({ keyLost: [], unreadable: ['conversations', 'designs'], corrupt: ['designs'], blocked: [] }) })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1)
    assert.match(ctx.calls[0].message, /Переписка не открылись: ключ шифрования профиля не подошёл/, 'ключ не назван: ' + ctx.calls[0].message)
    assert.match(ctx.calls[0].message, /Дизайны не открылись: файл набора не разобрался/, 'порча не названа: ' + ctx.calls[0].message)
  })

  check('наборы, открывшиеся по очереди, получают каждый своё окно', () => {
    let lost = ['conversations']
    const ctx = build({ integrity: () => ({ keyLost: lost, unreadable: lost, blocked: [] }) })
    ctx.noticeKeyLoss()
    lost = ['conversations', 'designs']
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 2, 'второй набор промолчал из-за первого окна')
    assert.match(ctx.calls[1].message, /Дизайны/, 'второе окно не про дизайны')
  })

  check('bulkKeyLost смотрит unreadable: после архива причина не исчезает', () => {
    const ctx = build({ integrity: () => ({ keyLost: [], unreadable: ['conversations'], blocked: [] }) })
    assert.equal(ctx.bulkKeyLost('conversations'), true, 'архивированный набор считается живым')
    assert.equal(ctx.bulkKeyLost('designs'), false, 'чужой набор числится потерянным')
    const keyLostOnly = build({ integrity: () => ({ keyLost: ['designs'], unreadable: [], blocked: [] }) })
    assert.equal(keyLostOnly.bulkKeyLost('designs'), false, 'keyLost выдан за нечитаемое навсегда')
  })

  check('bulk спрашивают в момент окна, а не при создании модуля', () => {
    const ctx = build({ integrity: () => ({ keyLost: [], unreadable: ['conversations'], blocked: [] }) })
    assert.equal(ctx.bulkCalls(), 0, 'хранилище открыто на старте до первого вопроса')
    ctx.noticeKeyLoss()
    assert.ok(ctx.bulkCalls() >= 1, 'модуль не спросил целостность')
  })

  check('строки окна проходят через tr', () => {
    const seen = []
    const ctx = build({
      integrity: () => ({ keyLost: [], unreadable: ['conversations'], blocked: [] }),
      tr: (text, ...args) => { seen.push(String(text)); return String(text).replace(/%s/g, () => String(args.shift())) }
    })
    ctx.noticeKeyLoss()
    assert.ok(seen.some(text => text.includes('%s не открылись')), 'шаблон окна не переведён: ' + seen.join(' | '))
  })

  check('порядок наборов — порядок BULK_KEYS, а не алфавит', () => {
    const ctx = build({
      integrity: () => ({ keyLost: [], unreadable: ['designs', 'conversations'], blocked: [] }),
      bulkKeys: new Set(['conversations', 'designs'])
    })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1)
    assert.match(ctx.calls[0].message, /Переписка и дизайны/, 'порядок наборов подменён: ' + ctx.calls[0].message)
  })

  check('архив пишет один файл на ключ, атомарно и с записью в журнал', () => {
    const dir = mkDir()
    const ctx = build({ dir })
    assert.equal(ctx.archiveCorruptSettings('skills', { enc: 'safeStorage', data: 'QUJD' }), true, 'архив не записан')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'settings-corrupt')), ['skills.json'], 'файлов больше одного или остался .tmp')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings-corrupt', 'skills.json'), 'utf8')),
      { enc: 'safeStorage', data: 'QUJD' })
    assert.ok(ctx.log.some(text => text.includes('settings archived-corrupt skills')), 'архив не описан в журнале')
    // Повтор не перезаписывает уже отложенное.
    assert.equal(ctx.archiveCorruptSettings('skills', { enc: 'plain', data: 'bmV3' }), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings-corrupt', 'skills.json'), 'utf8')),
      { enc: 'safeStorage', data: 'QUJD' }, 'первый архив перезаписан')
  })

  check('архив называет секцию человеку, а не только журналу', () => {
    const dir = mkDir()
    const ctx = build({ dir })
    ctx.archiveCorruptSettings('skills', { enc: 'safeStorage', data: 'QUJD' })
    ctx.archiveCorruptSettings('mcpServers', { enc: 'safeStorage', data: 'QUJD' })
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1, 'об архиве секций человеку не сказали')
    const text = ctx.calls[0].message + ' ' + ctx.calls[0].detail
    assert.match(text, /Скиллы/, 'skills не названы')
    assert.match(text, /MCP/, 'mcpServers не названы')
    assert.match(text, /settings-corrupt/, 'не сказано, где лежит архив')
    assert.match(text, /не удаляйте/, 'не сказано, что архив трогать нельзя')
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1, 'окно об архиве повторяется')
  })

  check('незнакомая секция называется своим ключом, а не пропадает', () => {
    const dir = mkDir()
    const ctx = build({ dir })
    ctx.archiveCorruptSettings('projects', ['p1'])
    ctx.noticeKeyLoss()
    assert.equal(ctx.calls.length, 1)
    assert.match(ctx.calls[0].detail, /projects/, 'ключ секции потерян в тексте')
  })

  check('сбой архива описан в журнале, не бросает и не называет секцию', () => {
    const dir = mkDir()
    const broken = {
      existsSync: () => false,
      mkdirSync: () => { throw new Error('папка занята') },
      writeFileSync: () => {},
      renameSync: () => {}
    }
    const ctx = build({ dir, fs: broken })
    assert.equal(ctx.archiveCorruptSettings('skills', { enc: 'safeStorage', data: 'QUJD' }), false, 'сбой выдан за успех')
    assert.ok(ctx.log.some(text => text.includes('settings archive-failed skills')), 'сбой архива не описан')
    ctx.noticeKeyLoss()
    assert.deepEqual(ctx.calls, [], 'несохранённый архив назван человеку как отложенный')
  })

  // Аудиты 01.11: общий Н4 и новый Н3 — один корень, ранний выход до журнала,
  // до `archivedSettings.add` и до новых байтов.
  check('вторичная порча той же секции: новые байты на месте, окно говорит', () => {
    const dir = mkDir()
    const first = build({ dir })
    assert.equal(first.archiveCorruptSettings('skills', 'V1'), true)
    // Второй «запуск»: новый экземпляр модуля на том же диске.
    const second = build({ dir })
    assert.equal(second.archiveCorruptSettings('skills', 'V2'), true)
    const archiveDir = path.join(dir, 'settings-corrupt')
    const files = fs.readdirSync(archiveDir)
    assert.equal(files.length, 2, 'второй образец не дописан на диск: ' + files.join(', '))
    assert.ok(files.some(name => JSON.parse(fs.readFileSync(path.join(archiveDir, name), 'utf8')) === 'V2'),
      'новые байты потеряны безвозвратно')
    assert.ok(second.log.some(text => text.includes('archived-corrupt skills')), 'повторная порча не описана в журнале')
    second.noticeKeyLoss()
    assert.equal(second.calls.length, 1, 'со второго запуска диалог о секции молчит')
  })

  check('те же байты повторно не плодят архив, но окно говорит каждый запуск', () => {
    const dir = mkDir()
    const first = build({ dir })
    first.archiveCorruptSettings('skills', 'V1')
    const second = build({ dir })
    assert.equal(second.archiveCorruptSettings('skills', 'V1'), true)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'settings-corrupt')), ['skills.json'],
      'дубликат содержимого умножает файлы архива')
    second.noticeKeyLoss()
    assert.equal(second.calls.length, 1, 'секция по-прежнему не читается, а человеку молчат')
  })

  check('все строки окна — сообщение, детали, заметка об архиве и кнопка — идут через tr', () => {
    const dir = mkDir()
    const seen = []
    const ctx = build({
      dir,
      integrity: () => ({ keyLost: [], unreadable: ['conversations'], blocked: [] }),
      tr: (text, ...args) => { seen.push(String(text)); return String(text).replace(/%s/g, () => String(args.shift())) }
    })
    ctx.archiveCorruptSettings('skills', { enc: 'safeStorage', data: 'QUJD' })
    ctx.noticeKeyLoss()
    assert.ok(seen.some(text => /папка данных: %s/.test(text)), 'детали окна не переведены: ' + seen.join(' | '))
    assert.ok(seen.some(text => /Секции настроек \(%s\)/.test(text)), 'заметка об архиве не переведена')
    assert.ok(seen.some(text => /корруп|не разобрал/.test(text)) || seen.some(text => /ключ шифрования/.test(text)),
      'причина в деталях не проходит tr')
    assert.ok(seen.some(text => text === 'Понятно'), 'кнопка не переведена')
  })
} finally {
  for (const dir of dirs) {
    if (!failures.length) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
    else console.error('улики оставлены: ' + dir)
  }
}
console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
process.exit(failures.length ? 1 : 0)
