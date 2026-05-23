<script setup>
import { ref, computed } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'
import { useGridObserver } from '../composables/useGridObserver'
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
  getTargetFiles,
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
const processError = ref('')

const ACTION_LABELS = {
  filter: '分辨率过滤',
  convert: '格式转换',
  alpha: '透明通道转换',
  crop: '比例裁剪',
  dedup: '去重',
  cluster: '聚类',
  clusterMove: '整理聚类结果'
}

const processingLabel = computed(() => {
  if (!processingAction.value) return ''
  return ACTION_LABELS[processingAction.value] || '处理中'
})

function togglePanel(name) {
  activePanel.value = activePanel.value === name ? null : name
}

function closePanel() {
  activePanel.value = null
}

function setProcessError(error, actionName) {
  if (!error) return
  if (typeof error === 'string') {
    processError.value = error
    return
  }
  processError.value = error.error || error.message || `${ACTION_LABELS[actionName] || '处理'}失败`
}

// --- 通用任务执行器（需要输出目录的任务） ---
async function runOutputTask(actionName, apiFn) {
  activePanel.value = null
  processError.value = ''
  const outDir = await getOutputDir()
  processingAction.value = actionName
  try {
    const result = await apiFn(outDir)
    if (result.aborted) return
    if (!result.success) {
      setProcessError(result, actionName)
      return
    }
    if (outDir === inputFolder.value) {
      await refreshImages()
    }
  } catch (err) {
    setProcessError(err, actionName)
  } finally {
    if (processingAction.value === actionName) processingAction.value = null
  }
}

// --- 分辨率过滤 ---
const filterMode = ref('both') // 'width' | 'height' | 'both'
const filterMinWidth = ref(512)
const filterMinHeight = ref(512)
const filterMap = ref(new Map()) // file path → { filtered, width, height }
const filterActive = ref(false)

async function runResolutionFilter() {
  activePanel.value = null
  processError.value = ''
  clearDedup()
  clearCluster()
  const files = getTargetFiles()
  if (files.length === 0) return

  const minW = filterMode.value === 'height' ? 0 : filterMinWidth.value
  const minH = filterMode.value === 'width' ? 0 : filterMinHeight.value

  processingAction.value = 'filter'
  try {
    const result = await window.api.callPython('/resolution-filter', {
      files: files,
      min_width: minW,
      max_width: 0,
      min_height: minH,
      max_height: 0
    })
    if (result.aborted) return
    if (result.success) {
      const map = new Map()
      for (const item of result.results) {
        if (item.ok && item.filtered) {
          map.set(item.file, { width: item.width, height: item.height })
        }
      }
      filterMap.value = map
      filterActive.value = true
    } else {
      setProcessError(result, 'filter')
    }
  } catch (err) {
    setProcessError(err, 'filter')
  } finally {
    if (processingAction.value === 'filter') processingAction.value = null
  }
}

function clearFilter() {
  filterMap.value = new Map()
  filterActive.value = false
}

// --- 格式转换 ---
const targetFormat = ref('png')

function runFormatConvert() {
  runOutputTask('convert', (outDir) =>
    window.api.callPython('/format-convert', {
      files: [...selectedImages.value],
      output_dir: outDir,
      target_format: targetFormat.value
    })
  )
}

// --- 透明通道转换 ---
const alphaBackground = ref('white')

function runAlphaFlatten() {
  runOutputTask('alpha', (outDir) =>
    window.api.callPython('/flatten-alpha', {
      files: getTargetFiles(),
      output_dir: outDir,
      background: alphaBackground.value
    })
  )
}

// --- 按比例裁剪 ---
const cropRatioW = ref(1)
const cropRatioH = ref(1)
const cropAuto = ref(false)
const cropCustom = ref(false)
const cropPresets = [
  { label: '1:1', w: 1, h: 1 },
  { label: '2:3', w: 2, h: 3 },
  { label: '3:2', w: 3, h: 2 },
  { label: '16:9', w: 16, h: 9 },
  { label: '9:16', w: 9, h: 16 }
]

function applyCropPreset(preset) {
  cropRatioW.value = preset.w
  cropRatioH.value = preset.h
  cropAuto.value = false
  cropCustom.value = false
}

