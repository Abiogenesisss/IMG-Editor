<script setup>
import { ref, computed, onMounted } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'
import { useGridObserver } from '../composables/useGridObserver'
import FolderRow from '../components/FolderRow.vue'
import ImageStatusBar from '../components/ImageStatusBar.vue'

defineOptions({ name: 'ImageAesthetic' })

const CLASS_LABELS = {
  '3d': '3D',
  bangumi: '番剧',
  comic: '漫画',
  illustration: '插画',
  not_painting: '非绘画'
}

const AESTHETIC_LABELS = {
  masterpiece: '神作',
  best: '极佳',
  great: '优秀',
  good: '良好',
  normal: '普通',
  low: '低质',
  worst: '极低'
}

const DEFAULT_ALLOWED_CLASSES = ['3d', 'bangumi', 'comic', 'illustration']

const downloadingKey = ref('')
const downloadInfo = ref('')
const aestheticError = ref('')
const models = ref([])
const selectedClassifier = ref('')
const selectedAesthetic = ref('')
const allowedClasses = ref(new Set(DEFAULT_ALLOWED_CLASSES))
const classThreshold = ref(0.0)
const minScore = ref(5.0)
const scoreOnlyPassed = ref(true)
const resultMap = ref(new Map())

const {
  inputFolder,
  images,
  selectedImages,
  selectAll,
  thumbnails,
  imageCount,
  selectedCount,
  getTargetFiles,
  chooseInputFolder,
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
  refreshing,
  refreshImages,
  abortTask,
  observeGrid
} = useImageBrowser({
  onProgress({ step, total_steps, file: fileName, downloaded, total }) {
    if (!downloadingKey.value || step === undefined) return
    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0
    downloadInfo.value = `(${step}/${total_steps}) ${fileName} ${pct}%`
  }
})

const gridRef = useGridObserver(images, observeGrid)

const classifierModels = computed(() => models.value.filter((model) => model.kind === 'classifier'))
const aestheticModels = computed(() => models.value.filter((model) => model.kind === 'aesthetic'))
const currentClassifier = computed(() =>
  models.value.find((model) => model.key === selectedClassifier.value)
)
const currentAesthetic = computed(() =>
  models.value.find((model) => model.key === selectedAesthetic.value)
)
const modelsReady = computed(
  () => currentClassifier.value?.downloaded && currentAesthetic.value?.downloaded
)
const classLabels = computed(() => currentClassifier.value?.labels || Object.keys(CLASS_LABELS))
const analysisActive = computed(() => resultMap.value.size > 0)

const processingLabel = computed(() => {
  if (processingAction.value === 'deepghs') return '分类评分中'
  if (processingAction.value === 'moveLow') return '移入 del 中'
  return '处理中'
})

const lowScoreCandidates = computed(() => {
  const existingPaths = new Set(images.value.map((img) => img.path))
  return [...resultMap.value.values()].filter(
    (result) =>
      existingPaths.has(result.file) &&
      result.ok &&
      result.class_passed &&
      result.aesthetic_score !== null &&
      result.aesthetic_score < minScore.value
  )
})

const summary = computed(() => {
  const results = [...resultMap.value.values()].filter((result) => result.ok)
  const scored = results.filter((result) => result.aesthetic_score !== null)
  const passed = results.filter((result) => result.class_passed)
  const rejected = results.length - passed.length
  const avg =
    scored.length > 0
      ? scored.reduce((sum, result) => sum + Number(result.aesthetic_score || 0), 0) / scored.length
      : 0
  return {
    total: results.length,
    scored: scored.length,
    rejected,
    low: lowScoreCandidates.value.length,
    avg
  }
})

const sortedImages = computed(() => {
  if (!analysisActive.value) return images.value

  const arr = [...images.value]
  arr.sort((a, b) => {
    const ra = resultMap.value.get(a.path)
    const rb = resultMap.value.get(b.path)
    const rank = (result) => {
      if (!result) return 4
      if (!result.ok) return 3
      if (
        result.class_passed &&
        result.aesthetic_score !== null &&
        result.aesthetic_score < minScore.value
      ) {
        return 0
      }
      if (!result.class_passed) return 1
      return 2
    }
    const diff = rank(ra) - rank(rb)
    if (diff !== 0) return diff
    return Number(ra?.aesthetic_score ?? 99) - Number(rb?.aesthetic_score ?? 99)
  })
  return arr
})

function displayClass(label) {
  return CLASS_LABELS[label] || label || '-'
}

function displayAesthetic(label) {
  return AESTHETIC_LABELS[label] || label || '-'
}

function formatPercent(value) {
  if (value === null || value === undefined) return '0%'
  return `${Math.round(Number(value) * 100)}%`
}

