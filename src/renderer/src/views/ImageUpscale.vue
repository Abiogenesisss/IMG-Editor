<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'

defineOptions({ name: 'ImageUpscale' })

const {
  inputFolder,
  outputFolder,
  images,
  selectedImages,
  selectAll,
  thumbnails,
  imageCount,
  selectedCount,
  chooseInputFolder,
  chooseOutputFolder,
  loadInputFolder,
  toggleSelect,
  toggleSelectAll,
  isSelected,
  previewImage,
  openPreview,
  closePreview,
  deleteSelected,
  processingAction,
  progressDone,
  progressTotal,
  getOutputDir,
  refreshing,
  refreshImages,
  abortTask,
  observeGrid
} = useImageBrowser()

const gridRef = ref(null)
onMounted(() => { if (gridRef.value) observeGrid(gridRef.value) })
watch(imageCount, () => { if (gridRef.value) observeGrid(gridRef.value) }, { flush: 'post' })

// --- 面板控制 ---
const activePanel = ref(null)
const denoiseDropOpen = ref(false)

function togglePanel(name) {
  activePanel.value = activePanel.value === name ? null : name
  denoiseDropOpen.value = false
}

function closePanel() {
  activePanel.value = null
  denoiseDropOpen.value = false
}

// --- 模型定义 ---
const modelOptions = [
  { value: 'real-cugan', label: 'Real-CUGAN' },
  { value: 'real-esrgan', label: 'Real-ESRGAN' },
  { value: 'waifu2x', label: 'Waifu2x' },
]

const model = ref('real-cugan')

// --- Waifu2x 风格 & TTA ---
const w2xStyleOptions = [
  { value: 'art', label: 'Art' },
  { value: 'art_scan', label: 'Art Scan' },
  { value: 'photo', label: 'Photo' },
]
const w2xStyle = ref('art')
const tta = ref(false)

// --- 各模型参数配置 ---
const modelConfigs = {
  'real-cugan': {
    scales: [
      { value: 2, label: '2X' },
      { value: 3, label: '3X' },
      { value: 4, label: '4X' }
    ],
    getDenoiseOptions(scale) {
      if (scale === 2) {
        return [
          { value: 'no-denoise', label: '无降噪' },
          { value: 'denoise1x', label: '降噪1X' },
          { value: 'denoise2x', label: '降噪2X' },
          { value: 'denoise3x', label: '降噪3X' }
        ]
      }
      return [{ value: 'denoise3x', label: '降噪3X' }]
    },
    defaultScale: 2,
    defaultDenoise: 'denoise3x'
  },
  'real-esrgan': {
    scales: [
      { value: 2, label: '2X' },
      { value: 4, label: '4X' }
    ],
    getDenoiseOptions() {
      return [{ value: 'none', label: '默认' }]
    },
    defaultScale: 4,
    defaultDenoise: 'none'
  },
  'waifu2x': {
    scales: [
      { value: 1, label: '1X' },
      { value: 2, label: '2X' },
      { value: 4, label: '4X' }
    ],
    getDenoiseOptions() {
      return [
        { value: 'no-denoise', label: '(-) None' },
        { value: 'denoise0', label: '(0) Low' },
        { value: 'denoise1', label: '(1) Medium' },
        { value: 'denoise2', label: '(2) High' },
        { value: 'denoise3', label: '(3) Highest' }
      ]
    },
    defaultScale: 2,
    defaultDenoise: 'denoise2'
  }
}

// --- 超分参数 ---
const scale = ref(2)
const denoise = ref('denoise3x')
const previewMode = ref('slider') // slider | side | stack

const currentConfig = computed(() => modelConfigs[model.value])

const scaleOptions = computed(() => currentConfig.value?.scales || [])

const denoiseOptions = computed(() => {
  const config = currentConfig.value
  if (!config) return []
  return config.getDenoiseOptions(scale.value)
})

// 切换模型时，重置参数
watch(model, (val) => {
  const config = modelConfigs[val]
  if (config) {
    scale.value = config.defaultScale
    denoise.value = config.defaultDenoise
  }
  if (val !== 'waifu2x') {
    tta.value = false
  }
})

