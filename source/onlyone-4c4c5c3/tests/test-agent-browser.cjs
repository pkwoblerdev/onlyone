// test-agent-browser.cjs: TDD проверки безопасности и контракта browse_page (этап 3.6).
const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try {
    await fn()
    console.log(`ok     ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

const within = (ms, promise, what) => {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`больше ${ms} мс — ${what}`)), ms)
    timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

;(async () => {
  // 1. Модуль должен существовать и экспортировать validateBrowserUrl, browsePage
  let browserModule
  try {
    browserModule = require('../src/main/agent-browser.js')
  } catch (err) {
    console.error('Ошибка загрузки agent-browser.js:', err.message)
  }

  await check('модуль agent-browser.js экспортирует нужные функции', () => {
    assert.ok(browserModule, 'agent-browser.js должен существовать')
    assert.equal(typeof browserModule.validateBrowserUrl, 'function', 'должна быть функция validateBrowserUrl')
    assert.equal(typeof browserModule.browsePage, 'function', 'должна быть функция browsePage')
  })

  const validate = browserModule?.validateBrowserUrl || (async () => { throw new Error('not implemented') })

  // 2. Запрет недопустимых протоколов
  await check('запрет протокола file://', async () => {
    await assert.rejects(
      async () => validate('file:///C:/Windows/win.ini'),
      /только http|недопустимый протокол|file/i
    )
  })

  await check('запрет протокола chrome://', async () => {
    await assert.rejects(
      async () => validate('chrome://settings'),
      /только http|недопустимый протокол|chrome/i
    )
  })

  await check('запрет протокола devtools://', async () => {
    await assert.rejects(
      async () => validate('devtools://devtools/bundled/inspector.html'),
      /только http|недопустимый протокол|devtools/i
    )
  })

  await check('запрет javascript: и data:', async () => {
    await assert.rejects(async () => validate('javascript:alert(1)'), /протокол|только http/i)
    await assert.rejects(async () => validate('data:text/html,<h1>hi</h1>'), /протокол|только http/i)
  })

  // Н7 аудита sec-net 2026-11-01: `parseTarget` в web-fetch отказывает адресу с
  // userinfo, а браузер принимал — и пароль ехал в ответ инструмента (контекст
  // модели, контрольные точки) и в журнал редиректа.
  await check('адрес с логином/паролем отклоняется до всякой проверки сети', async () => {
    const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
    await assert.rejects(
      async () => validate('https://admin:hunter2@example.com/vpn', { lookup: fakeLookup }),
      /Логин и пароль/i
    )
  })

  // 3. Запрет localhost и loopback
  await check('запрет http://localhost', async () => {
    await assert.rejects(
      async () => validate('http://localhost:3000'),
      /локальн|запрещ|localhost|private/i
    )
  })

  await check('запрет http://127.0.0.1', async () => {
    await assert.rejects(
      async () => validate('http://127.0.0.1:8080/api'),
      /локальн|запрещ|localhost|private/i
    )
  })

  await check('запрет IPv6 loopback http://[::1]', async () => {
    await assert.rejects(
      async () => validate('http://[::1]:8080/'),
      /локальн|запрещ|localhost|private/i
    )
  })

  // 4. Запрет частных IP-сетей
  await check('запрет приватной сети 10.0.0.0/8', async () => {
    await assert.rejects(
      async () => validate('http://10.0.0.5/admin'),
      /локальн|частн|приватн|private/i
    )
  })

  await check('запрет приватной сети 172.16.0.0/12', async () => {
    await assert.rejects(
      async () => validate('http://172.20.1.1/'),
      /локальн|частн|приватн|private/i
    )
  })

  await check('запрет приватной сети 192.168.0.0/16', async () => {
    await assert.rejects(
      async () => validate('http://192.168.1.1/'),
      /локальн|частн|приватн|private/i
    )
  })

  // 5. DNS-подмена на локальный адрес
  await check('запрет домена, резолвящегося в приватный IP', async () => {
    const fakeLookup = async () => [{ address: '127.0.0.1', family: 4 }]
    await assert.rejects(
      async () => validate('http://malicious-local.example.com', { lookup: fakeLookup }),
      /локальн|частн|приватн|private/i
    )
  })

  // 6. Валидные публичные адреса проходят
  await check('публичный URL успешно валидируется', async () => {
    const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const res = await validate('https://example.com/docs', { lookup: fakeLookup })
    assert.ok(res, 'должен вернуть проверенный url')
    assert.equal(res.protocol, 'https:')
    assert.equal(res.hostname, 'example.com')
  })

  // 7. Проверка очистки и изоляции в browsePage через мок BrowserWindow/session
  await check('browsePage изолирует сессию и уничтожает окно в finally', async () => {
    let windowDestroyed = false
    let storageCleared = false
    let openHandlerSet = false
    let downloadPrevented = false
    let permissionDenied = false

    const mockPartition = {
      setPermissionRequestHandler: fn => {
        fn({}, 'media', granted => { permissionDenied = !granted })
      },
      setPermissionCheckHandler: () => false,
      webRequest: {
        onBeforeRequest: () => {},
        onBeforeRedirect: () => {}
      },
      on: (event, handler) => {
        if (event === 'will-download') {
          handler({ preventDefault: () => { downloadPrevented = true } })
        }
      },
      clearStorageData: async () => { storageCleared = true }
    }

    const mockSession = {
      fromPartition: () => mockPartition
    }

    class MockBrowserWindow {
      constructor(opts) {
        this.opts = opts
        this.webContents = {
          setWindowOpenHandler: fn => {
            openHandlerSet = true
            assert.deepEqual(fn(), { action: 'deny' })
          },
          on: () => {},
          executeJavaScript: async () => ({ title: 'Test Title', text: 'Clean body text', links: [{ text: 'Home', href: 'https://example.com' }] })
        }
      }
      async loadURL() { return }
      destroy() { windowDestroyed = true }
      isDestroyed() { return windowDestroyed }
    }

    const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const result = await browserModule.browsePage('https://example.com/test', {
      BrowserWindow: MockBrowserWindow,
      session: mockSession,
      lookup: fakeLookup,
      timeoutMs: 5000
    })

    assert.equal(result.success, true, 'должен быть успешен')
    assert.equal(result.title, 'Test Title')
    assert.ok(result.text.includes('Clean body text'))
    assert.ok(windowDestroyed, 'окно должно быть закрыто в finally')
    assert.ok(storageCleared, 'данные хранилища должны быть очищены')
    assert.ok(openHandlerSet, 'setWindowOpenHandler должен запрещать новые окна')
    assert.ok(downloadPrevented, 'will-download должен предотвращать скачивания')
    assert.ok(permissionDenied, 'разрешения должны отклоняться')
  })

  // 8. Обрезка по maxChars
  await check('browsePage обрезает длинный текст по maxChars', async () => {
    let windowDestroyed = false
    const longText = 'A'.repeat(5000)

    class MockLongWindow {
      constructor() {
        this.webContents = {
          setWindowOpenHandler: () => {},
          on: () => {},
          executeJavaScript: async () => ({ title: 'Long Page', text: longText, links: [] })
        }
      }
      async loadURL() {}
      destroy() { windowDestroyed = true }
      isDestroyed() { return windowDestroyed }
    }

    const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const result = await browserModule.browsePage('https://example.com/long', {
      BrowserWindow: MockLongWindow,
      session: { fromPartition: () => ({
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => false,
        webRequest: { onBeforeRequest: () => {}, onBeforeRedirect: () => {} },
        on: () => {},
        clearStorageData: async () => {}
      }) },
      lookup: fakeLookup,
      maxChars: 500
    })

    assert.equal(result.success, true)
    assert.ok(result.text.length <= 600, 'текст должен быть обрезан с запасом на индикатор обрезки')
    assert.ok(result.truncated, 'должен быть флаг truncated')
    assert.ok(windowDestroyed)
  })

  // 9. Таймаут прерывает загрузку
  await check('browsePage завершается с ошибкой по таймауту', async () => {
    class MockHangingWindow {
      constructor() {
        this.destroyed = false
        this.webContents = {
          setWindowOpenHandler: () => {},
          on: () => {},
          executeJavaScript: () => new Promise(() => {})
        }
      }
      async loadURL() {
        return new Promise((resolve) => setTimeout(resolve, 2000))
      }
      destroy() { this.destroyed = true }
      isDestroyed() { return this.destroyed }
    }

    const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const result = await browserModule.browsePage('https://example.com/slow', {
      BrowserWindow: MockHangingWindow,
      session: { fromPartition: () => ({
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => false,
        webRequest: { onBeforeRequest: () => {}, onBeforeRedirect: () => {} },
        on: () => {},
        clearStorageData: async () => {}
      }) },
      lookup: fakeLookup,
      timeoutMs: 200
    })

    assert.equal(result.success, false)
    assert.match(result.error, /таймаут|время|лимит|timeout/i)
  })

  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed > 0) process.exit(1)
})()
