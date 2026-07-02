<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { MarkerType, VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import {
  Copy,
  FolderOpen,
  Maximize2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2
} from 'lucide-vue-next'
import WorkflowNode from '../components/WorkflowNode.vue'
import { loadApiConfigs } from '../services/apiConfigs'

defineOptions({ name: 'WorkflowCanvas' })

const STORAGE_KEY = 'img-editor-workflow-templates-v1'
const OUTPUT_ROOT_KEY = 'img-editor-workflow-output-root'

const FILE_IN = [{ id: 'files', label: '输入', type: 'file-list' }]
const FILE_OUT = [{ id: 'files', label: '输出', type: 'file-list' }]
const META_OUT = { id: 'metadata', label: '文本', type: 'metadata' }

const NODE_DEFS = {
  'source-generic': {
    label: '通用 URL 抓取',
    category: '源节点',
    inputs: [],
    outputs: FILE_OUT,
    required: ['sources'],
    params: {
      sources: '',
      include_srcset: true,
      file_types: 'jpg,png,webp,gif',
      max_per_source: 120
    },
    fields: [
      {
        key: 'sources',
        label: 'URL 列表',
        type: 'textarea',
        rows: 4,
        placeholder: '每行一个页面或图片 URL'
      },
      { key: 'file_types', label: '文件类型', type: 'text', placeholder: 'jpg,png,webp,gif' },
      { key: 'max_per_source', label: '每源上限', type: 'number', min: 1, max: 500 },
      { key: 'include_srcset', label: 'Srcset', type: 'checkbox', hint: '读取 srcset 候选' }
    ]
  },
  'source-booru': {
    label: 'Booru 抓取',
    category: '源节点',
    inputs: [],
    outputs: FILE_OUT,
    required: ['tags'],
    params: {
      site: 'danbooru',
      tags: 'original',
      limit: 500,
      per_page: 100,
      min_score: 0,
      rating: 'all',
      filter_ai: true,
      only_original: true,
      write_txt: true,
      enable_resume: true
    },
    fields: [
      {
        key: 'site',
        label: '站点',
        type: 'select',
        options: [
          { value: 'danbooru', label: 'Danbooru' },
          { value: 'gelbooru', label: 'Gelbooru' },
          { value: 'safebooru', label: 'Safebooru' },
          { value: 'yande', label: 'Yande.re' },
          { value: 'konachan', label: 'Konachan' },
          { value: 'sakugabooru', label: 'Sakugabooru' }
        ]
      },
      { key: 'tags', label: 'Tags', type: 'text' },
      { key: 'limit', label: '数量', type: 'number', min: 1 },
      { key: 'per_page', label: '每页', type: 'number', min: 1, max: 320 },
      { key: 'min_score', label: '最低分', type: 'number' },
      {
        key: 'rating',
        label: 'Rating',
        type: 'select',
        options: [
          { value: 'all', label: 'All' },
          { value: 'safe', label: 'Safe' },
          { value: 'nsfw', label: 'NSFW' }
        ]
      },
      { key: 'filter_ai', label: '过滤 AI', type: 'checkbox' },
      { key: 'only_original', label: '原图', type: 'checkbox' },
      { key: 'write_txt', label: 'TXT', type: 'checkbox', hint: '保存站点标签' },
      { key: 'enable_resume', label: '断点', type: 'checkbox' }
    ]
  },
  'source-pixiv': {
    label: 'Pixiv 抓取',
    category: '源节点',
    inputs: [],
    outputs: FILE_OUT,
    required: ['cookie', 'query'],
    params: {
      cookie: '',
      mode: 'user',
      query: '',
      limit: 48,
      min_bookmarks: 0,
      start_page: 1,
      end_page: 1,
      ugoira: 'skip',
      enable_resume: true
    },
    fields: [
      { key: 'query', label: '用户 ID / Tag', type: 'text' },
      {
        key: 'mode',
        label: '入口',
        type: 'select',
        options: [
          { value: 'user', label: '用户' },
          { value: 'search', label: 'Tag' }
        ]
      },
      { key: 'limit', label: '数量', type: 'number', min: 1 },
      { key: 'min_bookmarks', label: '最低收藏', type: 'number', min: 0 },
      { key: 'start_page', label: '起始页', type: 'number', min: 1 },
      { key: 'end_page', label: '结束页', type: 'number', min: 1 },
      {
        key: 'ugoira',
        label: '动图',
        type: 'select',
        options: [
          { value: 'skip', label: '跳过' },
          { value: 'zip', label: '保存 ZIP' }
        ]
      },
      { key: 'cookie', label: 'Cookie', type: 'textarea', rows: 3 },
      { key: 'enable_resume', label: '断点', type: 'checkbox' }
    ]
  },
  'source-twitter': {
    label: 'Twitter/X 抓取',
    category: '源节点',
    inputs: [],
    outputs: FILE_OUT,
    required: ['cookie', 'query'],
    params: { cookie: '', query: '', limit: 100, include_video: false, enable_resume: true },
    fields: [
      { key: 'query', label: '用户', type: 'text', placeholder: '@username / x.com/username' },
      { key: 'limit', label: '数量', type: 'number', min: 1 },
      { key: 'cookie', label: 'Cookie / JSON', type: 'textarea', rows: 3 },
      { key: 'include_video', label: '视频/GIF', type: 'checkbox', hint: '包含视频/GIF' },
      { key: 'enable_resume', label: '断点', type: 'checkbox' }
    ]
  },
  'source-folder': {
    label: '本地文件夹输入',
    category: '源节点',
    inputs: [],
    outputs: FILE_OUT,
    required: ['folder'],
    params: { folder: '' },
    fields: [{ key: 'folder', label: '图片目录', type: 'folder', placeholder: '选择本地图片目录' }]
  },
  'filter-resolution': {
    label: '分辨率过滤',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: {
      min_width: 0,
      min_height: 0,
      max_width: 0,
      max_height: 0,
      move_rejected_to_del: true
    },
    fields: [
      { key: 'min_width', label: '最小宽度', type: 'number', min: 0 },
      { key: 'min_height', label: '最小高度', type: 'number', min: 0 },
      { key: 'max_width', label: '最大宽度', type: 'number', min: 0 },
      { key: 'max_height', label: '最大高度', type: 'number', min: 0 },
      { key: 'move_rejected_to_del', label: '移除项', type: 'checkbox', hint: '移动到 del 文件夹' }
    ]
  },
  'filter-dedup': {
    label: '去重过滤',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: {
      hash_thresh: 10,
      phash_thresh: 10,
      color_thresh: 0.5,
      cleanup_strategy: 'quality',
      move_rejected_to_del: true
    },
    fields: [
      { key: 'hash_thresh', label: 'Hash 阈值', type: 'number', min: 0 },
      { key: 'phash_thresh', label: 'PHash 阈值', type: 'number', min: 0 },
      { key: 'color_thresh', label: '颜色阈值', type: 'number', min: 0, max: 1, step: 0.05 },
      {
        key: 'cleanup_strategy',
        label: '清理策略',
        type: 'select',
        options: [
          { value: 'quality', label: '按质量建议' },
          { value: 'first', label: '每组保留首张' }
        ]
      },
      {
        key: 'move_rejected_to_del',
        label: '自动清理',
        type: 'checkbox',
        hint: '建议删除项移动到 del 文件夹'
      }
    ]
  },
  'process-alpha': {
    label: '透明通道',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { background: 'white' },
    fields: [
      {
        key: 'background',
        label: '背景',
        type: 'select',
        options: [
          { value: 'white', label: '白色' },
          { value: 'black', label: '黑色' },
          { value: 'transparent', label: '透明' }
        ]
      }
    ]
  },
  'process-resize': {
    label: '缩放',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { width: 1024, height: 1024, allow_upscale: false, face_threshold: 0.5 },
    fields: [
      { key: 'width', label: '宽度', type: 'number', min: 1 },
      { key: 'height', label: '高度', type: 'number', min: 1 },
      { key: 'allow_upscale', label: '放大', type: 'checkbox', hint: '允许普通缩放放大' },
      { key: 'face_threshold', label: '人脸阈值', type: 'number', min: 0, max: 1, step: 0.05 }
    ]
  },
  'process-ratio-crop': {
    label: '比例裁剪',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { ratio_w: 1, ratio_h: 1 },
    fields: [
      { key: 'ratio_w', label: '比例宽', type: 'number', min: 1 },
      { key: 'ratio_h', label: '比例高', type: 'number', min: 1 }
    ]
  },
  'process-three-split': {
    label: '三分法裁剪',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { person_conf: 0.3, halfbody_conf: 0.3, head_conf: 0.3 },
    fields: [
      { key: 'person_conf', label: '全身阈值', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'halfbody_conf', label: '半身阈值', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'head_conf', label: '头部阈值', type: 'number', min: 0, max: 1, step: 0.05 }
    ]
  },
  'process-format': {
    label: '格式转换',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { target_format: 'png' },
    fields: [
      {
        key: 'target_format',
        label: '格式',
        type: 'select',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'jpg', label: 'JPG' },
          { value: 'webp', label: 'WebP' }
        ]
      }
    ]
  },
  'process-mirror': {
    label: '镜像',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: {},
    fields: []
  },
  'process-cutout': {
    label: 'Cutout',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { count: 2, size_ratio: 0.15 },
    fields: [
      { key: 'count', label: '次数', type: 'number', min: 1 },
      { key: 'size_ratio', label: '遮挡比例', type: 'number', min: 0.01, max: 1, step: 0.01 }
    ]
  },
  'process-perspective': {
    label: '透视',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { intensity: 0.1 },
    fields: [{ key: 'intensity', label: '强度', type: 'number', min: 0, max: 1, step: 0.05 }]
  },
  'process-blur-noise': {
    label: '模糊/噪声',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { blur_radius: 2, noise_sigma: 15 },
    fields: [
      { key: 'blur_radius', label: '模糊半径', type: 'number', min: 0, step: 0.1 },
      { key: 'noise_sigma', label: '噪声 Sigma', type: 'number', min: 0, step: 1 }
    ]
  },
  'process-upscale': {
    label: '超分',
    category: '处理节点',
    inputs: FILE_IN,
    outputs: FILE_OUT,
    params: { scale: 2, denoise: 'denoise3x', model: 'real-cugan', style: 'art', tta: false },
    fields: [
      { key: 'scale', label: '倍数', type: 'number', min: 1, max: 4 },
      {
        key: 'denoise',
        label: '降噪',
        type: 'select',
        options: [
          { value: 'no-denoise', label: '无' },
          { value: 'denoise1x', label: '轻' },
          { value: 'denoise2x', label: '中' },
          { value: 'denoise3x', label: '强' }
        ]
      },
      { key: 'model', label: '模型', type: 'text' },
      {
        key: 'style',
        label: '风格',
        type: 'select',
        options: [
          { value: 'art', label: '插画' },
          { value: 'photo', label: '照片' }
        ]
      },
      { key: 'tta', label: 'TTA', type: 'checkbox' }
    ]
  },
  'metadata-tagger': {
    label: '自动打标',
    category: '元数据节点',
    inputs: FILE_IN,
    outputs: [FILE_OUT[0], META_OUT],
    params: {
      model_key: '',
      general_threshold: 0.35,
      character_threshold: 0.85,
      keep_copyright: true,
      keep_rating: false,
      keep_meta: false,
      keep_model: false,
      keep_quality: false
    },
    fields: [
      {
        key: 'model_key',
        label: '模型 Key',
        type: 'text',
        placeholder: '留空使用第一个已下载模型'
      },
      { key: 'general_threshold', label: '通用阈值', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'character_threshold', label: '角色阈值', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'keep_copyright', label: '版权', type: 'checkbox' },
      { key: 'keep_rating', label: 'Rating', type: 'checkbox' },
      { key: 'keep_meta', label: 'Meta', type: 'checkbox' },
      { key: 'keep_model', label: '模型标签', type: 'checkbox' },
      { key: 'keep_quality', label: '质量标签', type: 'checkbox' }
    ]
  },
  'metadata-aesthetic': {
    label: '美学评分',
    category: '元数据节点',
    inputs: FILE_IN,
    outputs: [FILE_OUT[0], META_OUT],
    params: {
      classifier_model_key: '',
      aesthetic_model_key: '',
      min_score: 5,
      keep_only_passed: false,
      move_low_to_del: false,
      class_filter_enabled: true,
      allowed_classes: '3d,bangumi,comic,illustration',
      class_threshold: 0,
      score_only_passed: true,
      letterbox_preprocess: true,
      relaxed_class_match: true
    },
    fields: [
      {
        key: 'classifier_model_key',
        label: '分类模型 Key',
        type: 'text',
        placeholder: '留空使用第一个已下载分类模型'
      },
      {
        key: 'aesthetic_model_key',
        label: '评分模型 Key',
        type: 'text',
        placeholder: '留空使用第一个已下载评分模型'
      },
      { key: 'min_score', label: '低分阈值', type: 'number', min: 0, max: 10, step: 0.1 },
      { key: 'keep_only_passed', label: '仅输出达标', type: 'checkbox' },
      { key: 'move_low_to_del', label: '低分入 del', type: 'checkbox' },
      { key: 'class_filter_enabled', label: '启用分类筛选', type: 'checkbox' },
      {
        key: 'allowed_classes',
        label: '允许类别',
        type: 'text',
        placeholder: '3d,bangumi,comic,illustration'
      },
      { key: 'class_threshold', label: '分类置信', type: 'number', min: 0, max: 0.95, step: 0.05 },
      { key: 'score_only_passed', label: '只评分通过分类', type: 'checkbox' },
      { key: 'letterbox_preprocess', label: '保持比例补边', type: 'checkbox' },
      { key: 'relaxed_class_match', label: '绘画容错', type: 'checkbox' }
    ]
  },
  'metadata-caption': {
    label: 'Caption',
    category: '元数据节点',
    inputs: FILE_IN,
    outputs: [FILE_OUT[0], META_OUT],
    params: {
      api_config: '',
      system_prompt: '',
      user_prompt: 'Please describe this image.',
      temperature: 0,
      top_p: 0,
      max_tokens: 1024,
      concurrency: 4,
      image_size: 1024,
      disable_think: false
    },
    fields: [
      {
        key: 'api_config',
        label: 'API 配置名/ID',
        type: 'text',
        placeholder: '留空使用第一个启用配置'
      },
      { key: 'system_prompt', label: 'System Prompt', type: 'textarea', rows: 2 },
      { key: 'user_prompt', label: 'User Prompt', type: 'textarea', rows: 3 },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', min: 1 },
      { key: 'concurrency', label: '并发', type: 'number', min: 1, max: 16 },
      { key: 'image_size', label: '图像尺寸', type: 'number', min: 128 },
      { key: 'disable_think', label: '禁用思考', type: 'checkbox' }
    ]
  },
  'output-save': {
    label: '保存输出',
    category: '输出节点',
    inputs: FILE_IN,
    outputs: [],
    params: { output_dir: '', subfolder: 'save' },
    fields: [
      { key: 'output_dir', label: '输出目录', type: 'folder', placeholder: '留空使用运行目录' },
      { key: 'subfolder', label: '运行目录子文件夹', type: 'text' }
    ]
  },
  'output-cluster': {
    label: '聚类分组输出',
    category: '输出节点',
    inputs: FILE_IN,
    outputs: [],
    params: { output_dir: '', subfolder: 'cluster', method: 'style', algorithm: 'kmeans', k: 5 },
    fields: [
      { key: 'output_dir', label: '输出目录', type: 'folder', placeholder: '留空使用运行目录' },
      { key: 'subfolder', label: '运行目录子文件夹', type: 'text' },
      {
        key: 'method',
        label: '特征',
        type: 'select',
        options: [
          { value: 'style', label: '风格' },
          { value: 'semantic', label: '语义' }
        ]
      },
      {
        key: 'algorithm',
        label: '算法',
        type: 'select',
        options: [
          { value: 'kmeans', label: 'KMeans' },
          { value: 'dbscan', label: 'DBSCAN' }
        ]
      },
      { key: 'k', label: '分组数', type: 'number', min: 1 }
    ]
  }
}

