// In-window renderer checks for milestone 1.5: emoji and symbols standardization.
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

  const booted = await until(() => $('messagesList') && $('newChatBtn') && $('sendBtn') && $('chatHistoryList') && $('composerTextarea'));
  note('интерфейс загрузился', booted);
  if (!booted) return { ok: false, checks };

  await wait(600); // Async initialization

  // Test target string with diverse emojis
  const targetTitle = 'Сайт с пальмами готов 🌴 🚀 ✅';

  // 1. Create or set up chat with targetTitle
  $('newChatBtn').click();
  await wait(300);

  // Rename chat item using native dblclick -> history-rename
  const titleEl = document.querySelector('.history-item-title');
  note('заголовок диалога в сайдбаре найден', !!titleEl);

  if (titleEl) {
    titleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await wait(150);
    const renameInput = document.querySelector('.history-rename');
    if (renameInput) {
      renameInput.value = targetTitle;
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(250);
    }
  }

  // Send message with targetTitle into chat feed
  const ta = $('composerTextarea');
  if (ta) {
    ta.value = targetTitle;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const sendForm = $('sendForm') || ta.closest('form');
    if (sendForm) {
      sendForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    await wait(400);
  }

  // 2. Check sidebar title formatting
  const updatedSidebarTitle = document.querySelector('.history-item-title');
  const sidebarEmojiEls = updatedSidebarTitle?.querySelectorAll('.ui-emoji') || [];
  note('эмодзи в названии диалога обёрнуты в .ui-emoji', sidebarEmojiEls.length >= 3, `найдено: ${sidebarEmojiEls.length}`);

  let sidebarMetricsOk = false;
  if (sidebarEmojiEls.length > 0) {
    const s = window.getComputedStyle(sidebarEmojiEls[0]);
    sidebarMetricsOk = (s.fontSize === '16px' || s.width === '16px') && s.fontFamily.includes('Twemoji');
    note('эмодзи в сайдбаре имеют размер 16px и шрифт Twemoji', sidebarMetricsOk,
      `size: ${s.fontSize}, width: ${s.width}, font: ${s.fontFamily}`);
  }

  // 3. Check chat messages formatting
  const chatMsgEl = document.querySelector('.msg-item .msg-content') || document.querySelector('.msg-item');
  const chatEmojiEls = chatMsgEl?.querySelectorAll('.ui-emoji') || [];
  note('эмодзи в сообщениях чата обёрнуты в .ui-emoji', chatEmojiEls.length >= 3, `найдено: ${chatEmojiEls.length}`);

  let chatMetricsOk = false;
  if (chatEmojiEls.length > 0) {
    const s = window.getComputedStyle(chatEmojiEls[0]);
    chatMetricsOk = (s.fontSize === '16px' || s.width === '16px') && s.fontFamily.includes('Twemoji');
    note('эмодзи в чате имеют размер 16px и шрифт Twemoji', chatMetricsOk,
      `size: ${s.fontSize}, width: ${s.width}, font: ${s.fontFamily}`);
  }

  // 4. Open context menu on the chat item to check menu formatting
  const itemToRightClick = document.querySelector('.history-item');
  if (itemToRightClick) {
    const rect = itemToRightClick.getBoundingClientRect();
    const evt = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    });
    itemToRightClick.dispatchEvent(evt);
  }
  await wait(350);

  const ctxMenu = document.querySelector('.ctx-menu');
  note('контекстное меню открыто', !!ctxMenu && ctxMenu.style.display !== 'none');

  // Add custom menu item with targetTitle to check menu emoji rendering
  if (ctxMenu) {
    const testMenuItem = document.createElement('button');
    testMenuItem.className = 'ctx-item';
    testMenuItem.setAttribute('role', 'menuitem');
    testMenuItem.innerHTML = `<span class="ctx-label">${window.formatWithEmoji ? window.formatWithEmoji(targetTitle) : targetTitle}</span>`;
    ctxMenu.insertBefore(testMenuItem, ctxMenu.firstChild);

    const menuEmojiEls = testMenuItem.querySelectorAll('.ui-emoji');
    note('эмодзи в меню обёрнуты в .ui-emoji', menuEmojiEls.length >= 3, `найдено: ${menuEmojiEls.length}`);

    if (menuEmojiEls.length > 0) {
      const s = window.getComputedStyle(menuEmojiEls[0]);
      const menuMetricsOk = (s.fontSize === '16px' || s.width === '16px') && s.fontFamily.includes('Twemoji');
      note('эмодзи в меню имеют размер 16px и шрифт Twemoji', menuMetricsOk,
        `size: ${s.fontSize}, width: ${s.width}, font: ${s.fontFamily}`);
    }
  }

  // 5. Check service interface symbols: no text arrows/chevrons/pencils
  const openButtons = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '→');
  note('нет кнопок с текстовыми стрелками →', openButtons.length === 0, `найдено: ${openButtons.length}`);

  // Keep menu open for screenshot capture
  await wait(500);

  const allPassed = checks.every(c => c.pass);
  return { ok: allPassed, checks };
})();
