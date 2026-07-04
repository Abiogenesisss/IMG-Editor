<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  ChevronDown,
  CheckCircle2,
  CircleX,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Globe2,
  LayoutGrid,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-vue-next'
import { loadApiConfigs, saveApiConfigs } from '../services/apiConfigs'
import { settingsMenuItems } from '../services/navigation'
import { readStoredJson } from '../composables/useLocalStorage'
import {
  resolveGeminiInteractionsEndpoint,
  resolveImageProvider,
  resolveOpenAIImageEndpoint,
  trimTrailingSlash
} from '../../../shared/imageProviders'

defineOptions({ name: 'Settings' })

// ===================== GPU 加速设置 =====================
const gpuEnabled = ref(true)
const gpuInfo = ref(null) // { cuda_available, gpu_name, vram_total, vram_free, enabled }
const gpuLoading = ref(false)

onMounted(async () => {
  // 加载 GPU 状态
  await loadGpuStatus()
})

async function loadGpuStatus() {
  gpuLoading.value = true
  try {
    const res = await window.api.callPython('/gpu-status', {})
    gpuInfo.value = res
    gpuEnabled.value = res.enabled !== false
    // 同步 localStorage
    const saved = localStorage.getItem('gpu-enabled')
    if (saved !== null) {
      const savedVal = saved === 'true'
      if (savedVal !== gpuEnabled.value) {
        gpuEnabled.value = savedVal
        await syncGpuToBackend(savedVal)
      }
    }
  } catch {
    gpuInfo.value = null
  } finally {
    gpuLoading.value = false
  }
}

async function toggleGpu() {
  gpuEnabled.value = !gpuEnabled.value
  localStorage.setItem('gpu-enabled', String(gpuEnabled.value))
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'gpu-enabled',
      newValue: String(gpuEnabled.value)
    })
  )
  await syncGpuToBackend(gpuEnabled.value)
}

async function syncGpuToBackend(enabled) {
  gpuLoading.value = true
  try {
    const res = await window.api.callPython('/set-gpu-config', { enabled })
    gpuInfo.value = res
  } catch {
    /* ignore */
  } finally {
    gpuLoading.value = false
  }
}

// ===================== 菜单显示设置 =====================
const allMenuItems = settingsMenuItems

function loadMenuConfig() {
  const saved = readStoredJson('menu-visible', {})
  const result = {}
  allMenuItems.forEach((item) => {
    result[item.path] = item.required ? true : saved[item.path] !== false
  })
  return result
}

const menuVisible = ref(loadMenuConfig())

function toggleMenuVisible(item) {
  if (item.required) return
  menuVisible.value[item.path] = !menuVisible.value[item.path]
  localStorage.setItem('menu-visible', JSON.stringify(menuVisible.value))
  // 通知其他组件刷新
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'menu-visible',
      newValue: JSON.stringify(menuVisible.value)
    })
  )
}

// ===================== 自动更新 =====================
const autoCheckUpdate = ref(true)
const updateStatus = ref('') // checking | available | not-available | downloading | downloaded | error
const updateInfo = ref(null) // { version, percent, message }
let removeUpdateListener = null

onMounted(async () => {
  try {
    autoCheckUpdate.value = await window.api.getAutoCheckUpdate()
  } catch {
    /* ignore */
  }

  removeUpdateListener = window.api.onUpdateStatus((status, data) => {
    updateStatus.value = status
    if (status === 'available') {
      updateInfo.value = { version: data?.version }
    } else if (status === 'downloading') {
      updateInfo.value = { ...updateInfo.value, percent: data?.percent }
    } else if (status === 'error') {
      updateInfo.value = { message: data?.message }
    } else if (status === 'not-available' || status === 'downloaded') {
      updateInfo.value = updateInfo.value || {}
    }
  })
})

onBeforeUnmount(() => {
  if (removeUpdateListener) removeUpdateListener()
  if (modelFetchTimer) clearTimeout(modelFetchTimer)
  document.removeEventListener('click', closeModelDrop)
})

