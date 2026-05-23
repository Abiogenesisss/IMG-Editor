<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Waypoints } from 'lucide-vue-next'
import { loadApiConfigs, saveApiConfigs } from '../services/apiConfigs'

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
const allMenuItems = [
  { path: '/grab', label: '图片抓取', icon: 'grab', required: false },
  { path: '/process', label: '图片处理', icon: 'process', required: false },
  { path: '/augment', label: '数据增强', icon: 'augment', required: false },
  { path: '/upscale', label: '超分辨率', icon: 'upscale', required: false },
  { path: '/tagger', label: '图片打标', icon: 'tagger', required: false },
  { path: '/caption', label: 'Caption', icon: 'caption', required: false },
  { path: '/buckets', label: '分桶分析', icon: 'buckets', required: false },
  { path: '/workflow', label: '工作流', icon: 'workflow', required: false },
  { path: '/tunnel', label: '隧道工具', icon: 'tunnel', required: false },
  { path: '/settings', label: '设置', icon: 'settings', required: true }
]

function loadMenuConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('menu-visible') || '{}')
    // 默认全部显示
    const result = {}
    allMenuItems.forEach((item) => {
      result[item.path] = item.required ? true : saved[item.path] !== false
    })
    return result
  } catch {
    const result = {}
    allMenuItems.forEach((item) => {
      result[item.path] = true
    })
    return result
  }
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
})

// 添加/编辑表单
const showForm = ref(false)
const editingId = ref(null)
const formName = ref('')
const formModel = ref('')
const formEndpoint = ref('')
const formApiKey = ref('')
const showApiKey = ref(false)

function resetForm() {
  editingId.value = null
  formName.value = ''
  formModel.value = ''
  formEndpoint.value = ''
  formApiKey.value = ''
  showApiKey.value = false
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
}

function closeForm() {
  showForm.value = false
  resetForm()
}

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
  if (model.includes('gemini')) {
    return endpoint
  }
  if (model.includes('claude')) {
    const base = endpoint.replace(/\/+$/, '')
    return base + '/v1/messages'
  }
  // OpenAI 兼容
  const base = endpoint.replace(/\/+$/, '')
  return base + '/chat/completions'
})
</script>

<template>
  <div class="settings-page">
    <div class="settings-content">
      <!-- 菜单显示设置 -->
      <section class="settings-section">
        <div class="section-header">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
          </svg>
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
              <!-- 图片抓取 -->
              <svg
                v-if="item.icon === 'grab'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              <!-- 图片处理 -->
              <svg
                v-else-if="item.icon === 'process'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
              <!-- 数据增强 -->
              <svg
                v-else-if="item.icon === 'augment'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
                <polyline points="17 6 23 6 23 12"></polyline>
              </svg>
              <!-- 超分辨率 -->
              <svg
                v-else-if="item.icon === 'upscale'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              <!-- 图片打标 -->
              <svg
                v-else-if="item.icon === 'tagger'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
                ></path>
                <line x1="7" y1="7" x2="7.01" y2="7"></line>
              </svg>
              <!-- Caption -->
              <svg
                v-else-if="item.icon === 'caption'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <!-- 分桶分析 -->
              <svg
                v-else-if="item.icon === 'buckets'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
              </svg>
              <!-- 工作流 -->
              <Waypoints
                v-else-if="item.icon === 'workflow'"
                :size="28"
                :stroke-width="1.5"
                aria-hidden="true"
              />
              <!-- 设置 -->
              <svg
                v-else-if="item.icon === 'tunnel'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 8h5"></path>
                <path d="M13 8h5"></path>
                <path d="M6 16h5"></path>
                <path d="M13 16h5"></path>
                <path d="M11 8a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2"></path>
                <path d="M13 8a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2"></path>
                <circle cx="5" cy="8" r="1"></circle>
                <circle cx="19" cy="8" r="1"></circle>
                <circle cx="5" cy="16" r="1"></circle>
                <circle cx="19" cy="16" r="1"></circle>
              </svg>
              <svg
                v-else-if="item.icon === 'settings'"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="3"></circle>
                <path
                  d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                ></path>
              </svg>
            </div>
            <span class="menu-card-label">{{ item.label }}</span>
          </div>
        </div>
        <p class="menu-hint-bottom">被选中的项目将显示在顶部导航栏中。</p>
      </section>

      <!-- GPU 加速设置 -->
      <section class="settings-section">
        <div class="section-header">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="6" width="20" height="12" rx="2"></rect>
            <path d="M6 12h.01"></path>
            <path d="M10 12h.01"></path>
            <path d="M14 12h.01"></path>
            <path d="M18 12h.01"></path>
            <line x1="6" y1="2" x2="6" y2="6"></line>
            <line x1="18" y1="2" x2="18" y2="6"></line>
          </svg>
          <h2>GPU 加速</h2>
        </div>

        <!-- GPU 状态信息 -->
        <div v-if="gpuInfo" class="gpu-status-card" :class="{ available: gpuInfo.cuda_available }">
          <div class="gpu-status-icon">
            <svg
              v-if="gpuInfo.cuda_available"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <svg
              v-else
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="15" y1="9" x2="9" y2="15"></line>
              <line x1="9" y1="9" x2="15" y2="15"></line>
            </svg>
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
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
            <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path>
          </svg>
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
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <h2>
            API 配置 <span class="config-count">({{ apiConfigs.length }})</span>
          </h2>
          <button class="add-config-btn" @click="openAddForm">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            >
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            添加配置
          </button>
        </div>

        <!-- 添加/编辑表单 -->
        <Transition name="form-fade">
          <div v-if="showForm" class="config-form">
            <div class="form-title">
              {{ editingId ? '编辑 API 配置' : '添加 API 配置' }}
              <button class="form-close" @click="closeForm">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="form-row two-col">
              <div class="form-field">
                <label class="form-label">配置名称</label>
                <input v-model="formName" class="form-input" type="text" placeholder="Deepseek" />
              </div>
              <div class="form-field">
                <label class="form-label">MODEL NAME</label>
                <input
                  v-model="formModel"
                  class="form-input"
                  type="text"
                  placeholder="deepseek-reasoner"
                />
              </div>
            </div>
            <div class="form-field">
              <label class="form-label">API ENDPOINT</label>
              <div class="form-input-icon">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path
                    d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
                  ></path>
                </svg>
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
                  <svg
                    v-if="!showApiKey"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                  <svg
                    v-else
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"
                    ></path>
                    <path
                      d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"
                    ></path>
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="form-actions">
              <button class="submit-btn" @click="submitForm">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                {{ editingId ? '保存修改' : '添加配置' }}
              </button>
            </div>
          </div>
        </Transition>

        <!-- 配置列表 -->
        <div v-if="apiConfigs.length === 0 && !showForm" class="empty-configs">
          <span>暂无 API 配置，点击上方按钮添加</span>
        </div>
        <TransitionGroup name="list-fade" tag="div" class="config-list">
          <div
            v-for="cfg in apiConfigs"
            :key="cfg.id"
            :class="['config-item', { disabled: !cfg.enabled }]"
          >
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
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button class="config-action-btn delete" title="删除" @click="deleteConfig(cfg.id)">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                  <path d="M10 11v6"></path>
                  <path d="M14 11v6"></path>
                </svg>
              </button>
            </div>
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
  padding: 8px 0 24px;
}

