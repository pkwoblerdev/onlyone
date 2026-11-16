// Человек просил показать браузер («открой браузер», «чтобы мне было видно», «open the browser inside this environment»):
// страницы агента этого хода открываются в панели «Браузер» на его глазах, даже если модель сама не поставила show_to_user.
const WANTS_VISIBLE_BROWSER = new RegExp([
  '(?:открой(?:те)?|открыть|запусти(?:те)?|покажи(?:те)?)\\s+(?:мне\\s+)?(?:в\\s+)?(?:этом\\s+|нашем\\s+|встроенн\\p{L}*\\s+)?браузер',
  'в\\s+браузере\\s+(?:внутри|приложения|onlyone)',
  'чтобы\\s+(?:мне\\s+)?было\\s+видно',
  'open\\s+(?:the\\s+|a\\s+)?browser',
  'show\\s+me\\s+(?:the\\s+)?(?:browser|page)',
  'browser\\s+inside\\s+this'
].join('|'), 'iu')

const wantsVisibleBrowser = text => WANTS_VISIBLE_BROWSER.test(String(text || ''))

module.exports = { wantsVisibleBrowser, WANTS_VISIBLE_BROWSER }