async function toggleAutoCheck() {
  autoCheckUpdate.value = !autoCheckUpdate.value
  try {
    await window.api.setAutoCheckUpdate(autoCheckUpdate.value)
  } catch {
    /* ignore */
  }
}

function manualCheckUpdate() {
  updateStatus.value = 'checking'
  updateInfo.value = null
  window.api.checkForUpdate()
}

function downloadUpdate() {
  window.api.downloadUpdate()
}

function installUpdate() {
  window.api.installUpdate()
}

const updateStatusText = computed(() => {
  switch (updateStatus.value) {
    case 'checking':
      return '正在检查更新...'
    case 'available':
      return `发现新版本 v${updateInfo.value?.version || ''}`
    case 'not-available':
      return '当前已是最新版本'
    case 'downloading':
      return `正在下载更新... ${updateInfo.value?.percent || 0}%`
    case 'downloaded':
      return '下载完成，点击安装并重启'
    case 'error':
      return `检查更新失败: ${updateInfo.value?.message || '未知错误'}`
    default:
      return ''
  }
})

// ===================== API 配置管理 =====================
async function saveConfigs(list) {
  apiConfigs.value = await saveApiConfigs(list)
}

async function refreshConfigs() {
  apiConfigs.value = await loadApiConfigs()
}

const apiConfigs = ref([])

onMounted(() => {
  refreshConfigs()
  document.addEventListener('click', closeModelDrop)
})

// 添加/编辑表单
const showForm = ref(false)
const editingId = ref(null)
const formName = ref('')
const formModel = ref('')
const formEndpoint = ref('')
const formApiKey = ref('')
const showApiKey = ref(false)
const modelOptions = ref([])
const modelLoading = ref(false)
const modelError = ref('')
const modelDropOpen = ref(false)
const modelFilter = ref('')
let modelFetchTimer = null
let modelFetchSeq = 0

function closeModelDrop() {
  modelDropOpen.value = false
}

function resetForm() {
  editingId.value = null
  formName.value = ''
  formModel.value = ''
  formEndpoint.value = ''
  formApiKey.value = ''
  showApiKey.value = false
  modelOptions.value = []
  modelLoading.value = false
  modelError.value = ''
  modelDropOpen.value = false
  modelFilter.value = ''
}

function openAddForm() {
  resetForm()
  showForm.value = true
}

function openEditForm(cfg) {
  editingId.value = cfg.id
  formName.value = cfg.name
  formModel.value = cfg.model
  formEndpoint.value = cfg.endpoint
  formApiKey.value = cfg.apiKey
  showApiKey.value = false
  showForm.value = true
  scheduleModelFetch()
}

function closeForm() {
  showForm.value = false
  modelFetchSeq += 1
  if (modelFetchTimer) clearTimeout(modelFetchTimer)
  resetForm()
}

const modelSelectOptions = computed(() => {
  const current = formModel.value.trim()
  const options = modelOptions.value
  if (!current || options.some((item) => item.id === current)) return options
  return [{ id: current, name: current }, ...options]
})

const filteredModelOptions = computed(() => {
  const keyword = modelFilter.value.trim().toLowerCase()
  if (!keyword) return modelSelectOptions.value
  return modelSelectOptions.value.filter((model) =>
    `${model.id} ${model.name || ''}`.toLowerCase().includes(keyword)
  )
})

const selectedModelText = computed(() => {
  const model = modelSelectOptions.value.find((item) => item.id === formModel.value)
  return model?.name || formModel.value || '选择模型'
})

function formAnchorId(id) {
  return `api-config-form-anchor-${String(id).replace(/[^A-Za-z0-9_-]/g, '-')}`
}

const formTeleportTarget = computed(() =>
  editingId.value ? `#${formAnchorId(editingId.value)}` : '#api-config-form-anchor-top'
)

function selectFormModel(id) {
  formModel.value = id
  modelDropOpen.value = false
  modelFilter.value = ''
}

