const { contextBridge, ipcRenderer } = require('electron');

// ---- Expose APIs to renderer ----

contextBridge.exposeInMainWorld('electronAPI', {
  // Listeners (menu → renderer)
  onMenuNew: (cb) => ipcRenderer.on('menu-new', () => cb()),
  onMenuSave: (cb) => ipcRenderer.on('menu-save', () => cb()),
  onMenuSaveAs: (cb) => ipcRenderer.on('menu-save-as', () => cb()),
  onFileOpened: (cb) => ipcRenderer.on('file-opened', (_e, data) => cb(data)),
  onFileSaved: (cb) => ipcRenderer.on('file-saved', (_e, data) => cb(data)),
  onToggleTheme: (cb) => ipcRenderer.on('toggle-theme', (_e, isDark) => cb(isDark)),
  onCycleMode: (cb) => ipcRenderer.on('menu-cycle-mode', () => cb()),
  onExportHtml: (cb) => ipcRenderer.on('menu-export-html', () => cb()),

  // Actions (renderer → main)
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openDroppedFile: (filePath) => ipcRenderer.invoke('open-dropped-file', filePath),
  saveImage: (dataUrl) => ipcRenderer.invoke('save-image', dataUrl),
  exportHtml: (html) => ipcRenderer.invoke('export-html', html),
  requestOpen: () => ipcRenderer.send('request-open'),
  saveContent: (content) => ipcRenderer.send('request-save', content),
  saveContentAs: (content) => ipcRenderer.send('save-as', content),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getRecentFolder: () => ipcRenderer.invoke('get-recent-folder'),
  pickAndSaveImage: () => ipcRenderer.invoke('pick-and-save-image'),
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),
});

console.log('[Marky preload] electronAPI exposed OK');
