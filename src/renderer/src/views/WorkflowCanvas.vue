<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { MarkerType, VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import {
  Copy,
  FolderOpen,
  Maximize2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2
} from 'lucide-vue-next'
import WorkflowNode from '../components/WorkflowNode.vue'
import { readStoredJson } from '../composables/useLocalStorage'
import { NODE_DEFS, nodeCategories, normalizeNodeParams } from '../services/workflowCatalog'
import { createWorkflowExecutor, basenameText } from '../services/workflowExecutor'

defineOptions({ name: 'WorkflowCanvas' })

const STORAGE_KEY = 'img-editor-workflow-templates-v1'
const OUTPUT_ROOT_KEY = 'img-editor-workflow-output-root'
const nodeTypes = { workflow: WorkflowNode }
const { fitView, getViewport, screenToFlowCoordinate, setViewport, toObject } = useVueFlow({
  id: 'workflow-canvas'
})

const nodes = ref([])
const edges = ref([])
const templates = ref([])
const activeTemplateId = ref('')
const templateNameDraft = ref('')
const outputRoot = ref(localStorage.getItem(OUTPUT_ROOT_KEY) || '')
const contextMenu = ref({ visible: false, x: 0, y: 0, position: { x: 80, y: 80 } })
const runLog = ref([])
const runRoot = ref('')
const runError = ref('')
const running = ref(false)
const abortRequested = ref(false)
const currentNodeId = ref('')
let removeProgressListener = null
const { runNode, assertSuccess } = createWorkflowExecutor({
  isAborted: () => abortRequested.value,
  onNodeProgress: (patch) => patchNode(currentNodeId.value, patch),
  addLog
})

const runStateText = computed(() => {
  if (running.value)
    return currentNodeId.value ? `运行中：${nodeLabel(currentNodeId.value)}` : '运行中'
  if (runError.value) return runError.value
  if (runRoot.value) return '运行完成'
  return '等待运行'
})

onMounted(() => {
  loadTemplates()
  window.addEventListener('click', closeContextMenu)
  removeProgressListener = window.api.onTaskProgress(handleTaskProgress)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeContextMenu)
  if (removeProgressListener) removeProgressListener()
})

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createBlankTemplate(name = '未命名工作流') {
  return {
    id: createId('tpl'),
    version: 1,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

function loadTemplates() {
  const parsed = readStoredJson(STORAGE_KEY, [])
  templates.value =
    Array.isArray(parsed) && parsed.length ? parsed : [createBlankTemplate('默认工作流')]
  activeTemplateId.value = templates.value[0].id
  loadActiveTemplate()
}

function persistTemplates() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.value))
  localStorage.setItem(OUTPUT_ROOT_KEY, outputRoot.value || '')
}

function toggleNodeCollapsed(id) {
  nodes.value = nodes.value.map((node) =>
    node.id === id ? { ...node, data: { ...node.data, collapsed: !node.data.collapsed } } : node
  )
}

function hydrateNode(node) {
  const kind = NODE_DEFS[node.data?.kind] ? node.data.kind : 'source-folder'
  const def = NODE_DEFS[kind]
  return {
    ...node,
    type: 'workflow',
    data: {
      kind,
      label: def.label,
      category: def.category,
      inputs: clone(def.inputs),
      outputs: clone(def.outputs),
      fields: clone(def.fields),
      params: normalizeNodeParams(kind, node.data?.params),
      collapsed: node.data?.collapsed === true,
      status: 'idle',
      message: '',
      metrics: {},
      onToggleCollapsed: toggleNodeCollapsed,
      onDelete: deleteNode
    }
  }
}

function serializeNodes() {
  return nodes.value.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: node.position,
    data: {
      kind: node.data.kind,
      params: clone(node.data.params || {}),
      collapsed: node.data.collapsed === true
    }
  }))
}

function serializeEdges() {
  return edges.value.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: edge.type || 'smoothstep',
    markerEnd: edge.markerEnd,
    data: edge.data || {}
  }))
}

async function loadActiveTemplate() {
  const tpl =
    templates.value.find((item) => item.id === activeTemplateId.value) || templates.value[0]
  if (!tpl) return
  activeTemplateId.value = tpl.id
  templateNameDraft.value = tpl.name
  nodes.value = (tpl.nodes || []).map(hydrateNode)
  edges.value = (tpl.edges || []).map((edge) => ({
    ...edge,
    type: edge.type || 'smoothstep',
    markerEnd: edge.markerEnd || { type: MarkerType.ArrowClosed }
  }))
  await nextTick()
  if (tpl.viewport) {
    try {
      setViewport(tpl.viewport)
    } catch {
      /* ignore */
    }
  }
}

