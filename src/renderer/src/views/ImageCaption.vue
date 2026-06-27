<script setup>
import { ref, computed, watch, onMounted, onActivated, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useImageBrowser } from '../composables/useImageBrowser'
import { useGridObserver } from '../composables/useGridObserver'
import { useLocalStorage } from '../composables/useLocalStorage'
import {
  API_CONFIGS_UPDATED_EVENT,
  loadApiConfigs,
  saveApiConfigs,
  serializeApiConfigs
} from '../services/apiConfigs'
import FolderRow from '../components/FolderRow.vue'
import IconButton from '../components/IconButton.vue'
import ImageStatusBar from '../components/ImageStatusBar.vue'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Settings,
  X
} from 'lucide-vue-next'

defineOptions({ name: 'ImageCaption' })

// ===================== Caption 数据 =====================
const captionsMap = ref({})
const dirtySet = ref(new Set())
const dirtyCount = computed(() => dirtySet.value.size)
const editingImage = ref(null)
const editingCaption = ref('')
const captionError = ref('')

function applyCaptionResult(filePath, caption) {
  captionsMap.value = { ...captionsMap.value, [filePath]: caption }
  dirtySet.value = new Set([...dirtySet.value, filePath])
  if (editingImage.value?.path === filePath) {
    editingCaption.value = caption
  }
}

const {
  inputFolder,
  outputFolder,
  images,
  selectAll,
  thumbnails,
  imageCount,
  selectedCount,
  getTargetFiles,
  chooseInputFolder,
  chooseOutputFolder,
  loadInputFolder,
  clearCurrentFolder,
  toggleSelect,
  toggleSelectAll,
  isSelected,
  deleteSelected,
  processingAction,
  progressDone,
  progressTotal,
  refreshing,
  refreshImages,
  abortTask,
  observeGrid
} = useImageBrowser({
  onProgress(data) {
    if (data.ok && data.file && data.caption) {
      applyCaptionResult(data.file, data.caption)
    }
  }
})

const gridRef = useGridObserver(images, observeGrid)

// ===================== 全局 API 配置 =====================
const apiConfigs = ref([])
const enabledConfigs = computed(() => apiConfigs.value.filter((c) => c.enabled))
const hasEnabledConfig = computed(() => enabledConfigs.value.length > 0)
const firstEnabled = computed(() => enabledConfigs.value[0] || null)

async function refreshApiConfigs() {
  apiConfigs.value = await loadApiConfigs()
}

// ===================== API 选择 =====================
const multiApiMode = useLocalStorage('caption-multi-api', false)
const selectedApiId = useLocalStorage('caption-selected-api', '')
const selectedApiIds = ref(
  new Set(JSON.parse(localStorage.getItem('caption-selected-apis') || '[]'))
)
watch(
  selectedApiIds,
  (v) => localStorage.setItem('caption-selected-apis', JSON.stringify([...v])),
  { deep: true }
)

const selectedConfig = computed(() => {
  if (!selectedApiId.value) return firstEnabled.value
  return enabledConfigs.value.find((c) => c.id === selectedApiId.value) || firstEnabled.value
})

const selectedConfigs = computed(() => {
  if (selectedApiIds.value.size === 0) return enabledConfigs.value
  return enabledConfigs.value.filter((c) => selectedApiIds.value.has(c.id))
})

function isApiSelected(cfg) {
  if (multiApiMode.value) {
    return selectedApiIds.value.size === 0 || selectedApiIds.value.has(cfg.id)
  }
  return selectedConfig.value?.id === cfg.id
}

function selectApi(cfg) {
  if (multiApiMode.value) {
    const newSet = new Set(selectedApiIds.value)
    newSet.has(cfg.id) ? newSet.delete(cfg.id) : newSet.add(cfg.id)
    selectedApiIds.value = newSet
  } else {
    selectedApiId.value = cfg.id
  }
}

async function toggleApiEnabled(cfg) {
  const next = apiConfigs.value.map((item) =>
    item.id === cfg.id ? { ...item, enabled: !item.enabled } : item
  )
  apiConfigs.value = await saveApiConfigs(next)
}

