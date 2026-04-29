<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useImageBrowser } from '../composables/useImageBrowser'
import FolderRow from '../components/FolderRow.vue'
import IconButton from '../components/IconButton.vue'
import ImageStatusBar from '../components/ImageStatusBar.vue'
import { ChevronLeft, ChevronRight, Tags, X } from 'lucide-vue-next'

const downloading = ref(false)
const downloadInfo = ref('')
const modelDropOpen = ref(false)

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
  onProgress({ step, total_steps, file: fileName, downloaded, total: fileTotal }) {
    if (downloading.value && step !== undefined) {
      const pct = fileTotal > 0 ? Math.round((downloaded / fileTotal) * 100) : 0
      downloadInfo.value = `(${step}/${total_steps}) ${fileName} ${pct}%`
    }
  }
})

const gridRef = ref(null)

// ===================== 辅助函数 =====================
function splitTags(str) {
  return str.split(',').map((t) => t.trim()).filter(Boolean)
}
function joinTags(arr) {
  return arr.join(', ')
}

// ===================== 模型相关 =====================
const models = ref([])
const selectedModel = ref('')

async function loadModels() {
  const result = await window.api.callPython('/tagger-models', {})
  if (result.success) {
    models.value = result.models
    const downloaded = result.models.find((m) => m.downloaded)
    selectedModel.value = (downloaded || result.models[0])?.key || ''
  }
}

async function downloadModel() {
  if (!selectedModel.value || downloading.value) return
  downloading.value = true
  downloadInfo.value = '准备下载...'
  try {
    const result = await window.api.callPython('/tagger-download', { model_key: selectedModel.value })
    if (result.success) { await loadModels(); downloadInfo.value = '' }
    else downloadInfo.value = result.error || '下载失败'
  } catch (err) { downloadInfo.value = err.message || '下载失败' }
  finally { downloading.value = false }
}

const currentModelInfo = computed(() => models.value.find((m) => m.key === selectedModel.value))

const selectedModelLabel = computed(() => {
  const m = currentModelInfo.value
  if (!m) return models.value.length === 0 ? '加载模型中...' : '选择模型'
  return m.name + (m.downloaded ? '' : ' (未下载)')
})

function selectModel(key) {
  selectedModel.value = key
  modelDropOpen.value = false
}

// ===================== 打标参数 =====================
const generalThreshold = ref(0.35)
const characterThreshold = ref(0.85)
const replaceUnderscore = ref(true)
// CL Tagger 类别开关:仅在选中 CL Tagger 时生效
const keepCopyright = ref(true)
const keepRating = ref(false)
const keepMeta = ref(false)
const keepModel = ref(false)
const keepQuality = ref(false)

const isClTagger = computed(() => selectedModel.value === 'cl-tagger-v1.02')

// ===================== 标签数据 =====================
const tagsMap = shallowRef({})
const dirtySet = ref(new Set())
const dirtyCount = computed(() => dirtySet.value.size)

watch(() => images.value, async (imgs) => {
  if (imgs.length === 0) { tagsMap.value = {}; dirtySet.value = new Set(); return }
  const paths = imgs.map((i) => i.path)
  const result = await window.api.batchReadTags(paths)
  tagsMap.value = { ...result }
})

// ===================== 初始化 =====================
function closeModelDrop() { modelDropOpen.value = false }

onMounted(() => {
  loadModels()
  if (gridRef.value) observeGrid(gridRef.value)
  document.addEventListener('click', closeModelDrop)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeModelDrop)
})

watch(imageCount, () => { if (gridRef.value) observeGrid(gridRef.value) }, { flush: 'post' })

// ===================== 批量打标 =====================
const tagError = ref('')

async function runTag() {
  const model = currentModelInfo.value
  if (!model || !model.downloaded) return
  const files = getTargetFiles()
  if (files.length === 0) return
  processingAction.value = 'tag'
  tagError.value = ''
  try {
    const result = await window.api.callPython('/tagger-tag', {
      files,
      model_key: selectedModel.value,
      general_threshold: generalThreshold.value,
      character_threshold: characterThreshold.value,
      keep_copyright: keepCopyright.value,
      keep_rating: keepRating.value,
      keep_meta: keepMeta.value,
      keep_model: keepModel.value,
      keep_quality: keepQuality.value
    })
    if (result.aborted) return
    if (result.success) {
      const newMap = { ...tagsMap.value }
      for (const item of result.results) {
            if (item.ok) {
              newMap[item.file] = replaceUnderscore.value
                ? item.tag_string.replace(/_/g, ' ')
                : item.tag_string
            }
          }
      tagsMap.value = newMap
      dirtySet.value = new Set(files.filter((f) => {
        const r = result.results.find((x) => x.file === f)
        return r && r.ok
      }))
      showTagPanel.value = true
    } else {
      tagError.value = result.error || '打标失败，请检查模型或图片'
    }
  } catch (err) {
    tagError.value = err.message || '打标请求异常'
  } finally { if (processingAction.value === 'tag') processingAction.value = null; window.api.callPython('/cleanup-caches', {}).catch(() => {}) }
}

