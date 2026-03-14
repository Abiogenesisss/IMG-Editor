import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  quitApp: () => ipcRenderer.send('quit-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  maximizeApp: () => ipcRenderer.send('maximize-app'),
  onWindowStateChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized)
    ipcRenderer.on('window-state-change', handler)
    return () => ipcRenderer.removeListener('window-state-change', handler)
  },
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  resolveOutputDir: (inputDir) => ipcRenderer.invoke('resolve-output-dir', inputDir),
  readImages: (folderPath) => ipcRenderer.invoke('read-images', folderPath),
  generateThumbnail: (filePath) => ipcRenderer.invoke('generate-thumbnail', filePath),
  deleteImage: (filePath) => ipcRenderer.invoke('delete-image', filePath),
  mirrorFlip: (filePaths, outputDir) => ipcRenderer.invoke('mirror-flip', filePaths, outputDir),
  threeStageSplit: (filePaths, outputDir, personConf, halfbodyConf, headConf) =>
    ipcRenderer.invoke('three-stage-split', filePaths, outputDir, personConf, halfbodyConf, headConf),
  resolutionFilter: (filePaths, minWidth, maxWidth, minHeight, maxHeight) =>
    ipcRenderer.invoke('resolution-filter', filePaths, minWidth, maxWidth, minHeight, maxHeight),
  batchResize: (filePaths, outputDir, width, height, allowUpscale, faceThreshold) =>
    ipcRenderer.invoke('batch-resize', filePaths, outputDir, width, height, allowUpscale, faceThreshold),
  formatConvert: (filePaths, outputDir, targetFormat) =>
    ipcRenderer.invoke('format-convert', filePaths, outputDir, targetFormat),
  proportionalCrop: (filePaths, outputDir, ratioW, ratioH) =>
    ipcRenderer.invoke('proportional-crop', filePaths, outputDir, ratioW, ratioH),
  autoCrop: (filePaths, outputDir, ratioList) =>
    ipcRenderer.invoke('auto-crop', filePaths, outputDir, ratioList),
  deduplicate: (filePaths, hashThresh, phashThresh, colorThresh) =>
    ipcRenderer.invoke('deduplicate', filePaths, hashThresh, phashThresh, colorThresh),
  cluster: (filePaths, options) =>
    ipcRenderer.invoke('cluster', filePaths, options),
  clusterMove: (filesByGroup, outputDir) =>
    ipcRenderer.invoke('cluster-move', filesByGroup, outputDir),
  cutout: (filePaths, outputDir, count, sizeRatio) =>
    ipcRenderer.invoke('cutout', filePaths, outputDir, count, sizeRatio),
  perspective: (filePaths, outputDir, intensity) =>
    ipcRenderer.invoke('perspective', filePaths, outputDir, intensity),
  gaussianBlurNoise: (filePaths, outputDir, blurRadius, noiseSigma) =>
    ipcRenderer.invoke('gaussian-blur-noise', filePaths, outputDir, blurRadius, noiseSigma),
  previewAugment: (filePath, augType, params) =>
    ipcRenderer.invoke('preview-augment', filePath, augType, params),
  abortTask: () => ipcRenderer.invoke('abort-task'),
  cleanupCaches: () => ipcRenderer.invoke('cleanup-caches'),
  taggerModels: () => ipcRenderer.invoke('tagger-models'),
  taggerDownload: (modelKey) => ipcRenderer.invoke('tagger-download', modelKey),
  taggerTag: (filePaths, modelKey, generalThreshold, characterThreshold) =>
    ipcRenderer.invoke('tagger-tag', filePaths, modelKey, generalThreshold, characterThreshold),
  upscale: (filePaths, outputDir, scale, denoise, model, style, tta) =>
    ipcRenderer.invoke('upscale', filePaths, outputDir, scale, denoise, model, style, tta),
  upscaleModels: () => ipcRenderer.invoke('upscale-models'),
  previewUpscale: (filePath, scale, denoise, model, style, tta) =>
    ipcRenderer.invoke('preview-upscale', filePath, scale, denoise, model, style, tta),
  batchReadTags: (imagePaths) => ipcRenderer.invoke('batch-read-tags', imagePaths),
  saveImageTags: (imagePath, tags, outputDir) => ipcRenderer.invoke('save-image-tags', imagePath, tags, outputDir),
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