// 切换倍率时，自动修正降噪选项
watch(scale, () => {
  const valid = denoiseOptions.value.map(o => o.value)
  if (!valid.includes(denoise.value)) {
    const config = currentConfig.value
    denoise.value = config?.defaultDenoise || valid[0] || 'none'
  }
})

const previewModes = [
  { value: 'slider', label: '叠图' },
  { value: 'side', label: '并排' },
  { value: 'stack', label: '并列' }
]

const denoiseLabel = computed(() => {
  const opt = denoiseOptions.value.find(o => o.value === denoise.value)
  return opt ? opt.label : ''
})

function selectDenoise(val) {
  denoise.value = val
  denoiseDropOpen.value = false
}

// --- 超分预览 ---
const upscalePreviewLoading = ref(false)
const upscalePreviewData = ref(null)
const sliderPos = ref(50)

async function doUpscalePreview() {
  const file = selectedImages.value.values().next().value
  if (!file) return
  upscalePreviewLoading.value = true
  try {
    const result = await window.api.previewUpscale(
      file, scale.value, denoise.value, model.value,
      w2xStyle.value, tta.value
    )
    if (result.ok) {
      upscalePreviewData.value = result
      sliderPos.value = 50
    }
  } finally {
    upscalePreviewLoading.value = false
  }
}

function closeUpscalePreview() {
  upscalePreviewData.value = null
}

// --- 叠图模式拖拽 ---
let isDragging = false
const sliderContainerRef = ref(null)

function onSliderDown(e) {
  isDragging = true
  updateSliderPos(e)
  e.preventDefault()
}

function onSliderMove(e) {
  if (!isDragging) return
  updateSliderPos(e)
}

function onSliderUp() {
  isDragging = false
}

function updateSliderPos(e) {
  const container = sliderContainerRef.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  const clientX = e.touches ? e.touches[0].clientX : e.clientX
  const x = clientX - rect.left
  const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
  sliderPos.value = pct
}

// --- 批量超分执行 ---
async function runUpscale() {
  activePanel.value = null
  const outDir = await getOutputDir()
  processingAction.value = 'upscale'
  try {
    const files = selectedCount.value > 0 ? [...selectedImages.value] : images.value.map(i => i.path)
    const result = await window.api.upscale(
      files, outDir, scale.value, denoise.value, model.value,
      w2xStyle.value, tta.value
    )
    if (result.aborted) return
  } finally {
    if (processingAction.value === 'upscale') processingAction.value = null
  }
}

const canRun = computed(() => imageCount.value > 0 && !processingAction.value)
const canPreview = computed(() => selectedCount.value > 0 && !upscalePreviewLoading.value && !processingAction.value)
</script>

