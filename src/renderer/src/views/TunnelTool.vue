<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Cable, Clipboard, Play, Plus, RotateCcw, Square, Terminal, Trash2 } from 'lucide-vue-next'
import { useLocalStorage } from '../composables/useLocalStorage'

defineOptions({ name: 'TunnelTool' })

function makeMapping(remotePort = '', localPort = remotePort) {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    enabled: true,
    remotePort,
    localPort
  }
}

const sshCommand = useLocalStorage('tunnel-ssh-command', '')
const mappings = useLocalStorage('tunnel-port-mappings', [makeMapping('6006', '6006')], {
  type: 'json'
})

if (!Array.isArray(mappings.value) || mappings.value.length === 0) {
  mappings.value = [makeMapping('6006', '6006')]
}

const sshPassword = ref('')
const configText = ref('')
const actionError = ref('')
const copiedPort = ref('')
const tunnelStatus = ref({
  state: 'stopped',
  running: false,
  logs: [],
  mappings: [],
  command: '',
  error: ''
})

const stateLabel = computed(() => {
  const labels = {
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    error: '异常'
  }
  return labels[tunnelStatus.value.state] || tunnelStatus.value.state || '未知'
})

const stateClass = computed(() => `state-${tunnelStatus.value.state || 'stopped'}`)
const isBusy = computed(
  () => tunnelStatus.value.state === 'starting' || tunnelStatus.value.state === 'stopping'
)
const isActive = computed(
  () => tunnelStatus.value.state === 'running' || tunnelStatus.value.state === 'starting'
)
const enabledMappings = computed(() => mappings.value.filter((row) => row.enabled !== false))
const visibleMappings = computed(() =>
  tunnelStatus.value.mappings?.length ? tunnelStatus.value.mappings : enabledMappings.value
)
const portValidationError = computed(() => {
  if (!enabledMappings.value.length) return '至少需要一条启用的端口映射'

  const localPorts = new Set()
  for (const [index, row] of enabledMappings.value.entries()) {
    const remotePort = String(row.remotePort || '').trim()
    const localPort = String(row.localPort || row.remotePort || '').trim()
    const remoteError = validatePort(remotePort, `第 ${index + 1} 行云端端口`)
    if (remoteError) return remoteError

    const localError = validatePort(localPort, `第 ${index + 1} 行本地端口`)
    if (localError) return localError

    if (localPorts.has(localPort)) return `本地端口 ${localPort} 被重复使用`
    localPorts.add(localPort)
  }

  return ''
})
const visibleError = computed(
  () => actionError.value || tunnelStatus.value.error || portValidationError.value
)
const canStart = computed(
  () => sshCommand.value.trim() && !portValidationError.value && !isBusy.value
)
const logs = computed(() => tunnelStatus.value.logs || [])

let removeTunnelListener = null

function syncStatus(status) {
  if (status) tunnelStatus.value = { ...tunnelStatus.value, ...status }
}

function errorMessage(err, fallback) {
  return err?.message || String(err || '') || fallback
}

function validatePort(value, label) {
  if (!/^\d+$/.test(value)) return `${label} 必须是 1-65535 的端口号`
  const port = Number(value)
  if (port < 1 || port > 65535) return `${label} 必须是 1-65535 的端口号`
  return ''
}

function getStartPayload() {
  return {
    command: String(sshCommand.value || ''),
    password: String(sshPassword.value || ''),
    mappings: enabledMappings.value.map((row) => ({
      id: String(row.id || ''),
      enabled: row.enabled !== false,
      remotePort: String(row.remotePort || '').trim(),
      localPort: String(row.localPort || row.remotePort || '').trim()
    }))
  }
}

async function refreshStatus() {
  try {
    const result = await window.api.getTunnelStatus()
    syncStatus(result)
  } catch (err) {
    actionError.value = errorMessage(err, '刷新隧道状态失败')
  }
}

function addMapping() {
  mappings.value.push(makeMapping())
}

function removeMapping(id) {
  if (mappings.value.length <= 1) {
    mappings.value = [makeMapping()]
    return
  }
  mappings.value = mappings.value.filter((row) => row.id !== id)
}

