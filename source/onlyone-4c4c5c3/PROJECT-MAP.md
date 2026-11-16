# Карта проекта onlyone

Для агентов и людей: где что лежит и куда идти за задачей. Блок между маркерами внизу собирается из кода
(`node scripts/project-map.cjs`), проверяется `tests/test-project-map.cjs` в `pretest`. Правила работы — [CONTRIBUTING.md](CONTRIBUTING.md).

**Что это.** onlyone — настольное Electron-приложение (Windows): агент с инструментами и подключаемыми моделями,
команда агентов, Дизайн, встроенный браузер, расписания, удалённое управление с телефона.
Папка данных — `%APPDATA%\onlyone`; старая `%APPDATA%\1code` переносится при первом запуске. Версия — `package.json`; каналы `stable` и `experimental`.

## Быстрый поиск: задача → где смотреть

| Что нужно | Куда идти |
|---|---|
| Агентный цикл, шаги, вызовы инструментов | `src/main/main.js`: `runAgentLoopSteps`, `streamAgentStep` (якоря ниже) |
| Системный промпт режима | `src/main/mode-prompts/*`, сборка — `buildSystemPrompt` в `main.js` |
| Список и описания инструментов агента | `src/main/mode-prompts/tools.js`, диета — `src/main/tool-diet.cjs`; исполнение — `main.js` (ищите имя инструмента строкой) |
| Расход токенов, сжатие истории | `src/main/context-diet.cjs`, `prior-digest.cjs`, `tool-diet.cjs`; замеры — `tests/measure-diet.cjs`, `measure-prompt-cost.cjs` |
| Приёмка хода, «готово/не готово», замок доски | `agent-completion.js`, `agent-board.js`, `verification.cjs`, `judge-model.cjs` |
| Команда агентов, помощники, указания во время хода | `agent-team.cjs`, `agent-board.js`, `helper-model.cjs`, `named-model.cjs`, `agent-steering.cjs` |
| Браузер агента (вне окна) / встроенный браузер панели | `agent-browser.js`, `agent-interact.js`, `visible-browser.cjs` / `panel-browser.js`, `renderer/browser-panel.js` |
| Провайдеры, ключи, пул ключей | `src/main/providers/*` (каталог путей, пул, маска секретов) |
| Чат: лента, блоки хода, панель «Работа» | `renderer/message-blocks.js`, `work-panel.js`, `app.js` (`renderMessages`, `paintBlocks`) |
| Строка ввода, команды «/» и «.», выбор модели | `renderer/composer-menu.js`, `slash-commands.js`, `model-popover.js`, `send-controls.js` |
| Дизайн-система: цвета, линии, радиусы, темы | `renderer/tokens.css` (тёмная/светлая), `ui-system.css`, `index.css`; шрифты — `fonts.css` |
| Раздел «Дизайн» (макеты) | `src/main/design/*`, `renderer/design-task-card.js`, режим — `mode-prompts/design.js` |
| Артефакты (страница, график, видео…) | `src/main/artifacts.js`, `renderer/artifact-panel.js`; видео — `ffmpeg-tools.js`, `html-video.js`, `video-render.js` |
| Расписания и Центр задач | `schedule-*.js`, `task-manager.js`, `task-view.js`; окно — `schedules.js`, `task-center.js` |
| Удалённое управление, телефон | `src/main/remote-control.js`, `src/shared/remote-*.js`, `renderer/remote-*.js`; приложение — `mobile/`; посредник — `server/relay/` |
| CLI `onlyone run`, установка команды в PATH | `src/cli/`, `resources/cli/`, `build/installer.nsh`; `npm run test:installed-cli`, `test:cli-ui`, `test:cli-package` |
| Каналы сборки, Pro/Ultra | `src/main/channel.cjs`, `scripts/build-channel.cjs`, `electron-builder.config.cjs` |
| Вступление, настройки, обновления | `renderer/onboarding.js`; настройки и обновления — `app.js` и `main.js` (ищите `autoUpdate`) |
| Переводы | `renderer/i18n.js` (ключ — русская строка), тексты главного — `ui-text.cjs` |

## Процессы и каталоги

- `src/main/` — главный процесс (Node/Electron): `main.js` — ядро, остальное — модули с одной темой. Расширение `.cjs` — модуль,
  который грузят тесты в песочнице: у него нет Electron и файловой системы без `deps`.