// ===================== 持久化配置 =====================
localStorage.removeItem('caption-local-batchsize')
const captionMode = useLocalStorage('caption-mode', 'online')
const localModel = useLocalStorage('caption-local-model', '')
const localQuantization = useLocalStorage('caption-local-quant', 'none')
const localUseSdpa = useLocalStorage('caption-local-sdpa', false)
const localImageSize = useLocalStorage('caption-local-imgsize', 1024)
const apiImageSize = useLocalStorage('caption-api-imgsize', 1024)
const concurrency = useLocalStorage('caption-concurrency', 4)
const temperature = useLocalStorage('caption-temperature', 0, { type: 'float' })
const topP = useLocalStorage('caption-topp', 0, { type: 'float' })
const maxTokens = useLocalStorage('caption-maxtokens', 1024)
const skipExisting = ref(true)
const disableThink = useLocalStorage('caption-disable-think', false)
const systemPrompt = useLocalStorage(
  'caption-system-prompt',
  'You are a professional image captioning assistant. Provide a detailed, natural language description of the image suitable for training image generation models.'
)
const userPrompt = useLocalStorage('caption-user-prompt', 'Please describe this image in detail.')

// ===================== 本地模型状态 =====================
const localModelLoaded = ref(false)
const localModelLoading = ref(false)
const localModelInfo = ref(null)

// ===================== 本地模型路径验证 =====================
const pathStatus = ref('') // '' | 'checking' | 'valid' | 'invalid' | 'hf'
let pathCheckTimer = null

function checkModelPath(val) {
  clearTimeout(pathCheckTimer)
  if (!val) {
    pathStatus.value = ''
    return
  }
  // 看起来像 HF ID（含 / 且无盘符前缀）
  if (/^[^\\:]+\/[^\\:]+$/.test(val) && !val.startsWith('/')) {
    pathStatus.value = 'hf'
    return
  }
  pathStatus.value = 'checking'
  pathCheckTimer = setTimeout(async () => {
    try {
      const r = await window.api.checkPathExists(val)
      pathStatus.value = r.exists && r.isDirectory ? 'valid' : 'invalid'
    } catch {
      pathStatus.value = 'invalid'
    }
  }, 300)
}

watch(localModel, checkModelPath, { immediate: true })

function clearLocalModelPath() {
  clearTimeout(pathCheckTimer)
  localModel.value = ''
  pathStatus.value = ''
}

async function browseLocalModel() {
  const folder = await window.api.selectFolder()
  if (folder) localModel.value = folder
}

// ===================== 初始化 =====================
const route = useRoute()

watch(
  () => images.value,
  async (imgs) => {
    if (imgs.length === 0) {
      captionsMap.value = {}
      dirtySet.value = new Set()
      return
    }
    captionsMap.value = { ...(await window.api.batchReadTags(imgs.map((i) => i.path))) }
  }
)

onMounted(async () => {
  window.addEventListener(API_CONFIGS_UPDATED_EVENT, refreshApiConfigs)
  await refreshApiConfigs()
  try {
    const st = await window.api.callPython('/local-model-status', {})
    if (st.success && st.loaded) {
      localModelLoaded.value = true
      localModelInfo.value = st.info || null
    }
  } catch {
    /* ignore */
  }
})

onBeforeUnmount(() => {
  window.removeEventListener(API_CONFIGS_UPDATED_EVENT, refreshApiConfigs)
})

watch(
  () => route.path,
  (p) => {
    if (p === '/caption') refreshApiConfigs()
  }
)
onActivated(() => refreshApiConfigs())

// ===================== 本地模型加载/卸载 =====================
async function loadLocalModel() {
  if (!localModel.value) return
  localModelLoading.value = true
  captionError.value = ''
  try {
    const result = await window.api.callPython('/local-model-load', {
      model_path: localModel.value,
      quantization: localQuantization.value || 'none',
      use_sdpa: localUseSdpa.value || false,
      image_size: localImageSize.value || 1024,
      model_type: 'auto'
    })
    if (result.success) {
      localModelLoaded.value = true
      localModelInfo.value = result.info || null
    } else {
      captionError.value = result.error || '模型加载失败'
    }
  } catch (err) {
    captionError.value = err.message || '模型加载异常'
  } finally {
    localModelLoading.value = false
  }
}

async function unloadLocalModel() {
  try {
    await window.api.callPython('/local-model-unload', {})
  } catch {
    /* ignore */
  }
  localModelLoaded.value = false
  localModelInfo.value = null
}

// ===================== 通用生成参数 =====================
function getCommonParams() {
  return [systemPrompt.value, userPrompt.value, temperature.value, topP.value, maxTokens.value]
}