<template>
  <div class="process-page">
    <!-- 面板背景遮罩 -->
    <div v-if="activePanel" class="panel-backdrop" @click="closePanel"></div>

    <!-- 顶部：文件夹选择 + 操作按钮 -->
    <div class="process-toolbar">
      <div class="folder-section">
        <div class="folder-row">
          <span class="folder-label">输入</span>
          <input
            class="folder-input"
            :value="inputFolder"
            placeholder="输入路径后按回车加载文件夹内的图片，或点击 ... 选择文件夹"
            @change="e => e.target.value.trim() && loadInputFolder(e.target.value.trim())"
          />
          <button class="folder-browse-btn" @click="chooseInputFolder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></button>
        </div>
        <div class="folder-row">
          <span class="folder-label">输出</span>
          <input
            class="folder-input"
            :value="outputFolder"
            :placeholder="inputFolder ? '同级自动创建输出目录' : '输入文件夹路径...'"
            @change="e => outputFolder = e.target.value.trim()"
          />
          <button class="folder-browse-btn" @click="chooseOutputFolder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></button>
        </div>
      </div>
      <div class="action-section">
        <!-- 参数设置 -->
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'params' }]"
            @click="togglePanel('params')"
          >
            参数设置
          </button>
          <div v-if="activePanel === 'params'" class="action-panel upscale-panel" @click="denoiseDropOpen = false">
            <!-- 模型选择 -->
            <div class="panel-section">
              <span class="panel-label">超分模型</span>
              <div class="panel-row format-options">
                <label
                  v-for="opt in modelOptions"
                  :key="opt.value"
                  :class="['format-tag', { selected: model === opt.value }]"
                  @click="model = opt.value"
                >
                  {{ opt.label }}
                </label>
              </div>
            </div>
            <!-- 超分倍率 -->
            <div class="panel-section">
              <span class="panel-label">超分倍率</span>
              <div class="panel-row format-options">
                <label
                  v-for="opt in scaleOptions"
                  :key="opt.value"
                  :class="['format-tag', { selected: scale === opt.value }]"
                  @click="scale = opt.value"
                >
                  {{ opt.label }}
                </label>
              </div>
            </div>
            <!-- 降噪配置 -->
            <div class="panel-section">
              <span class="panel-label">降噪配置</span>
              <div class="custom-select" @click.stop="denoiseDropOpen = !denoiseDropOpen">
                <span class="custom-select-value">{{ denoiseLabel }}</span>
                <svg class="custom-select-arrow" :class="{ open: denoiseDropOpen }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                <Transition name="dropdown">
                  <div v-if="denoiseDropOpen" class="custom-select-list">
                    <div
                      v-for="opt in denoiseOptions"
                      :key="opt.value"
                      :class="['custom-select-item', { active: denoise === opt.value }]"
                      @click.stop="selectDenoise(opt.value)"
                    >
                      {{ opt.label }}
                    </div>
                  </div>
                </Transition>
              </div>
            </div>
            <!-- Waifu2x 风格 (仅 waifu2x 模型显示) -->
            <template v-if="model === 'waifu2x'">
              <div class="panel-section">
                <span class="panel-label">风格</span>
                <div class="panel-row format-options">
                  <label
                    v-for="opt in w2xStyleOptions"
                    :key="opt.value"
                    :class="['format-tag', { selected: w2xStyle === opt.value }]"
                    @click="w2xStyle = opt.value"
                  >
                    {{ opt.label }}
                  </label>
                </div>
              </div>
              <div class="panel-section">
                <span class="panel-label">TTA 增强</span>
                <div class="panel-row format-options">
                  <label
                    :class="['format-tag', { selected: !tta }]"
                    @click="tta = false"
                  >
                    关闭
                  </label>
                  <label
                    :class="['format-tag', { selected: tta }]"
                    @click="tta = true"
                  >
                    开启
                  </label>
                </div>
              </div>
            </template>
          </div>
        </div>
        <!-- 预览按钮 -->
        <button
          class="action-btn"
          :disabled="!canPreview"
          @click="doUpscalePreview"
        >
          {{ upscalePreviewLoading ? '处理中...' : '预览' }}
        </button>
        <!-- 执行按钮 -->
        <button
          class="action-btn upscale-run-btn"
          :disabled="!canRun"
          @click="runUpscale"
        >
          {{ processingAction === 'upscale' ? '处理中...' : '执行超分' }}
        </button>
      </div>
    </div>

    <!-- 预览模式栏 -->
    <div class="preview-mode-bar">
      <span class="preview-mode-label">预览模式</span>
      <label
        v-for="opt in previewModes"
        :key="opt.value"
        :class="['preview-mode-tag', { active: previewMode === opt.value }]"
        @click="previewMode = opt.value"
      >
        {{ opt.label }}
      </label>
    </div>

    <!-- 状态栏 -->
    <div v-if="imageCount > 0" class="status-bar">
      <label class="select-all-label" @click="toggleSelectAll">
        <span :class="['checkbox', { checked: selectAll }]"></span>
        全选
      </label>
      <div class="bar-btn-group">
        <button :class="['bar-icon-btn', { spinning: refreshing }]" title="刷新" @click="refreshImages">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
            <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path>
          </svg>
        </button>
        <button class="bar-icon-btn delete" title="删除选中图片" :disabled="selectedCount === 0" @click="deleteSelected">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
          </svg>
        </button>
      </div>
      <span v-if="processingAction && progressTotal > 0" class="status-progress">
        <span class="progress-bar-track">
          <span class="progress-bar-fill" :style="{ width: (progressDone / progressTotal * 100) + '%' }"></span>
        </span>
        <span class="progress-text">{{ progressDone }} / {{ progressTotal }}</span>
        <button class="abort-btn" title="终止任务" @click="abortTask">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </span>
      <span v-else class="status-text">共 {{ imageCount }} 张，已选 {{ selectedCount }} 张</span>
    </div>

    <!-- 图片网格 -->
    <div v-if="imageCount > 0" ref="gridRef" class="image-grid">
      <div
        v-for="img in images"
        :key="img.path"
        :data-path="img.path"
        :class="['image-card', { selected: isSelected(img) }]"
        @click="openPreview(img)"
      >
        <img
          v-if="thumbnails[img.path]"
          :src="thumbnails[img.path]"
          :alt="img.name"
          draggable="false"
        />
        <div v-else class="image-placeholder"></div>
        <div class="image-name-overlay">{{ img.name }}</div>
        <span
          :class="['checkbox', { checked: isSelected(img) }]"
          @click.stop="toggleSelect(img)"
        ></span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <span class="empty-text">选择输入文件夹以加载图片</span>
    </div>

    <!-- 原图预览遮罩 -->
    <Teleport to="body">
      <Transition name="preview-fade">
        <div v-if="previewImage" class="preview-overlay" @click="closePreview">
          <img :src="previewImage.url" :alt="previewImage.name" class="preview-img" />
          <div class="preview-filename">{{ previewImage.name }}</div>
        </div>
      </Transition>
    </Teleport>

    <!-- 超分预览遮罩 -->
    <Teleport to="body">
      <Transition name="preview-fade">
        <div v-if="upscalePreviewData" class="preview-overlay upscale-preview-overlay" @click.self="closeUpscalePreview">

          <!-- 叠图模式 (Slider) -->
          <div
            v-if="previewMode === 'slider'"
            ref="sliderContainerRef"
            class="compare-slider"
            @mousedown="onSliderDown"
            @mousemove="onSliderMove"
            @mouseup="onSliderUp"
            @mouseleave="onSliderUp"
            @touchstart="onSliderDown"
            @touchmove="onSliderMove"
            @touchend="onSliderUp"
          >
            <img :src="upscalePreviewData.upscaled" class="compare-img" draggable="false" />
            <img
              :src="upscalePreviewData.original"
              class="compare-img compare-original"
              :style="{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }"
              draggable="false"
            />
            <div class="slider-line" :style="{ left: sliderPos + '%' }">
              <div class="slider-handle">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </div>
            </div>
            <span class="compare-label label-left">原图</span>
            <span class="compare-label label-right">超分</span>
          </div>

          <!-- 并排模式 (Side by side) -->
          <div v-else-if="previewMode === 'side'" class="compare-side">
            <div class="compare-side-item">
              <img :src="upscalePreviewData.original" class="compare-img" draggable="false" />
              <span class="compare-label">原图</span>
            </div>
            <div class="compare-side-item">
              <img :src="upscalePreviewData.upscaled" class="compare-img" draggable="false" />
              <span class="compare-label">超分</span>
            </div>
          </div>

          <!-- 并列模式 (Top-bottom) -->
          <div v-else class="compare-stack">
            <div class="compare-stack-item">
              <img :src="upscalePreviewData.original" class="compare-img" draggable="false" />
              <span class="compare-label">原图</span>
            </div>
            <div class="compare-stack-item">
              <img :src="upscalePreviewData.upscaled" class="compare-img" draggable="false" />
              <span class="compare-label">超分</span>
            </div>
          </div>

          <!-- 预览模式切换 -->
          <div class="preview-mode-float">
            <label
              v-for="opt in previewModes"
              :key="opt.value"
              :class="['preview-mode-tag', { active: previewMode === opt.value }]"
              @click="previewMode = opt.value"
            >
              {{ opt.label }}
            </label>
          </div>

          <!-- 关闭按钮 -->
          <button class="preview-close-btn" @click="closeUpscalePreview">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <div class="preview-filename">点击空白区域关闭</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 参数面板 */
