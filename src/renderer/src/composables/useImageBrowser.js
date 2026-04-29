import { ref, shallowReactive, computed, watch, onUnmounted, onDeactivated, onActivated, nextTick } from 'vue'

export function useImageBrowser(options = {}) {
  const { onProgress } = options
  const inputFolder = ref('')
  const outputFolder = ref('')
  const images = ref([])
  const selectedImages = ref(new Set())
  const selectAll = ref(false)
  const thumbnails = shallowReactive({})

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
  let thumbLoadGeneration = 0
  const loadQueue = []
  const loadQueueSet = new Set() // 用 Set 去重，避免 O(n) 的 includes 查找
  const thumbLoadOrder = [] // 记录加载顺序用于 LRU 淘汰
  let intersectionObs = null
  let mutationObs = null
  let lastGridEl = null

  function evictOldThumbnails() {
    while (thumbLoadOrder.length > THUMB_CACHE_LIMIT) {
      const oldest = thumbLoadOrder.shift()
      delete thumbnails[oldest]
    }
  }

  function resetThumbnailLoadState(clearCache = false) {
    thumbLoadGeneration += 1
    activeLoads = 0
    loadQueue.length = 0
    loadQueueSet.clear()
    if (clearCache) {
      for (const key of Object.keys(thumbnails)) delete thumbnails[key]
      thumbLoadOrder.length = 0
    }
    return thumbLoadGeneration
  }

  function enqueueLoad(filePath) {
    if (thumbnails[filePath]) return
    const generation = thumbLoadGeneration
    if (activeLoads < CONCURRENT_LIMIT) {
      loadThumbnail(filePath, generation)
    } else {
      if (!loadQueueSet.has(filePath)) {
        loadQueue.push(filePath)
        loadQueueSet.add(filePath)
      }
    }
  }

  async function loadThumbnail(filePath, generation) {
    if (generation !== thumbLoadGeneration) return
    activeLoads++
    try {
      const dataUrl = await window.api.generateThumbnail(filePath)
      if (generation !== thumbLoadGeneration) return
      if (dataUrl) {
        thumbnails[filePath] = dataUrl
        thumbLoadOrder.push(filePath)
        evictOldThumbnails()
      }
    } finally {
      if (generation === thumbLoadGeneration) {
        activeLoads = Math.max(0, activeLoads - 1)
        while (loadQueue.length > 0 && activeLoads < CONCURRENT_LIMIT) {
          const next = loadQueue.shift()
          loadQueueSet.delete(next)
          loadThumbnail(next, generation)
        }
      }
    }
  }

  function observeNewCards(containerEl) {
    if (!containerEl || !intersectionObs) return
    const cards = containerEl.querySelectorAll('.image-card[data-path]')
    cards.forEach((card) => {
      const path = card.dataset.path
      if (path && !thumbnails[path]) {
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
    mutationObs.observe(containerEl, { childList: true, subtree: true })

    nextTick(() => observeNewCards(containerEl))
  }

  function cleanupObservers() {
    intersectionObs?.disconnect()
    intersectionObs = null
    mutationObs?.disconnect()
    mutationObs = null
  }

  // --- 文件夹选择 ---
  async function loadInputFolder(folder) {
    const generation = resetThumbnailLoadState(true)
    inputFolder.value = folder
    images.value = []
    const list = await window.api.readImages(folder)
    if (generation !== thumbLoadGeneration) return

    // 强制清理以触发DOM重绘与IntersectionObserver的重新计算，解决由于系统文件夹对话框导致主窗口失去焦点被Chromium节流导致的只显示加载骨架的问题
    images.value = []
    await new Promise(resolve => setTimeout(resolve, 50))
    if (generation !== thumbLoadGeneration) return

    images.value = list
    selectedImages.value = new Set()
    selectAll.value = false
  }

  async function chooseInputFolder() {
    const folder = await window.api.selectFolder()
    if (!folder) return
    await loadInputFolder(folder)
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

  function clearCurrentFolder() {
    resetThumbnailLoadState(true)
    cleanupObservers()
    inputFolder.value = ''
    images.value = []
    selectedImages.value = new Set()
    selectAll.value = false
    previewImage.value = null
    refreshing.value = false
    lastGridEl = null
  }

  // --- 删除图片（批量删除选中的图片） ---
  async function deleteSelected() {
    const paths = [...selectedImages.value]
    if (paths.length === 0) return
    const confirmed = window.confirm(
      `将选中的 ${paths.length} 张图片移动到同目录的 del 文件夹。\n文件不会被永久删除，是否继续？`
    )
    if (!confirmed) return
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
        delete thumbnails[p]
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
    resetThumbnailLoadState(false)
    cleanupObservers()
    teardownProgressListener()
  })

  // keep-alive 组件重新激活时恢复资源
  onActivated(() => {
    setupProgressListener()
    if (lastGridEl) observeGrid(lastGridEl)
  })

  onUnmounted(() => {
    resetThumbnailLoadState(false)
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
    const generation = thumbLoadGeneration
    refreshing.value = true
    try {
      const list = await window.api.readImages(dir)
      if (generation !== thumbLoadGeneration) return
      const latestPaths = new Set(list.map((i) => i.path))
      for (const key of Object.keys(thumbnails)) {
        if (!latestPaths.has(key)) delete thumbnails[key]
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
  }
}