// ===================== 单张生成 =====================
async function captionSingle() {
  if (!editingImage.value) return
  const filePath = editingImage.value.path

  if (captionMode.value === 'local') {
    if (!localModelLoaded.value) {
      captionError.value = '请先加载本地模型'
      return
    }
    const [sp, up, temp, tp, mt] = getCommonParams()
    await runCaptionTask('caption', () =>
      window.api.callPython('/local-caption-single', {
        file: filePath,
        system_prompt: sp,
        user_prompt: up,
        temperature: temp,
        top_p: tp,
        max_tokens: mt,
        image_size: localImageSize.value || 1024,
        disable_think: disableThink.value || false
      })
    )
  } else {
    await refreshApiConfigs()
    const cfg = selectedConfig.value
    if (!cfg) {
      captionError.value = '请先在设置页面添加并启用 API 配置'
      return
    }
    const [sp, up, temp, tp, mt] = getCommonParams()
    await runCaptionTask('caption', () =>
      window.api.callPython('/caption-single', {
        file: filePath,
        model: cfg.model,
        api_key: cfg.apiKey,
        system_prompt: sp,
        user_prompt: up,
        temperature: temp,
        top_p: tp,
        max_tokens: mt,
        base_url: cfg.endpoint,
        disable_think: disableThink.value || false,
        image_size: apiImageSize.value || 1024
      })
    )
  }
}

async function runCaptionTask(action, apiFn) {
  processingAction.value = action
  captionError.value = ''
  try {
    const result = await apiFn()
    if (result.aborted) return
    if (result.success && result.caption) {
      applyCaptionResult(editingImage.value?.path || result.file, result.caption)
    } else {
      captionError.value = result.error || '生成失败'
    }
  } catch (err) {
    captionError.value = err.message || '请求异常'
  } finally {
    if (processingAction.value === action) processingAction.value = null
  }
}

// ===================== 批量生成 =====================
async function captionBatch() {
  let files = getTargetFiles()
  if (files.length === 0) return
  if (skipExisting.value) files = files.filter((f) => !captionsMap.value[f])
  if (files.length === 0) return

  const commonParams = getCommonParams()

  if (captionMode.value === 'local') {
    if (!localModelLoaded.value) {
      captionError.value = '请先加载本地模型'
      return
    }
    const [sp, up, temp, tp, mt] = commonParams
    await runBatchTask(() =>
      window.api.callPython('/local-caption-batch', {
        files,
        system_prompt: sp,
        user_prompt: up,
        temperature: temp,
        top_p: tp,
        max_tokens: mt,
        image_size: localImageSize.value || 1024,
        disable_think: disableThink.value || false
      })
    )
  } else {
    await refreshApiConfigs()
    await runBatchTask(() => callOnlineBatch(files, commonParams))
  }
}

function callOnlineBatch(files, commonParams) {
  const [sp, up, temp, tp, mt] = commonParams
  if (multiApiMode.value) {
    const configs = serializeApiConfigs(selectedConfigs.value)
    if (configs.length === 0) throw new Error('请先选择至少一个 API 配置')
    if (configs.length > 1) {
      return window.api.callPython('/caption-batch-multi-api', {
        files,
        api_configs: configs,
        system_prompt: sp,
        user_prompt: up,
        temperature: temp,
        top_p: tp,
        max_tokens: mt,
        disable_think: disableThink.value || false,
        concurrency: concurrency.value || 4,
        image_size: apiImageSize.value || 1024
      })
    }
    const cfg = configs[0]
    return window.api.callPython('/caption-batch', {
      files,
      model: cfg.model,
      api_key: cfg.apiKey,
      system_prompt: sp,
      user_prompt: up,
      temperature: temp,
      top_p: tp,
      max_tokens: mt,
      base_url: cfg.endpoint,
      disable_think: disableThink.value || false,
      concurrency: concurrency.value || 4,
      image_size: apiImageSize.value || 1024
    })
  }
  const cfg = selectedConfig.value
  if (!cfg) throw new Error('请先在设置页面添加并启用 API 配置')
  return window.api.callPython('/caption-batch', {
    files,
    model: cfg.model,
    api_key: cfg.apiKey,
    system_prompt: sp,
    user_prompt: up,
    temperature: temp,
    top_p: tp,
    max_tokens: mt,
    base_url: cfg.endpoint,
    disable_think: disableThink.value || false,
    concurrency: concurrency.value || 4,
    image_size: apiImageSize.value || 1024
  })
}

async function runBatchTask(apiFn) {
  processingAction.value = 'caption-batch'
  captionError.value = ''
  try {
    const result = await apiFn()
    if (result.aborted) return
    if (!result.success) captionError.value = result.error || '批量生成失败'
  } catch (err) {
    captionError.value = err.message || '批量请求异常'
  } finally {
    if (processingAction.value === 'caption-batch') processingAction.value = null
  }
}