.upscale-panel {
  min-width: 320px;
}

.upscale-panel .format-tag {
  flex: 1 1 0;
  text-align: center;
  min-width: 0;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-label {
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
}

/* 选项允许换行 */
.panel-section .format-options {
  flex-wrap: wrap;
}

/* 自定义下拉框 */
.custom-select {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 2px;
  font-size: 12px;
  color: #1b1b1f;
  background: #fff;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s;
}

.custom-select:hover {
  border-color: #b0b0b0;
}

.custom-select-value {
  flex: 1;
}

.custom-select-arrow {
  flex-shrink: 0;
  color: #9ca3af;
  transition: transform 0.2s;
}

.custom-select-arrow.open {
  transform: rotate(180deg);
}

.custom-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 20;
  overflow: hidden;
}

.custom-select-item {
  padding: 6px 10px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.custom-select-item:hover {
  background: #f3f4f6;
}

.custom-select-item.active {
  background: #1b1b1f;
  color: #fff;
}

/* 下拉框动画 */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s, transform 0.15s;
  transform-origin: top center;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scaleY(0.9);
}

/* 执行按钮强调色 */
.upscale-run-btn {
  background: #1b1b1f;
  color: #fff;
  border-color: #1b1b1f;
  transition: background 0.15s, opacity 0.15s;
}

