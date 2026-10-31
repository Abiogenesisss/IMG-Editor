import { contextBridge, ipcRenderer } from 'electron'

const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args)
const send =
  (channel) =>
  (...args) =>
    ipcRenderer.send(channel, ...args)
const on =
  (channel, map = (...args) => args) =>
  (callback) => {
    const handler = (_event, ...args) => callback(...map(...args))
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }

const api = {
  getAppVersion: invoke('get-app-version'),
  quitApp: send('quit-app'),
  minimizeApp: send('minimize-app'),
  maximizeApp: send('maximize-app'),
  onWindowStateChange: on('window-state-change', (isMaximized) => [isMaximized]),

  getApiConfigs: invoke('get-api-configs'),
  saveApiConfigs: invoke('save-api-configs'),
  migrateApiConfigs: invoke('migrate-api-configs'),
  listApiModels: invoke('list-api-models'),

  selectFolder: invoke('select-folder'),
  selectUploadSources: invoke('select-upload-sources'),
  saveTextFile: invoke('save-text-file'),
  resolveOutputDir: invoke('resolve-output-dir'),
  readImages: invoke('read-images'),
  readImagesRecursive: invoke('read-images-recursive'),
  createWorkflowRunDir: invoke('create-workflow-run-dir'),
  resolveWorkflowPath: invoke('resolve-workflow-path'),
  copyWorkflowFiles: invoke('copy-workflow-files'),
  generateThumbnail: invoke('generate-thumbnail'),
  getImageMetadata: invoke('get-image-metadata'),
  deleteImage: invoke('delete-image'),

  scanImageSources: invoke('scan-image-sources'),
  loadGrabPreview: invoke('load-grab-preview'),
  downloadGrabImages: invoke('download-grab-images'),

  getTunnelStatus: invoke('tunnel-status'),
  startTunnel: invoke('tunnel-start'),
  stopTunnel: invoke('tunnel-stop'),
  uploadTunnelFiles: invoke('tunnel-upload'),
  onTunnelEvent: on('tunnel-event'),

  callPython: invoke('call-python'),
  abortTask: invoke('abort-task'),

  checkPathExists: invoke('check-path-exists'),
  batchReadTags: invoke('batch-read-tags'),
  saveImageTags: invoke('save-image-tags'),
  batchSaveTags: invoke('batch-save-tags'),
  onTaskProgress: on('task-progress'),

  checkForUpdate: invoke('check-for-update'),
  downloadUpdate: invoke('download-update'),
  installUpdate: invoke('install-update'),
  getAutoCheckUpdate: invoke('get-auto-check-update'),
  setAutoCheckUpdate: invoke('set-auto-check-update'),
  onUpdateStatus: on('update-status')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}