function toggleCropAuto() {
  cropAuto.value = !cropAuto.value
  if (cropAuto.value) cropCustom.value = false
}

function toggleCropCustom() {
  cropCustom.value = !cropCustom.value
  if (cropCustom.value) cropAuto.value = false
}

function runProportionalCrop() {
  runOutputTask('crop', (outDir) => {
    if (cropAuto.value) {
      const ratioList = cropPresets.map((p) => [p.w, p.h])
      return window.api.callPython('/auto-crop', {
        files: [...selectedImages.value],
        output_dir: outDir,
        ratio_list: ratioList
      })
    }
    return window.api.callPython('/proportional-crop', {
      files: [...selectedImages.value],
      output_dir: outDir,
      ratio_w: cropRatioW.value,
      ratio_h: cropRatioH.value
    })
  })
}

// --- 去重 ---
const dedupHashThresh = ref(10)
const dedupPhashThresh = ref(10)
const dedupColorThresh = ref(0.5)
const dedupMap = ref(new Map()) // file path → { group, similarity }
const dedupActive = ref(false)

const GROUP_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316'
]

function getGroupColor(groupId) {
  if (groupId == null) return null
  return GROUP_COLORS[groupId % GROUP_COLORS.length]
}

// --- 聚类 ---
const clusterMethod = ref('style')
const clusterAlgorithm = ref('kmeans')
const clusterK = ref(8)
const clusterMap = ref(new Map()) // file path → group number
const clusterActive = ref(false)
const clusterFusion = ref(false)
const clusterFusionStyle = ref(0.5)
const clusterFusionSemantic = ref(0.5)
const clusterFusionColor = ref(0.0)

function setClusterMethod(method) {
  clusterFusion.value = false
  clusterMethod.value = method
}

// --- 统一的分组信息获取 ---
function getGroupInfo(img) {
  if (filterActive.value) {
    const info = filterMap.value.get(img.path)
    if (info) return { group: 1, label: `${info.width}×${info.height}` }
  }
  if (dedupActive.value) {
    const info = dedupMap.value.get(img.path)
    if (info?.group != null) return { group: info.group, label: `${info.similarity}%` }
  }
  if (clusterActive.value) {
    const group = clusterMap.value.get(img.path)
    if (group != null) return { group, label: `组${group + 1}` }
  }
  return null
}

// 排序后的图片列表：过滤/去重/聚类时按分组排列
const sortedImages = computed(() => {
  if (filterActive.value && filterMap.value.size > 0) {
    const arr = [...images.value]
    arr.sort((a, b) => {
      const fa = filterMap.value.has(a.path) ? 0 : 1
      const fb = filterMap.value.has(b.path) ? 0 : 1
      return fa - fb
    })
    return arr
  }

  let activeMap = null
  let getGroup = null

  if (clusterActive.value && clusterMap.value.size > 0) {
    activeMap = clusterMap.value
    getGroup = (path) => activeMap.get(path) ?? null
  } else if (dedupActive.value && dedupMap.value.size > 0) {
    activeMap = dedupMap.value
    getGroup = (path) => activeMap.get(path)?.group ?? null
  }

  if (!activeMap) return images.value

  const arr = [...images.value]
  arr.sort((a, b) => {
    const ga = getGroup(a.path)
    const gb = getGroup(b.path)
    if (ga != null && gb == null) return -1
    if (ga == null && gb != null) return 1
    if (ga != null && gb != null && ga !== gb) return ga - gb
    return 0
  })
  return arr
})

async function deduplicate() {
  activePanel.value = null
  processError.value = ''
  clearFilter()
  clearCluster()
  const files = getTargetFiles()
  if (files.length === 0) return

  processingAction.value = 'dedup'
  try {
    const result = await window.api.callPython('/deduplicate', {
      files: files,
      hash_thresh: dedupHashThresh.value,
      phash_thresh: dedupPhashThresh.value,
      color_thresh: dedupColorThresh.value
    })
    if (result.aborted) return
    if (result.success) {
      const map = new Map()
      for (const item of result.results) {
        map.set(item.file, { group: item.group, similarity: item.similarity })
      }
      dedupMap.value = map
      dedupActive.value = true
    } else {
      setProcessError(result, 'dedup')
    }
  } catch (err) {
    setProcessError(err, 'dedup')
  } finally {
    if (processingAction.value === 'dedup') processingAction.value = null
  }
}

