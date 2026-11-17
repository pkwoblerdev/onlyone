// Канал сборки onlyone. experimental — сборка владельца: все версии окна (Default, Pro, Ultra), обновления из
// experimental.yml. stable — для всех остальных и тестеров: только Default, без выбора версии, обновления из latest.yml.
//
// Канал вшивается при сборке в package.json приложения (extraMetadata.onlyoneChannel, см. electron-builder.config.cjs).
// Запуск из исходников — это работа владельца, поэтому по умолчанию experimental. Для проверок окна канал можно
// подменить переменной ONECODE_CHANNEL, но только вместе с ONECODE_E2E=1: человек подменить его не может.
function channelOf(meta, env = {}) {
  if (env.ONECODE_E2E === '1' && (env.ONECODE_CHANNEL === 'stable' || env.ONECODE_CHANNEL === 'experimental')) return env.ONECODE_CHANNEL
  return meta && meta.onlyoneChannel === 'stable' ? 'stable' : 'experimental'
}

function currentChannel() {
  let meta = null
  try { meta = require('../../package.json') } catch { /* без package.json — исходники */ }
  return channelOf(meta, process.env)
}

// С 11.10.2026 Pro и Ultra выключены во всех каналах: упор на основную версию. Код оболочек остаётся, включить их
// обратно — поменять VERSIONS_ENABLED. Проверки окна включают их переменной ONECODE_VERSIONS=1, но только вместе
// с ONECODE_SMOKE (человек запускает приложение без неё).
const VERSIONS_ENABLED = false

function versionsEnabled(env = process.env) {
  return VERSIONS_ENABLED || (env.ONECODE_VERSIONS === '1' && Boolean(env.ONECODE_SMOKE))
}

// Канал, каким его видит окно: пока версий нет, окно ведёт себя как stable (без выбора версии и шага вступления).
function uiChannel(channel, env = process.env) {
  return versionsEnabled(env) ? channel : 'stable'
}

// Когда версий нет (или канал stable), версия окна всегда Default: Pro и Ultra не показываются и не включаются,
// даже если профиль помнит Ultra из прежней сборки.
function lockVersion(config, channel, env = process.env) {
  if ((channel !== 'stable' && versionsEnabled(env)) || !config || typeof config !== 'object') return config
  return config.versionPreset && config.versionPreset !== 'default' ? { ...config, versionPreset: 'default' } : config
}

module.exports = { channelOf, currentChannel, lockVersion, uiChannel, versionsEnabled }
