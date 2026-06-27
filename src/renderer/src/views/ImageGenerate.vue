<script setup>
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FolderOpen, ImagePlus, Loader2, RefreshCw, Sparkles, Trash2, X } from 'lucide-vue-next'
import { API_CONFIGS_UPDATED_EVENT, loadApiConfigs } from '../services/apiConfigs'
import { useLocalStorage } from '../composables/useLocalStorage'

defineOptions({ name: 'ImageGenerate' })

const gptSizeOptions = [
  { value: '1024x1024', label: '1:1' },
  { value: '1536x1024', label: '3:2' },
  { value: '1024x1536', label: '2:3' },
  { value: 'auto', label: 'Auto' }
]

const qualityOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

const outputFormatOptions = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPG' },
  { value: 'webp', label: 'WEBP' }
]

const backgroundOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'opaque', label: 'Opaque' },
  { value: 'transparent', label: 'Clear' }
]

const aspectOptions = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' }
]

const imageSizeOptions = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' }
]

const apiConfigs = ref([])
const generationMode = useLocalStorage('image-generate-mode', 'text')
const selectedApiId = useLocalStorage('image-generate-api', '')
const prompt = useLocalStorage('image-generate-prompt', '')
const outputFolder = useLocalStorage('image-generate-output-folder', '')
const count = useLocalStorage('image-generate-count', 1, { type: 'number' })
const gptSize = useLocalStorage('image-generate-gpt-size', '1024x1024')
const gptQuality = useLocalStorage('image-generate-gpt-quality', 'auto')
const outputFormat = useLocalStorage('image-generate-output-format', 'png')
const background = useLocalStorage('image-generate-background', 'auto')
const aspectRatio = useLocalStorage('image-generate-aspect', '1:1')
const imageSize = useLocalStorage('image-generate-image-size', '1K')

const referenceImages = ref([])
const results = ref([])
const previewItem = ref(null)
const running = ref(false)
const taskError = ref('')
const taskStatus = ref('')
const progressDone = ref(0)
const progressTotal = ref(0)
let removeProgressListener = null

function providerOf(config = {}) {
  config = config || {}
  const value = `${config.model || ''} ${config.name || ''} ${config.endpoint || ''}`.toLowerCase()
  if (/gpt[-_\s]?image|gpt[-_\s]?img|gpt.*\bimg\b/.test(value)) return 'gpt'
  if (/nano[-_\s]?banana|gemini.*image|flash-image|pro-image/.test(value)) return 'nanobanana'
  return ''
}

const supportedConfigs = computed(() =>
  apiConfigs.value.filter((item) => item.enabled !== false && providerOf(item))
)

const selectedConfig = computed(() => {
  if (!supportedConfigs.value.length) return null
  return (
    supportedConfigs.value.find((item) => item.id === selectedApiId.value) ||
    supportedConfigs.value[0]
  )
})

const selectedProvider = computed(() =>
  selectedConfig.value ? providerOf(selectedConfig.value) : ''
)
const activeReferences = computed(() =>
  generationMode.value === 'image' ? referenceImages.value : []
)
const canGenerate = computed(() =>
  Boolean(selectedConfig.value && prompt.value.trim() && !running.value)
)
const countValue = computed(() => Math.max(1, Math.min(Number(count.value) || 1, 4)))

watch(
  supportedConfigs,
  (configs) => {
    if (!configs.length) return
    if (!configs.some((item) => item.id === selectedApiId.value)) {
      selectedApiId.value = configs[0].id
    }
  },
  { immediate: true }
)

async function refreshApiConfigs() {
  apiConfigs.value = await loadApiConfigs()
}

async function chooseOutputFolder() {
  const folder = await window.api.selectFolder()
  if (folder) outputFolder.value = folder
}

function switchMode(mode) {
  generationMode.value = mode
  taskError.value = ''
}

