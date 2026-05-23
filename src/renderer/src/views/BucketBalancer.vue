<script setup>
import { computed, ref, watch } from 'vue'
import { Clipboard, Play, Save, Trash2 } from 'lucide-vue-next'
import FolderRow from '../components/FolderRow.vue'

const folderPath = ref('')
const recursive = ref(true)
const useRecommendedRange = ref(true)
const baseResolution = ref(1024)
const bucketStep = ref(16)
const batchSize = ref(4)
const minAr = ref(0.5)
const maxAr = ref(2.0)

const analyzing = ref(false)
const errorText = ref('')
const result = ref(null)
const copyState = ref('')
const activeBucketIndex = ref(null)
const selectedBucketImages = ref(new Set())
const deleting = ref(false)
const gridRef = ref(null)
const scrollTop = ref(0)
const cardHeight = 98
const gridColumnMin = 72
const gridGap = 6
const overscanRows = 8
const thumbnailMap = ref({})

const summary = computed(() => result.value?.result || null)
const buckets = computed(() => summary.value?.buckets || [])
const nonEmptyBuckets = computed(() => buckets.value.filter((bucket) => bucket.count > 0))
const tomlText = computed(() => result.value?.toml || '')
const activeBucket = computed(() => {
  if (activeBucketIndex.value === null) return nonEmptyBuckets.value[0] || null
  return (
    buckets.value.find((bucket) => bucket.index === activeBucketIndex.value) ||
    nonEmptyBuckets.value[0] ||
    null
  )
})
const selectedCount = computed(() => selectedBucketImages.value.size)
const activeBucketImages = computed(() => activeBucket.value?.images || [])
const gridColumnCount = ref(4)
const visibleRange = computed(() => {
  const rowHeight = cardHeight + gridGap
  const viewportHeight = gridRef.value?.clientHeight || 280
  const startRow = Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscanRows)
  const endRow = Math.ceil((scrollTop.value + viewportHeight) / rowHeight) + overscanRows
  const start = startRow * gridColumnCount.value
  const end = Math.min(activeBucketImages.value.length, endRow * gridColumnCount.value)
  return { start, end }
})
const visibleBucketImages = computed(() => {
  const { start, end } = visibleRange.value
  return activeBucketImages.value.slice(start, end).map((image, index) => ({
    ...image,
    virtualIndex: start + index
  }))
})

const viableRange = computed(() => {
  return summary.value ? '精确比例' : '-'
})

const arBucketText = computed(() => {
  const pairs = summary.value?.arBuckets || []
  return pairs.length ? pairs.map(([w, h]) => `${w}:${h}`).join(', ') : '-'
})

function formatNumber(value, digits = 3) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(digits) : '-'
}

function formatPercent(value) {
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '-'
}

function statusForBucket(bucket) {
  if (bucket.count === 0) return '空'
  if (bucket.count < summary.value.batchSize) return '不足'
  if (bucket.dropped > 0) return '尾数'
  return '可用'
}

function bucketBarWidth(bucket) {
  if (!bucket.count || !result.value?.totalImages) return '0%'
  return `${Math.max(4, (bucket.count / result.value.totalImages) * 100)}%`
}

function setActiveBucket(bucket) {
  activeBucketIndex.value = bucket.index
  selectedBucketImages.value = new Set()
  scrollTop.value = 0
  if (gridRef.value) gridRef.value.scrollTop = 0
}

function isImageSelected(image) {
  return selectedBucketImages.value.has(image.path)
}

function toggleImageSelection(image) {
  const next = new Set(selectedBucketImages.value)
  if (next.has(image.path)) {
    next.delete(image.path)
  } else {
    next.add(image.path)
  }
  selectedBucketImages.value = next
}

function clearImageSelection() {
  selectedBucketImages.value = new Set()
}

function selectDroppedTail() {
  const bucket = activeBucket.value
  if (!bucket?.dropped) return
  selectedBucketImages.value = new Set(
    bucket.images.slice(-bucket.dropped).map((image) => image.path)
  )
}

function thumbnailFor(image) {
  return thumbnailMap.value[image.path] || ''
}

