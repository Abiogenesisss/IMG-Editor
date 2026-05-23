import { app, ipcMain, BrowserWindow, dialog, safeStorage } from 'electron'
import { readdir, mkdir, rename, access, writeFile, readFile, stat, copyFile } from 'fs/promises'
import sharp from 'sharp'
import { join, extname, dirname, basename } from 'path'
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { pathToFileURL } from 'url'
import { grantLocalFileAccess } from './localFileAccess'
import { forceStopTunnel, registerTunnelIPC, stopTunnel } from './tunnelManager'

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
const GRAB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GRAB_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
const GRAB_FETCH_TIMEOUT_MS = 15000
const BACKEND_CONTROL_TIMEOUT_MS = 1500
const BACKEND_SHUTDOWN_TIMEOUT_MS = 3500
const BACKEND_FORCE_KILL_WAIT_MS = 1000
const GRAB_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image']
const GRAB_EXT_TO_TYPE = new Map([
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
  ['.gif', 'gif'],
  ['.bmp', 'bmp'],
  ['.tif', 'tiff'],
  ['.tiff', 'tiff'],
  ['.avif', 'avif']
])
const GRAB_TYPE_TO_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff'],
  ['image/avif', '.avif']
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

let pythonProcess = null
let pythonPort = null
let startingPromise = null
let shutdownRequested = false
let shutdownIntent = null
let shutdownPromise = null
let shutdownComplete = false
let exitScheduled = false
const pythonAuthToken = randomBytes(32).toString('hex')
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

function canRunPython(command, args = []) {
  try {
    const result = spawnSync(command, [...args, '--version'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 3000
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

function isWindowsAppPython(command) {
  return String(command || '')
    .replace(/\//g, '\\')
    .toLowerCase()
    .includes('\\microsoft\\windowsapps\\')
}

function registeredPythonCandidates() {
  if (process.platform !== 'win32') return []
  const roots = [
    'HKCU\\Software\\Python\\PythonCore',
    'HKLM\\Software\\Python\\PythonCore',
    'HKLM\\Software\\WOW6432Node\\Python\\PythonCore'
  ]
  const candidates = []

  for (const root of roots) {
    const result = spawnSync('reg.exe', ['query', root, '/s', '/v', 'ExecutablePath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    if (result.error || result.status !== 0) continue

    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = line.match(/ExecutablePath\s+REG_\w+\s+(.+)$/)
      const command = match?.[1]?.trim()
      if (command && !isWindowsAppPython(command)) {
        candidates.push({ command, args: [] })
      }
    }
  }

  return candidates
}

function resolvePythonCandidates() {
  const candidates = []

  if (process.platform === 'win32') {
    const systemCandidates = [
      ...registeredPythonCandidates(),
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] }
    ]
    if (app.isPackaged) {
      candidates.push(...systemCandidates)
      candidates.push({
        command: join(process.resourcesPath, 'python_backend', 'python_embed', 'python.exe'),
        args: []
      })
    } else {
      candidates.push(...systemCandidates)
      candidates.push({
        command: join(app.getAppPath(), 'python_backend', 'python_embed', 'python.exe'),
        args: []
      })
    }
  } else {
    candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] })
  }

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = [candidate.command, ...(candidate.args || [])].join('\0').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return canRunPython(candidate.command, candidate.args)
  })
}

function formatPythonCommand(candidate) {
  return [candidate.command, ...(candidate.args || [])].join(' ')
}

function buildPythonStartupError(message, attempts) {
  const hint =
    process.platform === 'win32'
      ? '请确认系统 Python 已安装所需依赖，或准备 python_backend/python_embed 基础运行时。'
      : '请确认 Python 3 已安装所需依赖。'
  const details = attempts
    .map((attempt) => {
      const error = attempt.error ? `\n${attempt.error}` : ''
      return `启动命令: ${attempt.command}${error}`
    })
    .join('\n\n')
  return [message, hint, details].filter(Boolean).join('\n')
}

function startPythonCandidate(candidate, scriptPath, attempts) {
  const pythonCommandText = formatPythonCommand(candidate)

  return new Promise((resolve, reject) => {
    const py = spawn(candidate.command, [...(candidate.args || []), scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        IMG_EDITOR_BACKEND_TOKEN: pythonAuthToken
      },
      // Unix: 创建新进程组，方便用 -pid 一次杀掉整个进程树
      ...(process.platform !== 'win32' ? { detached: true } : {})
    })

    pythonProcess = py
    let resolved = false
    let stderrBuffer = ''

    const fail = (error) => {
      attempts.push({ command: pythonCommandText, error })
      reject(new Error(error))
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try {
          py.kill()
        } catch {
          /* ignore */
        }
        if (pythonProcess === py) {
          pythonProcess = null
          pythonPort = null
        }
        fail('Python 后端启动超时，未能正常返回端口。')
      }
    }, 10000)

    py.stdout.on('data', (data) => {
      const msg = data.toString().trim()
      const portMatch = msg.match(/^PORT:(\d+)/)
      if (portMatch && !resolved) {
        resolved = true
        clearTimeout(timer)
        pythonPort = parseInt(portMatch[1])
        resolve(pythonPort)
      }
    })

    py.stderr.on('data', (data) => {
      const text = data.toString()
      stderrBuffer = `${stderrBuffer}${text}`.slice(-4000)
      console.error('[Python]', text)
    })

    py.on('error', (err) => {
      console.error('Python 启动失败:', err.message)
      if (pythonProcess === py) {
        pythonProcess = null
        pythonPort = null
      }
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        fail(`Python 后端启动失败: ${err.message}`)
      }
    })

    py.on('exit', (code) => {
      console.log('Python 进程退出, code:', code)
      if (pythonProcess === py) {
        pythonProcess = null
        pythonPort = null
      }
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        const details = stderrBuffer.trim()
        fail([`Python 进程意外退出，code: ${code}`, details].filter(Boolean).join('\n'))
      }
    })
  })
}

