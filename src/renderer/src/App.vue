<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import IconButton from './components/IconButton.vue'
import { Copy, Minus, Moon, Settings, Square, Sun, X } from 'lucide-vue-next'

const router = useRouter()
const route = useRoute()

const activeNav = ref(route.path)
const isMaximized = ref(false)
const appVersion = ref('')

// --- 主题 ---
const theme = ref(localStorage.getItem('app-theme') || 'light') // 'light' | 'dark'
watch(theme, (val) => {
  localStorage.setItem('app-theme', val)
  document.documentElement.setAttribute('data-theme', val)
}, { immediate: true })

function toggleTheme(event) {
  const isDark = theme.value === 'dark'

  // 检查浏览器是否支持 View Transitions API
  const isAppearanceTransition = document.startViewTransition
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!isAppearanceTransition || !event) {
    theme.value = isDark ? 'light' : 'dark'
    return
  }

  // 获取点击位置作为动画圆心
  const x = event.clientX
  const y = event.clientY
  const endRadius = Math.hypot(
      Math.max(x, innerWidth - x),
      Math.max(y, innerHeight - y)
  )

  const transition = document.startViewTransition(async () => {
    theme.value = isDark ? 'light' : 'dark'
    await nextTick()
  })

  transition.ready.then(() => {
    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${endRadius}px at ${x}px ${y}px)`
    ]

    document.documentElement.animate(
        {
          clipPath: isDark
              ? [...clipPath].reverse()
              : clipPath
        },
        {
          duration: 400,
          easing: 'ease-in-out',
          fill: 'forwards',
          pseudoElement: isDark
              ? '::view-transition-old(root)'
              : '::view-transition-new(root)'
        }
    )
  })
}

// --- 设置页面 ---
function openSettings() {
  activeNav.value = '/settings'
  router.push('/settings')
}

// --- 自动更新 ---
const updateStatus = ref('') // '', 'available', 'downloading', 'downloaded'
const updateVersion = ref('')
const updatePercent = ref(0)

const allNavItems = [
  { path: '/grab', label: '图片抓取' },
  { path: '/process', label: '图片处理' },
  { path: '/augment', label: '数据增强' },
  { path: '/upscale', label: '超分辨率' },
  { path: '/tagger', label: '图片打标' },
  { path: '/caption', label: 'Caption' },
  { path: '/workflow', label: '工作流' }
]

// --- 菜单显示设置 ---
function loadMenuVisible() {
  try {
    return JSON.parse(localStorage.getItem('menu-visible') || '{}')
  } catch { return {} }
}

const menuVisibleConfig = ref(loadMenuVisible())

const navItems = computed(() => {
  const cfg = menuVisibleConfig.value
  return allNavItems.filter((item) => cfg[item.path] !== false)
})

function navigateTo(path) {
  activeNav.value = path
  router.push(path)
}

// 窗口控制
function minimize() {
  window.api.minimizeApp()
}

function toggleMaximize() {
  window.api.maximizeApp()
}

function quit() {
  window.api.quitApp()
}

function doDownload() {
  window.api.downloadUpdate()
}

function doInstall() {
  window.api.installUpdate()
}

function dismissUpdate() {
  updateStatus.value = ''
}

let unsubscribe = null
let unsubUpdate = null

function onMenuStorageChange(e) {
  if (e.key === 'menu-visible') {
    menuVisibleConfig.value = loadMenuVisible()
  }
}

onMounted(() => {
  window.api.getAppVersion().then(v => { appVersion.value = v })
  window.addEventListener('storage', onMenuStorageChange)
  unsubscribe = window.api.onWindowStateChange((maximized) => {
    isMaximized.value = maximized
  })
  unsubUpdate = window.api.onUpdateStatus((status, data) => {
    if (status === 'available') {
      updateStatus.value = 'available'
      updateVersion.value = data?.version || ''
    } else if (status === 'downloading') {
      updateStatus.value = 'downloading'
      updatePercent.value = data?.percent || 0
    } else if (status === 'downloaded') {
      updateStatus.value = 'downloaded'
    } else if (status === 'error' || status === 'not-available') {
      updateStatus.value = ''
    }
  })
  // 启动时同步 GPU 设置到后端
  const gpuSaved = localStorage.getItem('gpu-enabled')
  if (gpuSaved !== null) {
    window.api.callPython('/set-gpu-config', { enabled: gpuSaved === 'true' }).catch(() => {})
  }
})

onUnmounted(() => {
  window.removeEventListener('storage', onMenuStorageChange)
  if (unsubscribe) unsubscribe()
  if (unsubUpdate) unsubUpdate()
})
</script>

<template>
  <div class="app-layout">
    <!-- 顶部拖拽区域 + 窗口控制按钮 -->
    <header class="app-header">
      <div class="header-brand">
        <img src="./assets/icon.png" alt="icon" class="brand-icon" />
        <span class="brand-title">IMG Editor {{ appVersion ? `v${appVersion}` : '' }}</span>
      </div>
      <div class="header-drag"></div>
      <div class="header-right">
        <IconButton :icon="Minus" variant="window" title="最小化" :size="14" @click="minimize" />
        <IconButton :icon="isMaximized ? Copy : Square" variant="window" title="最大化" :size="14" @click="toggleMaximize" />
        <IconButton :icon="X" variant="window" tone="close" title="关闭" :size="14" @click="quit" />
      </div>
    </header>

    <!-- 内容区 -->
    <main class="app-main">
      <!-- 更新提示条 -->
      <div v-if="updateStatus === 'available'" class="update-bar">
        <span>发现新版本 {{ updateVersion }}，是否下载？</span>
        <button class="update-btn" @click="doDownload">下载</button>
        <button class="update-btn dismiss" @click="dismissUpdate">忽略</button>
      </div>
      <div v-else-if="updateStatus === 'downloading'" class="update-bar">
        <span>正在下载更新... {{ updatePercent }}%</span>
        <div class="update-progress"><div class="update-progress-inner" :style="{ width: updatePercent + '%' }"></div></div>
      </div>
      <div v-else-if="updateStatus === 'downloaded'" class="update-bar">
        <span>下载完成，重启以完成更新</span>
        <button class="update-btn" @click="doInstall">立即重启</button>
        <button class="update-btn dismiss" @click="dismissUpdate">稍后</button>
      </div>
      <!-- 顶部工具栏区域 -->
      <div class="toolbar-row">
        <!-- 左侧占位，保持导航栏居中 -->
        <div class="toolbar-utils-placeholder"></div>
        <!-- 中间：页面导航 -->
        <div class="floating-toolbar">
          <button
            v-for="item in navItems"
            :key="item.path"
            :class="['toolbar-btn', { active: activeNav === item.path }]"
            @click="navigateTo(item.path)"
          >
            {{ item.label }}
          </button>
        </div>
        <!-- 右侧：主题 + 设置 -->
        <div class="toolbar-utils">
          <!-- 主题切换 -->
          <IconButton
            :icon="theme === 'dark' ? Moon : Sun"
            variant="toolbar"
            :title="theme === 'light' ? '深色模式' : '浅色模式'"
            @click="toggleTheme"
          />
          <!-- 设置 -->
          <IconButton
            :icon="Settings"
            variant="toolbar"
            :active="activeNav === '/settings'"
            title="设置"
            @click="openSettings"
          />
        </div>
      </div>
      <router-view v-slot="{ Component }">
        <Transition name="route-fade" mode="out-in">
          <keep-alive :include="['ImageGrab', 'ImageProcess', 'DataAugment', 'ImageTagger', 'ImageUpscale', 'ImageCaption', 'WorkflowCanvas']" :max="8">
            <component :is="Component" class="route-view" />
          </keep-alive>
        </Transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* 顶部栏：仅拖拽区域 + 窗口控制按钮 */
.app-header {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0;
  background: var(--color-header-bg);
  flex-shrink: 0;
  user-select: none;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 100%;
  -webkit-app-region: no-drag;
}

.brand-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.brand-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.header-drag {
  flex: 1;
  height: 100%;
  -webkit-app-region: drag;
}

.header-right {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
}

/* 窗口控制按钮 */
.window-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.window-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.window-btn.close:hover {
  color: #fff;
  background: #e53935;
}

/* 内容区 */
.app-main {
  flex: 1;
  overflow: hidden;
  background: var(--color-background);
  padding: 0 24px;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* 顶部工具栏行：三列布局 */
.toolbar-row {
  display: flex;
  align-items: center;
  margin: 8px 0 0;
  flex-shrink: 0;
  z-index: 100;
}

/* 左侧工具按钮组 */
.toolbar-utils {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 1px 3px var(--color-shadow);
  flex-shrink: 0;
}

/* 右侧占位，和左侧等宽以保持导航居中 */
.toolbar-utils-placeholder {
  width: 82px; /* 与 toolbar-utils 实际宽度匹配 */
  flex-shrink: 0;
}

/* 悬浮导航栏 */
.floating-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  width: fit-content;
  margin: 0 auto;
  box-shadow: 0 1px 3px var(--color-shadow);
}

.toolbar-btn {
  width: var(--ui-nav-button-width);
  height: var(--ui-nav-button-height);
  padding: 0 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.toolbar-btn.active {
  color: var(--color-active-text);
  background: var(--color-active-bg);
  font-weight: 500;
}

/* 工具栏图标按钮 */
.toolbar-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
  padding: 0;
}

.toolbar-icon-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.toolbar-icon-btn.active {
  color: var(--color-info);
  background: var(--color-info-light);
}

.route-view {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 路由切换过渡动画 */
.route-fade-enter-active,
.route-fade-leave-active {
  transition: opacity 0.15s ease;
}

.route-fade-enter-from {
  opacity: 0;
}

.route-fade-leave-to {
  opacity: 0;
}

/* 更新提示条 */
.update-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  margin: 8px 0 0;
  background: var(--color-primary-light);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-text);
  flex-shrink: 0;
}

.update-btn {
  padding: 3px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.update-btn:hover {
  background: #4338ca;
}

.update-btn.dismiss {
  background: transparent;
  color: #6366f1;
}

.update-btn.dismiss:hover {
  background: var(--color-surface-hover);
}

.update-progress {
  flex: 1;
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}

.update-progress-inner {
  height: 100%;
  background: #4f46e5;
  border-radius: 3px;
  transition: width 0.3s ease;
}
</style>