- `src/preload/preload.js` — мост окна (`electronAPI`); `src/renderer/` — окно (HTML/CSS/JS без сборщика, `app.js` — одним файлом);
  `src/shared/` — код, общий для ПК и телефона; `src/cli/` — командная строка.
- `mobile/` — Android-приложение (Capacitor): `www/` — страницы, `sync.cjs` копирует общие модули, `android/` — проект Gradle.
- `server/relay/` — посредник удалённого управления (служба `onlyone-relay` на сервере).
- `scripts/` — сборка каналов, удаление worktree, проверка упаковки; `tools/` — иконки; `build/` — вставки установщика.
- `tests/` — 526 элементов: `test-*.cjs` (347, без окна), `run-*.cjs` (102, настоящее окно Electron), `*-renderer.js` (38, скрипты, которые
  `run-*` выполняют внутри окна), `measure-*`, `stress-*`, `live-*` (вручную, вне `npm test`), `retired/` — тесты снятых модулей.
- `archive/` — снятые модули (`chat-context`, `page-watch`); `resources/` — значки; `release/` — сборки (не в git).

## Данные на диске (`%APPDATA%\onlyone`)

Старая папка `%APPDATA%\1code` при первом запуске переносится целиком, поэтому имена файлов внутри остались прежними.

`1code-settings.json` (настройки, ключи — зашифрованы `safeStorage`; `Local State` нужен для расшифровки), `data/` (переписка, дизайны),
`artifacts/`, `designs/`, `runs/` (журналы и контрольные точки ходов), `pasted/`, `archive/`, `logs/`, `schedules.json`, `tasks.json`,
`session-tasks.json`, `remote-control.json`, `ultra-layout.json`, `workspace.json`. Резервные копии настроек лежат рядом (`*.bak`).
Установленная копия — каталог, выбранный при установке (по умолчанию `%LOCALAPPDATA%\Programs\onlyone`); в ней `resources\app.asar` читать только через `require('@electron/asar')`.

## Проверки

| Команда | Что делает |
|---|---|
| `npm test` | `pretest` (гигиена набора, порядок строк, словари, карта проекта) + `test` (все `test-*`, смоук окна) + `posttest`; ≈15 минут, код выхода — единственный судья |
| `node tests/test-<имя>.cjs` | одна проверка без окна — основной рабочий режим |
| `node tests/run-smoke.cjs` | запуск настоящего окна и 255 проверок экрана (после правок верха `main.js` и `app.js` — сразу) |
| `node tests/run-<имя>-ui.cjs` | оконная проверка одного экрана |
| `node tests/audit-design.cjs [папка] [сцены…]` | снимки и замеры вида: шрифты, наложения, обрезка (рецепт — ниже) |
| `ONECODE_APP=<app.asar> node tests/live-free-suite.cjs <модель:free>` | живой прогон на бесплатной модели (в упакованном exe тестовые перехватчики выключены) |
| `npm run bench:agent [-- --scenario id] [--repeat N]` | стенд качества агентной работы: семь сценариев (в т.ч. защищённые задачи браузера, документа и Desk) через настоящий цикл, ответы — сценарный провайдер, JSON-отчёт; `--mode live --model … --profile …` — только явным запуском (см. `scripts/quality-bench/README.md`, `LIVE-BASELINE.md`) |
| `npm run bench:aa -- --runs N --out <новый каталог>` | повторы A/A одной конфигурации и сводка разброса `aa-summary.json`; два прогона — лишь начальная оценка шума |
| `node tests/run-android-device.cjs <apk>` | APK на эмуляторе (`onlyone_test`) со стендом удалённого управления |

Тестовые перехватчики окна: `ONECODE_SMOKE` (скрипт окна), `ONECODE_SHOT`, `ONECODE_PROVIDER_FILE` (подставной провайдер),
`ONECODE_E2E`; работают только при `!app.isPackaged`. Любой новый файл `tests/test-*.cjs` или `run-*.cjs` обязан быть вписан в
`package.json` (иначе `test-suite-hygiene` откажет).

## Сборка и выпуск

`npm run build:win:stable`, затем `npm run build:win:experimental` (→ `release/`), выкладка на сервер
(канал обновлений сейчас не задан; при настройке будущего канала бинарники публикуются первыми, yml последними), проверка скачиванием по
sha512. Выпуск и удаление файлов на сервере — вручную и только по явному решению. APK: `cd mobile && node sync.cjs && npx cap sync android`,
затем `gradlew assembleDebug`.

