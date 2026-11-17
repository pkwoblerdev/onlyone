// In-window Electron renderer checks for milestone 2.6: English locale parity.
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

  const cyrillicRegex = /[а-яёА-ЯЁ]/;

  try {
    const booted = await until(() => $('messagesList') && $('newChatBtn') && $('sendBtn') && $('welcomeHero') && $('navChats'));
    note('интерфейс успешно загрузился', booted);
    if (!booted) return { ok: false, checks };

    await wait(600); // Wait for initial boot & translations

    // 1. Switch UI to English
    if (typeof window.__setLanguage === 'function') {
      await window.__setLanguage('en');
    } else {
      const langSelect = $('languageSelect');
      if (langSelect) {
        langSelect.value = 'en';
        langSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await wait(500);

    note('html lang установлен в en', document.documentElement.lang === 'en', `lang=${document.documentElement.lang}`);

    // 2. Verify welcome hero and primary chat controls in English
    const heroTitle = $('welcomeHero')?.querySelector('.hero-title')?.textContent?.trim();
    const allEnGreetings = [
      'Good morning', 'Where shall we start', 'Good afternoon', 'What are we working on',
      'Good evening', 'What’s on tonight', 'Good night', 'Night shift', 'What can I help with'
    ];
    const isEnHero = allEnGreetings.some(g => heroTitle?.includes(g)) && !cyrillicRegex.test(heroTitle);
    note('приветствие переведено на английский', isEnHero, `heroTitle='${heroTitle}'`);

    const textareaPlaceholder = $('composerTextarea')?.getAttribute('placeholder');
    note('placeholder поля ввода на английском',
      textareaPlaceholder?.includes('What should I do'),
      `placeholder='${textareaPlaceholder}'`
    );

    const sendTooltip = $('sendBtn')?.getAttribute('data-tooltip');
    note('подсказка кнопки отправки на английском',
      sendTooltip?.includes('Send'),
      `sendTooltip='${sendTooltip}'`
    );

    const newChatTooltip = $('newChatBtn')?.getAttribute('data-tooltip');
    note('подсказка кнопки нового диалога на английском',
      newChatTooltip?.includes('New chat'),
      `newChatTooltip='${newChatTooltip}'`
    );

    const permTooltip = $('permModeBtn')?.getAttribute('data-tooltip');
    const isEnPerm = (permTooltip?.includes('Manual') || permTooltip?.includes('Plan') || permTooltip?.includes('Ask') || permTooltip?.includes('change')) && !cyrillicRegex.test(permTooltip);
    note('подсказка режима разрешений на английском', isEnPerm, `permTooltip='${permTooltip}'`);

    // 3. Verify Projects view in English
    $('navProjects')?.click();
    await wait(300);
    const projNewBtn = $('newProjectBtn')?.textContent?.trim();
    note('кнопка нового проекта на английском',
      projNewBtn?.includes('New project'),
      `newProjectBtn='${projNewBtn}'`
    );

    // Поясняющего текста под заголовком у раздела больше нет (макет 2.0, «без
    // лишнего текста»): на английском проверяется сам заголовок.
    const projTitle = document.querySelector('#projectsView .page-head h1')?.textContent?.trim();
    note('заголовок раздела Projects на английском', projTitle === 'Projects', `projTitle='${projTitle}'`);

    // 4. Verify Skills view in English
    $('navSkills')?.click();
    await wait(300);
    const skillCreateBtn = $('addSkillBtn')?.textContent?.trim();
    note('кнопка создания скилла на английском',
      skillCreateBtn?.includes('Create skill') || skillCreateBtn?.includes('Skill'),
      `addSkillBtn='${skillCreateBtn}'`
    );
    // Группы раздела (макет 21.10): заголовки .grp — «В проекте …», «Ваши», «Встроенные»
    const skillGroups = Array.from(document.querySelectorAll('#skillsView .grp')).map(node => node.textContent.trim());
    note('группы скиллов на английском',
      // Встроенных скиллов больше нет (чистка 04.10): в пустом профиле групп нет, а если есть — без русского.
      skillGroups.every(group => !/[А-Яа-яЁё]/.test(group)),
      `groups=${JSON.stringify(skillGroups)}`
    );

    // 5. Verify Settings modal in English
    $('navChats')?.click();
    await wait(200);
    $('openSettingsBtn')?.click();
    await wait(400);

    const settingsModal = $('settingsModal');
    const isSettingsOpen = settingsModal && !settingsModal.hidden && (settingsModal.open || settingsModal.hasAttribute('open') || settingsModal.classList.contains('active') || settingsModal.style.display !== 'none');
    note('окно настроек открыто', isSettingsOpen);

    // Inspect settings tab labels
    const tabs = Array.from(document.querySelectorAll('#settingsModal [role="tab"]')).map(t => t.textContent.trim());
    const hasEnglishTabs = tabs.some(t => ['Personalisation', 'Keys', 'Workspaces', 'Updates', 'Shortcuts'].includes(t));
    note('вкладки настроек на английском', hasEnglishTabs, `tabs=${JSON.stringify(tabs)}`);

    // Close settings modal
    document.querySelector('#settingsModal [data-close="settingsModal"]')?.click();
    await wait(300);

    // 6. Test seamless round-trip to Russian and back without page reload
    if (typeof window.__setLanguage === 'function') {
      await window.__setLanguage('ru');
    } else {
      const langSelect = $('languageSelect');
      if (langSelect) {
        langSelect.value = 'ru';
        langSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await wait(300);
    const ruHero = $('welcomeHero')?.querySelector('.hero-title')?.textContent?.trim();
    const allRuGreetings = [
      'Доброе утро', 'С чего начнём', 'Добрый день', 'Над чем работаем',
      'Добрый вечер', 'Что делаем сегодня вечером', 'Доброй ночи', 'Ночная смена', 'Чем могу помочь'
    ];
    const isRuHero = allRuGreetings.some(g => ruHero?.includes(g)) && cyrillicRegex.test(ruHero);
    note('мгновенный возврат на русский язык работает без перезагрузки', isRuHero, `ruHero='${ruHero}'`);

    // Switch back to EN for final screenshot
    if (typeof window.__setLanguage === 'function') {
      await window.__setLanguage('en');
    } else {
      const langSelect = $('languageSelect');
      if (langSelect) {
        langSelect.value = 'en';
        langSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await wait(300);

    // 7. Global scan of primary visible controls for untranslated Russian text
    const primaryControls = Array.from(document.querySelectorAll('.sidebar-nav span, .page-title, .btn-primary, .btn-send'));
    const untranslatedVisible = primaryControls
      .map(el => el.textContent.trim())
      .filter(t => cyrillicRegex.test(t));
    note('основные видимые элементы управления свободны от кириллицы в режиме EN',
      untranslatedVisible.length === 0,
      `untranslated=${JSON.stringify(untranslatedVisible)}`
    );

    const allPassed = checks.every(c => c.pass);
    return { ok: allPassed, checks };
  } catch (err) {
    return { ok: false, error: err.message, stack: err.stack, checks };
  }
})();
