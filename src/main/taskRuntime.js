import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { grantLocalFileAccess } from './localFiles'
import { forceStopTunnel, stopTunnel } from './tunnelManager'

const BACKEND_STARTUP_TIMEOUT_MS = 45000
const BACKEND_CONTROL_TIMEOUT_MS = 1500
const BACKEND_SHUTDOWN_TIMEOUT_MS = 3500
const BACKEND_FORCE_KILL_WAIT_MS = 1000
let pythonProcess = null
let pythonPort = null
let startingPromise = null
let shutdownRequested = false
let shutdownIntent = null
let shutdownPromise = null
let shutdownComplete = false
let exitScheduled = false
const pythonAuthToken = randomBytes(32).toString('hex')

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
    }, BACKEND_STARTUP_TIMEOUT_MS)

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
  port = pythonPort,
  body = {}
) {
  if (!port) return false

  try {
    const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IMG-Editor-Token': pythonAuthToken
      },
      body: JSON.stringify(body),
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

async function stopPythonBackend() {
  const child = pythonProcess
  const port = pythonPort

  startingPromise = null
  if (!child && !port) return

  await requestBackendControl('/shutdown', BACKEND_CONTROL_TIMEOUT_MS, port)

  if (isProcessRunning(child)) {
    const exited = await waitForProcessExit(child, BACKEND_SHUTDOWN_TIMEOUT_MS)

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

let taskIdCounter = 0
const activeControllers = new Map()

// Python 和抓取任务共用取消入口；任务表与编号只由运行模块维护。
export function beginTask(sender, backend = false) {
  const taskId = ++taskIdCounter
  const controller = new AbortController()
  activeControllers.set(taskId, { controller, senderId: sender?.id ?? null, backend })
  return { taskId, controller, finish: () => activeControllers.delete(taskId) }
}

function abortActiveControllers() {
  for (const [id, task] of activeControllers) {
    task.controller.abort()
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

async function cancelAllActiveTasks() {
  const backendIds = [...activeControllers]
    .filter(([, task]) => task.backend)
    .map(([id]) => String(id))
  const backendCancel = backendIds.length
    ? await requestBackendControl('/cancel', BACKEND_CONTROL_TIMEOUT_MS, pythonPort, {
        task_ids: backendIds
      })
    : true
  abortActiveControllers()
  return backendCancel
}

export async function cancelLatestTask(senderId) {
  const entry = [...activeControllers.entries()]
    .reverse()
    .find(([, task]) => task.senderId === senderId)
  if (!entry) return false

  const [taskId, task] = entry
  if (task.backend) {
    await requestBackendControl('/cancel', BACKEND_CONTROL_TIMEOUT_MS, pythonPort, {
      task_id: String(taskId)
    })
  }
  task.controller.abort()
  activeControllers.delete(taskId)
  return true
}

async function runForcedQuitShutdown(reason) {
  shutdownRequested = true

  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await cancelAllActiveTasks()
        await stopTunnel()
        await stopPythonBackend()
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

async function doFetch(endpoint, body, sender, controller, taskId) {
  const resp = await fetch(`http://127.0.0.1:${pythonPort}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IMG-Editor-Token': pythonAuthToken,
      'X-IMG-Editor-Task-Id': String(taskId)
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

export async function callPython(endpoint, body, sender) {
  if (!pythonPort) {
    await startPythonBackend()
  }
  const { taskId, controller, finish } = beginTask(sender, true)
  try {
    // 文件任务可能已产生输出，连接失败时交给调用方报错，不自动重放请求。
    const result = await doFetch(endpoint, body, sender, controller, taskId)
    await grantResultLocalFileAccess(body, result)
    return result
  } finally {
    finish()
  }
}

async function grantResultLocalFileAccess(body = {}, result = {}) {
  const dirs = new Set()
  if (body.output_dir) dirs.add(body.output_dir)
  if (result.output_dir) dirs.add(result.output_dir)

  for (const item of Array.isArray(result.results) ? result.results : []) {
    if (item?.path) dirs.add(dirname(item.path))
    if (item?.file) dirs.add(dirname(item.file))
  }

  await Promise.all([...dirs].filter(Boolean).map((dir) => grantLocalFileAccess(dir)))
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