const nodeTypes = { workflow: WorkflowNode }
const { fitView, getViewport, screenToFlowCoordinate, setViewport, toObject } = useVueFlow({
  id: 'workflow-canvas'
})

const nodes = ref([])
const edges = ref([])
const templates = ref([])
const activeTemplateId = ref('')
const templateNameDraft = ref('')
const outputRoot = ref(localStorage.getItem(OUTPUT_ROOT_KEY) || '')
const contextMenu = ref({ visible: false, x: 0, y: 0, position: { x: 80, y: 80 } })
const runLog = ref([])
const runRoot = ref('')
const runError = ref('')
const running = ref(false)
const abortRequested = ref(false)
const currentNodeId = ref('')
let removeProgressListener = null

const nodeCategories = computed(() => {
  const groups = []
  for (const [kind, def] of Object.entries(NODE_DEFS)) {
    let group = groups.find((item) => item.label === def.category)
    if (!group) {
      group = { label: def.category, items: [] }
      groups.push(group)
    }
    group.items.push({ kind, label: def.label })
  }
  return groups
})

const runStateText = computed(() => {
  if (running.value)
    return currentNodeId.value ? `运行中：${nodeLabel(currentNodeId.value)}` : '运行中'
  if (runError.value) return runError.value
  if (runRoot.value) return '运行完成'
  return '等待运行'
})