const canGenerate = computed(() => {
  if (captionMode.value === 'local') return localModelLoaded.value
  return hasEnabledConfig.value
})

// ===================== 保存 =====================
async function saveAllCaptions() {
  const toSave = {}
  for (const path of dirtySet.value) {
    if (captionsMap.value[path] !== undefined) toSave[path] = captionsMap.value[path]
  }
  if (Object.keys(toSave).length === 0) {
    for (const [path, text] of Object.entries(captionsMap.value)) {
      if (text) toSave[path] = text
    }
  }
  if (Object.keys(toSave).length === 0) return
  processingAction.value = 'save'
  try {
    await window.api.batchSaveTags(toSave, outputFolder.value || undefined)
    dirtySet.value = new Set()
  } finally {
    if (processingAction.value === 'save') processingAction.value = null
  }
}

// ===================== 右侧编辑面板 =====================
function openEditor(img) {
  editingImage.value = img
  editingCaption.value = captionsMap.value[img.path] || ''
}
function closeEditor() {
  editingImage.value = null
  editingCaption.value = ''
}

function syncEditToMap() {
  if (!editingImage.value) return
  const path = editingImage.value.path
  captionsMap.value = { ...captionsMap.value, [path]: editingCaption.value }
  dirtySet.value = new Set([...dirtySet.value, path])
}

async function saveCurrentCaption() {
  if (!editingImage.value) return
  syncEditToMap()
  const path = editingImage.value.path
  const result = await window.api.saveImageTags(
    path,
    editingCaption.value,
    outputFolder.value || undefined
  )
  if (result.success) {
    const s = new Set(dirtySet.value)
    s.delete(path)
    dirtySet.value = s
  }
}

function navEditor(direction) {
  if (!editingImage.value) return
  syncEditToMap()
  const list = images.value
  const idx = list.findIndex((i) => i.path === editingImage.value.path)
  const next = idx + direction
  if (next >= 0 && next < list.length) openEditor(list[next])
}

function getCaptionPreview(imgPath) {
  const text = captionsMap.value[imgPath]
  if (!text) return ''
  return text.length > 60 ? text.slice(0, 60) + '...' : text
}

function clearCaptionFolder() {
  captionsMap.value = {}
  dirtySet.value = new Set()
  editingImage.value = null
  editingCaption.value = ''
  captionError.value = ''
  clearCurrentFolder()
}

// 面板折叠
const showSettings = ref(true)
</script>