function resetMappings() {
  mappings.value = [makeMapping('6006', '6006')]
}

function readConfigValue(key) {
  const pattern = new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\n#]+))`, 'i')
  const match = configText.value.match(pattern)
  if (!match) return ''
  return (match[2] || match[3] || match[4] || '').trim()
}

function parsePorts() {
  const match = configText.value.match(/ports\s*=\s*\[([^\]]*)\]/i)
  if (!match) return []
  const parts = match[1].match(/"[^"]+"|'[^']+'|[^,\s]+/g) || []
  return parts
    .map((part) => part.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean)
    .map((value) => {
      const [remotePort, localPort] = value.split(':').map((item) => item.trim())
      return makeMapping(remotePort, localPort || remotePort)
    })
}

function importConfig() {
  actionError.value = ''
  const cmd = readConfigValue('cmd')
  const password = readConfigValue('password')
  const ports = parsePorts()
  if (!cmd && !password && ports.length === 0) {
    actionError.value = '没有识别到 cmd、password 或 ports'
    return
  }
  if (cmd) sshCommand.value = cmd
  if (password) sshPassword.value = password
  if (ports.length) mappings.value = ports
}

async function start() {
  actionError.value = ''
  copiedPort.value = ''
  if (portValidationError.value) return
  try {
    const result = await window.api.startTunnel(getStartPayload())
    syncStatus(result)
    if (!result.success) actionError.value = result.error || '隧道启动失败'
  } catch (err) {
    actionError.value = errorMessage(err, '隧道启动失败')
    refreshStatus().catch(() => {})
  }
}

async function stop() {
  actionError.value = ''
  try {
    const result = await window.api.stopTunnel()
    syncStatus(result)
    if (!result.success) actionError.value = result.error || '隧道停止失败'
  } catch (err) {
    actionError.value = errorMessage(err, '隧道停止失败')
    refreshStatus().catch(() => {})
  }
}

async function copyLocalUrl(port) {
  const text = `http://127.0.0.1:${port}`
  try {
    await navigator.clipboard.writeText(text)
    copiedPort.value = String(port)
    setTimeout(() => {
      if (copiedPort.value === String(port)) copiedPort.value = ''
    }, 1200)
  } catch {
    actionError.value = '复制失败'
  }
}

onMounted(() => {
  refreshStatus().catch(() => {})
  removeTunnelListener = window.api.onTunnelEvent((event) => {
    if (event?.status) syncStatus(event.status)
  })
})

watch(
  [sshCommand, mappings],
  () => {
    actionError.value = ''
  },
  { deep: true }
)

onBeforeUnmount(() => {
  if (removeTunnelListener) removeTunnelListener()
})
</script>

