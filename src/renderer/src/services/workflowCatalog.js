import {
  createFallbackUpscaleCatalog,
  getUpscaleDenoiseOptions,
  getUpscaleScaleOptions,
  getUpscaleStyleOptions,
  listUpscaleModels
} from '../../../shared/upscaleCatalog'

const LEGACY_CAPTION_PROMPT = 'Please describe this image.'
export const DEFAULT_CAPTION_PROMPT = '请描述这张图片。'

const FILE_IN = [{ id: 'files', label: '输入', type: 'file-list' }]
const FILE_OUT = [{ id: 'files', label: '输出', type: 'file-list' }]
const META_OUT = { id: 'metadata', label: '文本', type: 'metadata' }
const DEFAULT_UPSCALE_CATALOG = createFallbackUpscaleCatalog()
const UPSCALE_MODEL_OPTIONS = listUpscaleModels(DEFAULT_UPSCALE_CATALOG)
const UPSCALE_SCALE_OPTIONS = [
  ...new Set(
    Object.keys(DEFAULT_UPSCALE_CATALOG).flatMap((model) =>
      getUpscaleScaleOptions(DEFAULT_UPSCALE_CATALOG, model).map((option) => option.value)
    )
  )
]
  .sort((a, b) => a - b)
  .map((value) => ({ value, label: `${value}X` }))
const UPSCALE_DENOISE_OPTIONS = [
  ...new Map(
    Object.keys(DEFAULT_UPSCALE_CATALOG)
      .flatMap((model) =>
        getUpscaleScaleOptions(DEFAULT_UPSCALE_CATALOG, model).flatMap((scale) =>
          getUpscaleDenoiseOptions(DEFAULT_UPSCALE_CATALOG, model, scale.value)
        )
      )
      .map((option) => [option.value, option])
  ).values()
]
const UPSCALE_STYLE_OPTIONS = getUpscaleStyleOptions(DEFAULT_UPSCALE_CATALOG, 'waifu2x')

export const NODE_DEFS = {
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
      {
        key: 'scale',
        label: '倍数',
        type: 'select',
        options: UPSCALE_SCALE_OPTIONS
      },
      {
        key: 'denoise',
        label: '降噪',
        type: 'select',
        options: UPSCALE_DENOISE_OPTIONS
      },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: UPSCALE_MODEL_OPTIONS
      },
      {
        key: 'style',
        label: '风格',
        type: 'select',
        options: UPSCALE_STYLE_OPTIONS
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
      keep_quality: false,
      replace_underscore: true
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
      { key: 'keep_quality', label: '质量标签', type: 'checkbox' },
      { key: 'replace_underscore', label: '下划线', type: 'checkbox', hint: '替换为空格' }
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
    label: '图片描述',
    category: '元数据节点',
    inputs: FILE_IN,
    outputs: [FILE_OUT[0], META_OUT],
    params: {
      api_config: '',
      system_prompt: '',
      user_prompt: DEFAULT_CAPTION_PROMPT,
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
      { key: 'system_prompt', label: '系统提示词', type: 'textarea', rows: 2 },
      { key: 'user_prompt', label: '用户提示词', type: 'textarea', rows: 3 },
      { key: 'temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'max_tokens', label: '最大 Token 数', type: 'number', min: 1 },
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

export function normalizeNodeParams(kind, params = {}) {
  const next = { ...JSON.parse(JSON.stringify(NODE_DEFS[kind].params)), ...params }
  if (kind === 'metadata-caption' && next.user_prompt === LEGACY_CAPTION_PROMPT) {
    next.user_prompt = DEFAULT_CAPTION_PROMPT
  }
  return next
}

export const nodeCategories = []
for (const [kind, def] of Object.entries(NODE_DEFS)) {
  let group = nodeCategories.find((item) => item.label === def.category)
  if (!group) {
    group = { label: def.category, items: [] }
    nodeCategories.push(group)
  }
  group.items.push({ kind, label: def.label })
}
