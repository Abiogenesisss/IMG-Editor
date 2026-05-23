import { BrowserWindow } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { chmodSync, unlinkSync, writeFileSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
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

let tunnelProcess = null
let tunnelClient = null
let tunnelReadyTimer = null
let tunnelStopping = false
let tunnelAskpassPath = ''
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

function terminateProcess(child) {
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

function cleanupAskpassHelper() {
  if (!tunnelAskpassPath) return
  const helperPath = tunnelAskpassPath
  tunnelAskpassPath = ''
  try {
    unlinkSync(helperPath)
  } catch {
    /* ignore */
  }
}

function makeAskpassEnv(password) {
  if (!password) return {}

  cleanupAskpassHelper()
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  if (process.platform === 'win32') {
    tunnelAskpassPath = join(tmpdir(), `img-editor-ssh-askpass-${suffix}.cmd`)
    writeFileSync(tunnelAskpassPath, '@echo off\r\n<nul set /p "=%IMG_EDITOR_SSH_PASSWORD%"\r\n', {
      mode: 0o700
    })
  } else {
    tunnelAskpassPath = join(tmpdir(), `img-editor-ssh-askpass-${suffix}.sh`)
    writeFileSync(tunnelAskpassPath, '#!/bin/sh\nprintf "%s" "$IMG_EDITOR_SSH_PASSWORD"\n', {
      mode: 0o700
    })
    chmodSync(tunnelAskpassPath, 0o700)
  }

  return {
    SSH_ASKPASS: tunnelAskpassPath,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'img-editor',
    IMG_EDITOR_SSH_PASSWORD: password
  }
}

function canConnectLocalPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: Number(port)
    })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(350)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function areLocalForwardsReady(mappings) {
  for (const mapping of mappings) {
    const ok = await canConnectLocalPort(mapping.localPort)
    if (!ok) return false
  }
  return true
}

function scheduleTunnelReadyCheck(child, mappings) {
  const started = Date.now()
  const timeoutMs = 12000

  const check = async () => {
    if (tunnelProcess !== child || !isProcessRunning(child)) return

    if (await areLocalForwardsReady(mappings)) {
      cleanupAskpassHelper()
      setTunnelState({ state: 'running', pid: child.pid, error: '' })
      appendTunnelLog('success', '隧道已运行')
      return
    }

    if (Date.now() - started < timeoutMs) {
      tunnelReadyTimer = setTimeout(check, 400)
      return
    }

    const ports = mappings.map((item) => `127.0.0.1:${item.localPort}`).join('、')
    const message = `SSH 进程已启动，但本地端口未监听：${ports}。通常是密码认证卡住、密码错误，或 ssh 未能建立端口转发。`
    setTunnelState({
      state: 'error',
      pid: null,
      stoppedAt: new Date().toISOString(),
      error: message
    })
    appendTunnelLog('error', message)
    forceKillProcessTree(child)
    if (tunnelProcess === child) tunnelProcess = null
    cleanupAskpassHelper()
  }

  clearTimeout(tunnelReadyTimer)
  tunnelReadyTimer = setTimeout(check, 250)
}

function forceKillProcessTree(child = tunnelProcess) {
  if (!isProcessRunning(child) || !child.pid) return

  try {
    if (process.platform === 'win32') {
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

function buildTunnelCommand(config = {}) {
  const mappings = normalizeTunnelMappings(config.mappings)
  const tokens = tokenizeCommand(extractSshCommand(config.command))
  if (!tokens.length || !isSshCommand(tokens[0])) {
    throw new Error('SSH 指令必须以 ssh 或 ssh.exe 开头')
  }

  const ssh = tokens[0]
  const args = tokens.slice(1)
  const sshOptions = []
  const trailing = []
  let destination = ''

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      sshOptions.push(arg)
      if (sshOptionConsumesValue(arg) && i + 1 < args.length) {
        sshOptions.push(args[i + 1])
        i += 1
      }
      continue
    }

    if (!destination) destination = arg
    else trailing.push(arg)
  }

  if (!destination) throw new Error('SSH 指令里缺少 user@host')
  if (trailing.length) throw new Error('SSH 指令只保留登录部分，不要追加远端命令')

  const forwardArgs = []
  for (const mapping of mappings) {
    forwardArgs.push('-L', `${mapping.localPort}:127.0.0.1:${mapping.remotePort}`)
  }

  return {
    command: ssh,
    args: [
      ...sshOptions,
      '-N',
      '-T',
      '-o',
      'BatchMode=no',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...forwardArgs,
      destination
    ],
    mappings
  }
}

function commandPreview(command, args) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ')
}