function scheduleModelFetch() {
  modelFetchSeq += 1
  const seq = modelFetchSeq
  if (modelFetchTimer) clearTimeout(modelFetchTimer)
  modelError.value = ''
  if (!showForm.value || !formEndpoint.value.trim() || !formApiKey.value.trim()) {
    modelOptions.value = []
    modelLoading.value = false
    return
  }
  modelLoading.value = true
  modelFetchTimer = setTimeout(() => fetchModelOptions(seq), 650)
}

async function fetchModelOptions(seq) {
  const endpoint = formEndpoint.value.trim()
  const apiKey = formApiKey.value.trim()
  try {
    const result = await window.api.listApiModels({ endpoint, apiKey })
    if (seq !== modelFetchSeq) return
    if (result.success) {
      modelOptions.value = result.models || []
      if (!formModel.value.trim() && modelOptions.value[0])
        formModel.value = modelOptions.value[0].id
      modelDropOpen.value = false
      modelFilter.value = ''
    } else {
      modelOptions.value = []
      modelError.value = result.error || '模型列表读取失败'
    }
  } catch (err) {
    if (seq !== modelFetchSeq) return
    modelOptions.value = []
    modelError.value = err.message || '模型列表读取失败'
  } finally {
    if (seq === modelFetchSeq) modelLoading.value = false
  }
}

watch([formEndpoint, formApiKey], scheduleModelFetch)

async function submitForm() {
  if (!formName.value.trim() || !formModel.value.trim()) return

  if (editingId.value) {
    // 编辑
    const idx = apiConfigs.value.findIndex((c) => c.id === editingId.value)
    if (idx !== -1) {
      apiConfigs.value[idx] = {
        ...apiConfigs.value[idx],
        name: formName.value.trim(),
        model: formModel.value.trim(),
        endpoint: formEndpoint.value.trim(),
        apiKey: formApiKey.value.trim()
      }
    }
  } else {
    // 新增
    apiConfigs.value.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: formName.value.trim(),
      model: formModel.value.trim(),
      endpoint: formEndpoint.value.trim(),
      apiKey: formApiKey.value.trim(),
      enabled: true
    })
  }
  await saveConfigs(apiConfigs.value)
  closeForm()
}

async function deleteConfig(id) {
  if (editingId.value === id) closeForm()
  apiConfigs.value = apiConfigs.value.filter((c) => c.id !== id)
  await saveConfigs(apiConfigs.value)
}

async function toggleEnabled(cfg) {
  cfg.enabled = !cfg.enabled
  await saveConfigs(apiConfigs.value)
}

// 根据模型名和 endpoint 预览实际请求地址
const previewUrl = computed(() => {
  const endpoint = formEndpoint.value.trim()
  const model = formModel.value.trim().toLowerCase()
  if (!endpoint) return ''
  const provider = resolveImageProvider({
    name: formName.value,
    model,
    endpoint
  })
  if (provider === 'gpt') return resolveOpenAIImageEndpoint(endpoint)
  if (provider === 'nanobanana') return resolveGeminiInteractionsEndpoint(endpoint)
  if (model.includes('gemini')) {
    return endpoint
  }
  if (model.includes('claude')) {
    const base = trimTrailingSlash(endpoint)
    return base + '/v1/messages'
  }
  // OpenAI 兼容
  const base = trimTrailingSlash(endpoint)
  return base + '/chat/completions'
})
</script>

