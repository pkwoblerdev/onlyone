// Сборка Windows нужного канала: node scripts/build-channel.cjs stable|experimental
//   stable       — для всех, кроме владельца: без версий Pro и Ultra; обновления из latest.yml;
//   experimental — для владельца: все версии; обновления из experimental.yml.
const { spawnSync } = require('node:child_process')
const channel = process.argv[2]
if (channel !== 'stable' && channel !== 'experimental') {
  console.error('Укажите канал: stable или experimental')
  process.exit(2)
}
const cli = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [cli, '--win', 'nsis', 'portable', '--x64', '--config', 'electron-builder.config.cjs'], {
  stdio: 'inherit', env: { ...process.env, ONECODE_CHANNEL: channel }
})
process.exit(result.status === null ? 1 : result.status)
