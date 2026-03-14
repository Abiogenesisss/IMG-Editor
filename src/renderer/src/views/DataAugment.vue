<script setup>
import { ref, onMounted, watch } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'

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

const activePanel = ref(null)

function togglePanel(name) {
  activePanel.value = activePanel.value === name ? null : name
}

function closePanel() {
  activePanel.value = null
}

// --- 增强预览 ---
const augPreviewData = ref(null)   // base64 图片数据
const augPreviewLoading = ref(false)

async function doPreview(augType, params) {
  const file = selectedImages.value.values().next().value
  if (!file) return
  augPreviewLoading.value = true
  try {
    const result = await window.api.previewAugment(file, augType, params)
    if (result.ok) {
      augPreviewData.value = result.data
    }
  } finally {
    augPreviewLoading.value = false
  }
}

function closeAugPreview() {
  augPreviewData.value = null
}

// --- 通用任务执行器 ---
async function runTask(actionName, apiFn) {
  activePanel.value = null
  const outDir = await getOutputDir()
  processingAction.value = actionName
  try {
    const result = await apiFn(outDir)
    if (result.aborted) return
  } finally {
    if (processingAction.value === actionName) processingAction.value = null
  }
}

// --- 镜像翻转 ---
function mirrorFlip() {
  runTask('mirrorFlip', (outDir) =>
    window.api.mirrorFlip([...selectedImages.value], outDir)
  )
}

// --- 三阶段裁剪 ---
const personConf = ref(0.3)
const halfbodyConf = ref(0.3)
const headConf = ref(0.3)

function runThreeStageSplit() {
  runTask('split', (outDir) =>
    window.api.threeStageSplit(
      [...selectedImages.value], outDir,
      personConf.value, halfbodyConf.value, headConf.value
    )
  )
}

// --- Cutout ---
const cutoutCount = ref(2)
const cutoutSize = ref(0.15)

function runCutout() {
  runTask('cutout', (outDir) =>
    window.api.cutout(
      [...selectedImages.value], outDir,
      cutoutCount.value, cutoutSize.value
    )
  )
}

function previewCutout() {
  doPreview('cutout', { count: cutoutCount.value, size_ratio: cutoutSize.value })
}

// --- 透视变换 ---
const perspIntensity = ref(0.1)

function runPerspective() {
  runTask('perspective', (outDir) =>
    window.api.perspective(
      [...selectedImages.value], outDir,
      perspIntensity.value
    )
  )
}

function previewPerspective() {
  doPreview('perspective', { intensity: perspIntensity.value })
}

// --- 高斯模糊 + 噪声 ---
const blurRadius = ref(2.0)
const noiseSigma = ref(15.0)

function runGaussianBlurNoise() {
  runTask('blurnoise', (outDir) =>
    window.api.gaussianBlurNoise(
      [...selectedImages.value], outDir,
      blurRadius.value, noiseSigma.value
    )
  )
}

function previewBlurNoise() {
  doPreview('blurnoise', { blur_radius: blurRadius.value, noise_sigma: noiseSigma.value })
}


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
        <div class="action-item">
          <button
            class="action-btn"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="mirrorFlip"
          >
            镜像翻转
          </button>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'split' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('split')"
          >
            三分法裁剪
          </button>
          <div v-if="activePanel === 'split'" class="action-panel">
            <div style="font-size: 12px; color: #4b5563; font-weight: 500; margin-bottom: 2px;">阈值</div>
            <div class="panel-row">
              <label>全身</label>
              <input type="range" v-model.number="personConf" min="0.1" max="0.9" step="0.05" />
              <span class="range-value">{{ personConf.toFixed(2) }}</span>
            </div>
            <div class="panel-row">
              <label>半身</label>
              <input type="range" v-model.number="halfbodyConf" min="0.1" max="0.9" step="0.05" />
              <span class="range-value">{{ halfbodyConf.toFixed(2) }}</span>
            </div>
            <div class="panel-row">
              <label>头像</label>
              <input type="range" v-model.number="headConf" min="0.1" max="0.9" step="0.05" />
              <span class="range-value">{{ headConf.toFixed(2) }}</span>
            </div>
            <button class="panel-run" @click="runThreeStageSplit">执行</button>
          </div>
        </div>

        <!-- Cutout -->
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'cutout' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('cutout')"
          >
            Cutout
          </button>
          <div v-if="activePanel === 'cutout'" class="action-panel">
            <div class="panel-row">
              <label>数量</label>
              <input type="range" v-model.number="cutoutCount" min="1" max="10" step="1" />
              <span class="range-value">{{ cutoutCount }}</span>
            </div>
            <div class="panel-row">
              <label>遮挡比例</label>
              <input type="range" v-model.number="cutoutSize" min="0.05" max="0.4" step="0.01" />
              <span class="range-value">{{ cutoutSize.toFixed(2) }}</span>
            </div>
            <div class="panel-actions">
              <button class="panel-preview" :disabled="selectedCount === 0 || augPreviewLoading" @click="previewCutout">预览</button>
              <button class="panel-run" @click="runCutout">执行</button>
            </div>
          </div>
        </div>

        <!-- 透视变换 -->
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'perspective' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('perspective')"
          >
            透视变换
          </button>
          <div v-if="activePanel === 'perspective'" class="action-panel">
            <div class="panel-row">
              <label>强度</label>
              <input type="range" v-model.number="perspIntensity" min="0.02" max="0.3" step="0.01" />
              <span class="range-value">{{ perspIntensity.toFixed(2) }}</span>
            </div>
            <div class="panel-actions">
              <button class="panel-preview" :disabled="selectedCount === 0 || augPreviewLoading" @click="previewPerspective">预览</button>
              <button class="panel-run" @click="runPerspective">执行</button>
            </div>
          </div>
        </div>

        <!-- 高斯模糊 + 噪声 -->
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'blurnoise' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('blurnoise')"
          >
            模糊/噪声
          </button>
          <div v-if="activePanel === 'blurnoise'" class="action-panel">
            <div class="panel-row">
              <label>模糊半径</label>
              <input type="range" v-model.number="blurRadius" min="0" max="10" step="0.5" />
              <span class="range-value">{{ blurRadius.toFixed(1) }}</span>
            </div>
            <div class="panel-row">
              <label>噪声强度</label>
              <input type="range" v-model.number="noiseSigma" min="0" max="50" step="1" />
              <span class="range-value">{{ noiseSigma.toFixed(0) }}</span>
            </div>
            <div class="panel-actions">
              <button class="panel-preview" :disabled="selectedCount === 0 || augPreviewLoading" @click="previewBlurNoise">预览</button>
              <button class="panel-run" @click="runGaussianBlurNoise">执行</button>
            </div>
          </div>
        </div>
      </div>
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

    <!-- 增强预览遮罩 -->
    <Teleport to="body">
      <Transition name="preview-fade">
        <div v-if="augPreviewData" class="preview-overlay" @click="closeAugPreview">
          <img :src="augPreviewData" class="preview-img" />
          <div class="preview-filename">增强预览（点击关闭）</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.panel-preview {
  padding: 5px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 2px;
  background: #fff;
  color: #1b1b1f;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s, border-color 0.15s;
}

.panel-preview:hover:not(:disabled) {
  background: #f3f4f6;
  border-color: #b0b0b0;
}

.panel-preview:disabled {
  color: #c0c0c0;
  border-color: #eee;
  cursor: not-allowed;
}
</style>
