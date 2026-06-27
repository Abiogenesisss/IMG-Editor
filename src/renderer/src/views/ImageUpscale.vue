<script setup>
import { ref, computed, watch } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'
import { useGridObserver } from '../composables/useGridObserver'
import FolderRow from '../components/FolderRow.vue'
import IconButton from '../components/IconButton.vue'
import ImageStatusBar from '../components/ImageStatusBar.vue'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-vue-next'

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
  clearCurrentFolder,
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

const gridRef = useGridObserver(images, observeGrid)

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
  { value: 'waifu2x', label: 'Waifu2x' }
]

const model = ref('real-cugan')

// --- Waifu2x 风格 & TTA ---
const w2xStyleOptions = [
  { value: 'art', label: 'Art' },
  { value: 'art_scan', label: 'Art Scan' },
  { value: 'photo', label: 'Photo' }
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
  waifu2x: {
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
  const valid = denoiseOptions.value.map((o) => o.value)
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
  const opt = denoiseOptions.value.find((o) => o.value === denoise.value)
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
    const result = await window.api.callPython('/preview-upscale', {
      file: file,
      scale: scale.value,
      denoise: denoise.value,
      model: model.value,
      style: w2xStyle.value,
      tta: tta.value
    })
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

function clearUpscaleFolder() {
  activePanel.value = null
  denoiseDropOpen.value = false
  upscalePreviewData.value = null
  upscalePreviewLoading.value = false
  sliderPos.value = 50
  clearCurrentFolder()
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
    const files =
      selectedCount.value > 0 ? [...selectedImages.value] : images.value.map((i) => i.path)
    const result = await window.api.callPython('/upscale', {
      files: files,
      output_dir: outDir,
      scale: scale.value,
      denoise: denoise.value,
      model: model.value || 'real-cugan',
      style: w2xStyle.value || 'art',
      tta: tta.value || false
    })
    if (result.aborted) return
  } finally {
    if (processingAction.value === 'upscale') processingAction.value = null
  }
}

const canRun = computed(() => imageCount.value > 0 && !processingAction.value)
const canPreview = computed(
  () => selectedCount.value > 0 && !upscalePreviewLoading.value && !processingAction.value
)
</script>

<template>
  <div class="process-page">
    <!-- 面板背景遮罩 -->
    <div v-if="activePanel" class="panel-backdrop" @click="closePanel"></div>

    <!-- 顶部：文件夹选择 + 操作按钮 -->
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
          :placeholder="inputFolder ? '同级自动创建输出目录' : '输入文件夹路径...'"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
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
          <div
            v-if="activePanel === 'params'"
            class="action-panel upscale-panel"
            @click="denoiseDropOpen = false"
          >
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
                <ChevronDown
                  class="custom-select-arrow"
                  :class="{ open: denoiseDropOpen }"
                  :size="12"
                  :stroke-width="2.5"
                  aria-hidden="true"
                />
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
                  <label :class="['format-tag', { selected: !tta }]" @click="tta = false">
                    关闭
                  </label>
                  <label :class="['format-tag', { selected: tta }]" @click="tta = true">
                    开启
                  </label>
                </div>
              </div>
            </template>
          </div>
        </div>
        <!-- 预览按钮 -->
        <button class="action-btn" :disabled="!canPreview" @click="doUpscalePreview">
          {{ upscalePreviewLoading ? '处理中...' : '预览' }}
        </button>
        <!-- 执行按钮 -->
        <button class="action-btn upscale-run-btn" :disabled="!canRun" @click="runUpscale">
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
    <ImageStatusBar
      :image-count="imageCount"
      :selected-count="selectedCount"
      :select-all="selectAll"
      :refreshing="refreshing"
      :processing-action="processingAction"
      :progress-done="progressDone"
      :progress-total="progressTotal"
      processing-label="超分"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshImages"
      @clear-folder="clearUpscaleFolder"
      @delete-selected="deleteSelected"
      @abort="abortTask"
    />

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
        <div
          v-if="upscalePreviewData"
          class="preview-overlay upscale-preview-overlay"
          @click.self="closeUpscalePreview"
        >
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
                <ChevronLeft :size="16" :stroke-width="2.5" aria-hidden="true" />
                <ChevronRight :size="16" :stroke-width="2.5" aria-hidden="true" />
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
          <IconButton
            :icon="X"
            variant="preview-close-btn"
            title="关闭"
            :size="20"
            @click="closeUpscalePreview"
          />
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
  color: var(--color-text-muted);
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
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  background: var(--color-input-bg);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s;
}

.custom-select:hover {
  border-color: var(--color-border-hover);
}

.custom-select-value {
  flex: 1;
}

.custom-select-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
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
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  z-index: var(--z-dropdown);
  overflow: hidden;
}

.custom-select-item {
  padding: 6px 9px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s;
}

.custom-select-item:hover {
  background: var(--color-surface-hover);
}

.custom-select-item.active {
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

/* 下拉框动画 */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
  transform-origin: top center;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scaleY(0.9);
}

/* 执行按钮强调色 */
.upscale-run-btn {
  background: var(--color-active-bg);
  color: var(--color-active-text);
  border-color: var(--color-active-bg);
  transition:
    background 0.15s,
    opacity 0.15s;
}

.upscale-run-btn:hover:not(:disabled) {
  background: var(--color-text-secondary);
  border-color: var(--color-text-secondary);
}

.upscale-run-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ===== 预览模式栏（工具栏下方独立行） ===== */
.preview-mode-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 7px 0 9px;
  box-sizing: border-box;
  border-bottom: none;
  flex-shrink: 0;
}

.preview-mode-label {
  font-size: 12px;
  line-height: 16px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.preview-mode-tag {
  padding: 3px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 16px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  transition:
    color 0.12s,
    background 0.12s,
    border-color 0.12s;
  background: var(--color-surface);
}

.preview-mode-tag:hover {
  border-color: var(--color-border-hover);
}

.preview-mode-tag.active {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-active-text);
}

/* ===== 预览遮罩内浮动模式切换 ===== */
.preview-mode-float {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  background: var(--color-overlay-soft);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  z-index: 10;
}

.preview-mode-float .preview-mode-tag {
  background: transparent;
  border-color: var(--color-overlay-text-muted);
  color: var(--color-overlay-text-muted);
}

.preview-mode-float .preview-mode-tag:hover {
  border-color: var(--color-overlay-text);
  color: var(--color-overlay-text);
}

.preview-mode-float .preview-mode-tag.active {
  background: var(--color-overlay-text);
  border-color: var(--color-overlay-text);
  color: var(--color-stage-bg);
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
  border-radius: var(--radius-sm);
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
  background: var(--color-overlay-text);
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
  box-shadow: none;
}

.slider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: var(--color-overlay-soft);
  border: 2px solid var(--color-overlay-text);
  color: var(--color-overlay-text);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.compare-label {
  position: absolute;
  bottom: 10px;
  padding: 3px 10px;
  background: var(--color-overlay-soft);
  color: var(--color-overlay-text);
  font-size: 12px;
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
  border: none;
  background: var(--color-overlay-soft);
  color: var(--color-overlay-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  z-index: 10;
}

.preview-close-btn:hover {
  background: var(--color-overlay-strong);
}

.custom-select {
  height: 32px;
  background: var(--color-input-bg);
}

.upscale-run-btn,
.preview-mode-tag.active {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-button);
}

.upscale-run-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}
</style>
