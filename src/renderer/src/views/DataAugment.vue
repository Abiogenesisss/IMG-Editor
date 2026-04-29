<script setup>
import { ref, onMounted, watch } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'
import FolderRow from '../components/FolderRow.vue'
import ImageStatusBar from '../components/ImageStatusBar.vue'

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

const gridRef = ref(null)
onMounted(() => { if (gridRef.value) observeGrid(gridRef.value) })
watch(() => images.value, () => { if (gridRef.value) observeGrid(gridRef.value) }, { flush: 'post' })

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
    const result = await window.api.callPython('/preview-augment', {
      file: file, aug_type: augType, params
    })
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

function clearAugmentFolder() {
  activePanel.value = null
  augPreviewData.value = null
  augPreviewLoading.value = false
  clearCurrentFolder()
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
    window.api.callPython('/mirror-flip', {
      files: [...selectedImages.value], output_dir: outDir
    })
  )
}

// --- 三阶段裁剪 ---
const personConf = ref(0.3)
const halfbodyConf = ref(0.3)
const headConf = ref(0.3)

function runThreeStageSplit() {
  runTask('split', (outDir) =>
    window.api.callPython('/three-stage-split', {
      files: [...selectedImages.value], output_dir: outDir,
      person_conf: personConf.value, halfbody_conf: halfbodyConf.value, head_conf: headConf.value
    })
  )
}

// --- Cutout ---
const cutoutCount = ref(2)
const cutoutSize = ref(0.15)

function runCutout() {
  runTask('cutout', (outDir) =>
    window.api.callPython('/cutout', {
      files: [...selectedImages.value], output_dir: outDir,
      count: cutoutCount.value, size_ratio: cutoutSize.value
    })
  )
}

function previewCutout() {
  doPreview('cutout', { count: cutoutCount.value, size_ratio: cutoutSize.value })
}

// --- 透视变换 ---
const perspIntensity = ref(0.1)

function runPerspective() {
  runTask('perspective', (outDir) =>
    window.api.callPython('/perspective', {
      files: [...selectedImages.value], output_dir: outDir,
      intensity: perspIntensity.value
    })
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
    window.api.callPython('/gaussian-blur-noise', {
      files: [...selectedImages.value], output_dir: outDir,
      blur_radius: blurRadius.value, noise_sigma: noiseSigma.value
    })
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
        <FolderRow
          v-model="inputFolder"
          label="输入"
          placeholder="输入路径后按回车加载文件夹内的图片，或点击 ... 选择文件夹"
          @commit="path => path && loadInputFolder(path)"
          @browse="chooseInputFolder"
        />
        <FolderRow
          v-model="outputFolder"
          label="输出"
          :placeholder="inputFolder ? '同级自动创建输出目录' : '输入文件夹路径...'"
          @commit="path => { outputFolder = path }"
          @browse="chooseOutputFolder"
        />
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
    <ImageStatusBar
      :image-count="imageCount"
      :selected-count="selectedCount"
      :select-all="selectAll"
      :refreshing="refreshing"
      :processing-action="processingAction"
      :progress-done="progressDone"
      :progress-total="progressTotal"
      processing-label="增强"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshImages"
      @clear-folder="clearAugmentFolder"
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--ui-panel-run-width);
  height: var(--ui-panel-run-height);
  padding: 0 10px;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius-sm);
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