<template>
  <div class="settings-page">
    <div class="settings-content">
      <!-- 菜单显示设置 -->
      <section class="settings-section">
        <div class="section-header">
          <LayoutGrid :size="18" :stroke-width="2" aria-hidden="true" />
          <h2>菜单显示设置</h2>
        </div>
        <p class="menu-hint">选择要在导航栏中显示的功能项。隐藏不常用的菜单可以节省空间。</p>
        <div class="menu-grid">
          <div
            v-for="item in allMenuItems"
            :key="item.path"
            :class="['menu-card', { active: menuVisible[item.path], required: item.required }]"
            @click="toggleMenuVisible(item)"
          >
            <span v-if="item.required" class="required-badge">必选</span>
            <div class="menu-card-icon">
              <component :is="item.icon" :size="28" :stroke-width="1.5" aria-hidden="true" />
            </div>
            <span class="menu-card-label">{{ item.label }}</span>
          </div>
        </div>
        <p class="menu-hint-bottom">被选中的项目将显示在顶部导航栏中。</p>
      </section>

      <!-- GPU 加速设置 -->
      <section class="settings-section">
        <div class="section-header">
          <Cpu :size="18" :stroke-width="2" aria-hidden="true" />
          <h2>GPU 加速</h2>
        </div>

        <!-- GPU 状态信息 -->
        <div v-if="gpuInfo" class="gpu-status-card" :class="{ available: gpuInfo.cuda_available }">
          <div class="gpu-status-icon">
            <CheckCircle2
              v-if="gpuInfo.cuda_available"
              :size="20"
              :stroke-width="2"
              aria-hidden="true"
            />
            <CircleX v-else :size="20" :stroke-width="2" aria-hidden="true" />
          </div>
          <div class="gpu-status-info">
            <span v-if="gpuInfo.cuda_available" class="gpu-name">{{ gpuInfo.gpu_name }}</span>
            <span v-else class="gpu-name gpu-unavailable">CUDA 不可用</span>
            <span v-if="gpuInfo.cuda_available && gpuInfo.vram_total" class="gpu-vram">
              显存: {{ gpuInfo.vram_free != null ? gpuInfo.vram_free + ' / ' : ''
              }}{{ gpuInfo.vram_total }} GB
            </span>
            <span v-if="!gpuInfo.cuda_available" class="gpu-vram"
              >未检测到支持 CUDA 的 GPU，所有任务将使用 CPU</span
            >
          </div>
        </div>
        <div v-else-if="gpuLoading" class="gpu-status-card loading">
          <span class="gpu-loading-text">检测 GPU 中...</span>
        </div>

        <!-- GPU 开关 -->
        <div v-if="gpuInfo && gpuInfo.cuda_available" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">启用 GPU 加速</span>
            <span class="setting-desc"
              >开启后超分辨率、打标、裁剪、聚类等任务将使用 GPU 加速处理</span
            >
          </div>
          <span :class="['toggle-switch', { on: gpuEnabled }]" @click="toggleGpu">
            <span class="toggle-knob"></span>
          </span>
        </div>
      </section>

      <!-- 自动更新 -->
      <section class="settings-section">
        <div class="section-header">
          <RefreshCw :size="18" :stroke-width="2" aria-hidden="true" />
          <h2>自动更新</h2>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">启动时自动检测更新</span>
            <span class="setting-desc">开启后每次启动应用时自动检测是否有新版本</span>
          </div>
          <span :class="['toggle-switch', { on: autoCheckUpdate }]" @click="toggleAutoCheck">
            <span class="toggle-knob"></span>
          </span>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">手动检查更新</span>
            <span class="setting-desc">立即检查是否有可用的新版本</span>
          </div>
          <button
            class="check-btn"
            :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
            @click="manualCheckUpdate"
          >
            {{ updateStatus === 'checking' ? '检查中...' : '检查更新' }}
          </button>
        </div>
        <!-- 更新状态反馈 -->
        <div v-if="updateStatus" class="update-feedback">
          <div :class="['update-status-bar', updateStatus]">
            <span class="update-status-text">{{ updateStatusText }}</span>
            <div class="update-actions">
              <button
                v-if="updateStatus === 'available'"
                class="update-action-btn"
                @click="downloadUpdate"
              >
                下载更新
              </button>
              <button
                v-if="updateStatus === 'downloaded'"
                class="update-action-btn"
                @click="installUpdate"
              >
                安装并重启
              </button>
              <button
                v-if="updateStatus === 'not-available' || updateStatus === 'error'"
                class="update-dismiss-btn"
                @click="updateStatus = ''"
              >
                关闭
              </button>
            </div>
          </div>
          <div
            v-if="updateStatus === 'downloading' && updateInfo?.percent != null"
            class="update-progress-track"
          >
            <div class="update-progress-fill" :style="{ width: updateInfo.percent + '%' }"></div>
          </div>
        </div>
      </section>

      <!-- API 配置 -->
      <section class="settings-section">
        <div class="section-header">
          <Monitor :size="18" :stroke-width="2" aria-hidden="true" />
          <h2>
            API 配置 <span class="config-count">({{ apiConfigs.length }})</span>
          </h2>
          <button class="add-config-btn" @click="openAddForm">
            <Plus :size="14" :stroke-width="2.5" aria-hidden="true" />
            添加配置
          </button>
        </div>

        <!-- 添加/编辑表单 -->
        <div id="api-config-form-anchor-top" class="config-form-anchor"></div>
        <Teleport v-if="showForm" :to="formTeleportTarget" defer>
          <Transition name="form-fade" appear>
            <div class="config-form">
              <div class="form-title">
                {{ editingId ? '编辑 API 配置' : '添加 API 配置' }}
                <button class="form-close" @click="closeForm">
                  <X :size="14" :stroke-width="2" aria-hidden="true" />
                </button>
              </div>
              <div class="form-row two-col">
                <div class="form-field">
                  <label class="form-label">配置名称</label>
                  <input v-model="formName" class="form-input" type="text" placeholder="Deepseek" />
                </div>
                <div class="form-field">
                  <label class="form-label">MODEL NAME</label>
                  <div v-if="modelSelectOptions.length" class="model-combobox">
                    <button
                      class="model-combobox-trigger"
                      type="button"
                      @click.stop="modelDropOpen = !modelDropOpen"
                    >
                      <span>{{ selectedModelText }}</span>
                      <ChevronDown
                        :class="['model-combobox-arrow', { open: modelDropOpen }]"
                        :size="14"
                        :stroke-width="2.2"
                        aria-hidden="true"
                      />
                    </button>
                    <Transition name="model-menu">
                      <div v-if="modelDropOpen" class="model-combobox-menu" @click.stop>
                        <input
                          v-model="modelFilter"
                          class="model-combobox-search"
                          type="text"
                          placeholder="搜索模型"
                        />
                        <div class="model-combobox-list">
                          <button
                            v-for="model in filteredModelOptions"
                            :key="model.id"
                            :class="['model-combobox-item', { active: formModel === model.id }]"
                            type="button"
                            @click="selectFormModel(model.id)"
                          >
                            <span>{{ model.name || model.id }}</span>
                            <small v-if="model.name && model.name !== model.id">{{
                              model.id
                            }}</small>
                          </button>
                          <div
                            v-if="filteredModelOptions.length === 0"
                            class="model-combobox-empty"
                          >
                            没有匹配模型
                          </div>
                        </div>
                      </div>
                    </Transition>
                  </div>
                  <input
                    v-else
                    v-model="formModel"
                    class="form-input"
                    type="text"
                    placeholder="deepseek-reasoner"
                  />
                  <span v-if="modelLoading" class="model-fetch-hint">正在读取模型列表...</span>
                  <span v-else-if="modelError" class="model-fetch-hint error">
                    {{ modelError }}，可手动填写
                  </span>
                </div>
              </div>
              <div class="form-field">
                <label class="form-label">API ENDPOINT</label>
                <div class="form-input-icon">
                  <Globe2 :size="14" :stroke-width="2" aria-hidden="true" />
                  <input
                    v-model="formEndpoint"
                    class="form-input with-icon"
                    type="text"
                    placeholder="https://api.deepseek.com/v1"
                  />
                </div>
                <span v-if="previewUrl" class="endpoint-preview">预览：{{ previewUrl }}</span>
              </div>
              <div class="form-field">
                <label class="form-label">API KEY</label>
                <div class="form-input-icon right">
                  <input
                    v-model="formApiKey"
                    class="form-input with-icon-right"
                    :type="showApiKey ? 'text' : 'password'"
                    placeholder=""
                  />
                  <button class="eye-btn" @click="showApiKey = !showApiKey">
                    <Eye v-if="!showApiKey" :size="16" :stroke-width="2" aria-hidden="true" />
                    <EyeOff v-else :size="16" :stroke-width="2" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div class="form-actions">
                <button class="submit-btn" @click="submitForm">
                  <Copy :size="14" :stroke-width="2" aria-hidden="true" />
                  {{ editingId ? '保存修改' : '添加配置' }}
                </button>
              </div>
            </div>
          </Transition>
        </Teleport>

        <!-- 配置列表 -->
        <div v-if="apiConfigs.length === 0 && !showForm" class="empty-configs">
          <span>暂无 API 配置，点击上方按钮添加</span>
        </div>
        <TransitionGroup name="list-fade" tag="div" class="config-list">
          <div v-for="cfg in apiConfigs" :key="cfg.id" class="config-entry">
            <div :class="['config-item', { disabled: !cfg.enabled }]">
              <span :class="['config-toggle', { on: cfg.enabled }]" @click="toggleEnabled(cfg)">
                <span class="config-toggle-knob"></span>
              </span>
              <div class="config-info">
                <div class="config-name-row">
                  <span class="config-name">{{ cfg.name }}</span>
                  <span class="config-model-badge">{{ cfg.model }}</span>
                </div>
                <span class="config-endpoint">{{ cfg.endpoint || '(默认官方地址)' }}</span>
              </div>
              <div class="config-actions">
                <button class="config-action-btn" title="编辑" @click="openEditForm(cfg)">
                  <Pencil :size="15" :stroke-width="2" aria-hidden="true" />
                </button>
                <button class="config-action-btn delete" title="删除" @click="deleteConfig(cfg.id)">
                  <Trash2 :size="15" :stroke-width="2" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div :id="formAnchorId(cfg.id)" class="config-form-anchor"></div>
          </div>
        </TransitionGroup>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  padding: 0 0 14px;
}

