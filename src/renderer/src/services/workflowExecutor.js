import { loadApiConfigs } from './apiConfigs'
import { loadUpscaleCatalog } from './upscaleModels'
import { validateUpscaleSelection } from '../../../shared/upscaleCatalog'
import { DEFAULT_CAPTION_PROMPT } from './workflowCatalog'

export function basenameText(value) {
  const text = String(value || '')
  if (!text) return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

// 执行器只接收取消、进度和日志回调，不持有画布节点或 Vue 状态。
export function createWorkflowExecutor({ isAborted, onNodeProgress, addLog }) {
  function makeFileValue(files, metadata = {}) {
    return { type: 'file-list', files: unique(files), metadata }
  }

  function makeMetadataValue(items) {
    return { type: 'metadata', items: items || {} }
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

  async function resolveWorkflowPath(root, name) {
    const result = await window.api.resolveWorkflowPath(root, name)
    if (typeof result !== 'string') assertSuccess(result, '创建工作流目录失败')
    return result
  }

  function stageDir(root, node) {
    return resolveWorkflowPath(root, `${node.id}_${node.data.kind}`)
  }

  async function resolveOutputDir(root, node) {
    const params = node.data.params || {}
    if (params.output_dir) return params.output_dir
    return resolveWorkflowPath(root, params.subfolder || node.data.kind)
  }

  function assertSuccess(result, fallback) {
    if (isAborted() || result?.aborted) throw new Error('任务已停止')
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
      if (isAborted()) throw new Error('任务已停止')
      const file = targets[index]
      onNodeProgress({
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

    onNodeProgress({
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
    const folder = await stageDir(root, node)

    if (isAborted()) throw new Error('任务已停止')

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
        {
          const catalog = await loadUpscaleCatalog()
          const validation = validateUpscaleSelection(catalog, {
            model: params.model || 'real-cugan',
            scale: params.scale || 2,
            denoise: params.denoise || 'denoise3x',
            style: params.style || 'art'
          })
          if (!validation.valid) throw new Error(validation.error)
        }
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
        const targetDir = await resolveOutputDir(root, node)
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
        const targetDir = await resolveOutputDir(root, node)
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
      general_threshold:
        params.general_threshold === 0.35 && selected.general_threshold != null
          ? selected.general_threshold
          : (params.general_threshold ?? selected.general_threshold ?? 0.35),
      character_threshold: params.character_threshold ?? 0.85,
      keep_copyright: params.keep_copyright !== false,
      keep_rating: params.keep_rating === true,
      keep_meta: params.keep_meta === true,
      keep_model: params.keep_model === true,
      keep_quality: params.keep_quality === true,
      replace_underscore: params.replace_underscore !== false
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
    const moveText = params.move_low_to_del === true ? `，低分入 del ${deleted.moved} 张` : ''
    const failedText = deleted.failed ? `，移动失败 ${deleted.failed} 张` : ''
    const filterText = params.keep_only_passed === true ? `，输出达标 ${outputFiles.length} 张` : ''
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
    if (!selected) throw new Error('没有启用的图片描述 API 配置')
    if (!selected.apiKey)
      throw new Error(`图片描述 API 缺少 key：${selected.name || selected.model}`)

    const result = await window.api.callPython('/caption-batch', {
      files,
      model: selected.model,
      api_key: selected.apiKey,
      base_url: selected.endpoint,
      system_prompt: params.system_prompt || '',
      user_prompt: params.user_prompt || DEFAULT_CAPTION_PROMPT,
      temperature: params.temperature ?? 0,
      top_p: params.top_p ?? 0,
      max_tokens: params.max_tokens || 1024,
      disable_think: params.disable_think === true,
      concurrency: params.concurrency || 4,
      image_size: params.image_size || 1024
    })
    assertSuccess(result, '图片描述失败')
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

  return { runNode, assertSuccess }
}
