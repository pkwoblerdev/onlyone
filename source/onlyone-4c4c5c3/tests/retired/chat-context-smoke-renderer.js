// chat-context-smoke-renderer.js: внутриоконный зонд проверки состояний контекста чата одной строкой.
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch {}
      await wait(50)
    }
    return false
  }

  // Ожидание полной инициализации приложения
  await until(() => document.documentElement.dataset.appReady === '1')

  // Если открыто знакомство, закрываем его, чтобы чат и контекст были видны
  const ob = $('onboarding')
  if (ob) {
    ob.remove()
    try { localStorage.setItem('onlyone.onboarded', '1') } catch {}
  }

  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')

  const { state = 'normal', lang = 'ru' } = arg

  // Переключение языка при необходимости
  if (lang === 'en' && window.onlyoneApp?.setLanguage) {
    window.onlyoneApp.setLanguage('en')
    await wait(200)
  }

  const bar = window.onlyoneApp?.getChatContext?.()
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

  note('контекстная панель присутствует в окне', Boolean(bar) && Boolean(document.querySelector('.chat-context-bar')))

  if (!bar) {
    return { ok: false, checks }
  }

  // Применение тестируемого состояния
  switch (state) {
    case 'empty':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: true,
        usedTokens: 0,
        limitTokens: 1310720,
        attachmentCount: 0,
        historyTokens: 0,
        attachmentTokens: 0,
        systemTokens: 0
      })
      break

    case 'normal':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: true,
        usedTokens: 15400,
        limitTokens: 1310720,
        attachmentCount: 2,
        historyTokens: 11000,
        attachmentTokens: 3400,
        systemTokens: 1000
      })
      break

    case 'warn':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: true,
        usedTokens: 850000,
        limitTokens: 1000000,
        attachmentCount: 1,
        historyTokens: 800000,
        attachmentTokens: 49000,
        systemTokens: 1000
      })
      break

    case 'overflow':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: true,
        usedTokens: 1080000,
        limitTokens: 1000000,
        attachmentCount: 0,
        historyTokens: 1079000,
        attachmentTokens: 0,
        systemTokens: 1000
      })
      break

    case 'no-folder':
      bar.update({
        workspacePath: '',
        modelName: 'MiniMax M3',
        hasKey: true,
        usedTokens: 12000,
        limitTokens: 1048576,
        attachmentCount: 0,
        historyTokens: 11000,
        attachmentTokens: 0,
        systemTokens: 1000
      })
      break

    case 'no-key':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: false,
        usedTokens: 500,
        limitTokens: 256000,
        attachmentCount: 0,
        historyTokens: 500,
        attachmentTokens: 0,
        systemTokens: 0
      })
      break

    case 'expanded':
      bar.update({
        workspacePath: 'D:\\projects\\onlyone',
        modelName: 'GLM 5.3 Flash',
        hasKey: true,
        usedTokens: 42000,
        limitTokens: 1310720,
        attachmentCount: 3,
        historyTokens: 32000,
        attachmentTokens: 9000,
        systemTokens: 1000
      })
      bar.toggleDetails(true)
      break
  }

  await wait(120)

  const el = document.querySelector('.chat-context-bar')
  const summaryBtn = el.querySelector('.chat-context-summary')
  const folderEl = el.querySelector('.context-folder')
  const modelEl = el.querySelector('.context-model')
  const usageEl = el.querySelector('.context-usage')
  const details = el.querySelector('.chat-context-details')

  note('строка контекста размещена над полем ввода', el.closest('.chat-main') || el.closest('#chatView'))
  note('кнопка раскрытия имеет aria-expanded', summaryBtn && summaryBtn.hasAttribute('aria-expanded'))

  if (state === 'empty') {
    note('состояние empty отражено в классе', el.classList.contains('is-empty'))
    note('токены отображают 0%', usageEl?.textContent?.includes('0%') || usageEl?.textContent?.includes('0 /'))
  } else if (state === 'normal') {
    note('состояние normal отражено в классе', el.classList.contains('is-normal'))
    note('папки и модели в строке нет: они в поле ввода', !folderEl && !modelEl)
  } else if (state === 'warn') {
    note('состояние warn отражено в классе', el.classList.contains('is-warn'))
    note('процент предупреждения (>=75%) корректен', usageEl?.textContent?.includes('85%'))
  } else if (state === 'overflow') {
    note('состояние overflow отражено в классе', el.classList.contains('is-overflow'))
  } else if (state === 'no-folder') {
    note('состояние no-folder отражено в классе', el.classList.contains('no-folder'))
    note('папка в строке не дублируется', !folderEl)
  } else if (state === 'no-key') {
    note('состояние no-key отражено в классе', el.classList.contains('no-key'))
    const noKeyLabel = lang === 'en' ? 'No API key' : 'Нет ключа'
    note('надпись отсутствия ключа соответствует языку', modelEl?.textContent?.includes(noKeyLabel))
  } else if (state === 'expanded') {
    note('подробности раскрыты (aria-expanded=true)', summaryBtn?.getAttribute('aria-expanded') === 'true')
    note('карточка подробностей видима', details && !details.hidden)
  }

  const ok = checks.every(c => c.pass)
  return { ok, checks }
})()