## Ловушки (повторяются)

- **Окончания строк.** Файлы смешанные (`app.js` — CRLF с отдельными LF-строками): правьте только нужные строки, не нормализуйте;
  `tests/test-line-ending-churn.cjs` краснеет, если дифф содержит строки, изменённые только окончанием. Скрипты правки пишите файлом (в Bash-heredoc
  теряются обратные косые черты).
- **Песочницы тестов.** Тесты вырезают куски `main.js` и подают им явный список зависимостей: новое имя в вырезаемом месте надо добавить заглушкой в таких
  тестах (`test-agent-turn`, `test-dispatch-runtime`, `test-prompt-routes`, `test-known-risks`…) — полный прогон по одному ловит это сразу.
- **Потолок `app.js` — 12 100 строк** (`test-app-split`): новый код — в модуль `src/renderer/*.js`.
- **`git stash` общий для всех рабочих деревьев**; `git merge`/`package.json` вручную теряет ключи `test:*` — после слияния прогоните `test-suite-hygiene`.
- **Pro и Ultra выключены** (`VERSIONS_ENABLED=false` в `channel.cjs`); код оболочек цел, тесты Ultra — `npm run test:ultra`.
- **Данные не покидают ПК**, кроме выбранного провайдера и фида обновлений; телеметрии нет (`test-no-phone-home`).

## Где план и история

Планы, отчёты и старые аудиты в репозитории не хранятся: история — в `git log`.

## Таблицы, собираемые из кода

<!-- MAP:BEGIN (scripts/project-map.cjs) -->

### Модули `src/` (строк; назначение)

