# onlyone 1.3.39 — pre-release

This version adds update checks through the onlyone GitHub Releases page for the Windows installer. The app can download a new version and install it when it closes; this can be disabled in settings. Portable builds do not install updates automatically.

Version 1.3.38 has automatic updates disabled. Install 1.3.39 manually once to enable the new update mechanism. Your local profile should be preserved; keep a backup and verify your data after installation.

Windows binaries are unsigned and may trigger a system warning. Existing tests include simulated GitHub update metadata; a real update between two published versions and a clean Windows install still require independent verification.

## Русский

В установленной Windows-версии появилась проверка обновлений через GitHub Releases проекта onlyone. Приложение может скачать новую версию и установить её при выходе; функцию можно выключить в настройках. Portable-сборка не устанавливает обновления автоматически.

В версии 1.3.38 автоматические обновления отключены. Чтобы перейти на новый механизм, установите 1.3.39 вручную один раз. Локальный профиль должен сохраниться; сохраните резервную копию и проверьте данные после установки.

Сборки Windows не подписаны, поэтому система может показать предупреждение. Механизм проверен с имитацией ответов GitHub; реальное обновление между двумя опубликованными версиями и установку на чистой Windows ещё нужно проверить отдельно.

## Files for the release / Файлы выпуска

- `onlyone-Setup-1.3.39.exe` — installer / установщик.
- `latest.yml` — update metadata / метаданные для автообновления; required / обязательный файл.
- `onlyone-1.3.39-portable-windows.zip` — optional portable archive / необязательная portable-версия в ZIP.

Upload the installer and `latest.yml` from the same build without renaming either file. / Загружайте установщик и `latest.yml` из одной сборки, не переименовывая их.