.settings-content {
  width: 100%;
  max-width: 720px;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ===== Section ===== */
.settings-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--color-text);
}

.section-header h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
}

.config-count {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 13px;
}

.add-config-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
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
  padding: 12px 0;
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
  font-size: 13px;
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
  width: 38px;
  height: 20px;
  border-radius: 10px;
  background: var(--color-border-unchecked);
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-switch.on {
  background: var(--color-active-bg);
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s;
}
.toggle-switch.on .toggle-knob {
  transform: translateX(18px);
}

/* ===== Check Button ===== */
.check-btn {
  padding: 6px 16px;
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
  padding: 10px 14px;
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
  padding: 5px 14px;
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
  padding: 4px 10px;
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
  padding: 16px;
  margin-bottom: 16px;
  background: var(--color-surface-soft);
}

.form-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 14px;
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
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--color-text);
  outline: none;
  background: var(--color-input-bg);
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.form-input:focus {
  border-color: var(--color-text);
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
  padding: 7px 18px;
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

.config-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
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
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--color-border-unchecked);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;
}
.config-toggle.on {
  background: #7c3aed;
}
.config-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
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
  font-size: 14px;
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
  width: 32px;
  height: 32px;
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
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0 0 16px;
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
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  margin-bottom: 12px;
}

.gpu-status-card.available {
  border-color: var(--color-tag-has-border);
  background: var(--color-tag-has-bg);
}

.gpu-status-card.loading {
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 13px;
  padding: 20px;
}

.gpu-loading-text {
  font-size: 13px;
  color: var(--color-text-muted);
}

.gpu-status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.gpu-status-card.available .gpu-status-icon {
  background: var(--color-tag-has-bg);
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
  font-size: 14px;
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
  gap: 12px;
}

.menu-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px 12px;
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s,
    box-shadow 0.2s;
  user-select: none;
}

.menu-card:hover {
  border-color: var(--color-tag-hover-border);
  background: var(--color-tag-hover-bg);
}

.menu-card.active {
  border-color: var(--color-info);
  background: var(--color-info-light);
  box-shadow: 0 0 0 1px var(--color-info);
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
  top: 6px;
  right: 8px;
  font-size: 10px;
  color: var(--color-text-muted);
  background: var(--color-surface-hover);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  line-height: 1.4;
}

.menu-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  background: var(--color-primary-light);
  color: var(--color-info);
  transition:
    background 0.2s,
    color 0.2s;
}

.menu-card:not(.active) .menu-card-icon {
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
}

.menu-card-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}

.menu-card:not(.active) .menu-card-label {
  color: var(--color-text-muted);
}

