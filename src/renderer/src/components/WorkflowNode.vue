<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { Trash2 } from 'lucide-vue-next'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false }
})

const statusText = {
  idle: '等待',
  queued: '排队',
  running: '运行中',
  done: '完成',
  error: '失败',
  skipped: '跳过'
}

const typeText = {
  'file-list': '文件列表',
  'candidate-list': '候选列表',
  metadata: '元数据'
}

const nodeStatus = computed(() => props.data.status || 'idle')
const fields = computed(() => props.data.fields || [])
const params = computed(() => props.data.params || {})
const progress = computed(() => props.data.progress || null)
const progressPercent = computed(() => {
  if (nodeStatus.value === 'done') return 100
  if (!progress.value || progress.value.percent == null) return 0
  return Math.max(0, Math.min(100, progress.value.percent))
})
const hasProgress = computed(
  () => nodeStatus.value === 'running' || progress.value?.percent != null
)

function toggleCollapsed() {
  props.data.onToggleCollapsed?.(props.id)
}

function deleteNode() {
  props.data.onDelete?.(props.id)
}

function handleTop(index, total) {
  return `${((index + 1) * 100) / (total + 1)}%`
}

async function chooseFolder(field) {
  const folder = await window.api.selectFolder()
  if (folder) params.value[field.key] = folder
}
</script>

<template>
  <div :class="['workflow-node', `status-${nodeStatus}`, { selected }]">
    <Handle
      v-for="(port, index) in data.inputs || []"
      :id="port.id"
      :key="`in-${port.id}`"
      type="target"
      :position="Position.Left"
      :style="{ top: handleTop(index, (data.inputs || []).length) }"
      class="workflow-handle input-handle"
    />

    <div class="node-head">
      <div class="node-title-block">
        <span class="node-category">{{ data.category }}</span>
        <strong class="node-title">{{ data.label }}</strong>
      </div>
      <div class="node-head-actions">
        <button
          class="node-icon-btn"
          type="button"
          :title="data.collapsed ? '展开参数' : '折叠参数'"
          @click.stop="toggleCollapsed"
        >
          {{ data.collapsed ? '+' : '-' }}
        </button>
        <button
          class="node-icon-btn danger"
          type="button"
          title="删除节点"
          @click.stop="deleteNode"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </div>

    <div v-if="(data.inputs || []).length" class="port-list input-list">
      <span v-for="port in data.inputs" :key="port.id" class="port-chip">
        {{ port.label }} · {{ typeText[port.type] || port.type }}
      </span>
    </div>

    <div
      v-if="!data.collapsed"
      class="node-body nodrag nopan"
      @pointerdown.stop
      @mousedown.stop
      @touchstart.stop
      @dblclick.stop
    >
      <label
        v-for="field in fields"
        :key="field.key"
        :class="['param-field', `field-${field.type}`]"
      >
        <span class="field-label">{{ field.label }}</span>

        <template v-if="field.type === 'select'">
          <select v-model="params[field.key]" class="node-input">
            <option v-for="option in field.options || []" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </template>

        <template v-else-if="field.type === 'textarea'">
          <textarea
            v-model="params[field.key]"
            class="node-input node-textarea"
            :rows="field.rows || 3"
            :placeholder="field.placeholder"
            spellcheck="false"
          ></textarea>
        </template>

        <template v-else-if="field.type === 'checkbox'">
          <span class="node-check">
            <input v-model="params[field.key]" type="checkbox" />
            <span>{{ field.hint || '启用' }}</span>
          </span>
        </template>

        <template v-else-if="field.type === 'folder'">
          <span class="folder-input">
            <input
              v-model="params[field.key]"
              class="node-input"
              type="text"
              :placeholder="field.placeholder"
              spellcheck="false"
            />
            <button type="button" class="tiny-btn" @click.stop="chooseFolder(field)">选择</button>
          </span>
        </template>

        <template v-else-if="field.type === 'color'">
          <input v-model="params[field.key]" class="node-input color-input" type="color" />
        </template>

        <template v-else-if="field.type === 'number'">
          <input
            v-model.number="params[field.key]"
            class="node-input"
            type="number"
            :min="field.min"
            :max="field.max"
            :step="field.step || 1"
            :placeholder="field.placeholder"
          />
        </template>

        <template v-else>
          <input
            v-model="params[field.key]"
            class="node-input"
            type="text"
            :placeholder="field.placeholder"
            spellcheck="false"
          />
        </template>
      </label>
    </div>

    <div v-if="data.message" class="node-message">{{ data.message }}</div>

    <div v-if="hasProgress" class="node-progress">
      <div class="progress-track">
        <div
          :class="[
            'progress-fill',
            { indeterminate: nodeStatus === 'running' && progress?.percent == null }
          ]"
          :style="{
            width:
              progress?.percent == null && nodeStatus === 'running' ? '38%' : `${progressPercent}%`
          }"
        ></div>
      </div>
      <div class="progress-meta">
        <span>{{ progress?.stageText || statusText[nodeStatus] || nodeStatus }}</span>
        <span v-if="progress?.total">{{ progress.done || 0 }} / {{ progress.total }}</span>
        <span v-else-if="nodeStatus === 'done'">100%</span>
      </div>
      <div v-if="progress?.current" class="progress-current">{{ progress.current }}</div>
    </div>

    <div class="node-foot">
      <span :class="['status-pill', `pill-${nodeStatus}`]">{{
        statusText[nodeStatus] || nodeStatus
      }}</span>
      <span v-if="data.metrics?.count != null" class="metric-text"
        >{{ data.metrics.count }} 张</span
      >
    </div>

    <div v-if="(data.outputs || []).length" class="port-list output-list">
      <span v-for="port in data.outputs" :key="port.id" class="port-chip output">
        {{ port.label }} · {{ typeText[port.type] || port.type }}
      </span>
    </div>

    <Handle
      v-for="(port, index) in data.outputs || []"
      :id="port.id"
      :key="`out-${port.id}`"
      type="source"
      :position="Position.Right"
      :style="{ top: handleTop(index, (data.outputs || []).length) }"
      class="workflow-handle output-handle"
    />
  </div>
