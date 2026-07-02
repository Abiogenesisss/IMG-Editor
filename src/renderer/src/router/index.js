import { createRouter, createWebHashHistory } from 'vue-router'
import ImageGenerate from '../views/ImageGenerate.vue'

const routes = [
  {
    path: '/',
    redirect: '/grab'
  },
  {
    path: '/grab',
    name: 'ImageGrab',
    component: () => import('../views/ImageGrab.vue')
  },
  {
    path: '/process',
    name: 'ImageProcess',
    component: () => import('../views/ImageProcess.vue')
  },
  {
    path: '/augment',
    name: 'DataAugment',
    component: () => import('../views/DataAugment.vue')
  },
  {
    path: '/upscale',
    name: 'ImageUpscale',
    component: () => import('../views/ImageUpscale.vue')
  },
  {
    path: '/tagger',
    name: 'ImageTagger',
    component: () => import('../views/ImageTagger.vue')
  },
  {
    path: '/aesthetic',
    name: 'ImageAesthetic',
    component: () => import('../views/ImageAesthetic.vue')
  },
  {
    path: '/caption',
    name: 'ImageCaption',
    component: () => import('../views/ImageCaption.vue')
  },
  {
    path: '/generate',
    name: 'ImageGenerate',
    component: ImageGenerate
  },
  {
    path: '/workflow',
    name: 'WorkflowCanvas',
    component: () => import('../views/WorkflowCanvas.vue')
  },
  {
    path: '/tunnel',
    name: 'TunnelTool',
    component: () => import('../views/TunnelTool.vue')
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/Settings.vue')
  },
  {
    path: '/thanks',
    name: 'SpecialThanks',
    component: () => import('../views/SpecialThanks.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
