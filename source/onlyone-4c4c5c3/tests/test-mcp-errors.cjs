// The raw SDK failure is "Streamable HTTP error: Error POSTing to endpoint:
// {json}". These assert that what reaches the user says what to do instead.
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mcp-manager.js'), 'utf8')
const start = src.indexOf('function describeMcpError')
const end = src.indexOf('class McpManager')
if (start < 0 || end < 0) throw new Error('describeMcpError не найдена')

// Вырезанная функция видит только глобальную область: в живом модуле маска —
// обычный require на уровне файла (провайдеры маскируют отказы тем же модулем).
globalThis.maskSecretText = require('../src/main/providers/secret-mask.js').maskSecretText

// eslint-disable-next-line no-new-func
const describeMcpError = new Function(src.slice(start, end) + '\nreturn describeMcpError')()

const CASES = [
  {
    what: 'токен не вписан после Bearer',
    error: new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"Connect with a Platinum token or sign in with OAuth"}'),
    config: { type: 'http', url: 'https://pkwobler.best/mcp', headers: { Authorization: 'Bearer ' } },
    expect: /после «Bearer » пусто/
  },
  {
    what: 'заголовка авторизации нет вовсе',
    error: new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"Connect with a Platinum token or sign in with OAuth"}'),
    config: { type: 'http', url: 'https://pkwobler.best/mcp', headers: {} },
    expect: /добавьте заголовок/
  },
  {
    what: 'токен есть, но отклонён',
    error: new Error('HTTP 401 Unauthorized'),
    config: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer abc123' } },
    expect: /отклонил токен/
  },
  {
    what: 'неверный путь',
    error: new Error('Error POSTing to endpoint (HTTP 404): Not Found'),
    config: { type: 'http', url: 'https://pkwobler.best/api' },
    expect: /нет MCP-эндпоинта/
  },
  {
    what: 'сети нет',
    error: new Error('fetch failed'),
    config: { type: 'http', url: 'https://x/mcp' },
    expect: /недоступен/
  },
  {
    what: 'команда не установлена',
    error: new Error('spawn npx ENOENT'),
    config: { type: 'stdio', command: 'npx' },
    expect: /Проверьте, что она установлена/
  },
  // Находка Н3 (аудит sec-net 2026-11-01): сервер вправе эхом вернуть
  // отправленный заголовок — текст уходит в карточку и каналом mcp-status
  // во все окна. Как у провайдеров модели: маска до выдачи, длина ограничена.
  {
    what: 'сервер эхом отдал заголовок Authorization в сообщении',
    error: new Error('MCP error -32000: authorization value sk-MCPTEST-9f3Kq7Zx2Lm8Vb4N is invalid'),
    config: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-MCPTEST-9f3Kq7Zx2Lm8Vb4N' } },
    expect: /\*\*\*|\[ключ\]/,
    forbid: /sk-MCPTEST|9f3Kq7Zx|Zx2Lm8|Vb4N/
  },
  {
    what: 'эхо заголовка лежит в JSON-теле 500',
    error: new Error('HTTP 500: {"error":{"message":"upstream rejected: Bearer sk-MCPTEST-9f3Kq7Zx2Lm8Vb4N is invalid"}}'),
    config: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-MCPTEST-9f3Kq7Zx2Lm8Vb4N' } },
    expect: /\*\*\*|\[ключ\]/,
    forbid: /sk-MCPTEST|9f3Kq7Zx|Zx2Lm8|Vb4N/
  },
  {
    what: 'хвост ключа в сокращённом эхо («sk-…Jp2W»-форма)',
    error: new Error('MCP error -32000: credential 2Lm8Vb4N is not recognised'),
    config: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-MCPTEST-9f3Kq7Zx2Lm8Vb4N' } },
    // Значение обязано исчезнуть; чем именно оно закрыто — `[ключ]` из маски
    // заголовков или `***` из зачистки по имени метки (`credential`), — не важно.
    expect: /\*\*\*|\[ключ\]/,
    forbid: /2Lm8Vb4N/
  },
  {
    what: 'нечитаемый гигантский ответ не растягивает карточку',
    error: new Error('x'.repeat(5000)),
    config: { type: 'http', url: 'https://x/mcp' },
    expect: /./,
    max: 420
  }
]

let failed = 0
for (const c of CASES) {
  const got = describeMcpError(c.error, c.config)
  const ok = c.expect.test(got) && !(c.forbid && c.forbid.test(got)) && !(c.max && got.length > c.max)
  if (!ok) { failed++; console.error(`ПРОВАЛ [${c.what}]: ${String(got).slice(0, 240)}`) }
  if (/Streamable HTTP error|POSTing to endpoint/.test(got)) {
    failed++
    console.error(`ПРОВАЛ [${c.what}]: сырой текст SDK просочился — ${got}`)
  }
}

console.log(JSON.stringify({ ok: failed === 0, cases: CASES.length, failed }))
process.exit(failed ? 1 : 0)
