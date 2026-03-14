import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import { readdir, mkdir, rename, access, writeFile, readFile } from 'fs/promises'
import sharp from 'sharp'
import { join, extname, dirname, basename } from 'path'
import { spawn, execSync } from 'child_process'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff', '.tif'])

let pythonProcess = null
let pythonPort = null
let startingPromise = null

function findPythonCommand() {
  // 打包后优先使用内嵌的 Python 环境
  if (app.isPackaged) {
    const embeddedPython = join(process.resourcesPath, 'python_backend', 'python_embed', 'python.exe')
    try {
      execSync(`"${embeddedPython}" --version`, { stdio: 'ignore' })
      return embeddedPython
    } catch { /* 内嵌 Python 不可用，回退到系统 Python */ }
  }

  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' })
      return cmd
    } catch { /* 继续尝试下一个 */ }
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
    const pythonCmd = findPythonCommand()
    const py = spawn(pythonCmd, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Unix: 创建新进程组，方便用 -pid 一次杀掉整个进程树
      ...(process.platform !== 'win32' ? { detached: true } : {})
    })

    pythonProcess = py
    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(new Error('Python 后端启动超时'))
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
      console.error('[Python]', data.toString())
    })

    py.on('error', (err) => {
      console.error('Python 启动失败:', err.message)
      pythonProcess = null
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(err)
      }
    })

    py.on('exit', (code) => {
      console.log('Python 进程退出, code:', code)
      pythonProcess = null
      pythonPort = null
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(new Error(`Python 进程意外退出, code: ${code}`))
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

let taskIdCounter = 0
const activeControllers = new Map() // taskId -> AbortController

async function doFetch(endpoint, body, sender, controller) {
  const resp = await fetch(`http://127.0.0.1:${pythonPort}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data = line.slice(6)
        }
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

// --- 通用 Python 任务注册器：消除重复的 try/catch/abort 样板代码 ---
function handlePythonTask(channel, endpoint, buildBody) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await callPython(endpoint, buildBody(...args), event.sender)
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

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // 根据输入目录生成唯一的同级输出目录路径
  ipcMain.handle('resolve-output-dir', async (_event, inputDir) => {
    const parent = dirname(inputDir)
    const base = basename(inputDir)
    let outName = `${base}_output`
    let outPath = join(parent, outName)
    let counter = 2
    while (true) {
      try {
        await access(outPath)
        // 目录已存在，递增后缀
        outName = `${base}_output_${counter}`
        outPath = join(parent, outName)
        counter++
      } catch {
        // 目录不存在，可以使用
        break
      }
    }
    return outPath
  })

  ipcMain.handle('read-images', async (_event, folderPath) => {
    try {
      const results = []
      const entries = await readdir(folderPath)
      for (const entry of entries) {
        const fullPath = join(folderPath, entry)
        const ext = extname(entry).toLowerCase()
        if (IMAGE_EXTS.has(ext)) {
          results.push({
            name: entry,
            path: fullPath,
            url: `local-file:///${fullPath.replace(/\\/g, '/')}`
          })
        }
      }
      return results
    } catch {
      return []
    }
  })

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
      const stem = name.slice(0, -ext.length || undefined)
      let target = join(delDir, name)
      let counter = 1
      while (true) {
        try {
          await access(target)
          counter++
          target = join(delDir, `${stem}_${counter}${ext}`)
        } catch {
          break
        }
      }
      await rename(filePath, target)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // --- Python 后端任务（通用注册） ---
  handlePythonTask('mirror-flip', '/mirror-flip', (filePaths, outputDir) => ({
    files: filePaths, output_dir: outputDir
  }))

  handlePythonTask('three-stage-split', '/three-stage-split', (filePaths, outputDir, personConf, halfbodyConf, headConf) => ({
    files: filePaths, output_dir: outputDir,
    person_conf: personConf, halfbody_conf: halfbodyConf, head_conf: headConf
  }))

  handlePythonTask('resolution-filter', '/resolution-filter', (filePaths, minWidth, maxWidth, minHeight, maxHeight) => ({
    files: filePaths, min_width: minWidth, max_width: maxWidth, min_height: minHeight, max_height: maxHeight
  }))

  handlePythonTask('batch-resize', '/batch-resize', (filePaths, outputDir, width, height, allowUpscale, faceThreshold) => ({
    files: filePaths, output_dir: outputDir, width, height,
    allow_upscale: allowUpscale, face_threshold: faceThreshold
  }))

  handlePythonTask('format-convert', '/format-convert', (filePaths, outputDir, targetFormat) => ({
    files: filePaths, output_dir: outputDir, target_format: targetFormat
  }))

  handlePythonTask('proportional-crop', '/proportional-crop', (filePaths, outputDir, ratioW, ratioH) => ({
    files: filePaths, output_dir: outputDir, ratio_w: ratioW, ratio_h: ratioH
  }))

  handlePythonTask('auto-crop', '/auto-crop', (filePaths, outputDir, ratioList) => ({
    files: filePaths, output_dir: outputDir, ratio_list: ratioList
  }))

  handlePythonTask('deduplicate', '/deduplicate', (filePaths, hashThresh, phashThresh, colorThresh) => ({
    files: filePaths, hash_thresh: hashThresh, phash_thresh: phashThresh, color_thresh: colorThresh
  }))

  handlePythonTask('cluster', '/cluster', (filePaths, options) => ({
    files: filePaths,
    method: options.method || 'style',
    algorithm: options.algorithm || 'kmeans',
    k: options.k || 5,
    fusion_weights: options.fusionWeights || null,
  }))

  handlePythonTask('cluster-move', '/cluster-move', (filesByGroup, outputDir) => ({
    files_by_group: filesByGroup, output_dir: outputDir
  }))

  handlePythonTask('cutout', '/cutout', (filePaths, outputDir, count, sizeRatio) => ({
    files: filePaths, output_dir: outputDir, count, size_ratio: sizeRatio
  }))

  handlePythonTask('perspective', '/perspective', (filePaths, outputDir, intensity) => ({
    files: filePaths, output_dir: outputDir, intensity
  }))

  handlePythonTask('gaussian-blur-noise', '/gaussian-blur-noise', (filePaths, outputDir, blurRadius, noiseSigma) => ({
    files: filePaths, output_dir: outputDir, blur_radius: blurRadius, noise_sigma: noiseSigma
  }))

  handlePythonTask('tagger-models', '/tagger-models', () => ({}))

  handlePythonTask('tagger-download', '/tagger-download', (modelKey) => ({
    model_key: modelKey
  }))

  handlePythonTask('tagger-tag', '/tagger-tag', (filePaths, modelKey, generalThreshold, characterThreshold) => ({
    files: filePaths, model_key: modelKey,
    general_threshold: generalThreshold, character_threshold: characterThreshold
  }))

  handlePythonTask('upscale', '/upscale', (filePaths, outputDir, scale, denoise, model, style, tta) => ({
    files: filePaths, output_dir: outputDir, scale, denoise, model: model || 'real-cugan',
    style: style || 'art', tta: tta || false
  }))

  handlePythonTask('upscale-models', '/upscale-models', () => ({}))

  // 超分预览：返回 base64，不写盘
  ipcMain.handle('preview-upscale', async (_event, filePath, scale, denoise, model, style, tta) => {
    try {
      return await callPython('/preview-upscale', {
        file: filePath, scale, denoise, model: model || 'real-cugan',
        style: style || 'art', tta: tta || false
      })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // 增强预览：返回 base64，不写盘（响应格式不同，单独处理）
  ipcMain.handle('preview-augment', async (_event, filePath, augType, params) => {
    try {
      return await callPython('/preview-augment', {
        file: filePath, aug_type: augType, params
      })
    } catch (err) {
      return { ok: false, error: err.message }
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
          headers: { 'Content-Type': 'application/json' },
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

  // 清理 Python 端模型缓存，释放内存
  ipcMain.handle('cleanup-caches', async () => {
    try {
      return await callPython('/cleanup-caches', {})
    } catch (err) {
      return { success: false, error: err.message }
    }
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