<template>
  <div class="tunnel-page">
    <div class="tunnel-toolbar">
      <div class="tunnel-heading">
        <Cable :size="18" :stroke-width="2.2" aria-hidden="true" />
        <span>隧道工具</span>
      </div>

      <div class="toolbar-actions">
        <button class="action-btn" type="button" :disabled="isBusy" @click="refreshStatus">
          <RotateCcw :size="15" />
          刷新
        </button>
        <button
          v-if="!isActive"
          class="action-btn primary"
          type="button"
          :disabled="!canStart"
          @click="start"
        >
          <Play :size="15" />
          启动代理
        </button>
        <button v-else class="action-btn danger" type="button" :disabled="isBusy" @click="stop">
          <Square :size="14" />
          停止
        </button>
      </div>
    </div>

    <div class="tunnel-layout">
      <section class="tunnel-panel main-panel">
        <div class="panel-title">
          <Terminal :size="16" />
          <span>SSH 登录</span>
        </div>

        <label class="form-field">
          <span>SSH 指令</span>
          <input
            v-model="sshCommand"
            class="text-input"
            type="text"
            spellcheck="false"
            placeholder="ssh -p 45119 root@host"
            :disabled="isActive"
          />
        </label>

        <label class="form-field">
          <span>密码</span>
          <input
            v-model="sshPassword"
            class="text-input"
            type="password"
            spellcheck="false"
            placeholder="本次会话使用，不保存"
            :disabled="isActive"
          />
        </label>

        <label class="form-field">
          <span>粘贴配置</span>
          <textarea
            v-model="configText"
            class="config-input"
            spellcheck="false"
            placeholder='cmd = "ssh -p 45119 root@host"&#10;password = "..."&#10;ports = ["28000", "6006"]'
            :disabled="isActive"
          ></textarea>
        </label>

        <button
          class="secondary-btn"
          type="button"
          :disabled="isActive || !configText.trim()"
          @click="importConfig"
        >
          从文本填入
        </button>
      </section>

      <section class="tunnel-panel mapping-panel">
        <div class="panel-head">
          <div class="panel-title">
            <Cable :size="16" />
            <span>端口映射</span>
          </div>
          <button
            class="icon-btn"
            type="button"
            title="新增端口"
            :disabled="isActive"
            @click="addMapping"
          >
            <Plus :size="15" />
          </button>
        </div>

        <div class="mapping-table">
          <div class="mapping-head">
            <span>启用</span>
            <span>云端端口</span>
            <span>本地端口</span>
            <span></span>
          </div>
          <div v-for="row in mappings" :key="row.id" class="mapping-row">
            <label class="mini-check">
              <input v-model="row.enabled" type="checkbox" :disabled="isActive" />
            </label>
            <input
              v-model.trim="row.remotePort"
              class="port-input"
              type="text"
              inputmode="numeric"
              :disabled="isActive || row.enabled === false"
              placeholder="6006"
            />
            <input
              v-model.trim="row.localPort"
              class="port-input"
              type="text"
              inputmode="numeric"
              :disabled="isActive || row.enabled === false"
              placeholder="6006"
            />
            <button
              class="icon-btn danger-text"
              type="button"
              title="删除"
              :disabled="isActive"
              @click="removeMapping(row.id)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <button
          class="secondary-btn compact"
          type="button"
          :disabled="isActive"
          @click="resetMappings"
        >
          重置端口
        </button>
      </section>

      <aside class="tunnel-panel status-panel">
        <div class="status-line">
          <span :class="['status-dot', stateClass]"></span>
          <span>{{ stateLabel }}</span>
        </div>

        <div v-if="visibleError" class="error-strip">
          {{ visibleError }}
        </div>

        <div class="mapped-list">
          <div class="mapped-title">本地访问</div>
          <div v-for="row in visibleMappings" :key="row.id || row.localPort" class="mapped-row">
            <span class="mapped-port">127.0.0.1:{{ row.localPort }}</span>
            <span class="mapped-arrow">→</span>
            <span class="mapped-remote">云端 {{ row.remotePort }}</span>
            <button
              class="icon-btn"
              type="button"
              title="复制本地地址"
              @click="copyLocalUrl(row.localPort)"
            >
              <Clipboard :size="14" />
            </button>
          </div>
          <div v-if="copiedPort" class="copy-hint">已复制 127.0.0.1:{{ copiedPort }}</div>
        </div>

        <div class="command-box">
          <div class="command-title">执行命令</div>
          <code>{{ tunnelStatus.command || '未启动' }}</code>
        </div>
      </aside>

      <section class="tunnel-panel log-panel">
        <div class="panel-title">
          <Terminal :size="16" />
          <span>日志</span>
        </div>
        <div class="log-list">
          <div v-for="entry in logs" :key="entry.id" :class="['log-row', entry.level]">
            <span class="log-time">{{ new Date(entry.time).toLocaleTimeString() }}</span>
            <span class="log-message">{{ entry.message }}</span>
          </div>
          <div v-if="logs.length === 0" class="empty-log">暂无日志</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tunnel-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
  min-width: 0;
}

.tunnel-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 8px;
  flex-shrink: 0;
}

.tunnel-toolbar::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--pjsk-page-divider-size);
  background: var(--pjsk-divider-gradient-x);
}

.tunnel-heading {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 22px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
}

.toolbar-actions,
.panel-title,
.panel-head,
.status-line,
.mapped-row {
  display: flex;
  align-items: center;
}