// ===================== 保存 =====================
async function saveAllTags() {
  const toSave = {}
  for (const path of dirtySet.value) {
    if (tagsMap.value[path] !== undefined) toSave[path] = tagsMap.value[path]
  }
  if (Object.keys(toSave).length === 0) {
    for (const [path, tags] of Object.entries(tagsMap.value)) { if (tags) toSave[path] = tags }
  }
  if (Object.keys(toSave).length === 0) return
  processingAction.value = 'save'
  try {
    await window.api.batchSaveTags(toSave, outputFolder.value || undefined)
    dirtySet.value = new Set()
  } finally { if (processingAction.value === 'save') processingAction.value = null }
}

// ===================== 全局标签统计 =====================
const allTagStats = computed(() => {
  const stats = new Map()
  for (const tagStr of Object.values(tagsMap.value)) {
    if (!tagStr) continue
    for (const tag of splitTags(tagStr)) {
      stats.set(tag, (stats.get(tag) || 0) + 1)
    }
  }
  return stats
})

// ===================== 标签搜索 / 排序 =====================
const tagSearch = ref('')
const tagSortBy = ref('frequency') // 'name' | 'frequency'
const tagSortOrder = ref('desc')   // 'asc' | 'desc'

const sortedTagList = computed(() => {
  let entries = [...allTagStats.value.entries()]
  if (tagSearch.value) {
    const q = tagSearch.value.toLowerCase()
    entries = entries.filter(([name]) => name.toLowerCase().includes(q))
  }
  if (tagSortBy.value === 'name') {
    entries.sort((a, b) => tagSortOrder.value === 'asc' ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]))
  } else {
    entries.sort((a, b) => tagSortOrder.value === 'desc' ? b[1] - a[1] : a[1] - b[1])
  }
  return entries
})

// ===================== 按标签筛选图片 =====================
const filterTags = ref(new Set())
const filterLogic = ref('and') // 'and' | 'or' | 'none'

function toggleFilterTag(tagName) {
  const s = new Set(filterTags.value)
  if (s.has(tagName)) s.delete(tagName); else s.add(tagName)
  filterTags.value = s
}

function clearFilterTags() {
  filterTags.value = new Set()
}

const filteredImages = computed(() => {
  if (filterTags.value.size === 0) return images.value
  return images.value.filter((img) => {
    const imgTags = new Set(splitTags(tagsMap.value[img.path] || ''))
    const fArr = [...filterTags.value]
    if (filterLogic.value === 'and') return fArr.every((t) => imgTags.has(t))
    if (filterLogic.value === 'or') return fArr.some((t) => imgTags.has(t))
    return fArr.every((t) => !imgTags.has(t)) // none
  })
})

// ===================== 右侧：单图编辑面板 =====================
const editingImage = ref(null)
const editingTags = ref('')

function openEditor(img) {
  editingImage.value = img
  editingTags.value = tagsMap.value[img.path] || ''
}
function closeEditor() { editingImage.value = null; editingTags.value = '' }

const editingTagsList = computed(() => splitTags(editingTags.value))

function syncEditToMap() {
  if (!editingImage.value) return
  const path = editingImage.value.path
  tagsMap.value = { ...tagsMap.value, [path]: editingTags.value }
  dirtySet.value = new Set([...dirtySet.value, path])
}

function removeTagFromEditing(tag) {
  editingTags.value = joinTags(editingTagsList.value.filter((t) => t !== tag))
  syncEditToMap()
}

const customTagInput = ref('')
function addCustomTag() {
  const newTags = splitTags(customTagInput.value)
  if (newTags.length === 0) return
  const existing = editingTagsList.value
  const toAdd = newTags.filter((t) => !existing.includes(t))
  if (toAdd.length > 0) {
    editingTags.value = joinTags([...existing, ...toAdd])
    syncEditToMap()
  }
  customTagInput.value = ''
}

