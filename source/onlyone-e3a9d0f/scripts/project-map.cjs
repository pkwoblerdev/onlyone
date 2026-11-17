#!/usr/bin/env node
// Собирает таблицы PROJECT-MAP.md (список модулей src/ и якоря в больших файлах) из самого кода.
//   node scripts/project-map.cjs           — переписать блок между маркерами MAP:BEGIN / MAP:END
//   node scripts/project-map.cjs --check   — ничего не писать; код 1, если карта разошлась с диском
// Описания модулей — в DESCRIPTIONS ниже: добавили файл в src/ — допишите строку, иначе `--check` (и
// tests/test-project-map.cjs) откажет. Якоря (ANCHORS) — имена функций, не номера строк: номера берутся из файла.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MAP = path.join(ROOT, 'PROJECT-MAP.md')
const BEGIN = '<!-- MAP:BEGIN (scripts/project-map.cjs) -->'
const END = '<!-- MAP:END -->'

// путь от корня → одна строка «что это». Для каталогов с однотипными файлами — запись на каталог: 'src/main/design/*'.
const DESCRIPTIONS = {
  'src/main/mods.cjs': 'Версионированные декларативные моды: проверка, разрешения, события, обновление и откат',
  'src/main/mods-store.cjs': 'Зашифрованное атомарное хранилище пакетов модов',
  'src/main/mods-ipc.cjs': 'Границы доступа модов: основное окно, Desk, проверка навыка',
  'src/main/mods-run.cjs': 'Явно выбранный навык мода в инструкциях и журнале хода',
  'src/renderer/mods-panels.js': 'Общие безопасные панели модов для Onlyone и Desk',
  'src/renderer/mods-ui.js': 'Установка модов с просмотром разрешений, панели и черновики задач',

  'src/main/desk-package.cjs': 'Перенос содержимого инструментов Desk, зависимостей и адаптация геометрии',
  'src/main/desk-observation.cjs': 'Согласованное наблюдение и ограниченные действия в собственном webview Desk',
  'src/main/desk-store.cjs': 'Защищённое хранилище Desk: safeStorage, атомарная запись и проверка восстановления',
  'src/main/desk-model.cjs': 'Модель Desk: ревизии, атомарные правки, ручное удержание блока и защита повторов',
  'src/main/desk-service.cjs': 'Отдельные окна Desk по чатам, проверка IPC и привязка ресурсов',
  'src/main/desk-process.cjs': 'Контролируемый запуск, вывод и остановка локальных процессов Desk',
  'src/main/desk-transfer.cjs': 'Версионированный шаблон раскладки Desk без исполнения и локальных ресурсов',
  'src/main/desk-tools.cjs': 'Схема инструмента desk_workspace для сборки окна агентом',
  'src/preload/desk.js': 'Ограниченный preload окна Desk без переписки и файлового API',
  'src/renderer/desk.html': 'Отдельное окно Desk без строки ввода',
  'src/renderer/desk.css': 'Свободный холст Desk на токенах приложения',
  'src/renderer/desk.js': 'Блоки браузера, интерфейса и результата; синхронизация с моделью Desk',
  'src/renderer/desk-transfer.js': 'Копирование, предпросмотр и добавление раскладки в Desk',
  // ── главный процесс: ядро ─────────────────────────────────────────────────────────────────────────────
  'src/main/plugins-ipc.cjs': 'Плагины: IPC, журнал действий, разрешения и откат версий',
  'src/renderer/plugins-page.js': 'Экран плагинов: список, права, журнал и действия',
  'src/renderer/plugins-page.css': 'Оформление экрана плагинов на токенах',
  'src/main/main.js': 'Главный процесс целиком: окно, IPC (≈140 каналов), хранилища, агентный цикл, инструменты, обновления',
  'src/main/channel.cjs': 'Канал сборки (stable/experimental) из package.json; флаг VERSIONS_ENABLED (Pro/Ultra выключены)',
  'src/main/ui-text.cjs': 'Тексты главного процесса для человека (RU/EN)',
  'src/main/latency-log.js': 'Журнал задержек запуска и настроек',
  'src/main/quit-guard.js': 'Сохранение несохранённой истории при выходе',
  'src/main/bulk-store.js': 'Большие наборы (переписка, дизайны) в своих файлах: кэш, ревизии, сброс при выходе',
  'src/main/profile-notice.cjs': 'Окно о потере ключа профиля и архив нечитаемых секций настроек (settings-corrupt)',
  'src/main/history-guard.js': 'Запись агента в переписку: дописывает её в устаревшее сохранение окна, пока окно не перечитало историю',
  // ── агент ─────────────────────────────────────────────────────────────────────────────────────────────
  'src/main/agent-board.js': 'Доска работы команды: пункты, права записи, замок приёмки',
  'src/main/agent-completion.js': 'Решение «ход закончен или нет»: признаки конца, обещания без действия',
  'src/main/agent-cycle.js': 'Порядок «исполнитель → проверка → доработка → итог»',
  'src/main/agent-quality.js': 'Общие правила качества для любого хода агента',
  'src/main/change-review.cjs': 'Обзор снимков файлов сессии, состояния конфликтов и ограниченный предпросмотр',
  'src/renderer/change-review.js': 'Обзор изменений чата и подтверждаемый выборочный откат файла',
  'src/renderer/change-review.css': 'Оформление обзора изменений сессии на токенах приложения',
  'src/main/run-model-observation.cjs': 'Учёт запрошенной/ответившей модели и исхода вспомогательных JSON-запросов без сохранения текста',
  'src/main/run-configuration-restore.cjs': 'Предпросмотр и атомарное восстановление модели/effort из архива с проверкой провайдера и состояния',
  'src/main/agent-run-context.js': 'Контекст одного хода пользователя: общий для ведущего, помощников и проверок',
  'src/main/agent-steering.cjs': 'Указания пользователя во время хода (очередь по requestId)',
  'src/main/agent-team.cjs': 'Размер команды и модели помощников по слову человека',
  'src/main/agent-shots.cjs': 'Снимок страницы в ходе мысли агента (JPEG, потолок размера)',
  'src/main/agent-browser.js': 'Изолированный браузер агента: ограды, SSRF-защита, browse_* инструменты',
  'src/main/agent-interact.js': 'Действия над открытой страницей: клик, ввод, секретные поля',
  'src/main/visible-browser.cjs': 'Распознавание «открой браузер» → страница в панели «Браузер»',
  'src/main/panel-browser.js': 'Ограды встроенного браузера панели превью',
  'src/main/web-fetch.js': 'fetch_url / чтение веб-страницы для агента (SSRF, лимиты)',
  'src/main/tool-protocol.cjs': 'Формат ответа инструмента: что модель узнаёт о последствиях вызова',
  'src/main/tool-runner.cjs': 'Запуск собственного инструмента агента в отдельном процессе',
  'src/main/tool-sandbox.cjs': 'Граница исполнения кода, написанного агентом',
  'src/main/tool-diet.cjs': 'Редкие группы инструментов не едут в каждом запросе',
  'src/main/context-diet.cjs': 'Сжатие истории провайдеру: старые результаты инструментов → заглушки (пороги 8k/2k)',
  'src/main/clock-note.cjs': 'Строка текущего времени (местное, UTC, граница 5-минутного окна) в хвосте запроса модели',
  'src/main/prior-digest.cjs': 'Краткая предыстория помощнику (≤1500 знаков) вместо полных отчётов',
  'src/main/project-lessons.cjs': 'Уроки проекта (АГ-4): источник, условия, статус; действует только включённый человеком, в промпт ≤1200 знаков',
  'src/renderer/project-lessons.js': 'Уроки на странице проекта: предложить, включить, исправить новой версией, отозвать с историей',
  'src/renderer/project-lessons.css': 'Оформление уроков проекта на токенах приложения',
  'src/main/session-tasks.cjs': 'Незакрытое переходит в следующее сообщение того же диалога',
  'src/main/resilience-guard.cjs': 'Защита от сбоев главного процесса: изоляция ошибок, зачистка процессов и барьер IPC-шквала',
  'src/main/repo-map.cjs': 'Карта символов проекта и инструмент find_symbol',
  'src/main/verification.cjs': 'Что считать проверкой результата; есть ли у проекта тесты',
  'src/main/loop-guard.cjs': 'Защита от зацикливания агента кодом',
  'src/main/edit-match.cjs': 'Точечная правка файла (edit_file): поиск фрагмента',
  'src/main/command-guard.js': 'Граница запуска команд агентом',
  'src/main/command-rules.cjs': 'Правила команд allow/ask/deny по маске',
  'src/main/command-runner.js': 'Исполнение команды: процесс, таймаут, снятие дерева, обрезка вывода',
  'src/main/workspace-search.js': 'Поиск по файлам рабочей папки (regex, потолок времени)',
  'src/main/workspace-search-worker.js': 'Точка входа worker-потока поиска',
  'src/main/search-service.js': 'Поиск по файлам в отдельном потоке (обвязка)',
  'src/main/workspace-store.js': 'Хранилище Workspace (Ultra): профиль и перенос в файл',
  'src/main/workspace-crate.js': 'Контейнер Workspace для шеринга',
  'src/main/run-checkpoints.js': 'Контрольные точки хода на диске (восстановление после перезапуска)',
  'src/main/task-state.cjs': 'Состояние задачи АГ-8: требования, доказательства, версии входов, действия с неизвестным исходом (в контрольной точке)',
  'src/main/task-budget.cjs': 'Общий бюджет задачи АГ-8: запросы, токены и время, резерв до запроса, отказ при исчерпании',
  'src/main/stream-join.js': 'Склейка потоковых кусков при повторе запроса',
  'src/main/fast-mode.js': 'Fast: приветствие и согласие не рассуждают на полную глубину',
  'src/main/next-suggestion.js': 'Подсказка следующего запроса',
  'src/main/chat-title.js': 'Название диалога моделью',
  'src/main/helper-model.cjs': 'Модель помощника по просьбе (assign_work.model)',
  'src/main/named-model.cjs': 'Модель, названная человеком в просьбе',
  'src/main/judge-model.cjs': 'Кто выносит приёмку',
  'src/main/decisions.cjs': 'Помощник по решениям (модели с выходом decisions)',
  'src/main/skill-packs.js': 'Скиллы как папки; ленивая загрузка',
  'src/main/skill-sources.js': 'Откуда берётся скилл: файл → инструкция (.md/.txt/.docx, свой разбор zip), проверка папки и .zip до импорта, скиллы проекта в .onlyone/skills',
  'src/main/work-guides.js': 'Авторские инструкции-справка для агента',
  'src/main/mcp-manager.js': 'MCP-серверы: stdio и Streamable HTTP, ошибки, права',
  'src/main/ui-config.js': 'Интерфейс как данные: предложения изменения интерфейса из чата',
  'src/main/ui-config.schema.json': 'Схема конфигурации интерфейса',
  'src/main/fork-proposal-tool.cjs': 'Инструмент propose_linked_chat: предложение связанного чата без создания и запуска',
  // ── артефакты, видео ──────────────────────────────────────────────────────────────────────────────────
  'src/main/artifacts.js': 'Артефакты чата: страница, картинка, таблица, график, код, дифф, видео',
  'src/main/artifact-capture.js': 'Снимок артефакта в PNG',
  'src/main/artifact-export.js': 'Выгрузка артефакта в файл',
  'src/main/ffmpeg-tools.js': 'ffmpeg под рукой у агента (установка по согласию)',
  'src/main/html-video.js': 'Ролик из HTML-страницы',
  'src/main/video-clock.js': 'Виртуальные часы страницы для покадрового рендера',
  'src/main/video-render.js': 'Разбор чужого ролика и рендер своего',
  // ── задачи, расписания ──────────────────────────────────────────────────────────────────────
  'src/main/task-manager.js': 'Планировщик фоновых задач (Центр задач): очередь, предел, перезапуск',
  'src/main/task-view.js': 'Прослойка Центра задач между планировщиком и окном',
  'src/main/schedule-model.js': 'Чистое ядро расписаний',
  'src/main/schedule-store.js': 'Хранилище расписаний (schedules.json)',
  'src/main/schedule-runner.js': 'Рантайм расписаний: пробуждение, пропуски, повтор',
  'src/main/schedule-queue.js': 'Расписание как производитель Центра задач',
  'src/main/schedule-ipc.js': 'IPC-каналы расписаний',
  // ── удалённое управление ──────────────────────────────────────────────────────────────────────────────
  'src/main/remote-control.js': 'Удалённое управление с телефона: ядро на стороне ПК',
  'src/shared/remote-link.js': 'Связь ПК и телефона через посредника (рукопожатие, шифрованный сеанс)',
  'src/shared/remote-pairing.js': 'Спаривание по коду (ABCDE-FGHJK)',
  'src/shared/remote-protocol.js': 'Общий протокол ПК ↔ телефон',
  // ── каталоги ──────────────────────────────────────────────────────────────────────────────────────────
  'src/main/design/*': 'Раздел «Дизайн»: хранилище макетов, задача из чата, инструменты, каркас сайта, снимок, экспорт, ZIP',
  'src/main/mode-prompts/*': 'Системные промпты режимов (agent, team, design, conversation, tools, shared, self-dev, artifacts)',
  'src/main/providers/*': 'Сетевые пути к модели: каталог, адаптеры, пул ключей, маска секретов',
  // ── прочее ────────────────────────────────────────────────────────────────────────────────────────────
  'src/preload/preload.js': 'Мост окна: электронный API (contextBridge) для renderer',
  'src/cli/onlyone.cjs': 'CLI `onlyone run "<просьба>" --folder …`: разбор входа, коды выхода, запускник',
  'src/cli/launcher.cjs': 'Запуск установленного CLI через встроенный runtime, вывод и остановка',
  'src/cli/session.cjs': 'Изолированный временный профиль CLI и проверка задания',
  'src/cli/turn-renderer.cjs': 'Скрипт окна для хода из CLI',
  // ── окно ──────────────────────────────────────────────────────────────────────────────────────────────
  'src/renderer/index.html': 'Разметка окна: все экраны и панели',
  'src/renderer/app.js': 'Окно целиком: чат, настройки, история, Design (потолок 12 100 строк — см. test-app-split)',
  'src/renderer/i18n.js': 'Английский словарь: ключ — русская строка',
  'src/renderer/index.css': 'Основные стили окна',
  'src/renderer/tokens.css': 'Токены дизайн-системы: цвета, линии, радиусы (тёмная/светлая темы)',
  'src/renderer/ui-system.css': 'Общие элементы интерфейса (дизайн-система)',
  'src/renderer/look.css': 'Вид по макету 19.10: компоненты и экраны макета поверх прежних классов (подключается последним)',
  'src/renderer/look-pages.css': 'Страницы разделов, окна и меню по макету 21.10 в области .mk (сгенерировано из CSS макета)',
  'src/renderer/design-gallery.js': 'Галерея «Дизайна» по макету 20.10: строка «что нарисовать», полка форматов листами, «Ваши дизайны» с живыми превью',
  'src/renderer/skills-page.js': 'Раздел «Скиллы» по макету 21.10: список, страница скилла (обзор, содержимое, правка), «Новый скилл» четырьмя способами',
  'src/renderer/projects-page.js': 'Раздел «Проекты» по макету 21.10: список, подробности, «Новый проект» формой на месте подробностей',
  'src/renderer/rules-drawer.js': 'Шторка правил проекта (инструкции, которые агент читает в начале чата): Проекты и шапка чата',
  'src/renderer/mk-kit.js': 'Общий набор страниц по макету: значки, строители разметки, состояние, пружины (window.OnlyoneMk)',
  'src/renderer/turn-state.js': 'Провал хода в ленте шаблоном состояния (макет 19.10): причина, что цело, одно главное действие',
  'src/renderer/ui-system.js': 'Общие DOM-поведения дизайн-системы',
  'src/renderer/fonts.css': 'Шрифты: Instrument Sans, Fira Code, Newsreader',
  'src/renderer/message-blocks.js': 'Блоки агентной ленты: ход, мысли, шаги, итог',
  'src/renderer/work-panel.js': 'Панель «Работа»: кто что делает сейчас',
  'src/renderer/run-configurations.js': 'Просмотр архива конфигураций запусков и сравнение модели, отпечатков, инструментов и навыков',
  'src/renderer/run-configurations.css': 'Экран просмотра и сравнения конфигураций запусков',
  'src/renderer/chat-forks.js': 'Ручной текстовый форк чата и связь с родителем',
  'src/renderer/chat-fork-preview.css': 'Окно предпросмотра форка на токенах дизайн-системы',
  'src/renderer/chat-fork-preview.js': 'Шаг предпросмотра ручного форка: название сессии, точка ответвления, что переносится',
  'src/renderer/fork-proposal.js': 'Предложение агентом связанного чата: проверка, устойчивый id операции, карточка, ровно один дочерний чат',
  'src/renderer/fork-proposal.css': 'Карточка предложения связанного чата на токенах дизайн-системы',
  'src/renderer/fork-proposal-store.js': 'Опись предложений связанного чата на чате-родителе: чтение, идемпотентная запись, статусы',
  'src/renderer/fork-proposal-context.js': 'Проверка родителя, границы истории и ревизии контекста предложения',
  'src/renderer/fork-proposal-restore.js': 'Восстановление карточек предложений после чтения сохранённой переписки',
  'src/renderer/fork-return.js': 'Возврат итога связанной задачи родителю: запись, карточка и ссылка на ребёнка',
  'src/renderer/chat-list.js': 'Список диалогов в боковике',
  'src/renderer/fork-tree-model.js': 'Дерево связанных чатов: родитель/дети из поля форка, петли, сироты, поиск с путём',
  'src/renderer/fork-tree-view.js': 'Дерево связанных чатов в боковике: строки, раскрытие, клавиатура, поиск',
  'src/renderer/fork-tree.css': 'Оформление дерева связанных чатов на токенах приложения',
  'src/main/budget-runtime.cjs': 'Обвязка общего бюджета вокруг запросов: резерв, списание, отказ до провайдера',
  'src/main/budget-settings.cjs': 'Настройки бюджета задачи: пределы, политика новой и текущей задачи',
  'src/main/review-sections.cjs': 'Участки обзора: файл, фрагмент и команда; снимок команды и выборочный откат',
  'src/renderer/review-sections.js': 'Окно участков изменений: файлы, правки и команды с выборочным откатом',
  'src/renderer/review-sections.css': 'Оформление окна участков изменений на токенах приложения',
  'src/renderer/budget-desk.js': 'Панель бюджета задачи в Desk: пределы, резервы, неизвестный расход и срок',
  'src/renderer/budget-desk.css': 'Оформление панели бюджета Desk на токенах',
  'src/renderer/composer-menu.js': 'Меню «+» и «/» над строкой ввода',
  'src/renderer/slash-commands.js': 'Команды «/» и директивы «.» (.plan .compact .diff .watch)',
  'src/renderer/model-popover.js': 'Выбор модели и глубины — выпадающие блоки у поля ввода',
  'src/renderer/send-controls.js': 'Управление отправкой хода',
  'src/renderer/token-tally.js': 'Счёт токенов хода по агентам: прогресс шагов и итог прогона без удвоения',
  'src/renderer/paste-tiles.js': 'Вставка: плитки вместо длинного текста',
  'src/renderer/context-menu.js': 'Общее контекстное меню',
  'src/renderer/select-widget.js': 'Свой выпадающий список',
  'src/renderer/artifact-panel.js': 'Панель артефактов чата',
  'src/renderer/browser-panel.js': 'Встроенный браузер в панели превью',
  'src/renderer/browser-model.js': 'Модель браузера: адресная строка, вкладки',
  'src/renderer/panel-adjust.js': 'Ширина и масштаб панели «Браузер / Превью»',
  'src/renderer/agent-browser-view.js': 'Живой вид браузера агента в панели «Работа»',
  'src/renderer/agent-run-history.js': 'Сериализация истории агента (чат и Design)',
  'src/renderer/tab-watch.js': 'Наблюдатель вкладки: страница изменилась — модель просыпается',
  'src/renderer/task-center.js': 'Центр задач: общий индекс задач',
  'src/renderer/schedules.js': 'Экран «Расписания»',
  'src/renderer/design-task-card.js': 'Карточка задачи Дизайна в ленте чата',
  'src/renderer/conversation-compression.js': 'Раскладка сжатия длинного разговора',
  'src/renderer/onboarding.js': 'Вступительный экран и выбор версии',
  'src/renderer/remote-bridge.js': 'Мост удалённого управления в окне',
  'src/renderer/remote-settings.js': 'Настройки → Удалённое управление',
  'src/renderer/remote-wiring.js': 'Проводка удалённого управления в окне',
  'src/renderer/video-settings.js': 'Настройки → Видео (ffmpeg)',
  'src/renderer/provider-groups.js': 'Провайдеры в настройках: группы',
  'src/renderer/ui-config-view.js': 'Показ предложения изменения интерфейса',
  'src/renderer/ui-catalog.js': 'Каталог образцов интерфейса (в сборку не входит)',
  'src/renderer/ui-catalog.html': 'Каталог образцов интерфейса (в сборку не входит)',
  'src/renderer/_preview.html': 'Служебный просмотр (в сборку не входит)',
  'src/renderer/dc-runtime.js': 'СГЕНЕРИРОВАНО: рантайм Design Components, не править руками',
  'src/renderer/ultra-shell.js': 'Оболочка Ultra (Pro/Ultra выключены, код цел)',
  'src/renderer/ultra-blocks.js': 'Свободные блоки результата Ultra',
  'src/renderer/ultra-intro.js': 'Представление Ultra',
  'src/renderer/ultra-workspace.js': 'Workspace Ultra в окне',
  'src/renderer/*.css': 'Стили по модулям (имя совпадает с именем .js: onboarding, task-center, model-popover…)'
}

