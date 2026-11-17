const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskAPI', {
  read: () => ipcRenderer.invoke('desk:read'),
  modsPanels: () => ipcRenderer.invoke('mods:panels'),
  modAction: input => ipcRenderer.invoke('mods:action', input),
  onModsChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('mods:changed', listener)
    return () => ipcRenderer.removeListener('mods:changed', listener)
  },
  apply: command => ipcRenderer.invoke('desk:apply', command),
  state: report => ipcRenderer.invoke('desk:state', report),
  guest: report => ipcRenderer.invoke('desk:guest', report),
  watches: () => ipcRenderer.invoke('desk:watches'),
  stopWatch: id => ipcRenderer.invoke('desk:watch-stop', id),
  processes: () => ipcRenderer.invoke('desk:processes'),
  stopProcess: id => ipcRenderer.invoke('desk:process-stop', id),
  exportTemplate: includeContent => ipcRenderer.invoke('desk:transfer', 'export', { includeContent }),
  copyTemplate: (text, includeContent) => ipcRenderer.invoke('desk:transfer', 'copy', { text, includeContent }),
  previewTemplate: (text, viewport) => ipcRenderer.invoke('desk:transfer', 'preview', { text, viewport }),
  activate: id => ipcRenderer.invoke('desk:activate', id),
  fit: input => ipcRenderer.invoke('desk:fit', input),
  legacyTemplate: () => ipcRenderer.invoke('desk:transfer', 'legacy'),
  importTemplate: token => ipcRenderer.invoke('desk:transfer', 'import', { token }),
  onProcessesChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('desk:process-changed', listener)
    return () => ipcRenderer.removeListener('desk:process-changed', listener)
  },
  hold: id => ipcRenderer.invoke('desk:hold', id),
  release: () => ipcRenderer.invoke('desk:release'),
  main: () => ipcRenderer.invoke('desk:main'),
  pause: paused => ipcRenderer.invoke('desk:pause', paused),
  stopBuild: () => ipcRenderer.invoke('desk:stop-build'),
  onChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('desk:changed', listener)
    return () => ipcRenderer.removeListener('desk:changed', listener)
  }
})
