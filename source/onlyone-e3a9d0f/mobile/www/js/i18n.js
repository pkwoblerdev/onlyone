/* Русский — источник строк, английский — словарь, как в настольном приложении. Нет перевода — остаётся русский. */
(function (root) {
  'use strict'
  const EN = {}
  let lang = 'ru'
  function detect(saved) {
    if (saved === 'ru' || saved === 'en') return saved
    return /^ru/i.test(navigator.language || '') ? 'ru' : 'en'
  }
  function setLang(value) { lang = detect(value); document.documentElement.lang = lang }
  function t(text, ...args) {
    let out = lang === 'en' && EN[text] ? EN[text] : text
    let i = 0
    return String(out).replace(/%s/g, () => (i < args.length ? args[i++] : ''))
  }
  root.OnlyoneI18n = { t, setLang, EN, get lang() { return lang } }
})(window)