// 从左侧标签面板点击添加到当前编辑图片
function addTagToEditing(tagName) {
  if (!editingImage.value) return
  const existing = editingTagsList.value
  if (!existing.includes(tagName)) {
    editingTags.value = joinTags([...existing, tagName])
    syncEditToMap()
  }
}

async function saveCurrentTags() {
  if (!editingImage.value) return
  syncEditToMap()
  const path = editingImage.value.path
  const result = await window.api.saveImageTags(path, editingTags.value, outputFolder.value || undefined)
  if (result.success) {
    const s = new Set(dirtySet.value); s.delete(path); dirtySet.value = s
  }
}

function navEditor(direction) {
  if (!editingImage.value) return
  syncEditToMap()
  const list = filteredImages.value
  const idx = list.findIndex((i) => i.path === editingImage.value.path)
  const next = idx + direction
  if (next >= 0 && next < list.length) openEditor(list[next])
}

function getTagPreview(imgPath) {
  return tagsMap.value[imgPath] || ""
}

// 当前图片是否有某个 tag
function editingHasTag(tagName) {
  return editingTagsList.value.includes(tagName)
}

// ===================== 批量编辑 =====================
const batchMode = ref('prepend')
const batchInput = ref('')
const batchReplaceFrom = ref('')
const batchReplaceTo = ref('')

function runBatchEdit() {
  const targets = getTargetFiles()
  if (targets.length === 0) return
  const newMap = { ...tagsMap.value }
  const newDirty = new Set(dirtySet.value)

  if (batchMode.value === 'prepend' || batchMode.value === 'append') {
    const insertTags = splitTags(batchInput.value)
    if (insertTags.length === 0) return
    for (const path of targets) {
      const existing = splitTags(newMap[path] || '')
      const toInsert = insertTags.filter((t) => !existing.includes(t))
      if (toInsert.length === 0) continue
      newMap[path] = joinTags(batchMode.value === 'prepend' ? [...toInsert, ...existing] : [...existing, ...toInsert])
      newDirty.add(path)
    }
  } else if (batchMode.value === 'replace') {
    const from = batchReplaceFrom.value.trim(), to = batchReplaceTo.value.trim()
    if (!from) return
    for (const path of targets) {
      const existing = splitTags(newMap[path] || '')
      let changed = false
      const replaced = existing.map((t) => { if (t === from) { changed = true; return to || null } return t }).filter(Boolean)
      if (changed) { newMap[path] = joinTags(replaced); newDirty.add(path) }
    }
  }

  tagsMap.value = newMap
  dirtySet.value = newDirty
  if (editingImage.value) editingTags.value = newMap[editingImage.value.path] || ''
  batchInput.value = ''; batchReplaceFrom.value = ''; batchReplaceTo.value = ''
}

// 从左侧面板批量删除某个 tag（从所有图片中）
function removeTagFromAll(tagName) {
  const newMap = { ...tagsMap.value }
  const newDirty = new Set(dirtySet.value)
  for (const [path, tagStr] of Object.entries(newMap)) {
    if (!tagStr) continue
    const existing = splitTags(tagStr)
    const filtered = existing.filter((t) => t !== tagName)
    if (filtered.length !== existing.length) {
      newMap[path] = joinTags(filtered)
      newDirty.add(path)
    }
  }
  tagsMap.value = newMap
  dirtySet.value = newDirty
  if (editingImage.value) editingTags.value = newMap[editingImage.value.path] || ''
  // 同时从筛选中移除
  const fs = new Set(filterTags.value); fs.delete(tagName); filterTags.value = fs
}

function clearTaggerFolder() {
  tagsMap.value = {}
  dirtySet.value = new Set()
  filterTags.value = new Set()
  tagSearch.value = ''
  tagError.value = ''
  modelDropOpen.value = false
  editingImage.value = null
  editingTags.value = ''
  customTagInput.value = ''
  batchInput.value = ''
  batchReplaceFrom.value = ''
  batchReplaceTo.value = ''
  clearCurrentFolder()
}

// 左侧面板显示/隐藏
const showTagPanel = ref(true)
</script>

