import { app, ipcMain, BrowserWindow, dialog, safeStorage } from 'electron'
import { readdir, mkdir, rename, access, writeFile, readFile, stat, copyFile } from 'fs/promises'
import sharp from 'sharp'
import { join, extname, dirname, basename } from 'path'
import { pathToFileURL } from 'url'
import {
  grantLocalFileAccess,
  isLocalFileAccessAllowed,
  sanitizeSegment,
  getAvailablePath,
  getAvailableFilePath
} from './localFiles'
import { registerTunnelIPC } from './tunnelManager'
import { callPython, cancelLatestTask, requestForcedQuit } from './taskRuntime'
import { scanImageSources, downloadGrabImages, loadGrabPreview } from './imageGrab'

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tiff',
  '.tif',
  '.avif'
])
const PYTHON_ENDPOINTS = new Set([
  '/mirror-flip',
  '/resolution-filter',
  '/batch-resize',
  '/format-convert',
  '/flatten-alpha',
  '/proportional-crop',
  '/auto-crop',
  '/deduplicate',
  '/cluster',
  '/cluster-move',
  '/three-stage-split',
  '/cutout',
  '/perspective',
  '/gaussian-blur-noise',
  '/preview-augment',
  '/tagger-models',
  '/tagger-download',
  '/tagger-tag',
  '/deepghs-models',
  '/deepghs-download',
  '/deepghs-analyze',
  '/upscale',
  '/preview-upscale',
  '/upscale-models',
  '/caption-single',
  '/caption-batch',
  '/caption-batch-multi-api',
  '/local-model-load',
  '/local-model-unload',
  '/local-model-status',
  '/local-caption-single',
  '/local-caption-batch',
  '/cleanup-caches',
  '/gpu-status',
  '/set-gpu-config',
  '/grab-download'
])

const API_CONFIGS_FILE = 'api-configs.secure.json'
const thumbnailCache = new Map()
const THUMBNAIL_CACHE_LIMIT = 1200
function rememberThumbnail(filePath, dataUrl) {
  if (thumbnailCache.has(filePath)) thumbnailCache.delete(filePath)
  thumbnailCache.set(filePath, dataUrl)
  while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    const firstKey = thumbnailCache.keys().next().value
    thumbnailCache.delete(firstKey)
  }
}

function apiConfigsPath() {
  return join(app.getPath('userData'), API_CONFIGS_FILE)
}

function normalizeApiConfig(config = {}) {
  return {
    id: String(config.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: String(config.name || ''),
    model: String(config.model || ''),
    endpoint: String(config.endpoint || ''),
    apiKey: String(config.apiKey || ''),
    enabled: config.enabled !== false
  }
}

function encryptApiKey(apiKey) {
  if (!apiKey) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('System credential encryption is unavailable')
  }
  return {
    encoding: 'safeStorage',
    value: safeStorage.encryptString(apiKey).toString('base64')
  }
}

function decryptApiKey(protectedValue) {
  if (!protectedValue) return ''
  if (protectedValue.encoding !== 'safeStorage' || !protectedValue.value) {
    throw new Error('无法识别已保存的 API Key 格式')
  }
  return safeStorage.decryptString(Buffer.from(protectedValue.value, 'base64'))
}