// Якоря: функция → что в ней. Номер строки подставляется при генерации.
const ANCHORS = [
  ['src/main/main.js', 'createWindow', 'создание окна, флаги тестовых перехватчиков (ONECODE_SMOKE работает только в неупакованной сборке)'],
  ['src/main/main.js', 'buildSystemPrompt', 'сборка системного промпта хода'],
  ['src/main/main.js', 'readWithIdleTimeout', 'чтение потока ответа с ожиданием простоя'],
  ['src/main/main.js', 'streamAgentStep', 'один шаг цикла: запрос к модели, разбор потока, вызовы инструментов'],
  ['src/main/main.js', 'runAgentLoop', 'агентный цикл (обёртка)'],
  ['src/main/main.js', 'runAgentLoopSteps', 'агентный цикл по шагам: инструменты, приёмка, доработка'],
  ['src/main/main.js', 'clearTurnPlans', 'сброс чек-листов и состояния хода'],
  ['src/main/main.js', 'rememberOpenWork', 'запись незакрытого в session-tasks'],
  ['src/main/main.js', 'buildCarryoverBlock', 'блок «что осталось с прошлого сообщения» в хвост промпта'],
  ['src/main/main.js', 'autoShotForTurn', 'автоснимок страницы после browse_page/click/input'],
  ['src/main/main.js', 'searchWorkspaceFiles', 'инструмент поиска по файлам'],
  ['src/main/main.js', 'findSymbolTool', 'инструмент find_symbol (карта символов)'],
  ['src/main/main.js', 'turnReports', 'отчёты помощников за ход'],
  ['src/renderer/app.js', 'renderMessages', 'отрисовка ленты сообщений'],
  ['src/renderer/app.js', 'paintBlocks', 'отрисовка блоков агентной ленты'],
  ['src/renderer/app.js', 'applyAppearance', 'тема и вид: data-theme на <html>']
]