<template>
  <div class="process-page tagger-page">
    <!-- 顶部工具条 -->
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
          :placeholder="inputFolder ? '标签保存在图片同目录' : '输入文件夹路径...'"
          @commit="path => { outputFolder = path }"
          @browse="chooseOutputFolder"
        />
      </div>
      <div class="action-section">
        <div class="model-select-wrap">
          <div class="custom-select" :class="{ disabled: !!processingAction }" @click.stop="!processingAction && (modelDropOpen = !modelDropOpen)">
            <span class="custom-select-value">{{ selectedModelLabel }}</span>
            <svg class="custom-select-arrow" :class="{ open: modelDropOpen }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <Transition name="dropdown">
              <div v-if="modelDropOpen" class="custom-select-list">
                <div
                  v-for="m in models"
                  :key="m.key"
                  :class="['custom-select-item', { active: selectedModel === m.key }]"
                  @click.stop="selectModel(m.key)"
                >
                  {{ m.name }} {{ m.downloaded ? '' : '(未下载)' }}
                </div>
              </div>
            </Transition>
          </div>
          <button v-if="currentModelInfo && !currentModelInfo.downloaded" class="action-btn download-btn" :disabled="downloading || !!processingAction" @click="downloadModel">
            {{ downloading ? '下载中...' : '下载模型' }}
          </button>
        </div>
        <span v-if="downloadInfo" class="download-info">{{ downloadInfo }}</span>
        <button class="action-btn" :disabled="imageCount === 0 || !!processingAction || !currentModelInfo?.downloaded" @click="runTag">开始打标</button>
        <button class="action-btn" :disabled="imageCount === 0 || !!processingAction" @click="saveAllTags">保存全部{{ dirtyCount > 0 ? ` (${dirtyCount})` : '' }}</button>
      </div>
    </div>

    <!-- 阈值设置栏 -->
    <div class="threshold-bar">
      <div class="threshold-item">
        <span class="threshold-label">通用阈值</span>
        <input type="range" min="0.05" max="0.95" step="0.05" v-model.number="generalThreshold" :disabled="!!processingAction" />
        <span class="threshold-value">{{ generalThreshold.toFixed(2) }}</span>
      </div>
      <div class="threshold-item">
        <span class="threshold-label">角色阈值</span>
        <input type="range" min="0.05" max="0.95" step="0.05" v-model.number="characterThreshold" :disabled="!!processingAction" />
        <span class="threshold-value">{{ characterThreshold.toFixed(2) }}</span>
      </div>
      <label class="threshold-toggle" @click="replaceUnderscore = !replaceUnderscore">
        <span :class="['toggle-switch', { on: replaceUnderscore }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">下划线转空格</span>
      </label>
      <label :class="['threshold-toggle', 'cl-only', { dim: !isClTagger }]" @click="keepCopyright = !keepCopyright">
        <span :class="['toggle-switch', { on: keepCopyright && isClTagger }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">Copyright</span>
      </label>
      <label :class="['threshold-toggle', 'cl-only', { dim: !isClTagger }]" @click="keepRating = !keepRating">
        <span :class="['toggle-switch', { on: keepRating && isClTagger }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">Rating</span>
      </label>
      <label :class="['threshold-toggle', 'cl-only', { dim: !isClTagger }]" @click="keepMeta = !keepMeta">
        <span :class="['toggle-switch', { on: keepMeta && isClTagger }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">Meta</span>
      </label>
      <label :class="['threshold-toggle', 'cl-only', { dim: !isClTagger }]" @click="keepModel = !keepModel">
        <span :class="['toggle-switch', { on: keepModel && isClTagger }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">Model</span>
      </label>
      <label :class="['threshold-toggle', 'cl-only', { dim: !isClTagger }]" @click="keepQuality = !keepQuality">
        <span :class="['toggle-switch', { on: keepQuality && isClTagger }]"><span class="toggle-knob"></span></span>
        <span class="toggle-text">Quality</span>
      </label>
    </div>

    <!-- 错误提示 -->
    <div v-if="tagError" class="tag-error-bar">
      <span>{{ tagError }}</span>
      <button class="tag-error-close" @click="tagError = ''">×</button>
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
      processing-label="打标"
      @toggle-select-all="toggleSelectAll"
      @refresh="refreshImages"
      @clear-folder="clearTaggerFolder"
      @delete-selected="deleteSelected"
      @abort="abortTask"
    >
      <template #actions>
        <IconButton
          :icon="Tags"
          :active="showTagPanel"
          title="标签面板"
          @click="showTagPanel = !showTagPanel"
        />
      </template>
      <template #idle>
        共 {{ imageCount }} 张<template v-if="filterTags.size > 0">，筛选 {{ filteredImages.length }} 张</template>，已选 {{ selectedCount }} 张
      </template>
    </ImageStatusBar>

    <!-- ========== 主内容三栏布局 ========== -->
    <div v-if="imageCount > 0" class="tagger-body">

      <!-- ===== 左侧：标签管理面板 ===== -->
      <div v-if="showTagPanel" class="tag-panel">
        <div class="tp-header">
          <span class="tp-title">标签列表</span>
          <span class="tp-count">{{ allTagStats.size }} 个标签</span>
        </div>

        <!-- 搜索 -->
        <input class="tp-search" v-model="tagSearch" placeholder="搜索标签..." />

        <!-- 排序 / 筛选 -->
        <div class="tp-controls">
          <div class="tp-control-row">
            <span class="tp-control-label">排序</span>
            <div class="tp-sort-group">
              <label :class="['tp-chip', { active: tagSortBy === 'frequency' }]" @click="tagSortBy = 'frequency'">频次</label>
              <label :class="['tp-chip', { active: tagSortBy === 'name' }]" @click="tagSortBy = 'name'">名称</label>
            </div>
            <div class="tp-sort-group">
              <label :class="['tp-chip', { active: tagSortOrder === 'desc' }]" @click="tagSortOrder = 'desc'">降序</label>
              <label :class="['tp-chip', { active: tagSortOrder === 'asc' }]" @click="tagSortOrder = 'asc'">升序</label>
            </div>
          </div>
          <div class="tp-control-row">
            <span class="tp-control-label">筛选</span>
            <div class="tp-sort-group">
              <label :class="['tp-chip', { active: filterLogic === 'and' }]" @click="filterLogic = 'and'">AND</label>
              <label :class="['tp-chip', { active: filterLogic === 'or' }]" @click="filterLogic = 'or'">OR</label>
              <label :class="['tp-chip', { active: filterLogic === 'none' }]" @click="filterLogic = 'none'">NONE</label>
            </div>
            <button v-if="filterTags.size > 0" class="tp-clear-btn" @click="clearFilterTags">清除</button>
          </div>
        </div>

        <!-- 标签列表（方块堆积） -->
        <div class="tp-tag-list">
          <div class="tp-tag-chips-wrap">
            <span
              v-for="[tagName, count] in sortedTagList"
              :key="tagName"
              :class="['tp-tag-chip', { filtered: filterTags.has(tagName), 'has-tag': editingImage && editingHasTag(tagName) }]"
              @click="editingImage ? addTagToEditing(tagName) : toggleFilterTag(tagName)"
            >
              <span class="tp-chip-name">{{ tagName }}</span>
              <span class="tp-chip-count">{{ count }}</span>
              <svg class="tp-chip-del" title="从所有图片中删除此标签" @click.stop="removeTagFromAll(tagName)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </span>
          </div>
          <div v-if="sortedTagList.length === 0" class="tp-empty">暂无标签</div>
        </div>

        <!-- 底部：批量编辑 -->
        <div class="tp-batch">
          <div class="tp-batch-header">
            <span class="tp-batch-title">批量编辑</span>
            <span class="tp-batch-scope">{{ selectedCount > 0 ? `${selectedCount} 张选中` : `全部 ${imageCount} 张` }}</span>
          </div>
          <div class="tp-batch-modes">
            <label :class="['tp-chip', { active: batchMode === 'prepend' }]" @click="batchMode = 'prepend'">前插</label>
            <label :class="['tp-chip', { active: batchMode === 'append' }]" @click="batchMode = 'append'">后插</label>
            <label :class="['tp-chip', { active: batchMode === 'replace' }]" @click="batchMode = 'replace'">替换</label>
          </div>
          <template v-if="batchMode !== 'replace'">
            <div class="tp-batch-input-row">
              <input class="tp-batch-input" v-model="batchInput" placeholder="输入标签, 逗号分隔" @keyup.enter="runBatchEdit" />
              <button class="tp-batch-run" @click="runBatchEdit" :disabled="!batchInput.trim()">执行</button>
            </div>
          </template>
          <template v-else>
            <div class="tp-batch-input-row">
              <input class="tp-batch-input" v-model="batchReplaceFrom" placeholder="原标签" />
            </div>
            <div class="tp-batch-input-row">
              <input class="tp-batch-input" v-model="batchReplaceTo" placeholder="替换为（留空则删除）" @keyup.enter="runBatchEdit" />
              <button class="tp-batch-run" @click="runBatchEdit" :disabled="!batchReplaceFrom.trim()">执行</button>
            </div>
          </template>
        </div>
      </div>

      <!-- ===== 中间：图片网格 ===== -->
      <div ref="gridRef" class="image-grid tagger-grid">
        <div
          v-for="img in filteredImages"
          :key="img.path"
          :data-path="img.path"
          :class="['image-card', { selected: isSelected(img), editing: editingImage?.path === img.path }]"
          @click="openEditor(img)"
        >
          <img v-if="thumbnails[img.path]" :src="thumbnails[img.path]" :alt="img.name" draggable="false" />
          <div v-else class="image-placeholder"></div>
          <div class="image-name-overlay">{{ img.name }}</div>
          <span v-if="getTagPreview(img.path)" class="tag-badge">{{ getTagPreview(img.path) }}</span>
          <span v-if="dirtySet.has(img.path)" class="dirty-dot" title="未保存"></span>
          <span :class="['checkbox', { checked: isSelected(img) }]" @click.stop="toggleSelect(img)"></span>
        </div>
      </div>

      <!-- ===== 右侧：单图标签编辑 ===== -->
      <Transition name="panel-slide">
        <div v-if="editingImage" class="tag-editor-panel">
          <div class="editor-header">
            <span class="editor-filename">{{ editingImage.name }}</span>
            <div class="editor-nav">
              <IconButton :icon="ChevronLeft" variant="editor" title="上一张" @click="navEditor(-1)" />
              <IconButton :icon="ChevronRight" variant="editor" title="下一张" @click="navEditor(1)" />
              <IconButton :icon="X" variant="editor" tone="close" title="关闭" @click="closeEditor" />
            </div>
          </div>
          <div class="editor-preview">
            <img :src="editingImage.url" :alt="editingImage.name" />
          </div>

          <!-- 标签芯片区 -->
          <div class="editor-chips-section">
            <div class="editor-chips">
              <span v-for="tag in editingTagsList" :key="tag" class="tag-chip" @click="removeTagFromEditing(tag)">
                {{ tag }}
                <svg class="chip-x" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </span>
              <span v-if="editingTagsList.length === 0" class="chips-empty">暂无标签</span>
            </div>
            <!-- 自定义标签输入 -->
            <div class="custom-tag-row">
              <input
                class="custom-tag-input"
                v-model="customTagInput"
                placeholder="输入标签, 回车添加"
                @keyup.enter="addCustomTag"
              />
              <button class="custom-tag-add" @click="addCustomTag" :disabled="!customTagInput.trim()">添加</button>
            </div>
          </div>

          <!-- 原始文本编辑 -->
          <div class="editor-raw-section">
            <textarea
              class="editor-textarea"
              v-model="editingTags"
              placeholder="标签以逗号分隔"
              rows="3"
              spellcheck="false"
              @input="syncEditToMap"
            ></textarea>
          </div>

          <div class="editor-actions">
            <span v-if="dirtySet.has(editingImage.path)" class="editor-dirty-hint">* 未保存</span>
            <button class="panel-run" @click="saveCurrentTags">保存</button>
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
/* ===== 错误提示条 ===== */
.tag-error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--color-error-light);
  border: 1px solid var(--color-error-border);
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-error);
  flex-shrink: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.tag-error-close {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--color-error);
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0 4px;
}

