import {
  Cable,
  CircleQuestionMark,
  Download,
  Maximize2,
  MessageSquareText,
  Settings,
  Sparkles,
  Star,
  Tags,
  WandSparkles,
  Waypoints
} from 'lucide-vue-next'

export const mainNavItems = [
  { path: '/grab', name: 'ImageGrab', label: '图片抓取', icon: Download, keepAlive: true },
  {
    path: '/process',
    name: 'ImageProcess',
    label: '图片处理',
    icon: WandSparkles,
    keepAlive: true
  },
  { path: '/augment', name: 'DataAugment', label: '数据增强', icon: Sparkles, keepAlive: true },
  { path: '/upscale', name: 'ImageUpscale', label: '超分辨率', icon: Maximize2, keepAlive: true },
  { path: '/tagger', name: 'ImageTagger', label: '图片打标', icon: Tags, keepAlive: true },
  { path: '/aesthetic', name: 'ImageAesthetic', label: '美学筛图', icon: Star, keepAlive: true },
  {
    path: '/caption',
    name: 'ImageCaption',
    label: 'Caption',
    icon: MessageSquareText,
    keepAlive: true
  },
  { path: '/workflow', name: 'WorkflowCanvas', label: '工作流', icon: Waypoints, keepAlive: true },
  { path: '/tunnel', name: 'TunnelTool', label: '隧道工具', icon: Cable, keepAlive: true }
]

export const settingsNavItem = {
  path: '/settings',
  name: 'Settings',
  label: '设置',
  icon: Settings,
  required: true,
  keepAlive: false
}

export const thanksNavItem = {
  path: '/thanks',
  name: 'SpecialThanks',
  label: '特别鸣谢',
  icon: CircleQuestionMark,
  required: true,
  keepAlive: false
}

export const keepAliveRouteNames = mainNavItems
  .filter((item) => item.keepAlive)
  .map((item) => item.name)

export const settingsMenuItems = [
  ...mainNavItems.map((item) => ({ ...item, required: false })),
  settingsNavItem
]