onMounted(() => {
  loadTemplates()
  window.addEventListener('click', closeContextMenu)
  removeProgressListener = window.api.onTaskProgress(handleTaskProgress)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeContextMenu)
  if (removeProgressListener) removeProgressListener()
})

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createBlankTemplate(name = '未命名工作流') {
  return {
    id: createId('tpl'),
    version: 1,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

function loadTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    templates.value =
      Array.isArray(parsed) && parsed.length ? parsed : [createBlankTemplate('默认工作流')]
  } catch {
    templates.value = [createBlankTemplate('默认工作流')]
  }
  activeTemplateId.value = templates.value[0].id
  loadActiveTemplate()
}

function persistTemplates() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.value))
  localStorage.setItem(OUTPUT_ROOT_KEY, outputRoot.value || '')
}

function toggleNodeCollapsed(id) {
  nodes.value = nodes.value.map((node) =>
    node.id === id ? { ...node, data: { ...node.data, collapsed: !node.data.collapsed } } : node
  )
}

function hydrateNode(node) {
  const kind = NODE_DEFS[node.data?.kind] ? node.data.kind : 'source-folder'
  const def = NODE_DEFS[kind]
  return {
    ...node,
    type: 'workflow',
    data: {
      kind,
      label: def.label,
      category: def.category,
      inputs: clone(def.inputs),
      outputs: clone(def.outputs),
      fields: clone(def.fields),
      params: { ...clone(def.params), ...(node.data?.params || {}) },
      collapsed: node.data?.collapsed === true,
      status: 'idle',
      message: '',
      metrics: {},
      onToggleCollapsed: toggleNodeCollapsed,
      onDelete: deleteNode
    }
  }
}

function serializeNodes() {
  return nodes.value.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: node.position,
    data: {
      kind: node.data.kind,
      params: clone(node.data.params || {}),
      collapsed: node.data.collapsed === true
    }
  }))
}

function serializeEdges() {
  return edges.value.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: edge.type || 'smoothstep',
    markerEnd: edge.markerEnd,
    data: edge.data || {}
  }))
}

async function loadActiveTemplate() {
  const tpl =
    templates.value.find((item) => item.id === activeTemplateId.value) || templates.value[0]
  if (!tpl) return
  activeTemplateId.value = tpl.id
  templateNameDraft.value = tpl.name
  nodes.value = (tpl.nodes || []).map(hydrateNode)
  edges.value = (tpl.edges || []).map((edge) => ({
    ...edge,
    type: edge.type || 'smoothstep',
    markerEnd: edge.markerEnd || { type: MarkerType.ArrowClosed }
  }))
  await nextTick()
  if (tpl.viewport) {
    try {
      setViewport(tpl.viewport)
    } catch {
      /* ignore */
    }
  }
}

function saveTemplate(showLog = true) {
  const tpl = templates.value.find((item) => item.id === activeTemplateId.value)
  if (!tpl) return
  const graph = toObject()
  tpl.version = 1
  tpl.name = templateNameDraft.value.trim() || '未命名工作流'
  tpl.nodes = serializeNodes()
  tpl.edges = serializeEdges()
  tpl.viewport = graph?.viewport || getViewport()
  persistTemplates()
  if (showLog) addLog(`已保存模板：${tpl.name}`)
}

function newTemplate() {
  saveTemplate(false)
  const tpl = createBlankTemplate(`工作流 ${templates.value.length + 1}`)
  templates.value.push(tpl)
  activeTemplateId.value = tpl.id
  persistTemplates()
  loadActiveTemplate()
}

function renameTemplate() {
  saveTemplate(true)
}

function duplicateTemplate() {
  saveTemplate(false)
  const src = templates.value.find((item) => item.id === activeTemplateId.value)
  if (!src) return
  const copyTpl = clone(src)
  copyTpl.id = createId('tpl')
  copyTpl.name = `${src.name} 副本`
  templates.value.push(copyTpl)
  activeTemplateId.value = copyTpl.id
  persistTemplates()
  loadActiveTemplate()
}

function deleteTemplate() {
  if (templates.value.length <= 1) {
    const tpl = createBlankTemplate('默认工作流')
    templates.value = [tpl]
    activeTemplateId.value = tpl.id
  } else {
    templates.value = templates.value.filter((item) => item.id !== activeTemplateId.value)
    activeTemplateId.value = templates.value[0].id
  }
  persistTemplates()
  loadActiveTemplate()
}

function onPaneContextMenu(event) {
  event.preventDefault()
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, position }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

function addNode(kind) {
  const def = NODE_DEFS[kind]
  if (!def) return
  const id = createId('node')
  nodes.value = [
    ...nodes.value,
    {
      id,
      type: 'workflow',
      position: contextMenu.value.position,
      data: {
        kind,
        label: def.label,
        category: def.category,
        inputs: clone(def.inputs),
        outputs: clone(def.outputs),
        fields: clone(def.fields),
        params: clone(def.params),
        collapsed: false,
        status: 'idle',
        message: '',
        metrics: {},
        onToggleCollapsed: toggleNodeCollapsed,
        onDelete: deleteNode
      }
    }
  ]
  closeContextMenu()
}

function findNode(id) {
  return nodes.value.find((node) => node.id === id)
}

function deleteNode(id) {
  if (running.value) {
    runError.value = '运行中不能删除节点'
    return
  }
  nodes.value = nodes.value.filter((node) => node.id !== id)
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id)
  if (currentNodeId.value === id) currentNodeId.value = ''
}

