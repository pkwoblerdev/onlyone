# onlyone

onlyone is a desktop AI workspace for Windows, built with Electron. An agent works with your project files and
commands, browses the web, and connects to MCP servers; models come from the provider you choose. The interface is
available in Russian and English.

## Features

- Agent with file, command, search, browser and MCP tools, with approval modes for what it may do on its own.
- Agent team: several agents work on one task and hand results to each other.
- Design workspace: turns a request into UI mockups, previews them and exports them, including a ZIP handoff.
- Built-in browser panel and page watching for the agent.
- Schedules and a task center for background work.
- Remote control is unavailable in packaged builds until a trusted relay is configured and reviewed.
- Command line: `onlyone run "<request>" --folder <path> [--allow-write]`.
- Skills, mods, chat artifacts and video rendering (uses a local FFmpeg installation).

## Requirements

- Windows x64. The build targets are a per-user NSIS installer and a portable executable.
- For development: Node.js 22.12 or newer with npm. Installed Windows builds include their runtime.
- Optional: FFmpeg and ffprobe for video tools. They are not bundled; install them yourself
  (`winget install --id Gyan.FFmpeg -e`) or use the app's install action.
- Optional: Android SDK and JDK for the mobile client; a Node.js host for the relay.

## Getting started

```bash
git clone <repository-url>
cd onlyone
npm ci
npm run dev
```

`npm ci` installs from the committed `package-lock.json`. Use `npm install` only when you intentionally change
dependencies. `npm run dev` starts the app from source.

## Командная строка Windows

В обычном установщике включите «Добавить команду onlyone в PATH моего пользователя».
После установки откройте **новый** PowerShell или CMD. Отдельный Node.js не нужен.
Обновление сохраняет выбор, удаление приложения убирает его запись из пользовательского PATH.

```powershell
onlyone --version
onlyone --help
onlyone run "Объясни устройство проекта" --folder "D:\Projects\My app"
onlyone run "Добавь README с инструкцией запуска" --folder "D:\Projects\My app" --allow-write
```

Сначала откройте приложение и настройте провайдера и модель. CLI использует эти настройки;
обычный профиль — `%APPDATA%\onlyone`, при его отсутствии — `%APPDATA%\1code`.
Другой профиль можно выбрать через `--profile "путь"`.
CLI запускает один ход того же агентного ядра в скрытом окне с отдельным временным профилем:
исходные настройки и история открытого приложения не меняются, история чата в CLI не переносится.
Временные настройки удаляются после завершения; при аварийном выключении ПК очистка не гарантируется.

Без `--allow-write` изменения запрещены. Этот флаг разрешает обычные изменения, но не подтверждает
опасные действия автоматически. Интерактивные вопросы и дополнительные запросы разрешения
останавливают ход; для них используйте приложение. Долгоживущие фоновые процессы в CLI не запускаются.
`Ctrl+C` отменяет ход; предельное время одного запуска — 4 минуты.

Коды выхода: `0` — успех, `1` — ошибка выполнения, `2` — неверные аргументы или профиль,
`3` — отказ в изменении, `4` — отмена. Необязательный `--log "путь.jsonl"` сохраняет очищенный от ключей
ответ и код выхода; содержимое ответа может включать данные проекта.

Если команда не найдена, откройте новый терминал или запустите из каталога установки:

```powershell
& "C:\Apps\onlyone\resources\cli\onlyone.cmd" --help
```

Portable EXE не регистрирует CLI в PATH. Для установки команды используйте обычный установщик.
Для разработки: `node src/cli/onlyone.cjs --help`, `npm run test:installed-cli`,
`npm run test:cli-ui`; после сборки — `npm run test:cli-package -- "путь к win-unpacked"`.


## Providers and keys

Add a provider in **Settings → Providers and keys** and paste the API key there. Credentials are stored in the
local profile; operating-system protection is used where available. Do not assume that logs, backups and exports
are encrypted. Never commit keys or paste them into issues. Compatible remote and local endpoints can be added.

## Where data lives

The profile is `%APPDATA%\onlyone`. An existing `%APPDATA%\1code` profile can be migrated on first launch.
Settings, history, designs, checkpoints, schedules, credentials and diagnostics may be stored on the device.
Some stored data uses operating-system protection; logs, backups, exports and metadata may be unencrypted. Back up
the profile and project files before deleting them.

