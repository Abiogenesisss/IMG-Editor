import { autoUpdater } from 'electron-updater'
import { ipcMain } from 'electron'
import { getMainWindow } from './windowManager'

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
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall()
  })

  // 启动后自动检查一次
  autoUpdater.checkForUpdates().catch(() => {})
}