function nodeLabel(id) {
  const node = findNode(id)
  return node?.data?.label || id
}

function getPort(nodeId, handleId, direction) {
  const node = findNode(nodeId)
  const ports = direction === 'source' ? node?.data?.outputs : node?.data?.inputs
  return (ports || []).find((port) => port.id === handleId)
}

function hasPath(fromId, toId, edgeList = edges.value) {
  const queue = [fromId]
  const seen = new Set()
  while (queue.length) {
    const id = queue.shift()
    if (id === toId) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of edgeList) {
      if (edge.source === id) queue.push(edge.target)
    }
  }
  return false
}

function isValidConnection(connection) {
  if (
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  )
    return false
  if (connection.source === connection.target) return false
  const sourcePort = getPort(connection.source, connection.sourceHandle, 'source')
  const targetPort = getPort(connection.target, connection.targetHandle, 'target')
  if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) return false
  return !hasPath(connection.target, connection.source)
}

function onConnect(connection) {
  if (!isValidConnection(connection)) {
    runError.value = '连线失败：端口类型不匹配或会形成环'
    return
  }
  const sourcePort = getPort(connection.source, connection.sourceHandle, 'source')
  edges.value = [
    ...edges.value,
    {
      ...connection,
      id: createId('edge'),
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { valueType: sourcePort.type }
    }
  ]
  runError.value = ''
}

function clearNodeStatus() {
  for (const node of nodes.value) {
    node.data.status = 'idle'
    node.data.message = ''
    node.data.metrics = {}
    node.data.progress = null
  }
  runError.value = ''
  currentNodeId.value = ''
}

function patchNode(id, patch) {
  const node = findNode(id)
  if (!node) return
  Object.assign(node.data, patch)
}

function addLog(message) {
  const time = new Date().toLocaleTimeString()
  runLog.value.unshift({ id: createId('log'), time, message })
  runLog.value = runLog.value.slice(0, 80)
}

function stageText(stage, scope) {
  const key = String(stage || scope || '').toLowerCase()
  const labels = {
    collect: '收集',
    download: '下载',
    extract: '提取特征',
    match: '匹配',
    scan: '扫描',
    'grab-scan': '扫描',
    'grab-download': '下载',
    'grab-site': '抓取'
  }
  return labels[key] || stage || scope || '执行中'
}

function basenameText(value) {
  const text = String(value || '')
  if (!text) return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

function handleTaskProgress(payload = {}) {
  if (!running.value || !currentNodeId.value) return
  const done = Number(payload.done ?? 0)
  const total = Number(payload.total ?? 0)
  const percent = total > 0 ? Math.round(Math.max(0, Math.min(1, done / total)) * 100) : null
  const progress = {
    done,
    total,
    percent,
    stage: payload.stage || payload.scope || '',
    stageText: stageText(payload.stage, payload.scope),
    current: basenameText(payload.current || payload.file || ''),
    saved: payload.saved,
    failed: payload.failed
  }
  const message = total > 0 ? `${progress.stageText} ${done}/${total}` : progress.stageText
  patchNode(currentNodeId.value, { progress, message })
}

function validateWorkflow() {
  for (const edge of edges.value) {
    const sourcePort = getPort(edge.source, edge.sourceHandle, 'source')
    const targetPort = getPort(edge.target, edge.targetHandle, 'target')
    if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) {
      throw new Error(`连线类型错误：${nodeLabel(edge.source)} -> ${nodeLabel(edge.target)}`)
    }
  }

  const outputNodes = nodes.value.filter((node) => node.data.category === '输出节点')
  if (!outputNodes.length) throw new Error('需要至少添加一个输出节点')

  const reverse = new Map()
  for (const edge of edges.value) {
    if (!reverse.has(edge.target)) reverse.set(edge.target, [])
    reverse.get(edge.target).push(edge.source)
  }

  const involved = new Set()
  const queue = outputNodes.map((node) => node.id)
  while (queue.length) {
    const id = queue.shift()
    if (involved.has(id)) continue
    involved.add(id)
    for (const prev of reverse.get(id) || []) queue.push(prev)
  }

  for (const node of nodes.value) {
    if (!involved.has(node.id)) continue
    const def = NODE_DEFS[node.data.kind]
    for (const key of def.required || []) {
      const value = node.data.params?.[key]
      if (value === null || value === undefined || String(value).trim() === '') {
        throw new Error(`${node.data.label} 缺少必填参数：${key}`)
      }
    }
    for (const input of node.data.inputs || []) {
      const hasIncoming = edges.value.some(
        (edge) => edge.target === node.id && edge.targetHandle === input.id
      )
      if (!input.optional && !hasIncoming) {
        throw new Error(`${node.data.label} 缺少输入：${input.label}`)
      }
    }
  }

  const subEdges = edges.value.filter(
    (edge) => involved.has(edge.source) && involved.has(edge.target)
  )
  const indegree = new Map([...involved].map((id) => [id, 0]))
  for (const edge of subEdges) indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)
  const order = []
  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const edge of subEdges.filter((item) => item.source === id)) {
      indegree.set(edge.target, indegree.get(edge.target) - 1)
      if (indegree.get(edge.target) === 0) ready.push(edge.target)
    }
  }
  if (order.length !== involved.size) throw new Error('工作流存在环路')

  return { order, involved }
}

function makeFileValue(files, metadata = {}) {
  return { type: 'file-list', files: unique(files), metadata }
}

function makeMetadataValue(items) {
  return { type: 'metadata', items: items || {} }
}

function getNodeInputs(nodeId, values) {
  const inputMap = new Map()
  for (const edge of edges.value.filter((item) => item.target === nodeId)) {
    const value = values.get(`${edge.source}:${edge.sourceHandle}`)
    if (!value) continue
    const list = inputMap.get(edge.targetHandle) || []
    list.push(value)
    inputMap.set(edge.targetHandle, list)
  }
  return inputMap
}

function filesFromInputs(inputMap, port = 'files') {
  return unique((inputMap.get(port) || []).flatMap((value) => value.files || []))
}

