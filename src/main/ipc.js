import { app, ipcMain, BrowserWindow, dialog, safeStorage } from 'electron'
import { readdir, mkdir, rename, access, writeFile, readFile, stat, copyFile } from 'fs/promises'
import sharp from 'sharp'
import { join, extname, dirname, basename } from 'path'
import { spawn, execSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { grantLocalFileAccess } from './localFileAccess'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif', '.avif'])
const GRAB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GRAB_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
const GRAB_FETCH_TIMEOUT_MS = 15000
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
const pythonAuthToken = randomBytes(32).toString('hex')
const API_CONFIGS_FILE = 'api-configs.secure.json'

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

function resolvePythonRuntime() {
  const candidates = []

  if (process.platform === 'win32') {
    if (app.isPackaged) {
      candidates.push({
        command: join(process.resourcesPath, 'python_backend', 'python_embed', 'python.exe'),
        args: [],
      })
    }
    candidates.push(
      {
        command: join(app.getAppPath(), 'python_backend', 'python_embed', 'python.exe'),
        args: [],
      },
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] }
    )
  } else {
    candidates.push(
      { command: 'python3', args: [] },
      { command: 'python', args: [] }
    )
  }

  for (const candidate of candidates) {
    if (canRunPython(candidate.command, candidate.args)) {
      return candidate
    }
  }

  return candidates[0]
}

function startPythonBackend() {
  if (startingPromise) return startingPromise
  if (pythonPort) return Promise.resolve(pythonPort)

  startingPromise = new Promise((resolve, reject) => {
    const backendDir = app.isPackaged
      ? join(process.resourcesPath, 'python_backend')
      : join(app.getAppPath(), 'python_backend')
    const scriptPath = join(backendDir, 'server.py')
    const pythonRuntime = resolvePythonRuntime()
    const pythonCommandText = [pythonRuntime.command, ...(pythonRuntime.args || [])].join(' ')
    const py = spawn(pythonRuntime.command, [...(pythonRuntime.args || []), scriptPath], {
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

    const buildPythonStartupError = (message) => {
      const hint = process.platform === 'win32'
        ? '请先运行 `npm run setup:python` 准备 python_backend/python_embed，或安装 Python 3 并加入 PATH。'
        : '请先安装 Python 3，或提供可用的 Python 可执行文件。'
      const details = stderrBuffer.trim()
      return [message, `启动命令: ${pythonCommandText}`, hint, details].filter(Boolean).join('\n')
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(new Error(buildPythonStartupError('Python 后端启动超时，未能正常返回端口。')))
      }
    }, 10000)

    py.stdout.on('data', (data) => {
      const msg = data.toString().trim()
      // 后端启动后会输出 "PORT:xxxxx"
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
      pythonProcess = null
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(new Error(buildPythonStartupError(`Python 后端启动失败: ${err.message}`)))
      }
    })

    py.on('exit', (code) => {
      console.log('Python 进程退出, code:', code)
      pythonProcess = null
      pythonPort = null
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(new Error(buildPythonStartupError(`Python 进程意外退出，code: ${code}`)))
      }
    })
  }).finally(() => {
    startingPromise = null
  })

  return startingPromise
}

function stopPythonBackend() {
  if (pythonProcess) {
    const pid = pythonProcess.pid
    try {
      // Windows 下必须用 taskkill /T 杀掉整个进程树（包括 ProcessPoolExecutor 的 worker 子进程）
      // 否则 worker 进程会变成孤儿进程，持续占用内存（尤其是加载了 ONNX 模型的 worker）
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      } else {
        // Unix 系统发送信号给进程组
        try { process.kill(-pid, 'SIGKILL') } catch { pythonProcess.kill('SIGKILL') }
      }
    } catch {
      // 进程可能已经退出
      try { pythonProcess.kill() } catch { /* ignore */ }
    }
    pythonProcess = null
    pythonPort = null
    startingPromise = null
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
  if (protectedValue.encoding !== 'safeStorage' || !protectedValue.value) return ''
  return safeStorage.decryptString(Buffer.from(protectedValue.value, 'base64'))
}

