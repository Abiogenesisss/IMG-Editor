<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import IconButton from './components/IconButton.vue'
import { Copy, Minus, Moon, Square, Sun, X } from 'lucide-vue-next'
import { mainNavItems, settingsNavItem, thanksNavItem } from './services/navigation'

const router = useRouter()
const route = useRoute()

const activeNav = computed(() => route.path)
const isMaximized = ref(false)
const appVersion = ref('')

// --- 主题 ---
const theme = ref(localStorage.getItem('app-theme') || 'dark') // 'light' | 'dark'
watch(
  theme,
  (val) => {
    localStorage.setItem('app-theme', val)
    document.documentElement.setAttribute('data-theme', val)
  },
  { immediate: true }
)

function toggleTheme(event) {
  const isDark = theme.value === 'dark'

  // 检查浏览器是否支持 View Transitions API
  const isAppearanceTransition =
    document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!isAppearanceTransition || !event) {
    theme.value = isDark ? 'light' : 'dark'
    return
  }

  // 获取点击位置作为动画圆心
  const x = event.clientX
  const y = event.clientY
  const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))

  const transition = document.startViewTransition(async () => {
    theme.value = isDark ? 'light' : 'dark'
    await nextTick()
  })

  transition.ready.then(() => {
    const clipPath = [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`]

    document.documentElement.animate(
      {
        clipPath: isDark ? [...clipPath].reverse() : clipPath
      },
      {
        duration: 400,
        easing: 'ease-in-out',
        fill: 'forwards',
        pseudoElement: isDark ? '::view-transition-old(root)' : '::view-transition-new(root)'
      }
    )
  })
}

// --- 设置页面 ---
function openSettings() {
  router.push('/settings')
}

// --- 自动更新 ---
const updateStatus = ref('') // '', 'available', 'downloading', 'downloaded'
const updateVersion = ref('')
const updatePercent = ref(0)

const allNavItems = mainNavItems

// --- 菜单显示设置 ---
function loadMenuVisible() {
  try {
    return JSON.parse(localStorage.getItem('menu-visible') || '{}')
  } catch {
    return {}
  }
}

const menuVisibleConfig = ref(loadMenuVisible())

const navItems = computed(() => {
  const cfg = menuVisibleConfig.value
  return allNavItems.filter((item) => cfg[item.path] !== false)
})

function navigateTo(path) {
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
  window.api.getAppVersion().then((v) => {
    appVersion.value = v
  })
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
        <IconButton
          :icon="isMaximized ? Copy : Square"
          variant="window"
          title="最大化"
          :size="14"
          @click="toggleMaximize"
        />
        <IconButton :icon="X" variant="window" tone="close" title="关闭" :size="14" @click="quit" />
      </div>
    </header>

    <div class="app-shell">
      <aside class="app-rail" aria-label="主导航">
        <div class="rail-section-label">MAIN</div>
        <nav class="rail-nav">
          <button
            v-for="item in navItems"
            :key="item.path"
            :class="['rail-btn', { active: activeNav === item.path }]"
            :title="item.label"
            :aria-label="item.label"
            @click="navigateTo(item.path)"
          >
            <component :is="item.icon" :size="19" :stroke-width="2.2" aria-hidden="true" />
            <span class="rail-tooltip">{{ item.label }}</span>
          </button>
        </nav>

        <div class="rail-footer">
          <div class="rail-section-label">PREFS</div>
          <button
            class="rail-btn rail-tool"
            :title="theme === 'light' ? '深色模式' : '浅色模式'"
            :aria-label="theme === 'light' ? '深色模式' : '浅色模式'"
            @click="toggleTheme"
          >
            <component
              :is="theme === 'dark' ? Moon : Sun"
              :size="18"
              :stroke-width="2.2"
              aria-hidden="true"
            />
            <span class="rail-tooltip">{{ theme === 'light' ? '深色模式' : '浅色模式' }}</span>
          </button>
          <button
            :class="['rail-btn', 'rail-tool', { active: activeNav === thanksNavItem.path }]"
            :title="thanksNavItem.label"
            :aria-label="thanksNavItem.label"
            @click="navigateTo(thanksNavItem.path)"
          >
            <component :is="thanksNavItem.icon" :size="18" :stroke-width="2.2" aria-hidden="true" />
            <span class="rail-tooltip">{{ thanksNavItem.label }}</span>
          </button>
          <button
            :class="['rail-btn', 'rail-tool', { active: activeNav === settingsNavItem.path }]"
            :title="settingsNavItem.label"
            :aria-label="settingsNavItem.label"
            @click="openSettings"
          >
            <component
              :is="settingsNavItem.icon"
              :size="18"
              :stroke-width="2.2"
              aria-hidden="true"
            />
            <span class="rail-tooltip">{{ settingsNavItem.label }}</span>
          </button>
        </div>
      </aside>

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
          <div class="update-progress">
            <div class="update-progress-inner" :style="{ width: updatePercent + '%' }"></div>
          </div>
        </div>
        <div v-else-if="updateStatus === 'downloaded'" class="update-bar">
          <span>下载完成，重启以完成更新</span>
          <button class="update-btn" @click="doInstall">立即重启</button>
          <button class="update-btn dismiss" @click="dismissUpdate">稍后</button>
        </div>
        <section class="workspace-content">
          <router-view v-slot="{ Component }">
            <Transition name="route-fade" mode="out-in">
              <keep-alive
                :include="[
                  'ImageGrab',
                  'ImageProcess',
                  'DataAugment',
                  'ImageTagger',
                  'ImageAesthetic',
                  'ImageUpscale',
                  'ImageCaption',
                  'ImageGenerate',
                  'WorkflowCanvas',
                  'TunnelTool'
                ]"
                :max="10"
              >
                <component :is="Component" class="route-view" />
              </keep-alive>
            </Transition>
          </router-view>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  position: relative;
  background: var(--color-stage-bg);
}

/* 顶部栏：仅拖拽区域 + 窗口控制按钮 */
.app-header {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0;
  background: var(--color-header-bg);
  border-bottom: 1px solid var(--color-border-light);
  flex-shrink: 0;
  user-select: none;
  z-index: 3;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 100%;
  -webkit-app-region: no-drag;
}

.brand-icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
  border-radius: 0;
}

.brand-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  letter-spacing: 0;
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
  width: 42px;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.window-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.window-btn.close:hover {
  color: var(--color-on-accent);
  background: var(--color-error);
}

.app-shell {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  position: relative;
  z-index: 1;
  margin: 0;
  border: none;
  background: var(--color-background);
  box-shadow: none;
  overflow: hidden;
}

.app-rail {
  width: 60px;
  flex-shrink: 0;
  padding: 14px 7px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--color-surface);
  border-right: 1px solid var(--color-border-light);
  box-shadow: none;
  position: relative;
  z-index: 4;
}

.rail-section-label {
  width: 100%;
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 500;
  text-align: center;
  line-height: 1;
  letter-spacing: 0;
  flex-shrink: 0;
}

.rail-nav,
.rail-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.rail-footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-light);
}

.rail-btn {
  position: relative;
  width: 38px;
  height: 38px;
  min-width: 38px;
  max-width: 38px;
  aspect-ratio: 1 / 1;
  flex: 0 0 38px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition:
    color 0.18s ease,
    border-color 0.18s ease,
    background-color 0.18s ease;
}

.rail-btn::after {
  content: '';
  display: block;
  position: absolute;
  left: -8px;
  top: 50%;
  width: 3px;
  height: 18px;
  border-radius: 0 2px 2px 0;
  background: var(--color-nav-accent);
  transform: translateY(-50%) scaleY(0);
  opacity: 0;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.rail-btn svg {
  position: relative;
  z-index: 1;
}

.rail-btn:hover {
  color: var(--color-nav-accent);
  background: var(--color-surface-hover);
  border-color: var(--color-border-light);
}

.rail-btn.active {
  color: var(--color-nav-accent);
  background: var(--color-nav-accent-light);
  border-color: var(--color-accent-border);
  box-shadow: var(--shadow-glow);
}

.rail-btn.active::after {
  opacity: 1;
  transform: translateY(-50%) scaleY(1);
}

.rail-tooltip {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translate(-4px, -50%);
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  color: var(--color-tooltip-text);
  background: var(--color-tooltip-bg);
  box-shadow: var(--shadow-md);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  z-index: var(--z-dropdown);
}

.rail-tooltip::before {
  content: '';
  position: absolute;
  left: -4px;
  top: 50%;
  width: 8px;
  height: 8px;
  background: inherit;
  transform: translateY(-50%) rotate(45deg);
}

.rail-btn:hover .rail-tooltip,
.rail-btn:focus-visible .rail-tooltip {
  opacity: 1;
  transform: translate(0, -50%);
}

/* 内容区 */
.app-main {
  flex: 1;
  overflow: hidden;
  background: var(--color-background);
  padding: 14px 16px;
  position: relative;
  display: flex;
  flex-direction: column;
  z-index: 1;
}

.workspace-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.route-view {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* 路由切换过渡动画 —— 淡入 + 轻微上浮，丝滑 */
.route-fade-enter-active {
  transition:
    opacity 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}

.route-fade-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.route-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.route-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 更新提示条 */
.update-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 8px 12px;
  margin: 0 0 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: 12px;
  color: var(--color-text);
  flex-shrink: 0;
  box-shadow: var(--shadow-xs);
  z-index: 2;
}

.update-btn {
  min-width: 58px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--color-active-bg);
  border-radius: var(--radius-sm);
  background: var(--color-active-bg);
  color: var(--color-active-text);
  font-size: 11px;
  cursor: pointer;
  box-shadow: var(--shadow-button);
  transition:
    background 0.15s,
    filter 0.15s;
}

.update-btn:hover {
  filter: brightness(1.08);
}

.update-btn.dismiss {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text);
  box-shadow: none;
}

.update-btn.dismiss:hover {
  background: var(--color-surface-hover);
}

.update-progress {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: 999px;
  overflow: hidden;
}

.update-progress-inner {
  height: 100%;
  background: var(--color-active-bg);
  border-radius: 999px;
  transition: width 0.3s ease;
}

@media (max-width: 920px), (max-height: 720px) {
  .app-main {
    padding: 10px 12px;
  }
}
</style>
