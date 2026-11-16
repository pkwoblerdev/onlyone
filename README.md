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

## Project development

onlyone is still growing. The current version is an early step, and there is plenty more we want to build, improve and learn from the people using it.

Our priorities include improving stability and performance, making the application easier to use, strengthening security and privacy, and expanding documentation and testing. We also plan to explore update delivery through GitHub. These are directions for future work, not promises of features or release dates.

Feedback, issue reports and contributions can help shape the project. Please read the [contribution guide](docs/CONTRIBUTING.md) before opening a pull request.

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

## Repository structure

| Path | Contents |
| --- | --- |
| [`source/`](source/) | Application source, tests and build scripts. The 1.3.38 candidate is in `source/onlyone-4c4c5c3/`. |
| [`docs/`](docs/) | Guides, contribution rules, security information and release status. |
| [`releases/`](releases/) | Information and manifests for builds; download published files from GitHub Releases. |
| [`LICENSES/`](LICENSES/) | License texts and notices for included components. |
| [`README.md`](README.md) | Project overview and setup instructions. |
| [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) | Project license and accompanying notices. |
| [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md), [`SECURITY.md`](SECURITY.md) | Privacy, usage and security information. |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | Notices for third-party components and materials. |
| [`.gitignore`](.gitignore) | Files Git should normally leave out of the repository. |

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

### Развитие проекта

onlyone ещё развивается. Текущая версия — только первый шаг: впереди много идей и целей, над которыми мы хотим работать вместе с пользователями.

Среди наших приоритетов — стабильность и производительность, удобство приложения, безопасность и конфиденциальность, документация и тестирование. Мы также планируем изучить возможность обновлений через GitHub. Это направления дальнейшей работы, а не обещания конкретных функций или сроков.

Отзывы, сообщения об ошибках и участие в разработке помогут нам двигаться дальше. Перед отправкой изменений ознакомьтесь с [правилами участия](docs/CONTRIBUTING.md).

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

### Структура репозитория

| Путь | Что внутри |
| --- | --- |
| [`source/`](source/) | Исходники приложения, тесты и скрипты сборки. Кандидат 1.3.38 находится в `source/onlyone-4c4c5c3/`. |
| [`docs/`](docs/) | Руководства, правила участия, сведения о безопасности и статус выпуска. |
| [`releases/`](releases/) | Информация и манифесты сборок; опубликованные файлы скачиваются через GitHub Releases. |
| [`LICENSES/`](LICENSES/) | Тексты лицензий и уведомления для включённых компонентов. |
| [`README.md`](README.md) | Описание проекта и инструкция запуска. |
| [`LICENSE`](LICENSE) и [`NOTICE`](NOTICE) | Лицензия проекта и сопутствующие уведомления. |
| [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md), [`SECURITY.md`](SECURITY.md) | Информация о конфиденциальности, использовании и безопасности. |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | Уведомления о сторонних компонентах и материалах. |
| [`.gitignore`](.gitignore) | Файлы, которые Git обычно исключает из репозитория. |

### Документы проекта

- [Как участвовать и правила репозитория](docs/CONTRIBUTING.md)
- [Безопасность и сообщения об уязвимостях](SECURITY.md) — проверенный закрытый канал пока не настроен.
- [Использование и лицензии](TERMS.md) · [Уведомления о сторонних компонентах](THIRD-PARTY-NOTICES.md)
- [Статус выпуска](docs/RELEASE-STATUS.md) · [Командная строка](docs/CLI.md)

Исходный код проекта распространяется по [Apache License 2.0](LICENSE) там, где эта лицензия применима. Для сторонних материалов действуют собственные лицензии и уведомления.
