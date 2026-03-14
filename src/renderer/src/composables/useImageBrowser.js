import { ref, computed, watch, onUnmounted, onDeactivated, onActivated, nextTick } from 'vue'

export function useImageBrowser(options = {}) {
  const { onProgress } = options
  const inputFolder = ref('')
  const outputFolder = ref('')
  const images = ref([])
  const selectedImages = ref(new Set())
  const selectAll = ref(false)
  const thumbnails = ref({})

  const imageCount = computed(() => images.value.length)
  const selectedCount = computed(() => selectedImages.value.size)

  // --- 获取操作目标文件列表（有选中用选中，否则全部） ---
  function getTargetFiles() {
    return selectedCount.value > 0 ? [...selectedImages.value] : images.value.map((i) => i.path)
  }

  // --- 缩略图懒加载（IntersectionObserver，仅加载可视区域） ---
  const CONCURRENT_LIMIT = 6
  const THUMB_CACHE_LIMIT = 500 // 最多缓存 500 张缩略图，超出则淘汰最早的
  let activeLoads = 0
  const loadQueue = []
  const thumbLoadOrder = [] // 记录加载顺序用于 LRU 淘汰
  let intersectionObs = null
  let mutationObs = null
  let lastGridEl = null

  function evictOldThumbnails() {
    while (thumbLoadOrder.length > THUMB_CACHE_LIMIT) {
      const oldest = thumbLoadOrder.shift()
      delete thumbnails.value[oldest]
    }
  }

  function enqueueLoad(filePath) {
    if (thumbnails.value[filePath]) return
    if (activeLoads < CONCURRENT_LIMIT) {
      loadThumbnail(filePath)
    } else {
      if (!loadQueue.includes(filePath)) loadQueue.push(filePath)
    }
  }

  async function loadThumbnail(filePath) {
    activeLoads++
    try {
      const dataUrl = await window.api.generateThumbnail(filePath)
      if (dataUrl) {
        thumbnails.value[filePath] = dataUrl
        thumbLoadOrder.push(filePath)
        evictOldThumbnails()
      }
    } finally {
      activeLoads--
      if (loadQueue.length > 0) {
        const next = loadQueue.shift()
        loadThumbnail(next)
      }
    }
  }

  function observeNewCards(containerEl) {
    if (!containerEl || !intersectionObs) return
    const cards = containerEl.querySelectorAll('.image-card[data-path]')
    cards.forEach((card) => {
      const path = card.dataset.path
      if (path && !thumbnails.value[path]) {
        intersectionObs.observe(card)
      }
    })
  }

  function observeGrid(containerEl) {
    cleanupObservers()
    if (!containerEl) return
    lastGridEl = containerEl

    intersectionObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const path = entry.target.dataset?.path
            if (path) enqueueLoad(path)
            intersectionObs?.unobserve(entry.target)
          }
        }
      },
      { root: containerEl, rootMargin: '300px 0px' }
    )

    // 自动观察新增的卡片（v-for 动态渲染）
    mutationObs = new MutationObserver(() => observeNewCards(containerEl))
    mutationObs.observe(containerEl, { childList: true })

    nextTick(() => observeNewCards(containerEl))
  }

  function cleanupObservers() {
    intersectionObs?.disconnect()
    intersectionObs = null
    mutationObs?.disconnect()
    mutationObs = null
  }

  // --- 文件夹选择 ---
  async function chooseInputFolder() {
    const folder = await window.api.selectFolder()
    if (!folder) return
    inputFolder.value = folder
    const list = await window.api.readImages(folder)
    images.value = list
    selectedImages.value = new Set()
    selectAll.value = false
    thumbnails.value = {}
    thumbLoadOrder.length = 0
    loadQueue.length = 0
    // 缩略图由 IntersectionObserver 按需触发，无需主动全量加载
  }

  async function chooseOutputFolder() {
    const folder = await window.api.selectFolder()
    if (!folder) return
    outputFolder.value = folder
  }

  // --- 选择逻辑 ---
  function toggleSelect(img) {
    const s = new Set(selectedImages.value)
    if (s.has(img.path)) {
      s.delete(img.path)
    } else {
      s.add(img.path)
    }
    selectedImages.value = s
    selectAll.value = s.size === images.value.length
  }

  function toggleSelectAll() {
    if (selectAll.value) {
      selectedImages.value = new Set()
      selectAll.value = false
    } else {
      selectedImages.value = new Set(images.value.map((i) => i.path))
      selectAll.value = true
    }
  }

  function isSelected(img) {
    return selectedImages.value.has(img.path)
  }

  // --- 原图预览 ---
  const previewImage = ref(null)

  function openPreview(img) {
    previewImage.value = img
  }

  function closePreview() {
    previewImage.value = null
  }

  // --- 删除图片（批量删除选中的图片） ---
  async function deleteSelected() {
    const paths = [...selectedImages.value]
    if (paths.length === 0) return
    const results = await Promise.all(paths.map((p) => window.api.deleteImage(p)))
    const deletedPaths = new Set()
    results.forEach((r, i) => {
      if (r.success) deletedPaths.add(paths[i])
    })
    if (deletedPaths.size > 0) {
      images.value = images.value.filter((i) => !deletedPaths.has(i.path))
      const s = new Set([...selectedImages.value].filter((p) => !deletedPaths.has(p)))
      selectedImages.value = s
      selectAll.value = s.size === images.value.length && images.value.length > 0
      for (const p of deletedPaths) {
        delete thumbnails.value[p]
      }
    }
  }

  // --- 通用任务状态 ---
  const processingAction = ref(null)
  const progressDone = ref(0)
  const progressTotal = ref(0)

  // 监听后端进度事件
  let removeProgressListener = null

  function setupProgressListener() {
    if (removeProgressListener) return
    removeProgressListener = window.api.onTaskProgress((data) => {
      if (data.done !== undefined && data.total !== undefined) {
        progressDone.value = data.done
        progressTotal.value = data.total
      }
      // 将完整数据转发给自定义回调（如 ImageTagger 的下载进度）
      if (onProgress) onProgress(data)
    })
  }

  function teardownProgressListener() {
    if (removeProgressListener) {
      removeProgressListener()
      removeProgressListener = null
    }
  }

  setupProgressListener()

  // 任务结束时自动清零进度
  watch(processingAction, (val) => {
    if (val === null) {
      progressDone.value = 0
      progressTotal.value = 0
    }
  })

  // keep-alive 组件失活时释放资源
  onDeactivated(() => {
    loadQueue.length = 0
    cleanupObservers()
    teardownProgressListener()
  })

  // keep-alive 组件重新激活时恢复资源
  onActivated(() => {
    setupProgressListener()
    if (lastGridEl) observeGrid(lastGridEl)
  })

  onUnmounted(() => {
    loadQueue.length = 0
    cleanupObservers()
    teardownProgressListener()
  })

  async function getOutputDir() {
    if (outputFolder.value) return outputFolder.value
    // 未指定输出目录时，在输入目录同级创建唯一的 output 目录
    if (inputFolder.value) {
      return await window.api.resolveOutputDir(inputFolder.value)
    }
    return inputFolder.value
  }

  // --- 刷新 ---
  const refreshing = ref(false)

  async function refreshImages() {
    const dir = inputFolder.value
    if (!dir) return
    refreshing.value = true
    try {
      const list = await window.api.readImages(dir)
      const latestPaths = new Set(list.map((i) => i.path))
      for (const key of Object.keys(thumbnails.value)) {
        if (!latestPaths.has(key)) delete thumbnails.value[key]
      }
      images.value = list
      const s = new Set([...selectedImages.value].filter((p) => latestPaths.has(p)))
      selectedImages.value = s
      selectAll.value = s.size === list.length && list.length > 0
      // 缩略图由 IntersectionObserver 按需触发
    } finally {
      refreshing.value = false
    }
  }

  // --- 终止任务 ---
  async function abortTask() {
    await window.api.abortTask()
    processingAction.value = null
    progressDone.value = 0
    progressTotal.value = 0
  }

  return {
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
  }
}