function metadataFromInputs(inputMap) {
  const result = {}
  for (const values of inputMap.values()) {
    for (const value of values) {
      Object.assign(result, value.metadata || value.items || {})
    }
  }
  return result
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))]
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function imagePaths(entries) {
  return (entries || []).map((item) => item.path).filter(Boolean)
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function sanitizeSegment(value) {
  const reservedChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  return (
    String(value || 'output')
      .split('')
      .map((char) => (reservedChars.has(char) || char.charCodeAt(0) < 32 ? '_' : char))
      .join('')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'output'
  )
}

function joinRunPath(root, name) {
  return `${String(root || '').replace(/[\\/]+$/, '')}\\${sanitizeSegment(name)}`
}

function stageDir(root, node) {
  return joinRunPath(root, `${node.id}_${node.data.kind}`)
}

function resolveOutputDir(root, node) {
  const params = node.data.params || {}
  if (params.output_dir) return params.output_dir
  return joinRunPath(root, params.subfolder || node.data.kind)
}

function assertSuccess(result, fallback) {
  if (abortRequested.value || result?.aborted) throw new Error('任务已停止')
  if (!result || result.success === false || result.ok === false) {
    throw new Error(result?.error || fallback)
  }
}

async function collectOutputs(result, sourceFiles, folder) {
  const direct = []
  for (const item of result?.results || []) {
    if (item.ok === false) continue
    if (item.output) direct.push(item.output)
    else if (Array.isArray(item.outputs)) direct.push(...item.outputs)
    else if (item.skipped && item.file) direct.push(item.file)
  }
  if (direct.length) return unique(direct)
  const entries = await window.api.readImagesRecursive(folder)
  const paths = imagePaths(entries)
  return paths.length ? paths : unique(sourceFiles)
}

async function moveFilesToDel(files, label = '移入 del') {
  const targets = unique(files)
  if (!targets.length) return { moved: 0, failed: 0, failures: [] }

  let moved = 0
  let failed = 0
  const movedFiles = []
  const failures = []
  for (let index = 0; index < targets.length; index += 1) {
    if (abortRequested.value) throw new Error('任务已停止')
    const file = targets[index]
    patchNode(currentNodeId.value, {
      progress: {
        done: index,
        total: targets.length,
        percent: Math.round((index / targets.length) * 100),
        stageText: label,
        current: basenameText(file)
      },
      message: `${label} ${index}/${targets.length}`
    })
    const result = await window.api.deleteImage(file)
    if (result?.success) {
      moved += 1
      movedFiles.push(file)
    } else {
      failed += 1
      failures.push({ file, error: result?.error || '移动失败' })
    }
  }

  patchNode(currentNodeId.value, {
    progress: {
      done: targets.length,
      total: targets.length,
      percent: 100,
      stageText: label,
      current: ''
    },
    message: `${label} ${targets.length}/${targets.length}`
  })
  return { moved, failed, movedFiles, failures }
}

async function runTransform(endpoint, payload, sourceFiles, folder, fallback, metadata = {}) {
  const result = await window.api.callPython(endpoint, payload)
  assertSuccess(result, fallback)
  return makeFileValue(await collectOutputs(result, sourceFiles, folder), metadata)
}

async function runNode(node, inputMap, root) {
  const kind = node.data.kind
  const params = node.data.params || {}
  const inputFiles = filesFromInputs(inputMap)
  const inputMetadata = metadataFromInputs(inputMap)
  const folder = stageDir(root, node)

  if (abortRequested.value) throw new Error('任务已停止')

  switch (kind) {
    case 'source-folder': {
      const entries = await window.api.readImages(params.folder)
      return { files: makeFileValue(imagePaths(entries)) }
    }
    case 'source-generic': {
      const scan = await window.api.scanImageSources({
        sources: splitLines(params.sources),
        include_srcset: params.include_srcset !== false,
        file_types: splitCsv(params.file_types),
        max_per_source: Math.max(1, Math.min(params.max_per_source || 120, 500))
      })
      assertSuccess(scan, 'URL 扫描失败')
      const items = scan.items || []
      if (!items.length) return { files: makeFileValue([]) }
      const download = await window.api.downloadGrabImages({ output_dir: folder, items })
      assertSuccess(download, 'URL 下载失败')
      const files = (download.results || [])
        .filter((item) => item.success && item.path)
        .map((item) => item.path)
      return {
        files: makeFileValue(
          files.length ? files : imagePaths(await window.api.readImagesRecursive(folder))
        )
      }
    }
    case 'source-booru':
    case 'source-pixiv':
    case 'source-twitter': {
      const payload = buildGrabPayload(kind, params, folder)
      const result = await window.api.callPython('/grab-download', payload)
      assertSuccess(result, '抓取失败')
      return {
        files: makeFileValue(
          imagePaths(await window.api.readImagesRecursive(result.output_dir || folder))
        )
      }
    }
    case 'filter-resolution': {
      const result = await window.api.callPython('/resolution-filter', {
        files: inputFiles,
        min_width: params.min_width || 0,
        max_width: params.max_width || 0,
        min_height: params.min_height || 0,
        max_height: params.max_height || 0
      })
      assertSuccess(result, '分辨率过滤失败')
      const kept = (result.results || [])
        .filter((item) => item.ok && !item.filtered)
        .map((item) => item.file)
      const rejected = (result.results || [])
        .filter((item) => item.ok && item.filtered)
        .map((item) => item.file)
      let deleted = { moved: 0, failed: 0 }
      if (params.move_rejected_to_del !== false) {
        deleted = await moveFilesToDel(rejected, '移入 del')
      }
      return {
        files: makeFileValue(kept, inputMetadata),
        message: `保留 ${kept.length} 张，移入 del ${deleted.moved} 张${deleted.failed ? `，失败 ${deleted.failed} 张` : ''}`
      }
    }
    case 'filter-dedup': {
      const result = await window.api.callPython('/deduplicate', {
        files: inputFiles,
        hash_thresh: params.hash_thresh ?? 10,
        phash_thresh: params.phash_thresh ?? 10,
        color_thresh: params.color_thresh ?? 0.5
      })
      assertSuccess(result, '去重失败')
      const dedupItems = result.results || []
      const byFile = new Map(dedupItems.map((item) => [item.file, item]))
      const groupedItems = dedupItems.filter(
        (item) => item.group !== null && item.group !== undefined
      )
      const groupCount = new Set(groupedItems.map((item) => item.group)).size
      const cleanupStrategy = params.cleanup_strategy || 'quality'
      const reviewCount = groupedItems.filter((item) => item.quality_action === 'review').length
      const seenGroups = new Set()
      const kept = []
      const rejected = []

      if (cleanupStrategy === 'first') {
        for (const file of inputFiles) {
          const item = byFile.get(file)
          if (!item || item.group === null || item.group === undefined) {
            kept.push(file)
            continue
          }
          if (!seenGroups.has(item.group)) {
            seenGroups.add(item.group)
            kept.push(file)
          } else {
            rejected.push(file)
          }
        }
      } else {
        const removeFiles = new Set(
          groupedItems.filter((item) => item.quality_action === 'remove').map((item) => item.file)
        )
        for (const file of inputFiles) {
          if (removeFiles.has(file)) {
            rejected.push(file)
          } else {
            kept.push(file)
          }
        }
      }

      let deleted = { moved: 0, failed: 0, failures: [] }
      if (params.move_rejected_to_del !== false) {
        deleted = await moveFilesToDel(
          rejected,
          cleanupStrategy === 'quality' ? '清理低质重复图' : '移入 del'
        )
      }

      const strategyText =
        cleanupStrategy === 'quality'
          ? `建议清理 ${rejected.length} 张，待确认 ${reviewCount} 张`
          : `过滤重复 ${rejected.length} 张`
      const moveText =
        params.move_rejected_to_del !== false
          ? `移入 del ${deleted.moved} 张`
          : `仅从输出排除 ${rejected.length} 张，未移动文件`
      const failedText = deleted.failed ? `，失败 ${deleted.failed} 张` : ''
      if (deleted.failed) {
        const firstFailure = deleted.failures?.[0]
        if (firstFailure) {
          addLog(`清理失败示例：${basenameText(firstFailure.file)} - ${firstFailure.error}`)
        } else {
          addLog(`清理失败 ${deleted.failed} 张`)
        }
      }
      return {
        files: makeFileValue(kept, inputMetadata),
        message: `重复组 ${groupCount} 个，${strategyText}，保留 ${kept.length} 张，${moveText}${failedText}`
      }
    }
    case 'process-alpha':
      return {
        files: await runTransform(
          '/flatten-alpha',
          {
            files: inputFiles,
            output_dir: folder,
            background: params.background || 'white'
          },
          inputFiles,
          folder,
          '透明通道处理失败',
          inputMetadata
        )
      }
    case 'process-resize':
      return {
        files: await runTransform(
          '/batch-resize',
          {
            files: inputFiles,
            output_dir: folder,
            width: params.width || 1024,
            height: params.height || 1024,
            allow_upscale: params.allow_upscale === true,
            face_threshold: params.face_threshold ?? 0.5
          },
          inputFiles,
          folder,
          '缩放失败',
          inputMetadata
        )
      }
    case 'process-ratio-crop':
      return {
        files: await runTransform(
          '/proportional-crop',
          {
            files: inputFiles,
            output_dir: folder,
            ratio_w: params.ratio_w || 1,
            ratio_h: params.ratio_h || 1
          },
          inputFiles,
          folder,
          '比例裁剪失败',
          inputMetadata
        )
      }
    case 'process-three-split': {
      const result = await window.api.callPython('/three-stage-split', {
        files: inputFiles,
        output_dir: folder,
        person_conf: params.person_conf ?? 0.3,
        halfbody_conf: params.halfbody_conf ?? 0.3,
        head_conf: params.head_conf ?? 0.3
      })
      assertSuccess(result, '三分法裁剪失败')
      return {
        files: makeFileValue(
          imagePaths(await window.api.readImagesRecursive(folder)),
          inputMetadata
        )
      }
    }
    case 'process-format':
      return {
        files: await runTransform(
          '/format-convert',
          {
            files: inputFiles,
            output_dir: folder,
            target_format: params.target_format || 'png'
          },
          inputFiles,
          folder,
          '格式转换失败',
          inputMetadata
        )
      }
    case 'process-mirror':
      return {
        files: await runTransform(
          '/mirror-flip',
          {
            files: inputFiles,
            output_dir: folder
          },
          inputFiles,
          folder,
          '镜像失败',
          inputMetadata
        )
      }
    case 'process-cutout':
      return {
        files: await runTransform(
          '/cutout',
          {
            files: inputFiles,
            output_dir: folder,
            count: params.count || 1,
            size_ratio: params.size_ratio ?? 0.15
          },
          inputFiles,
          folder,
          'Cutout 失败',
          inputMetadata
        )
      }
    case 'process-perspective':
      return {
        files: await runTransform(
          '/perspective',
          {
            files: inputFiles,
            output_dir: folder,
            intensity: params.intensity ?? 0.1
          },
          inputFiles,
          folder,
          '透视处理失败',
          inputMetadata
        )
      }
    case 'process-blur-noise':
      return {
        files: await runTransform(
          '/gaussian-blur-noise',
          {
            files: inputFiles,
            output_dir: folder,
            blur_radius: params.blur_radius ?? 2,
            noise_sigma: params.noise_sigma ?? 15
          },
          inputFiles,
          folder,
          '模糊/噪声失败',
          inputMetadata
        )
      }
    case 'process-upscale':
      return {
        files: await runTransform(
          '/upscale',
          {
            files: inputFiles,
            output_dir: folder,
            scale: params.scale || 2,
            denoise: params.denoise || 'denoise3x',
            model: params.model || 'real-cugan',
            style: params.style || 'art',
            tta: params.tta === true
          },
          inputFiles,
          folder,
          '超分失败',
          inputMetadata
        )
      }
    case 'metadata-tagger':
      return await runTaggerNode(params, inputFiles, inputMetadata)
    case 'metadata-aesthetic':
      return await runAestheticNode(params, inputFiles, inputMetadata)
    case 'metadata-caption':
      return await runCaptionNode(params, inputFiles, inputMetadata)
    case 'output-save': {
      const targetDir = resolveOutputDir(root, node)
      const result = await window.api.copyWorkflowFiles(inputFiles, targetDir)
      assertSuccess(result, '保存输出失败')
      const copied = (result.results || [])
        .filter((item) => item.success && item.path)
        .map((item) => item.path)
      return { files: makeFileValue(copied, inputMetadata) }
    }
    case 'output-cluster': {
      const cluster = await window.api.callPython('/cluster', {
        files: inputFiles,
        method: params.method || 'style',
        algorithm: params.algorithm || 'kmeans',
        k: params.k || 5
      })
      assertSuccess(cluster, '聚类失败')
      const filesByGroup = {}
      for (const item of cluster.results || []) {
        if (item.group === null || item.group === undefined) continue
        const key = String(item.group)
        if (!filesByGroup[key]) filesByGroup[key] = []
        filesByGroup[key].push(item.file)
      }
      if (!Object.keys(filesByGroup).length) throw new Error('聚类没有生成有效分组')
      const targetDir = resolveOutputDir(root, node)
      const move = await window.api.callPython('/cluster-move', {
        files_by_group: filesByGroup,
        output_dir: targetDir
      })
      assertSuccess(move, '聚类输出失败')
      return {
        files: makeFileValue(
          imagePaths(await window.api.readImagesRecursive(targetDir)),
          inputMetadata
        )
      }
    }
    default:
      throw new Error(`未知节点：${kind}`)
  }
}

function buildGrabPayload(kind, params, outputDir) {
  if (kind === 'source-twitter') {
    return {
      site: 'twitter',
      output_dir: outputDir,
      cookie: params.cookie || '',
      query: params.query || '',
      limit: Math.max(1, params.limit || 1),
      include_video: params.include_video === true,
      enable_resume: params.enable_resume !== false
    }
  }
  if (kind === 'source-pixiv') {
    return {
      site: 'pixiv',
      output_dir: outputDir,
      cookie: params.cookie || '',
      mode: params.mode || 'user',
      query: params.query || '',
      limit: Math.max(1, params.limit || 1),
      min_bookmarks: Math.max(0, params.min_bookmarks || 0),
      start_page: Math.max(1, params.start_page || 1),
      end_page: Math.max(params.start_page || 1, params.end_page || params.start_page || 1),
      ugoira: params.ugoira || 'skip',
      enable_resume: params.enable_resume !== false
    }
  }
  return {
    site: params.site || 'danbooru',
    output_dir: outputDir,
    tags: params.tags || '',
    limit: Math.max(1, params.limit || 1),
    per_page: Math.max(1, params.per_page || 1),
    min_score: params.min_score || 0,
    rating: params.rating || 'all',
    filter_ai: params.filter_ai !== false,
    only_original: params.only_original !== false,
    write_txt: params.write_txt !== false,
    enable_resume: params.enable_resume !== false
  }
}

async function runTaggerNode(params, files, inputMetadata) {
  const models = await window.api.callPython('/tagger-models', {})
  assertSuccess(models, '读取打标模型失败')
  const selected = params.model_key
    ? (models.models || []).find((item) => item.key === params.model_key)
    : (models.models || []).find((item) => item.downloaded) || (models.models || [])[0]
  if (!selected) throw new Error('没有可用打标模型')
  if (!selected.downloaded) throw new Error(`打标模型未下载：${selected.key}`)

  const result = await window.api.callPython('/tagger-tag', {
    files,
    model_key: selected.key,
    general_threshold: params.general_threshold ?? 0.35,
    character_threshold: params.character_threshold ?? 0.85,
    keep_copyright: params.keep_copyright !== false,
    keep_rating: params.keep_rating === true,
    keep_meta: params.keep_meta === true,
    keep_model: params.keep_model === true,
    keep_quality: params.keep_quality === true
  })
  assertSuccess(result, '自动打标失败')
  const tags = {}
  for (const item of result.results || []) {
    if (item.ok && item.file) tags[item.file] = item.tag_string || ''
  }
  if (Object.keys(tags).length) await window.api.batchSaveTags(tags)
  return {
    files: makeFileValue(files, { ...inputMetadata, ...tags }),
    metadata: makeMetadataValue(tags)
  }
}

function selectDeepGhsModel(models, kind, key, label) {
  const candidates = (models || []).filter((item) => item.kind === kind)
  const modelKey = String(key || '').trim()
  const selected = modelKey
    ? candidates.find((item) => item.key === modelKey)
    : candidates.find((item) => item.downloaded) || candidates[0]
  if (!selected) throw new Error(`没有可用${label}模型`)
  if (!selected.downloaded) throw new Error(`${label}模型未下载：${selected.key}`)
  return selected
}

function formatAestheticMetadata(item) {
  if (!item?.ok) return `error: ${item?.error || 'failed'}`
  const score = item.aesthetic_score == null ? '-' : Number(item.aesthetic_score).toFixed(2)
  const classText = item.class_label || '-'
  const qualityText = item.aesthetic_label || '-'
  const parts = [`score:${score}`, `quality:${qualityText}`, `class:${classText}`]
  if (item.class_confidence != null) {
    parts.push(`class_conf:${Math.round(Number(item.class_confidence) * 100)}%`)
  }
  if (item.class_passed === false) parts.push('class_passed:no')
  if (item.low_score) parts.push('low_score:yes')
  if (item.class_fallback) parts.push(`fallback:${item.class_fallback}`)
  if (item.raw_class_label && item.raw_class_label !== item.class_label) {
    parts.push(`raw_class:${item.raw_class_label}`)
  }
  return parts.join(', ')
}

async function runAestheticNode(params, files, inputMetadata) {
  if (!files.length) {
    return {
      files: makeFileValue([], inputMetadata),
      metadata: makeMetadataValue({}),
      message: '没有可评分图片'
    }
  }

  const models = await window.api.callPython('/deepghs-models', {})
  assertSuccess(models, '读取美学模型失败')
  const classifier = selectDeepGhsModel(
    models.models,
    'classifier',
    params.classifier_model_key,
    '分类'
  )
  const aesthetic = selectDeepGhsModel(
    models.models,
    'aesthetic',
    params.aesthetic_model_key,
    '评分'
  )
  const classFilterEnabled = params.class_filter_enabled === true
  const minScore = clampNumber(params.min_score, 5, 0, 10)
  const classThreshold = clampNumber(params.class_threshold, 0, 0, 0.95)

  const result = await window.api.callPython('/deepghs-analyze', {
    files,
    classifier_model_key: classifier.key,
    aesthetic_model_key: aesthetic.key,
    allowed_classes: classFilterEnabled ? splitCsv(params.allowed_classes) : [],
    class_threshold: classThreshold,
    min_score: minScore,
    score_only_passed: classFilterEnabled && params.score_only_passed === true,
    letterbox_preprocess: params.letterbox_preprocess !== false,
    relaxed_class_match: params.relaxed_class_match !== false
  })
  assertSuccess(result, '美学评分失败')

  const results = result.results || []
  const byFile = new Map(results.map((item) => [item.file, item]))
  const metadata = {}
  for (const item of results) {
    if (item.file) metadata[item.file] = formatAestheticMetadata(item)
  }

  const lowFiles = results
    .filter(
      (item) =>
        item.ok &&
        item.file &&
        (!classFilterEnabled || item.class_passed) &&
        item.aesthetic_score != null &&
        Number(item.aesthetic_score) < minScore
    )
    .map((item) => item.file)
  let outputFiles = files
  let deleted = { moved: 0, failed: 0 }

  if (params.keep_only_passed === true) {
    outputFiles = files.filter((file) => {
      const item = byFile.get(file)
      if (!item?.ok || item.aesthetic_score == null) return false
      if (Number(item.aesthetic_score) < minScore) return false
      return !classFilterEnabled || item.class_passed
    })
  }

  if (params.move_low_to_del === true) {
    deleted = await moveFilesToDel(lowFiles, '低分入 del')
    const movedSet = new Set(deleted.movedFiles || [])
    outputFiles = outputFiles.filter((file) => !movedSet.has(file))
  }

  const outputMetadata = {}
  for (const file of outputFiles) {
    if (metadata[file] !== undefined) outputMetadata[file] = metadata[file]
  }

  const scored = results.filter((item) => item.ok && item.aesthetic_score != null).length
  const rejected = classFilterEnabled
    ? results.filter((item) => item.ok && item.class_passed === false).length
    : 0
  const moveText =
    params.move_low_to_del === true ? `，低分入 del ${deleted.moved} 张` : ''
  const failedText = deleted.failed ? `，移动失败 ${deleted.failed} 张` : ''
  const filterText =
    params.keep_only_passed === true ? `，输出达标 ${outputFiles.length} 张` : ''
  const classText = classFilterEnabled ? `，分类过滤 ${rejected} 张` : ''

  return {
    files: makeFileValue(outputFiles, { ...inputMetadata, ...outputMetadata }),
    metadata: makeMetadataValue(metadata),
    message: `已评分 ${scored} 张，低分 ${lowFiles.length} 张${classText}${filterText}${moveText}${failedText}`
  }
}

async function runCaptionNode(params, files, inputMetadata) {
  const configs = (await loadApiConfigs()).filter((cfg) => cfg.enabled !== false)
  const selected = params.api_config
    ? configs.find((cfg) => cfg.id === params.api_config || cfg.name === params.api_config)
    : configs[0]
  if (!selected) throw new Error('没有启用的 Caption API 配置')
  if (!selected.apiKey) throw new Error(`Caption API 缺少 key：${selected.name || selected.model}`)

  const result = await window.api.callPython('/caption-batch', {
    files,
    model: selected.model,
    api_key: selected.apiKey,
    base_url: selected.endpoint,
    system_prompt: params.system_prompt || '',
    user_prompt: params.user_prompt || 'Please describe this image.',
    temperature: params.temperature ?? 0,
    top_p: params.top_p ?? 0,
    max_tokens: params.max_tokens || 1024,
    disable_think: params.disable_think === true,
    concurrency: params.concurrency || 4,
    image_size: params.image_size || 1024
  })
  assertSuccess(result, 'Caption 失败')
  const captions = {}
  for (const item of result.results || []) {
    if (item.ok && item.file) captions[item.file] = item.caption || ''
  }
  if (Object.keys(captions).length) await window.api.batchSaveTags(captions)
  return {
    files: makeFileValue(files, { ...inputMetadata, ...captions }),
    metadata: makeMetadataValue(captions)
  }
}

async function chooseOutputRoot() {
  const folder = await window.api.selectFolder()
  if (folder) {
    outputRoot.value = folder
    persistTemplates()
  }
}

async function runWorkflow() {
  if (running.value) return
  saveTemplate(false)
  clearNodeStatus()
  runLog.value = []
  runRoot.value = ''
  abortRequested.value = false

  let plan
  try {
    plan = validateWorkflow()
  } catch (err) {
    runError.value = err.message
    addLog(err.message)
    return
  }

  running.value = true
  const values = new Map()
  try {
    for (const nodeId of plan.order)
      patchNode(nodeId, { status: 'queued', message: '', metrics: {} })
    const rootResult = await window.api.createWorkflowRunDir(
      outputRoot.value,
      templateNameDraft.value || 'workflow'
    )
    if (typeof rootResult !== 'string') assertSuccess(rootResult, '创建运行目录失败')
    const root = rootResult
    runRoot.value = root
    addLog(`运行目录：${root}`)

    for (const nodeId of plan.order) {
      if (abortRequested.value) throw new Error('任务已停止')
      const node = findNode(nodeId)
      currentNodeId.value = nodeId
      patchNode(nodeId, {
        status: 'running',
        message: '执行中...',
        progress: { done: 0, total: 0, percent: null, stageText: '执行中', current: '' }
      })
      addLog(`开始：${node.data.label}`)
      const result = await runNode(node, getNodeInputs(nodeId, values), root)
      for (const output of node.data.outputs || []) {
        const value = result[output.id]
        if (value) values.set(`${node.id}:${output.id}`, value)
      }
      const count = result.files?.files?.length
      const resultMessage = result.message || (count != null ? `输出 ${count} 张` : '完成')
      patchNode(nodeId, {
        status: 'done',
        message: resultMessage,
        metrics: count != null ? { count } : {},
        progress: {
          done: count || 1,
          total: count || 1,
          percent: 100,
          stageText: '完成',
          current: ''
        }
      })
      addLog(`完成：${node.data.label} - ${resultMessage}`)
    }
    currentNodeId.value = ''
    addLog('工作流执行完成')
  } catch (err) {
    if (currentNodeId.value)
      patchNode(currentNodeId.value, { status: 'error', message: err.message || '执行失败' })
    runError.value = err.message || '执行失败'
    addLog(runError.value)
  } finally {
    running.value = false
    currentNodeId.value = ''
  }
}

async function stopRun() {
  if (!running.value) return
  abortRequested.value = true
  addLog('停止请求已发送')
  try {
    await window.api.abortTask()
  } catch {
    /* ignore */
  }
}

function resetStatus() {
  clearNodeStatus()
  runLog.value = []
  runRoot.value = ''
}
</script>

<template>
  <div class="workflow-page">
    <header class="workflow-toolbar" @click.stop>
      <div class="template-tools">
        <select
          v-model="activeTemplateId"
          class="tool-select"
          :disabled="running"
          @change="loadActiveTemplate"
        >
          <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
        </select>
        <input
          v-model="templateNameDraft"
          class="tool-input name-input"
          type="text"
          spellcheck="false"
          :disabled="running"
        />
        <button
          class="icon-tool"
          type="button"
          title="保存模板"
          :disabled="running"
          @click="saveTemplate(true)"
        >
          <Save :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="重命名"
          :disabled="running"
          @click="renameTemplate"
        >
          <Pencil :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="新建模板"
          :disabled="running"
          @click="newTemplate"
        >
          <Plus :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="复制模板"
          :disabled="running"
          @click="duplicateTemplate"
        >
          <Copy :size="15" />
        </button>
        <button
          class="icon-tool danger"
          type="button"
          title="删除模板"
          :disabled="running"
          @click="deleteTemplate"
        >
          <Trash2 :size="15" />
        </button>
      </div>

      <div class="run-tools">
        <button class="primary-tool" type="button" :disabled="running" @click="runWorkflow">
          <Play :size="15" />
          运行
        </button>
        <button class="icon-tool" type="button" title="停止" :disabled="!running" @click="stopRun">
          <Square :size="15" />
        </button>
        <button class="icon-tool" type="button" title="适配画布" @click="fitView({ padding: 0.2 })">
          <Maximize2 :size="15" />
        </button>
        <button
          class="icon-tool"
          type="button"
          title="清状态"
          :disabled="running"
          @click="resetStatus"
        >
          <RotateCcw :size="15" />
        </button>
      </div>

      <div class="output-tools">
        <span class="output-label">输出根目录</span>
        <input
          v-model="outputRoot"
          class="tool-input output-input"
          type="text"
          placeholder="留空自动使用应用数据目录 workflow_runs"
          spellcheck="false"
          @change="persistTemplates"
        />
        <button
          class="icon-tool"
          type="button"
          title="选择输出根目录"
          :disabled="running"
          @click="chooseOutputRoot"
        >
          <FolderOpen :size="15" />
        </button>
      </div>
    </header>

    <section class="workflow-body">
      <VueFlow
        id="workflow-canvas"
        v-model:nodes="nodes"
        v-model:edges="edges"
        class="flow-canvas"
        :node-types="nodeTypes"
        :is-valid-connection="isValidConnection"
        :min-zoom="0.18"
        :max-zoom="1.6"
        :default-viewport="{ x: 0, y: 0, zoom: 0.9 }"
        fit-view-on-init
        @connect="onConnect"
        @pane-context-menu="onPaneContextMenu"
      >
        <Background :gap="24" :size="1.2" />
        <Controls />
      </VueFlow>

      <aside class="run-panel">
        <div class="panel-title">运行状态</div>
        <div :class="['state-card', { error: runError, running }]">
          <span>{{ runStateText }}</span>
          <small v-if="runRoot">{{ runRoot }}</small>
        </div>
        <div class="panel-title">日志</div>
        <div class="log-list">
          <div v-if="!runLog.length" class="empty-log">暂无日志</div>
          <div v-for="item in runLog" :key="item.id" class="log-row">
            <span>{{ item.time }}</span>
            <p>{{ item.message }}</p>
          </div>
        </div>
      </aside>

      <div
        v-if="contextMenu.visible"
        class="node-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
      >
        <div v-for="group in nodeCategories" :key="group.label" class="menu-group">
          <div class="menu-group-title">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.kind"
            type="button"
            class="menu-item"
            @click="addNode(item.kind)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workflow-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  overflow: hidden;
  padding: 0;
}