.settings-content {
  width: 100%;
  max-width: 860px;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ===== Section ===== */
.settings-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 13px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--color-text);
}

.section-header h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
}

.config-count {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 12px;
}

.add-config-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.add-config-btn:hover {
  opacity: 0.85;
}

/* ===== Setting Row ===== */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--color-surface-hover);
}
.setting-row:last-child {
  border-bottom: none;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.setting-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
}
.setting-desc {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* ===== Toggle ===== */
.toggle-switch {
  position: relative;
  width: 32px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: var(--color-border-unchecked);
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-switch.on {
  background: var(--color-toggle-on);
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: none;
  transition: transform 0.2s;
}
.toggle-switch.on .toggle-knob {
  transform: translateX(16px);
}

/* ===== Check Button ===== */
.check-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.check-btn:hover:not(:disabled) {
  border-color: var(--color-text);
  background: var(--color-surface-soft);
}
.check-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== Update Feedback ===== */
.update-feedback {
  margin-top: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-surface-soft);
}
.update-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  gap: 12px;
}
.update-status-bar.checking {
  color: var(--color-text-secondary);
}
.update-status-bar.available {
  color: var(--color-info);
  background: var(--color-info-light);
  border-color: var(--color-border);
}
.update-status-bar.not-available {
  color: var(--color-success);
  background: var(--color-tag-has-bg);
  border-color: var(--color-tag-has-border);
}
.update-status-bar.downloading {
  color: var(--color-text-secondary);
}
.update-status-bar.downloaded {
  color: var(--color-info);
  background: var(--color-info-light);
  border-color: var(--color-border);
}
.update-status-bar.error {
  color: var(--color-error);
  background: var(--color-error-light);
  border-color: var(--color-error-border);
}
.update-status-text {
  font-size: 12px;
  font-weight: 500;
}
.update-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.update-action-btn {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
}
.update-action-btn:hover {
  opacity: 0.85;
}
.update-dismiss-btn {
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--color-border-unchecked);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.update-dismiss-btn:hover {
  border-color: var(--color-text-muted);
}
.update-progress-track {
  height: 3px;
  background: var(--color-border);
}
.update-progress-fill {
  height: 100%;
  background: var(--color-info);
  transition: width 0.3s ease;
}

