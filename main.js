const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let currentFilePath = null;
let isDarkTheme = false;
let pendingFile = null; // File path from open-file event before window is ready

// Window state persistence
const statePath = path.join(app.getPath('userData'), 'window-state.json');
const recentPath = path.join(app.getPath('userData'), 'recent-files.json');
const recentFolderPath = path.join(app.getPath('userData'), 'recent-folder.json');

function loadWindowState() {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch (_) {}
  return { width: 1200, height: 800 };
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(statePath, JSON.stringify({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
    }), 'utf-8');
  } catch (_) {}
}

// Recent files
function loadRecentFiles() {
  try {
    if (fs.existsSync(recentPath)) {
      return JSON.parse(fs.readFileSync(recentPath, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

function saveRecentFiles(files) {
  try {
    fs.writeFileSync(recentPath, JSON.stringify(files.slice(0, 10)), 'utf-8');
  } catch (_) {}
}

function addRecentFile(filePath) {
  let recent = loadRecentFiles();
  recent = recent.filter(f => f !== filePath);
  recent.unshift(filePath);
  saveRecentFiles(recent);
  // Rebuild menu with updated recent list
  const menu = buildMenu();
  Menu.setApplicationMenu(menu);
}

// Recent folder
function loadRecentFolder() {
  try {
    if (fs.existsSync(recentFolderPath)) {
      return JSON.parse(fs.readFileSync(recentFolderPath, 'utf-8'));
    }
  } catch (_) {}
  return null;
}

function saveRecentFolder(folderPath) {
  try {
    fs.writeFileSync(recentFolderPath, JSON.stringify({ folderPath }), 'utf-8');
  } catch (_) {}
}

function buildRecentMenu() {
  const recent = loadRecentFiles();
  if (recent.length === 0) {
    return [{ label: 'No Recent Files', enabled: false }];
  }
  return recent.map(f => ({
    label: f,
    click: () => openFileByPath(f),
  }));
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    icon: path.join(__dirname, 'build', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Save window state on resize or move
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  // Build menu
  const menu = buildMenu();
  Menu.setApplicationMenu(menu);

  // Defer pending file and argv processing until renderer is ready
  // (otherwise IPC events arrive before the renderer's listeners are registered)
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingFile) {
      openFileByPath(pendingFile);
      pendingFile = null;
    }
    if (!process.argv.includes('--dev')) {
      processArgv(process.argv.slice(1));
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Open a file by path and send to renderer
function openFileByPath(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    currentFilePath = filePath;
    addRecentFile(filePath);
    if (mainWindow) {
      mainWindow.webContents.send('file-opened', { filePath, content });
    }
  } catch (err) {
    console.error('Failed to open file:', filePath, err.message);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu-new'),
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              openFileByPath(result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu-save'),
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu-save-as'),
        },
        { type: 'separator' },
        {
          label: 'Export HTML...',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow.webContents.send('menu-export-html'),
        },
        { type: 'separator' },
        {
          label: 'Open Recent',
          submenu: buildRecentMenu(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            isDarkTheme = !isDarkTheme;
            mainWindow.webContents.send('toggle-theme', isDarkTheme);
          },
        },
        {
          label: 'Cycle View Mode',
          accelerator: 'CmdOrCtrl+J',
          click: () => mainWindow.webContents.send('menu-cycle-mode'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  return Menu.buildFromTemplate(template);
}

function saveFile(forceSaveAs, content) {
  try {
    if (!forceSaveAs && currentFilePath) {
      fs.writeFileSync(currentFilePath, content, 'utf-8');
      mainWindow.webContents.send('file-saved', { path: currentFilePath, error: null });
    } else {
      const result = dialog.showSaveDialogSync(mainWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: currentFilePath || 'untitled.md',
      });
      if (result) {
        fs.writeFileSync(result, content, 'utf-8');
        currentFilePath = result;
        mainWindow.webContents.send('file-saved', { path: currentFilePath, error: null });
      }
    }
  } catch (err) {
    console.error('Save failed:', err.message);
    if (mainWindow) {
      mainWindow.webContents.send('file-saved', { path: currentFilePath, error: err.message });
    }
  }
}

// Debug log IPC — writes renderer console logs to a temp file
const debugLogPath = path.join(app.getPath('userData'), 'marky-debug.log');
ipcMain.on('debug-log', (_event, msg) => {
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(debugLogPath, '[' + timestamp + '] ' + msg + '\n');
  } catch (_) {}
});

// IPC handlers
ipcMain.on('request-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    openFileByPath(result.filePaths[0]);
  }
});

ipcMain.on('request-save', (_event, content) => {
  saveFile(false, content);
});

ipcMain.on('save-as', (_event, content) => {
  saveFile(true, content);
});

// Save pasted image to disk
ipcMain.handle('save-image', async (event, dataUrl) => {
  try {
    const imgDir = currentFilePath
      ? path.join(path.dirname(currentFilePath), 'Marky_assets')
      : path.join(app.getPath('pictures'), 'Marky');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const name = 'img_' + Date.now() + '.png';
    const outPath = path.join(imgDir, name);

    // dataUrl format: "data:image/png;base64,..."
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));

    // Return relative path if saved alongside file, else absolute
    if (currentFilePath) {
      const rel = path.relative(path.dirname(currentFilePath), outPath);
      return rel;
    }
    return outPath;
  } catch (_) {
    return null;
  }
});

ipcMain.handle('export-html', async (event, html) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: 'export.html',
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, html, 'utf-8');
    return true;
  }
  return false;
});

