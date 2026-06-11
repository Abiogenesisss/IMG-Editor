import { BrowserWindow } from 'electron'
import net from 'net'
import { Client as SshClient } from 'ssh2'

const TUNNEL_LOG_LIMIT = 160
const SSH_OPTIONS_WITH_VALUE = new Set([
  '-B',
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w'
])

let tunnelClient = null
let tunnelStopping = false
let tunnelServers = []
const tunnelSockets = new Set()
const tunnelStreams = new Set()
const tunnelLogs = []
let tunnelState = {
  state: 'stopped',
  pid: null,
  startedAt: null,
  stoppedAt: null,
  command: '',
  mappings: [],
  error: ''
}

function closeForwardResources() {
  for (const socket of tunnelSockets) {
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  }
  tunnelSockets.clear()

  for (const stream of tunnelStreams) {
    try {
      stream.destroy()
    } catch {
      /* ignore */
    }
  }
  tunnelStreams.clear()

  const servers = tunnelServers
  tunnelServers = []
  return Promise.all(
    servers.map(
      ({ server }) =>
        new Promise((resolve) => {
          try {
            server.close(() => resolve())
          } catch {
            resolve()
          }
        })
    )
  )
}

function tunnelSnapshot() {
  return {
    success: true,
    ...tunnelState,
    running: tunnelState.state === 'running' || tunnelState.state === 'starting',
    logs: tunnelLogs.slice(-TUNNEL_LOG_LIMIT)
  }
}

function emitTunnelEvent(type, payload = {}) {
  const message = { type, ...payload }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('tunnel-event', message)
    }
  }
}

function setTunnelState(next) {
  tunnelState = { ...tunnelState, ...next }
  emitTunnelEvent('status', { status: tunnelSnapshot() })
}

function appendTunnelLog(level, message) {
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    level,
    message: String(message || '').trim()
  }
  if (!entry.message) return
  tunnelLogs.push(entry)
  while (tunnelLogs.length > TUNNEL_LOG_LIMIT) tunnelLogs.shift()
  emitTunnelEvent('log', { entry, status: tunnelSnapshot() })
}

function normalizeTunnelPort(value, label) {
  const text = String(value || '').trim()
  if (!/^\d+$/.test(text)) throw new Error(`${label} 必须是 1-65535 的端口号`)
  const port = Number(text)
  if (port < 1 || port > 65535) throw new Error(`${label} 必须是 1-65535 的端口号`)
  return String(port)
}

function normalizeTunnelMappings(input) {
  const rows = Array.isArray(input) ? input : []
  const mappings = rows
    .filter((row) => row && row.enabled !== false)
    .map((row, index) => {
      const remotePort = normalizeTunnelPort(
        row.remotePort ?? row.remote ?? row.port,
        `第 ${index + 1} 行云端端口`
      )
      const localPort = normalizeTunnelPort(
        row.localPort ?? row.local ?? remotePort,
        `第 ${index + 1} 行本地端口`
      )
      return {
        id: String(row.id || `${localPort}-${remotePort}`),
        localPort,
        remotePort
      }
    })

  if (!mappings.length) throw new Error('至少需要一条启用的端口映射')

  const localPorts = new Set()
  for (const mapping of mappings) {
    if (localPorts.has(mapping.localPort)) {
      throw new Error(`本地端口 ${mapping.localPort} 被重复使用`)
    }
    localPorts.add(mapping.localPort)
  }

  return mappings
}

function canListenLocalPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      if (server.listening) {
        server.close(() => resolve(result))
      } else {
        resolve(result)
      }
    }

    server.once('error', (err) => finish({ ok: false, error: err }))
    server.listen(Number(port), '127.0.0.1', () => finish({ ok: true }))
  })
}

function formatLocalPortError(mapping, err) {
  if (err?.code === 'EADDRINUSE') {
    return `本地端口 ${mapping.localPort} 已被占用，请换一个本地端口或先关闭占用程序`
  }
  if (err?.code === 'EACCES') {
    return `本地端口 ${mapping.localPort} 没有监听权限，请换一个本地端口`
  }
  return `本地端口 ${mapping.localPort} 无法监听：${err?.message || '未知错误'}`
}

async function assertLocalPortsAvailable(mappings) {
  for (const mapping of mappings) {
    const result = await canListenLocalPort(mapping.localPort)
    if (!result.ok) throw new Error(formatLocalPortError(mapping, result.error))
  }
}

