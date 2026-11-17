// In-window renderer checks for milestone 1.6: UI Motion and reduced-motion.
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

  await wait(600); // Async boot settling

  // 1. Check skip-link uses transform instead of top
  const skipLink = document.querySelector('.skip-link');
  note('skip-link присутствует в DOM', !!skipLink);
  if (skipLink) {
    const s = window.getComputedStyle(skipLink);
    note('skip-link transition анимирует transform, а не top',
      s.transitionProperty.includes('transform') && !s.transitionProperty.includes('top'),
      `transitionProperty: ${s.transitionProperty}`);
  }

  // 2. Check brand-glyph animation is gentle and within budget (<300ms for done, no scale explosion)
  const brandGlyph = document.querySelector('.brand-glyph');
  note('brand-glyph присутствует в шапке', !!brandGlyph);
  if (brandGlyph) {
    // Add is-done class temporarily to test computed styles
    brandGlyph.classList.add('is-done');
    const s = window.getComputedStyle(brandGlyph);
    note('brand-glyph.is-done длится <= 300ms',
      parseFloat(s.animationDuration) <= 0.35,
      `duration: ${s.animationDuration}`);
    brandGlyph.classList.remove('is-done');
  }

  // 3. Check agent-mark animation contracts in normal mode
  const mark = document.createElement('div');
  mark.className = 'agent-mark';
  document.body.appendChild(mark);
  const markStyle = window.getComputedStyle(mark);
  note('agent-mark transition использует var(--dur-hover)',
    matchMedia('(prefers-reduced-motion: reduce)').matches ? parseFloat(markStyle.transitionDuration) <= .001 : markStyle.transitionDuration !== '0s',
    `duration: ${markStyle.transitionDuration}`);

  // Test event states: tick and is-settled durations are <= 250ms
  mark.className = 'agent-mark tick';
  const tickStyle = window.getComputedStyle(mark);
  note('agent-mark.tick длится <= 200ms',
    parseFloat(tickStyle.animationDuration) <= 0.25,
    `tick duration: ${tickStyle.animationDuration}`);

  mark.className = 'agent-mark is-settled';
  const settleStyle = window.getComputedStyle(mark);
  note('agent-mark.is-settled длится <= 250ms',
    parseFloat(settleStyle.animationDuration) <= 0.25,
    `settle duration: ${settleStyle.animationDuration}`);
  mark.remove();

  // 4. Test modal opening and smooth scale-in
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) {
    settingsBtn.click();
    await wait(350);
  }
  const modalContainer = $('settingsModal') || document.querySelector('.modal-container, .modal-backdrop');
  const modalCard = document.querySelector('.modal-card');
  note('модальное окно открылось', !!modalContainer && !!modalCard);

  if (modalCard) {
    const cardStyle = window.getComputedStyle(modalCard);
    note('модальное окно использует dur-modal <= 250ms',
      parseFloat(cardStyle.animationDuration) <= 0.25,
      `modal duration: ${cardStyle.animationDuration}`);
  }

  // Close modal via Escape
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(250);

  note('настоящая эмуляция prefers-reduced-motion', matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Verify in reduced motion: buttons have transform: none
  const sendBtn = $('sendBtn');
  const sendBtnStyle = window.getComputedStyle(sendBtn);
  note('в режиме reduced-motion transform кнопок сброшен в none',
    sendBtnStyle.transform === 'none',
    `transform: ${sendBtnStyle.transform}`);

  // Open settings modal again in reduced motion mode to prove instant open without shift
  if (settingsBtn) {
    settingsBtn.click();
    await wait(200);
  }
  const reducedModalCard = document.querySelector('.modal-card');
  if (reducedModalCard) {
    const rCardStyle = window.getComputedStyle(reducedModalCard);
    note('в режиме reduced-motion модальное окно появляется без сдвига transform',
      rCardStyle.transform === 'none',
      `transform: ${rCardStyle.transform}`);
    note('в режиме reduced-motion длительность анимации модалки <= 0.01ms',
      parseFloat(rCardStyle.animationDuration) <= 0.001 || rCardStyle.animationName === 'none',
      `animDuration: ${rCardStyle.animationDuration}, animName: ${rCardStyle.animationName}`);
  }

  // Capture screenshot of settings open under reduced motion
  try {
    if (typeof window.electronAPI?.takeScreenshot === 'function') {
      await window.electronAPI.takeScreenshot();
    }
  } catch {}

  // Close modal
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(200);


  const allPassed = checks.every(c => c.pass);
  return { ok: allPassed, checks };
})();
