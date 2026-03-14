<script setup>
import { ref, computed, onMounted, watch } from 'vue'
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
  getTargetFiles,
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

function togglePanel(name) {
  activePanel.value = activePanel.value === name ? null : name
}

function closePanel() {
  activePanel.value = null
}

// --- 通用任务执行器（需要输出目录的任务） ---
async function runOutputTask(actionName, apiFn) {
  activePanel.value = null
  const outDir = await getOutputDir()
  processingAction.value = actionName
  try {
    const result = await apiFn(outDir)
    if (result.aborted) return
    if (result.success && outDir === inputFolder.value) {
      await refreshImages()
    }
  } finally {
    if (processingAction.value === actionName) processingAction.value = null
  }
}

// --- 分辨率过滤 ---
const filterMode = ref('both')  // 'width' | 'height' | 'both'
const filterMinWidth = ref(512)
const filterMinHeight = ref(512)
const filterMap = ref(new Map())  // file path → { filtered, width, height }
const filterActive = ref(false)

async function runResolutionFilter() {
  activePanel.value = null
  clearDedup()
  clearCluster()
  const files = getTargetFiles()
  if (files.length === 0) return

  const minW = filterMode.value === 'height' ? 0 : filterMinWidth.value
  const minH = filterMode.value === 'width' ? 0 : filterMinHeight.value

  processingAction.value = 'filter'
  try {
    const result = await window.api.resolutionFilter(files, minW, 0, minH, 0)
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
    }
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
    window.api.formatConvert([...selectedImages.value], outDir, targetFormat.value)
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
      return window.api.autoCrop([...selectedImages.value], outDir, ratioList)
    }
    return window.api.proportionalCrop([...selectedImages.value], outDir, cropRatioW.value, cropRatioH.value)
  })
}

// --- 去重 ---
const dedupHashThresh = ref(10)
const dedupPhashThresh = ref(10)
const dedupColorThresh = ref(0.5)
const dedupMap = ref(new Map()) // file path → { group, similarity }
const dedupActive = ref(false)

const GROUP_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

function getGroupColor(groupId) {
  if (groupId == null) return null
  return GROUP_COLORS[groupId % GROUP_COLORS.length]
}

// --- 聚类 ---
const clusterMethod = ref('style')
const clusterAlgorithm = ref('kmeans')
const clusterK = ref(6)
const clusterMap = ref(new Map()) // file path → group number
const clusterActive = ref(false)
const clusterFusion = ref(false)
const clusterFusionStyle = ref(0.5)
const clusterFusionSemantic = ref(0.5)
const clusterFusionColor = ref(0.0)

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
  clearFilter()
  clearCluster()
  const files = getTargetFiles()
  if (files.length === 0) return

  processingAction.value = 'dedup'
  try {
    const result = await window.api.deduplicate(files, dedupHashThresh.value, dedupPhashThresh.value, dedupColorThresh.value)
    if (result.aborted) return
    if (result.success) {
      const map = new Map()
      for (const item of result.results) {
        map.set(item.file, { group: item.group, similarity: item.similarity })
      }
      dedupMap.value = map
      dedupActive.value = true
    }
  } finally {
    if (processingAction.value === 'dedup') processingAction.value = null
  }
}

async function runCluster() {
  activePanel.value = null
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
        ? { style: clusterFusionStyle.value, semantic: clusterFusionSemantic.value, color: clusterFusionColor.value }
        : null,
    }
    const result = await window.api.cluster(files, options)
    if (result.aborted) return
    if (result.success) {
      const map = new Map()
      for (const item of result.results) {
        if (item.group != null) map.set(item.file, item.group)
      }
      clusterMap.value = map
      clusterActive.value = true
    }
  } finally {
    if (processingAction.value === 'cluster') processingAction.value = null
  }
}

