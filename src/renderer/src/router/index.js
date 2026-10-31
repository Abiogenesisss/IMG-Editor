import { createRouter, createWebHashHistory } from 'vue-router'
import { mainNavItems, settingsNavItem, thanksNavItem } from '../services/navigation'

const views = {
  ImageGrab: () => import('../views/ImageGrab.vue'),
  ImageProcess: () => import('../views/ImageProcess.vue'),
  DataAugment: () => import('../views/DataAugment.vue'),
  ImageUpscale: () => import('../views/ImageUpscale.vue'),
  ImageTagger: () => import('../views/ImageTagger.vue'),
  ImageAesthetic: () => import('../views/ImageAesthetic.vue'),
  ImageCaption: () => import('../views/ImageCaption.vue'),
  WorkflowCanvas: () => import('../views/WorkflowCanvas.vue'),
  TunnelTool: () => import('../views/TunnelTool.vue'),
  Settings: () => import('../views/Settings.vue'),
  SpecialThanks: () => import('../views/SpecialThanks.vue')
}

const routeItems = [...mainNavItems, settingsNavItem, thanksNavItem]

const routes = [
  {
    path: '/',
    redirect: mainNavItems[0].path
  },
  ...routeItems.map((item) => ({
    path: item.path,
    name: item.name,
    component: views[item.name],
    meta: { keepAlive: item.keepAlive }
  }))
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
