<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  Eraser,
  ExternalLink,
  FolderOpen,
  ImagePlus,
  RefreshCw,
  Search,
  X
} from 'lucide-vue-next'
import FolderRow from '../components/FolderRow.vue'
import IconButton from '../components/IconButton.vue'
import { useLocalStorage } from '../composables/useLocalStorage'

defineOptions({ name: 'ImageGrab' })

const tabs = [
  { key: 'booru', label: 'Booru' },
  { key: 'pixiv', label: 'Pixiv' },
  { key: 'twitter', label: 'Twitter/X' },
  { key: 'generic', label: '通用工具' }
]

const booruSites = [
  { value: 'danbooru', label: 'Danbooru' },
  { value: 'gelbooru', label: 'Gelbooru' },
  { value: 'safebooru', label: 'Safebooru' },
  { value: 'yande', label: 'Yande.re' },
  { value: 'konachan', label: 'Konachan' },
  { value: 'sakugabooru', label: 'Sakugabooru' }
]

const ratingOptions = [
  { value: 'all', label: 'All' },
  { value: 'safe', label: 'Safe' },
  { value: 'nsfw', label: 'NSFW' }
]

const pixivModes = [
  { value: 'user', label: '用户' },
  { value: 'search', label: 'Tag' }
]

const ugoiraOptions = [
  { value: 'skip', label: '跳过' },
  { value: 'zip', label: '保存 ZIP' }
]

const typeOptions = [
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WEBP' },
  { value: 'gif', label: 'GIF' },
  { value: 'bmp', label: 'BMP' },
  { value: 'tiff', label: 'TIFF' },
  { value: 'avif', label: 'AVIF' }
]

const activeTab = useLocalStorage('image-grab-active-tab', 'booru')
const outputFolder = useLocalStorage('image-grab-output-folder', '')

const booruSite = useLocalStorage('image-grab-booru-site', 'danbooru')
if (!booruSites.some((item) => item.value === booruSite.value)) booruSite.value = 'danbooru'
const booruTags = useLocalStorage('image-grab-booru-tags', 'original')
const booruLimit = useLocalStorage('image-grab-booru-limit', 500, { type: 'number' })
const booruPerPage = useLocalStorage('image-grab-booru-per-page', 100, { type: 'number' })
const booruMinScore = useLocalStorage('image-grab-booru-min-score', 0, { type: 'number' })
const booruRating = useLocalStorage('image-grab-booru-rating', 'all')
const booruFilterAi = useLocalStorage('image-grab-booru-filter-ai', true, { type: 'boolean' })
const booruOnlyOriginal = useLocalStorage('image-grab-booru-only-original', true, {
  type: 'boolean'
})
const booruWriteTxt = useLocalStorage('image-grab-booru-write-txt', true, { type: 'boolean' })
const booruResume = useLocalStorage('image-grab-booru-resume', true, { type: 'boolean' })

const pixivCookie = useLocalStorage('image-grab-pixiv-cookie', '')
const pixivMode = useLocalStorage('image-grab-pixiv-mode', 'user')
if (!pixivModes.some((item) => item.value === pixivMode.value)) pixivMode.value = 'user'
const pixivQuery = useLocalStorage('image-grab-pixiv-query', '')
const pixivLimit = useLocalStorage('image-grab-pixiv-limit', 48, { type: 'number' })
const pixivMinBookmarks = useLocalStorage('image-grab-pixiv-min-bookmarks', 0, { type: 'number' })
const pixivStartPage = useLocalStorage('image-grab-pixiv-start-page', 1, { type: 'number' })
const pixivEndPage = useLocalStorage('image-grab-pixiv-end-page', 1, { type: 'number' })
const pixivUgoira = useLocalStorage('image-grab-pixiv-ugoira', 'skip')
const pixivResume = useLocalStorage('image-grab-pixiv-resume', true, { type: 'boolean' })

const twitterCookie = useLocalStorage('image-grab-twitter-cookie', '')
const twitterQuery = useLocalStorage('image-grab-twitter-query', '')
const twitterLimit = useLocalStorage('image-grab-twitter-limit', 100, { type: 'number' })
const twitterIncludeVideo = useLocalStorage('image-grab-twitter-include-video', false, {
  type: 'boolean'
})
const twitterResume = useLocalStorage('image-grab-twitter-resume', true, { type: 'boolean' })

const sourceText = useLocalStorage('image-grab-sources', '')
const includeSrcset = useLocalStorage('image-grab-include-srcset', true, { type: 'boolean' })
const maxPerSource = useLocalStorage('image-grab-max-per-source', 120, { type: 'number' })
const selectedTypes = ref(new Set(typeOptions.map((item) => item.value)))

const candidates = ref([])
const selected = ref(new Set())
const searchText = ref('')
const previewItem = ref(null)
const scanWarnings = ref([])
const taskError = ref('')
const taskResult = ref(null)
const genericStatus = ref('')
const booruSiteDropOpen = ref(false)
const siteRunning = ref(false)
const scanning = ref(false)
const downloading = ref(false)
const taskDone = ref(0)
const taskTotal = ref(0)
const taskCurrent = ref('')
const taskStage = ref('')