/* ===== 阈值栏 ===== */
.threshold-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 20px; padding: 6px 0; min-height: 36px; box-sizing: border-box; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.threshold-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.threshold-label { color: var(--color-text-secondary); white-space: nowrap; width: 56px; flex-shrink: 0; }
.threshold-item input[type="range"] { width: 120px; height: 4px; accent-color: var(--color-text); cursor: pointer; }
.threshold-value { font-size: 12px; color: var(--color-text); font-weight: 500; min-width: 32px; text-align: right; }
.threshold-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; flex-shrink: 0; }
.toggle-text { font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; transition: color 0.15s; }
.threshold-toggle:hover .toggle-text { color: var(--color-text); }
.threshold-toggle.cl-only.dim { opacity: 0.4; }
.threshold-toggle.cl-only.dim:hover .toggle-text { color: var(--color-text-secondary); }
.toggle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--color-border-unchecked);
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-switch.on { background: var(--color-active-bg); }
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-active-text);
  box-shadow: 0 1px 3px var(--color-shadow);
  transition: transform 0.2s;
}
.toggle-switch.on .toggle-knob { transform: translateX(14px); }

/* ===== 模型选择 ===== */
.model-select-wrap { display: flex; align-items: center; gap: 6px; }

/* 自定义下拉框 */
.custom-select {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--color-text);
  background: var(--color-input-bg);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s;
  min-width: 180px;
  box-sizing: border-box;
  gap: 6px;
}
.custom-select:hover { border-color: var(--color-border-hover); }
.custom-select.disabled { opacity: 0.6; cursor: not-allowed; pointer-events: none; }
.custom-select-value { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.custom-select-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.2s;
}
.custom-select-arrow.open { transform: rotate(180deg); }
.custom-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  width: max-content;
  background: var(--color-input-bg);
  border: 1px solid var(--color-border);
  border-radius: 2px;
  box-shadow: 0 4px 12px var(--color-shadow);
  z-index: 20;
  overflow: hidden;
  max-height: 300px;
  overflow-y: auto;
}
.custom-select-item {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
  white-space: nowrap;
}
.custom-select-item:hover { background: var(--color-surface-hover); }
.custom-select-item.active { background: var(--color-active-bg); color: var(--color-active-text); }

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