async function addReferenceImages() {
  const files = await window.api.selectImageFiles()
  if (!files?.length) return
  const existing = new Set(referenceImages.value.map((item) => item.path))
  const merged = [...referenceImages.value]
  for (const file of files) {
    if (!existing.has(file.path)) {
      existing.add(file.path)
      merged.push(file)
    }
  }
  referenceImages.value = merged.slice(0, 10)
  generationMode.value = 'image'
}

function removeReferenceImage(path) {
  referenceImages.value = referenceImages.value.filter((item) => item.path !== path)
}

function clearReferences() {
  referenceImages.value = []
}

async function generate() {
  if (!selectedConfig.value) {
    taskError.value = '请先在设置页面添加并启用 GPT Image 或 Nano Banana API 配置'
    return
  }
  if (!prompt.value.trim()) {
    taskError.value = '请输入 Prompt'
    return
  }

  running.value = true
  taskError.value = ''
  taskStatus.value = '生成中...'
  progressDone.value = 0
  progressTotal.value = countValue.value

  try {
    const result = await window.api.generateImage({
      configId: selectedConfig.value.id,
      prompt: prompt.value.trim(),
      outputDir: outputFolder.value,
      count: countValue.value,
      size: gptSize.value,
      quality: gptQuality.value,
      outputFormat: outputFormat.value,
      background: background.value,
      aspectRatio: aspectRatio.value,
      imageSize: imageSize.value,
      referenceImages: activeReferences.value.map((item) => item.path)
    })

    if (result?.success) {
      if (result.output_dir) outputFolder.value = result.output_dir
      results.value = [...(result.results || []), ...results.value]
      taskStatus.value = `已生成 ${result.count || result.results?.length || 0} 张`
      progressDone.value = result.count || result.results?.length || countValue.value
    } else if (result?.aborted) {
      taskStatus.value = '已停止'
    } else {
      taskError.value = result?.error || '生图失败'
      taskStatus.value = ''
      if (result?.results?.length) results.value = [...result.results, ...results.value]
    }
  } catch (err) {
    taskError.value = err.message || '生图失败'
    taskStatus.value = ''
  } finally {
    running.value = false
  }
}

async function abortGeneration() {
  await window.api.abortTask()
  running.value = false
  taskStatus.value = '已停止'
}

function openPreview(item) {
  previewItem.value = item
}

function closePreview() {
  previewItem.value = null
}

function handleProgress(data) {
  if (data?.scope !== 'image-generate') return
  progressDone.value = data.done || 0
  progressTotal.value = data.total || 0
  if (data.current) taskStatus.value = data.current
}

onMounted(async () => {
  removeProgressListener = window.api.onTaskProgress(handleProgress)
  window.addEventListener(API_CONFIGS_UPDATED_EVENT, refreshApiConfigs)
  await refreshApiConfigs()
})

onActivated(() => refreshApiConfigs())

onBeforeUnmount(() => {
  if (removeProgressListener) removeProgressListener()
  window.removeEventListener(API_CONFIGS_UPDATED_EVENT, refreshApiConfigs)
})
</script>