function listFiles (dir) {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) { if (!['vendor', 'fonts', 'assets', 'node_modules'].includes(entry.name)) out.push(...listFiles(rel)) } else out.push(rel)
  }
  return out
}

function describe (file) {
  if (DESCRIPTIONS[file]) return DESCRIPTIONS[file]
  const dir = file.replace(/\/[^/]+$/, '/*')
  if (DESCRIPTIONS[dir]) return DESCRIPTIONS[dir]
  if (/^src\/renderer\/[^/]+\.css$/.test(file)) return DESCRIPTIONS['src/renderer/*.css']
  return null
}

function lineNo (file, name) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const re = new RegExp('^\\s*(?:async\\s+)?function\\s+' + name + '\\b|^\\s*(?:const|let)\\s+' + name + '\\b', 'm')
  const match = re.exec(text)
  return match ? text.slice(0, match.index).split('\n').length : 0
}

function lines (file) { return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length }

function build () {
  const problems = []
  const files = ['src/main', 'src/shared', 'src/preload', 'src/cli', 'src/renderer'].flatMap(listFiles).sort()
  const rows = []
  const dirSeen = new Set()
  for (const file of files) {
    const desc = describe(file)
    if (!desc) { problems.push('нет описания в scripts/project-map.cjs: ' + file); continue }
    const dirKey = file.replace(/\/[^/]+$/, '/*')
    if (DESCRIPTIONS[dirKey] && !DESCRIPTIONS[file] && /^src\/main\/(design|mode-prompts|providers)\//.test(file)) {
      if (dirSeen.has(dirKey)) continue
      dirSeen.add(dirKey)
      const count = files.filter(f => f.startsWith(dirKey.slice(0, -1))).length
      rows.push(`| \`${dirKey}\` | ${count} файлов | ${desc} |`)
      continue
    }
    if (/^src\/renderer\/[^/]+\.css$/.test(file) && !DESCRIPTIONS[file]) continue
    rows.push(`| \`${file}\` | ${lines(file)} | ${desc} |`)
  }
  for (const key of Object.keys(DESCRIPTIONS)) {
    if (!key.includes('*') && !fs.existsSync(path.join(ROOT, key))) problems.push('описан, но файла нет: ' + key)
  }
  const anchors = ANCHORS.map(([file, name, what]) => {
    const line = lineNo(file, name)
    if (!line) problems.push(`якорь не найден: ${name} в ${file}`)
    return `| \`${file}\` | \`${name}\` | ${line || '?'} | ${what} |`
  })
  const body = [
    BEGIN,
    '',
    '### Модули `src/` (строк; назначение)',
    '',
    '| Файл | Строк | Что это |',
    '|---|---|---|',
    ...rows,
    '',
    '### Якоря в больших файлах (номер строки — на момент генерации; ищите по имени)',
    '',
    '| Файл | Имя | ≈строка | Что там |',
    '|---|---|---|---|',
    ...anchors,
    '',
    END
  ].join('\n')
  return { body, problems }
}