async function startPythonBackendImpl() {
  const backendDir = app.isPackaged
    ? join(process.resourcesPath, 'python_backend')
    : join(app.getAppPath(), 'python_backend')
  const scriptPath = join(backendDir, 'server.py')
  const candidates = resolvePythonCandidates()
  const attempts = []

  if (candidates.length === 0) {
    throw new Error(buildPythonStartupError('未找到可执行的 Python 运行时。', attempts))
  }

  for (const candidate of candidates) {
    if (shutdownRequested) {
      throw new Error('Application is shutting down')
    }
    try {
      return await startPythonCandidate(candidate, scriptPath, attempts)
    } catch {
      // Try the next Python runtime.
    }
  }

  throw new Error(
    buildPythonStartupError('Python 后端启动失败，所有候选 Python 都不可用。', attempts)
  )
}

function startPythonBackend() {
  if (shutdownRequested) return Promise.reject(new Error('Application is shutting down'))
  if (startingPromise) return startingPromise
  if (pythonPort) return Promise.resolve(pythonPort)

  startingPromise = startPythonBackendImpl().finally(() => {
    startingPromise = null
  })

  return startingPromise
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function waitForProcessExit(child, timeoutMs) {
  if (!isProcessRunning(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onExit)
      resolve(result)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onExit)
  })
}

async function requestBackendControl(
  endpoint,
  timeoutMs = BACKEND_CONTROL_TIMEOUT_MS,
  port = pythonPort
) {
  if (!port) return false

  try {
    const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IMG-Editor-Token': pythonAuthToken
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return resp.ok
  } catch {
    return false
  }
}

function terminatePythonProcess(child) {
  if (!isProcessRunning(child)) return

  try {
    if (process.platform === 'win32') {
      child.kill()
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

function forceKillPythonProcessTree(child = pythonProcess) {
  if (!isProcessRunning(child) || !child.pid) return

  try {
    if (process.platform === 'win32') {
      // Kill the whole tree so ProcessPoolExecutor workers do not survive shutdown.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 3000
      })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

async function stopPythonBackend({ cancel = false, graceful = true } = {}) {
  const child = pythonProcess
  const port = pythonPort

  startingPromise = null
  if (!child && !port) return

  if (cancel) {
    await requestBackendControl('/cancel', BACKEND_CONTROL_TIMEOUT_MS, port)
  }

  if (graceful) {
    await requestBackendControl('/shutdown', BACKEND_CONTROL_TIMEOUT_MS, port)
  }

  if (isProcessRunning(child)) {
    const exited = graceful ? await waitForProcessExit(child, BACKEND_SHUTDOWN_TIMEOUT_MS) : false

    if (!exited) {
      terminatePythonProcess(child)
      await delay(BACKEND_FORCE_KILL_WAIT_MS)
      forceKillPythonProcessTree(child)
      await waitForProcessExit(child, BACKEND_FORCE_KILL_WAIT_MS)
    }
  }

  if (pythonProcess === child) pythonProcess = null
  if (pythonPort === port) pythonPort = null
  startingPromise = null
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
  if (protectedValue.encoding !== 'safeStorage' || !protectedValue.value) return ''
  return safeStorage.decryptString(Buffer.from(protectedValue.value, 'base64'))
}

async function readApiConfigs() {
  try {
    const raw = JSON.parse(await readFile(apiConfigsPath(), 'utf-8'))
    const configs = Array.isArray(raw?.configs) ? raw.configs : []
    return configs
      .map((config) => ({
        id: String(config.id || ''),
        name: String(config.name || ''),
        model: String(config.model || ''),
        endpoint: String(config.endpoint || ''),
        apiKey: decryptApiKey(config.apiKeyProtected),
        enabled: config.enabled !== false
      }))
      .filter((config) => config.id)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    console.warn('Failed to read API configs:', err.message)
    return []
  }
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
  const current = await readApiConfigs()
  if (current.length > 0) {
    return { migrated: false, configs: current }
  }
  const configs = Array.isArray(legacyConfigs) ? legacyConfigs.map(normalizeApiConfig) : []
  if (configs.length === 0) {
    return { migrated: false, configs: [] }
  }
  return { migrated: true, configs: await writeApiConfigs(configs) }
}

let taskIdCounter = 0
const activeControllers = new Map() // taskId -> AbortController

function abortActiveControllers() {
  for (const [id, controller] of activeControllers) {
    controller.abort()
    activeControllers.delete(id)
  }
}

function destroyAllWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

async function cancelActiveTasks() {
  const backendCancel = requestBackendControl('/cancel')
  abortActiveControllers()
  return backendCancel
}

async function runForcedQuitShutdown(reason) {
  shutdownRequested = true

  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await cancelActiveTasks()
        await stopTunnel()
        await stopPythonBackend({ graceful: true })
      } catch (err) {
        console.warn(`Shutdown cleanup failed during ${reason}:`, err)
      } finally {
        destroyAllWindows()
        shutdownComplete = true
      }
    })()
  }

  return shutdownPromise
}

