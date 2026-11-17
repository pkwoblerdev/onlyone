/* Управление отправкой хода (план, 2d).
 * Кнопка «отправить» меняет вид вместе с ходом, знак в шапке окна дышит,
 * неотправленное сообщение лежит полосой под полем ввода, а остановка хода
 * собирает воедино и чат, и Design.
 *
 * Отдельный файл потому, что это один прибор: состояние кнопки, очередь и
 * остановка. В `app.js` их части были разбросаны между оркестровкой хода и
 * разметкой превью. Очередь дизайнов остаётся видимой окну — она нужна тому,
 * кто продолжает прерванный ход.
 */
(function (root) {
  'use strict'

  // Что нужно от окна, приходит проводкой при первом обращении: к этому
  // моменту `app.js` уже объявил всё, что передаёт.
  let $, el, t, escapeHtml, showToast, cleanErrorText, renderSuggestion, allTasks, clearAgentTasks, settleAgentTasks, renderAgentTasks, getPanes, getActiveDesign, getDesignRun, onDesignQueueDrop

  function create(deps) {
    ;({ $, el, t, escapeHtml, showToast, cleanErrorText, renderSuggestion, allTasks, clearAgentTasks, settleAgentTasks, renderAgentTasks, getPanes, getActiveDesign, getDesignRun, onDesignQueueDrop } = deps)
    return Object.freeze({
      paintGlyph,
      paintSendButton,
      stopDesignRun,
      designQueue,
      queuedFor,
      renderDesignQueue,
      paintDesignSendButton,
      stopTurn,
      setGeneratingState,
      renderQueued
    })
  }

  // Знак в шапке окна живёт вместе с ходом: дышит, пока работа идёт, и один раз
  // вспыхивает, когда она кончилась. Считается по всем панелям сразу — в
  // раздельном режиме ход может идти во второй, пока первая уже свободна.
  function paintGlyph() {
    const el = $('appGlyph')
    if (!el) return
    let working = getPanes().some(p => p.generating)
    if (!working) {
      for (const p of getPanes()) {
        if (p.liveTurnsByChat) {
          for (const turn of p.liveTurnsByChat.values()) {
            if (turn.generating) { working = true; break }
          }
        }
        if (working) break
      }
    }
    if (working) {
      el.classList.remove('is-done')
      el.classList.add('is-working')
      return
    }
    if (!el.classList.contains('is-working')) return
    el.classList.remove('is-working')
    // Перезапуск анимации: без принудительной перерисовки второй ход подряд не
    // мигнёт вовсе — браузер считает, что класс и не менялся.
    void el.offsetWidth
    el.classList.add('is-done')
  }

  // Кнопка отправки во время хода: квадрат, пока поле пустое, и стрелка, как
  // только что-то набрано. Набранное во время ответа не пропадает — оно встаёт
  // в очередь и уходит следующим ходом, поэтому отнимать у него кнопку нельзя.
  function paintSendButton(pane) {
    const btn = pane.dom?.sendBtn
    if (!btn) return
    const typed = Boolean(pane.dom.textarea?.value.trim())
    const stopping = (pane.generating || pane.preparing) && !typed
    const send = btn.querySelector('.send-icon')
    const stop = btn.querySelector('.stop-icon')
    if (send) send.style.display = stopping ? 'none' : 'block'
    if (stop) stop.style.display = stopping ? 'block' : 'none'
    btn.classList.toggle('is-stop', stopping)
    btn.dataset.tooltip = stopping ? t('Остановить') : (pane.generating || pane.preparing)
      ? t('Добавить сообщение в очередь')
      : t('Отправить (Enter)')
    btn?.removeAttribute?.('title')
  }

  // Остановка хода в Дизайне. Своей кнопки у неё больше нет: зовут её кнопка
  // отправки в состоянии «стоп» и квадрат в панели работы.
  async function stopDesignRun() {
    const run = getDesignRun()
    if (!run) return
    const btn = $('designSendBtn')
    if (btn) btn.disabled = true
    try {
      await window.electronAPI.abortMessage(run.requestId)
    } catch (err) {
      showToast(cleanErrorText(err), true)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  // Кнопка отправки в Дизайне живёт по тем же правилам, что и в чате: пустое
  // поле останавливает ход, набранный текст ставится в очередь.
  // Очередь привязана к дизайну: уходя в другой, человек не должен обнаружить
  // там чужое отложенное сообщение.
  const designQueue = new Map()

  // В очереди лежит будущий ход целиком: текст, скрытая опись продолжения и id
  // хода. Полосе под полем ввода нужен только текст.
  function queuedFor(designId) {
    return String((designId ? designQueue.get(designId) : null)?.text || '')
  }

  function renderDesignQueue() {
    const card = $('designComposerCard')
    if (!card) return
    const text = queuedFor(getActiveDesign()?.id)
    let strip = card.querySelector('.queued-strip')
    if (!text) { strip?.remove(); return }
    if (!strip) {
      strip = document.createElement('div')
      strip.className = 'queued-strip'
      card.insertBefore(strip, card.firstChild)
    }
    strip.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'queued-item'
    row.innerHTML = `
      <svg fill="none" class="icon small" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.4"/></svg>
      <span class="queued-text"></span>
      <button type="button" class="queued-drop" data-tooltip="${escapeHtml(t('Убрать из очереди'))}" aria-label="${escapeHtml(t('Убрать из очереди'))}"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>`
    row.querySelector('.queued-text').textContent = text
    row.querySelector('.queued-drop').addEventListener('click', () => {
      const designId = getActiveDesign()?.id
      const entry = designId ? designQueue.get(designId) : null
      if (designId) designQueue.delete(designId)
      renderDesignQueue()
      if (entry?.resumeRunId) onDesignQueueDrop?.(designId, entry)
    })
    strip.appendChild(row)
  }

  function paintDesignSendButton(running) {
    const btn = $('designSendBtn')
    if (!btn) return
    const typed = Boolean($('designComposerTextarea')?.value.trim())
    const stopping = Boolean(running) && !typed
    const send = btn.querySelector('.send-icon')
    const stop = btn.querySelector('.stop-icon')
    if (send) send.style.display = stopping ? 'none' : 'block'
    if (stop) stop.style.display = stopping ? 'block' : 'none'
    btn.classList.toggle('is-stop', stopping)
    btn.dataset.tooltip = stopping ? t('Остановить') : running && typed
      ? t('Добавить сообщение в очередь')
      : t('Отправить (Enter)')
    btn?.removeAttribute?.('title')
    btn.dataset.stop = stopping ? '1' : ''
  }

  async function stopTurn(pane) {
    const id = pane.requestId || pane.liveTurnsByChat?.get(pane.chatId)?.requestId
    if (!id) return
    const btn = pane.dom?.sendBtn
    if (btn) btn.disabled = true
    try { await window.electronAPI?.abortMessage?.(id) }
    finally { if (btn) btn.disabled = false }
  }

  function setGeneratingState(pane, generating) {
    const targetChatId = arguments[2] || pane?.chatId
    pane.generating = generating
    if (targetChatId) {
      pane.liveTurnsByChat = pane.liveTurnsByChat || new Map()
      const turn = pane.liveTurnsByChat.get(targetChatId)
      if (turn) {
        turn.generating = generating
        if (!generating) {
          turn.assistantEl = null
          turn.requestId = null
        }
      } else if (generating) {
        pane.liveTurnsByChat.set(targetChatId, {
          generating: true,
          preparing: false,
          requestId: pane.requestId,
          liveChatId: targetChatId
        })
      }
    }
    paintGlyph()

    if (!generating) {
      settleAgentTasks(pane)
      const tasks = allTasks(pane)
      if (tasks.length && !pane.tasksFinishedDuration) {
        const earliest = tasks.reduce((first, task) => Math.min(first, task.since || Date.now()), Date.now())
        pane.tasksFinishedDuration = Math.max(1, Math.round((Date.now() - earliest) / 1000))
      }
      if (pane.agentTaskTimer) {
        clearInterval(pane.agentTaskTimer)
        pane.agentTaskTimer = null
      }
    } else {
      pane.tasksFinishedDuration = null
    }

    // Who was doing what is a live question. Once the turn is over the answer
    // is in the transcript, so the panel goes rather than freezing on the last
    // thing anybody happened to be doing.
    if (generating) clearAgentTasks(pane)
    else renderAgentTasks(pane)
    paintSendButton(pane)

    // The turn is over — anything typed during it goes now, joined into one
    // message so a train of thoughts arrives as a train of thoughts.
    // Offered only when the turn is over and the field is empty.
    renderSuggestion(pane)

    if (!generating && pane.queued?.length) {
      pane.queued = []
      renderQueued(pane)
    }
  }

  // Queued text is invisible otherwise: it left the input and nothing showed
  // where it went.
  function renderQueued(pane) {
    const card = pane.dom.card
    if (!card) return

    let strip = card.querySelector('.queued-strip')
    if (!pane.queued.length) {
      strip?.remove()
      return
    }

    if (!strip) {
      strip = document.createElement('div')
      strip.className = 'queued-strip'
      card.insertBefore(strip, card.firstChild)
    }

    strip.innerHTML = ''
    pane.queued.forEach((text, index) => {
      const row = document.createElement('div')
      row.className = 'queued-item'
      row.innerHTML = `
        <svg fill="none" class="icon small" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.4"/></svg>
        <span class="queued-text">${escapeHtml(text)}</span>
        <button type="button" class="queued-drop" data-tooltip="Убрать из очереди" aria-label="Убрать из очереди"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
      `
      row.querySelector('.queued-drop').addEventListener('click', () => {
        pane.queued.splice(index, 1)
        renderQueued(pane)
      })
      strip.appendChild(row)
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneSendControls = api
})(typeof window === 'object' ? window : globalThis)