The application can contact selected model endpoints, MCP servers and websites. Prompt context and relevant
project content may be sent to those services. Automatic updates and the packaged remote relay are disabled in
this candidate; a manually configured update feed can receive network requests. See the [privacy draft](docs/PRIVACY.md).

## Tests

```bash
npm test                     # full suite; allow 40–60 minutes on Windows
node tests/test-<name>.cjs   # one headless test
node tests/run-smoke.cjs     # opens a real Electron window and runs screen checks
```

The UI tests open real Electron windows, so run them in an interactive Windows desktop session. A new
`tests/test-*.cjs` or `tests/run-*.cjs` file must be added to `package.json`, otherwise `npm test` fails. This
repository has no CI configuration; run the suite locally.

## Validate a public source export

`scripts/export-public.cjs` exports committed files and writes a separate SHA-256 manifest. Keep that export
pristine; install dependencies and run tests in a separate copy. Use `--internal-docs=public` to exclude local
agent instructions. Export integrity does not establish that secrets or third-party rights have been cleared.

An archive has no Git history. In its validation copy, initialize a new repository with an empty initial commit,
then import the files as a second commit. Use your own Git identity:

```bash
git init
git commit --allow-empty -m "Initialize public history"
git add --force .
git commit -m "Import sources"
npm ci
npm run test:public-record -- --checkout . --manifest ../source.manifest.json --out ../test-evidence
```

The declared `tests/eol-base.json` value `public-root` selects that initial commit without private release refs.
Import only the pristine export before installing dependencies; `--force` retains source files covered by nested
ignore rules. The runner requires Git to track exactly the files in the export manifest.
A missing/invalid base or a single-commit history is refused; committed, staged and working changes are checked.
Clones of the resulting two-commit repository can run `npm ci` followed by `npm test` directly. Mobile shared
files are prepared automatically by `pretest`.

The fixed runner executes `npm test`, records source and log hashes and refuses changes during the run.
`scripts/verify-public-readiness.cjs` checks that record against the pristine export and manifest. This is local
evidence consistency, not authenticated execution or permission to publish. Licensing and secret review remain
separate release decisions.

## Build

```bash
npm run build:win:stable         # NSIS installer and portable exe in release/
npm run build:win:experimental   # the same for the experimental channel
```

The first build downloads Electron and electron-builder artifacts. `release/` is not tracked by git.

## Repository layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: window, IPC, agent loop, tools, storage, updates |
| `src/preload/` | Context bridge between main process and UI |
| `src/renderer/` | UI: HTML, CSS and JavaScript, no bundler |
| `src/shared/` | Code shared by the desktop app and the mobile client |
| `src/cli/` | `onlyone run` command line |
| `mobile/` | Capacitor Android client |
| `server/relay/` | WebSocket relay for remote control |
| `tests/` | Test suite: headless tests and Electron window tests |
| `scripts/`, `tools/`, `build/`, `resources/` | Build scripts, icon tools, installer snippets, icons |

## Contributing, security and legal

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, tests and rules the suite enforces.
- [SECURITY.md](SECURITY.md) — security reporting status.
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — third-party components and open-source licenses.
- [NOTICE](NOTICE) — copyright notice (`onlyone.labs`, `onlyone.dev`, `pkwoblerdev` / `pkwobler.dev`).
- [docs/EULA.md](docs/EULA.md) — draft usage and licensing information.
- [docs/PRIVACY.md](docs/PRIVACY.md) — draft privacy information and data flows.
- [docs/TERMS.md](docs/TERMS.md) — terms of use and responsible execution boundaries.
- [docs/CLI.md](docs/CLI.md) — command line reference.
- [docs/os/USER-GUIDE.md](docs/os/USER-GUIDE.md) — plugins: install, capabilities, journal, rollback and the isolation boundary.

## Contacts

A verified support and private security contact has not yet been established.

## License

Source code is licensed under the Apache License, Version 2.0 where applicable. See [LICENSE](LICENSE), [NOTICE](NOTICE) and the third-party notices. Binary distribution terms are not final.