<template>
  <div class="process-page caption-page">
    <!-- 顶部工具条 -->
    <div class="process-toolbar">
      <div class="folder-section">
        <FolderRow
          v-model="inputFolder"
          label="输入"
          placeholder="输入路径后按回车加载文件夹内的图片，或点击 ... 选择文件夹"
          @commit="(path) => path && loadInputFolder(path)"
          @browse="chooseInputFolder"
        />
        <FolderRow
          v-model="outputFolder"
          label="输出"
          :placeholder="inputFolder ? '描述保存在图片同目录' : '输入文件夹路径...'"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
      </div>
      <div class="action-section">
        <button
          class="action-btn"
          :disabled="imageCount === 0 || !canGenerate || !!processingAction"
          @click="captionBatch"
        >
          批量生成
        </button>
        <button
          class="action-btn"
          :disabled="imageCount === 0 || !!processingAction"
          @click="saveAllCaptions"
        >
          保存全部{{ dirtyCount > 0 ? ` (${dirtyCount})` : '' }}
        </button>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="captionError" class="error-bar">
      <span>{{ captionError }}</span>
      <button class="error-bar-close" @click="captionError = ''">×</button>
    </div>

    <!-- 状态栏 -->
    <ImageStatusBar
      :image-count="imageCount"
      :selected-count="selectedCount"
      :select-all="selectAll"
      :refreshing="refreshing"
      :processing-action="processingAction"
      :progress-done="progressDone"
      :progress-total="progressTotal"
      processing-label="Caption"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshImages"
      @clear-folder="clearCaptionFolder"
      @delete-selected="deleteSelected"
      @abort="abortTask"
    >
      <template #actions>
        <IconButton
          :icon="Settings"
          :active="showSettings"
          title="设置面板"
          @click="showSettings = !showSettings"
        />
      </template>
    </ImageStatusBar>

    <!-- ========== 主内容三栏布局 ========== -->
    <div v-if="imageCount > 0" class="caption-body">
      <!-- ===== 左侧：设置面板 ===== -->
      <div v-if="showSettings" class="settings-panel">
        <!-- 模式切换 Tab -->
        <div class="sp-mode-tabs">
          <button
            :class="['sp-mode-tab', { active: captionMode === 'local' }]"
            @click="captionMode = 'local'"
          >
            Local
          </button>
          <button
            :class="['sp-mode-tab', { active: captionMode === 'online' }]"
            @click="captionMode = 'online'"
          >
            API
          </button>
        </div>

        <!-- Online 模式 -->
        <template v-if="captionMode === 'online'">
          <div class="sp-section">
            <div class="sp-section-title">
              API 配置 <span class="sp-hint">({{ enabledConfigs.length }} 个启用)</span>
            </div>
            <div v-if="apiConfigs.length === 0" class="sp-empty-hint">
              暂无配置，请前往设置页面添加
            </div>
            <div v-else class="sp-config-list">
              <div
                v-for="cfg in apiConfigs"
                :key="cfg.id"
                :class="[
                  'sp-config-item',
                  { active: cfg.enabled && isApiSelected(cfg), disabled: !cfg.enabled }
                ]"
                @click="cfg.enabled && selectApi(cfg)"
              >
                <span
                  :class="['toggle-switch accent', { on: cfg.enabled }]"
                  @click.stop="toggleApiEnabled(cfg)"
                >
                  <span class="toggle-knob"></span>
                </span>
                <div class="sp-config-info">
                  <span class="sp-config-name">{{ cfg.name }}</span>
                  <span class="sp-config-model">{{ cfg.model }}</span>
                </div>
                <span v-if="cfg.enabled && isApiSelected(cfg)" class="sp-config-check">
                  <Check :size="14" :stroke-width="2.5" aria-hidden="true" />
                </span>
              </div>
            </div>
          </div>
          <div class="sp-section">
            <label class="sp-toggle-row" @click="multiApiMode = !multiApiMode">
              <span :class="['toggle-switch accent', { on: multiApiMode }]">
                <span class="toggle-knob"></span>
              </span>
              <span class="sp-toggle-label">多API并发</span>
            </label>
            <div v-if="multiApiMode" class="sp-param-row">
              <span class="sp-param-label">Batch Size</span>
              <input
                v-model.number="concurrency"
                type="number"
                min="1"
                max="16"
                step="1"
                class="sp-number-input"
              />
            </div>
          </div>
          <div class="sp-section">
            <div class="sp-param-row">
              <span class="sp-param-label">图像尺寸</span>
              <input
                v-model.number="apiImageSize"
                type="number"
                min="256"
                max="2048"
                step="64"
                class="sp-number-input"
              />
            </div>
          </div>
        </template>

        <!-- Local 模式 -->
        <template v-else>
          <div class="sp-section">
            <div class="sp-section-title">
              模型路径 <span class="sp-hint">(HF ID 或本地路径)</span>
            </div>
            <div class="sp-model-path-row">
              <div class="sp-model-input-wrap">
                <input
                  v-model="localModel"
                  class="sp-input"
                  type="text"
                  placeholder="Qwen/Qwen3.5-VL-2B"
                />
                <span v-if="pathStatus === 'valid'" class="sp-path-icon valid" title="本地路径有效">
                  <Check :size="14" :stroke-width="2.5" aria-hidden="true" />
                </span>
                <button
                  v-else-if="pathStatus === 'invalid'"
                  type="button"
                  class="sp-path-icon invalid clickable"
                  title="路径不存在或不是文件夹，点击清空"
                  aria-label="清空模型路径"
                  @mousedown.prevent
                  @click="clearLocalModelPath"
                >
                  <X :size="14" :stroke-width="2.5" aria-hidden="true" />
                </button>
                <span
                  v-else-if="pathStatus === 'hf'"
                  class="sp-path-icon hf"
                  title="HuggingFace 模型 ID"
                  >HF</span
                >
                <span v-else-if="pathStatus === 'checking'" class="sp-path-icon checking">
                  <LoaderCircle :size="14" :stroke-width="2" aria-hidden="true" />
                </span>
              </div>
              <button
                class="folder-browse-btn"
                title="浏览本地模型文件夹"
                @click="browseLocalModel"
              >
                <FolderOpen :size="16" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="sp-section">
            <div class="sp-section-title">量化</div>
            <div class="sp-radio-group">
              <label
                :class="['sp-radio', { active: localQuantization === 'none' }]"
                @click="localQuantization = 'none'"
              >
                <span :class="['sp-radio-dot', { checked: localQuantization === 'none' }]"></span>
                不量化
              </label>
              <label
                :class="['sp-radio', { active: localQuantization === '4bit' }]"
                @click="localQuantization = '4bit'"
              >
                <span :class="['sp-radio-dot', { checked: localQuantization === '4bit' }]"></span>
                4bit
              </label>
              <label
                :class="['sp-radio', { active: localQuantization === '8bit' }]"
                @click="localQuantization = '8bit'"
              >
                <span :class="['sp-radio-dot', { checked: localQuantization === '8bit' }]"></span>
                8bit
              </label>
            </div>
          </div>
          <div class="sp-section">
            <label class="sp-toggle-row" @click="localUseSdpa = !localUseSdpa">
              <span :class="['toggle-switch', { on: localUseSdpa }]"
                ><span class="toggle-knob"></span
              ></span>
              <span class="sp-toggle-text"
                >SDPA 注意力 <span class="sp-hint">(PyTorch 原生)</span></span
              >
            </label>
          </div>
          <div class="sp-section">
            <div class="sp-param-row">
              <span class="sp-param-label">图像尺寸</span>
              <input
                v-model.number="localImageSize"
                type="number"
                min="256"
                max="2048"
                step="64"
                class="sp-number-input"
              />
            </div>
          </div>
          <div class="sp-section">
            <div class="sp-model-actions">
              <button
                class="sp-load-btn"
                :disabled="!localModel || localModelLoading"
                @click="loadLocalModel"
              >
                {{ localModelLoading ? '加载中...' : localModelLoaded ? '重新加载' : '加载模型' }}
              </button>
              <button v-if="localModelLoaded" class="sp-unload-btn" @click="unloadLocalModel">
                卸载
              </button>
            </div>
            <div v-if="localModelLoaded && localModelInfo" class="sp-model-status">
              <span class="sp-status-dot on"></span>
              已加载
              <span class="sp-hint"
                >({{ localModelInfo.load_time }}s{{
                  localModelInfo.quantization !== 'none' ? ', ' + localModelInfo.quantization : ''
                }})</span
              >
            </div>
          </div>
        </template>

        <div class="sp-section">
          <div class="sp-section-title">生成参数</div>
          <div class="sp-param-row">
            <span class="sp-param-label">Temperature</span>
            <input
              v-model.number="temperature"
              type="range"
              min="0"
              max="2"
              step="0.1"
              class="sp-range"
            />
            <span class="sp-param-value">{{ temperature.toFixed(1) }}</span>
          </div>
          <div class="sp-param-row">
            <span class="sp-param-label">Top P</span>
            <input
              v-model.number="topP"
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="sp-range"
            />
            <span class="sp-param-value">{{ topP.toFixed(2) }}</span>
          </div>
          <div class="sp-param-row">
            <span class="sp-param-label">Max Tokens</span>
            <input
              v-model.number="maxTokens"
              type="number"
              min="64"
              max="8192"
              step="64"
              class="sp-number-input"
            />
          </div>
        </div>

        <div class="sp-section">
          <label class="sp-toggle-row" @click="skipExisting = !skipExisting">
            <span :class="['toggle-switch', { on: skipExisting }]"
              ><span class="toggle-knob"></span
            ></span>
            <span class="sp-toggle-text">跳过已有描述</span>
          </label>
        </div>

        <div class="sp-section">
          <label class="sp-toggle-row" @click="disableThink = !disableThink">
            <span :class="['toggle-switch', { on: disableThink }]"
              ><span class="toggle-knob"></span
            ></span>
            <span class="sp-toggle-text"
              >去除思考标签 <span class="sp-hint">(&lt;think&gt;...&lt;/think&gt;)</span></span
            >
          </label>
        </div>

        <div class="sp-section">
          <div class="sp-section-title">System Prompt</div>
          <textarea
            v-model="systemPrompt"
            class="sp-textarea"
            rows="3"
            spellcheck="false"
          ></textarea>
        </div>

        <div class="sp-section">
          <div class="sp-section-title">User Prompt</div>
          <textarea v-model="userPrompt" class="sp-textarea" rows="2" spellcheck="false"></textarea>
        </div>
      </div>

      <!-- ===== 中间：图片网格 ===== -->
      <div ref="gridRef" class="image-grid caption-grid">
        <div
          v-for="img in images"
          :key="img.path"
          :data-path="img.path"
          :class="[
            'image-card',
            { selected: isSelected(img), editing: editingImage?.path === img.path }
          ]"
          @click="openEditor(img)"
        >
          <img
            v-if="thumbnails[img.path]"
            :src="thumbnails[img.path]"
            :alt="img.name"
            draggable="false"
          />
          <div v-else class="image-placeholder"></div>
          <div class="image-name-overlay">{{ img.name }}</div>
          <span v-if="getCaptionPreview(img.path)" class="caption-badge">{{
            getCaptionPreview(img.path)
          }}</span>
          <span v-if="dirtySet.has(img.path)" class="dirty-dot" title="未保存"></span>
          <span
            :class="['checkbox', { checked: isSelected(img) }]"
            @click.stop="toggleSelect(img)"
          ></span>
        </div>
      </div>

      <!-- ===== 右侧：描述编辑面板 ===== -->
      <Transition name="panel-slide">
        <div v-if="editingImage" class="caption-editor-panel">
          <div class="editor-header">
            <span class="editor-filename">{{ editingImage.name }}</span>
            <div class="editor-nav">
              <IconButton
                :icon="ChevronLeft"
                variant="editor"
                title="上一张"
                @click="navEditor(-1)"
              />
              <IconButton
                :icon="ChevronRight"
                variant="editor"
                title="下一张"
                @click="navEditor(1)"
              />
              <IconButton
                :icon="X"
                variant="editor"
                tone="close"
                title="关闭"
                @click="closeEditor"
              />
            </div>
          </div>
          <div class="editor-preview">
            <img :src="editingImage.url" :alt="editingImage.name" />
          </div>

          <!-- 生成按钮 -->
          <div class="editor-generate">
            <button
              class="generate-btn"
              :disabled="!canGenerate || !!processingAction"
              @click="captionSingle"
            >
              {{ processingAction === 'caption' ? '生成中...' : '生成描述' }}
            </button>
          </div>

          <!-- 描述文本编辑 -->
          <div class="editor-caption-section">
            <textarea
              v-model="editingCaption"
              class="editor-textarea"
              placeholder="图片描述将显示在这里..."
              rows="8"
              spellcheck="false"
              @input="syncEditToMap"
            ></textarea>
          </div>

          <div class="editor-actions">
            <span v-if="dirtySet.has(editingImage.path)" class="editor-dirty-hint">* 未保存</span>
            <button class="panel-run" @click="saveCurrentCaption">保存</button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <span class="empty-text">选择输入文件夹以加载图片</span>
    </div>
  </div>