function getResult(img) {
  return resultMap.value.get(img.path)
}

function toggleAllowedClass(label) {
  const next = new Set(allowedClasses.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  allowedClasses.value = next
}

function isAllowed(label) {
  return allowedClasses.value.has(label)
}

function clearAnalysis() {
  resultMap.value = new Map()
  aestheticError.value = ''
}

async function loadModels() {
  const keepClassifier = selectedClassifier.value
  const keepAesthetic = selectedAesthetic.value
  const result = await window.api.callPython('/deepghs-models', {})
  if (!result.success) {
    aestheticError.value = result.error || '模型列表加载失败'
    return
  }
  models.value = result.models || []

  const classifiers = classifierModels.value
  const aesthetics = aestheticModels.value
  selectedClassifier.value =
    classifiers.find((model) => model.key === keepClassifier)?.key ||
    classifiers.find((model) => model.downloaded)?.key ||
    classifiers[0]?.key ||
    ''
  selectedAesthetic.value =
    aesthetics.find((model) => model.key === keepAesthetic)?.key ||
    aesthetics.find((model) => model.downloaded)?.key ||
    aesthetics[0]?.key ||
    ''
}

async function downloadModel(modelKey) {
  if (!modelKey || downloadingKey.value || processingAction.value) return
  downloadingKey.value = modelKey
  downloadInfo.value = '准备下载...'
  aestheticError.value = ''
  try {
    const result = await window.api.callPython('/deepghs-download', { model_key: modelKey })
    if (result.success) {
      await loadModels()
      downloadInfo.value = ''
    } else {
      downloadInfo.value = ''
      aestheticError.value = result.error || '模型下载失败'
    }
  } catch (err) {
    downloadInfo.value = ''
    aestheticError.value = err.message || '模型下载失败'
  } finally {
    downloadingKey.value = ''
  }
}

async function runAnalyze() {
  const files = getTargetFiles()
  if (files.length === 0 || !modelsReady.value) return
  aestheticError.value = ''
  processingAction.value = 'deepghs'
  try {
    const result = await window.api.callPython('/deepghs-analyze', {
      files,
      classifier_model_key: selectedClassifier.value,
      aesthetic_model_key: selectedAesthetic.value,
      allowed_classes: [...allowedClasses.value],
      class_threshold: classThreshold.value,
      min_score: minScore.value,
      score_only_passed: scoreOnlyPassed.value
    })
    if (result.aborted) return
    if (!result.success) {
      aestheticError.value = result.error || '分类评分失败'
      return
    }
    resultMap.value = new Map((result.results || []).map((item) => [item.file, item]))
  } catch (err) {
    aestheticError.value = err.message || '分类评分请求失败'
  } finally {
    if (processingAction.value === 'deepghs') processingAction.value = null
    window.api.callPython('/cleanup-caches', {}).catch(() => {})
  }
}

async function moveLowScoreToDel() {
  const targets = lowScoreCandidates.value
  if (targets.length === 0) return
  const confirmed = window.confirm(
    `将 ${targets.length} 张低于 ${minScore.value.toFixed(1)} 分的图片移入同目录 del 文件夹。\n文件不会永久删除，是否继续？`
  )
  if (!confirmed) return

  const paths = targets.map((item) => item.file)
  processingAction.value = 'moveLow'
  aestheticError.value = ''
  try {
    const results = await Promise.all(paths.map((path) => window.api.deleteImage(path)))
    const movedPaths = new Set()
    results.forEach((result, index) => {
      if (result?.success) movedPaths.add(paths[index])
    })

    if (movedPaths.size > 0) {
      images.value = images.value.filter((img) => !movedPaths.has(img.path))
      selectedImages.value = new Set(
        [...selectedImages.value].filter((path) => !movedPaths.has(path))
      )
      selectAll.value = selectedImages.value.size === images.value.length && images.value.length > 0
      for (const path of movedPaths) {
        delete thumbnails[path]
      }
      const nextMap = new Map(resultMap.value)
      for (const path of movedPaths) nextMap.delete(path)
      resultMap.value = nextMap
    }

    const failed = paths.length - movedPaths.size
    if (failed > 0) {
      aestheticError.value = `已移入 del ${movedPaths.size} 张，失败 ${failed} 张`
    }
  } catch (err) {
    aestheticError.value = err.message || '移动低分图片失败'
  } finally {
    if (processingAction.value === 'moveLow') processingAction.value = null
  }
}

async function loadFolder(path) {
  clearAnalysis()
  if (path) await loadInputFolder(path)
}

async function chooseFolder() {
  clearAnalysis()
  await chooseInputFolder()
}

async function refreshAndClear() {
  clearAnalysis()
  await refreshImages()
}

function clearFolder() {
  clearAnalysis()
  downloadInfo.value = ''
  clearCurrentFolder()
}

onMounted(() => {
  loadModels()
})
</script>

<template>
  <div class="process-page aesthetic-page">
    <div class="process-toolbar aesthetic-toolbar">
      <div class="folder-section">
        <FolderRow
          v-model="inputFolder"
          label="输入"
          placeholder="输入路径后按回车加载图片文件夹，或点击 ... 选择文件夹"
          @commit="loadFolder"
          @browse="chooseFolder"
        />
      </div>

      <div class="action-section aesthetic-actions">
        <select v-model="selectedClassifier" class="model-select" :disabled="!!processingAction">
          <option v-for="model in classifierModels" :key="model.key" :value="model.key">
            {{ model.name }}{{ model.downloaded ? '' : ' (未下载)' }}
          </option>
        </select>
        <button
          v-if="currentClassifier && !currentClassifier.downloaded"
          class="action-btn download-model-btn"
          :disabled="!!downloadingKey || !!processingAction"
          @click="downloadModel(selectedClassifier)"
        >
          {{ downloadingKey === selectedClassifier ? '下载中' : '下载分类' }}
        </button>

        <select v-model="selectedAesthetic" class="model-select" :disabled="!!processingAction">
          <option v-for="model in aestheticModels" :key="model.key" :value="model.key">
            {{ model.name }}{{ model.downloaded ? '' : ' (未下载)' }}
          </option>
        </select>
        <button
          v-if="currentAesthetic && !currentAesthetic.downloaded"
          class="action-btn download-model-btn"
          :disabled="!!downloadingKey || !!processingAction"
          @click="downloadModel(selectedAesthetic)"
        >
          {{ downloadingKey === selectedAesthetic ? '下载中' : '下载评分' }}
        </button>

        <button
          class="action-btn analyze-btn"
          :disabled="imageCount === 0 || !!processingAction || !!downloadingKey || !modelsReady"
          @click="runAnalyze"
        >
          分类评分
        </button>
      </div>
    </div>

    <div class="aesthetic-control-bar">
      <div class="class-filter">
        <span class="control-label">类别</span>
        <button
          v-for="label in classLabels"
          :key="label"
          :class="['class-chip', { active: isAllowed(label) }]"
          :disabled="!!processingAction"
          @click="toggleAllowedClass(label)"
        >
          {{ displayClass(label) }}
        </button>
      </div>

      <label class="range-control">
        <span class="control-label">分类置信</span>
        <input
          v-model.number="classThreshold"
          type="range"
          min="0"
          max="0.95"
          step="0.05"
          :disabled="!!processingAction"
        />
        <span class="range-value">{{ formatPercent(classThreshold) }}</span>
      </label>

      <label class="range-control">
        <span class="control-label">低分阈值</span>
        <input
          v-model.number="minScore"
          type="range"
          min="0"
          max="10"
          step="0.1"
          :disabled="!!processingAction"
        />
        <span class="range-value">{{ minScore.toFixed(1) }}</span>
      </label>

      <label class="toggle-control" @click="scoreOnlyPassed = !scoreOnlyPassed">
        <span :class="['toggle-switch', { on: scoreOnlyPassed }]">
          <span class="toggle-knob"></span>
        </span>
        <span>只评分通过分类</span>
      </label>

      <span v-if="downloadInfo" class="download-info">{{ downloadInfo }}</span>
    </div>

    <div v-if="aestheticError" class="error-bar">
      <span>{{ aestheticError }}</span>
      <button class="error-bar-close" @click="aestheticError = ''">关闭</button>
    </div>

    <ImageStatusBar
      :image-count="imageCount"
      :selected-count="selectedCount"
      :select-all="selectAll"
      :refreshing="refreshing"
      :processing-action="processingAction"
      :progress-done="progressDone"
      :progress-total="progressTotal"
      :processing-label="processingLabel"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshAndClear"
      @clear-folder="clearFolder"
      @delete-selected="deleteSelected"
      @abort="abortTask"
    >
      <template #idle>
        <span v-if="analysisActive">
          已评 {{ summary.scored }} 张，低分 {{ summary.low }} 张，分类过滤
          {{ summary.rejected }} 张，均分
          {{ summary.avg.toFixed(2) }}
        </span>
        <span v-else>共 {{ imageCount }} 张，已选 {{ selectedCount }} 张</span>
      </template>
      <template #tail>
        <button
          v-if="lowScoreCandidates.length > 0"
          class="action-btn low-move-btn"
          :disabled="!!processingAction"
          @click="moveLowScoreToDel"
        >
          低分入 del
        </button>
      </template>
    </ImageStatusBar>

    <div v-if="imageCount > 0" ref="gridRef" class="image-grid aesthetic-grid">
      <div
        v-for="img in sortedImages"
        :key="img.path"
        :data-path="img.path"
        :class="[
          'image-card',
          'aesthetic-card',
          {
            selected: isSelected(img),
            'low-score-card':
              getResult(img)?.ok &&
              getResult(img)?.aesthetic_score !== null &&
              getResult(img)?.aesthetic_score < minScore,
            'class-rejected-card': getResult(img)?.ok && getResult(img)?.class_passed === false,
            'error-card': getResult(img)?.ok === false
          }
        ]"
        @click="openPreview(img)"
      >
        <img
          v-if="thumbnails[img.path]"
          :src="thumbnails[img.path]"
          :alt="img.name"
          draggable="false"
        />
        <div v-else class="image-placeholder"></div>

        <template v-if="getResult(img)">
          <span
            v-if="getResult(img)?.ok && getResult(img)?.aesthetic_score !== null"
            :class="['score-badge', { low: getResult(img)?.aesthetic_score < minScore }]"
          >
            {{ Number(getResult(img).aesthetic_score).toFixed(2) }}
          </span>
          <span v-else-if="getResult(img)?.ok === false" class="score-badge error">失败</span>

          <span
            v-if="getResult(img)?.ok"
            :class="['class-badge', { rejected: getResult(img)?.class_passed === false }]"
          >
            {{ displayClass(getResult(img).class_label) }}
          </span>

          <span
            v-if="getResult(img)?.ok && getResult(img)?.aesthetic_label"
            class="aesthetic-label-badge"
          >
            {{ displayAesthetic(getResult(img).aesthetic_label) }}
          </span>
        </template>

        <div class="image-name-overlay">{{ img.name }}</div>
        <span
          :class="['checkbox', { checked: isSelected(img) }]"
          @click.stop="toggleSelect(img)"
        ></span>
      </div>
    </div>

    <div v-else class="empty-state">
      <span class="empty-text">选择输入文件夹以加载图片</span>
    </div>

    <Teleport to="body">
      <Transition name="preview-fade">
        <div v-if="previewImage" class="preview-overlay" @click="closePreview">
          <img :src="previewImage.url" :alt="previewImage.name" class="preview-img" />
          <div class="preview-filename">{{ previewImage.name }}</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.aesthetic-toolbar {
  align-items: center;
}