/* ===== Config Form ===== */
.config-form {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 13px;
  margin-bottom: 12px;
  background: var(--color-surface-soft);
}

.form-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-close {
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
}
.form-close:hover {
  color: var(--color-text);
}

.form-row.two-col {
  display: flex;
  gap: 12px;
}
.form-row.two-col .form-field {
  flex: 1;
}

.form-field {
  margin-bottom: 12px;
}

.form-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 5px;
}

.form-input {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  background: var(--color-input-bg);
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.form-input:focus {
  border-color: var(--color-text);
}

.model-combobox {
  position: relative;
}
.model-combobox-trigger {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}
.model-combobox-trigger span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-combobox-trigger:hover,
.model-combobox-trigger:focus-visible {
  border-color: var(--color-border-hover);
  box-shadow: 0 0 0 2px var(--color-accent-light);
  outline: none;
}
.model-combobox-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.16s;
}
.model-combobox-arrow.open {
  transform: rotate(180deg);
}
.model-combobox-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 40;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  box-shadow: 0 10px 24px var(--color-shadow);
}
.model-combobox-search {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  margin-bottom: 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.model-combobox-search:focus {
  border-color: var(--color-accent-border);
}
.model-combobox-list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border-hover) transparent;
}
.model-combobox-list::-webkit-scrollbar {
  width: 7px;
}
.model-combobox-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--color-border-hover);
}
.model-combobox-item {
  width: 100%;
  min-height: 30px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.model-combobox-item:hover {
  background: var(--color-surface-hover);
}
.model-combobox-item.active {
  background: var(--color-accent-light);
  color: var(--color-accent-text);
}
.model-combobox-item span,
.model-combobox-item small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-combobox-item small {
  margin-top: 2px;
  color: var(--color-text-muted);
}
.model-combobox-empty {
  padding: 14px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
}
.model-menu-enter-active,
.model-menu-leave-active {
  transition:
    opacity 0.12s,
    transform 0.12s;
}
.model-menu-enter-from,
.model-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.model-fetch-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.model-fetch-hint.error {
  color: var(--color-warning);
}

.endpoint-preview {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  word-break: break-all;
  padding-left: 2px;
}

.form-input-icon {
  position: relative;
  display: flex;
  align-items: center;
}
.form-input-icon > svg {
  position: absolute;
  left: 10px;
  color: var(--color-text-muted);
  pointer-events: none;
  z-index: 1;
}
.form-input.with-icon {
  padding-left: 32px;
}
.form-input-icon.right > svg {
  display: none;
}
.form-input.with-icon-right {
  padding-right: 38px;
}
.eye-btn {
  position: absolute;
  right: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
}
.eye-btn:hover {
  color: var(--color-text-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.submit-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.submit-btn:hover {
  opacity: 0.85;
}

/* ===== Config List ===== */
.empty-configs {
  padding: 32px 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

.config-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.config-entry {
  margin-bottom: 6px;
}
.config-entry:last-child {
  margin-bottom: 0;
}
.config-entry .config-item {
  margin-bottom: 0;
}
.config-entry .config-form {
  margin-top: 6px;
  margin-bottom: 0;
}
.config-form-anchor {
  min-height: 0;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
  background: var(--color-surface);
  transition:
    border-color 0.15s,
    opacity 0.15s;
}
.config-item:last-child {
  margin-bottom: 0;
}
.config-item:hover {
  border-color: var(--color-border-unchecked);
}
.config-item.disabled {
  opacity: 0.5;
}

/* Toggle for config items */
.config-toggle {
  position: relative;
  width: 32px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: var(--color-border-unchecked);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;
}
.config-toggle.on {
  background: var(--color-toggle-on);
}
.config-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: none;
  transition: transform 0.2s;
}
.config-toggle.on .config-toggle-knob {
  transform: translateX(16px);
}

.config-info {
  flex: 1;
  min-width: 0;
}
.config-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}
.config-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}
.config-model-badge {
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-surface-hover);
  padding: 1px 8px;
  border-radius: var(--radius-sm);
  font-family: monospace;
}
.config-endpoint {
  font-size: 12px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.config-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}
