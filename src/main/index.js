import { app, protocol, net, session } from 'electron'
import { registerIPC } from './ipc'
import { openMainWindow, hasAnyWindow } from './windowManager'
import { setupAutoUpdater } from './updater'
import { isLocalFileAccessAllowed } from './localFileAccess'
import { fileURLToPath, pathToFileURL } from 'url'

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } }
])

// 启用 SharedArrayBuffer（WASM 多线程需要）
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

app.whenReady().then(() => {
  // 设置跨域隔离头，确保 SharedArrayBuffer 可用
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['credentialless']
      }
    })
  })

  protocol.handle('local-file', async (request) => {
    const filePath = fileURLToPath(request.url.replace(/^local-file:/, 'file:'))
    if (!(await isLocalFileAccessAllowed(filePath))) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.electron' : process.execPath)
  }

  registerIPC()
  openMainWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (!hasAnyWindow()) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