function buildSshConnectionConfig(config = {}) {
  const { command, args, mappings } = buildTunnelCommand(config)
  const tokens = tokenizeCommand(extractSshCommand(config.command))
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
  }

  const atIndex = destination.lastIndexOf('@')
  const host = atIndex >= 0 ? destination.slice(atIndex + 1) : destination
  if (atIndex >= 0 && !username) username = destination.slice(0, atIndex)

  if (!host || !username) throw new Error('SSH 指令需要包含 user@host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须是 1-65535')

  return {
    command,
    args,
    preview: commandPreview(command, args),
    mappings,
    ssh: {
      host,
      port,
      username,
      password: String(config.password || ''),
      readyTimeout: 12000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3
    }
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
            appendTunnelLog('error', `转发流错误 ${mapping.localPort}->${mapping.remotePort}：${streamErr.message}`)
          })
          socket.pipe(stream)
          stream.pipe(socket)
        }
      )
    })

    server.once('error', reject)
    server.listen(Number(mapping.localPort), '127.0.0.1', () => {
      server.off('error', reject)
      tunnelServers.push({ server, mapping })
      appendTunnelLog('success', `本地端口已监听：127.0.0.1:${mapping.localPort} -> 云端 ${mapping.remotePort}`)
      resolve()
    })
  })
}

async function openForwardServers(client, mappings) {
  for (const mapping of mappings) {
    await listenForwardServer(client, mapping)
  }
}

function handleTunnelOutput(child, source, data, password) {
  const text = data.toString()
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) appendTunnelLog(source, line)

  if (/are you sure you want to continue connecting/i.test(text)) {
    try {
      if (child.stdin?.writable) child.stdin.write('yes\n')
      appendTunnelLog('info', '已确认新的 SSH 主机指纹')
    } catch {
      /* ignore */
    }
  }

  if (password && /(password|passphrase).*:\s*$/i.test(text)) {
    try {
      if (child.stdin?.writable) child.stdin.write(`${password}\n`)
      appendTunnelLog('info', '已发送 SSH 密码')
    } catch {
      /* ignore */
    }
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
  const child = tunnelProcess
  clearTimeout(tunnelReadyTimer)
  cleanupAskpassHelper()
  if (!child && !tunnelClient && tunnelServers.length === 0) {
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

  if (child) {
    terminateProcess(child)
    const exited = await waitForProcessExit(child, 1800)
    if (!exited) {
      forceKillProcessTree(child)
      await waitForProcessExit(child, 1000)
    }
  }

  if (tunnelProcess === child) tunnelProcess = null
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
  if ((tunnelProcess && isProcessRunning(tunnelProcess)) || tunnelClient || tunnelServers.length) {
    await stopTunnel()
  }

  const { preview, mappings, ssh } = buildSshConnectionConfig(config)
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
  clearTimeout(tunnelReadyTimer)
  cleanupAskpassHelper()
  closeForwardResources()
  if (tunnelClient) {
    try {
      tunnelClient.destroy()
    } catch {
      /* ignore */
    }
  }
  tunnelClient = null
  if (tunnelProcess) forceKillProcessTree(tunnelProcess)
  tunnelProcess = null
  tunnelStopping = false
}
