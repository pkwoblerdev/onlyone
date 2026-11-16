(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  await wait(1500)
  $('composerTextarea').value = 'Проверь ядро и покажи готовую конфигурацию.'
  $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  for (let i = 0; i < 200 && !document.querySelector('.msg-actions'); i++) await wait(100)
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  for (const family of ['Onest', 'Fira Code']) {
    const loaded = await document.fonts.load(`400 15px "${family}"`, 'Проверка шрифта ABC 123')
    note(`${family}: локальные кириллица и латиница загружены`, loaded.length >= 2 && loaded.every(f => f.status === 'loaded'), loaded.map(f => f.status))
  }
  await document.fonts.ready
  const answer = document.querySelector('.msg-item.assistant .msg-content p')
  const code = document.querySelector('.msg-item.assistant code.is-path')
  const strong = document.querySelector('.msg-item.assistant strong')
  note('Ответ отрисован', answer)
  note('Проза Onest 400 / 15px', answer && getComputedStyle(answer).fontWeight === '400' && getComputedStyle(answer).fontSize === '15px', answer && getComputedStyle(answer).fontFamily)
  note('Путь в лавандовом чипе', code && getComputedStyle(code).color === 'rgb(191, 174, 220)' && getComputedStyle(code).backgroundColor === 'rgba(184, 166, 214, 0.1)', code && getComputedStyle(code).color)
  note('Выделение весом 500', strong && getComputedStyle(strong).fontWeight === '500')
  const ring = document.querySelector('.ctx-ring-dial')
  note('Кольцо не вращается', getComputedStyle(ring).animationName === 'none')
  const card = $('composerCard').getBoundingClientRect()
  note('Композер 800px', Math.abs(card.width - 800) < 1, card.width)
  $('permModeBtn').click()
  await wait(300)
  note('Четыре режима доступа', $('permModeMenu').children.length === 4,
    [...$('permModeMenu').children].map(n => n.querySelector('.perm-item-name')?.textContent).join(', '))
  note('Ни одного слова о ролях', !/Solo|Lead|Council|Parallel/.test($('permModeMenu').textContent))
  $('permModeBtn').click()
  $('chatFeed').scrollTop = $('chatFeed').scrollHeight
  await wait(300)
  return { ok: checks.every(c => c.pass), checks }
})()