// macOS: handle "Open with" from Finder
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    openFileByPath(filePath);
    mainWindow.focus();
  } else {
    // Window not ready yet — save for later processing
    pendingFile = filePath;
  }
});

// Select folder and list .md files
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    saveRecentFolder(folderPath);
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile() && /\.md$/i.test(e.name))
        .map(e => ({
          name: e.name,
          path: path.join(folderPath, e.name),
        }));
      return { folderPath, files };
    } catch (_) {
      return null;
    }
  }
  return null;
});

// Open external URL in default browser
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
});

// Toggle fullscreen
ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// Open dropped .md file
ipcMain.handle('open-dropped-file', async (event, filePath) => {
  openFileByPath(filePath);
  return true;
});

// Pick an image file, save it to the Marky_assets folder, return the path
ipcMain.handle('pick-and-save-image', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const srcPath = result.filePaths[0];
    const imgDir = currentFilePath
      ? path.join(path.dirname(currentFilePath), 'Marky_assets')
      : path.join(app.getPath('pictures'), 'Marky');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const ext = path.extname(srcPath);
    const name = 'img_' + Date.now() + ext;
    const outPath = path.join(imgDir, name);
    fs.copyFileSync(srcPath, outPath);
    if (currentFilePath) {
      return path.relative(path.dirname(currentFilePath), outPath);
    }
    return outPath;
  } catch (_) {
    return null;
  }
});

// Get recent folder data for startup
ipcMain.handle('get-recent-folder', async () => {
  const data = loadRecentFolder();
  if (data && data.folderPath) {
    if (!fs.existsSync(data.folderPath)) return null;
    try {
      const entries = fs.readdirSync(data.folderPath, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile() && /\.md$/i.test(e.name))
        .map(e => ({
          name: e.name,
          path: path.join(data.folderPath, e.name),
        }));
      return { folderPath: data.folderPath, files };
    } catch (_) {
      return null;
    }
  }
  return null;
});

// Handle file path from command line arguments
function processArgv(argv) {
  const filePath = argv.find(a => a.endsWith('.md') || a.endsWith('.markdown'));
  if (filePath && fs.existsSync(filePath)) {
    openFileByPath(filePath);
  }
}

app.whenReady().then(() => {
  // Customize About panel
  app.setAboutPanelOptions({
    applicationName: 'Marky',
    applicationVersion: '1.0.0',
    authors: ['liwy'],
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
