// test-no-phone-home.cjs: сетевой сторож разрешённых адресов (принцип «данные только на ПК», П-1).
// Проверяет, что в src/main нет неавторизованных внешних сетевых адресов (телеметрии, трекеров, сторонних серверов).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainDir = path.join(root, 'src', 'main')

// Разрешённые внешние хосты и шаблоны URL в главном процессе
const ALLOWED_HOSTS = new Set([
  'openrouter.ai',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'opencode.ai',
  // Каталог провайдеров (07.10.2026): адреса, на которые уходят ходы, только если человек сам выбрал путь и вписал ключ.
  'api.together.ai', 'api.groq.com', 'api.fireworks.ai', 'api.deepinfra.com', 'router.huggingface.co', 'api.cerebras.ai',
  'api.sambanova.ai', 'integrate.api.nvidia.com', 'ai-gateway.vercel.sh', 'router.requesty.ai', 'api.tokenfactory.nebius.com',
  'llm.chutes.ai', 'api.siliconflow.com', 'api.siliconflow.cn',
  'pkwobler.best',
  '1code.app',
  'localhost',
  '127.0.0.1',
  'github.com',
  'raw.githubusercontent.com',
  'nodejs.org',
  'schema.org',
  'json-schema.org',
  'w3.org',
  'www.w3.org'
])

// Запрещённые телеметрические паттерны
const FORBIDDEN_TELEMETRY = [
  'sentry.io',
  'posthog.com',
  'mixpanel.com',
  'google-analytics.com',
  'segment.io',
  'telemetry',
  'crashReporter'
]

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok     ${name}`)
  } catch (err) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${err.message}`)
  }
}

function getAllFiles(dir, exts = ['.js', '.cjs']) {
  const result = []
  const list = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of list) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...getAllFiles(full, exts))
    } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
      result.push(full)
    }
  }
  return result
}

const mainFiles = getAllFiles(mainDir)

check('в src/main найдены файлы для проверки', () => {
  assert.ok(mainFiles.length >= 10, `найдено файлов: ${mainFiles.length}`)
})

check('в src/main и package.json отсутствуют телеметрия и сборщики отчётов', () => {
  const pkgContent = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  for (const pattern of FORBIDDEN_TELEMETRY) {
    if (pattern === 'telemetry') {
      // Ищем именно библиотеки телеметрии в dependencies
      assert.ok(!pkgContent.includes('"@sentry') && !pkgContent.includes('"posthog'), 'найдены библиотеки трекинга в package.json')
      continue
    }
    assert.ok(!pkgContent.includes(pattern), `найден запрещённый телеметрический пакет ${pattern} в package.json`)
  }

  for (const file of mainFiles) {
    const text = fs.readFileSync(file, 'utf8')
    for (const pattern of ['sentry.io', 'posthog.com', 'mixpanel.com', 'google-analytics.com', 'segment.io']) {
      assert.ok(!text.includes(pattern), `в ${path.relative(root, file)} найден запрещённый хост: ${pattern}`)
    }
  }
})

check('все внешние HTTP/HTTPS адреса в src/main принадлежат разрешённому списку', () => {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::[0-9]+)?(?:[/\s"'>`]|$)/g
  const disallowed = []

  for (const file of mainFiles) {
    const text = fs.readFileSync(file, 'utf8')
    let match
    while ((match = urlRegex.exec(text))) {
      const host = match[1].toLowerCase()
      // Игнорируем закомментированные примеры или заглушки вида example.com
      if (host === 'example.com' || host === 'foo.bar' || host === 'my-server' || host === 'my-proxy.com' || host === 'host' || host.endsWith('.local')) {
        continue
      }
      if (!ALLOWED_HOSTS.has(host) && !ALLOWED_HOSTS.has(host.replace(/^api\./, ''))) {
        disallowed.push({ file: path.relative(root, file), host, match: match[0].trim() })
      }
    }
  }

  assert.deepEqual(disallowed, [], `найдены неавторизованные адреса: ${JSON.stringify(disallowed, null, 2)}`)
})

console.log(`\nИтог test-no-phone-home: ${passed} успешно, ${failed} провалов.`)
if (failed > 0) process.exit(1)