</template>

<style scoped>
.workflow-node {
  width: 282px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  color: var(--color-text);
  overflow: visible;
}

.workflow-node.selected {
  border-color: var(--color-info);
  box-shadow:
    0 0 0 2px var(--color-info-light),
    0 12px 28px rgba(15, 23, 42, 0.12);
}

.node-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.node-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.node-category {
  font-size: 10px;
  color: var(--color-text-muted);
}

.node-title {
  font-size: 13px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.node-icon-btn {
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.node-icon-btn:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.node-icon-btn.danger:hover {
  color: var(--color-error);
  border-color: var(--color-error);
  background: var(--color-error-light);
}

.node-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.param-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.node-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  padding: 0 8px;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}

.node-textarea {
  height: auto;
  min-height: 58px;
  padding: 7px 8px;
  resize: vertical;
}

.node-input:focus {
  border-color: var(--color-info);
}

.node-check,
.folder-input {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.folder-input .node-input {
  flex: 1;
}

.tiny-btn {
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.tiny-btn:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.color-input {
  padding: 2px;
}

.port-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 12px 0;
}

.output-list {
  padding: 0 12px 10px;
  justify-content: flex-end;
}

.port-chip {
  max-width: 100%;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.port-chip.output {
  color: var(--color-info);
  background: var(--color-info-light);
}

.node-message {
  margin: 0 12px 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.4;
  word-break: break-word;
}

.node-progress {
  margin: 0 12px 8px;
}

.progress-track {
  position: relative;
  height: 6px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-surface-hover);
}

.progress-fill {
  height: 100%;
  border-radius: var(--radius-sm);
  background: var(--color-info);
  transition: width 0.18s ease;
}

.progress-fill.indeterminate {
  position: absolute;
  left: -38%;
  animation: progress-slide 1.1s ease-in-out infinite;
}

.progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 5px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.progress-current {
  margin-top: 3px;
  font-size: 10px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes progress-slide {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(365%);
  }
}

.node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
  font-size: 11px;
}

.pill-running {
  background: var(--color-info-light);
  color: var(--color-info);
}

.pill-done {
  background: var(--color-tag-has-bg);
  color: var(--color-success);
}

.pill-error {
  background: var(--color-error-light);
  color: var(--color-error);
}

.metric-text {
  font-size: 11px;
  color: var(--color-text-muted);
}

.workflow-handle {
  width: 11px;
  height: 11px;
  border: 2px solid var(--color-surface);
  background: var(--color-info);
}

.input-handle {
  left: -6px;
}

.output-handle {
  right: -6px;
}

[data-theme='dark'] .workflow-node {
  background: rgba(32, 32, 36, 0.96);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.28);
}
</style>