let removeProgressListener = null

const sourceLines = computed(() =>
  sourceText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
)

const isBusy = computed(() => siteRunning.value || scanning.value || downloading.value)
const selectedCount = computed(() => selected.value.size)
const savedCount = computed(() => candidates.value.filter((item) => item.status === 'saved').length)
const failedCount = computed(
  () => candidates.value.filter((item) => item.status === 'failed').length
)

const activeBooruLabel = computed(
  () => booruSites.find((item) => item.value === booruSite.value)?.label || 'Booru'
)
const pixivQueryLabel = computed(() => (pixivMode.value === 'search' ? 'Tag' : '用户 ID / URL'))
const canRunSiteTask = computed(() => {
  if (isBusy.value || !outputFolder.value) return false
  if (activeTab.value === 'booru') return !!booruSite.value && !!booruTags.value.trim()
  if (activeTab.value === 'pixiv') return !!pixivCookie.value.trim() && !!pixivQuery.value.trim()
  if (activeTab.value === 'twitter')
    return !!twitterCookie.value.trim() && !!twitterQuery.value.trim()
  return false
})

const canScanGeneric = computed(
  () => sourceLines.value.length > 0 && selectedTypes.value.size > 0 && !isBusy.value
)
const canDownloadGeneric = computed(() => selectedCount.value > 0 && !isBusy.value)

const filteredCandidates = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return candidates.value
  return candidates.value.filter((item) => {
    return [item.filename, item.type, item.url, item.source, item.error].some((value) =>
      String(value || '')
        .toLowerCase()
        .includes(keyword)
    )
  })
})

const allVisibleSelected = computed(() => {
  if (filteredCandidates.value.length === 0) return false
  return filteredCandidates.value.every((item) => selected.value.has(item.id))
})

const progressWidth = computed(() => {
  if (!taskTotal.value) return '0%'
  return `${Math.min(100, Math.round((taskDone.value / taskTotal.value) * 100))}%`
})

const taskLabel = computed(() => {
  if (siteRunning.value) return taskStage.value === 'collect' ? '收集' : '下载'
  if (scanning.value) return '扫描'
  if (downloading.value) return '保存'
  return ''
})