| Файл | Строк | Что это |
|---|---|---|
| `src/cli/launcher.cjs` | 83 | Запуск установленного CLI через встроенный runtime, вывод и остановка |
| `src/cli/onlyone.cjs` | 311 | CLI `onlyone run "<просьба>" --folder …`: разбор входа, коды выхода, запускник |
| `src/cli/session.cjs` | 82 | Изолированный временный профиль CLI и проверка задания |
| `src/cli/turn-renderer.cjs` | 99 | Скрипт окна для хода из CLI |
| `src/main/agent-board.js` | 625 | Доска работы команды: пункты, права записи, замок приёмки |
| `src/main/agent-browser.js` | 457 | Изолированный браузер агента: ограды, SSRF-защита, browse_* инструменты |
| `src/main/agent-completion.js` | 337 | Решение «ход закончен или нет»: признаки конца, обещания без действия |
| `src/main/agent-cycle.js` | 329 | Порядок «исполнитель → проверка → доработка → итог» |
| `src/main/agent-interact.js` | 583 | Действия над открытой страницей: клик, ввод, секретные поля |
| `src/main/agent-quality.js` | 77 | Общие правила качества для любого хода агента |
| `src/main/agent-run-context.js` | 202 | Контекст одного хода пользователя: общий для ведущего, помощников и проверок |
| `src/main/agent-shots.cjs` | 52 | Снимок страницы в ходе мысли агента (JPEG, потолок размера) |
| `src/main/agent-steering.cjs` | 52 | Указания пользователя во время хода (очередь по requestId) |
| `src/main/agent-team.cjs` | 28 | Размер команды и модели помощников по слову человека |
| `src/main/artifact-capture.js` | 89 | Снимок артефакта в PNG |
| `src/main/artifact-export.js` | 270 | Выгрузка артефакта в файл |
| `src/main/artifacts.js` | 507 | Артефакты чата: страница, картинка, таблица, график, код, дифф, видео |
| `src/main/budget-runtime.cjs` | 310 | Обвязка общего бюджета вокруг запросов: резерв, списание, отказ до провайдера |
| `src/main/budget-settings.cjs` | 176 | Настройки бюджета задачи: пределы, политика новой и текущей задачи |
| `src/main/bulk-store.js` | 343 | Большие наборы (переписка, дизайны) в своих файлах: кэш, ревизии, сброс при выходе |
| `src/main/change-review.cjs` | 88 | Обзор снимков файлов сессии, состояния конфликтов и ограниченный предпросмотр |
| `src/main/channel.cjs` | 40 | Канал сборки (stable/experimental) из package.json; флаг VERSIONS_ENABLED (Pro/Ultra выключены) |
| `src/main/chat-title.js` | 43 | Название диалога моделью |
| `src/main/clock-note.cjs` | 28 | Строка текущего времени (местное, UTC, граница 5-минутного окна) в хвосте запроса модели |
| `src/main/command-guard.js` | 152 | Граница запуска команд агентом |
| `src/main/command-rules.cjs` | 125 | Правила команд allow/ask/deny по маске |
| `src/main/command-runner.js` | 401 | Исполнение команды: процесс, таймаут, снятие дерева, обрезка вывода |
| `src/main/context-diet.cjs` | 180 | Сжатие истории провайдеру: старые результаты инструментов → заглушки (пороги 8k/2k) |
| `src/main/decisions.cjs` | 130 | Помощник по решениям (модели с выходом decisions) |
| `src/main/design/*` | 15 файлов | Раздел «Дизайн»: хранилище макетов, задача из чата, инструменты, каркас сайта, снимок, экспорт, ZIP |
| `src/main/desk-model.cjs` | 123 | Модель Desk: ревизии, атомарные правки, ручное удержание блока и защита повторов |
| `src/main/desk-observation.cjs` | 146 | Согласованное наблюдение и ограниченные действия в собственном webview Desk |
| `src/main/desk-package.cjs` | 71 | Перенос содержимого инструментов Desk, зависимостей и адаптация геометрии |
| `src/main/desk-process.cjs` | 154 | Контролируемый запуск, вывод и остановка локальных процессов Desk |
| `src/main/desk-service.cjs` | 594 | Отдельные окна Desk по чатам, проверка IPC и привязка ресурсов |
| `src/main/desk-store.cjs` | 66 | Защищённое хранилище Desk: safeStorage, атомарная запись и проверка восстановления |
| `src/main/desk-tools.cjs` | 35 | Схема инструмента desk_workspace для сборки окна агентом |
| `src/main/desk-transfer.cjs` | 52 | Версионированный шаблон раскладки Desk без исполнения и локальных ресурсов |
| `src/main/edit-match.cjs` | 152 | Точечная правка файла (edit_file): поиск фрагмента |
| `src/main/fast-mode.js` | 25 | Fast: приветствие и согласие не рассуждают на полную глубину |
| `src/main/ffmpeg-tools.js` | 333 | ffmpeg под рукой у агента (установка по согласию) |
| `src/main/fork-proposal-tool.cjs` | 70 | Инструмент propose_linked_chat: предложение связанного чата без создания и запуска |
| `src/main/helper-model.cjs` | 29 | Модель помощника по просьбе (assign_work.model) |
| `src/main/history-guard.js` | 141 | Запись агента в переписку: дописывает её в устаревшее сохранение окна, пока окно не перечитало историю |
| `src/main/html-video.js` | 192 | Ролик из HTML-страницы |
| `src/main/judge-model.cjs` | 20 | Кто выносит приёмку |
| `src/main/latency-log.js` | 89 | Журнал задержек запуска и настроек |
| `src/main/loop-guard.cjs` | 83 | Защита от зацикливания агента кодом |
| `src/main/main.js` | 15522 | Главный процесс целиком: окно, IPC (≈140 каналов), хранилища, агентный цикл, инструменты, обновления |
| `src/main/mcp-manager.js` | 320 | MCP-серверы: stdio и Streamable HTTP, ошибки, права |
| `src/main/mode-prompts/*` | 9 файлов | Системные промпты режимов (agent, team, design, conversation, tools, shared, self-dev, artifacts) |
| `src/main/mods-ipc.cjs` | 62 | Границы доступа модов: основное окно, Desk, проверка навыка |
| `src/main/mods-run.cjs` | 17 | Явно выбранный навык мода в инструкциях и журнале хода |
| `src/main/mods-store.cjs` | 43 | Зашифрованное атомарное хранилище пакетов модов |
| `src/main/mods.cjs` | 283 | Версионированные декларативные моды: проверка, разрешения, события, обновление и откат |
| `src/main/named-model.cjs` | 64 | Модель, названная человеком в просьбе |
| `src/main/next-suggestion.js` | 40 | Подсказка следующего запроса |
| `src/main/panel-browser.js` | 199 | Ограды встроенного браузера панели превью |
| `src/main/plugins-ipc.cjs` | 228 | Плагины: IPC, журнал действий, разрешения и откат версий |
| `src/main/prior-digest.cjs` | 71 | Краткая предыстория помощнику (≤1500 знаков) вместо полных отчётов |
| `src/main/profile-notice.cjs` | 123 | Окно о потере ключа профиля и архив нечитаемых секций настроек (settings-corrupt) |
| `src/main/project-lessons.cjs` | 284 | Уроки проекта (АГ-4): источник, условия, статус; действует только включённый человеком, в промпт ≤1200 знаков |
| `src/main/providers/*` | 6 файлов | Сетевые пути к модели: каталог, адаптеры, пул ключей, маска секретов |
| `src/main/quit-guard.js` | 27 | Сохранение несохранённой истории при выходе |
| `src/main/remote-control.js` | 273 | Удалённое управление с телефона: ядро на стороне ПК |
| `src/main/repo-map.cjs` | 164 | Карта символов проекта и инструмент find_symbol |
| `src/main/resilience-guard.cjs` | 182 | Защита от сбоев главного процесса: изоляция ошибок, зачистка процессов и барьер IPC-шквала |
| `src/main/review-sections.cjs` | 825 | Участки обзора: файл, фрагмент и команда; снимок команды и выборочный откат |
| `src/main/run-checkpoints.js` | 980 | Контрольные точки хода на диске (восстановление после перезапуска) |
| `src/main/run-configuration-restore.cjs` | 62 | Предпросмотр и атомарное восстановление модели/effort из архива с проверкой провайдера и состояния |
| `src/main/run-model-observation.cjs` | 18 | Учёт запрошенной/ответившей модели и исхода вспомогательных JSON-запросов без сохранения текста |
| `src/main/schedule-ipc.js` | 169 | IPC-каналы расписаний |
| `src/main/schedule-model.js` | 506 | Чистое ядро расписаний |
| `src/main/schedule-queue.js` | 124 | Расписание как производитель Центра задач |
| `src/main/schedule-runner.js` | 477 | Рантайм расписаний: пробуждение, пропуски, повтор |
| `src/main/schedule-store.js` | 255 | Хранилище расписаний (schedules.json) |
| `src/main/search-service.js` | 112 | Поиск по файлам в отдельном потоке (обвязка) |
| `src/main/session-tasks.cjs` | 156 | Незакрытое переходит в следующее сообщение того же диалога |
| `src/main/skill-packs.js` | 189 | Скиллы как папки; ленивая загрузка |
| `src/main/skill-sources.js` | 248 | Откуда берётся скилл: файл → инструкция (.md/.txt/.docx, свой разбор zip), проверка папки и .zip до импорта, скиллы проекта в .onlyone/skills |
| `src/main/stream-join.js` | 12 | Склейка потоковых кусков при повторе запроса |
| `src/main/task-budget.cjs` | 558 | Общий бюджет задачи АГ-8: запросы, токены и время, резерв до запроса, отказ при исчерпании |
| `src/main/task-manager.js` | 432 | Планировщик фоновых задач (Центр задач): очередь, предел, перезапуск |
| `src/main/task-state.cjs` | 526 | Состояние задачи АГ-8: требования, доказательства, версии входов, действия с неизвестным исходом (в контрольной точке) |
| `src/main/task-view.js` | 106 | Прослойка Центра задач между планировщиком и окном |
| `src/main/tool-diet.cjs` | 83 | Редкие группы инструментов не едут в каждом запросе |
| `src/main/tool-protocol.cjs` | 355 | Формат ответа инструмента: что модель узнаёт о последствиях вызова |
| `src/main/tool-runner.cjs` | 137 | Запуск собственного инструмента агента в отдельном процессе |
| `src/main/tool-sandbox.cjs` | 255 | Граница исполнения кода, написанного агентом |
| `src/main/ui-config.js` | 352 | Интерфейс как данные: предложения изменения интерфейса из чата |
| `src/main/ui-config.schema.json` | 76 | Схема конфигурации интерфейса |
| `src/main/ui-text.cjs` | 62 | Тексты главного процесса для человека (RU/EN) |
| `src/main/verification.cjs` | 41 | Что считать проверкой результата; есть ли у проекта тесты |
| `src/main/video-clock.js` | 89 | Виртуальные часы страницы для покадрового рендера |
| `src/main/video-render.js` | 327 | Разбор чужого ролика и рендер своего |
| `src/main/visible-browser.cjs` | 15 | Распознавание «открой браузер» → страница в панели «Браузер» |
| `src/main/web-fetch.js` | 809 | fetch_url / чтение веб-страницы для агента (SSRF, лимиты) |
| `src/main/work-guides.js` | 94 | Авторские инструкции-справка для агента |
| `src/main/workspace-crate.js` | 283 | Контейнер Workspace для шеринга |
| `src/main/workspace-search-worker.js` | 26 | Точка входа worker-потока поиска |
| `src/main/workspace-search.js` | 688 | Поиск по файлам рабочей папки (regex, потолок времени) |
| `src/main/workspace-store.js` | 203 | Хранилище Workspace (Ultra): профиль и перенос в файл |
| `src/preload/desk.js` | 42 | Ограниченный preload окна Desk без переписки и файлового API |
| `src/preload/preload.js` | 369 | Мост окна: электронный API (contextBridge) для renderer |
| `src/renderer/_preview.html` | 141 | Служебный просмотр (в сборку не входит) |
| `src/renderer/agent-browser-view.js` | 413 | Живой вид браузера агента в панели «Работа» |
| `src/renderer/agent-run-history.js` | 44 | Сериализация истории агента (чат и Design) |
| `src/renderer/app.js` | 11286 | Окно целиком: чат, настройки, история, Design (потолок 12 100 строк — см. test-app-split) |
| `src/renderer/artifact-panel.js` | 782 | Панель артефактов чата |
| `src/renderer/browser-model.js` | 131 | Модель браузера: адресная строка, вкладки |
| `src/renderer/browser-panel.js` | 548 | Встроенный браузер в панели превью |
| `src/renderer/budget-desk.css` | 20 | Оформление панели бюджета Desk на токенах |
| `src/renderer/budget-desk.js` | 231 | Панель бюджета задачи в Desk: пределы, резервы, неизвестный расход и срок |
| `src/renderer/change-review.css` | 14 | Оформление обзора изменений сессии на токенах приложения |
| `src/renderer/change-review.js` | 101 | Обзор изменений чата и подтверждаемый выборочный откат файла |
| `src/renderer/chat-fork-preview.css` | 7 | Окно предпросмотра форка на токенах дизайн-системы |
| `src/renderer/chat-fork-preview.js` | 75 | Шаг предпросмотра ручного форка: название сессии, точка ответвления, что переносится |
| `src/renderer/chat-forks.js` | 29 | Ручной текстовый форк чата и связь с родителем |
| `src/renderer/chat-list.js` | 346 | Список диалогов в боковике |
| `src/renderer/composer-menu.js` | 358 | Меню «+» и «/» над строкой ввода |
| `src/renderer/context-menu.js` | 118 | Общее контекстное меню |
| `src/renderer/conversation-compression.js` | 78 | Раскладка сжатия длинного разговора |
| `src/renderer/dc-runtime.js` | 1915 | СГЕНЕРИРОВАНО: рантайм Design Components, не править руками |
| `src/renderer/design-gallery.js` | 142 | Галерея «Дизайна» по макету 20.10: строка «что нарисовать», полка форматов листами, «Ваши дизайны» с живыми превью |
| `src/renderer/design-task-card.js` | 559 | Карточка задачи Дизайна в ленте чата |
| `src/renderer/desk-transfer.js` | 200 | Копирование, предпросмотр и добавление раскладки в Desk |
| `src/renderer/desk.css` | 244 | Свободный холст Desk на токенах приложения |
| `src/renderer/desk.html` | 104 | Отдельное окно Desk без строки ввода |
| `src/renderer/desk.js` | 997 | Блоки браузера, интерфейса и результата; синхронизация с моделью Desk |
| `src/renderer/fonts.css` | 245 | Шрифты: Instrument Sans, Fira Code, Newsreader |
| `src/renderer/fork-proposal-context.js` | 77 | Проверка родителя, границы истории и ревизии контекста предложения |
| `src/renderer/fork-proposal-restore.js` | 114 | Восстановление карточек предложений после чтения сохранённой переписки |
| `src/renderer/fork-proposal-store.js` | 278 | Опись предложений связанного чата на чате-родителе: чтение, идемпотентная запись, статусы |
| `src/renderer/fork-proposal.css` | 238 | Карточка предложения связанного чата на токенах дизайн-системы |
| `src/renderer/fork-proposal.js` | 702 | Предложение агентом связанного чата: проверка, устойчивый id операции, карточка, ровно один дочерний чат |
| `src/renderer/fork-return.js` | 153 | Возврат итога связанной задачи родителю: запись, карточка и ссылка на ребёнка |
| `src/renderer/fork-tree-model.js` | 254 | Дерево связанных чатов: родитель/дети из поля форка, петли, сироты, поиск с путём |
| `src/renderer/fork-tree-view.js` | 363 | Дерево связанных чатов в боковике: строки, раскрытие, клавиатура, поиск |
| `src/renderer/fork-tree.css` | 150 | Оформление дерева связанных чатов на токенах приложения |
| `src/renderer/i18n.js` | 3088 | Английский словарь: ключ — русская строка |
| `src/renderer/index.css` | 9464 | Основные стили окна |
| `src/renderer/index.html` | 1348 | Разметка окна: все экраны и панели |
| `src/renderer/look-pages.css` | 1151 | Страницы разделов, окна и меню по макету 21.10 в области .mk (сгенерировано из CSS макета) |
| `src/renderer/look.css` | 703 | Вид по макету 19.10: компоненты и экраны макета поверх прежних классов (подключается последним) |
| `src/renderer/message-blocks.js` | 1644 | Блоки агентной ленты: ход, мысли, шаги, итог |
| `src/renderer/mk-kit.js` | 179 | Общий набор страниц по макету: значки, строители разметки, состояние, пружины (window.OnlyoneMk) |
| `src/renderer/model-popover.js` | 221 | Выбор модели и глубины — выпадающие блоки у поля ввода |
| `src/renderer/mods-panels.js` | 78 | Общие безопасные панели модов для Onlyone и Desk |
| `src/renderer/mods-ui.js` | 178 | Установка модов с просмотром разрешений, панели и черновики задач |
| `src/renderer/onboarding.js` | 934 | Вступительный экран и выбор версии |
| `src/renderer/panel-adjust.js` | 99 | Ширина и масштаб панели «Браузер / Превью» |
| `src/renderer/paste-tiles.js` | 85 | Вставка: плитки вместо длинного текста |
| `src/renderer/plugins-page.css` | 56 | Оформление экрана плагинов на токенах |
| `src/renderer/plugins-page.js` | 239 | Экран плагинов: список, права, журнал и действия |
| `src/renderer/project-lessons.css` | 15 | Оформление уроков проекта на токенах приложения |
| `src/renderer/project-lessons.js` | 217 | Уроки на странице проекта: предложить, включить, исправить новой версией, отозвать с историей |
| `src/renderer/projects-page.js` | 350 | Раздел «Проекты» по макету 21.10: список, подробности, «Новый проект» формой на месте подробностей |
| `src/renderer/provider-groups.js` | 45 | Провайдеры в настройках: группы |
| `src/renderer/remote-bridge.js` | 211 | Мост удалённого управления в окне |
| `src/renderer/remote-settings.js` | 120 | Настройки → Удалённое управление |
| `src/renderer/remote-wiring.js` | 38 | Проводка удалённого управления в окне |
| `src/renderer/review-sections.css` | 29 | Оформление окна участков изменений на токенах приложения |
| `src/renderer/review-sections.js` | 263 | Окно участков изменений: файлы, правки и команды с выборочным откатом |
| `src/renderer/rules-drawer.js` | 95 | Шторка правил проекта (инструкции, которые агент читает в начале чата): Проекты и шапка чата |
| `src/renderer/run-configurations.css` | 22 | Экран просмотра и сравнения конфигураций запусков |
| `src/renderer/run-configurations.js` | 199 | Просмотр архива конфигураций запусков и сравнение модели, отпечатков, инструментов и навыков |
| `src/renderer/schedules.js` | 299 | Экран «Расписания» |
| `src/renderer/select-widget.js` | 99 | Свой выпадающий список |
| `src/renderer/send-controls.js` | 261 | Управление отправкой хода |
| `src/renderer/skills-page.js` | 604 | Раздел «Скиллы» по макету 21.10: список, страница скилла (обзор, содержимое, правка), «Новый скилл» четырьмя способами |
| `src/renderer/slash-commands.js` | 186 | Команды «/» и директивы «.» (.plan .compact .diff .watch) |
| `src/renderer/tab-watch.js` | 183 | Наблюдатель вкладки: страница изменилась — модель просыпается |
| `src/renderer/task-center.js` | 543 | Центр задач: общий индекс задач |
| `src/renderer/token-tally.js` | 44 | Счёт токенов хода по агентам: прогресс шагов и итог прогона без удвоения |
| `src/renderer/tokens.css` | 498 | Токены дизайн-системы: цвета, линии, радиусы (тёмная/светлая темы) |
| `src/renderer/turn-state.js` | 161 | Провал хода в ленте шаблоном состояния (макет 19.10): причина, что цело, одно главное действие |
| `src/renderer/ui-catalog.html` | 109 | Каталог образцов интерфейса (в сборку не входит) |
| `src/renderer/ui-catalog.js` | 8 | Каталог образцов интерфейса (в сборку не входит) |
| `src/renderer/ui-config-view.js` | 97 | Показ предложения изменения интерфейса |
| `src/renderer/ui-system.css` | 90 | Общие элементы интерфейса (дизайн-система) |
| `src/renderer/ui-system.js` | 338 | Общие DOM-поведения дизайн-системы |
| `src/renderer/ultra-blocks.js` | 657 | Свободные блоки результата Ultra |
| `src/renderer/ultra-intro.js` | 492 | Представление Ultra |
| `src/renderer/ultra-shell.js` | 869 | Оболочка Ultra (Pro/Ultra выключены, код цел) |
| `src/renderer/ultra-workspace.js` | 150 | Workspace Ultra в окне |
| `src/renderer/video-settings.js` | 65 | Настройки → Видео (ffmpeg) |
| `src/renderer/work-panel.js` | 1025 | Панель «Работа»: кто что делает сейчас |
| `src/shared/remote-link.js` | 240 | Связь ПК и телефона через посредника (рукопожатие, шифрованный сеанс) |
| `src/shared/remote-pairing.js` | 141 | Спаривание по коду (ABCDE-FGHJK) |
| `src/shared/remote-protocol.js` | 217 | Общий протокол ПК ↔ телефон |