</template>

<style scoped>
/* ===== 三栏布局 ===== */
.caption-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
  overflow: hidden;
}
.caption-grid {
  flex: 1;
  min-width: 0;
}

/* ===== 左侧面板 API 配置列表 ===== */
.sp-empty-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 8px 0;
}
.sp-config-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sp-config-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  background: var(--color-input-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
  user-select: none;
}
.sp-config-item:hover {
  border: var(--color-border);
  background: var(--color-surface-soft);
}
.sp-config-item.active {
  border-color: var(--color-accent);
  background: var(--color-accent-light);
}
.sp-config-item.disabled {
  opacity: 0.45;
  cursor: default;
}

/* accent 颜色变体 toggle —— 与普通开关一致用 emerald 点缀 */
.toggle-switch.accent.on {
  background: var(--color-toggle-on);
}

.sp-config-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sp-config-name {
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-config-model {
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-surface-hover);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-family: monospace;
}
.sp-config-check {
  flex-shrink: 0;
  color: var(--color-accent);
  display: flex;
  align-items: center;
}
.sp-toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
}
.sp-toggle-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  transition: color 0.15s;
}
.sp-toggle-row:hover .sp-toggle-label {
  color: var(--color-text);
}

/* ===== 描述摘要 ===== */
.caption-badge {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 3px 6px;
  font-size: 10px;
  color: var(--color-overlay-text);
  background: var(--color-overlay-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 1;
}

/* ============================================
   左侧设置面板
   ============================================ */
.settings-panel {
  width: 360px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 0 12px;
}

/* 模式切换 Tab */
.sp-mode-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.sp-mode-tab {
  flex: 1;
  padding: 9px 0;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  cursor: pointer;
  position: relative;
  transition: color 0.15s;
}
.sp-mode-tab:hover {
  color: var(--color-text-secondary);
}
.sp-mode-tab.active {
  color: var(--color-text);
}
.sp-mode-tab.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 20%;
  right: 20%;
  height: 2px;
  background: var(--color-active-bg);
  border-radius: var(--radius-sm);
}