.upscale-run-btn:hover:not(:disabled) {
  background: #333;
}

.upscale-run-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ===== 预览模式栏（工具栏下方独立行） ===== */
.preview-mode-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.preview-mode-label {
  font-size: 12px;
  color: #6b7280;
  white-space: nowrap;
}

.preview-mode-tag {
  padding: 4px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 2px;
  font-size: 12px;
  color: #6b7280;
  cursor: pointer;
  user-select: none;
  transition: color 0.12s, background 0.12s, border-color 0.12s;
  background: #fff;
}

.preview-mode-tag:hover {
  border-color: #b0b0b0;
}

.preview-mode-tag.active {
  background: #1b1b1f;
  border-color: #1b1b1f;
  color: #fff;
}

/* ===== 预览遮罩内浮动模式切换 ===== */
.preview-mode-float {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  background: rgba(0, 0, 0, 0.6);
  padding: 4px 8px;
  border-radius: 6px;
  z-index: 10;
}

.preview-mode-float .preview-mode-tag {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.7);
}

.preview-mode-float .preview-mode-tag:hover {
  border-color: rgba(255, 255, 255, 0.6);
  color: #fff;
}

.preview-mode-float .preview-mode-tag.active {
  background: #fff;
  border-color: #fff;
  color: #1b1b1f;
}

/* ============================
   超分预览遮罩
   ============================ */
.upscale-preview-overlay {
  cursor: default;
  flex-direction: column;
  gap: 12px;
}

/* --- 叠图模式 (Slider) --- */
.compare-slider {
  position: relative;
  max-width: 85vw;
  max-height: 80vh;
  cursor: ew-resize;
  user-select: none;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}

.compare-slider .compare-img {
  display: block;
  max-width: 85vw;
  max-height: 80vh;
  object-fit: contain;
}

.compare-original {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.slider-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
}

.slider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  border: 2px solid #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.compare-label {
  position: absolute;
  bottom: 10px;
  padding: 3px 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  border-radius: 3px;
  pointer-events: none;
  z-index: 3;
}

.label-left {
  left: 10px;
}

.label-right {
  right: 10px;
}

/* --- 并排模式 (Side by side) --- */
.compare-side {
  display: flex;
  gap: 16px;
  max-width: 90vw;
  max-height: 80vh;
  align-items: center;
}

.compare-side-item {
  position: relative;
  flex: 1;
  min-width: 0;
}

.compare-side-item .compare-img {
  display: block;
  max-width: 44vw;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 4px;
}

.compare-side-item .compare-label {
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
}

/* --- 并列模式 (Top-bottom) --- */
.compare-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 85vw;
  max-height: 85vh;
  align-items: center;
  overflow: auto;
}

.compare-stack-item {
  position: relative;
  flex-shrink: 0;
}

.compare-stack-item .compare-img {
  display: block;
  max-width: 85vw;
  max-height: 40vh;
  object-fit: contain;
  border-radius: 4px;
}

.compare-stack-item .compare-label {
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
}

/* 关闭按钮 */
.preview-close-btn {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  z-index: 10;
}

.preview-close-btn:hover {
  background: rgba(0, 0, 0, 0.75);
}
</style>