.workflow-toolbar {
  position: relative;
  display: grid;
  grid-template-columns: minmax(360px, auto) auto minmax(300px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 0 0 9px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  box-shadow: none;
}

.template-tools,
.run-tools,
.output-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.run-tools {
  justify-content: center;
}

.output-tools {
  justify-content: flex-end;
}

.tool-select,
.tool-input {
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  padding: 0 9px;
  font-size: 12px;
  outline: none;
}

.tool-select {
  width: 150px;
}

.name-input {
  width: 150px;
}

.output-input {
  flex: 1;
  min-width: 160px;
}

.output-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.icon-tool,
.primary-tool {
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.icon-tool {
  width: 30px;
  padding: 0;
}

.primary-tool {
  padding: 0 14px;
  background: var(--color-active-bg);
  color: var(--color-active-text);
  border-color: var(--color-active-bg);
}

.icon-tool:hover:not(:disabled),
.primary-tool:hover:not(:disabled) {
  border-color: var(--color-info);
  color: var(--color-text);
}

.primary-tool:hover:not(:disabled) {
  color: var(--color-active-text);
}

.icon-tool.danger:hover:not(:disabled) {
  border-color: var(--color-error);
  color: var(--color-error);
}

.icon-tool:disabled,
.primary-tool:disabled,
.tool-select:disabled,
.tool-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.workflow-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  gap: 9px;
}

.flow-canvas {
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-background);
  overflow: hidden;
}

