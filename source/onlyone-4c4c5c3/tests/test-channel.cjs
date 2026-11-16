// Каналы сборки: experimental (владелец, все версии) и stable (все остальные, без Pro и Ultra).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { channelOf, lockVersion, uiChannel, versionsEnabled } = require('../src/main/channel.cjs')

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

check('канал берётся из метаданных сборки; без них — experimental (исходники — рабочее место владельца)', () => {
  assert.equal(channelOf({ onlyoneChannel: 'stable' }), 'stable')
  assert.equal(channelOf({ onlyoneChannel: 'experimental' }), 'experimental')
  assert.equal(channelOf({}), 'experimental')
  assert.equal(channelOf(null), 'experimental')
  assert.equal(channelOf({ onlyoneChannel: 'что-то-ещё' }), 'experimental')
})
check('подменить канал переменной окружения можно только в проверке окна (ONECODE_E2E=1)', () => {
  assert.equal(channelOf({ onlyoneChannel: 'stable' }, { ONECODE_CHANNEL: 'experimental' }), 'stable', 'человек не должен вернуть Ultra переменной')
  assert.equal(channelOf({}, { ONECODE_CHANNEL: 'stable', ONECODE_E2E: '1' }), 'stable')
})
check('stable всегда Default: Pro и Ultra из прежнего профиля сбрасываются, остальное не трогается', () => {
  const config = { versionPreset: 'ultra', sidebarWidth: 240 }
  assert.deepEqual(lockVersion(config, 'stable'), { versionPreset: 'default', sidebarWidth: 240 })
  assert.deepEqual(lockVersion({ versionPreset: 'pro' }, 'stable'), { versionPreset: 'default' })
  assert.equal(lockVersion(config, 'experimental', { ONECODE_VERSIONS: '1', ONECODE_SMOKE: 'x' }), config, 'в проверке окна с включёнными версиями ничего не меняется')
  assert.equal(lockVersion(null, 'stable'), null)
  assert.equal(config.versionPreset, 'ultra', 'исходный объект не изменён')
})

function configFor(channel, feed) {
  const saved = process.env.ONECODE_CHANNEL
  const savedFeed = process.env.ONECODE_FEED_URL
  if (channel) process.env.ONECODE_CHANNEL = channel; else delete process.env.ONECODE_CHANNEL
  if (feed) process.env.ONECODE_FEED_URL = feed; else delete process.env.ONECODE_FEED_URL
  delete require.cache[require.resolve('../electron-builder.config.cjs')]
  const config = require('../electron-builder.config.cjs')
  if (saved === undefined) delete process.env.ONECODE_CHANNEL; else process.env.ONECODE_CHANNEL = saved
  if (savedFeed === undefined) delete process.env.ONECODE_FEED_URL; else process.env.ONECODE_FEED_URL = savedFeed
  delete require.cache[require.resolve('../electron-builder.config.cjs')]
  return config
}
check('сборка по умолчанию — stable: «просто собранное» не уйдёт другим с лишними версиями', () => {
  const config = configFor('')
  assert.equal(config.extraMetadata.onlyoneChannel, 'stable')
  assert.deepEqual(config.publish, [])
  assert.equal(configFor('stable', 'https://updates.example.com/').publish[0].channel, 'latest')
  assert.equal(config.nsis.artifactName, 'onlyone Setup ${version}.exe')
})
check('experimental: свой канал обновлений experimental.yml и свои имена файлов', () => {
  const config = configFor('experimental')
  assert.equal(config.extraMetadata.onlyoneChannel, 'experimental')
  assert.deepEqual(config.publish, [])
  assert.equal(configFor('experimental', 'https://updates.example.com/').publish[0].channel, 'experimental')
  assert.match(config.nsis.artifactName, /experimental/)
  assert.match(config.portable.artifactName, /experimental/)
})
check('в сборку входят общие модули (протокол удалённого управления) — иначе приложение не запустится', () => {
  assert.ok(configFor('stable').files.includes('src/shared/**/*'))
  assert.ok(fs.existsSync(path.join(__dirname, '../src/shared/remote-protocol.js')))
})
check('главный процесс закрывает версию в stable при чтении и записи конфигурации интерфейса', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.match(main, /lockVersion\(uiConfig\.load\(/)
  assert.match(main, /uiConfig\.save\(app\.getPath\('userData'\), lockVersion\(config, CHANNEL\)\)/)
})

check('Pro и Ultra выключены для людей в любом канале; включить можно только проверке окна (ONECODE_SMOKE)', () => {
  assert.equal(versionsEnabled({}), false)
  assert.equal(versionsEnabled({ ONECODE_VERSIONS: '1' }), false, 'одной переменной мало')
  assert.equal(versionsEnabled({ ONECODE_VERSIONS: '1', ONECODE_SMOKE: 'x' }), true)
  assert.deepEqual(lockVersion({ versionPreset: 'ultra', a: 1 }, 'experimental', {}), { versionPreset: 'default', a: 1 })
  assert.equal(uiChannel('experimental', {}), 'stable')
  assert.equal(uiChannel('experimental', { ONECODE_VERSIONS: '1', ONECODE_SMOKE: 'x' }), 'experimental')
})

if (failed) process.exit(1)
console.log('\nКаналы сборки: проверки пройдены')
