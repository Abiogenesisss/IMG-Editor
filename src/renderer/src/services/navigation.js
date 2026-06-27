import {
  Cable,
  Download,
  ImagePlus,
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
  { path: '/grab', label: '图片抓取', icon: Download },
  { path: '/process', label: '图片处理', icon: WandSparkles },
  { path: '/augment', label: '数据增强', icon: Sparkles },
  { path: '/upscale', label: '超分辨率', icon: Maximize2 },
  { path: '/tagger', label: '图片打标', icon: Tags },
  { path: '/aesthetic', label: '美学筛图', icon: Star },
  { path: '/caption', label: 'Caption', icon: MessageSquareText },
  { path: '/generate', label: '生图', icon: ImagePlus },
  { path: '/workflow', label: '工作流', icon: Waypoints },
  { path: '/tunnel', label: '隧道工具', icon: Cable }
]

export const settingsNavItem = { path: '/settings', label: '设置', icon: Settings, required: true }

export const settingsMenuItems = [
  ...mainNavItems.map((item) => ({ ...item, required: false })),
  settingsNavItem
]
