# Windows Command-Line Interface (CLI) / Командная строка Windows

[English](#english) | [Русский](#русский)

---

<a name="english"></a>
## English

The `onlyone` Windows CLI allows engineers to execute autonomous agent tasks directly from PowerShell, Command Prompt, or automated developer scripts without keeping the main graphical window open.

The command is implemented as `resources\cli\onlyone.cmd`, which invokes the packaged `onlyone.exe` binary in an embedded runtime mode. A standalone Node.js installation is not required on target machines.

---

### Installation and PATH Registration

1. During installation via the standard NSIS installer, ensure the option **"Add onlyone command to user PATH"** is checked.
2. Open a **new** PowerShell or CMD terminal so the updated environment variables take effect.
3. Verify the command is available:
   ```powershell
   onlyone --version
   onlyone --help
   ```

> **Note on Portable Builds:** The Portable executable does not register global environment variables. To run the CLI manually from a portable layout, invoke:
> ```powershell
> & "C:\Path\To\onlyone\resources\cli\onlyone.cmd" --help
> ```

---

### Command Syntax

```powershell
onlyone run "<task-prompt>" --folder "<workspace-path>" [options]
```

#### Core Arguments & Options

| Option | Required | Description |
|---|---|---|
| `run "<prompt>"` | Yes | The natural language task prompt provided to the agent. |
| `--folder "<path>"` | Yes | The target working directory where the agent explores and operates. |
| `--allow-write` | No | Authorizes file modifications. When omitted, the agent runs in read-only mode. |
| `--profile "<path>"` | No | Path to custom user profile directory (defaults to `%APPDATA%\onlyone`). |
| `--log "<file.jsonl>"` | No | Writes structured, credential-sanitized execution output to a JSONL file. |
| `--version` | No | Outputs the installed application version and exits. |
| `--help` | No | Displays available flags and syntax reference. |

---

### Execution and Security Model

1. **Profile Isolation:**  
   The CLI reads provider keys and configuration from `%APPDATA%\onlyone` (or `%APPDATA%\1code` if migrating). It copies configuration and `Local State` into an isolated temporary directory. Original profile files and active desktop sessions are untouched.
2. **DPAPI Decryption:**  
   API credentials are encrypted via Windows DPAPI (`safeStorage`). Decryption requires executing under the same Windows user account where the credentials were created in the desktop application.
3. **Permission Boundaries:**  
   Without `--allow-write`, all disk modifications are blocked. When an agent attempts an unauthorized file modification, execution halts with exit code `3`. Interactive questions or prompts requiring manual confirmation stop execution.
4. **Lifecycle and Timeouts:**  
   Execution runs in a headless Electron instance. Maximum execution time is bounded at 4 minutes per run. Pressing `Ctrl+C` cleanly aborts the operation. Temporary profile directories are removed upon process exit.

---

### Exit Codes

| Code | Status | Meaning |
|---|---|---|
| `0` | Success | Task completed successfully. |
| `1` | Execution Error | An unhandled exception or agent error occurred during the step. |
| `2` | Invalid Arguments | Missing required arguments, invalid path, or corrupted profile. |
| `3` | Permission Denied | The agent requested write operations without `--allow-write`. |
| `4` | Aborted | Execution was cancelled by the user (`Ctrl+C`) or timed out. |

---

### Usage Examples

```powershell
# Read-only repository audit
onlyone run "Scan for outdated dependency declarations in package.json" --folder "D:\Projects\web-client"

# Apply changes and generate new unit tests
onlyone run "Create unit test suite for the token parser" --folder "D:\Projects\web-client" --allow-write

# Execute with structured log output
onlyone run "Verify line ending consistency across source files" --folder "D:\Projects\web-client" --log "D:\Logs\audit.jsonl"
```

---

<a name="русский"></a>
## Русский

Интерфейс командной строки Windows `onlyone` позволяет разработчикам запускать задачи автономного агента напрямую из PowerShell, CMD или локальных сценариев автоматизации без необходимости держать открытым основное окно приложения.

Команда представляет собой командный файл `resources\cli\onlyone.cmd`, который запускает исполняемый файл `onlyone.exe` во встроенном режиме. Отдельная установка Node.js на целевой машине не требуется.

---

### Установка и регистрация в PATH

1. При установке через стандартный установщик Windows NSIS убедитесь, что включена опция **«Добавить команду onlyone в PATH моего пользователя»**.
2. После завершения установки откройте **новое** окно PowerShell или CMD для применения системных переменных среды.
3. Проверьте доступность утилиты:
   ```powershell
   onlyone --version
   onlyone --help
   ```

> **Примечание к Portable EXE:** Портативная версия не вносит изменений в системный реестр и PATH. Для прямого вызова используйте путь к каталогу:
> ```powershell
> & "C:\Путь\К\onlyone\resources\cli\onlyone.cmd" --help
> ```

---

### Синтаксис команды

```powershell
onlyone run "<текст-задачи>" --folder "<путь-к-каталогу>" [параметры]
```

#### Параметры командной строки

| Флаг | Обязательный | Назначение |
|---|---|---|
| `run "<запрос>"` | Да | Формулировка задачи для автономного агента. |
| `--folder "<путь>"` | Да | Рабочий каталог проекта, в котором агент выполняет исследование или правки. |
| `--allow-write` | Нет | Разрешение на запись. Без этого флага любые изменения файлов запрещены. |
| `--profile "<путь>"` | Нет | Путь к альтернативному профилю настроек (по умолчанию: `%APPDATA%\onlyone`). |
| `--log "<файл.jsonl>"` | Нет | Сохранение результата работы и кода возврата в файл JSONL (ключи удаляются). |
| `--version` | Нет | Вывод текущей версии утилиты и завершение. |
| `--help` | Нет | Отображение справочной информации по аргументам. |

---

### Модель безопасности и изолированное выполнение

1. **Изоляция профиля:**  
   Утилита считывает настройки провайдеров и моделей из `%APPDATA%\onlyone` (или `%APPDATA%\1code`). Настройки и файл `Local State` копируются во временный изолированный каталог. Основная история чатов и конфигурация открытого приложения не изменяются.
2. **Расшифровка ключей через Windows DPAPI:**  
   Ключи провайдеров зашифрованы с помощью Windows DPAPI (`safeStorage`). Расшифровка возможна только в контексте той учётной записи пользователя Windows, в которой ключи были внесены через графический интерфейс.
3. **Границы прав на запись:**  
   По умолчанию действует строгий режим чтения. Если агент запрашивает запись изменений в файл при отсутствии флага `--allow-write`, выполнение останавливается с кодом возврата `3`. Интерактивные диалоги подтверждения в CLI не поддерживаются.
4. **Таймауты и отмена:**  
   Ход агента выполняется в скрытом окне. Предельное время одного запуска ограничено 4 минутами. Комбинация `Ctrl+C` выполняет безопасную отмену процесса. Временный профиль удаляется при штатном завершении.

---

### Коды завершения (Exit Codes)

| Код | Обозначение | Причина |
|---|---|---|
| `0` | Success | Задача успешно выполнена агентом. |
| `1` | Execution Error | Ошибка в процессе выполнения шага агента. |
| `2` | Invalid Arguments | Ошибка в переданных аргументах или повреждение профиля. |
| `3` | Permission Denied | Попытка изменения файлов без флага `--allow-write`. |
| `4` | Aborted | Процесс отменён пользователем (`Ctrl+C`) или завершён по таймауту. |

---

### Примеры использования

```powershell
# Аудит структуры проекта в режиме чтения
onlyone run "Объясни назначение основных модулей в каталоге src" --folder "D:\Projects\demo"

# Применение правок с флагом записи
onlyone run "Создай файл конфигурации ESLint и добавь базовые правила" --folder "D:\Projects\demo" --allow-write

# Выполнение задачи с сохранением журнала в JSONL
onlyone run "Проверь форматирование файлов и окончания строк" --folder "D:\Projects\demo" --log "D:\Reports\run.jsonl"
```