async function runCluster() {
  activePanel.value = null
  processError.value = ''
  clearFilter()
  clearDedup()
  const files = getTargetFiles()
  if (files.length === 0) return

  processingAction.value = 'cluster'
  try {
    const options = {
      method: clusterMethod.value,
      algorithm: clusterAlgorithm.value,
      k: clusterK.value,
      fusionWeights: clusterFusion.value
        ? {
            style: clusterFusionStyle.value,
            semantic: clusterFusionSemantic.value,
            color: clusterFusionColor.value
          }
        : null
    }
    const result = await window.api.callPython('/cluster', {
      files: files,
      method: options.method || 'style',
      algorithm: options.algorithm || 'kmeans',
      k: options.k || 5,
      fusion_weights: options.fusionWeights || null
    })
    if (result.aborted) return
    if (result.success) {
      const map = new Map()
      for (const item of result.results) {
        if (item.group != null) map.set(item.file, item.group)
      }
      clusterMap.value = map
      clusterActive.value = true
    } else {
      setProcessError(result, 'cluster')
    }
  } catch (err) {
    setProcessError(err, 'cluster')
  } finally {
    if (processingAction.value === 'cluster') processingAction.value = null
  }
}

async function moveClusterResults() {
  processError.value = ''
  const outDir = await getOutputDir()
  if (!outDir) return

  const filesByGroup = {}
  for (const [file, group] of clusterMap.value.entries()) {
    if (!filesByGroup[group]) filesByGroup[group] = []
    filesByGroup[group].push(file)
  }

  processingAction.value = 'clusterMove'
  try {
    const result = await window.api.callPython('/cluster-move', {
      files_by_group: filesByGroup,
      output_dir: outDir
    })
    if (result.success) {
      clearCluster()
    } else {
      setProcessError(result, 'clusterMove')
    }
  } catch (err) {
    setProcessError(err, 'clusterMove')
  } finally {
    if (processingAction.value === 'clusterMove') processingAction.value = null
  }
}

function clearDedup() {
  dedupMap.value = new Map()
  dedupActive.value = false
}

function clearCluster() {
  clusterMap.value = new Map()
  clusterActive.value = false
}

async function refreshAndClearAll() {
  clearFilter()
  clearDedup()
  clearCluster()
  await refreshImages()
}

function clearProcessFolder() {
  activePanel.value = null
  processError.value = ''
  clearFilter()
  clearDedup()
  clearCluster()
  clearCurrentFolder()
}
</script>