export function isForcedQuitInProgress() {
  return Boolean(shutdownIntent || shutdownPromise) && !shutdownComplete
}

export function requestForcedQuit(reason = 'app') {
  if (shutdownIntent === 'update-restart') return shutdownPromise || Promise.resolve()
  shutdownIntent = 'exit'

  const quitPromise = runForcedQuitShutdown(reason)
  if (!exitScheduled) {
    exitScheduled = true
    quitPromise.finally(() => {
      setImmediate(() => app.exit(0))
    })
  }
  return quitPromise
}

export async function prepareForUpdateRestart() {
  shutdownIntent = 'update-restart'
  await runForcedQuitShutdown('update-restart')
}

function forceQuitApp() {
  requestForcedQuit('quit-app')
}

function grabFetchSignal(taskSignal) {
  return AbortSignal.any([taskSignal, AbortSignal.timeout(GRAB_FETCH_TIMEOUT_MS)])
}

function grabFetchErrorMessage(err, fallback) {
  return err.name === 'TimeoutError' ? '请求超时' : err.message || fallback
}

async function doFetch(endpoint, body, sender, controller) {
  const resp = await fetch(`http://127.0.0.1:${pythonPort}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IMG-Editor-Token': pythonAuthToken
    },
    body: JSON.stringify(body),
    signal: controller.signal
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Python 后端错误: ${resp.status} ${text}`)
  }

  const contentType = resp.headers.get('Content-Type') || ''

  // SSE 流式响应：逐块解析事件，实时推送进度，返回最终 done 数据
  if (contentType.includes('text/event-stream')) {
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按双换行拆分完整的 SSE 事件块
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 2)

        let event = ''
        let dataLines = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
          else if (line.startsWith('data:')) dataLines.push(line.slice(5))
        }
        const data = dataLines.join('\n')
        if (!event || !data) continue

        if (event === 'progress' && sender) {
          try {
            sender.send('task-progress', JSON.parse(data))
          } catch {
            /* ignore */
          }
        } else if (event === 'error') {
          try {
            const errData = JSON.parse(data)
            result = { success: false, error: errData.error || errData.message || data }
          } catch {
            result = { success: false, error: data }
          }
        } else if (event === 'done') {
          try {
            result = JSON.parse(data)
          } catch {
            /* ignore */
          }
        }
      }
    }

    return result || { success: false, error: 'no done event' }
  }

  // 普通 JSON 响应
  return resp.json()
}

