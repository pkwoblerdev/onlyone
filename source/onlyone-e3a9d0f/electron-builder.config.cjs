// Канал сборки: stable — для всех, кроме владельца (без версий Pro и Ultra), experimental — только для владельца.
// Сборка выбирает канал переменной ONECODE_CHANNEL (scripts/build-channel.cjs); по умолчанию — stable, чтобы сборка
// «просто так» никогда не ушла другим людям с лишними версиями.
const CHANNEL = process.env.ONECODE_CHANNEL === 'experimental' ? 'experimental' : 'stable'
const experimental = CHANNEL === 'experimental'

module.exports = {
  productName: 'onlyone',
  appId: 'com.onecode.workspace',
  copyright: 'Copyright © 2026 onlyone',
  directories: {
    output: 'release'
  },
  // Приложение узнаёт канал из своего package.json (src/main/channel.cjs).
  // name — от него electron-builder называет папку загрузок обновления (onlyone-updater вместо 1code-updater).
  extraMetadata: { onlyoneChannel: CHANNEL, name: 'onlyone' },
  extraResources: [
    { from: 'src/cli', to: 'cli', filter: ['*.cjs'] },
    { from: 'resources/cli', to: 'cli', filter: ['*.cmd', '*.ps1'] },
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'NOTICE', to: 'NOTICE' },
    { from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
    { from: 'LICENSES', to: 'LICENSES' }
  ],
  files: [
    'src/main/**/*',
    'src/cli/**/*',
    'src/preload/**/*',
    'src/renderer/**/*',
    // Общие модули компьютера и телефона (протокол удалённого управления): их зовёт главный процесс.
    'src/shared/**/*',
    'tools/plugin/**/*',
    'tools/sandbox/**/*',
    // A page of sample markup for eyeballing the chat styles against the design
    // handoff. It lives next to the stylesheet so it picks up the real one; it
    // has no business in the shipped app.
    '!src/renderer/_preview.html',
    // Страница образцов дизайн-системы (план, пункт 1.2) — инструмент
    // разработки: её проверяет tests/run-ui-system.cjs из исходников.
    '!src/renderer/ui-catalog.*',
    'package.json'
  ],
  // Fail packaging if electron-builder omitted any production dependency from
  // app.asar. This catches shared/corrupted node_modules before a broken
  // update can be published.
  afterPack: require('./scripts/verify-packaged-runtime-dependencies.cjs'),
  asar: true,
  // Фьюзы Electron (разбор REA 25.10): готовый onlyone.exe не должен становиться
  // чужим Node. Отладчик (`--inspect`) и NODE_OPTIONS выключены; код грузится
  // только из app.asar, а app.asar сверяется с хэшем, вшитым в exe при сборке,
  // так что подменённый архив не запустится. Куки шифруются средствами системы.
  //
  // runAsNode остаётся включённым сознательно: «свои инструменты» агента
  // (runCustomTool в main.js) запускаются как `onlyone.exe` + ELECTRON_RUN_AS_NODE
  // под моделью прав Node (`--permission`). utilityProcess эти флаги не
  // соблюдает (проверено 25.10: запись вне разрешённой папки прошла), то есть
  // переезд туда ослабил бы песочницу инструментов, а не усилил.
  //
  // grantFileProtocolExtraPrivileges тоже остаётся: окно грузится с file://.
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  },
  // Emits latest.yml next to the installer — without it electron-updater has
  // nothing to read. The URL here is only a default baked into the build; the
  // app reads its real feed from settings, so this can be repointed later
  // without a rebuild.
  publish: process.env.ONECODE_FEED_URL ? [{
    provider: 'generic',
    url: process.env.ONECODE_FEED_URL,
    channel: experimental ? 'experimental' : 'latest'
  }] : (experimental ? [] : [{ provider: 'github', owner: 'pkwoblerdev', repo: 'onlyone' }]),
  win: {
    icon: 'resources/1code.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] }
    ]
  },
  nsis: {
    artifactName: experimental ? 'onlyone-experimental-Setup-${version}.exe' : 'onlyone-Setup-${version}.exe',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'onlyone',
    guid: '4EB839B2-2DAB-4DA7-9E3B-F2E884BBD9A1',
    include: 'build/installer.nsh',
    installerIcon: 'resources/1code.ico',
    uninstallerIcon: 'resources/1code.ico'
  },
  portable: {
    artifactName: experimental ? 'onlyone-experimental-${version}-portable.exe' : 'onlyone-${version}-portable.exe'
  }
}