function extractSshCommand(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('请填写 SSH 登录指令')

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const cmdLine =
    lines.find((line) => /^cmd\s*=/.test(line)) ||
    lines.find((line) => /\bssh(?:\.exe)?\b/i.test(line)) ||
    text

  if (/^cmd\s*=/.test(cmdLine)) {
    const value = cmdLine.replace(/^cmd\s*=\s*/, '').trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1)
      if (end > 0) return value.slice(1, end).trim()
    }
    return value.replace(/\s+#.*$/, '').trim()
  }

  return cmdLine
}

function tokenizeCommand(command) {
  const tokens = []
  let current = ''
  let quote = ''

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = ''
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (quote) throw new Error('SSH 指令里有未闭合的引号')
  if (current) tokens.push(current)
  return tokens
}

function isSshCommand(command) {
  return /(^|[\\/])ssh(?:\.exe)?$/i.test(command)
}

function sshOptionConsumesValue(token) {
  if (SSH_OPTIONS_WITH_VALUE.has(token)) return true
  if (/^-[A-Za-z].+/.test(token)) return false
  return false
}

function buildSshConnectionConfig(config = {}) {
  const mappings = normalizeTunnelMappings(config.mappings)
  const tokens = tokenizeCommand(extractSshCommand(config.command))
  if (!tokens.length || !isSshCommand(tokens[0])) {
    throw new Error('SSH 指令必须以 ssh 或 ssh.exe 开头')
  }

  const rawArgs = tokens.slice(1)
  let port = 22
  let username = ''
  let destination = ''

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === '-p' && i + 1 < rawArgs.length) {
      port = Number(rawArgs[i + 1])
      i += 1
      continue
    }
    if (/^-p\d+$/.test(arg)) {
      port = Number(arg.slice(2))
      continue
    }
    if (arg === '-l' && i + 1 < rawArgs.length) {
      username = rawArgs[i + 1]
      i += 1
      continue
    }
    if (/^-l.+/.test(arg)) {
      username = arg.slice(2)
      continue
    }
    if (arg.startsWith('-')) {
      if (sshOptionConsumesValue(arg) && i + 1 < rawArgs.length) i += 1
      continue
    }
    if (!destination) destination = arg
    else throw new Error('SSH 指令只保留登录部分，不要追加远端命令')
  }

  const atIndex = destination.lastIndexOf('@')
  const host = atIndex >= 0 ? destination.slice(atIndex + 1) : destination
  if (atIndex >= 0 && !username) username = destination.slice(0, atIndex)

  if (!host || !username) throw new Error('SSH 指令需要包含 user@host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须是 1-65535')

  const ssh = {
    host,
    port,
    username,
    password: String(config.password || ''),
    readyTimeout: 12000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3
  }

  return {
    preview: `${ssh.username}@${ssh.host}:${ssh.port}`,
    mappings,
    ssh
  }
}

function listenForwardServer(client, mapping) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      tunnelSockets.add(socket)
      socket.once('close', () => tunnelSockets.delete(socket))
      socket.once('error', (err) => {
        appendTunnelLog('error', `本地连接错误 ${mapping.localPort}：${err.message}`)
      })

      client.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        '127.0.0.1',
        Number(mapping.remotePort),
        (err, stream) => {
          if (err) {
            appendTunnelLog('error', `远端端口 ${mapping.remotePort} 连接失败：${err.message}`)
            socket.destroy()
            return
          }

          tunnelStreams.add(stream)
          stream.once('close', () => tunnelStreams.delete(stream))
          stream.once('error', (streamErr) => {
            appendTunnelLog(
              'error',
              `转发流错误 ${mapping.localPort}->${mapping.remotePort}：${streamErr.message}`
            )
          })
          socket.pipe(stream)
          stream.pipe(socket)
        }
      )
    })

    const onListenError = (err) => reject(new Error(formatLocalPortError(mapping, err)))
    server.once('error', onListenError)
    server.listen(Number(mapping.localPort), '127.0.0.1', () => {
      server.off('error', onListenError)
      tunnelServers.push({ server, mapping })
      appendTunnelLog(
        'success',
        `本地端口已监听：127.0.0.1:${mapping.localPort} -> 云端 ${mapping.remotePort}`
      )
      resolve()
    })
  })
}