.panel-title {
  gap: 7px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
}

.toolbar-actions {
  gap: 8px;
}

.tunnel-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(360px, 0.8fr) 360px;
  grid-template-rows: auto minmax(180px, 1fr);
  gap: 12px;
  padding-top: 10px;
}

.tunnel-panel {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  padding: 12px;
}

.main-panel,
.mapping-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.status-panel {
  grid-row: span 2;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-panel {
  grid-column: span 2;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-head {
  justify-content: space-between;
  gap: 8px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.text-input,
.config-input,
.port-input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}

.text-input,
.port-input {
  height: 34px;
  padding: 0 9px;
}

.config-input {
  min-height: 92px;
  resize: vertical;
  padding: 9px 10px;
  line-height: 1.5;
}

.text-input:focus,
.config-input:focus,
.port-input:focus {
  border-color: var(--color-text);
}

.text-input:disabled,
.config-input:disabled,
.port-input:disabled {
  opacity: 0.62;
}

.action-btn,
.secondary-btn,
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  font-family: inherit;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}

.action-btn {
  gap: 6px;
  height: var(--ui-action-button-height);
  min-width: 92px;
  padding: 0 12px;
  font-size: 13px;
}

.action-btn.primary {
  border-color: var(--color-active-bg);
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

.action-btn.danger {
  border-color: var(--color-error-border);
  background: var(--color-error-light);
  color: var(--color-error);
}

.secondary-btn {
  align-self: flex-start;
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
}

.secondary-btn.compact {
  margin-top: auto;
}

.icon-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--color-text-muted);
}

.action-btn:hover:not(:disabled),
.secondary-btn:hover:not(:disabled),
.icon-btn:hover:not(:disabled) {
  border-color: var(--color-border-hover);
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.action-btn:disabled,
.secondary-btn:disabled,
.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.danger-text:hover:not(:disabled) {
  color: var(--color-error);
  background: var(--color-error-light);
}

.mapping-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mapping-head,
.mapping-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) minmax(0, 1fr) 34px;
  gap: 8px;
  align-items: center;
}

.mapping-head {
  color: var(--color-text-muted);
  font-size: 11px;
}

.mini-check {
  display: flex;
  justify-content: center;
}

.mini-check input {
  width: 15px;
  height: 15px;
  accent-color: var(--color-active-bg);
}

.status-line {
  gap: 8px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-muted);
}

.status-dot.state-running {
  background: var(--color-success);
}

.status-dot.state-starting,
.status-dot.state-stopping {
  background: var(--color-warning);
}

.status-dot.state-error {
  background: var(--color-error);
}

.error-strip {
  padding: 8px 10px;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius-sm);
  background: var(--color-error-light);
  color: var(--color-error);
  font-size: 12px;
  line-height: 1.5;
}

.mapped-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mapped-title,
.command-title {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.mapped-row {
  gap: 8px;
  min-height: 30px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.mapped-port {
  color: var(--color-text);
  font-family: Consolas, 'Courier New', monospace;
}

.mapped-arrow {
  color: var(--color-text-muted);
}

.mapped-remote {
  flex: 1;
  min-width: 0;
}

.copy-hint {
  color: var(--color-success);
  font-size: 12px;
}

.command-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.command-box code {
  display: block;
  max-height: 120px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-list {
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
}

.log-row {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border-light);
  color: var(--color-text-secondary);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.45;
}

.log-row:last-child {
  border-bottom: none;
}

.log-row.error,
.log-row.stderr {
  color: var(--color-error);
}

.log-row.success {
  color: var(--color-success);
}

.log-time {
  color: var(--color-text-muted);
}

.log-message {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.empty-log {
  padding: 18px;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
}

[data-theme='dark'] .tunnel-panel {
  background: rgba(39, 39, 42, 0.72);
  border-color: rgba(63, 63, 70, 0.8);
}

@media (max-width: 1180px) {
  .tunnel-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(180px, 1fr);
  }

  .status-panel,
  .log-panel {
    grid-row: auto;
    grid-column: auto;
  }
}
</style>