<template>
  <div class="generate-page">
    <section class="generate-toolbar">
      <div class="folder-section output-section">
        <div class="folder-row">
          <span class="folder-label">输出</span>
          <div class="folder-path" @click="chooseOutputFolder">
            <span v-if="outputFolder" class="path-text">{{ outputFolder }}</span>
            <span v-else class="path-placeholder">默认保存目录</span>
          </div>
          <button class="folder-browse-btn" title="选择输出目录" @click="chooseOutputFolder">
            <FolderOpen :size="16" />
          </button>
        </div>
      </div>

      <div class="api-field">
        <label class="field-label">API</label>
        <select
          v-model="selectedApiId"
          class="tool-select"
          :disabled="running || !supportedConfigs.length"
        >
          <option v-if="!supportedConfigs.length" value="">无可用配置</option>
          <option v-for="cfg in supportedConfigs" :key="cfg.id" :value="cfg.id">
            {{ cfg.name }} / {{ cfg.model }}
          </option>
        </select>
      </div>

      <div class="toolbar-actions">
        <button
          class="bar-icon-btn"
          title="刷新 API 配置"
          :disabled="running"
          @click="refreshApiConfigs"
        >
          <RefreshCw :size="16" />
        </button>
        <button
          class="bar-icon-btn"
          title="添加参考图"
          :disabled="running"
          @click="addReferenceImages"
        >
          <ImagePlus :size="16" />
        </button>
        <button v-if="running" class="action-btn danger" @click="abortGeneration">
          <X :size="14" />
          停止
        </button>
        <button v-else class="action-btn primary" :disabled="!canGenerate" @click="generate">
          <Sparkles :size="14" />
          生成
        </button>
      </div>
    </section>

    <section class="generate-workspace">
      <aside class="prompt-panel">
        <div class="mode-tabs">
          <button
            :class="['mode-tab', { active: generationMode === 'text' }]"
            @click="switchMode('text')"
          >
            文生图
          </button>
          <button
            :class="['mode-tab', { active: generationMode === 'image' }]"
            @click="switchMode('image')"
          >
            图生图
          </button>
        </div>

        <label class="prompt-label">Prompt</label>
        <textarea
          v-model="prompt"
          class="prompt-input"
          :disabled="running"
          placeholder="Describe the image you want..."
        ></textarea>

        <div v-if="generationMode === 'image'" class="reference-block">
          <div class="reference-header">
            <span>参考图</span>
            <button
              v-if="referenceImages.length"
              class="mini-btn"
              :disabled="running"
              @click="clearReferences"
            >
              <Trash2 :size="13" />
            </button>
          </div>
          <div v-if="referenceImages.length" class="reference-grid">
            <div v-for="item in referenceImages" :key="item.path" class="reference-item">
              <img :src="item.url" :alt="item.name" />
              <button
                class="reference-remove"
                :disabled="running"
                @click="removeReferenceImage(item.path)"
              >
                <X :size="12" />
              </button>
            </div>
          </div>
          <button class="reference-add" :disabled="running" @click="addReferenceImages">
            <ImagePlus :size="15" />
            添加图片
          </button>
        </div>

        <div class="param-grid">
          <label class="param-field">
            <span>数量</span>
            <input
              v-model.number="count"
              type="number"
              min="1"
              max="4"
              step="1"
              :disabled="running"
            />
          </label>

          <template v-if="selectedProvider === 'gpt'">
            <label class="param-field">
              <span>比例</span>
              <select v-model="gptSize" :disabled="running">
                <option v-for="item in gptSizeOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="param-field">
              <span>质量</span>
              <select v-model="gptQuality" :disabled="running">
                <option v-for="item in qualityOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="param-field">
              <span>格式</span>
              <select v-model="outputFormat" :disabled="running">
                <option v-for="item in outputFormatOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="param-field">
              <span>背景</span>
              <select v-model="background" :disabled="running">
                <option v-for="item in backgroundOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
          </template>

          <template v-else>
            <label class="param-field">
              <span>比例</span>
              <select v-model="aspectRatio" :disabled="running">
                <option v-for="item in aspectOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="param-field">
              <span>尺寸</span>
              <select v-model="imageSize" :disabled="running">
                <option v-for="item in imageSizeOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
          </template>
        </div>
      </aside>

      <main class="result-panel">
        <div v-if="taskError" class="error-bar">
          <span>{{ taskError }}</span>
          <button class="error-bar-close" @click="taskError = ''">×</button>
        </div>

        <div v-if="running || taskStatus" class="status-strip">
          <Loader2 v-if="running" :size="15" class="spin-icon" />
          <span>{{ taskStatus }}</span>
          <div v-if="progressTotal" class="progress-track">
            <span
              class="progress-fill"
              :style="{ width: (progressDone / progressTotal) * 100 + '%' }"
            ></span>
          </div>
          <span v-if="progressTotal" class="progress-count"
            >{{ progressDone }} / {{ progressTotal }}</span
          >
        </div>

        <div v-if="results.length" class="result-grid">
          <button
            v-for="item in results"
            :key="item.path"
            class="result-card"
            @click="openPreview(item)"
          >
            <img :src="item.url" :alt="item.name" />
            <span class="result-meta">
              <span>{{ item.name }}</span>
              <small>{{ item.model }}</small>
            </span>
          </button>
        </div>
        <div v-else class="empty-state">
          <div class="empty-text">暂无生成结果</div>
        </div>
      </main>
    </section>

    <Transition name="preview-fade">
      <div v-if="previewItem" class="preview-overlay" @click="closePreview">
        <img class="preview-img" :src="previewItem.url" :alt="previewItem.name" />
        <div class="preview-filename">{{ previewItem.path }}</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.generate-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.generate-toolbar {
  display: flex;
  align-items: stretch;
  gap: 12px;
  padding: 9px 11px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  flex-shrink: 0;
}