function saveTemplate(showLog = true) {
  const tpl = templates.value.find((item) => item.id === activeTemplateId.value)
  if (!tpl) return
  const graph = toObject()
  tpl.version = 1
  tpl.name = templateNameDraft.value.trim() || '未命名工作流'
  tpl.nodes = serializeNodes()
  tpl.edges = serializeEdges()
  tpl.viewport = graph?.viewport || getViewport()
  persistTemplates()
  if (showLog) addLog(`已保存模板：${tpl.name}`)
}

function newTemplate() {
  saveTemplate(false)
  const tpl = createBlankTemplate(`工作流 ${templates.value.length + 1}`)
  templates.value.push(tpl)
  activeTemplateId.value = tpl.id
  persistTemplates()
  loadActiveTemplate()
}

function renameTemplate() {
  saveTemplate(true)
}

function duplicateTemplate() {
  saveTemplate(false)
  const src = templates.value.find((item) => item.id === activeTemplateId.value)
  if (!src) return
  const copyTpl = clone(src)
  copyTpl.id = createId('tpl')
  copyTpl.name = `${src.name} 副本`
  templates.value.push(copyTpl)
  activeTemplateId.value = copyTpl.id
  persistTemplates()
  loadActiveTemplate()
}

function deleteTemplate() {
  if (templates.value.length <= 1) {
    const tpl = createBlankTemplate('默认工作流')
    templates.value = [tpl]
    activeTemplateId.value = tpl.id
  } else {
    templates.value = templates.value.filter((item) => item.id !== activeTemplateId.value)
    activeTemplateId.value = templates.value[0].id
  }
  persistTemplates()
  loadActiveTemplate()
}

function onPaneContextMenu(event) {
  event.preventDefault()
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, position }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

function addNode(kind) {
  const def = NODE_DEFS[kind]
  if (!def) return
  const id = createId('node')
  nodes.value = [
    ...nodes.value,
    {
      id,
      type: 'workflow',
      position: contextMenu.value.position,
      data: {
        kind,
        label: def.label,
        category: def.category,
        inputs: clone(def.inputs),
        outputs: clone(def.outputs),
        fields: clone(def.fields),
        params: clone(def.params),
        collapsed: false,
        status: 'idle',
        message: '',
        metrics: {},
        onToggleCollapsed: toggleNodeCollapsed,
        onDelete: deleteNode
      }
    }
  ]
  closeContextMenu()
}

function findNode(id) {
  return nodes.value.find((node) => node.id === id)
}

function deleteNode(id) {
  if (running.value) {
    runError.value = '运行中不能删除节点'
    return
  }
  nodes.value = nodes.value.filter((node) => node.id !== id)
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id)
  if (currentNodeId.value === id) currentNodeId.value = ''
}

function nodeLabel(id) {
  const node = findNode(id)
  return node?.data?.label || id
}

function getPort(nodeId, handleId, direction) {
  const node = findNode(nodeId)
  const ports = direction === 'source' ? node?.data?.outputs : node?.data?.inputs
  return (ports || []).find((port) => port.id === handleId)
}

function hasPath(fromId, toId, edgeList = edges.value) {
  const queue = [fromId]
  const seen = new Set()
  while (queue.length) {
    const id = queue.shift()
    if (id === toId) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of edgeList) {
      if (edge.source === id) queue.push(edge.target)
    }
  }
  return false
}

function isValidConnection(connection) {
  if (
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  )
    return false
  if (connection.source === connection.target) return false
  const sourcePort = getPort(connection.source, connection.sourceHandle, 'source')
  const targetPort = getPort(connection.target, connection.targetHandle, 'target')
  if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) return false
  return !hasPath(connection.target, connection.source)
}

function onConnect(connection) {
  if (!isValidConnection(connection)) {
    runError.value = '连线失败：端口类型不匹配或会形成环'
    return
  }
  const sourcePort = getPort(connection.source, connection.sourceHandle, 'source')
  edges.value = [
    ...edges.value,
    {
      ...connection,
      id: createId('edge'),
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { valueType: sourcePort.type }
    }
  ]
  runError.value = ''
}

function clearNodeStatus() {
  for (const node of nodes.value) {
    node.data.status = 'idle'
    node.data.message = ''
    node.data.metrics = {}
    node.data.progress = null
  }
  runError.value = ''
  currentNodeId.value = ''
}