function main () {
  const check = process.argv.includes('--check')
  const { body, problems } = build()
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  const current = fs.existsSync(MAP) ? fs.readFileSync(MAP, 'utf8') : ''
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const text = current.replace(/\r\n/g, '\n')
  const i = text.indexOf(BEGIN); const j = text.indexOf(END)
  if (i < 0 || j < 0) { console.error('в PROJECT-MAP.md нет маркеров MAP:BEGIN / MAP:END'); process.exit(1) }
  // номера строк при проверке не сравниваем: они плывут с каждой правкой main.js
  const norm = s => s.replace(/\| \d+ \|/g, '| N |').replace(/\| ≈?\d+ \|/g, '| N |')
  const next = text.slice(0, i) + body + text.slice(j + END.length)
  if (check) {
    const same = norm(text.slice(i, j + END.length)) === norm(body)
    if (!same) { console.error('PROJECT-MAP.md разошёлся с диском: node scripts/project-map.cjs'); process.exit(1) }
    console.log('PROJECT-MAP.md в порядке')
    return
  }
  fs.writeFileSync(MAP, eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next)
  console.log('PROJECT-MAP.md обновлён: модулей ' + body.split('\n').filter(l => l.startsWith('| `src')).length)
}

if (require.main === module) main()
module.exports = { build, DESCRIPTIONS, ANCHORS }