async function loadVisibleThumbnails() {
  const missing = visibleBucketImages.value.filter((image) => !thumbnailMap.value[image.path])
  if (!missing.length) return
  const entries = await Promise.all(
    missing.map(async (image) => {
      const url = await window.api.generateThumbnail(image.path)
      return [image.path, url || image.url]
    })
  )
  thumbnailMap.value = {
    ...thumbnailMap.value,
    ...Object.fromEntries(entries)
  }
}

function updateGridMetrics() {
  if (!gridRef.value) return
  const width = gridRef.value.clientWidth || 320
  gridColumnCount.value = Math.max(1, Math.floor((width + gridGap) / (gridColumnMin + gridGap)))
}

function onBucketImageScroll(event) {
  scrollTop.value = event.target.scrollTop
  updateGridMetrics()
}

watch(
  [visibleBucketImages, activeBucketIndex],
  () => {
    loadVisibleThumbnails().catch(() => {})
  },
  { immediate: false }
)

async function chooseFolder() {
  const folder = await window.api.selectFolder()
  if (folder) folderPath.value = folder
}

async function analyze() {
  if (!folderPath.value.trim()) {
    errorText.value = '请选择训练集目录'
    return
  }

  analyzing.value = true
  errorText.value = ''
  copyState.value = ''
  try {
    const response = await window.api.analyzeTrainingBuckets({
      folderPath: folderPath.value,
      recursive: recursive.value,
      useRecommendedRange: useRecommendedRange.value,
      baseResolution: baseResolution.value,
      bucketStep: bucketStep.value,
      batchSize: batchSize.value,
      minAr: minAr.value,
      maxAr: maxAr.value
    })

    if (!response?.success) {
      result.value = null
      errorText.value = response?.error || '分析失败'
      return
    }

    result.value = response
    thumbnailMap.value = {}
    activeBucketIndex.value =
      response.result.buckets.find((bucket) => bucket.count > 0)?.index ?? null
    scrollTop.value = 0
    if (gridRef.value) gridRef.value.scrollTop = 0
    selectedBucketImages.value = new Set()
    minAr.value = Number(response.result.minAr.toFixed(3))
    maxAr.value = Number(response.result.maxAr.toFixed(3))
  } catch (err) {
    result.value = null
    thumbnailMap.value = {}
    errorText.value = err.message || '分析失败'
  } finally {
    analyzing.value = false
  }
}

async function deleteSelectedImages() {
  if (!selectedCount.value || deleting.value) return
  const ok = window.confirm(`确认将选中的 ${selectedCount.value} 张图片移动到 del 文件夹吗？`)
  if (!ok) return

  deleting.value = true
  errorText.value = ''
  try {
    const paths = [...selectedBucketImages.value]
    const results = await Promise.all(paths.map((path) => window.api.deleteImage(path)))
    const failed = results.filter((item) => !item?.success)
    if (failed.length) {
      errorText.value = `有 ${failed.length} 张图片删除失败`
      return
    }
    await analyze()
  } catch (err) {
    errorText.value = err.message || '删除失败'
  } finally {
    deleting.value = false
  }
}

async function copyToml() {
  if (!tomlText.value) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(tomlText.value)
  } else {
    const textarea = document.createElement('textarea')
    textarea.value = tomlText.value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  copyState.value = '已复制'
  window.setTimeout(() => {
    copyState.value = ''
  }, 1600)
}

async function saveToml() {
  if (!tomlText.value) return
  const response = await window.api.saveTextFile({
    defaultPath: 'dataset_bucket.toml',
    content: tomlText.value,
    filters: [
      { name: 'TOML', extensions: ['toml'] },
      { name: 'Text', extensions: ['txt'] }
    ]
  })
  if (!response?.canceled) copyState.value = '已保存'
}
</script>