function patchNode(id, patch) {
  const node = findNode(id)
  if (!node) return
  Object.assign(node.data, patch)
}

function addLog(message) {
  const time = new Date().toLocaleTimeString()
  runLog.value.unshift({ id: createId('log'), time, message })
  runLog.value = runLog.value.slice(0, 80)
}

function stageText(stage, scope) {
  const key = String(stage || scope || '').toLowerCase()
  const labels = {
    collect: '收集',
    download: '下载',
    extract: '提取特征',
    match: '匹配',
    scan: '扫描',
    'grab-scan': '扫描',
    'grab-download': '下载',
    'grab-site': '抓取'
  }
  return labels[key] || stage || scope || '执行中'
}

function handleTaskProgress(payload = {}) {
  if (!running.value || !currentNodeId.value) return
  const done = Number(payload.done ?? 0)
  const total = Number(payload.total ?? 0)
  const percent = total > 0 ? Math.round(Math.max(0, Math.min(1, done / total)) * 100) : null
  const progress = {
    done,
    total,
    percent,
    stage: payload.stage || payload.scope || '',
    stageText: stageText(payload.stage, payload.scope),
    current: basenameText(payload.current || payload.file || ''),
    saved: payload.saved,
    failed: payload.failed
  }
  const message = total > 0 ? `${progress.stageText} ${done}/${total}` : progress.stageText
  patchNode(currentNodeId.value, { progress, message })
}

function validateWorkflow() {
  for (const edge of edges.value) {
    const sourcePort = getPort(edge.source, edge.sourceHandle, 'source')
    const targetPort = getPort(edge.target, edge.targetHandle, 'target')
    if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) {
      throw new Error(`连线类型错误：${nodeLabel(edge.source)} -> ${nodeLabel(edge.target)}`)
    }
  }

  const outputNodes = nodes.value.filter((node) => node.data.category === '输出节点')
  if (!outputNodes.length) throw new Error('需要至少添加一个输出节点')

  const reverse = new Map()
  for (const edge of edges.value) {
    if (!reverse.has(edge.target)) reverse.set(edge.target, [])
    reverse.get(edge.target).push(edge.source)
  }

  const involved = new Set()
  const queue = outputNodes.map((node) => node.id)
  while (queue.length) {
    const id = queue.shift()
    if (involved.has(id)) continue
    involved.add(id)
    for (const prev of reverse.get(id) || []) queue.push(prev)
  }

  for (const node of nodes.value) {
    if (!involved.has(node.id)) continue
    const def = NODE_DEFS[node.data.kind]
    for (const key of def.required || []) {
      const value = node.data.params?.[key]
      if (value === null || value === undefined || String(value).trim() === '') {
        throw new Error(`${node.data.label} 缺少必填参数：${key}`)
      }
    }
    for (const input of node.data.inputs || []) {
      const hasIncoming = edges.value.some(
        (edge) => edge.target === node.id && edge.targetHandle === input.id
      )
      if (!input.optional && !hasIncoming) {
        throw new Error(`${node.data.label} 缺少输入：${input.label}`)
      }
    }
  }

  const subEdges = edges.value.filter(
    (edge) => involved.has(edge.source) && involved.has(edge.target)
  )
  const indegree = new Map([...involved].map((id) => [id, 0]))
  for (const edge of subEdges) indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)
  const order = []
  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const edge of subEdges.filter((item) => item.source === id)) {
      indegree.set(edge.target, indegree.get(edge.target) - 1)
      if (indegree.get(edge.target) === 0) ready.push(edge.target)
    }
  }
  if (order.length !== involved.size) throw new Error('工作流存在环路')

  return { order, involved }
}

function getNodeInputs(nodeId, values) {
  const inputMap = new Map()
  for (const edge of edges.value.filter((item) => item.target === nodeId)) {
    const value = values.get(`${edge.source}:${edge.sourceHandle}`)
    if (!value) continue
    const list = inputMap.get(edge.targetHandle) || []
    list.push(value)
    inputMap.set(edge.targetHandle, list)
  }
  return inputMap
}

async function chooseOutputRoot() {
  const folder = await window.api.selectFolder()
  if (folder) {
    outputRoot.value = folder
    persistTemplates()
  }
}