### Якоря в больших файлах (номер строки — на момент генерации; ищите по имени)

| Файл | Имя | ≈строка | Что там |
|---|---|---|---|
| `src/main/main.js` | `createWindow` | 11866 | создание окна, флаги тестовых перехватчиков (ONECODE_SMOKE работает только в неупакованной сборке) |
| `src/main/main.js` | `buildSystemPrompt` | 7704 | сборка системного промпта хода |
| `src/main/main.js` | `readWithIdleTimeout` | 10091 | чтение потока ответа с ожиданием простоя |
| `src/main/main.js` | `streamAgentStep` | 10134 | один шаг цикла: запрос к модели, разбор потока, вызовы инструментов |
| `src/main/main.js` | `runAgentLoop` | 10433 | агентный цикл (обёртка) |
| `src/main/main.js` | `runAgentLoopSteps` | 10437 | агентный цикл по шагам: инструменты, приёмка, доработка |
| `src/main/main.js` | `clearTurnPlans` | 5436 | сброс чек-листов и состояния хода |
| `src/main/main.js` | `rememberOpenWork` | 5451 | запись незакрытого в session-tasks |
| `src/main/main.js` | `buildCarryoverBlock` | 5463 | блок «что осталось с прошлого сообщения» в хвост промпта |
| `src/main/main.js` | `autoShotForTurn` | 5893 | автоснимок страницы после browse_page/click/input |
| `src/main/main.js` | `searchWorkspaceFiles` | 5079 | инструмент поиска по файлам |
| `src/main/main.js` | `findSymbolTool` | 5112 | инструмент find_symbol (карта символов) |
| `src/main/main.js` | `turnReports` | 8352 | отчёты помощников за ход |
| `src/renderer/app.js` | `renderMessages` | 3967 | отрисовка ленты сообщений |
| `src/renderer/app.js` | `paintBlocks` | 4923 | отрисовка блоков агентной ленты |
| `src/renderer/app.js` | `applyAppearance` | 6855 | тема и вид: data-theme на <html> |

<!-- MAP:END -->