.download-btn { color: var(--color-info); border-color: var(--color-info); }
.download-btn:hover:not(:disabled) { background: var(--color-info-light); }
.download-info { font-size: 11px; color: var(--color-text-secondary); white-space: nowrap; }

/* ===== 三栏布局 ===== */
.tagger-body { flex: 1; min-height: 0; display: flex; gap: 0; overflow: hidden; }
.tagger-grid { flex: 1; min-width: 0; }
.image-card.editing { border-color: var(--color-info); }

/* ===== 标签摘要 ===== */
.tag-badge { position: absolute; bottom: 0; left: 0; right: 0; padding: 3px 6px; font-size: 10px; color: #fff; background: rgba(0,0,0,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; z-index: 1; }
.dirty-dot { position: absolute; top: 6px; left: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning); z-index: 2; pointer-events: none; }

/* ============================================
   左侧标签管理面板
   ============================================ */
.tag-panel {
  width: 360px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  background: var(--color-surface-soft);
  overflow: hidden;
}

.tp-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--color-border-light); }
.tp-title { font-size: 13px; font-weight: 600; color: var(--color-text); }
.tp-count { font-size: 11px; color: var(--color-text-muted); }

.tp-search {
  margin: 8px 10px 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  background: var(--color-input-bg);
  box-sizing: border-box;
}
.tp-search:focus { border-color: var(--color-text); }