async function openForwardServers(client, mappings) {
  for (const mapping of mappings) {
    await listenForwardServer(client, mapping)
  }
}

export function getTunnelStatus() {
  return tunnelSnapshot()
}

export function registerTunnelIPC(ipcMain) {
  ipcMain.handle('tunnel-status', () => getTunnelStatus())

  ipcMain.handle('tunnel-start', async (_event, config = {}) => {
    try {
      return await startTunnel(config)
    } catch (err) {
      return {
        ...getTunnelStatus(),
        success: false,
        error: err.message || '隧道启动失败'
      }
    }
  })

  ipcMain.handle('tunnel-stop', async () => {
    try {
      return await stopTunnel()
    } catch (err) {
      return {
        ...getTunnelStatus(),
        success: false,
        error: err.message || '隧道停止失败'
      }
    }
  })
}

export async function stopTunnel() {
  if (!tunnelClient && tunnelServers.length === 0) {
    setTunnelState({
      state: 'stopped',
      pid: null,
      stoppedAt: tunnelState.stoppedAt || new Date().toISOString()
    })
    return tunnelSnapshot()
  }

  tunnelStopping = true
  setTunnelState({ state: 'stopping' })
  appendTunnelLog('info', '正在停止隧道')

  await closeForwardResources()

  if (tunnelClient) {
    try {
      tunnelClient.end()
    } catch {
      /* ignore */
    }
    tunnelClient = null
  }

  tunnelStopping = false
  setTunnelState({
    state: 'stopped',
    pid: null,
    stoppedAt: new Date().toISOString(),
    error: ''
  })
  appendTunnelLog('info', '隧道已停止')
  return tunnelSnapshot()
}

export async function startTunnel(config = {}) {
  if (tunnelClient || tunnelServers.length) {
    await stopTunnel()
  }

  const { preview, mappings, ssh } = buildSshConnectionConfig(config)
  await assertLocalPortsAvailable(mappings)
  const startedAt = new Date().toISOString()

  tunnelLogs.length = 0
  setTunnelState({
    state: 'starting',
    pid: null,
    startedAt,
    stoppedAt: null,
    command: preview,
    mappings,
    error: ''
  })
  appendTunnelLog('info', `启动隧道：${preview}`)

  const client = new SshClient()
  tunnelClient = client

  client.on('ready', async () => {
    appendTunnelLog('success', `SSH 已认证：${ssh.username}@${ssh.host}:${ssh.port}`)
    try {
      await openForwardServers(client, mappings)
      if (tunnelClient === client) {
        setTunnelState({ state: 'running', pid: null, error: '' })
        appendTunnelLog('success', '隧道已运行')
      }
    } catch (err) {
      const message = err.message || '本地端口监听失败'
      appendTunnelLog('error', message)
      await closeForwardResources()
      try {
        client.end()
      } catch {
        /* ignore */
      }
      if (tunnelClient === client) tunnelClient = null
      setTunnelState({
        state: 'error',
        pid: null,
        stoppedAt: new Date().toISOString(),
        error: message
      })
    }
  })

  client.on('error', (err) => {
    if (tunnelClient === client) tunnelClient = null
    const message = err.message || 'SSH 连接失败'
    setTunnelState({
      state: 'error',
      pid: null,
      stoppedAt: new Date().toISOString(),
      error: message
    })
    appendTunnelLog('error', message)
  })

  client.on('close', async () => {
    await closeForwardResources()
    if (tunnelClient === client) tunnelClient = null
    const stoppedAt = new Date().toISOString()
    if (tunnelStopping) {
      setTunnelState({ state: 'stopped', pid: null, stoppedAt, error: '' })
      return
    }

    if (tunnelState.state === 'running' || tunnelState.state === 'starting') {
      const message = 'SSH 连接已断开'
      setTunnelState({ state: 'error', pid: null, stoppedAt, error: message })
      appendTunnelLog('error', message)
    }
  })

  client.connect(ssh)
  return tunnelSnapshot()
}

export function forceStopTunnel() {
  closeForwardResources()
  if (tunnelClient) {
    try {
      tunnelClient.destroy()
    } catch {
      /* ignore */
    }
  }
  tunnelClient = null
  tunnelStopping = false
}