<template>
  <div class="process-page">
    <!-- 面板背景遮罩：点击关闭 -->
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
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'filter' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('filter')"
          >
            分辨率过滤
          </button>
          <div v-if="activePanel === 'filter'" class="action-panel filter-panel">
            <div class="panel-row format-options">
              <label
                :class="['format-tag', { selected: filterMode === 'width' }]"
                @click="filterMode = 'width'"
              >
                宽度
              </label>
              <label
                :class="['format-tag', { selected: filterMode === 'height' }]"
                @click="filterMode = 'height'"
              >
                高度
              </label>
              <label
                :class="['format-tag', { selected: filterMode === 'both' }]"
                @click="filterMode = 'both'"
              >
                综合
              </label>
            </div>
            <template v-if="filterMode === 'width' || filterMode === 'both'">
              <div class="panel-row">
                <label>最小宽度</label>
                <input v-model.number="filterMinWidth" type="number" min="1" /> px
              </div>
            </template>
            <template v-if="filterMode === 'height' || filterMode === 'both'">
              <div class="panel-row">
                <label>最小高度</label>
                <input v-model.number="filterMinHeight" type="number" min="1" /> px
              </div>
            </template>
            <button class="panel-run" @click="runResolutionFilter">执行</button>
          </div>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'format' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('format')"
          >
            格式转换
          </button>
          <div v-if="activePanel === 'format'" class="action-panel">
            <div class="panel-row format-options">
              <label
                v-for="fmt in ['png', 'jpg', 'webp']"
                :key="fmt"
                :class="['format-tag', { selected: targetFormat === fmt }]"
                @click="targetFormat = fmt"
              >
                {{ fmt.toUpperCase() }}
              </label>
            </div>
            <button class="panel-run" @click="runFormatConvert">执行</button>
          </div>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'alpha' }]"
            :disabled="imageCount === 0 || !!processingAction"
            @click="togglePanel('alpha')"
          >
            透明通道
          </button>
          <div v-if="activePanel === 'alpha'" class="action-panel alpha-panel">
            <div class="panel-hint">合成透明背景图片；无透明通道的图片会自动跳过</div>
            <div class="panel-row format-options">
              <label
                :class="['format-tag', { selected: alphaBackground === 'white' }]"
                @click="alphaBackground = 'white'"
              >
                白底
              </label>
              <label
                :class="['format-tag', { selected: alphaBackground === 'black' }]"
                @click="alphaBackground = 'black'"
              >
                黑底
              </label>
            </div>
            <button class="panel-run" @click="runAlphaFlatten">执行</button>
          </div>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'crop' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('crop')"
          >
            按比例裁剪
          </button>
          <div v-if="activePanel === 'crop'" class="action-panel">
            <div class="panel-row preset-row">
              <label :class="['format-tag', { selected: cropAuto }]" @click="toggleCropAuto">
                Auto
              </label>
              <label
                v-for="p in cropPresets"
                :key="p.label"
                :class="[
                  'format-tag',
                  { selected: !cropAuto && !cropCustom && cropRatioW === p.w && cropRatioH === p.h }
                ]"
                @click="applyCropPreset(p)"
              >
                {{ p.label }}
              </label>
              <label :class="['format-tag', { selected: cropCustom }]" @click="toggleCropCustom">
                自定义
              </label>
            </div>
            <div v-if="cropCustom" class="panel-row">
              <input v-model.number="cropRatioW" type="number" min="1" />
              <span class="ratio-sep">:</span>
              <input v-model.number="cropRatioH" type="number" min="1" />
            </div>
            <button class="panel-run" @click="runProportionalCrop">执行</button>
          </div>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'dedup' }]"
            :disabled="imageCount === 0 || !!processingAction"
            @click="togglePanel('dedup')"
          >
            去重
          </button>
          <div v-if="activePanel === 'dedup'" class="action-panel dedup-panel">
            <div class="panel-hint">dHash + pHash + 颜色直方图筛选，ORB + RANSAC 几何验证</div>
            <div class="panel-row">
              <label>dHash阈值</label>
              <input v-model.number="dedupHashThresh" type="range" min="1" max="20" step="1" />
              <span class="range-value">{{ dedupHashThresh }}</span>
            </div>
            <div class="panel-row">
              <label>pHash阈值</label>
              <input v-model.number="dedupPhashThresh" type="range" min="1" max="20" step="1" />
              <span class="range-value">{{ dedupPhashThresh }}</span>
            </div>
            <div class="panel-row">
              <label>颜色阈值</label>
              <input
                v-model.number="dedupColorThresh"
                type="range"
                min="0.1"
                max="0.9"
                step="0.05"
              />
              <span class="range-value">{{ dedupColorThresh.toFixed(2) }}</span>
            </div>
            <button class="panel-run" @click="deduplicate">执行</button>
          </div>
        </div>
        <div class="action-item">
          <button
            :class="['action-btn', { active: activePanel === 'cluster' }]"
            :disabled="imageCount === 0 || !!processingAction"
            @click="togglePanel('cluster')"
          >
            聚类
          </button>
          <div v-if="activePanel === 'cluster'" class="action-panel cluster-panel">
            <div class="panel-section">
              <span class="panel-label">算法</span>
              <div class="panel-row format-options">
                <label
                  :class="['format-tag', { selected: clusterAlgorithm === 'kmeans' }]"
                  @click="clusterAlgorithm = 'kmeans'"
                >
                  K-Means
                </label>
                <label
                  :class="['format-tag', { selected: clusterAlgorithm === 'hdbscan' }]"
                  @click="clusterAlgorithm = 'hdbscan'"
                >
                  HDBSCAN
                </label>
              </div>
            </div>
            <div class="panel-section">
              <span class="panel-label">特征</span>
              <div class="panel-row format-options">
                <label
                  :class="['format-tag', { selected: !clusterFusion && clusterMethod === 'style' }]"
                  @click="setClusterMethod('style')"
                >
                  风格
                </label>
                <label
                  :class="[
                    'format-tag',
                    { selected: !clusterFusion && clusterMethod === 'semantic' }
                  ]"
                  @click="setClusterMethod('semantic')"
                >
                  语义
                </label>
                <label
                  :class="['format-tag', { selected: clusterFusion }]"
                  @click="clusterFusion = !clusterFusion"
                >
                  融合
                </label>
              </div>
            </div>
            <!-- 融合权重 -->
            <div v-if="clusterFusion" class="panel-section fusion-weights">
              <div class="panel-row">
                <label>风格</label>
                <input
                  v-model.number="clusterFusionStyle"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                />
                <span class="range-value">{{ clusterFusionStyle.toFixed(1) }}</span>
              </div>
              <div class="panel-row">
                <label>语义</label>
                <input
                  v-model.number="clusterFusionSemantic"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                />
                <span class="range-value">{{ clusterFusionSemantic.toFixed(1) }}</span>
              </div>
              <div class="panel-row">
                <label>颜色</label>
                <input
                  v-model.number="clusterFusionColor"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                />
                <span class="range-value">{{ clusterFusionColor.toFixed(1) }}</span>
              </div>
            </div>
            <div class="panel-row">
              <label>分组数</label>
              <input v-model.number="clusterK" type="number" min="2" max="50" />
            </div>
            <button class="panel-run" @click="runCluster">执行</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="processError" class="task-error-bar">
      <span>{{ processError }}</span>
      <button class="task-error-close" @click="processError = ''">关闭</button>
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
      :processing-label="processingLabel"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshAndClearAll"
      @clear-folder="clearProcessFolder"
      @delete-selected="deleteSelected"
      @abort="abortTask"
    >
      <template #tail>
        <button
          v-if="clusterActive"
          class="action-btn"
          :disabled="!!processingAction"
          @click="moveClusterResults"
        >
          移动到子文件夹
        </button>
      </template>
    </ImageStatusBar>

    <!-- 图片网格 -->
    <div v-if="imageCount > 0" ref="gridRef" class="image-grid">
      <div
        v-for="img in sortedImages"
        :key="img.path"
        :data-path="img.path"
        :class="['image-card', { selected: isSelected(img) }]"
        :style="getGroupInfo(img) ? { borderColor: getGroupColor(getGroupInfo(img).group) } : {}"
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
        <!-- 分组徽章（去重 / 聚类） -->
        <span
          v-if="getGroupInfo(img)"
          class="dedup-badge"
          :style="{ background: getGroupColor(getGroupInfo(img).group) }"
        >
          {{ getGroupInfo(img).label }}
        </span>
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
  </div>
