import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'

let mainWindow = null

export function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 900,
    minHeight: 700,
    show: false,
    frame: false,
    transparent: false,
    roundedCorners: false,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-state-change', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-state-change', false)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

export function openMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
  } else {
    mainWindow.show()
    mainWindow.center()
  }
}

export function getMainWindow() {
  return mainWindow
}

export function hasAnyWindow() {
  return BrowserWindow.getAllWindows().length > 0
}