async function callPython(endpoint, body, sender) {
  if (!pythonPort) {
    await startPythonBackend()
  }
  const taskId = ++taskIdCounter
  const controller = new AbortController()
  activeControllers.set(taskId, controller)
  try {
    try {
      return await doFetch(endpoint, body, sender, controller)
    } catch (err) {
      // 连接被拒绝说明 Python 进程已崩溃，尝试重启一次
      if (err.name === 'AbortError') throw err
      const isConnErr = err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')
      if (!isConnErr) throw err

      console.warn('Python 后端连接失败，正在重启…', err.message)
      await stopPythonBackend()
      await startPythonBackend()
      return await doFetch(endpoint, body, sender, controller)
    }
  } finally {
    activeControllers.delete(taskId)
  }
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

function decodeHtmlEntities(value) {
  if (!value) return ''
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function normalizeSourceUrl(value, baseUrl) {
  const raw = decodeHtmlEntities(String(value || '').trim())
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:')) {
    return null
  }
  try {
    const url = new URL(raw, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function getUrlImageExt(url) {
  try {
    return extname(new URL(url).pathname).toLowerCase()
  } catch {
    return ''
  }
}

function getUrlImageType(url) {
  return GRAB_EXT_TO_TYPE.get(getUrlImageExt(url)) || ''
}

function matchesAllowedTypes(url, allowedTypes) {
  const ext = getUrlImageExt(url)
  if (!ext) return true

  const type = GRAB_EXT_TO_TYPE.get(ext)
  if (!type) return false

  return !allowedTypes || allowedTypes.size === 0 || allowedTypes.has(type)
}

function looksLikeImageUrl(url) {
  return Boolean(getUrlImageType(url))
}

function splitSrcset(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function parseAttributes(tag) {
  const attrs = {}
  const attrPattern = /([:@\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let match
  while ((match = attrPattern.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
  }
  return attrs
}

function buildGrabItem(url, sourceUrl, sourceKind, sourceIndex) {
  const type = getUrlImageType(url)
  return {
    id: `${sourceIndex}-${Buffer.from(url).toString('base64url').slice(0, 24)}`,
    url,
    source: sourceUrl,
    sourceKind,
    filename: deriveGrabFilename(url, type),
    type
  }
}

function pushGrabCandidate(list, seen, url, sourceUrl, sourceKind, sourceIndex, allowedTypes) {
  if (!url || seen.has(url) || !matchesAllowedTypes(url, allowedTypes)) return
  seen.add(url)
  list.push(buildGrabItem(url, sourceUrl, sourceKind, sourceIndex))
}

function extractImageCandidates(html, pageUrl, options) {
  const { includeSrcset, allowedTypes, maxPerSource, sourceIndex } = options
  const items = []
  const seen = new Set()

  const tagPattern = /<(img|source|meta|link)\b[^>]*>/gi
  let tagMatch
  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tagName = tagMatch[1].toLowerCase()
    const attrs = parseAttributes(tagMatch[0])

    if (tagName === 'img' || tagName === 'source') {
      for (const attr of GRAB_ATTRS) {
        const url = normalizeSourceUrl(attrs[attr], pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'page', sourceIndex, allowedTypes)
      }
      if (includeSrcset) {
        for (const attr of ['srcset', 'data-srcset']) {
          for (const entry of splitSrcset(attrs[attr])) {
            const url = normalizeSourceUrl(entry, pageUrl)
            pushGrabCandidate(items, seen, url, pageUrl, 'page', sourceIndex, allowedTypes)
          }
        }
      }
    } else if (tagName === 'meta') {
      const metaKey = `${attrs.property || ''} ${attrs.name || ''}`.toLowerCase()
      if (metaKey.includes('image')) {
        const url = normalizeSourceUrl(attrs.content, pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'meta', sourceIndex, allowedTypes)
      }
    } else if (tagName === 'link') {
      const rel = String(attrs.rel || '').toLowerCase()
      const asType = String(attrs.as || '').toLowerCase()
      const type = String(attrs.type || '').toLowerCase()
      if (asType === 'image' || type.startsWith('image/') || rel.includes('icon')) {
        const url = normalizeSourceUrl(attrs.href, pageUrl)
        pushGrabCandidate(items, seen, url, pageUrl, 'link', sourceIndex, allowedTypes)
      }
    }

    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  const cssUrlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
  let cssMatch
  while ((cssMatch = cssUrlPattern.exec(html)) !== null) {
    const url = normalizeSourceUrl(cssMatch[2], pageUrl)
    if (url && looksLikeImageUrl(url)) {
      pushGrabCandidate(items, seen, url, pageUrl, 'style', sourceIndex, allowedTypes)
    }
    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  const plainImageUrlPattern =
    /https?:\/\/[^"' <>)]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?[^"' <>)]+)?/gi
  let plainMatch
  while ((plainMatch = plainImageUrlPattern.exec(html)) !== null) {
    const url = normalizeSourceUrl(plainMatch[0], pageUrl)
    pushGrabCandidate(items, seen, url, pageUrl, 'inline', sourceIndex, allowedTypes)
    if (items.length >= maxPerSource) return items.slice(0, maxPerSource)
  }

  return items.slice(0, maxPerSource)
}

function normalizeGrabSources(sources) {
  if (Array.isArray(sources)) return sources.map((s) => String(s || '').trim()).filter(Boolean)
  return String(sources || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalizeAllowedTypes(types) {
  if (!Array.isArray(types)) return new Set()
  return new Set(types.map((type) => String(type || '').toLowerCase()).filter(Boolean))
}

function deriveGrabFilename(url, type = '') {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname)
    const name = basename(pathname) || `image.${type || 'jpg'}`
    return sanitizeGrabFilename(name)
  } catch {
    return `image.${type || 'jpg'}`
  }
}

function sanitizeGrabFilename(name) {
  const cleaned = Array.from(String(name || ''), (char) => {
    const code = char.charCodeAt(0)
    return code < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char
  })
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
  return (cleaned || 'image').slice(0, 140)
}

function getContentTypeExt(contentType) {
  const normalized = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return GRAB_TYPE_TO_EXT.get(normalized) || ''
}

function buildGrabHeaders(
  referer = '',
  accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
) {
  const headers = {
    'User-Agent': GRAB_USER_AGENT,
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  if (referer) headers.Referer = referer
  return headers
}

function ensureImageExtension(filename, url, contentType) {
  const clean = sanitizeGrabFilename(filename)
  const currentExt = extname(clean).toLowerCase()
  if (GRAB_EXT_TO_TYPE.has(currentExt)) return clean

  const contentExt = getContentTypeExt(contentType)
  if (contentExt) return `${clean}${contentExt}`

  try {
    const urlExt = extname(new URL(url).pathname).toLowerCase()
    if (GRAB_EXT_TO_TYPE.has(urlExt)) return `${clean}${urlExt}`
  } catch {
    /* ignore */
  }

  return `${clean}.jpg`
}

async function getAvailablePath(initialPath, makeNextPath) {
  let target = initialPath
  let counter = 2
  while (true) {
    try {
      await access(target)
      target = makeNextPath(counter)
      counter += 1
    } catch {
      return target
    }
  }
}

async function getUniqueGrabPath(outputDir, filename) {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  return getAvailablePath(join(outputDir, filename), (counter) =>
    join(outputDir, `${stem}_${counter}${ext}`)
  )
}

async function scanImageSources(event, body = {}) {
  const sources = normalizeGrabSources(body.sources)
  const allowedTypes = normalizeAllowedTypes(body.file_types)
  const includeSrcset = body.include_srcset !== false
  const maxPerSource = Math.max(1, Math.min(parseInt(body.max_per_source, 10) || 120, 500))
  const items = []
  const errors = []
  const seen = new Set()

  if (sources.length === 0) {
    return { success: false, error: '请输入至少一个 URL。' }
  }

  const taskId = ++taskIdCounter
  const controller = new AbortController()
  activeControllers.set(taskId, controller)

  try {
    for (let index = 0; index < sources.length; index += 1) {
      const rawSource = sources[index]
      const sourceUrl = normalizeSourceUrl(rawSource)
      if (!sourceUrl) {
        errors.push({ source: rawSource, error: 'URL 无效' })
        continue
      }

      try {
        if (looksLikeImageUrl(sourceUrl)) {
          pushGrabCandidate(items, seen, sourceUrl, sourceUrl, 'direct', index, allowedTypes)
        } else {
          const response = await fetch(sourceUrl, {
            headers: buildGrabHeaders(
              '',
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            ),
            signal: grabFetchSignal(controller.signal)
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)

          const contentType = response.headers.get('content-type') || ''
          if (contentType.toLowerCase().startsWith('image/')) {
            pushGrabCandidate(items, seen, sourceUrl, sourceUrl, 'direct', index, allowedTypes)
          } else {
            const html = await response.text()
            const extracted = extractImageCandidates(html, sourceUrl, {
              includeSrcset,
              allowedTypes,
              maxPerSource,
              sourceIndex: index
            })
            for (const item of extracted) {
              if (!seen.has(item.url)) {
                seen.add(item.url)
                items.push(item)
              }
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err
        errors.push({ source: rawSource, error: grabFetchErrorMessage(err, '抓取失败') })
      } finally {
        event.sender.send('task-progress', {
          scope: 'grab-scan',
          done: index + 1,
          total: sources.length,
          current: rawSource
        })
      }
    }

    return { success: true, items, errors }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, aborted: true }
    return { success: false, error: err.message || '抓取失败', items, errors }
  } finally {
    activeControllers.delete(taskId)
  }
}

async function downloadGrabImages(event, body = {}) {
  const items = Array.isArray(body.items) ? body.items : []
  const outputDir = String(body.output_dir || '').trim()
  const results = []

  if (items.length === 0) return { success: false, error: '没有选择要保存的图片。' }
  if (!outputDir) return { success: false, error: '请选择输出目录。' }

  const taskId = ++taskIdCounter
  const controller = new AbortController()
  activeControllers.set(taskId, controller)

  try {
    await mkdir(outputDir, { recursive: true })

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const url = normalizeSourceUrl(item.url)
      if (!url) {
        results.push({ id: item.id, url: item.url, success: false, error: 'URL 无效' })
        continue
      }

      try {
        const response = await fetch(url, {
          headers: buildGrabHeaders(item.source || url),
          signal: grabFetchSignal(controller.signal)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.toLowerCase().startsWith('image/') && !looksLikeImageUrl(url)) {
          throw new Error(`非图片响应: ${contentType || 'unknown'}`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length === 0) throw new Error('空文件')

        const filename = ensureImageExtension(
          item.filename || deriveGrabFilename(url, item.type),
          url,
          contentType
        )
        const targetPath = await getUniqueGrabPath(outputDir, filename)
        await writeFile(targetPath, buffer)
        results.push({
          id: item.id,
          url,
          success: true,
          path: targetPath,
          filename: basename(targetPath),
          bytes: buffer.length
        })
      } catch (err) {
        if (err.name === 'AbortError') throw err
        results.push({
          id: item.id,
          url,
          success: false,
          error: grabFetchErrorMessage(err, '保存失败')
        })
      } finally {
        event.sender.send('task-progress', {
          scope: 'grab-download',
          done: index + 1,
          total: items.length,
          current: item.filename || item.url
        })
      }
    }

    const saved = results.filter((item) => item.success).length
    return {
      success: true,
      output_dir: outputDir,
      saved,
      failed: results.length - saved,
      results
    }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, aborted: true, results }
    return { success: false, error: err.message || '保存失败', results }
  } finally {
    activeControllers.delete(taskId)
  }
}

async function loadGrabPreview(_event, body = {}) {
  const url = normalizeSourceUrl(body.url)
  const referer = normalizeSourceUrl(body.source) || url

  if (!url) return { success: false, error: 'URL 无效' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      headers: buildGrabHeaders(referer),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().startsWith('image/') && !looksLikeImageUrl(url)) {
      throw new Error(`非图片响应: ${contentType || 'unknown'}`)
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    if (contentLength > GRAB_PREVIEW_MAX_BYTES) {
      throw new Error('图片过大，跳过预览')
    }

    const input = Buffer.from(await response.arrayBuffer())
    if (input.length === 0) throw new Error('空文件')
    if (input.length > GRAB_PREVIEW_MAX_BYTES) throw new Error('图片过大，跳过预览')

    try {
      const preview = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer()
      return {
        success: true,
        dataUrl: `data:image/webp;base64,${preview.toString('base64')}`
      }
    } catch (err) {
      const mime = String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (mime.startsWith('image/') && input.length <= 8 * 1024 * 1024) {
        return {
          success: true,
          dataUrl: `data:${mime};base64,${input.toString('base64')}`
        }
      }
      throw err
    }
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, error: '预览加载超时' }
    return { success: false, error: err.message || '预览加载失败' }
  } finally {
    clearTimeout(timer)
  }
}

function isImageFileName(name) {
  return IMAGE_EXTS.has(extname(name).toLowerCase())
}

function toLocalFileUrl(filePath) {
  return pathToFileURL(filePath)
    .toString()
    .replace(/^file:/, 'local-file:')
}

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0
  const pos = (sortedValues.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sortedValues[base + 1]
  if (next === undefined) return sortedValues[base]
  return sortedValues[base] + rest * (next - sortedValues[base])
}

function roundToNearestMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function approximateRatio(ar, maxDenominator = 16) {
  let best = { w: 1, h: 1, ar: 1, error: Math.abs(ar - 1) }
  for (let h = 1; h <= maxDenominator; h += 1) {
    const w = Math.max(1, Math.round(ar * h))
    const candidateAr = w / h
    const error = Math.abs(candidateAr - ar)
    if (error < best.error) {
      const div = gcd(w, h)
      best = { w: w / div, h: h / div, ar: candidateAr, error }
    }
  }
  return best
}

function collectRatioBuckets(images, options) {
  const maxDenominator = Math.max(
    2,
    Math.round(clampNumber(options.maxRatioDenominator, 16, 2, 200))
  )
  const groups = new Map()

  for (const image of images) {
    const ratio = approximateRatio(image.ar, maxDenominator)
    const key = `${ratio.w}:${ratio.h}`
    const existing = groups.get(key) || {
      w: ratio.w,
      h: ratio.h,
      targetAr: ratio.w / ratio.h,
      count: 0,
      examples: []
    }
    existing.count += 1
    if (existing.examples.length < 5) {
      existing.examples.push({
        name: image.name,
        width: image.width,
        height: image.height,
        ar: image.ar
      })
    }
    groups.set(key, existing)
  }

  return [...groups.values()].sort((a, b) => a.targetAr - b.targetAr)
}

function sizeBucketForAr(ar, baseResolution, bucketStep) {
  const area = baseResolution * baseResolution
  const width = roundToNearestMultiple(Math.sqrt(area * ar), bucketStep)
  const height = roundToNearestMultiple(area / Math.sqrt(area * ar), bucketStep)
  return { width, height, actualAr: width / height }
}

function simulateTrainingBuckets(images, options) {
  const minAr = clampNumber(options.minAr, 0.5, 0.01, 100)
  const maxAr = clampNumber(options.maxAr, 2.0, minAr, 100)
  const baseResolution = Math.max(
    64,
    Math.round(clampNumber(options.baseResolution, 1024, 64, 8192))
  )
  const bucketStep = Math.max(1, Math.round(clampNumber(options.bucketStep, 16, 1, 1024)))
  const batchSize = Math.max(1, Math.round(clampNumber(options.batchSize, 4, 1, 1000000)))
  const exactRatios = collectRatioBuckets(images, options)

  const buckets = exactRatios.map((ratio, index) => ({
    index,
    targetAr: ratio.targetAr,
    ratio: [ratio.w, ratio.h],
    ratioLabel: `${ratio.w}:${ratio.h}`,
    ...sizeBucketForAr(ratio.targetAr, baseResolution, bucketStep),
    count: 0,
    used: 0,
    dropped: 0,
    examples: [],
    images: []
  }))

  for (const image of images) {
    const logAr = Math.log(image.ar)
    let bestIndex = 0
    let bestDiff = Infinity
    for (let i = 0; i < buckets.length; i += 1) {
      const diff = Math.abs(logAr - Math.log(buckets[i].targetAr))
      if (diff < bestDiff) {
        bestDiff = diff
        bestIndex = i
      }
    }
    const bucket = buckets[bestIndex]
    bucket.count += 1
    bucket.images.push({
      name: image.name,
      path: image.path,
      url: image.url,
      width: image.width,
      height: image.height,
      ar: image.ar
    })
    if (bucket.examples.length < 5) {
      bucket.examples.push({
        name: image.name,
        width: image.width,
        height: image.height,
        ar: image.ar
      })
    }
  }

  for (const bucket of buckets) {
    bucket.used = Math.floor(bucket.count / batchSize) * batchSize
    bucket.dropped = bucket.count - bucket.used
  }

  const nonEmptyBuckets = buckets.filter((bucket) => bucket.count > 0)
  const usableImages = buckets.reduce((sum, bucket) => sum + bucket.used, 0)
  const tailDroppedImages = buckets.reduce((sum, bucket) => sum + bucket.dropped, 0)

  return {
    minAr,
    maxAr,
    numArBuckets: exactRatios.length,
    arBuckets: exactRatios.map((ratio) => [ratio.w, ratio.h]),
    baseResolution,
    bucketStep,
    batchSize,
    totalImages: images.length,
    nonEmptyBucketCount: nonEmptyBuckets.length,
    usableImages,
    tailDroppedImages,
    efficiency: images.length ? (usableImages / images.length) * 100 : 0,
    buckets
  }
}

function recommendArRange(images) {
  const ars = images.map((image) => image.ar).sort((a, b) => a - b)
  const q05 = quantile(ars, 0.05)
  const q50 = quantile(ars, 0.5)
  const q95 = quantile(ars, 0.95)
  return {
    q05,
    q50,
    q95,
    minAr: Math.max(0.5, q05 * 0.8),
    maxAr: Math.min(2.0, q95 * 1.2)
  }
}

async function collectImageFiles(folderPath, recursive) {
  const files = []

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
        if (recursive) await visit(fullPath)
      } else if (entry.isFile() && isImageFileName(entry.name)) {
        files.push(fullPath)
      }
    }
  }

  await visit(folderPath)
  return files.sort((a, b) => a.localeCompare(b))
}

async function readImageDimensions(filePath) {
  const metadata = await sharp(filePath, { pages: 1, limitInputPixels: false }).metadata()
  const width = metadata.width || 0
  const height = metadata.height || 0
  if (!width || !height) throw new Error('missing image dimensions')
  return { width, height }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

function buildBucketToml(result) {
  const arPairs = result.arBuckets?.length
    ? result.arBuckets.map(([w, h]) => `[${w}, ${h}]`).join(', ')
    : ''
  const exactLines = arPairs
    ? [
        '# Exact aspect-ratio buckets derived from the dataset.',
        '# When ar_buckets is set, diffusion-pipe uses these ratios directly.',
        `ar_buckets = [${arPairs}]`,
        ''
      ]
    : []
  return [
    `resolutions = [${result.baseResolution}]`,
    '',
    'enable_ar_bucket = true',
    ...exactLines,
    arPairs ? '# Kept for GUI compatibility; ar_buckets takes priority.' : '',
    `min_ar = ${result.minAr.toFixed(3)}`,
    `max_ar = ${result.maxAr.toFixed(3)}`,
    `num_ar_buckets = ${result.numArBuckets}`,
    '',
    'frame_buckets = [1]'
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
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

function sanitizeWorkflowSegment(value) {
  const reservedChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  return (
    String(value || 'workflow')
      .split('')
      .map((char) => (reservedChars.has(char) || char.charCodeAt(0) < 32 ? '_' : char))
      .join('')
      .replace(/\s+/g, '_')
      .replace(/\.+$/g, '')
      .slice(0, 80) || 'workflow'
  )
}

function getDefaultWorkflowRoot() {
  return join(app.getPath('userData'), 'workflow_runs')
}

function workflowTimestamp() {
  const d = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function uniqueDirectoryPath(parent, name) {
  return getAvailablePath(join(parent, name), (counter) => join(parent, `${name}_${counter}`))
}

async function uniqueCopyTarget(outputDir, sourcePath) {
  const sourceName = basename(sourcePath)
  const ext = extname(sourceName)
  const stem = ext ? sourceName.slice(0, -ext.length) : sourceName
  return getAvailablePath(join(outputDir, sourceName), (counter) =>
    join(outputDir, `${stem}_${counter}${ext}`)
  )
}

export function registerIPC() {
  ipcMain.on('quit-app', (event) => {
    forceQuitApp(event.sender)
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
      return join(parent, `${outName}_${maxCounter + 1}`)
    } catch {
      // 降级保护：如果读取目录失败，用时间戳保证不冲突
      return join(parent, `${outName}_${Date.now()}`)
    }
  })

  ipcMain.handle('read-images', async (_event, folderPath) => {
    try {
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
      return await readImagesRecursiveFromDir(folderPath)
    } catch {
      return []
    }
  })

  ipcMain.handle('analyze-training-buckets', async (_event, options = {}) => {
    try {
      const folderPath = String(options.folderPath || '').trim()
      if (!folderPath) return { success: false, error: '请选择训练集目录' }

      const files = await collectImageFiles(folderPath, options.recursive !== false)
      if (!files.length) return { success: false, error: '目录中没有找到图片文件' }

      const scanned = await mapWithConcurrency(files, 8, async (filePath) => {
        try {
          const { width, height } = await readImageDimensions(filePath)
          return {
            ok: true,
            name: basename(filePath),
            path: filePath,
            url: toLocalFileUrl(filePath),
            width,
            height,
            ar: width / height
          }
        } catch (err) {
          return {
            ok: false,
            name: basename(filePath),
            path: filePath,
            error: err.message
          }
        }
      })

      const images = scanned.filter((item) => item.ok)
      const skipped = scanned.filter((item) => !item.ok)
      if (!images.length) return { success: false, error: '图片尺寸读取失败，请检查文件格式' }

      const rangeStats = recommendArRange(images)
      const minAr = options.useRecommendedRange
        ? rangeStats.minAr
        : clampNumber(options.minAr, rangeStats.minAr, 0.01, 100)
      const maxAr = options.useRecommendedRange
        ? rangeStats.maxAr
        : clampNumber(options.maxAr, rangeStats.maxAr, minAr, 100)

      const baseOptions = {
        ...options,
        minAr,
        maxAr
      }
      const result = simulateTrainingBuckets(images, baseOptions)
      const sortedArs = images.map((image) => image.ar).sort((a, b) => a - b)

      return {
        success: true,
        folderPath,
        totalFiles: files.length,
        totalImages: images.length,
        skippedCount: skipped.length,
        skipped: skipped.slice(0, 20),
        stats: {
          minAr: sortedArs[0],
          maxAr: sortedArs[sortedArs.length - 1],
          q05: rangeStats.q05,
          medianAr: rangeStats.q50,
          q95: rangeStats.q95,
          recommendedMinAr: rangeStats.minAr,
          recommendedMaxAr: rangeStats.maxAr
        },
        result,
        toml: buildBucketToml(result)
      }
    } catch (err) {
      return { success: false, error: err.message || '分桶分析失败' }
    }
  })

  ipcMain.handle('create-workflow-run-dir', async (_event, baseDir, name) => {
    try {
      const parent = String(baseDir || '').trim() || getDefaultWorkflowRoot()
      await mkdir(parent, { recursive: true })
      const dirName = `${sanitizeWorkflowSegment(name)}_${workflowTimestamp()}`
      const target = await uniqueDirectoryPath(parent, dirName)
      await mkdir(target, { recursive: true })
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
      for (const filePath of files) {
        try {
          const target = await uniqueCopyTarget(outputDir, filePath)
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

  // 删除图片：移动到同目录下的 del 文件夹（同名文件自动加后缀避免覆盖）
  ipcMain.handle('delete-image', async (_event, filePath) => {
    try {
      const dir = dirname(filePath)
      const name = basename(filePath)
      const delDir = join(dir, 'del')
      await mkdir(delDir, { recursive: true })

      const ext = extname(name)
      const stem = ext ? name.slice(0, -ext.length) : name
      const target = join(delDir, name)

      try {
        await access(target)
      } catch {
        // 目标不存在，直接移动
        await rename(filePath, target)
        return { success: true }
      }

      // 目标存在，读取 del 目录并匹配最大序号，避免高频 IO
      try {
        const entries = await readdir(delDir)
        let maxCounter = 1
        const prefix = `${stem}_`
        for (const entry of entries) {
          if (entry.startsWith(prefix) && (!ext || entry.endsWith(ext))) {
            const numStr = ext
              ? entry.slice(prefix.length, -ext.length)
              : entry.slice(prefix.length)
            const num = parseInt(numStr, 10)
            if (!isNaN(num) && num > maxCounter) {
              maxCounter = num
            }
          }
        }
        const newTarget = join(delDir, `${stem}_${maxCounter + 1}${ext}`)
        await rename(filePath, newTarget)
        return { success: true }
      } catch {
        // 读取出错，降级使用时间戳
        const tsTarget = join(delDir, `${stem}_${Date.now()}${ext}`)
        await rename(filePath, tsTarget)
        return { success: true }
      }
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

  // 终止所有进行中的任务
  ipcMain.handle('abort-task', async () => {
    const cancelled = await cancelActiveTasks()
    if (!cancelled && pythonPort) {
      await stopPythonBackend({ graceful: true })
    }
    return { success: true }
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

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  requestForcedQuit('before-quit')
})

// 应用退出时清理 Python 进程
app.on('will-quit', () => {
  shutdownRequested = true
  abortActiveControllers()
  forceStopTunnel()
  if (!shutdownComplete) forceKillPythonProcessTree()
})