async function readApiConfigs() {
  let content
  try {
    content = await readFile(apiConfigsPath(), 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const raw = JSON.parse(content)
  if (!Array.isArray(raw?.configs)) throw new Error('API 配置文件格式错误')
  return raw.configs
    .map((config) => ({
      id: String(config.id || ''),
      name: String(config.name || ''),
      model: String(config.model || ''),
      endpoint: String(config.endpoint || ''),
      apiKey: decryptApiKey(config.apiKeyProtected),
      enabled: config.enabled !== false
    }))
    .filter((config) => config.id)
}

async function writeApiConfigs(configs) {
  const normalized = Array.isArray(configs) ? configs.map(normalizeApiConfig) : []
  const stored = {
    version: 1,
    configs: normalized.map(({ apiKey, ...config }) => ({
      ...config,
      apiKeyProtected: encryptApiKey(apiKey)
    }))
  }
  const targetPath = apiConfigsPath()
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, JSON.stringify(stored, null, 2), 'utf-8')
  return normalized
}

async function migrateApiConfigs(legacyConfigs) {
  if (!Array.isArray(legacyConfigs)) throw new Error('旧版 API 配置格式错误')
  const current = await readApiConfigs()
  if (current.length > 0) {
    return { migrated: false, configs: current }
  }
  if (legacyConfigs.length === 0) {
    return { migrated: false, configs: [] }
  }
  return { migrated: true, configs: await writeApiConfigs(legacyConfigs) }
}

function resolveModelListRequest(endpoint, apiKey) {
  const raw = String(endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url = new URL(raw)
  const isGoogle = /(^|\.)googleapis\.com$/i.test(url.hostname)

  if (isGoogle) {
    url.pathname = url.pathname.replace(/\/models\/?$/i, '').replace(/\/+$/, '')
    url.pathname = `${url.pathname || '/v1beta'}/models`
    url.searchParams.set('key', apiKey)
    return { url: url.toString(), headers: {} }
  }

  url.pathname = url.pathname
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models\/?$/i, '')
    .replace(/\/+$/, '')
  url.pathname = `${url.pathname || '/v1'}/models`
  return { url: url.toString(), headers: { Authorization: `Bearer ${apiKey}` } }
}

function parseApiModels(payload) {
  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : []
  return items
    .map((item) => {
      const raw = String(item?.id || item?.name || '').trim()
      if (!raw) return null
      const id = raw.replace(/^models\//, '')
      return { id, name: String(item?.display_name || item?.displayName || id) }
    })
    .filter(Boolean)
}

async function listApiModels(_event, config = {}) {
  const endpoint = String(config.endpoint || '').trim()
  const apiKey = String(config.apiKey || '').trim()
  if (!endpoint) return { success: false, error: '请先填写 API Endpoint' }
  if (!apiKey) return { success: false, error: '请先填写 API Key' }

  try {
    const request = resolveModelListRequest(endpoint, apiKey)
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(12000)
    })
    const payload = await readJsonResponse(response)
    const models = parseApiModels(payload)
    if (!models.length) return { success: false, error: '未解析到模型列表' }
    return { success: true, models }
  } catch (err) {
    return { success: false, error: err.message || '读取模型列表失败' }
  }
}

function timestamp() {
  const d = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function readJsonResponse(response) {
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!response.ok) {
    const message =
      data?.error?.message || data?.error || data?.message || text || `HTTP ${response.status}`
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }

  return data || {}
}

// --- 通用 Python 代理：前端直接传 endpoint + body，无需逐个注册 ---
function registerPythonProxy() {
  ipcMain.handle('call-python', async (event, endpoint, body) => {
    try {
      if (!PYTHON_ENDPOINTS.has(endpoint)) {
        return { success: false, error: `Unsupported Python endpoint: ${endpoint}` }
      }
      return await callPython(endpoint, body || {}, event.sender)
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, aborted: true }
      return { success: false, error: err.message }
    }
  })
}

// --- 标签文件路径解析 ---
function resolveTagPath(imagePath, outputDir) {
  if (outputDir) {
    return join(outputDir, basename(imagePath).replace(/\.[^.]+$/, '.txt'))
  }
  return imagePath.replace(/\.[^.]+$/, '.txt')
}

function isImageFileName(name) {
  return IMAGE_EXTS.has(extname(name).toLowerCase())
}

function toLocalFileUrl(filePath) {
  return pathToFileURL(filePath)
    .toString()
    .replace(/^file:/, 'local-file:')
}

async function readImagesRecursiveFromDir(folderPath) {
  const results = []
  async function visit(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile() && isImageFileName(entry.name)) {
        results.push({
          name: entry.name,
          path: fullPath,
          url: toLocalFileUrl(fullPath)
        })
      }
    }
  }
  await visit(folderPath)
  return results
}

function getDefaultWorkflowRoot() {
  return join(app.getPath('userData'), 'workflow_runs')
}

async function uniqueDirectoryPath(parent, name) {
  return getAvailablePath(join(parent, name), (counter) => join(parent, `${name}_${counter}`))
}

