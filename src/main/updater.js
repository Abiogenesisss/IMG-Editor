import { autoUpdater } from 'electron-updater'
import { ipcMain, app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { prepareForUpdateRestart } from './ipc'
import { getMainWindow } from './windowManager'

// 自动检测更新开关（在 setupAutoUpdater 之前声明）
let autoCheckEnabled = true

// 向渲染进程发送更新事件
function sendToRenderer(channel, ...args) {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function setupAutoUpdater() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('update-status', 'checking')
  })

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update-status', 'available', {
      version: info.version,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('update-status', 'not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-status', 'downloading', {
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    sendToRenderer('update-status', 'downloaded')
  })

  autoUpdater.on('error', (err) => {
    sendToRenderer('update-status', 'error', { message: err.message })
  })

  // 渲染进程请求检查更新
  ipcMain.handle('check-for-update', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return result
    } catch {
      return null
    }
  })

  // 渲染进程请求下载更新
  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return true
    } catch {
      return false
    }
  })

  // 渲染进程请求安装更新（退出并安装）
  ipcMain.handle('install-update', async () => {
    try {
      await prepareForUpdateRestart()
      autoUpdater.quitAndInstall(false, true)
      return true
    } catch {
      return false
    }
  })

  // 渲染进程请求获取自动检测更新设置
  ipcMain.handle('get-auto-check-update', () => {
    return autoCheckEnabled
  })

  // 渲染进程设置自动检测更新开关
  ipcMain.handle('set-auto-check-update', (_event, enabled) => {
    autoCheckEnabled = enabled
    try {
      const settingsPath = join(app.getPath('userData'), 'auto-update-settings.json')
      writeFileSync(settingsPath, JSON.stringify({ autoCheck: enabled }), 'utf-8')
    } catch {
      /* ignore */
    }
    return true
  })

  // 从持久化文件读取自动更新设置
  try {
    const settingsPath = join(app.getPath('userData'), 'auto-update-settings.json')
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    autoCheckEnabled = data.autoCheck !== false
  } catch {
    autoCheckEnabled = true
  }

  // 启动后根据设置决定是否自动检查更新
  if (autoCheckEnabled) {
    autoUpdater.checkForUpdates().catch(() => {})
  }
}
