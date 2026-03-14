<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const router = useRouter()
const route = useRoute()

const activeNav = ref(route.path)
const isMaximized = ref(false)

// --- 自动更新 ---
const updateStatus = ref('') // '', 'available', 'downloading', 'downloaded'
const updateVersion = ref('')
const updatePercent = ref(0)

const navItems = [
  { path: '/grab', label: '图片抓取' },
  { path: '/process', label: '图片处理' },
  { path: '/augment', label: '数据增强' },
  { path: '/upscale', label: '超分辨率' },
  { path: '/tagger', label: '图片打标' }
]

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

onMounted(() => {
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
})

onUnmounted(() => {
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
        <span class="brand-title">IMG Editor</span>
      </div>
      <div class="header-drag"></div>
      <div class="header-right">
        <button class="window-btn" title="最小化" @click="minimize">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button class="window-btn" title="最大化" @click="toggleMaximize">
          <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 12 12">
            <rect x="3.5" y="1" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
            <rect x="1.5" y="3" width="7" height="7" rx="1" fill="#fff" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
        <button class="window-btn close-btn" title="关闭" @click="quit">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
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
      <!-- 悬浮工具栏 -->
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
      <router-view v-slot="{ Component }">
        <Transition name="route-fade" mode="out-in">
          <keep-alive :include="['ImageProcess', 'DataAugment', 'ImageTagger', 'ImageUpscale']" :max="5">
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
  background: #f3f4f6;
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
  color: #374151;
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
  border-radius: 0;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.window-btn:hover {
  color: #1b1b1f;
  background: #f3f4f6;
}

.close-btn:hover {
  color: #fff;
  background: #e53935;
}

/* 内容区 */
.app-main {
  flex: 1;
  overflow: hidden;
  background: #fff;
  padding: 0 24px;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* 悬浮工具栏 */
.floating-toolbar {
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  width: fit-content;
  margin: 8px auto 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}

.toolbar-btn {
  padding: 6px 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #6b7280;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
  white-space: nowrap;
}

.toolbar-btn:hover {
  color: #1b1b1f;
  background: #f3f4f6;
}

.toolbar-btn.active {
  color: #fff;
  background: #1b1b1f;
  font-weight: 500;
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
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  font-size: 13px;
  color: #3730a3;
  flex-shrink: 0;
}

.update-btn {
  padding: 3px 12px;
  border: none;
  border-radius: 4px;
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
  background: #e0e7ff;
}

.update-progress {
  flex: 1;
  height: 6px;
  background: #c7d2fe;
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
