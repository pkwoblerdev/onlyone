/* Проводка удалённого управления в окне (волна 4): раздел настроек, мост к чатам и команда /remote-control.
 * Вынесено из app.js, чтобы тот не рос: здесь только сборка из того, что окно отдаёт в ctx. */
(function (root) {
  'use strict'

  function setup(ctx) {
    const api = ctx.electronAPI
    if (!api || !api.remoteState || !root.OnlyoneRemoteBridge) return null
    const settings = root.OnlyoneRemoteSettings.create({ electronAPI: api, t: ctx.t, $: ctx.$, document: ctx.document, escapeHtml: ctx.escapeHtml, showToast: ctx.showToast, confirm: ctx.askConfirm })
    settings.setup()
    const bridge = root.OnlyoneRemoteBridge.create({
      conversations: ctx.conversations, panes: ctx.panes,
      send: ctx.send, select: ctx.select,
      emit: payload => ctx.electronAPI.remoteChatChanged(payload),
      setRemote: (chat, value) => { chat.remote = value; ctx.saveConversations(); ctx.renderChatHistory(); ctx.renderChatHeader(ctx.panes()[0]) },
      settings: {
        models: () => ctx.modelCatalog().filter(m => !m.unavailable).slice(0, 300).map(m => ({ id: m.id, name: m.name, isFree: Boolean(m.isFree) })),
        get: () => { const model = ctx.selectedModel(); return { model: model && model.id, modelName: model && model.name, effort: ctx.effort(), stops: ctx.effortStops(model) } },
        set: ({ model, effort }) => { const found = model && ctx.modelCatalog().find(m => m.id === model); if (found) ctx.setModel(found); if (effort) ctx.setEffort(effort) }
      },
      shot: async () => { const panel = ctx.browserPanel(); return panel && panel.shot ? panel.shot() : null },
      tasks: id => ctx.planItems(ctx.panes().find(p => p.chatId === id || p.liveChatId === id) || {})
    })
    bridge.start()
    bridge.attach(api)
    // /remote-control в чате: включает и выключает его показ на телефоне.
    const toggle = chat => {
      if (!chat) { ctx.showToast('Сначала откройте чат'); return }
      const on = bridge.toggle(chat)
      ctx.showToast(on ? 'Чат виден на телефоне' : 'Чат скрыт от телефона')
      if (on) Promise.resolve(api.remoteState()).then(state => { if (!state.enabled) ctx.showToast('Включите «Удалённое управление» в настройках, чтобы телефон подключился') }).catch(() => {})
    }
    return { bridge, settings, toggle }
  }

  root.OnlyoneRemoteWiring = { setup }
})(typeof window !== 'undefined' ? window : globalThis)
