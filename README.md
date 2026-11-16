# onlyone

A Windows workspace for working on software with AI agents. onlyone can inspect project files, run tools, and help review changes. It supports a Design workspace, command-line tasks, MCP tools and external model endpoints.

**Release candidate:** Version 1.3.38 is being verified and is not ready for publication. See [release status](docs/RELEASE-STATUS.md).

## Run from source

The candidate source is in [source/onlyone-4c4c5c3](source/onlyone-4c4c5c3/). From the repository root:

```powershell
cd source/onlyone-4c4c5c3
npm ci
npm run dev
```

The app runs locally, but requests can send prompts, conversation context and project content to chosen external services. Depending on permissions, agents can read or change files and run commands. Review actions and keep backups. Automatic updates and packaged remote control are disabled in this candidate.

See [privacy draft](docs/PRIVACY.md), [usage and licenses](docs/TERMS.md), [security policy](docs/SECURITY.md), [third-party notices](docs/THIRD-PARTY-NOTICES.md) and [Apache-2.0 license](LICENSE). A private vulnerability reporting channel has not yet been established.

---

onlyone — приложение для работы над программами с помощью ИИ-агентов. Агент может изучать файлы проекта, запускать инструменты и помогать проверять изменения; доступны режим Design, командная строка, MCP и подключение внешних сервисов моделей.

**Кандидат:** версия 1.3.38 проходит проверку и пока не готова к публикации. Статус — в [документе о выпуске](docs/RELEASE-STATUS.md). Для запуска из исходников выполните команды выше в папке репозитория.

Приложение работает локально, но может отправлять запросы, контекст переписки и части проекта выбранным внешним сервисам. В зависимости от разрешений агент может читать и менять файлы и выполнять команды. Проверяйте действия и сохраняйте резервные копии. Автообновление и удалённое управление в упакованной версии кандидата отключены.

[Конфиденциальность](docs/PRIVACY.md) · [Использование и лицензии](docs/TERMS.md) · [Политика безопасности](docs/SECURITY.md) · [Сторонние компоненты](docs/THIRD-PARTY-NOTICES.md)

Закрытый канал для сообщений об уязвимостях пока не настроен. Подробности — в [политике безопасности](docs/SECURITY.md).
