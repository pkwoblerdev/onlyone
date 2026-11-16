// Совет при отказе авторизации (11.10.2026, stress-provider): своему эндпоинту, Anthropic или Ollama говорили «Проверьте ключи
// OpenRouter». Совет называет тот путь, на котором ход шёл.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

const at = main.indexOf('Проверьте ключи OpenRouter в настройках: сервер отклонил авторизацию')
assert.ok(at > 0, 'совет про ключи пропал')
const around = main.slice(Math.max(0, at - 200), at + 600)
assert.match(around, /activeProviderId\(\) === 'openrouter'/, 'совет про OpenRouter должен зависеть от активного пути')
assert.match(around, /Проверьте ключ этого подключения в настройках/, 'для других путей нужен нейтральный совет')
console.log('Совет при отказе авторизации называет активный путь: проверки пройдены')