/* 排序 / 筛选控件 */
.tp-controls { padding: 6px 10px 0; border-bottom: 1px solid var(--color-border-light); }
.tp-control-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.tp-control-label { font-size: 11px; color: var(--color-text-secondary); flex-shrink: 0; width: 28px; }
.tp-sort-group { display: flex; gap: 4px; }

.tp-chip {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  transition: color 0.12s, background-color 0.12s, border-color 0.12s;
  background: var(--color-input-bg);
}
.tp-chip:hover { border-color: var(--color-border-hover); }
.tp-chip.active { background: var(--color-active-bg); border-color: var(--color-active-bg); color: var(--color-active-text); }

.tp-clear-btn {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--color-error);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-error);
  background: var(--color-input-bg);
  cursor: pointer;
}
.tp-clear-btn:hover { background: var(--color-error-light); }

/* 标签列表 */
.tp-tag-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
}

.tp-tag-chips-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-content: flex-start;
}

.tp-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--color-input-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition: color 0.12s, background-color 0.12s, border-color 0.12s;
  line-height: 1.3;
  max-width: 100%;
}
.tp-tag-chip:hover { background: var(--color-tag-hover-bg); border-color: var(--color-tag-hover-border); }
.tp-tag-chip.filtered { background: var(--color-tag-filtered-bg); border-color: var(--color-tag-hover-border); color: var(--color-tag-filtered-color); }
.tp-tag-chip.has-tag { background: var(--color-tag-has-bg); border-color: var(--color-tag-has-border); color: var(--color-tag-has-color); }
.tp-tag-chip.has-tag.filtered { background: var(--color-tag-filtered-bg); border-color: var(--color-tag-hover-border); color: var(--color-tag-filtered-color); }