async function runWorkflow() {
  if (running.value) return
  saveTemplate(false)
  clearNodeStatus()
  runLog.value = []
  runRoot.value = ''
  abortRequested.value = false

  let plan
  try {
    plan = validateWorkflow()
  } catch (err) {
    runError.value = err.message
    addLog(err.message)
    return
  }

  running.value = true
  const values = new Map()
  try {
    for (const nodeId of plan.order)
      patchNode(nodeId, { status: 'queued', message: '', metrics: {} })
    const rootResult = await window.api.createWorkflowRunDir(
      outputRoot.value,
      templateNameDraft.value || 'workflow'
    )
    if (typeof rootResult !== 'string') assertSuccess(rootResult, '创建运行目录失败')
    const root = rootResult
    runRoot.value = root
    addLog(`运行目录：${root}`)

    for (const nodeId of plan.order) {
      if (abortRequested.value) throw new Error('任务已停止')
      const node = findNode(nodeId)
      currentNodeId.value = nodeId
      patchNode(nodeId, {
        status: 'running',
        message: '执行中...',
        progress: { done: 0, total: 0, percent: null, stageText: '执行中', current: '' }
      })
      addLog(`开始：${node.data.label}`)
      const result = await runNode(node, getNodeInputs(nodeId, values), root)
      for (const output of node.data.outputs || []) {
        const value = result[output.id]
        if (value) values.set(`${node.id}:${output.id}`, value)
      }
      const count = result.files?.files?.length
      const resultMessage = result.message || (count != null ? `输出 ${count} 张` : '完成')
      patchNode(nodeId, {
        status: 'done',
        message: resultMessage,
        metrics: count != null ? { count } : {},
        progress: {
          done: count || 1,
          total: count || 1,
          percent: 100,
          stageText: '完成',
          current: ''
        }
      })
      addLog(`完成：${node.data.label} - ${resultMessage}`)
    }
    currentNodeId.value = ''
    addLog('工作流执行完成')
  } catch (err) {
    if (currentNodeId.value)
      patchNode(currentNodeId.value, { status: 'error', message: err.message || '执行失败' })
    runError.value = err.message || '执行失败'
    addLog(runError.value)
  } finally {
    running.value = false
    currentNodeId.value = ''
  }
}

async function stopRun() {
  if (!running.value) return
  abortRequested.value = true
  addLog('停止请求已发送')
  try {
    await window.api.abortTask()
  } catch {
    /* ignore */
  }
}

function resetStatus() {
  clearNodeStatus()
  runLog.value = []
  runRoot.value = ''
}
</script>

<template>
  <div class="workflow-page">
    <header class="workflow-toolbar" @click.stop>
      <div class="template-tools">
        <select
          v-model="activeTemplateId"
          class="tool-select"
          :disabled="running"
          @change="loadActiveTemplate"
        >
          <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
        </select>
        <input
          v-model="templateNameDraft"
          class="tool-input name-input"
          type="text"
          spellcheck="false"
          :disabled="running"
        />
        <button
          class="icon-tool"
          type="button"
          title="保存模板"
          :disabled="running"
          @click="saveTemplate(true)"
        >
          <Save :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="重命名"
          :disabled="running"
          @click="renameTemplate"
        >
          <Pencil :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="新建模板"
          :disabled="running"
          @click="newTemplate"
        >
          <Plus :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="复制模板"
          :disabled="running"
          @click="duplicateTemplate"
        >
          <Copy :size="15" />
        </button>
        <button
          class="icon-tool danger"
          type="button"
          title="删除模板"
          :disabled="running"
          @click="deleteTemplate"
        >
          <Trash2 :size="15" />
        </button>
      </div>

      <div class="run-tools">
        <button class="primary-tool" type="button" :disabled="running" @click="runWorkflow">
          <Play :size="15" />
          运行
        </button>
        <button class="icon-tool" type="button" title="停止" :disabled="!running" @click="stopRun">
          <Square :size="15" />
        </button>
        <button class="icon-tool" type="button" title="适配画布" @click="fitView({ padding: 0.2 })">
          <Maximize2 :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="清除状态"
          :disabled="running"
          @click="resetStatus"
        >
          <RotateCcw :size="15" />
        </button>
      </div>

      <div class="output-tools">
        <span class="output-label">输出根目录</span>
        <input
          v-model="outputRoot"
          class="tool-input output-input"
          type="text"
          placeholder="留空自动使用应用数据目录 workflow_runs"
          spellcheck="false"
          @change="persistTemplates"
        />
        <button
          class="icon-tool"
          type="button"
          title="选择输出根目录"
          :disabled="running"
          @click="chooseOutputRoot"
        >
          <FolderOpen :size="15" />
        </button>
      </div>
    </header>

    <section class="workflow-body">
      <VueFlow
        id="workflow-canvas"
        v-model:nodes="nodes"
        v-model:edges="edges"
        class="flow-canvas"
        :node-types="nodeTypes"
        :is-valid-connection="isValidConnection"
        :min-zoom="0.18"
        :max-zoom="1.6"
        :default-viewport="{ x: 0, y: 0, zoom: 0.9 }"
        fit-view-on-init
        @connect="onConnect"
        @pane-context-menu="onPaneContextMenu"
      >
        <Background :gap="24" :size="1.2" />
        <Controls />
      </VueFlow>

      <aside class="run-panel">
        <div class="panel-title">运行状态</div>
        <div :class="['state-card', { error: runError, running }]">
          <span>{{ runStateText }}</span>
          <small v-if="runRoot">{{ runRoot }}</small>
        </div>
        <div class="panel-title">日志</div>
        <div class="log-list">
          <div v-if="!runLog.length" class="empty-log">暂无日志</div>
          <div v-for="item in runLog" :key="item.id" class="log-row">
            <span>{{ item.time }}</span>
            <p>{{ item.message }}</p>
          </div>
        </div>
      </aside>

      <div
        v-if="contextMenu.visible"
        class="node-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
      >
        <div v-for="group in nodeCategories" :key="group.label" class="menu-group">
          <div class="menu-group-title">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.kind"
            type="button"
            class="menu-item"
            @click="addNode(item.kind)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workflow-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  overflow: hidden;
  padding: 0;
}