.sp-section {
  padding: 10px 12px 0;
}
.sp-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.sp-hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--color-text-muted);
}

/* Provider 单选 */
.sp-radio-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sp-radio {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.15s,
    background 0.15s;
  background: var(--color-input-bg);
}
.sp-radio:hover {
  border-color: var(--color-accent-border);
  background: var(--color-info-light);
}
.sp-radio.active {
  border-color: var(--color-text);
  background: var(--color-surface-hover);
}
.sp-radio-dot {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid var(--color-border-unchecked);
  box-sizing: border-box;
  transition: border-color 0.15s;
  position: relative;
}
.sp-radio-dot.checked {
  border-color: var(--color-text);
}
.sp-radio-dot.checked::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-active-bg);
}

/* 输入框 */
.sp-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  background: var(--color-input-bg);
  box-sizing: border-box;
}
.sp-input:focus {
  border-color: var(--color-text);
}
.sp-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 28px;
  cursor: pointer;
}

/* 参数行 */
.sp-param-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.sp-param-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  width: 80px;
  flex-shrink: 0;
}
.sp-range {
  flex: 1;
  height: 4px;
  accent-color: var(--color-text);
  cursor: pointer;
}
.sp-param-value {
  font-size: 12px;
  color: var(--color-text);
  font-weight: 500;
  min-width: 36px;
  text-align: right;
}
.sp-number-input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}
.sp-number-input:focus {
  border-color: var(--color-text);
}

