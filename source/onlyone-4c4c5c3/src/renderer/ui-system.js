/* Small DOM behaviours shared by specimen and future screen migrations.
   No Electron bridge, network, settings or model access. */
(() => {
  const mounted = new WeakMap();
  function mount(root) {
    if (mounted.has(root)) return mounted.get(root);
    const cleanup = [];
    const listen = (el, name, fn, options) => { el.addEventListener(name, fn, options); cleanup.push(() => el.removeEventListener(name, fn, options)); };
    for (const box of root.querySelectorAll('.ui-select')) {
      const trigger = box.querySelector('[aria-haspopup="listbox"]');
      const list = box.querySelector('[role="listbox"]');
      const items = [...list.querySelectorAll('[role="option"]')];
      let prefix = '', prefixTime = 0;
      const close = (focus = false) => { list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
      const open = () => {
        list.hidden = false; trigger.setAttribute('aria-expanded', 'true');
        (items.find(el => el.getAttribute('aria-selected') === 'true') || items[0])?.focus();
      };
      const choose = item => {
        items.forEach(el => el.setAttribute('aria-selected', String(el === item)));
        trigger.querySelector('[data-value-label]').textContent = item.textContent;
        box.dataset.value = item.dataset.value;
        close(true); box.dispatchEvent(new Event('change', { bubbles: true }));
      };
      listen(trigger, 'click', () => { if (list.hidden) open(); else close(); });
      listen(trigger, 'keydown', e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
      listen(list, 'click', e => { const item = e.target.closest('[role="option"]'); if (items.includes(item)) choose(item); });
      listen(list, 'keydown', e => {
        const current = items.indexOf(document.activeElement);
        let target;
        if (e.key === 'ArrowDown') target = (current + 1) % items.length;
        if (e.key === 'ArrowUp') target = (current - 1 + items.length) % items.length;
        if (e.key === 'Home') target = 0;
        if (e.key === 'End') target = items.length - 1;
        if (target !== undefined) { e.preventDefault(); items[target]?.focus(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (items[current]) choose(items[current]); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'Tab') close(true); // Let native traversal continue from the trigger.
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          prefix = Date.now() - prefixTime > 700 ? e.key : prefix + e.key; prefixTime = Date.now();
          const item = items.find(el => el.textContent.trim().toLowerCase().startsWith(prefix.toLowerCase()));
          if (item) { e.preventDefault(); item.focus(); }
        }
      });
      listen(document, 'pointerdown', e => { if (!box.contains(e.target)) close(); });
      listen(box, 'focusout', e => { if (!box.contains(e.relatedTarget)) close(); });
      listen(window, 'resize', () => close());
    }
    for (const list of root.querySelectorAll('[role="tablist"]')) {
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const select = tab => {
        tabs.forEach(el => {
          const selected = el === tab;
          el.setAttribute('aria-selected', String(selected)); el.tabIndex = selected ? 0 : -1;
          const panel = root.querySelector('#' + CSS.escape(el.getAttribute('aria-controls')));
          if (panel) panel.hidden = !selected;
        });
        tab.focus();
      };
      listen(list, 'click', e => { const tab = e.target.closest('[role="tab"]'); if (tabs.includes(tab)) select(tab); });
      listen(list, 'keydown', e => {
        const index = tabs.indexOf(document.activeElement);
        const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (next >= 0) { e.preventDefault(); select(tabs[next]); }
      });
    }
    for (const wrap of root.querySelectorAll('.ui-tip-wrap')) {
      const tip = wrap.querySelector('[role="tooltip"]');
      let timer;
      const show = () => {
        clearTimeout(timer); tip.hidden = false; tip.classList.add('is-visible');
        const anchor = wrap.getBoundingClientRect(), r = tip.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(root.documentElement || root).getPropertyValue('--ui-space-2')) || 8;
        tip.style.left = Math.max(gap, Math.min(anchor.left, innerWidth - r.width - gap)) + 'px';
        tip.style.top = Math.max(gap, anchor.top >= r.height + gap ? anchor.top - r.height - gap : anchor.bottom + gap) + 'px';
      };
      const hide = () => { clearTimeout(timer); tip.hidden = true; tip.classList.remove('is-visible'); };
      // The short bridge lets the pointer move across the gap onto the tooltip.
      listen(wrap, 'pointerenter', show); listen(wrap, 'pointerleave', () => { timer = setTimeout(hide, 120); });
      listen(wrap, 'focusin', show); listen(wrap, 'focusout', hide);
      listen(document, 'keydown', e => { if (e.key === 'Escape') hide(); });
      listen(window, 'scroll', hide, true); listen(window, 'resize', hide);
      cleanup.push(hide);
    }
    for (const trigger of root.querySelectorAll('[data-dialog]')) {
      const dialog = root.querySelector('#' + CSS.escape(trigger.dataset.dialog));
      listen(trigger, 'click', () => dialog.showModal());
      listen(dialog, 'close', () => trigger.focus());
    }
    for (const button of root.querySelectorAll('[data-close-dialog]')) {
      listen(button, 'click', () => button.closest('dialog').close());
    }
    for (const button of root.querySelectorAll('[data-dismiss]')) {
      listen(button, 'click', () => {
        const target = button.closest('[data-dismissible]');
        const next = target.nextElementSibling?.querySelector('button') || root.querySelector('[data-dismiss-focus]');
        target.hidden = true; next?.focus();
      });
    }
    const dispose = () => { cleanup.forEach(fn => fn()); mounted.delete(root); };
    mounted.set(root, dispose);
    initGlobalTooltips();
    return dispose;
  }

  let globalTooltipInited = false;
  function initGlobalTooltips() {
    if (globalTooltipInited || typeof document === 'undefined') return;
    globalTooltipInited = true;

    let tip = document.getElementById('onlyone-global-tooltip');
    if (!tip && document.body) {
      tip = document.createElement('div');
      tip.id = 'onlyone-global-tooltip';
      tip.className = 'ui-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
      document.body.appendChild(tip);
    }

    let activeAnchor = null;
    let showTimer = null;
    let hideTimer = null;
    let leaveTimer = null;
    let warmUntil = 0;
    let describedAnchor = null;
    let priorDescription = null;
    const unlinkDescription = () => {
      if (!describedAnchor) return;
      if (priorDescription === null) describedAnchor.removeAttribute('aria-describedby');
      else describedAnchor.setAttribute('aria-describedby', priorDescription);
      describedAnchor = null; priorDescription = null;
    };

    const parseContent = (target) => {
      let text = (target.getAttribute('data-tooltip') || '').trim();
      let shortcut = (target.getAttribute('data-tooltip-shortcut') || '').trim();
      if (!shortcut) {
        const match = text.match(/\(((?:Ctrl|Alt|Shift)\+[A-Za-z0-9,\.]+|Enter|Esc|Tab)\)$/i);
        if (match) {
          shortcut = match[1];
          text = text.slice(0, match.index).trim();
        }
      }
      return { text, shortcut };
    };

    const position = (anchor) => {
      if (!anchor || tip.hidden) return;
      const rect = anchor.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const gap = 6;
      const margin = 8;

      let top = rect.bottom + gap;
      if (top + tipRect.height > window.innerHeight - margin && rect.top - tipRect.height - gap >= margin) {
        top = rect.top - tipRect.height - gap;
      }

      let left = rect.left + (rect.width - tipRect.width) / 2;
      if (left < margin) left = margin;
      if (left + tipRect.width > window.innerWidth - margin) {
        left = window.innerWidth - margin - tipRect.width;
      }

      tip.style.top = Math.round(top) + 'px';
      tip.style.left = Math.round(left) + 'px';
    };

    const show = (anchor, immediate = false) => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearTimeout(leaveTimer);
      if (!anchor || !document.contains(anchor)) return;
      if (activeAnchor !== anchor) unlinkDescription();
      activeAnchor = anchor;

      const { text, shortcut } = parseContent(anchor);
      if (!text) {
        hide();
        return;
      }

      const render = () => {
        if (activeAnchor !== anchor) return;
        if (!tip && document.body) {
          tip = document.getElementById('onlyone-global-tooltip');
          if (!tip) {
            tip = document.createElement('div');
            tip.id = 'onlyone-global-tooltip';
            tip.className = 'ui-tooltip';
            tip.setAttribute('role', 'tooltip');
            tip.hidden = true;
            document.body.appendChild(tip);
          }
        }
        if (!tip) return;
        tip.textContent = '';
        const textSpan = document.createElement('span');
        textSpan.className = 'ui-tooltip-text';
        textSpan.textContent = text;
        tip.appendChild(textSpan);

        if (shortcut) {
          const kbd = document.createElement('kbd');
          kbd.className = 'ui-tooltip-kbd';
          kbd.textContent = shortcut;
          tip.appendChild(kbd);
        }

        tip.hidden = false;
        if (describedAnchor !== anchor) {
          unlinkDescription();
          describedAnchor = anchor;
          priorDescription = anchor.getAttribute('aria-describedby');
          anchor.setAttribute('aria-describedby', [priorDescription, tip.id].filter(Boolean).join(' '));
        }
        position(anchor);
        requestAnimationFrame(() => {
          if (activeAnchor === anchor) tip.classList.add('is-visible');
        });
        warmUntil = Date.now() + 500;
      };

      const isWarm = Date.now() < warmUntil;
      if (immediate || isWarm) {
        render();
      } else {
        showTimer = setTimeout(render, 300);
      }
    };

    const hide = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearTimeout(leaveTimer);
      unlinkDescription();
      activeAnchor = null;
      if (!tip || tip.hidden) return;
      tip.classList.remove('is-visible');
      hideTimer = setTimeout(() => {
        if (tip) tip.hidden = true;
        activeAnchor = null;
      }, 120);
      warmUntil = Date.now() + 300;
    };

    document.addEventListener('pointerenter', (e) => {
      const anchor = e.target.closest?.('[data-tooltip]');
      if (anchor?.contains(e.relatedTarget)) return;
      if (anchor) show(anchor, false);
    }, true);

    document.addEventListener('pointerleave', (e) => {
      const anchor = e.target.closest?.('[data-tooltip]');
      if (anchor?.contains(e.relatedTarget)) return;
      if (tip?.contains(e.relatedTarget)) return;
      if (anchor && anchor === activeAnchor) leaveTimer = setTimeout(hide, 120);
    }, true);
    tip?.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
    tip?.addEventListener('pointerleave', () => { leaveTimer = setTimeout(hide, 120); });

    document.addEventListener('focusin', (e) => {
      const anchor = e.target.closest?.('[data-tooltip]');
      if (anchor) show(anchor, true);
    }, true);

    document.addEventListener('focusout', (e) => {
      const anchor = e.target.closest?.('[data-tooltip]');
      if (anchor && anchor === activeAnchor) hide();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    }, true);

    document.addEventListener('click', () => hide(), true);
    window.addEventListener('scroll', (e) => {
      if (!activeAnchor) return;
      const t = e.target;
      if (t === document || t === window || (t && typeof t.contains === 'function' && t.contains(activeAnchor))) {
        hide();
      }
    }, true);
    window.addEventListener('resize', () => hide(), true);
  }

  let emojiRegex;
  try {
    emojiRegex = new RegExp('\\p{RGI_Emoji}', 'gv');
  } catch {
    emojiRegex = /\p{Extended_Pictographic}/gu;
  }

  function formatWithEmoji(text) {
    if (!text || typeof text !== 'string') return text || '';
    emojiRegex.lastIndex = 0;
    if (!emojiRegex.test(text)) return text;
    emojiRegex.lastIndex = 0;
    // Input is already escaped/sanitized by callers. This is NOT a sanitizer.
    // An inert template parses quoted ">" correctly; regex splitting did not.
    const template = document.createElement('template');
    template.innerHTML = text;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('pre,code,script,style,textarea,title,svg,math,.ui-emoji')) continue;
      emojiRegex.lastIndex = 0;
      const matches = [...node.data.matchAll(emojiRegex)];
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let end = 0;
      for (const match of matches) {
        fragment.append(document.createTextNode(node.data.slice(end, match.index)));
        const span = document.createElement('span');
        span.className = 'ui-emoji'; span.setAttribute('role', 'img');
        span.setAttribute('aria-label', match[0]); span.textContent = match[0];
        fragment.append(span); end = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(node.data.slice(end)));
      node.replaceWith(fragment);
    }
    return template.innerHTML;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initGlobalTooltips);
    } else {
      initGlobalTooltips();
    }
  }

  window.formatWithEmoji = formatWithEmoji;
  window.OnlyoneUI = Object.freeze({ mount, initGlobalTooltips, formatWithEmoji });
})();