export function registerIPC() {
  ipcMain.on('quit-app', () => {
    requestForcedQuit('quit-app')
  })

  ipcMain.on('minimize-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  ipcMain.on('maximize-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-api-configs', async () => readApiConfigs())

  ipcMain.handle('save-api-configs', async (_event, configs) => writeApiConfigs(configs))

  ipcMain.handle('migrate-api-configs', async (_event, legacyConfigs) =>
    migrateApiConfigs(legacyConfigs)
  )

  ipcMain.handle('list-api-models', listApiModels)

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    const folderPath = result.filePaths[0]
    await grantLocalFileAccess(folderPath)
    return folderPath
  })

  ipcMain.handle('select-upload-sources', async (event, mode = 'file') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const pickFolder = mode === 'folder'
    const result = await dialog.showOpenDialog(win, {
      properties: [pickFolder ? 'openDirectory' : 'openFile', 'multiSelections']
    })
    if (result.canceled) return []

    const items = []
    for (const filePath of result.filePaths) {
      try {
        const info = await stat(filePath)
        await grantLocalFileAccess(info.isDirectory() ? filePath : dirname(filePath))
        items.push({
          name: basename(filePath),
          path: filePath,
          isDirectory: info.isDirectory(),
          size: info.isFile() ? info.size : 0
        })
      } catch {
        /* ignore inaccessible selections */
      }
    }
    return items
  })

  ipcMain.handle('save-text-file', async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win, {
      defaultPath: options.defaultPath || 'config.toml',
      filters: Array.isArray(options.filters)
        ? options.filters
        : [
            { name: 'TOML', extensions: ['toml'] },
            { name: 'Text', extensions: ['txt'] }
          ]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await mkdir(dirname(result.filePath), { recursive: true })
    await writeFile(result.filePath, String(options.content || ''), 'utf-8')
    await grantLocalFileAccess(result.filePath)
    return { canceled: false, filePath: result.filePath }
  })

  // 根据输入目录生成唯一的同级输出目录路径
  ipcMain.handle('resolve-output-dir', async (_event, inputDir) => {
    const parent = dirname(inputDir)
    const base = basename(inputDir)
    const outName = `${base}_output`
    const outPath = join(parent, outName)

    try {
      await access(outPath)
    } catch {
      // 基础目录不存在，直接使用
      await grantLocalFileAccess(outPath)
      return outPath
    }

    // 目录存在，读取父级目录下所有子目录寻找最大序号，避免高频 IO
    try {
      const entries = await readdir(parent)
      let maxCounter = 1
      const prefix = `${outName}_`
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const numStr = entry.slice(prefix.length)
          const num = parseInt(numStr, 10)
          if (!isNaN(num) && num > maxCounter) {
            maxCounter = num
          }
        }
      }
      const nextOutPath = join(parent, `${outName}_${maxCounter + 1}`)
      await grantLocalFileAccess(nextOutPath)
      return nextOutPath
    } catch {
      const fallbackOutPath = join(parent, `${outName}_${Date.now()}`)
      await grantLocalFileAccess(fallbackOutPath)
      return fallbackOutPath
    }
  })

  ipcMain.handle('read-images', async (_event, folderPath) => {
    try {
      await grantLocalFileAccess(folderPath)
      const results = []
      const entries = await readdir(folderPath)
      for (const entry of entries) {
        const fullPath = join(folderPath, entry)
        if (isImageFileName(entry)) {
          results.push({
            name: entry,
            path: fullPath,
            url: toLocalFileUrl(fullPath)
          })
        }
      }
      return results
    } catch {
      return []
    }
  })

  ipcMain.handle('read-images-recursive', async (_event, folderPath) => {
    try {
      if (!folderPath) return []
      await grantLocalFileAccess(folderPath)
      return await readImagesRecursiveFromDir(folderPath)
    } catch {
      return []
    }
  })

  ipcMain.handle('create-workflow-run-dir', async (_event, baseDir, name) => {
    try {
      const parent = String(baseDir || '').trim() || getDefaultWorkflowRoot()
      await mkdir(parent, { recursive: true })
      const dirName = `${sanitizeSegment(name, 'workflow', { limit: 80 })}_${timestamp()}`
      const target = await uniqueDirectoryPath(parent, dirName)
      await mkdir(target, { recursive: true })
      await grantLocalFileAccess(target)
      return target
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('resolve-workflow-path', async (_event, root, name) => {
    try {
      const parent = String(root || '').trim()
      if (!parent) return { success: false, error: 'no workflow root' }
      const target = join(parent, sanitizeSegment(name, 'output', { limit: 80 }))
      await mkdir(target, { recursive: true })
      await grantLocalFileAccess(target)
      return target
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('copy-workflow-files', async (_event, files, outputDir) => {
    const results = []
    try {
      if (!Array.isArray(files) || files.length === 0) {
        return { success: false, error: 'no files selected', results }
      }
      if (!outputDir) {
        return { success: false, error: 'no output directory', results }
      }
      await mkdir(outputDir, { recursive: true })
      await grantLocalFileAccess(outputDir)
      for (const filePath of files) {
        try {
          const target = await getAvailableFilePath(outputDir, basename(filePath))
          await copyFile(filePath, target)
          results.push({ source: filePath, path: target, success: true })
        } catch (err) {
          results.push({ source: filePath, success: false, error: err.message })
        }
      }
      const copied = results.filter((item) => item.success).length
      return { success: true, copied, failed: results.length - copied, results }
    } catch (err) {
      return { success: false, error: err.message, results }
    }
  })

  ipcMain.handle('scan-image-sources', scanImageSources)

  ipcMain.handle('load-grab-preview', loadGrabPreview)

  ipcMain.handle('download-grab-images', downloadGrabImages)

  ipcMain.handle('generate-thumbnail', async (_event, filePath) => {
    try {
      const cached = thumbnailCache.get(filePath)
      if (cached) return cached
      const jpegBuffer = await sharp(filePath, { failOn: 'none' })
        .resize(180, 180, { fit: 'cover', withoutEnlargement: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toBuffer()
      const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
      rememberThumbnail(filePath, dataUrl)
      return dataUrl
    } catch {
      return null
    }
  })

  ipcMain.handle('get-image-metadata', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !(await isLocalFileAccessAllowed(filePath))) {
      return { success: false, error: '无法访问该图片' }
    }
    // BMP 等格式可能不受 sharp 支持，仍返回文件信息，由预览图补充分辨率。
    const [fileResult, imageResult] = await Promise.allSettled([
      stat(filePath),
      sharp(filePath, { failOn: 'none' }).metadata()
    ])
    if (fileResult.status === 'rejected') {
      return { success: false, error: fileResult.reason.message }
    }
    const metadata = imageResult.status === 'fulfilled' ? imageResult.value : null
    const width = metadata?.width
    const height = metadata?.pageHeight || metadata?.height
    const rotated = metadata?.orientation >= 5
    return {
      success: true,
      width: rotated ? height : width,
      height: rotated ? width : height,
      size: fileResult.value.size,
      format: (metadata?.format || extname(filePath).slice(1)).toUpperCase(),
      modifiedAt: fileResult.value.mtime.toISOString()
    }
  })

  // 删除图片：移动到同目录下的 del 文件夹（同名文件自动加后缀避免覆盖）
  ipcMain.handle('delete-image', async (_event, filePath) => {
    try {
      const delDir = join(dirname(filePath), 'del')
      await mkdir(delDir, { recursive: true })
      const target = await getAvailableFilePath(delDir, basename(filePath))
      await rename(filePath, target)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // --- Python 后端通用代理 ---
  registerPythonProxy()
  registerTunnelIPC(ipcMain)

  // --- 路径检测 ---
  ipcMain.handle('check-path-exists', async (_event, targetPath) => {
    try {
      const s = await stat(targetPath)
      return { exists: true, isDirectory: s.isDirectory() }
    } catch {
      return { exists: false, isDirectory: false }
    }
  })

  ipcMain.handle('abort-task', async (event) => {
    const cancelled = await cancelLatestTask(event.sender.id)
    return { success: true, cancelled }
  })

  // ---- Tagger: 批量读取标签文件（分批并发，避免文件句柄溢出） ----
  ipcMain.handle('batch-read-tags', async (_event, imagePaths) => {
    const BATCH = 50
    const entries = []
    for (let i = 0; i < imagePaths.length; i += BATCH) {
      const batch = imagePaths.slice(i, i + BATCH)
      const batchResults = await Promise.all(
        batch.map(async (imgPath) => {
          try {
            const content = await readFile(resolveTagPath(imgPath), 'utf-8')
            return [imgPath, content.trim()]
          } catch {
            return [imgPath, '']
          }
        })
      )
      entries.push(...batchResults)
    }
    return Object.fromEntries(entries)
  })

  // ---- Tagger: 保存单个标签文件 ----
  ipcMain.handle('save-image-tags', async (_event, imagePath, tags, outputDir) => {
    if (outputDir) await mkdir(outputDir, { recursive: true })
    try {
      await writeFile(resolveTagPath(imagePath, outputDir), tags, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ---- Tagger: 批量保存标签文件（分批并发） ----
  ipcMain.handle('batch-save-tags', async (_event, tagsMap, outputDir) => {
    if (outputDir) await mkdir(outputDir, { recursive: true })
    const BATCH = 50
    const allEntries = Object.entries(tagsMap)
    let okCount = 0
    let failCount = 0
    for (let i = 0; i < allEntries.length; i += BATCH) {
      const batch = allEntries.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async ([imgPath, tags]) => {
          try {
            await writeFile(resolveTagPath(imgPath, outputDir), tags, 'utf-8')
            return true
          } catch {
            return false
          }
        })
      )
      okCount += results.filter(Boolean).length
      failCount += results.filter((r) => !r).length
    }
    return { success: true, saved: okCount, failed: failCount }
  })
}