async function moveClusterResults() {
  const outDir = await getOutputDir()
  if (!outDir) return

  const filesByGroup = {}
  for (const [file, group] of clusterMap.value.entries()) {
    if (!filesByGroup[group]) filesByGroup[group] = []
    filesByGroup[group].push(file)
  }

  processingAction.value = 'clusterMove'
  try {
    const result = await window.api.clusterMove(filesByGroup, outDir)
    if (result.success) {
      clearCluster()
    }
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
</script>

<template>
  <div class="process-page">
    <!-- 面板背景遮罩：点击关闭 -->
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
                <input type="number" v-model.number="filterMinWidth" min="1" /> px
              </div>
            </template>
            <template v-if="filterMode === 'height' || filterMode === 'both'">
              <div class="panel-row">
                <label>最小高度</label>
                <input type="number" v-model.number="filterMinHeight" min="1" /> px
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
            :class="['action-btn', { active: activePanel === 'crop' }]"
            :disabled="selectedCount === 0 || !!processingAction"
            @click="togglePanel('crop')"
          >
            按比例裁剪
          </button>
          <div v-if="activePanel === 'crop'" class="action-panel">
            <div class="panel-row preset-row">
              <label
                :class="['format-tag', { selected: cropAuto }]"
                @click="toggleCropAuto"
              >
                Auto
              </label>
              <label
                v-for="p in cropPresets"
                :key="p.label"
                :class="['format-tag', { selected: !cropAuto && !cropCustom && cropRatioW === p.w && cropRatioH === p.h }]"
                @click="applyCropPreset(p)"
              >
                {{ p.label }}
              </label>
              <label
                :class="['format-tag', { selected: cropCustom }]"
                @click="toggleCropCustom"
              >
                自定义
              </label>
            </div>
            <div v-if="cropCustom" class="panel-row">
              <input type="number" v-model.number="cropRatioW" min="1" />
              <span class="ratio-sep">:</span>
              <input type="number" v-model.number="cropRatioH" min="1" />
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
              <input
                type="range"
                min="1"
                max="20"
                step="1"
                v-model.number="dedupHashThresh"
              />
              <span class="range-value">{{ dedupHashThresh }}</span>
            </div>
            <div class="panel-row">
              <label>pHash阈值</label>
              <input
                type="range"
                min="1"
                max="20"
                step="1"
                v-model.number="dedupPhashThresh"
              />
              <span class="range-value">{{ dedupPhashThresh }}</span>
            </div>
              <div class="panel-row">
                <label>颜色阈值</label>
                <input
                  type="range"
                  min="0.1"
                  max="0.9"
                  step="0.05"
                  v-model.number="dedupColorThresh"
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
                  @click="clusterFusion = false; clusterMethod = 'style'"
                >
                  风格
                </label>
                <label
                  :class="['format-tag', { selected: !clusterFusion && clusterMethod === 'semantic' }]"
                  @click="clusterFusion = false; clusterMethod = 'semantic'"
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
                <input type="range" min="0" max="1" step="0.1" v-model.number="clusterFusionStyle" />
                <span class="range-value">{{ clusterFusionStyle.toFixed(1) }}</span>
              </div>
              <div class="panel-row">
                <label>语义</label>
                <input type="range" min="0" max="1" step="0.1" v-model.number="clusterFusionSemantic" />
                <span class="range-value">{{ clusterFusionSemantic.toFixed(1) }}</span>
              </div>
              <div class="panel-row">
                <label>颜色</label>
                <input type="range" min="0" max="1" step="0.1" v-model.number="clusterFusionColor" />
                <span class="range-value">{{ clusterFusionColor.toFixed(1) }}</span>
              </div>
            </div>
            <div class="panel-row">
              <label>分组数</label>
              <input type="number" v-model.number="clusterK" min="2" max="50" />
            </div>
            <button class="panel-run" @click="runCluster">执行</button>
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
        <button :class="['bar-icon-btn', { spinning: refreshing }]" title="刷新" @click="refreshAndClearAll">
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
      <button
        v-if="clusterActive"
        class="action-btn"
        :disabled="!!processingAction"
        @click="moveClusterResults"
      >
        移动到子文件夹
      </button>
    </div>

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

/* 去重徽章 */
.dedup-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  z-index: 2;
  pointer-events: none;
  line-height: 1.3;
}
</style>