const skipReasonText = computed(() => {
  const reasons = taskResult.value?.skip_reasons || {}
  const labels = {
    bookmarks: '收藏不足',
    resume: '断点已存在',
    'ugoira skipped': '跳过动图',
    'ugoira zip url missing': '动图 ZIP 缺失',
    'original url missing': '原图地址缺失',
    other: '其它'
  }
  return Object.entries(reasons)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${labels[key] || key} ${count}`)
    .join('，')
})

onMounted(() => {
  document.addEventListener('click', closeOpenSelects)
  removeProgressListener = window.api.onTaskProgress((data) => {
    if (!String(data?.scope || '').startsWith('grab-')) return
    taskDone.value = data.done || 0
    taskTotal.value = data.total || 0
    taskCurrent.value = data.current || ''
    taskStage.value = data.stage || ''
  })
})

onUnmounted(() => {
  document.removeEventListener('click', closeOpenSelects)
  if (removeProgressListener) removeProgressListener()
})

function resetTaskProgress() {
  taskDone.value = 0
  taskTotal.value = 0
  taskCurrent.value = ''
  taskStage.value = ''
}

function setError(error, fallback) {
  taskError.value = typeof error === 'string' ? error : error?.error || error?.message || fallback
}

async function chooseOutputFolder() {
  const folder = await window.api.selectFolder()
  if (folder) outputFolder.value = folder
}

async function ensureOutputFolder() {
  if (outputFolder.value) return outputFolder.value
  const folder = await window.api.selectFolder()
  if (!folder) return ''
  outputFolder.value = folder
  return folder
}

function selectTab(tab) {
  if (isBusy.value) return
  activeTab.value = tab
  taskError.value = ''
  closeOpenSelects()
}

function closeOpenSelects() {
  booruSiteDropOpen.value = false
}

function toggleBooruSiteSelect() {
  if (isBusy.value) return
  booruSiteDropOpen.value = !booruSiteDropOpen.value
}

function selectBooruSite(value) {
  booruSite.value = value
  booruSiteDropOpen.value = false
}

function toggleType(type) {
  const next = new Set(selectedTypes.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  selectedTypes.value = next
}

function toggleSelect(item) {
  const next = new Set(selected.value)
  if (next.has(item.id)) next.delete(item.id)
  else next.add(item.id)
  selected.value = next
}

function toggleSelectAllVisible() {
  const visibleIds = filteredCandidates.value.map((item) => item.id)
  const next = new Set(selected.value)
  if (allVisibleSelected.value) visibleIds.forEach((id) => next.delete(id))
  else visibleIds.forEach((id) => next.add(id))
  selected.value = next
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

function sourceName(item) {
  return hostOf(item.source || item.url)
}

function typeLabel(item) {
  return item.type ? item.type.toUpperCase() : 'IMG'
}

function clearGenericResults() {
  candidates.value = []
  selected.value = new Set()
  scanWarnings.value = []
  taskError.value = ''
  genericStatus.value = ''
  searchText.value = ''
  resetTaskProgress()
}

function previewSource(item) {
  return item?.previewUrl || item?.url || ''
}

async function loadCandidatePreview(item) {
  if (!item || item.previewUrl || item.previewLoading || item.previewError) return

  item.previewLoading = true
  try {
    const result = await window.api.loadGrabPreview({
      url: item.url,
      source: item.source
    })
    if (result.success && result.dataUrl) {
      item.previewUrl = result.dataUrl
      item.previewError = ''
    } else {
      item.previewError = result.error || '预览加载失败'
    }
  } catch (err) {
    item.previewError = err.message || '预览加载失败'
  } finally {
    item.previewLoading = false
  }
}

async function warmCandidatePreviews(items) {
  const targets = items.slice(0, 30)
  let index = 0
  async function worker() {
    while (index < targets.length) {
      const item = targets[index]
      index += 1
      await loadCandidatePreview(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
}

function buildSitePayload(folder) {
  if (activeTab.value === 'twitter') {
    return {
      site: 'twitter',
      output_dir: folder,
      cookie: twitterCookie.value.trim(),
      query: twitterQuery.value.trim(),
      limit: Math.max(1, twitterLimit.value || 1),
      include_video: twitterIncludeVideo.value,
      enable_resume: twitterResume.value
    }
  }

  if (activeTab.value === 'pixiv') {
    return {
      site: 'pixiv',
      output_dir: folder,
      cookie: pixivCookie.value.trim(),
      mode: pixivMode.value,
      query: pixivQuery.value.trim(),
      limit: Math.max(1, pixivLimit.value || 1),
      min_bookmarks: Math.max(0, pixivMinBookmarks.value || 0),
      start_page: Math.max(1, pixivStartPage.value || 1),
      end_page: Math.max(
        pixivStartPage.value || 1,
        pixivEndPage.value || pixivStartPage.value || 1
      ),
      ugoira: pixivUgoira.value,
      enable_resume: pixivResume.value
    }
  }

  return {
    site: booruSite.value,
    output_dir: folder,
    tags: booruTags.value.trim(),
    limit: Math.max(1, booruLimit.value || 1),
    per_page: Math.max(1, booruPerPage.value || 1),
    min_score: booruMinScore.value || 0,
    rating: booruRating.value,
    filter_ai: booruFilterAi.value,
    only_original: booruOnlyOriginal.value,
    write_txt: booruWriteTxt.value,
    enable_resume: booruResume.value
  }
}

async function runSiteDownload() {
  const folder = await ensureOutputFolder()
  if (!folder || !canRunSiteTask.value) return

  siteRunning.value = true
  taskError.value = ''
  taskResult.value = null
  genericStatus.value = ''
  resetTaskProgress()

  try {
    const result = await window.api.callPython('/grab-download', buildSitePayload(folder))
    if (result.aborted) {
      taskResult.value = { ...result, title: '任务已终止' }
      return
    }
    if (!result.success) {
      setError(result, '抓取失败')
      taskResult.value = result
      return
    }
    taskResult.value = {
      ...result,
      title:
        activeTab.value === 'pixiv'
          ? 'Pixiv 下载完成'
          : activeTab.value === 'twitter'
            ? 'Twitter/X 下载完成'
            : `${activeBooruLabel.value} 下载完成`
    }
  } catch (err) {
    setError(err, '抓取失败')
  } finally {
    siteRunning.value = false
  }
}

async function scanSources() {
  if (!canScanGeneric.value) return
  scanning.value = true
  taskError.value = ''
  genericStatus.value = ''
  scanWarnings.value = []
  resetTaskProgress()

  try {
    const result = await window.api.scanImageSources({
      sources: sourceLines.value,
      include_srcset: includeSrcset.value,
      file_types: [...selectedTypes.value],
      max_per_source: Math.max(1, Math.min(maxPerSource.value || 120, 500))
    })

    if (result.aborted) {
      genericStatus.value = '扫描已终止'
      return
    }

    if (!result.success) {
      setError(result, '扫描失败')
      candidates.value = result.items || []
      selected.value = new Set(candidates.value.map((item) => item.id))
      scanWarnings.value = result.errors || []
      return
    }

    candidates.value = (result.items || []).map((item) => ({
      ...item,
      status: '',
      error: '',
      localPath: '',
      previewUrl: '',
      previewLoading: false,
      previewError: ''
    }))
    selected.value = new Set(candidates.value.map((item) => item.id))
    scanWarnings.value = result.errors || []
    genericStatus.value = `发现 ${candidates.value.length} 张图片`
    warmCandidatePreviews(candidates.value).catch(() => {})
  } catch (err) {
    setError(err, '扫描失败')
  } finally {
    scanning.value = false
  }
}

async function downloadSelected() {
  if (!canDownloadGeneric.value) return

  const folder = await ensureOutputFolder()
  if (!folder) return

  downloading.value = true
  taskError.value = ''
  genericStatus.value = ''
  resetTaskProgress()

  const items = candidates.value.filter((item) => selected.value.has(item.id))

  try {
    const result = await window.api.downloadGrabImages({
      output_dir: folder,
      items
    })

    if (result.aborted) {
      genericStatus.value = '保存已终止'
      applyDownloadResults(result.results || [])
      return
    }

    applyDownloadResults(result.results || [])

    if (!result.success) {
      setError(result, '保存失败')
      return
    }

    genericStatus.value = `已保存 ${result.saved || 0} 张${result.failed ? `，失败 ${result.failed} 张` : ''}`
  } catch (err) {
    setError(err, '保存失败')
  } finally {
    downloading.value = false
  }
}

function applyDownloadResults(results) {
  const byId = new Map(results.map((item) => [item.id, item]))
  candidates.value = candidates.value.map((item) => {
    const result = byId.get(item.id)
    if (!result) return item
    return {
      ...item,
      status: result.success ? 'saved' : 'failed',
      filename: result.filename || item.filename,
      localPath: result.path || item.localPath || '',
      error: result.error || ''
    }
  })
}

async function abortTask() {
  await window.api.abortTask()
  siteRunning.value = false
  scanning.value = false
  downloading.value = false
  resetTaskProgress()
}

function openPreview(item) {
  previewItem.value = item
  loadCandidatePreview(item)
}

function closePreview() {
  previewItem.value = null
}

function openExternal(item) {
  window.open(item.url, '_blank')
}
</script>

<template>
  <div class="grab-page">
    <div class="site-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        :class="['site-tab-btn', `tab-${tab.key}`, { active: activeTab === tab.key }]"
        :disabled="isBusy"
        @click="selectTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="activeTab === 'booru'" class="site-workbench">
      <section class="source-panel">
        <div class="section-title">
          <ImagePlus :size="17" />
          <span>Booru 参数</span>
        </div>
        <div class="form-grid">
          <div class="field">
            <span>站点</span>
            <div class="grab-select">
              <button
                class="grab-select-trigger"
                type="button"
                :disabled="isBusy"
                @click.stop="toggleBooruSiteSelect"
              >
                <span>{{ activeBooruLabel }}</span>
                <ChevronDown
                  :class="['grab-select-arrow', { open: booruSiteDropOpen }]"
                  :size="15"
                />
              </button>
              <Transition name="dropdown">
                <div v-if="booruSiteDropOpen" class="grab-select-list" @click.stop>
                  <button
                    v-for="site in booruSites"
                    :key="site.value"
                    type="button"
                    :class="['grab-select-item', { active: booruSite === site.value }]"
                    @click="selectBooruSite(site.value)"
                  >
                    {{ site.label }}
                  </button>
                </div>
              </Transition>
            </div>
          </div>
          <label class="field wide">
            <span>Tags</span>
            <input v-model="booruTags" class="field-input" type="text" spellcheck="false" />
          </label>
          <label class="field">
            <span>数量</span>
            <input v-model.number="booruLimit" class="field-input" type="number" min="1" />
          </label>
          <label class="field">
            <span>每页</span>
            <input
              v-model.number="booruPerPage"
              class="field-input"
              type="number"
              min="1"
              max="320"
            />
          </label>
          <label class="field">
            <span>最低分</span>
            <input v-model.number="booruMinScore" class="field-input" type="number" />
          </label>
          <div class="field">
            <span>Rating</span>
            <div class="segmented">
              <button
                v-for="item in ratingOptions"
                :key="item.value"
                type="button"
                :class="[
                  'segment-btn',
                  `rating-${item.value}`,
                  { active: booruRating === item.value }
                ]"
                @click="booruRating = item.value"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </div>
        <div class="option-row">
          <label class="option-toggle" @click="booruFilterAi = !booruFilterAi">
            <span :class="['toggle-switch', { on: booruFilterAi }]"
              ><span class="toggle-knob"></span
            ></span>
            过滤 AI
          </label>
          <label class="option-toggle" @click="booruOnlyOriginal = !booruOnlyOriginal">
            <span :class="['toggle-switch', { on: booruOnlyOriginal }]"
              ><span class="toggle-knob"></span
            ></span>
            原图
          </label>
          <label class="option-toggle" @click="booruWriteTxt = !booruWriteTxt">
            <span :class="['toggle-switch', { on: booruWriteTxt }]"
              ><span class="toggle-knob"></span
            ></span>
            生成 TXT
          </label>
          <label class="option-toggle" @click="booruResume = !booruResume">
            <span :class="['toggle-switch', { on: booruResume }]"
              ><span class="toggle-knob"></span
            ></span>
            断点
          </label>
        </div>
      </section>

      <section class="target-panel">
        <div class="section-title">
          <FolderOpen :size="17" />
          <span>保存位置</span>
        </div>
        <FolderRow
          v-model="outputFolder"
          label="输出"
          placeholder="选择根目录"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
        <button
          class="primary-btn"
          type="button"
          :disabled="!canRunSiteTask"
          @click="runSiteDownload"
        >
          <Download :size="15" />
          <span>{{ siteRunning ? '下载中' : '开始下载' }}</span>
        </button>
      </section>
    </div>

    <div v-else-if="activeTab === 'pixiv'" class="site-workbench">
      <section class="source-panel">
        <div class="section-title">
          <ImagePlus :size="17" />
          <span>Pixiv 参数</span>
        </div>
        <div class="form-grid pixiv-grid">
          <div class="field">
            <span>入口</span>
            <div class="segmented">
              <button
                v-for="item in pixivModes"
                :key="item.value"
                type="button"
                :class="['segment-btn', { active: pixivMode === item.value }]"
                @click="pixivMode = item.value"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
          <label class="field wide">
            <span>{{ pixivQueryLabel }}</span>
            <input v-model="pixivQuery" class="field-input" type="text" spellcheck="false" />
          </label>
          <label class="field">
            <span>数量</span>
            <input v-model.number="pixivLimit" class="field-input" type="number" min="1" />
          </label>
          <label class="field">
            <span>最低收藏</span>
            <input v-model.number="pixivMinBookmarks" class="field-input" type="number" min="0" />
          </label>
          <label class="field">
            <span>起始页</span>
            <input v-model.number="pixivStartPage" class="field-input" type="number" min="1" />
          </label>
          <label class="field">
            <span>结束页</span>
            <input v-model.number="pixivEndPage" class="field-input" type="number" min="1" />
          </label>
          <div class="field">
            <span>动图</span>
            <div class="segmented">
              <button
                v-for="item in ugoiraOptions"
                :key="item.value"
                type="button"
                :class="['segment-btn', { active: pixivUgoira === item.value }]"
                @click="pixivUgoira = item.value"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </div>
        <label class="field cookie-field">
          <span>Cookie</span>
          <textarea v-model="pixivCookie" class="cookie-input" spellcheck="false"></textarea>
        </label>
        <div class="option-row">
          <label class="option-toggle" @click="pixivResume = !pixivResume">
            <span :class="['toggle-switch', { on: pixivResume }]"
              ><span class="toggle-knob"></span
            ></span>
            断点
          </label>
        </div>
      </section>

      <section class="target-panel">
        <div class="section-title">
          <FolderOpen :size="17" />
          <span>保存位置</span>
        </div>
        <FolderRow
          v-model="outputFolder"
          label="输出"
          placeholder="选择根目录"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
        <button
          class="primary-btn"
          type="button"
          :disabled="!canRunSiteTask"
          @click="runSiteDownload"
        >
          <Download :size="15" />
          <span>{{ siteRunning ? '下载中' : '开始下载' }}</span>
        </button>
      </section>
    </div>

    <div v-else-if="activeTab === 'twitter'" class="site-workbench">
      <section class="source-panel">
        <div class="section-title">
          <ImagePlus :size="17" />
          <span>Twitter/X 参数</span>
        </div>
        <div class="form-grid twitter-grid">
          <label class="field wide">
            <span>用户</span>
            <input
              v-model="twitterQuery"
              class="field-input"
              type="text"
              spellcheck="false"
              placeholder="@username / x.com/username"
            />
          </label>
          <label class="field">
            <span>数量</span>
            <input v-model.number="twitterLimit" class="field-input" type="number" min="1" />
          </label>
        </div>
        <label class="field cookie-field">
          <span>Cookie / JSON</span>
          <textarea
            v-model="twitterCookie"
            class="cookie-input"
            spellcheck="false"
            placeholder="支持 a=b; c=d 或浏览器扩展导出的 JSON cookies"
          ></textarea>
        </label>
        <div class="option-row">
          <label class="option-toggle" @click="twitterIncludeVideo = !twitterIncludeVideo">
            <span :class="['toggle-switch', { on: twitterIncludeVideo }]"
              ><span class="toggle-knob"></span
            ></span>
            包含视频/GIF
          </label>
          <label class="option-toggle" @click="twitterResume = !twitterResume">
            <span :class="['toggle-switch', { on: twitterResume }]"
              ><span class="toggle-knob"></span
            ></span>
            断点
          </label>
        </div>
      </section>

      <section class="target-panel">
        <div class="section-title">
          <FolderOpen :size="17" />
          <span>保存位置</span>
        </div>
        <FolderRow
          v-model="outputFolder"
          label="输出"
          placeholder="选择根目录"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
        <button
          class="primary-btn"
          type="button"
          :disabled="!canRunSiteTask"
          @click="runSiteDownload"
        >
          <Download :size="15" />
          <span>{{ siteRunning ? '下载中' : '开始下载' }}</span>
        </button>
      </section>
    </div>

    <div v-else class="site-workbench">
      <section class="source-panel">
        <div class="source-header">
          <div class="section-title">
            <ImagePlus :size="17" />
            <span>抓取来源</span>
          </div>
          <span class="source-count">{{ sourceLines.length }} 个 URL</span>
        </div>
        <textarea
          v-model="sourceText"
          class="source-input"
          spellcheck="false"
          placeholder="https://example.com/page&#10;https://example.com/image.jpg"
        ></textarea>
        <div class="grab-options">
          <div class="type-options">
            <button
              v-for="type in typeOptions"
              :key="type.value"
              type="button"
              :class="['type-chip', { active: selectedTypes.has(type.value) }]"
              @click="toggleType(type.value)"
            >
              {{ type.label }}
            </button>
          </div>
          <label class="option-toggle" @click="includeSrcset = !includeSrcset">
            <span :class="['toggle-switch', { on: includeSrcset }]"
              ><span class="toggle-knob"></span
            ></span>
            srcset
          </label>
          <label class="limit-field">
            <span>上限</span>
            <input v-model.number="maxPerSource" type="number" min="1" max="500" />
          </label>
        </div>
      </section>

      <section class="target-panel">
        <div class="section-title">
          <FolderOpen :size="17" />
          <span>保存位置</span>
        </div>
        <FolderRow
          v-model="outputFolder"
          label="输出"
          placeholder="选择图片保存目录"
          @commit="
            (path) => {
              outputFolder = path
            }
          "
          @browse="chooseOutputFolder"
        />
        <div class="grab-actions">
          <button
            class="primary-btn"
            type="button"
            :disabled="!canScanGeneric"
            @click="scanSources"
          >
            <Search :size="15" />
            <span>{{ scanning ? '扫描中' : '扫描' }}</span>
          </button>
          <button
            class="action-btn icon-action"
            type="button"
            :disabled="!canDownloadGeneric"
            @click="downloadSelected"
          >
            <Download :size="15" />
            <span>{{ downloading ? '保存中' : '保存选中' }}</span>
          </button>
        </div>
      </section>
    </div>

    <div v-if="taskError" class="error-bar grab-message">
      <AlertCircle :size="15" />
      <span>{{ taskError }}</span>
      <button class="error-bar-close" type="button" @click="taskError = ''">×</button>
    </div>

    <div v-if="scanWarnings.length > 0 && activeTab === 'generic'" class="warning-strip">
      <AlertCircle :size="15" />
      <span>{{ scanWarnings.length }} 个来源未完成</span>
      <span class="warning-detail">{{ scanWarnings[0].source }}：{{ scanWarnings[0].error }}</span>
    </div>

    <div v-if="isBusy" class="grab-status-bar">
      <span class="status-progress">
        <span class="progress-bar-track">
          <span class="progress-bar-fill" :style="{ width: progressWidth }"></span>
        </span>
        <span class="progress-text" :title="taskCurrent"
          >{{ taskLabel }} {{ taskDone }} / {{ taskTotal }}</span
        >
        <button class="stop-task-btn" type="button" title="停止下载" @click="abortTask">
          <X :size="14" />
          <span>停止下载</span>
        </button>
      </span>
    </div>

    <div v-if="taskResult && !isBusy" class="task-summary">
      <div class="task-summary-title">
        <CheckCircle2 :size="16" />
        <span>{{ taskResult.title || '任务完成' }}</span>
      </div>
      <div class="task-metrics">
        <span class="metric">下载 {{ taskResult.downloaded || 0 }}</span>
        <span class="metric">跳过 {{ taskResult.skipped || 0 }}</span>
        <span class="metric">失败 {{ taskResult.failed || 0 }}</span>
      </div>
      <div v-if="taskResult.output_dir" class="task-output">{{ taskResult.output_dir }}</div>
      <div v-if="skipReasonText" class="task-output">跳过原因：{{ skipReasonText }}</div>
      <div v-if="taskResult.errors?.length" class="task-errors">{{ taskResult.errors[0] }}</div>
    </div>

    <template v-if="activeTab === 'generic'">
      <div v-if="candidates.length > 0" class="grab-status-bar">
        <label class="select-all-label" @click="toggleSelectAllVisible">
          <span :class="['checkbox', { checked: allVisibleSelected }]"></span>
          全选
        </label>

        <div class="bar-btn-group">
          <IconButton
            :icon="RefreshCw"
            :spinning="scanning"
            title="重新扫描"
            :disabled="isBusy || sourceLines.length === 0"
            @click="scanSources"
          />
          <IconButton
            :icon="Eraser"
            title="清空结果"
            :disabled="isBusy"
            @click="clearGenericResults"
          />
        </div>

        <span class="status-text">
          共 {{ candidates.length }} 张，已选 {{ selectedCount }} 张，已保存
          {{ savedCount }} 张<span v-if="failedCount">，失败 {{ failedCount }} 张</span>
        </span>

        <div class="result-search">
          <Search :size="14" />
          <input v-model="searchText" type="text" placeholder="筛选结果" />
        </div>
      </div>

      <div v-if="genericStatus && !isBusy" class="status-strip">
        <CheckCircle2 :size="15" />
        <span>{{ genericStatus }}</span>
      </div>

      <div v-if="filteredCandidates.length > 0" class="image-grid grab-grid">
        <div
          v-for="item in filteredCandidates"
          :key="item.id"
          :class="[
            'image-card grab-card',
            {
              selected: selected.has(item.id),
              saved: item.status === 'saved',
              failed: item.status === 'failed'
            }
          ]"
          @click="openPreview(item)"
        >
          <img
            :src="previewSource(item)"
            :alt="item.filename"
            draggable="false"
            @error.stop="loadCandidatePreview(item)"
          />
          <div class="image-name-overlay">{{ item.filename }}</div>
          <span class="source-badge">{{ sourceName(item) }}</span>
          <span class="type-badge">{{ typeLabel(item) }}</span>
          <span v-if="item.status === 'saved'" class="result-badge saved">已保存</span>
          <span v-else-if="item.status === 'failed'" class="result-badge failed">失败</span>
          <span
            :class="['checkbox', { checked: selected.has(item.id) }]"
            @click.stop="toggleSelect(item)"
          ></span>
        </div>
      </div>

      <div v-else class="empty-state">
        <span class="empty-text">{{
          candidates.length ? '没有匹配的图片' : '输入 URL 后开始扫描'
        }}</span>
      </div>
    </template>

    <div v-else class="empty-state direct-empty">
      <span class="empty-text">填写参数后开始下载</span>
    </div>

    <Teleport to="body">
      <Transition name="preview-fade">
        <div v-if="previewItem" class="preview-overlay" @click="closePreview">
          <img
            :src="previewSource(previewItem)"
            :alt="previewItem.filename"
            class="preview-img"
            @error.stop="loadCandidatePreview(previewItem)"
          />
          <div class="grab-preview-info" @click.stop>
            <div class="preview-title">{{ previewItem.filename }}</div>
            <div class="preview-url">{{ previewItem.url }}</div>
            <div v-if="previewItem.error" class="preview-error">{{ previewItem.error }}</div>
            <button class="preview-open-btn" type="button" @click="openExternal(previewItem)">
              <ExternalLink :size="14" />
              打开链接
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.grab-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 8px 0 0;
}

.site-tabs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  flex-shrink: 0;
}

.site-tabs::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--pjsk-page-divider-size);
  background: var(--pjsk-divider-gradient-x);
}

[data-theme='dark'] .site-tabs::after {
  opacity: 0.9;
}

.site-tab-btn {
  width: var(--ui-nav-button-width);
  height: var(--ui-nav-button-height);
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.site-tab-btn:hover:not(:disabled) {
  border-color: var(--color-border-hover);
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.site-tab-btn.active {
  border-color: var(--color-active-bg);
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

.site-tab-btn.tab-twitter.active {
  border-color: #0f1419;
  background: #0f1419;
  color: #ffffff;
}

/* Pixiv 品牌蓝 */
.site-tab-btn.tab-pixiv.active {
  border-color: #0096fa;
  background: #0096fa;
  color: #ffffff;
}

/* Booru 暖橙 */
.site-tab-btn.tab-booru.active {
  border-color: #ee8b2c;
  background: #ee8b2c;
  color: #ffffff;
}

/* 通用工具 - 流光渐变 */
.site-tab-btn.tab-generic.active {
  position: relative;
  border-color: transparent;
  color: #ffffff;
  background: linear-gradient(
    125deg,
    #6366f1 0%,
    #8b5cf6 25%,
    #ec4899 50%,
    #f59e0b 75%,
    #6366f1 100%
  );
  background-size: 300% 300%;
  animation: tab-generic-shift 6s ease-in-out infinite;
  box-shadow:
    0 0 0 1px rgba(139, 92, 246, 0.35),
    0 6px 18px rgba(99, 102, 241, 0.28);
}

@keyframes tab-generic-shift {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.site-tab-btn.active:hover:not(:disabled) {
  filter: brightness(1.06);
}

.site-tab-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.site-workbench {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 14px;
  padding-bottom: 12px;
  border-bottom: none;
  flex-shrink: 0;
}

.source-panel,
.target-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  padding: 12px;
}

.source-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.target-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.source-header,
.section-title {
  display: flex;
  align-items: center;
}

.source-header {
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  gap: 7px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
}

.section-title span {
  font-weight: 600;
}

.source-count {
  color: var(--color-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.form-grid {
  display: grid;
  grid-template-columns: 150px minmax(220px, 1fr) repeat(3, 116px) max-content;
  gap: 10px;
  align-items: end;
}

.pixiv-grid {
  grid-template-columns: max-content minmax(220px, 1fr) repeat(4, 116px) max-content;
}

.twitter-grid {
  grid-template-columns: minmax(220px, 1fr) 116px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.field.wide {
  min-width: 220px;
}

.field-input,
.source-input,
.cookie-input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}

.field-input {
  height: 34px;
  padding: 0 9px;
}

.grab-select {
  position: relative;
  width: 100%;
}

.grab-select-trigger {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.grab-select-trigger:hover:not(:disabled),
.grab-select-trigger:focus-visible {
  border-color: var(--color-text);
  outline: none;
}

.grab-select-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grab-select-trigger span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grab-select-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.18s ease;
}

.grab-select-arrow.open {
  transform: rotate(180deg);
}

.grab-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 236px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: 0 10px 26px var(--color-shadow);
}

.grab-select-item {
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.grab-select-item:hover {
  background: var(--color-surface-hover);
}

.grab-select-item.active {
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

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
  transform: scaleY(0.96);
}

.field-input:focus,
.source-input:focus,
.cookie-input:focus {
  border-color: var(--color-text);
}

.source-input {
  min-height: 92px;
  max-height: 132px;
  resize: vertical;
  padding: 9px 10px;
  line-height: 1.55;
}

.cookie-field {
  margin-top: 2px;
}

.cookie-input {
  min-height: 82px;
  resize: vertical;
  padding: 9px 10px;
  line-height: 1.5;
}

.segmented {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
}

.segment-btn,
.type-chip {
  box-sizing: border-box;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.segment-btn {
  width: 72px;
  height: 34px;
}

.type-chip {
  width: 62px;
  height: 30px;
}

.segment-btn:hover,
.type-chip:hover {
  border-color: var(--color-border-hover);
}

.segment-btn.active,
.type-chip.active {
  border-color: var(--color-active-bg);
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

/* Rating 配色 - 柔和染色 */
.segment-btn.rating-safe.active {
  border-color: var(--color-tag-has-border);
  background: var(--color-tag-has-bg);
  color: var(--color-tag-has-color);
  font-weight: 500;
}

.segment-btn.rating-nsfw.active {
  border-color: var(--color-error-border);
  background: var(--color-error-light);
  color: var(--color-error);
  font-weight: 500;
}

.option-row,
.grab-options,
.grab-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.option-row {
  flex-wrap: wrap;
}

.grab-options {
  min-width: 0;
}

.grab-actions {
  justify-content: flex-end;
  margin-top: auto;
}

.type-options {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.option-toggle,
.limit-field {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.option-toggle {
  cursor: pointer;
  user-select: none;
}

.limit-field input {
  width: 64px;
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  padding: 0 6px;
  outline: none;
}

.primary-btn,
.icon-action {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.primary-btn {
  width: var(--ui-action-button-width);
  height: var(--ui-action-button-height);
  padding: 0 18px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.primary-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.target-panel > .primary-btn {
  width: 100%;
}

.icon-action {
  height: var(--ui-action-button-height);
}

.grab-message {
  margin-top: 8px;
}

.warning-strip,
.status-strip,
.task-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-top: 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  flex-shrink: 0;
}

.warning-strip {
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.09);
  color: var(--color-warning);
}

.warning-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.status-strip,
.task-summary {
  border: 1px solid var(--color-tag-has-border);
  background: var(--color-tag-has-bg);
  color: var(--color-tag-has-color);
}

.task-summary {
  align-items: flex-start;
  flex-direction: column;
  gap: 6px;
}

.task-summary-title,
.task-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-summary-title span {
  font-weight: 600;
}

.metric {
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.5);
  color: var(--color-text);
}

.task-output,
.task-errors {
  max-width: 100%;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-errors {
  color: var(--color-error);
}

.grab-status-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 42px;
  padding: 8px 0 10px;
  border-bottom: none;
  flex-shrink: 0;
}

.stop-task-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.08);
  color: var(--color-error);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.stop-task-btn:hover {
  background: rgba(239, 68, 68, 0.14);
}

.result-search {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 190px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text-muted);
}

.result-search input {
  min-width: 0;
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
}

.grab-grid {
  padding-top: 12px;
}

.grab-card img {
  background: var(--color-background-mute);
}

.grab-card.saved {
  border-color: var(--color-success);
}

.grab-card.failed {
  border-color: var(--color-error);
}

.source-badge,
.type-badge,
.result-badge {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  max-width: calc(100% - 12px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.3;
}

.source-badge {
  top: 6px;
  left: 6px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.56);
  color: #fff;
}

.type-badge {
  left: 6px;
  bottom: 6px;
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.86);
  color: #1b1b1f;
  font-weight: 600;
}

.result-badge {
  right: 6px;
  bottom: 6px;
  padding: 2px 6px;
  color: #fff;
  font-weight: 600;
}

.result-badge.saved {
  background: var(--color-success);
}

.result-badge.failed {
  background: var(--color-error);
}

.direct-empty {
  border-bottom: 1px solid var(--color-border-light);
}

.grab-preview-info {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  width: min(720px, calc(100vw - 48px));
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.64);
  color: #fff;
  padding: 10px 12px;
  cursor: default;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 3px;
}

.preview-url,
.preview-error {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-error {
  color: #fca5a5;
}

.preview-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

.preview-open-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

[data-theme='dark'] .source-panel,
[data-theme='dark'] .target-panel {
  background: rgba(39, 39, 42, 0.72);
  border-color: rgba(63, 63, 70, 0.8);
}

[data-theme='dark'] .type-badge {
  background: rgba(24, 24, 27, 0.82);
  color: #e4e4e7;
}

[data-theme='dark'] .warning-strip {
  background: rgba(245, 158, 11, 0.08);
}

[data-theme='dark'] .status-strip,
[data-theme='dark'] .task-summary {
  background: rgba(74, 222, 128, 0.08);
  border-color: rgba(74, 222, 128, 0.22);
  color: #86efac;
}

[data-theme='dark'] .metric {
  background: rgba(24, 24, 27, 0.55);
  color: var(--color-text);
}

@media (max-width: 1280px) {
  .form-grid,
  .pixiv-grid {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }

  .field.wide {
    grid-column: span 2;
  }
}

@media (max-width: 1080px) {
  .site-workbench {
    grid-template-columns: 1fr;
  }

  .grab-options,
  .grab-status-bar {
    flex-wrap: wrap;
  }

  .result-search {
    width: 100%;
    margin-left: 0;
  }
}
</style>