</template>

<style scoped>
/* 过滤面板 */
.filter-panel {
  min-width: 220px;
}

.filter-panel .format-options {
  gap: 6px;
}

.filter-panel .format-tag {
  flex: 1;
  text-align: center;
}

/* 缩放面板扩展宽度 */
.resize-panel {
  min-width: 220px;
}

.preset-row {
  gap: 6px;
  flex-wrap: wrap;
}

.ratio-sep {
  font-weight: 600;
  color: #9ca3af;
}

/* 聚类面板扩展宽度 */
.cluster-panel {
  min-width: 300px;
}

.fusion-weights .panel-row {
  gap: 6px;
}

.fusion-weights label {
  min-width: 28px;
  font-size: 11px;
}

/* 去重面板 */
.dedup-panel {
  min-width: 240px;
}

.alpha-panel {
  min-width: 220px;
}

.panel-hint {
  font-size: 11px;
  color: #9ca3af;
  line-height: 1.4;
}

.cluster-panel .format-tag {
  flex: 1;
  text-align: center;
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

.task-error-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  margin: 8px 0 0;
  border-radius: var(--radius-sm);
  background: var(--color-error-light);
  border: 1px solid var(--color-error-border);
  color: var(--color-error);
  font-size: 13px;
}

.task-error-close {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.status-pending {
  font-weight: 500;
}

/* 去重徽章 */
.dedup-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  z-index: 2;
  pointer-events: none;
  line-height: 1.3;
}
</style>