.config-action-btn:hover {
  color: var(--color-text-secondary);
  background: var(--color-surface-hover);
}
.config-action-btn.delete:hover {
  color: var(--color-error);
  background: var(--color-error-light);
}

/* ===== Transitions ===== */
.form-fade-enter-active,
.form-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.form-fade-enter-from,
.form-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.list-fade-enter-active,
.list-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.list-fade-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.list-fade-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

/* ===== Menu Grid Dashboard ===== */
.menu-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0 0 10px;
}

.menu-hint-bottom {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 14px 0 0;
  padding-left: 2px;
}

.menu-hint-bottom::before {
  content: '●';
  margin-right: 6px;
  font-size: 8px;
  vertical-align: middle;
}

/* ===== GPU Status Card ===== */
.gpu-status-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  margin-bottom: 10px;
}

.gpu-status-card.available {
  border-color: var(--color-success-border);
  background: var(--color-success-light);
}

.gpu-status-card.loading {
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 14px;
}

.gpu-loading-text {
  font-size: 12px;
  color: var(--color-text-muted);
}

.gpu-status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.gpu-status-card.available .gpu-status-icon {
  background: var(--color-success-light);
  color: var(--color-success);
}

.gpu-status-card:not(.available) .gpu-status-icon {
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
}

.gpu-status-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gpu-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