.output-section {
  min-width: 260px;
}

.api-field {
  width: min(360px, 32vw);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.field-label,
.prompt-label,
.param-field span {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  flex-shrink: 0;
}

.tool-select,
.param-field select,
.param-field input {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
}

.tool-select:focus,
.param-field select:focus,
.param-field input:focus,
.prompt-input:focus {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.action-btn {
  gap: 6px;
}

.action-btn.danger {
  border-color: var(--color-error-border);
  background: var(--color-error-light);
  color: var(--color-error);
}

.generate-workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 8px;
}

.prompt-panel,
.result-panel {
  min-height: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}

.prompt-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow-y: auto;
}

.mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
}

.mode-tab {
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.mode-tab.active {
  background: var(--color-active-bg);
  color: var(--color-active-text);
  box-shadow: var(--shadow-button);
}

.prompt-input {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.55;
  outline: none;
}

.reference-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reference-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
}

.mini-btn,
.reference-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-muted);
  cursor: pointer;
}

.mini-btn {
  width: 24px;
  height: 24px;
}

.reference-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.reference-item {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-background-mute);
}

.reference-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.reference-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  background: var(--color-control-overlay);
  color: var(--color-text);
}

.reference-add {
  height: 30px;
  border: 1px dashed var(--color-border-hover);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
}

.param-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.param-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.result-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: hidden;
}

.status-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 7px 10px;
  border: 1px solid var(--color-tag-has-border);
  border-radius: var(--radius-sm);
  background: var(--color-tag-has-bg);
  color: var(--color-tag-has-color);
  font-size: 12px;
  flex-shrink: 0;
}

.spin-icon {
  animation: spin 0.85s linear infinite;
  flex-shrink: 0;
}

.progress-track {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: var(--color-border);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: currentColor;
  transition: width 0.2s ease;
}

.progress-count {
  min-width: 42px;
  text-align: right;
  color: inherit;
}

.result-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  grid-auto-rows: max-content;
  gap: 10px;
  align-content: start;
}

.result-card {
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
  box-shadow: var(--shadow-xs);
}

.result-card:hover {
  border-color: var(--color-accent-border);
  box-shadow: var(--shadow-sm);
}

.result-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
  background: var(--color-background-mute);
}

.result-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  min-width: 0;
}

.result-meta span,
.result-meta small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-meta span {
  font-size: 12px;
}

.result-meta small {
  font-size: 11px;
  color: var(--color-text-muted);
}

.empty-state {
  min-height: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 980px) {
  .generate-toolbar {
    flex-wrap: wrap;
  }

  .api-field {
    width: 100%;
  }

  .toolbar-actions {
    margin-left: 0;
  }

  .generate-workspace {
    grid-template-columns: 1fr;
  }

  .prompt-panel {
    max-height: 44vh;
  }
}
</style>