async function readApiConfigs() {
  try {
    const raw = JSON.parse(await readFile(apiConfigsPath(), 'utf-8'))
    const configs = Array.isArray(raw?.configs) ? raw.configs : []
    return configs.map((config) => ({
      id: String(config.id || ''),
      name: String(config.name || ''),
      model: String(config.model || ''),
      endpoint: String(config.endpoint || ''),
      apiKey: decryptApiKey(config.apiKeyProtected),
      enabled: config.enabled !== false
    })).filter((config) => config.id)
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

function grabFetchSignal(taskSignal) {
  return AbortSignal.any([taskSignal, AbortSignal.timeout(GRAB_FETCH_TIMEOUT_MS)])
}

function grabFetchErrorMessage(err, fallback) {
  return err.name === 'TimeoutError' ? '请求超时' : (err.message || fallback)
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
          } catch { /* ignore */ }
        } else if (event === 'error') {
          try {
            const errData = JSON.parse(data)
            result = { success: false, error: errData.error || errData.message || data }
          } catch {
            result = { success: false, error: data }
          }
        } else if (event === 'done') {
          try { result = JSON.parse(data) } catch { /* ignore */ }
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
      stopPythonBackend()
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

  const plainImageUrlPattern = /https?:\/\/[^"' <>)]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?[^"' <>)]+)?/gi
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
  }).join('')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
  return (cleaned || 'image').slice(0, 140)
}

function getContentTypeExt(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase()
  return GRAB_TYPE_TO_EXT.get(normalized) || ''
}

function buildGrabHeaders(referer = '', accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8') {
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
  } catch { /* ignore */ }

  return `${clean}.jpg`
}

async function getUniqueGrabPath(outputDir, filename) {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  let target = join(outputDir, filename)
  let counter = 2
  while (true) {
    try {
      await access(target)
      target = join(outputDir, `${stem}_${counter}${ext}`)
      counter += 1
    } catch {
      return target
    }
  }
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
            headers: buildGrabHeaders('', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'),
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

        const filename = ensureImageExtension(item.filename || deriveGrabFilename(url, item.type), url, contentType)
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
        results.push({ id: item.id, url, success: false, error: grabFetchErrorMessage(err, '保存失败') })
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
      const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
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
  return `local-file:///${filePath.replace(/\\/g, '/')}`
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
  return String(value || 'workflow')
    .split('')
    .map((char) => (reservedChars.has(char) || char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/\s+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 80) || 'workflow'
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
  let target = join(parent, name)
  let counter = 2
  while (true) {
    try {
      await access(target)
      target = join(parent, `${name}_${counter}`)
      counter += 1
    } catch {
      return target
    }
  }
}

async function uniqueCopyTarget(outputDir, sourcePath) {
  const sourceName = basename(sourcePath)
  const ext = extname(sourceName)
  const stem = ext ? sourceName.slice(0, -ext.length) : sourceName
  let target = join(outputDir, sourceName)
  let counter = 2
  while (true) {
    try {
      await access(target)
      target = join(outputDir, `${stem}_${counter}${ext}`)
      counter += 1
    } catch {
      return target
    }
  }
}

export function registerIPC() {
  ipcMain.on('quit-app', (event) => {
    stopPythonBackend()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.destroy()
    app.quit()
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

  ipcMain.handle('migrate-api-configs', async (_event, legacyConfigs) => migrateApiConfigs(legacyConfigs))

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
      const jpegBuffer = await sharp(filePath, { failOn: 'none' })
        .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      return `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
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
            const numStr = ext ? entry.slice(prefix.length, -ext.length) : entry.slice(prefix.length)
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
    // 先中断 Node 端的 fetch 请求
    for (const [id, controller] of activeControllers) {
      controller.abort()
      activeControllers.delete(id)
    }
    // 尝试优雅取消 Python 端正在执行的任务
    if (pythonPort) {
      try {
        await fetch(`http://127.0.0.1:${pythonPort}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-IMG-Editor-Token': pythonAuthToken
          },
          body: '{}',
          signal: AbortSignal.timeout(2000)
        })
        return { success: true }
      } catch {
        // 优雅取消失败，回退到杀进程
        stopPythonBackend()
      }
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

// 应用退出时清理 Python 进程
app.on('will-quit', () => {
  stopPythonBackend()
})
