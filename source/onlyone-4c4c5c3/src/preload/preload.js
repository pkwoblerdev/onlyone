const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Оконные проверки идут на свежем профиле: вступительный экран первого запуска
// закрыл бы им всё окно. Проверка самого экрана включает его явно.
const automatedRun = (() => {
  try { return Boolean(process.env.ONECODE_SMOKE) && !process.env.ONECODE_ONBOARDING } catch { return false }
})()

contextBridge.exposeInMainWorld('electronAPI', {
  automatedRun,
  openDesk: chatId => ipcRenderer.invoke('desk:open', chatId),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  fetchModels: options => ipcRenderer.invoke('fetch-models', options),
  sendMessage: payload => ipcRenderer.invoke('send-message', payload),
  abortMessage: requestId => ipcRenderer.invoke('abort-message', requestId),
  interruptedRuns: () => ipcRenderer.invoke('interrupted-runs'),
  dismissInterruptedRun: runId => ipcRenderer.invoke('dismiss-interrupted-run', runId),
  getSelfDev: () => ipcRenderer.invoke('get-self-dev'),
  setSelfDevPath: dir => ipcRenderer.invoke('set-self-dev-path', dir),
  toggleSelfDev: on => ipcRenderer.invoke('toggle-self-dev', on),
  attachmentThumbnail: path => ipcRenderer.invoke('attachment-thumbnail', path),
  savePastedImage: dataUrl => ipcRenderer.invoke('save-pasted-image', { dataUrl }),
  savePastedText: text => ipcRenderer.invoke('save-pasted-text', { text }),
  onProjectsChanged: cb => ipcRenderer.on('projects-changed', (_e, data) => cb(data)),
  onConversationsChanged: cb => ipcRenderer.on('conversations-changed', (_e, data) => cb(data)),
  undoAgentChanges: (requestId, selection) => ipcRenderer.invoke('undo-agent-changes', requestId, selection),
  reviewAgentChanges: input => ipcRenderer.invoke('review-agent-changes', input),
  previewAgentChange: input => ipcRenderer.invoke('preview-agent-change', input),
  reviewAgentSections: input => ipcRenderer.invoke('review-agent-sections', input),
  previewAgentSection: input => ipcRenderer.invoke('preview-agent-section', input),
  undoAgentSections: input => ipcRenderer.invoke('undo-agent-sections', input),
  getMemorySetting: () => ipcRenderer.invoke('get-memory-setting'),
  setMemorySetting: enabled => ipcRenderer.invoke('set-memory-setting', enabled),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  setUpdateSettings: payload => ipcRenderer.invoke('set-update-settings', payload),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateState: callback => ipcRenderer.on('update-state', (_e, state) => callback(state)),
  // Расписания (план, 3.5): экран видит только публичную вьюху записи — срок
  // словами, состояние, исход. Текст просьбы в окно не приезжает.
  getSchedules: () => ipcRenderer.invoke('get-schedules'),
  setSchedule: record => ipcRenderer.invoke('set-schedule', record),
  deleteSchedule: id => ipcRenderer.invoke('delete-schedule', id),
  runScheduleNow: id => ipcRenderer.invoke('run-schedule-now', id),
  setScheduleEnabled: (id, enabled) => ipcRenderer.invoke('set-schedule-enabled', { id, enabled }),
  // Текст просьбы нужен одному месту — форме правки. В списке и в событиях его
  // нет, и сам экран его не кэширует.
  getSchedulePrompt: id => ipcRenderer.invoke('get-schedule-prompt', id),
  onScheduleEvent: callback => ipcRenderer.on('schedule-event', (_e, body) => callback(body)),
  // Срок наступил: главный процесс просит окно выполнить ход расписания и ждёт
  // итога отдельным односторонним каналом — ответ ему не возвращаемый вызов.
  onScheduleTurn: callback => ipcRenderer.on('schedule-request-turn', (_e, body) => callback(body)),
  reportScheduleResult: body => ipcRenderer.send('schedule-turn-result', body),
  // Очередь фоновых задач (план, 3.4): экран видит карточку и те действия,
  // которые планировщик разрешил. Командной строки задачи в этом мосту нет.
  getTasks: () => ipcRenderer.invoke('task-list'),
  pauseTask: id => ipcRenderer.invoke('task-pause', { id }),
  resumeTask: id => ipcRenderer.invoke('task-resume', { id }),
  cancelTask: id => ipcRenderer.invoke('task-cancel', { id }),
  restartTask: id => ipcRenderer.invoke('task-restart', { id }),
  removeTask: id => ipcRenderer.invoke('task-remove', { id }),
  stopAgent: payload => ipcRenderer.invoke('stop-agent', payload),
  onTaskEvent: callback => ipcRenderer.on('task-event', (_e, body) => callback(body)),
  getOpenRouterKeys: () => ipcRenderer.invoke('get-openrouter-keys'),
  addOpenRouterKey: payload => ipcRenderer.invoke('add-openrouter-key', payload),
  removeOpenRouterKey: id => ipcRenderer.invoke('remove-openrouter-key', id),
  toggleOpenRouterKey: payload => ipcRenderer.invoke('toggle-openrouter-key', payload),
  resetOpenRouterKeyCooldown: id => ipcRenderer.invoke('reset-openrouter-key-cooldown', id),
  // Свои OpenAI-совместимые подключения (план, 2.8): ключ уходит в главный
  // процесс и обратно не возвращается — в ответе только маска.
  getCustomProvider: () => ipcRenderer.invoke('get-custom-provider'),
  setCustomProvider: payload => ipcRenderer.invoke('set-custom-provider', payload),
  addCustomProvider: payload => ipcRenderer.invoke('add-custom-provider', payload),
  removeCustomProvider: id => ipcRenderer.invoke('remove-custom-provider', id),
  chooseCustomProvider: id => ipcRenderer.invoke('choose-custom-provider', id),
  checkCustomProvider: payload => ipcRenderer.invoke('check-custom-provider', payload),
  setActiveProvider: id => ipcRenderer.invoke('set-active-provider', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: settings => ipcRenderer.invoke('set-settings', settings),
  getBudgetSettings: () => ipcRenderer.invoke('get-budget-settings'),
  setBudgetSettings: settings => ipcRenderer.invoke('set-budget-settings', settings),
  getUiConfig: () => ipcRenderer.invoke('get-ui-config'),
  setUiConfig: config => ipcRenderer.invoke('set-ui-config', config),
  resetUiConfig: () => ipcRenderer.invoke('reset-ui-config'),
  // U-2: место и размер свободных блоков Ultra (главный процесс держит их в
  // зашифрованном файле профиля).
  getUltraLayout: () => ipcRenderer.invoke('get-ultra-layout'),
  setUltraLayout: map => ipcRenderer.invoke('set-ultra-layout', map),
  onUiConfigChanged: callback => {
    const handler = (_, config) => callback(config)
    ipcRenderer.on('ui-config-changed', handler)
    return () => ipcRenderer.removeListener('ui-config-changed', handler)
  },
  getWorkspace: () => ipcRenderer.invoke('get-workspace'),
  selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
  setWorkspace: workspace => ipcRenderer.invoke('set-workspace', workspace),
  // U-7: Workspace Ultra — то, что человек КРАФТИТ и чем делится. Не путать с
  // тремя каналами выше: там рабочая ПАПКА проекта, здесь расположение блоков,
  // агенты, инструменты, файлы, контекст и сценарии.
  getUltraWorkspace: () => ipcRenderer.invoke('get-ultra-workspace'),
  previewUltraWorkspace: () => ipcRenderer.invoke('ultra-workspace-preview'),
  saveUltraWorkspace: (workspace, meta) => ipcRenderer.invoke('save-ultra-workspace', workspace, meta),
  exportUltraWorkspace: (workspace, meta) => ipcRenderer.invoke('export-ultra-workspace', workspace, meta),
  importUltraWorkspace: () => ipcRenderer.invoke('import-ultra-workspace'),
  // Канал сборки: stable (для всех) или experimental (владелец). Читается один раз при загрузке окна.
  channel: ipcRenderer.sendSync('get-channel'),
  resolveAgentApproval: decision => ipcRenderer.invoke('resolve-agent-approval', decision),
  // Удалённое управление с телефона: состояние и кнопки раздела, мост к чатам окна.
  remoteState: () => ipcRenderer.invoke('remote-state'),
  remoteSetEnabled: value => ipcRenderer.invoke('remote-set-enabled', value),
  remoteBeginPairing: () => ipcRenderer.invoke('remote-begin-pairing'),
  remoteCancelPairing: () => ipcRenderer.invoke('remote-cancel-pairing'),
  remoteRevokeAll: () => ipcRenderer.invoke('remote-revoke-all'),
  onRemoteState: callback => { ipcRenderer.on('remote-state-changed', (_event, payload) => callback(payload)) },
  onRemoteRequest: callback => { ipcRenderer.on('remote-request', (_event, payload) => callback(payload)) },
  remoteReply: payload => ipcRenderer.send('remote-reply', payload),
  remoteChatChanged: payload => ipcRenderer.send('remote-chat-changed', payload),
  resolveAgentQuestion: answer => ipcRenderer.invoke('resolve-agent-question', answer),
  getPersonal: () => ipcRenderer.invoke('get-personal'),
  setPersonal: payload => ipcRenderer.invoke('set-personal', payload),
  pickAttachments: () => ipcRenderer.invoke('pick-attachments'),
  describeAttachments: paths => ipcRenderer.invoke('describe-attachments', paths),
  scanMessagePaths: text => ipcRenderer.invoke('scan-message-paths', text),
  // File.path is deprecated in Electron 30 and gone in 32; webUtils is the
  // supported way to turn a dropped File into a real path.
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return file?.path || ''
    }
  },
  getMcpServers: () => ipcRenderer.invoke('get-mcp-servers'),
  addMcpServer: config => ipcRenderer.invoke('add-mcp-server', config),
  removeMcpServer: id => ipcRenderer.invoke('remove-mcp-server', id),
  connectMcpServer: id => ipcRenderer.invoke('connect-mcp-server', id),
  disconnectMcpServer: id => ipcRenderer.invoke('disconnect-mcp-server', id),
  getDesigns: () => ipcRenderer.invoke('get-designs'),
  setDesigns: designs => ipcRenderer.invoke('set-designs', designs),
  designComponents: designId => ipcRenderer.invoke('design-components', designId),
  designVersions: (designId, component) => ipcRenderer.invoke('design-versions', designId, component),
  designRestoreVersion: (designId, component, version) =>
    ipcRenderer.invoke('design-restore-version', designId, component, version),
  designDelete: designId => ipcRenderer.invoke('design-delete', designId),
  // Настоящий путь перетащенного файла. File.path устарел и в новых Electron
  // пуст, поэтому спрашиваем у webUtils; копирование делает главный процесс.
  filePath: file => { try { return webUtils.getPathForFile(file) } catch { return file?.path || '' } },
  designRefs: designId => ipcRenderer.invoke('design-refs', designId),
  designAddRefs: (designId, paths) => ipcRenderer.invoke('design-add-refs', designId, paths),
  designPasteRef: (designId, dataUrl, name) => ipcRenderer.invoke('design-paste-ref', designId, dataUrl, name),
  designRemoveRef: (designId, name) => ipcRenderer.invoke('design-remove-ref', designId, name),
  designReveal: designId => ipcRenderer.invoke('design-reveal', designId),
  designHandoff: designId => ipcRenderer.invoke('design-handoff', designId),
  // Какой макет открыт в окне (план, 4.2 шаг 2): единственный способ сказать
  // главному процессу, что правку из чата уже можно отдать ходу Дизайна. Уходит
  // `null`, когда окно ушло с макета.
  designFocus: designId => ipcRenderer.invoke('design-focus', { designId }),
  designEditResult: payload => ipcRenderer.invoke('design-edit-result', payload),
  // Артефакты чата (план, 3.2): панель рядом с ответом.
  getArtifacts: chatId => ipcRenderer.invoke('get-artifacts', chatId),
  getFfmpegStatus: refresh => ipcRenderer.invoke('ffmpeg-status', refresh),
  installFfmpeg: () => ipcRenderer.invoke('ffmpeg-install'),
  saveArtifactVersion: payload => ipcRenderer.invoke('save-artifact-version', payload),
  renameArtifact: payload => ipcRenderer.invoke('rename-artifact', payload),
  archiveArtifact: payload => ipcRenderer.invoke('archive-artifact', payload),
  revealArtifact: payload => ipcRenderer.invoke('reveal-artifact', payload),
  exportArtifact: payload => ipcRenderer.invoke('export-artifact', payload),
  onArtifactChanged: callback => {
    ipcRenderer.on('artifact-changed', (_event, payload) => callback(payload))
  },
  // Встроенный браузер панели: страница просит новую вкладку (target=_blank, window.open),
  // а «открыть в системном браузере» уходит в главный процесс, который пускает только http(s).
  onBrowserOpenTab: callback => {
    ipcRenderer.on('browser-open-tab', (_event, payload) => callback(payload))
  },
  onBrowserContextMenu: callback => {
    ipcRenderer.on('browser-context-menu', (_event, payload) => callback(payload))
  },
  openBrowserExternal: url => ipcRenderer.invoke('browser-open-external', url),
  openFilePreview: payload => ipcRenderer.invoke('open-file-preview', payload),
  watchOrigin: (url, on) => ipcRenderer.invoke('watch-origin', { url, on }),
  savePageScreenshot: dataUrl => ipcRenderer.invoke('save-page-screenshot', { dataUrl }),
  onBrowserPanelOpen: callback => { ipcRenderer.on('browser-panel-open', (_event, payload) => callback(payload)) },
  onWatchTabRequest: callback => { ipcRenderer.on('watch-tab-request', (_event, payload) => callback(payload)) },
  watchTabReply: (id, result) => ipcRenderer.invoke('watch-tab-reply', { id, result }),
  onWorkspaceFileChanged: callback => { ipcRenderer.on('workspace-file-changed', (_event, payload) => callback(payload)) },
  detectDevServers: () => ipcRenderer.invoke('browser-detect-dev-servers'),
  // Задача макета из чата (план, этап 4): начинает её модель инструментом,
  // окну остаётся только смотреть прогресс — и отписаться, иначе подписка
  // накопилась бы по одной на ход.
  onDesignTaskEvent: callback => {
    const handler = (_, state) => callback(state)
    ipcRenderer.on('design-task-event', handler)
    return () => ipcRenderer.removeListener('design-task-event', handler)
  },
  // Правка макета из чата (план, 4.2 шаг 2): главный процесс её не делает — он
  // передаёт её окну, а окно исполняет своим ходом Дизайна. Подписка с ручкой,
  // иначе на каждой перестройке окна накапливались бы слушатели.
  onDesignChatEdit: callback => {
    const handler = (_, edit) => callback(edit)
    ipcRenderer.on('design-chat-edit', handler)
    return () => ipcRenderer.removeListener('design-chat-edit', handler)
  },
  // Живой вид страницы агента (план, 3.6б): кадры и состояния идут событием,
  // «Остановить» закрывает скрытую страницу, не трогая ход.
  onAgentBrowserEvent: callback => {
    const handler = (_, state) => callback(state)
    ipcRenderer.on('agent-browser-event', handler)
    return () => ipcRenderer.removeListener('agent-browser-event', handler)
  },
  stopAgentBrowser: requestId => ipcRenderer.invoke('stop-agent-browser', { requestId }),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  setProjects: projects => ipcRenderer.invoke('set-projects', projects),
  // Уроки проекта (АГ-4): действует только включённый человеком; кем записан урок, решает главный процесс.
  lessonsList: projectId => ipcRenderer.invoke('lessons:list', { projectId }),
  lessonsPropose: (projectId, lesson) => ipcRenderer.invoke('lessons:propose', { projectId, lesson }),
  lessonsEnable: (projectId, id) => ipcRenderer.invoke('lessons:enable', { projectId, id }),
  lessonsRevoke: (projectId, id, reason) => ipcRenderer.invoke('lessons:revoke', { projectId, id, reason }),
  lessonsCorrect: (projectId, id, lesson) => ipcRenderer.invoke('lessons:correct', { projectId, id, lesson }),
  // Долгая задача окна — в журнал задержек (план, 1.7). Только длительность и
  // что перед этим нажимали; ни текста переписки, ни содержимого полей.
  reportLongTask: report => ipcRenderer.send('perf-longtask', report),
  // Окно не получило данные при запуске — причина в тот же журнал.
  reportBootProblem: reason => ipcRenderer.send('boot-problem', String(reason || '').slice(0, 200)),
  getConversations: () => ipcRenderer.invoke('get-conversations'),
  getRunConfigurations: () => ipcRenderer.invoke('get-run-configurations'),
  previewRunParameters: selection => ipcRenderer.invoke('preview-run-parameters', selection),
  applyRunParameters: token => ipcRenderer.invoke('apply-run-parameters', { token }),
  setConversations: conversations => ipcRenderer.invoke('set-conversations', conversations),
  migrateConversations: conversations => ipcRenderer.invoke('migrate-conversations', conversations),
  getStorageStatus: () => ipcRenderer.invoke('get-storage-status'),
  getToolCapability: () => ipcRenderer.invoke('get-tool-capability'),
  clearToolCapability: modelId => ipcRenderer.invoke('clear-tool-capability', modelId),
  purgeLegacyStorage: () => ipcRenderer.invoke('purge-legacy-storage'),
  generateChatTitle: payload => ipcRenderer.invoke('generate-chat-title', payload),
  generateNextSuggestion: payload => ipcRenderer.invoke('generate-next-suggestion', payload),
  cancelNextSuggestion: requestId => ipcRenderer.invoke('cancel-next-suggestion', requestId),
  getSkills: () => ipcRenderer.invoke('get-skills'),
  importSkillPack: payload => ipcRenderer.invoke('import-skill-pack', payload),
  folderState: payload => ipcRenderer.invoke('folder-state', payload),
  pickSkillSource: payload => ipcRenderer.invoke('pick-skill-source', payload),
  skillFromFile: payload => ipcRenderer.invoke('skill-from-file', payload),
  skillDraft: payload => ipcRenderer.invoke('skill-draft', payload),
  checkSkillPack: payload => ipcRenderer.invoke('check-skill-pack', payload),
  writeSkillFile: payload => ipcRenderer.invoke('write-skill-file', payload),
  revealSkill: payload => ipcRenderer.invoke('reveal-skill', payload),
  readSkillPackFile: payload => ipcRenderer.invoke('skill-pack-file', payload),
  addSkill: skill => ipcRenderer.invoke('add-skill', skill),
  removeSkill: id => ipcRenderer.invoke('remove-skill', id),
  toggleSkill: payload => ipcRenderer.invoke('toggle-skill', payload),
  onWindowState: callback => {
    const handler = (_, state) => callback(state)
    ipcRenderer.on('window-state', handler)
    return () => ipcRenderer.removeListener('window-state', handler)
  },
  onMessageChunk: callback => {
    const handler = (_, chunk) => callback(chunk)
    ipcRenderer.on('message-chunk', handler)
    return () => ipcRenderer.removeListener('message-chunk', handler)
  },
  onMessageReasoningChunk: callback => {
    const handler = (_, chunk) => callback(chunk)
    ipcRenderer.on('message-reasoning-chunk', handler)
    return () => ipcRenderer.removeListener('message-reasoning-chunk', handler)
  },
  onMessageComplete: callback => {
    const handler = (_, response) => callback(response)
    ipcRenderer.on('message-complete', handler)
    return () => ipcRenderer.removeListener('message-complete', handler)
  },
  onAgentStageStart: callback => {
    const handler = (_, stage) => callback(stage)
    ipcRenderer.on('agent-stage-start', handler)
    return () => ipcRenderer.removeListener('agent-stage-start', handler)
  },
  onAgentToolLog: callback => {
    const handler = (_, entry) => callback(entry)
    ipcRenderer.on('agent-tool-log', handler)
    return () => ipcRenderer.removeListener('agent-tool-log', handler)
  },
  onAgentEvent: callback => {
    const handler = (_, event) => callback(event)
    ipcRenderer.on('agent-event', handler)
    return () => ipcRenderer.removeListener('agent-event', handler)
  },
  steerAgent: payload => ipcRenderer.invoke('steer-agent', payload),
  onAgentPlan: callback => {
    const handler = (_, plan) => callback(plan)
    ipcRenderer.on('agent-plan', handler)
    return () => ipcRenderer.removeListener('agent-plan', handler)
  },
  onAgentBoard: callback => {
    const handler = (_, board) => callback(board)
    ipcRenderer.on('agent-board', handler)
    return () => ipcRenderer.removeListener('agent-board', handler)
  },
  onAgentProgress: callback => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('agent-progress', handler)
    return () => ipcRenderer.removeListener('agent-progress', handler)
  },
  onAgentFileChange: callback => {
    const handler = (_, change) => callback(change)
    ipcRenderer.on('agent-file-change', handler)
    return () => ipcRenderer.removeListener('agent-file-change', handler)
  },
  onAgentApprovalDone: callback => {
    const handler = (_e, payload) => callback(payload)
    ipcRenderer.on('agent-approval-done', handler)
    return () => ipcRenderer.removeListener('agent-approval-done', handler)
  },
  onAgentApproval: callback => {
    const handler = (_, request) => callback(request)
    ipcRenderer.on('agent-approval', handler)
    return () => ipcRenderer.removeListener('agent-approval', handler)
  },
  onAgentQuestion: callback => {
    const handler = (_, request) => callback(request)
    ipcRenderer.on('agent-question', handler)
    return () => ipcRenderer.removeListener('agent-question', handler)
  },
  onForkProposal: callback => {
    const handler = (_, payload) => callback(payload)
    ipcRenderer.on('fork-proposal', handler)
    return () => ipcRenderer.removeListener('fork-proposal', handler)
  },
  onMcpStatus: callback => {
    const handler = (_, status) => callback(status)
    ipcRenderer.on('mcp-status', handler)
    return () => ipcRenderer.removeListener('mcp-status', handler)
  },
  modsList: () => ipcRenderer.invoke('mods:list'),
  modsSample: input => ipcRenderer.invoke('mods:sample', input),
  modsPreview: input => ipcRenderer.invoke('mods:preview', input),
  modsCommit: token => ipcRenderer.invoke('mods:commit', { token }),
  modsToggle: input => ipcRenderer.invoke('mods:toggle', input),
  modsRemove: input => ipcRenderer.invoke('mods:remove', input),
  modsExport: id => ipcRenderer.invoke('mods:export', { id }),
  modsPanels: chatId => ipcRenderer.invoke('mods:panels', { chatId }),
  modAction: input => ipcRenderer.invoke('mods:action', input),
  onModsChanged: callback => {
    const listener = (_event, input) => callback(input)
    ipcRenderer.on('mods:changed', listener)
    return () => ipcRenderer.removeListener('mods:changed', listener)
  },
  onModDraft: callback => {
    const listener = (_event, input) => callback(input)
    ipcRenderer.on('mods:draft', listener)
    return () => ipcRenderer.removeListener('mods:draft', listener)
  },
  // OS-5: «Плагины» — согласие на права, откат версии и журнал. Каналы plugins:*
  // отвечают только главному окну (plugins-ipc.cjs), мост их не расширяет.
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsApprove: input => ipcRenderer.invoke('plugins:approve', input),
  pluginsDisable: input => ipcRenderer.invoke('plugins:disable', input),
  pluginsEnable: input => ipcRenderer.invoke('plugins:enable', input),
  pluginsRollback: input => ipcRenderer.invoke('plugins:rollback', input),
  pluginsRemove: input => ipcRenderer.invoke('plugins:remove', input),
  onSkillsUpdate: callback => {
    const handler = (_, skills) => callback(skills)
    ipcRenderer.on('skills-update', handler)
    return () => ipcRenderer.removeListener('skills-update', handler)
  }
})
