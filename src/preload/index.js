import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  quitApp: () => ipcRenderer.send('quit-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  maximizeApp: () => ipcRenderer.send('maximize-app'),
  onWindowStateChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized)
    ipcRenderer.on('window-state-change', handler)
    return () => ipcRenderer.removeListener('window-state-change', handler)
  },
  getApiConfigs: () => ipcRenderer.invoke('get-api-configs'),
  saveApiConfigs: (configs) => ipcRenderer.invoke('save-api-configs', configs),
  migrateApiConfigs: (configs) => ipcRenderer.invoke('migrate-api-configs', configs),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  saveTextFile: (options) => ipcRenderer.invoke('save-text-file', options),
  resolveOutputDir: (inputDir) => ipcRenderer.invoke('resolve-output-dir', inputDir),
  readImages: (folderPath) => ipcRenderer.invoke('read-images', folderPath),
  readImagesRecursive: (folderPath) => ipcRenderer.invoke('read-images-recursive', folderPath),
  createWorkflowRunDir: (baseDir, name) =>
    ipcRenderer.invoke('create-workflow-run-dir', baseDir, name),
  copyWorkflowFiles: (files, outputDir) =>
    ipcRenderer.invoke('copy-workflow-files', files, outputDir),
  generateThumbnail: (filePath) => ipcRenderer.invoke('generate-thumbnail', filePath),
  deleteImage: (filePath) => ipcRenderer.invoke('delete-image', filePath),
  scanImageSources: (body) => ipcRenderer.invoke('scan-image-sources', body),
  loadGrabPreview: (body) => ipcRenderer.invoke('load-grab-preview', body),
  downloadGrabImages: (body) => ipcRenderer.invoke('download-grab-images', body),
  getTunnelStatus: () => ipcRenderer.invoke('tunnel-status'),
  startTunnel: (config) => ipcRenderer.invoke('tunnel-start', config),
  stopTunnel: () => ipcRenderer.invoke('tunnel-stop'),
  onTunnelEvent: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('tunnel-event', handler)
    return () => ipcRenderer.removeListener('tunnel-event', handler)
  },
  // --- Python 后端通用代理 ---
  callPython: (endpoint, body) => ipcRenderer.invoke('call-python', endpoint, body),
  abortTask: () => ipcRenderer.invoke('abort-task'),
  // --- Node.js 本地文件操作 ---
  checkPathExists: (targetPath) => ipcRenderer.invoke('check-path-exists', targetPath),
  batchReadTags: (imagePaths) => ipcRenderer.invoke('batch-read-tags', imagePaths),
  saveImageTags: (imagePath, tags, outputDir) =>
    ipcRenderer.invoke('save-image-tags', imagePath, tags, outputDir),
  batchSaveTags: (tagsMap, outputDir) => ipcRenderer.invoke('batch-save-tags', tagsMap, outputDir),
  onTaskProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('task-progress', handler)
    return () => ipcRenderer.removeListener('task-progress', handler)
  },
  // --- 自动更新 ---
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAutoCheckUpdate: () => ipcRenderer.invoke('get-auto-check-update'),
  setAutoCheckUpdate: (enabled) => ipcRenderer.invoke('set-auto-check-update', enabled),
  onUpdateStatus: (callback) => {
    const handler = (_event, status, data) => callback(status, data)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