:deep(.vue-flow__edge-path) {
  stroke: var(--color-info);
  stroke-width: 2;
}

:deep(.vue-flow__connection-path) {
  stroke: var(--color-info);
  stroke-width: 2;
}

:deep(.vue-flow__controls) {
  box-shadow: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.run-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}

.panel-title {
  padding: 9px 10px 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.state-card {
  margin: 0 10px 8px;
  padding: 9px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
  color: var(--color-text);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  min-height: 58px;
}

.state-card small {
  color: var(--color-text-muted);
  word-break: break-all;
  line-height: 1.35;
}

.state-card.running {
  background: var(--color-info-light);
  color: var(--color-info);
}

.state-card.error {
  background: var(--color-error-light);
  color: var(--color-error);
}

.log-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
}

.empty-log {
  padding: 16px 0;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
}

.log-row {
  border-bottom: 1px solid var(--color-surface-hover);
  padding: 8px 0;
}

.log-row span {
  display: block;
  font-size: 10px;
  color: var(--color-text-muted);
  margin-bottom: 2px;
}

.log-row p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}

.node-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  width: 240px;
  max-height: min(620px, calc(100vh - 60px));
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

.menu-group + .menu-group {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.menu-group-title {
  padding: 4px 6px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.menu-item {
  width: 100%;
  min-height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
}

.menu-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

@media (max-width: 1100px) {
  .workflow-toolbar {
    grid-template-columns: 1fr;
  }

  .run-tools,
  .output-tools {
    justify-content: flex-start;
  }

  .workflow-body {
    grid-template-columns: 1fr;
  }

  .run-panel {
    max-height: 220px;
  }
}

.primary-tool {
  background: var(--color-active-bg);
  border-color: var(--color-active-bg);
  color: var(--color-on-accent);
  box-shadow: var(--shadow-button);
}

.primary-tool:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}
</style>
