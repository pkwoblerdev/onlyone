// Оконная проверка названий разделов (1.8, правило переписано 28.09 по Н89).
//
// Раньше разделы обязывались быть английскими в любом языке — из-за этого на
// русском экране левая панель оставалась «Chats, Projects, Skills,
// Design». Теперь название следует за языком: на русском — русское, на
// английском — английское. Проверяются оба, в одном окне и без перезапуска.
(async () => {
  const $ = id => document.getElementById(id);
  const checks = [];
  const note = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      try { if (fn()) return true; } catch {}
      await wait(100);
    }
    return false;
  };

  const booted = await until(() => $('messagesList') && $('newChatBtn') && $('sendBtn') && $('chatHistoryList') && $('navChats'));
  note('интерфейс загрузился', booted);
  if (!booted) return { ok: false, checks };
  await wait(600);

  const SECTIONS = [
    { id: 'navChats', view: 'chatView', ru: 'Диалоги', en: 'Chats' },
    { id: 'navProjects', view: 'projectsView', ru: 'Проекты', en: 'Projects' },
    { id: 'navSkills', view: 'skillsView', ru: 'Скиллы', en: 'Skills' },
    { id: 'navDesign', view: 'designView', ru: 'Дизайн', en: 'Design' },
    { id: 'navConnectors', view: 'connectorsView', ru: 'MCP', en: 'MCP' }
  ];

  const navText = id => $(id)?.querySelector('span')?.textContent?.trim() || '';
  const titleOf = view => document.querySelector(`#${view} .page-head .ttl h1, #${view} .page-title`)?.textContent?.trim() || '';

  // — русский язык (профиль по умолчанию) —
  document.documentElement.lang = document.documentElement.lang || 'ru';
  note('сначала экран на русском', document.documentElement.lang !== 'en', `lang=${document.documentElement.lang}`);
  for (const item of SECTIONS) {
    note(`[ru] кнопка #${item.id} называется «${item.ru}»`,
      navText(item.id) === item.ru, `фактически: «${navText(item.id)}»`);
  }
  for (const item of SECTIONS.filter(section => section.view !== 'chatView')) {
    $(item.id)?.click();
    await wait(300);
    note(`[ru] раздел «${item.ru}» открылся с русским заголовком`,
      $(item.view)?.classList.contains('active') && titleOf(item.view) === item.ru,
      `title: ${titleOf(item.view)}`);
  }

  // — английский: тот же экран после переключения, без перезапуска —
  if (typeof window.__setLanguage === 'function') await window.__setLanguage('en');
  else { const sel = $('languageSelect'); if (sel) { sel.value = 'en'; sel.dispatchEvent(new Event('change', { bubbles: true })); } }
  await until(() => navText('navChats') === 'Chats', 6000);
  note('после переключения панель стала английской', navText('navChats') === 'Chats', `navChats: «${navText('navChats')}»`);
  for (const item of SECTIONS) {
    note(`[en] кнопка #${item.id} называется «${item.en}»`,
      navText(item.id) === item.en, `фактически: «${navText(item.id)}»`);
  }
  for (const item of SECTIONS.filter(section => section.view !== 'chatView')) {
    $(item.id)?.click();
    await wait(300);
    note(`[en] раздел «${item.en}» открылся с английским заголовком`,
      $(item.view)?.classList.contains('active') && titleOf(item.view) === item.en,
      `title: ${titleOf(item.view)}`);
  }

  // — возврат на русский: названия обязаны вернуться, а не остаться английскими —
  if (typeof window.__setLanguage === 'function') await window.__setLanguage('ru');
  await until(() => navText('navChats') === 'Диалоги', 6000);
  note('возврат на русский снимает английские названия', navText('navChats') === 'Диалоги',
    `navChats: «${navText('navChats')}»`);

  $('navChats')?.click();
  await wait(300);
  note('возврат в раздел диалогов успешен', $('chatView')?.classList.contains('active'));

  try {
    if (typeof window.electronAPI?.takeScreenshot === 'function') await window.electronAPI.takeScreenshot();
  } catch {}

  return { ok: checks.every(c => c.pass), checks };
})();