.aesthetic-actions {
  flex-wrap: nowrap;
  justify-content: flex-end;
  max-width: none;
  min-width: 0;
}

.model-select {
  height: 34px;
  width: 260px;
  min-width: 0;
  flex: 0 0 260px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
}

.model-select:focus {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.download-model-btn,
.analyze-btn,
.low-move-btn {
  width: auto;
  min-width: 82px;
  flex: 0 0 auto;
}

.aesthetic-control-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: var(--shadow-xs);
  padding: 9px 11px;
  flex-shrink: 0;
}

.class-filter,
.range-control,
.toggle-control {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.control-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.class-chip {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.class-chip:hover:not(:disabled) {
  border-color: var(--color-accent-border);
}

.class-chip.active {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-active-text);
  box-shadow: var(--shadow-button);
}

.class-chip:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.range-control input[type='range'] {
  width: 116px;
  height: 4px;
  accent-color: var(--color-active-bg);
}

.toggle-control {
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.download-info {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.aesthetic-card.low-score-card {
  box-shadow:
    inset 0 0 0 2px var(--color-error-border),
    var(--shadow-xs);
}

.aesthetic-card.class-rejected-card {
  opacity: 0.78;
}

.aesthetic-card.error-card {
  box-shadow:
    inset 0 0 0 2px var(--color-warning-border),
    var(--shadow-xs);
}

.score-badge,
.class-badge,
.aesthetic-label-badge {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  color: var(--color-on-accent);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

.score-badge {
  left: 6px;
  top: 6px;
  min-width: 42px;
  background: var(--color-accent);
}

.score-badge.low {
  background: var(--color-error);
}

.score-badge.error {
  background: var(--color-warning);
}

.class-badge {
  right: 25px;
  top: 6px;
  max-width: calc(100% - 78px);
  background: var(--color-overlay-soft);
}

.class-badge.rejected {
  background: var(--color-text-muted);
}

.aesthetic-label-badge {
  left: 6px;
  bottom: 6px;
  background: var(--color-success);
}

@media (max-width: 1280px) {
  .aesthetic-actions {
    flex-wrap: wrap;
  }

  .model-select {
    width: 220px;
    flex-basis: 220px;
  }
}
</style>