/* Toggle */
.sp-toggle-text {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.sp-toggle-row:hover .sp-toggle-text {
  color: var(--color-text);
}

/* Textarea */
.sp-textarea {
  width: 100%;
  flex: 1;
  min-height: 50px;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text);
  resize: vertical;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}
.sp-textarea:focus {
  border-color: var(--color-text);
}

/* ============================================
   右侧编辑面板（仅保留 Caption 特有样式）
   ============================================ */
.caption-editor-panel {
  width: 360px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  background: var(--color-input-bg);
  overflow: hidden;
  transform-origin: right center;
}

/* 生成按钮区 */
.editor-generate {
  padding: 8px 12px;
  flex-shrink: 0;
}
.generate-btn {
  width: 100%;
  height: 32px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.generate-btn:hover:not(:disabled) {
  background: var(--color-text-secondary);
}
.generate-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 描述文本区 */
.editor-caption-section {
  flex: 1;
  min-height: 0;
  padding: 0 12px;
  overflow-y: auto;
}
.editor-textarea {
  height: 100%;
  min-height: 120px;
  resize: none;
}

/* ===== 本地模型操作按钮 ===== */
.sp-model-path-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sp-model-input-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.sp-model-input-wrap .sp-input {
  padding-right: 28px;
}
.sp-path-icon {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: transparent;
  border: none;
  padding: 0;
}
.sp-path-icon.valid {
  color: var(--color-success);
}
.sp-path-icon.invalid {
  color: var(--color-error);
}
.sp-path-icon.clickable {
  pointer-events: auto;
  appearance: none;
  cursor: pointer;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
  z-index: 1;
}
.sp-path-icon.clickable:hover {
  background: var(--color-error-light);
}
.sp-path-icon.clickable:focus-visible {
  outline: 1px solid var(--color-error);
  outline-offset: 1px;
}
.sp-path-icon.hf {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-warning);
  letter-spacing: 0;
}
.sp-path-icon.checking {
  color: var(--color-text-muted);
  animation: spin-check 0.8s linear infinite;
}
@keyframes spin-check {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}

.sp-model-actions {
  display: flex;
  gap: 6px;
}
.sp-load-btn {
  flex: 1;
  height: 30px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.sp-load-btn:hover:not(:disabled) {
  background: var(--color-text-secondary);
}
.sp-load-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.sp-unload-btn {
  width: 52px;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}
.sp-unload-btn:hover {
  border-color: var(--color-error);
  color: var(--color-error);
}
.sp-model-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
}
.sp-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--color-border);
  flex-shrink: 0;
}
.sp-status-dot.on {
  background: var(--color-success);
}

.sp-radio.active,
.sp-radio:hover {
  border-color: var(--color-accent-border);
  background: var(--color-info-light);
  color: var(--color-accent-text);
}

.generate-btn,
.sp-load-btn {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-button);
}

.generate-btn:hover:not(:disabled),
.sp-load-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
</style>