.tp-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-chip-count { flex-shrink: 0; font-size: 10px; color: var(--color-text-muted); font-weight: 500; }
.tp-chip-del {
  flex-shrink: 0;
  opacity: 0.4;
  transition: opacity 0.12s, stroke 0.12s;
  cursor: pointer;
}
.tp-tag-chip:hover .tp-chip-del { opacity: 1; }
.tp-chip-del:hover { opacity: 1; stroke: var(--color-error); }

.tp-empty { padding: 20px; text-align: center; font-size: 12px; color: var(--color-text-muted); }

/* ============================================
   右侧编辑面板
   ============================================ */
.tag-editor-panel { width: 360px; flex-shrink: 0; border-left: 1px solid var(--color-border); display: flex; flex-direction: column; background: var(--color-input-bg); overflow: hidden; }

.editor-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--color-surface-hover); flex-shrink: 0; }
.editor-filename { font-size: 13px; font-weight: 500; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.editor-nav { display: flex; gap: 2px; flex-shrink: 0; }
.editor-nav-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; padding: 0; }
.editor-nav-btn:hover { color: var(--color-text); background: var(--color-surface-hover); }
.editor-nav-btn.close:hover { color: var(--color-error); background: var(--color-error-light); }

.editor-preview { flex-shrink: 0; padding: 8px 12px; display: flex; justify-content: center; background: var(--color-surface-soft); max-height: 240px; }
.editor-preview img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 4px; }

/* 标签芯片区 */
.editor-chips-section { padding: 10px 12px 0; flex-shrink: 0; }
.editor-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 160px;
  overflow-y: auto;
  padding-bottom: 8px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition: color 0.12s, background-color 0.12s, border-color 0.12s;
  line-height: 1.3;
}
.tag-chip:hover { background: var(--color-error-light); border-color: var(--color-error-border); color: var(--color-error); }
.tag-chip .chip-x { flex-shrink: 0; opacity: 0.4; }
.tag-chip:hover .chip-x { opacity: 1; stroke: var(--color-error); }

.chips-empty { font-size: 12px; color: var(--color-text-muted); }

/* 自定义标签输入 */
.custom-tag-row { display: flex; gap: 6px; margin-top: 6px; }
.custom-tag-input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}
.custom-tag-input:focus { border-color: var(--color-text); }
.custom-tag-add {
  padding: 0 12px;
  height: 30px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.custom-tag-add:hover { background: var(--color-text-secondary); }
.custom-tag-add:disabled { opacity: 0.4; cursor: not-allowed; }

/* 原始文本区 */
.editor-raw-section { flex: 1; min-height: 0; padding: 8px 12px; overflow-y: auto; }
.editor-textarea { width: 100%; min-height: 60px; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; font-size: 12px; line-height: 1.6; color: var(--color-text); resize: vertical; outline: none; font-family: inherit; box-sizing: border-box; }
.editor-textarea:focus { border-color: var(--color-text); }

.editor-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--color-surface-hover); flex-shrink: 0; }
.editor-dirty-hint { font-size: 12px; color: var(--color-warning); }

/* 面板滑入动画 */
.tag-editor-panel { transform-origin: right center; }
.panel-slide-enter-active, .panel-slide-leave-active { transition: transform 0.2s ease, opacity 0.2s ease; }
.panel-slide-enter-from, .panel-slide-leave-to { transform: translateX(100%); opacity: 0; }

/* ===== 标签面板底部批量编辑 ===== */
.tp-batch {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
  padding: 8px 10px 10px;
  background: var(--color-input-bg);
}
.tp-batch-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.tp-batch-title { font-size: 12px; font-weight: 600; color: var(--color-text); }
.tp-batch-scope { font-size: 11px; color: var(--color-text-muted); }
.tp-batch-modes { display: flex; gap: 4px; margin-bottom: 6px; }
.tp-batch-input-row { display: flex; gap: 6px; margin-top: 4px; }
.tp-batch-input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  font-size: 12px;
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
  min-width: 0;
}
.tp-batch-input:focus { border-color: var(--color-text); }
.tp-batch-run {
  flex-shrink: 0;
  padding: 0 12px;
  height: 28px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
  cursor: pointer;
}
.tp-batch-run:hover { background: var(--color-text-secondary); }
.tp-batch-run:disabled { opacity: 0.4; cursor: not-allowed; }

/* 标签面板按钮高亮 */
.bar-icon-btn.active { color: var(--color-info); background: var(--color-info-light); }
</style>
