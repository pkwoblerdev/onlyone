# onlyone

**onlyone** is a Windows workspace for working on software with AI. Open a project, give an agent a task, and review the files and commands involved in its work.

[Русская версия](#русский) · [Contributing](docs/CONTRIBUTING.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [License](LICENSE)

## What you can do

- Work with an agent in a project folder and review its changes.
- Use the Design workspace to work on interfaces and previews.
- Run supported tasks from the Windows command line; see the [CLI guide](docs/CLI.md).
- Connect configured external AI services and MCP tools.
- Work in Russian or English and choose a light or dark theme.

Available capabilities depend on the selected service, permissions and settings. External services can have separate requirements, limits and charges.

## Download

Installers and portable builds, when published, appear in [Releases](https://github.com/pkwoblerdev/onlyone/releases). The executable files are uploaded separately and are not included in the Git source tree.

Version 1.3.38 is a release candidate. Its Windows builds are unsigned. The [release status](docs/RELEASE-STATUS.md) records the checks completed and the remaining limitations, including clean Windows installation testing. Automatic update checks and the packaged remote-control relay are disabled in this candidate.

## Run from source

On Windows, install Node.js and npm, then run from the repository root:

```powershell
cd source/onlyone-4c4c5c3
npm ci
npm run dev
```

To run the test suite from the same directory, use `npm test`. Some checks open application windows and may require a suitable Windows environment. A skipped test is not a passed test.

## How onlyone handles your data

The application runs on your computer. When you use an external service, your request, conversation context and relevant project content may be sent to that service. Depending on permissions, tools can read or change files and run commands. Review actions, protect credentials and keep backups. See the [privacy information](PRIVACY.md) for details.

## Project documents

- [Contributing and repository rules](docs/CONTRIBUTING.md)
- [Security and vulnerability reporting](SECURITY.md) — a verified private reporting channel has not been established yet.
- [Usage and licenses](TERMS.md) · [Third-party notices](THIRD-PARTY-NOTICES.md)
- [Release status](docs/RELEASE-STATUS.md) · [Command-line guide](docs/CLI.md)

The project source is available under the [Apache License 2.0](LICENSE), where applicable. Third-party materials have their own notices and licenses.

---

<a id="русский"></a>
## Русский

**onlyone** — рабочее пространство для Windows, которое помогает работать над программами с ИИ. Откройте папку проекта, поставьте агенту задачу и проверяйте файлы и команды, с которыми он работает.

### Возможности

- Работа агента с файлами проекта и просмотр изменений.
- Пространство Design для работы с интерфейсами и предпросмотра.
- Задачи через командную строку Windows — подробнее в [руководстве CLI](docs/CLI.md).
- Подключение внешних сервисов ИИ и инструментов MCP.
- Русский и английский языки, светлая и тёмная темы.

Доступные возможности зависят от выбранного сервиса, разрешений и настроек. У внешних сервисов могут быть свои условия, ограничения и стоимость.

### Скачать

Установщик и portable-версия, когда они опубликованы, находятся в разделе [Releases](https://github.com/pkwoblerdev/onlyone/releases). Исполняемые файлы загружаются отдельно и не входят в Git-репозиторий исходников.

Версия 1.3.38 — кандидат выпуска; её сборки для Windows не подписаны. Завершённые проверки и оставшиеся ограничения, в том числе проверка установки на чистой Windows, описаны в [статусе выпуска](docs/RELEASE-STATUS.md). Автопроверка обновлений и встроенный сервер удалённого управления в этом кандидате отключены.

### Запуск из исходников

Установите Node.js и npm, откройте PowerShell в корне репозитория и выполните:

```powershell
cd source/onlyone-4c4c5c3
npm ci
npm run dev
```

Для запуска тестов в этой же папке используйте `npm test`. Некоторые проверки открывают окна приложения и требуют подходящего окружения Windows. Пропущенный тест не считается пройденным.

### Данные и безопасность

Приложение работает на вашем компьютере. При использовании внешнего сервиса ему могут передаваться запрос, контекст переписки и относящиеся к задаче данные проекта. В зависимости от разрешений инструменты могут читать и менять файлы и выполнять команды. Проверяйте действия, защищайте ключи и сохраняйте резервные копии. Подробнее — в [информации о конфиденциальности](PRIVACY.md).

### Документы проекта

- [Как участвовать и правила репозитория](docs/CONTRIBUTING.md)
- [Безопасность и сообщения об уязвимостях](SECURITY.md) — проверенный закрытый канал пока не настроен.
- [Использование и лицензии](TERMS.md) · [Уведомления о сторонних компонентах](THIRD-PARTY-NOTICES.md)
- [Статус выпуска](docs/RELEASE-STATUS.md) · [Командная строка](docs/CLI.md)

Исходный код проекта распространяется по [Apache License 2.0](LICENSE) там, где эта лицензия применима. Для сторонних материалов действуют собственные лицензии и уведомления.
