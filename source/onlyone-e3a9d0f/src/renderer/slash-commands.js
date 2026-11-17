/* Команды «/» и директивы разработчика «.» в строке ввода. Список вынесен из app.js: у него нулевой запас строк.
 * «.sandbox» здесь нет и не будет без изоляции на уровне ОС: имя обещало бы защиту, которой нет.
 * Всё, чем команды управляют, приходит из окна через deps; сам модуль ничего не знает про его устройство.
 * Директива (directive: true) получает остаток строки в action(rest) и сама решает, что с ним делать: модели он не уходит. */
(function (root) {
  'use strict'

  // «/» открывает меню всегда; «.» — только пока введены точка и буквы без пробела, иначе обычный текст («.5 примеров»).
  const wantsMenu = text => /^\//.test(String(text || '')) || /^\.[a-z]*$/i.test(String(text || ''))
  const startsCommand = text => /^[\/.]/.test(String(text || ''))

  // Меню «/» показывает команды, меню «.» — директивы: смешивать их незачем.
  function match (list, query) {
    const q = String(query || '').toLowerCase()
    if (!q) return []
    return list.filter(item => item.cmd[0] === q[0] &&
      (item.cmd.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)))
  }

  function create (deps) {
    const t = deps.t || (text => text)
    const say = text => deps.showToast(t(text))

    // .plan — режим «только чтение»: агент ничего не меняет, а предлагает план. Идемпотентна: меню вставляет команду и
    // сразу выполняет её, а затем Enter выполнит снова — повтор не должен переключать обратно.
    let previousPermission = null
    function plan (rest) {
      const off = /^(off|выкл|нет)$/i.test(String(rest || '').trim())
      const now = deps.permission()
      if (off) {
        if (now !== 'plan') { say('Режим плана не был включён'); return }
        deps.selectPermission(previousPermission && previousPermission !== 'plan' ? previousPermission : 'acceptEdits')
        previousPermission = null
        say('Режим плана выключен')
        return
      }
      if (now === 'plan') return
      previousPermission = now
      deps.selectPermission('plan')
      say('Режим плана: агент только читает и предлагает план. «.plan off» вернёт прежний режим')
    }

    // .compact — следующее сообщение уйдёт со сжатой историей (начало разговора сворачивается в сводку).
    function compact () {
      deps.forceCompactNext()
      say('Следующее сообщение пойдёт со сжатой историей: начало разговора свернётся в сводку')
    }

    // .diff — блок правок последнего ответа раскрывается и показывается; откат — штатной кнопкой «Отменить» под ответом.
    function diff () {
      if (typeof deps.openChangesReview === 'function') { void deps.openChangesReview(); return }
      const blocks = Array.from(deps.changeBlocks() || [])
      if (!blocks.length) { say('В этом диалоге ещё нет правок файлов'); return }
      const last = blocks[blocks.length - 1]
      last.open = true
      last.scrollIntoView({ block: 'center', behavior: 'smooth' })
      say('Правки последнего ответа раскрыты. Вернуть файлы — «Отменить» в строке действий под ответом')
    }

    // .sections — файлы, отдельные правки и выполненные команды; откат по выбору.
    function sections () {
      if (typeof deps.openSectionsReview === 'function') { void deps.openSectionsReview(); return }
      say('Участки изменений доступны в основном окне')
    }

    // .watch — просьба агенту поставить тихое слежение за страницей (инструмент watch_page). За файлами слежения нет.
    function watch (rest) {
      const target = String(rest || '').trim()
      if (!target) { say('Укажите адрес страницы: .watch http://localhost:3000'); return }
      if (!/^https?:\/\/\S+$/i.test(target)) { say('Слежение работает за страницами (адрес http…); за файлами пока нельзя'); return }
      deps.send('Поставь тихое фоновое слежение за страницей ' + target + ' (инструмент watch_page) и сообщи, когда на ней что-то изменится.')
    }

    const commands = [
      { cmd: '/desk', label: 'Открыть Onlyone Desk', desc: 'Отдельное окно рабочей среды этого чата', action: () => deps.openDesk() },
      { cmd: '/mods', label: 'Моды', desc: 'Панели и черновики задач модов этого чата', action: () => (typeof deps.openMods === 'function' ? deps.openMods() : document.getElementById('mainMods')?.click()) },
      {
        cmd: '/agent',
        label: 'Агент-режим',
        desc: 'Командная работа: ведущий делит задачу между помощниками. Модель помощника можно назвать в просьбе: «второго поставь на GLM 5.3»',
        prompt: 'Агент-режим: разбери задачу на части, раздай их помощникам через assign_work и сам проверь результат. Если я назвал модель для помощника — укажи её в поле model этого помощника.'
      },
      {
        cmd: '/remote-control',
        label: 'Показать чат на телефоне',
        desc: 'Включить и выключить доступ к этому чату с телефона. Работает, если в настройках включено «Удалённое управление»',
        action: () => deps.toggleRemoteForChat()
      },
      {
        cmd: '/self',
        label: 'Улучшить сам onlyone',
        desc: 'Направить агента на исходники этого приложения. Только по вашей просьбе — ошибка здесь ломает окно, в котором вы работаете',
        action: () => deps.toggleSelfDevelopment()
      },
      {
        cmd: '/effort',
        label: 'Глубина рассуждений',
        desc: 'Открыть настройку глубины рассуждений модели',
        // Глубина — блок у кнопки рядом с полем ввода; окна-каталога больше нет.
        action: () => deps.openEffort()
      },
      {
        cmd: '/review',
        label: 'Code Review',
        desc: 'Комплексный аудит качества, стиля и чистоты кода проекта',
        prompt: 'Проведи детальный Code Review проекта. Проанализируй архитектуру, чистоту кода, паттерны проектирования и обработку ошибок. Выдели ключевые замечания и предложи конкретные улучшения в формате до/после.'
      },
      {
        cmd: '/security',
        label: 'Security Review',
        desc: 'Аудит безопасности, поиск уязвимостей и утечек секретов/ключей',
        prompt: 'Проведи полный аудит безопасности (Security Review). Проверь код на: 1) утечки секретов/токенов/ключей, 2) инъекции (SQL/Command/XSS), 3) небезопасную десериализацию и обработку файлов, 4) уязвимые зависимости и настройки разрешений. Предоставь отчет с уровнями критичности (High/Medium/Low) и рекомендациями по устранению.'
      },
      {
        cmd: '/refactor',
        label: 'Рефакторинг',
        desc: 'Оптимизация структуры, устранение дублирования (DRY) и модульность',
        prompt: 'Предложи план рефакторинга для оптимизации производительности, устранения дублирования кода (DRY), декомпозиции монолитных компонентов и улучшения модульности.'
      },
      {
        cmd: '/docs',
        label: 'Документация',
        desc: 'Генерация README, API спецификаций и пояснений к коду',
        prompt: 'Сгенерируй исчерпывающую техническую документацию: описание архитектуры, API спецификации, типы данных, структуру каталогов и подробные инструкции по установке и запуску в README.md.'
      },
      {
        cmd: '/tests',
        label: 'Тестирование',
        desc: 'Создание unit-тестов, integration тестов и граничных кейсов',
        prompt: 'Напиши набор unit-тестов и интеграционных тестов для покрытия критической функциональности проекта с учетом граничных случаев и обработки ошибок.'
      },
      {
        cmd: '/fix',
        label: 'Поиск багов',
        desc: 'Диагностика ошибок, утечек памяти и исправление дефектов',
        prompt: 'Проанализируй проект на наличие логических багов, утечек памяти, необработанных исключений и предложи точные исправления.'
      },
      {
        cmd: '/explain',
        label: 'Объяснить код',
        desc: 'Разбор устройства алгоритма или архитектуры проекта',
        prompt: 'Объясни устройство, архитектуру и логику работы компонентов этого проекта простым и понятным языком с примерами потоков данных.'
      },
      {
        cmd: '/skills',
        label: 'Skills',
        desc: 'Открыть управление скиллами и специализациями',
        action: () => deps.openSkills()
      },
      {
        cmd: '/clear',
        label: 'Очистить чат',
        desc: 'Очистить историю текущего диалога',
        action: () => deps.clearChat()
      },
      {
        cmd: '/models',
        label: 'Каталог моделей',
        desc: 'Открыть список всех моделей: листать и искать можно в нём',
        action: () => deps.openModels()
      },
      {
        cmd: '/settings',
        label: 'Настройки',
        desc: 'Открыть окно настроек и ключей API',
        action: () => deps.openSettings()
      }
  
    ]

    const directives = [
      { cmd: '.plan', directive: true, label: 'План без правок', desc: 'Агент только читает и предлагает план. «.plan off» — вернуть прежний режим', action: plan },
      { cmd: '.compact', directive: true, label: 'Сжать историю', desc: 'Следующее сообщение пойдёт со сжатым началом разговора', action: compact },
      { cmd: '.diff', directive: true, label: 'Изменения сессии', desc: 'Все доступные изменения файлов этого чата и выборочный откат', action: diff },
      { cmd: '.sections', directive: true, label: 'Участки изменений', desc: 'Файлы, отдельные правки и команды этого чата с выборочным откатом', action: sections },
      { cmd: '.watch', directive: true, label: 'Следить за страницей', desc: '.watch <адрес> — тихое слежение за страницей', action: watch }
    ]

    return commands.concat(directives)
  }

  const api = { create, match, wantsMenu, startsCommand }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneSlashCommands = api
})(typeof window !== 'undefined' ? window : globalThis)