/* ===== Dark Mode Enhancements ===== */
[data-theme='dark'] .settings-section {
  border-color: rgba(63, 63, 70, 0.6);
  background: rgba(39, 39, 42, 0.65);
  backdrop-filter: blur(8px);
}

/* 表单输入框 - 暗色模式增强可见性 */
[data-theme='dark'] .form-input {
  background: rgba(24, 24, 27, 0.8);
  border-color: #52525b;
}
[data-theme='dark'] .form-input:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.15);
}
[data-theme='dark'] .form-input::placeholder {
  color: #52525b;
}

/* 开关旋钮 - 暗色模式提高对比度 */
[data-theme='dark'] .toggle-knob,
[data-theme='dark'] .config-toggle-knob {
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}
[data-theme='dark'] .toggle-switch:not(.on),
[data-theme='dark'] .config-toggle:not(.on) {
  background: #3f3f46;
}
[data-theme='dark'] .toggle-switch.on {
  background: #818cf8;
}
[data-theme='dark'] .config-toggle.on {
  background: #8b5cf6;
}

/* 菜单卡片 - 暗色模式下激活态更醒目 */
[data-theme='dark'] .menu-card {
  background: rgba(30, 30, 34, 0.6);
  border-color: #3f3f46;
}
[data-theme='dark'] .menu-card:hover {
  background: rgba(49, 46, 89, 0.4);
  border-color: #6366f1;
}
[data-theme='dark'] .menu-card.active {
  background: rgba(99, 102, 241, 0.12);
  border-color: #818cf8;
  box-shadow:
    0 0 0 1px rgba(129, 140, 248, 0.3),
    0 0 12px rgba(99, 102, 241, 0.08);
}
[data-theme='dark'] .menu-card.active .menu-card-icon {
  background: rgba(99, 102, 241, 0.2);
  color: #a5b4fc;
}
[data-theme='dark'] .menu-card:not(.active) .menu-card-icon {
  background: rgba(63, 63, 70, 0.5);
  color: #71717a;
}
[data-theme='dark'] .menu-card.required:hover {
  background: rgba(30, 30, 34, 0.6);
  border-color: #3f3f46;
}
[data-theme='dark'] .menu-card.required.active:hover {
  background: rgba(99, 102, 241, 0.12);
  border-color: #818cf8;
}

/* 配置项卡片 - 暗色模式优化 */
[data-theme='dark'] .config-item {
  background: rgba(30, 30, 34, 0.5);
  border-color: rgba(63, 63, 70, 0.6);
}
[data-theme='dark'] .config-item:hover {
  border-color: #52525b;
  background: rgba(39, 39, 42, 0.7);
}
[data-theme='dark'] .config-model-badge {
  background: rgba(63, 63, 70, 0.5);
  color: #a1a1aa;
}

/* 表单容器 */
[data-theme='dark'] .config-form {
  background: rgba(24, 24, 27, 0.6);
  border-color: #52525b;
}

/* 检查更新按钮 */
[data-theme='dark'] .check-btn {
  border-color: #52525b;
  background: rgba(30, 30, 34, 0.6);
}
[data-theme='dark'] .check-btn:hover:not(:disabled) {
  border-color: #818cf8;
  background: rgba(49, 46, 89, 0.3);
  color: #e4e4e7;
}

/* 更新状态栏 - 暗色模式颜色优化 */
[data-theme='dark'] .update-status-bar.available,
[data-theme='dark'] .update-status-bar.downloaded {
  background: rgba(96, 165, 250, 0.1);
  color: #93c5fd;
}
[data-theme='dark'] .update-status-bar.not-available {
  background: rgba(74, 222, 128, 0.08);
  color: #86efac;
}
[data-theme='dark'] .update-status-bar.error {
  background: rgba(252, 165, 165, 0.1);
  color: #fca5a5;
}
[data-theme='dark'] .update-feedback {
  background: rgba(24, 24, 27, 0.5);
  border-color: rgba(63, 63, 70, 0.6);
}

/* 必选徽章 */
[data-theme='dark'] .required-badge {
  background: rgba(63, 63, 70, 0.6);
  color: #71717a;
}

/* 设置行分隔线 */
[data-theme='dark'] .setting-row {
  border-bottom-color: rgba(63, 63, 70, 0.4);
}

/* GPU 状态卡片 - 暗色模式 */
[data-theme='dark'] .gpu-status-card {
  background: rgba(24, 24, 27, 0.5);
  border-color: rgba(63, 63, 70, 0.6);
}
[data-theme='dark'] .gpu-status-card.available {
  background: rgba(74, 222, 128, 0.06);
  border-color: rgba(74, 222, 128, 0.2);
}
[data-theme='dark'] .gpu-status-card.available .gpu-status-icon {
  background: rgba(74, 222, 128, 0.1);
  color: #86efac;
}

/* 操作按钮 hover */
[data-theme='dark'] .config-action-btn:hover {
  background: rgba(63, 63, 70, 0.5);
  color: #d4d4d8;
}
[data-theme='dark'] .config-action-btn.delete:hover {
  background: rgba(252, 165, 165, 0.1);
  color: #fca5a5;
}
</style>