.workflow-toolbar {
  position: relative;
  display: grid;
  grid-template-columns: minmax(360px, auto) auto minmax(300px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 0 0 9px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  box-shadow: none;
}

.template-tools,
.run-tools,
.output-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.run-tools {
  justify-content: center;
}

.output-tools {
  justify-content: flex-end;
}

.tool-select,
.tool-input {
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  padding: 0 9px;
  font-size: 12px;
  outline: none;
}

.tool-select {
  width: 150px;
}

.name-input {
  width: 150px;
}

.output-input {
  flex: 1;
  min-width: 160px;
}

.output-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.icon-tool,
.primary-tool {
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.icon-tool {
  width: 30px;
  padding: 0;
}

.primary-tool {
  padding: 0 14px;
  background: var(--color-active-bg);
  color: var(--color-active-text);
  border-color: var(--color-active-bg);
}

.icon-tool:hover:not(:disabled),
.primary-tool:hover:not(:disabled) {
  border-color: var(--color-info);
  color: var(--color-text);
}

.primary-tool:hover:not(:disabled) {
  color: var(--color-active-text);
}

.icon-tool.danger:hover:not(:disabled) {
  border-color: var(--color-error);
  color: var(--color-error);
}

.icon-tool:disabled,
.primary-tool:disabled,
.tool-select:disabled,
.tool-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.workflow-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  gap: 9px;
}

.flow-canvas {
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-background);
  overflow: hidden;
}

:deep(.vue-flow__edge-path) {
  stroke: var(--color-info);
  stroke-width: 2;
}

:deep(.vue-flow__connection-path) {
  stroke: var(--color-info);
  stroke-width: 2;
}

:deep(.vue-flow__controls) {
  box-shadow: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.run-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}

.panel-title {
  padding: 9px 10px 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.state-card {
  margin: 0 10px 8px;
  padding: 9px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  min-height: 58px;
}

.state-card small {
  color: var(--color-text-muted);
  word-break: break-all;
  line-height: 1.35;
}

.state-card.running {
  background: var(--color-info-light);
  color: var(--color-info);
}

.state-card.error {
  background: var(--color-error-light);
  color: var(--color-error);
}

.log-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
}

.empty-log {
  padding: 16px 0;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
}

.log-row {
  border-bottom: 1px solid var(--color-surface-hover);
  padding: 8px 0;
}

.log-row span {
  display: block;
  font-size: 10px;
  color: var(--color-text-muted);
  margin-bottom: 2px;
}

.log-row p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}

.node-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  width: 240px;
  max-height: min(620px, calc(100vh - 60px));
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

.menu-group + .menu-group {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.menu-group-title {
  padding: 4px 6px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.menu-item {
  width: 100%;
  min-height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
}

.menu-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

@media (max-width: 1100px) {
  .workflow-toolbar {
    grid-template-columns: 1fr;
  }

  .run-tools,
  .output-tools {
    justify-content: flex-start;
  }

  .workflow-body {
    grid-template-columns: 1fr;
  }

  .run-panel {
    max-height: 220px;
  }
}

.primary-tool {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-button);
}

.primary-tool:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}
</style>