<template>
  <div class="bucket-page">
    <section class="bucket-toolbar">
      <div class="bucket-folder">
        <FolderRow
          v-model="folderPath"
          label="目录"
          placeholder="选择训练集目录"
          @browse="chooseFolder"
        />
      </div>
      <div class="bucket-actions">
        <label class="bucket-check">
          <input v-model="recursive" type="checkbox" />
          <span>递归</span>
        </label>
        <button
          class="action-btn icon-action primary"
          :disabled="analyzing || !folderPath"
          @click="analyze"
        >
          <Play :size="15" />
          {{ analyzing ? '分析中' : '分析' }}
        </button>
      </div>
    </section>

    <div v-if="errorText" class="error-bar">
      <span>{{ errorText }}</span>
      <button class="error-bar-close" @click="errorText = ''">×</button>
    </div>

    <section class="bucket-config">
      <div class="config-field">
        <span>基础分辨率</span>
        <input v-model.number="baseResolution" type="number" min="64" step="64" />
      </div>
      <div class="config-field">
        <span>取整步长</span>
        <input v-model.number="bucketStep" type="number" min="1" step="1" />
      </div>
      <div class="config-field">
        <span>训练 batch</span>
        <input v-model.number="batchSize" type="number" min="1" step="1" />
      </div>
      <label class="config-toggle">
        <input v-model="useRecommendedRange" type="checkbox" />
        <span>自动范围</span>
      </label>
      <div class="config-field">
        <span>min_ar</span>
        <input
          v-model.number="minAr"
          type="number"
          min="0.01"
          step="0.001"
          :disabled="useRecommendedRange"
        />
      </div>
      <div class="config-field">
        <span>max_ar</span>
        <input
          v-model.number="maxAr"
          type="number"
          min="0.01"
          step="0.001"
          :disabled="useRecommendedRange"
        />
      </div>
    </section>

    <main v-if="summary" class="bucket-content">
      <section class="metric-strip">
        <div class="metric">
          <span>图片</span>
          <strong>{{ result.totalImages }}</strong>
        </div>
        <div class="metric">
          <span>非空桶</span>
          <strong>{{ summary.nonEmptyBucketCount }}</strong>
        </div>
        <div class="metric">
          <span>可用率</span>
          <strong>{{ formatPercent(summary.efficiency) }}</strong>
        </div>
        <div class="metric">
          <span>尾数丢弃</span>
          <strong>{{ summary.tailDroppedImages }}</strong>
        </div>
        <div class="metric">
          <span>桶模式</span>
          <strong>{{ viableRange }}</strong>
        </div>
        <div class="metric">
          <span>推荐范围</span>
          <strong
            >{{ formatNumber(result.stats.recommendedMinAr) }} -
            {{ formatNumber(result.stats.recommendedMaxAr) }}</strong
          >
        </div>
      </section>

      <section class="bucket-main">
        <div class="bucket-table-wrap">
          <div class="section-title">桶分布</div>
          <div class="bucket-table">
            <div class="table-row table-head">
              <span>桶</span>
              <span>比例</span>
              <span>尺寸</span>
              <span>AR</span>
              <span>样本</span>
              <span>可用</span>
              <span>丢弃</span>
              <span>状态</span>
            </div>
            <div
              v-for="bucket in buckets"
              :key="bucket.index"
              class="table-row"
              :class="{ muted: bucket.count === 0, active: activeBucket?.index === bucket.index }"
              @click="bucket.count > 0 && setActiveBucket(bucket)"
            >
              <span>#{{ bucket.index + 1 }}</span>
              <span>{{ bucket.ratioLabel || '-' }}</span>
              <span>{{ bucket.width }}×{{ bucket.height }}</span>
              <span>{{ formatNumber(bucket.actualAr, 4) }}</span>
              <span>
                <i class="count-bar" :style="{ width: bucketBarWidth(bucket) }"></i>
                {{ bucket.count }}
              </span>
              <span>{{ bucket.used }}</span>
              <span>{{ bucket.dropped }}</span>
              <span :class="['bucket-status', statusForBucket(bucket)]">{{
                statusForBucket(bucket)
              }}</span>
            </div>
          </div>
        </div>

        <aside class="bucket-side">
          <div class="side-section image-section">
            <div class="section-title with-actions">
              <span>{{ activeBucket ? `${activeBucket.ratioLabel} 桶图片` : '桶图片' }}</span>
              <div class="bucket-image-actions">
                <button
                  class="mini-btn"
                  :disabled="!activeBucket?.dropped"
                  @click="selectDroppedTail"
                >
                  选尾数
                </button>
                <button
                  class="mini-btn"
                  :disabled="selectedCount === 0"
                  @click="clearImageSelection"
                >
                  清空
                </button>
                <button
                  class="mini-btn danger"
                  :disabled="selectedCount === 0 || deleting"
                  @click="deleteSelectedImages"
                >
                  <Trash2 :size="13" />
                  {{ deleting ? '删除中' : `删除 ${selectedCount || ''}` }}
                </button>
              </div>
            </div>
            <div v-if="activeBucket" class="bucket-image-meta">
              <span>总数 {{ activeBucket.count }}</span>
              <span>可用 {{ activeBucket.used }}</span>
              <span>尾数 {{ activeBucket.dropped }}</span>
              <span>显示 {{ visibleRange.start + 1 }} - {{ visibleRange.end }}</span>
            </div>
            <div
              v-if="activeBucket?.images?.length"
              ref="gridRef"
              class="bucket-image-scroll"
              @scroll="onBucketImageScroll"
            >
              <div
                class="bucket-image-spacer"
                :style="{
                  height: `${Math.ceil(activeBucketImages.length / gridColumnCount) * (cardHeight + gridGap)}px`
                }"
              >
                <div
                  class="bucket-image-window"
                  :style="{
                    transform: `translateY(${Math.floor(visibleRange.start / gridColumnCount) * (cardHeight + gridGap)}px)`
                  }"
                >
                  <button
                    v-for="image in visibleBucketImages"
                    :key="image.path"
                    type="button"
                    :class="['bucket-image-card', { selected: isImageSelected(image) }]"
                    :title="`${image.name}\n${image.width}×${image.height}`"
                    @click="toggleImageSelection(image)"
                  >
                    <img
                      v-if="thumbnailFor(image)"
                      :src="thumbnailFor(image)"
                      :alt="image.name"
                      loading="lazy"
                    />
                    <span v-else class="thumb-placeholder"></span>
                    <span class="bucket-image-check"></span>
                    <span class="bucket-image-size">{{ image.width }}×{{ image.height }}</span>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="bucket-image-empty">选择一个非空桶查看图片</div>
          </div>

          <div class="side-section">
            <div class="section-title">参数</div>
            <div class="param-grid">
              <span>min_ar</span><strong>{{ formatNumber(summary.minAr) }}</strong>
              <span>max_ar</span><strong>{{ formatNumber(summary.maxAr) }}</strong>
              <span>num_ar_buckets</span><strong>{{ summary.numArBuckets }}</strong>
              <span>ar_buckets</span><strong>{{ arBucketText }}</strong> <span>resolutions</span
              ><strong>[{{ summary.baseResolution }}]</strong> <span>frame_buckets</span
              ><strong>[1]</strong>
            </div>
          </div>

          <div class="side-section toml-section">
            <div class="section-title with-actions">
              <span>TOML</span>
              <div class="toml-actions">
                <button class="bar-icon-btn" title="复制" @click="copyToml">
                  <Clipboard :size="15" />
                </button>
                <button class="bar-icon-btn" title="保存" @click="saveToml">
                  <Save :size="15" />
                </button>
              </div>
            </div>
            <pre class="toml-box">{{ tomlText }}</pre>
            <span v-if="copyState" class="copy-state">{{ copyState }}</span>
          </div>
        </aside>
      </section>
    </main>

    <div v-else class="bucket-empty">
      <span>选择目录后开始分析</span>
    </div>
  </div>
