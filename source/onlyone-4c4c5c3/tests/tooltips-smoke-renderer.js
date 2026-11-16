// In-window renderer checks for milestone 1.4: custom tooltips.
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

  const booted = await until(() => $('messagesList') && $('newChatBtn') && $('sendBtn'));
  note('интерфейс загрузился', booted);
  if (!booted) return { ok: false, checks };

  await wait(800); // Async initialization

  // 1. Check no native title attributes on interactive elements
  const interactiveWithTitle = document.querySelectorAll(
    'button[title], a[title], input[title], textarea[title], select[title], [role="button"][title], [tabindex][title]'
  );
  note('отсутствуют нативные title у интерактивных элементов',
    interactiveWithTitle.length === 0,
    interactiveWithTitle.length > 0 ? Array.from(interactiveWithTitle).map(e => e.outerHTML.slice(0, 80)).join('; ') : '0 найдено'
  );

  // Chromium не шлёт focusin, пока у окна нет фокуса Windows, а окно прогона,
  // запущенное в фоне, его не получает (Windows не даёт перехватить передний
  // план). Проверяется логика подсказки, а не то, кто сейчас впереди на экране.
  const focusOn = el => {
    el.focus();
    if (!document.hasFocus()) el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  };

  // 2. Test tooltip triggering via focus on #newChatBtn
  const newChatBtn = $('newChatBtn');
  note('кнопка нового диалога имеет data-tooltip', !!newChatBtn?.dataset?.tooltip, newChatBtn?.dataset?.tooltip || '');

  focusOn(newChatBtn);
  await wait(100);

  const tip = document.getElementById('onlyone-global-tooltip');
  note('контейнер подсказки создан в DOM', !!tip);

  const tipVisibleOnFocus = await until(() => tip && !tip.hidden && tip.classList.contains('is-visible'), 2000);
  note('подсказка показана при фокусе', tipVisibleOnFocus);

  const tipText = tip?.querySelector('.ui-tooltip-text')?.textContent || '';
  const tipKbd = tip?.querySelector('.ui-tooltip-kbd')?.textContent || '';
  note('текст подсказки корректный', tipText === 'Новый чат', `текст: "${tipText}"`);
  note('сочетание клавиш выделено в чип kbd', tipKbd === 'Ctrl+N', `клавиши: "${tipKbd}"`);

  // 3. Test Escape hides the tooltip
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(250);
  note('подсказка скрывается по нажатию Escape', tip && (!tip.classList.contains('is-visible') || tip.hidden));

  // 3b. Длинная подсказка (режим: «Auto · Без вопросов; удаление…») переносится,
  // а не прокручивается: полосы в подсказке быть не должно (владелец, 25.10).
  const permBtn = $('permModeBtn');
  // Прогон стартует в Manual, его фраза короче и влезает; у Auto и Accept Edits
  // длиннее — ставим ту строку, что видел владелец (renderPermissionMode пишет её так же).
  permBtn.dataset.tooltip = 'Auto · Без вопросов; удаление — всегда с вопросом';
  if (document.activeElement) document.activeElement.blur();
  await wait(150);
  focusOn(permBtn);
  const permShown = await until(() => tip && !tip.hidden && tip.classList.contains('is-visible') && /·/.test(tip.textContent), 3000);
  note('подсказка режима показана', permShown, tip?.textContent || '');
  // Полоса прокрутки занимает место внутри рамки: её толщина — разница между
  // внешним размером и клиентской областью (рамки у подсказки нет).
  const barH = tip.offsetHeight - tip.clientHeight;
  const barW = tip.offsetWidth - tip.clientWidth;
  const text = tip.querySelector('.ui-tooltip-text');
  const clipped = text ? text.getBoundingClientRect().right > tip.getBoundingClientRect().right + 1 : true;
  note('у длинной подсказки нет полосы прокрутки', permShown && barH <= 0 && barW <= 0 && !clipped,
    `полоса ${barW}x${barH}, текст за краем: ${clipped}, ${tip.offsetWidth}x${tip.offsetHeight}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(250);

  // Blur active element
  if (document.activeElement) document.activeElement.blur();
  await wait(100);

  // 4. Test hover / focus on #newChatBtn for screenshot capture
  // We want the tooltip clearly visible for the screenshot.
  focusOn(newChatBtn);
  const tipVisibleForShot = await until(() => tip && !tip.hidden && tip.classList.contains('is-visible'), 3000);
  note('подсказка активирована для снимка', tipVisibleForShot);
  await wait(300); // Give Chromium animation frame time to settle for screenshot

  const rect = tip.getBoundingClientRect();
  const cs = window.getComputedStyle(tip);
  note('параметры подсказки перед снимком', true, JSON.stringify({
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    opacity: cs.opacity,
    zIndex: cs.zIndex,
    display: cs.display,
    hidden: tip.hidden,
    classList: Array.from(tip.classList)
  }));

  return { ok: checks.every(c => c.pass), checks };
})();