.gpu-name.gpu-unavailable {
  color: var(--color-text-muted);
}

.gpu-vram {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.menu-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.menu-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 12px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s,
    color 0.2s;
  user-select: none;
}

.menu-card:hover {
  border-color: var(--color-tag-hover-border);
  background: var(--color-tag-hover-bg);
}

.menu-card.active {
  border-color: var(--color-info);
  background: var(--color-info-light);
  box-shadow: none;
}

.menu-card.required {
  cursor: default;
  opacity: 0.7;
}

.menu-card.required:hover {
  border-color: var(--color-border);
  background: var(--color-surface-soft);
}

.menu-card.required.active:hover {
  border-color: var(--color-info);
  background: var(--color-info-light);
}

.required-badge {
  position: absolute;
  top: 5px;
  right: 6px;
  font-size: 10px;
  color: var(--color-text-muted);
  background: var(--color-surface-hover);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
}

.menu-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--color-info);
  transition: color 0.2s;
}

.menu-card:not(.active) .menu-card-icon {
  background: transparent;
  color: var(--color-text-muted);
}

.menu-card-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
}

.menu-card:not(.active) .menu-card-label {
  color: var(--color-text-muted);
}

/* Settings layout polish */
.settings-page {
  padding: 2px 0 16px;
}

.settings-content {
  max-width: 920px;
  gap: 14px;
}

.settings-section {
  padding: 16px;
  background: var(--color-surface);
  border-color: var(--color-border);
  box-shadow: var(--shadow-xs);
}

.section-header h2 {
  font-size: 14px;
}

.setting-row {
  padding: 11px 0;
}

.toggle-switch,
.config-toggle {
  width: 34px;
  height: 18px;
  border-radius: 999px;
}

.toggle-knob,
.config-toggle-knob {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--color-toggle-knob);
}

.toggle-switch.on .toggle-knob,
.config-toggle.on .config-toggle-knob {
  transform: translateX(16px);
}

.menu-grid {
  gap: 10px;
}

.menu-card {
  padding: 14px 10px;
  background: var(--color-surface-soft);
}

.menu-card.active {
  background: var(--color-info-light);
  border-color: var(--color-accent-border);
  color: var(--color-active-bg);
  box-shadow: none;
}

.menu-card.active .menu-card-icon {
  background: transparent;
  color: var(--color-accent-text);
}

.add-config-btn,
.submit-btn,
.update-action-btn {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  box-shadow: var(--shadow-button);
}
</style>