</template>

<style scoped>
.bucket-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 0;
  overflow: hidden;
}

.bucket-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 12px;
  border-bottom: none;
  flex-shrink: 0;
}

.bucket-folder {
  flex: 1;
  min-width: 0;
}

.bucket-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.icon-action {
  gap: 6px;
}

.icon-action.primary {
  color: var(--color-active-text);
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
}

.bucket-check,
.config-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  user-select: none;
}

.bucket-config {
  display: grid;
  grid-template-columns: repeat(6, minmax(92px, 1fr));
  gap: 8px;
  flex-shrink: 0;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.config-field span {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.config-field input {
  width: 100%;
  height: 30px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  background: var(--color-input-bg);
  font-size: 12px;
  outline: none;
}

.config-field input:focus {
  border-color: var(--color-text);
}

.config-field input:disabled {
  color: var(--color-text-muted);
  background: var(--color-surface-soft);
}

.config-toggle {
  height: 30px;
  align-self: end;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.bucket-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.metric-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(110px, 1fr));
  gap: 8px;
  flex-shrink: 0;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.metric span {
  font-size: 11px;
  color: var(--color-text-muted);
}

.metric strong {
  font-size: 15px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bucket-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 10px;
}

.bucket-table-wrap,
.bucket-side {
  min-height: 0;
}

.section-title {
  height: 28px;
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.section-title.with-actions {
  justify-content: space-between;
}

.bucket-table {
  height: calc(100% - 28px);
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.table-row {
  display: grid;
  grid-template-columns: 52px 70px 120px 86px minmax(96px, 1fr) 76px 76px 72px;
  min-height: 34px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid var(--color-border-light);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.table-row:not(.table-head) {
  cursor: pointer;
}

.table-row:not(.table-head):hover,
.table-row.active {
  background: var(--color-surface-hover);
}

.table-row:last-child {
  border-bottom: none;
}

.table-head {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 32px;
  color: var(--color-text);
  font-weight: 600;
  background: var(--color-background-soft);
}

.table-row.muted {
  color: var(--color-text-muted);
}

.count-bar {
  display: inline-block;
  height: 4px;
  max-width: 72px;
  margin-right: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  vertical-align: middle;
}

.bucket-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  background: var(--color-surface-soft);
}

.bucket-status.可用 {
  color: #166534;
  background: rgba(34, 197, 94, 0.14);
}

.bucket-status.尾数 {
  color: #92400e;
  background: rgba(245, 158, 11, 0.16);
}

.bucket-status.不足 {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.14);
}

.bucket-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.side-section {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  padding: 10px 12px 12px;
}

.param-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 12px;
  font-size: 12px;
}

.param-grid span {
  color: var(--color-text-muted);
}

.param-grid strong {
  color: var(--color-text);
  font-weight: 600;
}

.image-section {
  min-height: 280px;
  max-height: 42%;
  display: flex;
  flex-direction: column;
}

.bucket-image-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.mini-btn:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.mini-btn.danger:hover:not(:disabled) {
  color: var(--color-error);
  background: var(--color-error-light);
}

.mini-btn:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.bucket-image-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 0 8px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.bucket-image-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.bucket-image-spacer {
  position: relative;
  min-height: 100%;
}

.bucket-image-window {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  grid-auto-rows: 92px;
  gap: 6px;
  position: absolute;
  left: 0;
  right: 2px;
  top: 0;
}

.bucket-image-card {
  position: relative;
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  padding: 0;
  overflow: hidden;
  background: var(--color-background-mute);
  cursor: pointer;
}

.bucket-image-card:hover {
  border-color: var(--color-border-hover);
}

.bucket-image-card.selected {
  border-color: var(--color-active-bg);
}

.bucket-image-card img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.thumb-placeholder {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--color-background-mute);
}

.bucket-image-check {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 14px;
  height: 14px;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.32);
}

.bucket-image-card.selected .bucket-image-check {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
}

.bucket-image-card.selected .bucket-image-check::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0px;
  width: 4px;
  height: 8px;
  border: solid var(--color-active-text);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.bucket-image-size {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 12px 4px 3px;
  color: #fff;
  font-size: 10px;
  text-align: center;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.62));
}

.bucket-image-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 12px;
}

.toml-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.toml-actions {
  display: flex;
  gap: 2px;
}

.toml-box {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.copy-state {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 12px;
}

.bucket-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

@media (max-width: 1180px) {
  .bucket-config {
    grid-template-columns: repeat(5, minmax(92px, 1fr));
  }

  .metric-strip {
    grid-template-columns: repeat(3, minmax(110px, 1fr));
  }

  .bucket-main {
    grid-template-columns: 1fr;
  }

  .bucket-side {
    min-height: 360px;
  }
}
</style>
