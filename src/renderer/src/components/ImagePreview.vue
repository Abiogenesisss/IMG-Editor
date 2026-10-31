<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-vue-next'

const props = defineProps({
  image: { type: Object, required: true },
  images: { type: Array, required: true },
  deleteDisabled: { type: Boolean, default: false }
})
const emit = defineEmits(['open', 'close', 'deleted'])
const dialogRef = ref(null)
const metadata = ref(null)
const dimensions = ref(null)
const metadataLoading = ref(false)
const metadataError = ref('')
const imageError = ref(false)
const deleteError = ref('')
const deleting = ref(false)
const index = computed(() => props.images.findIndex((img) => img.path === props.image.path))
const resolution = computed(() => {
  const value = metadata.value?.width && metadata.value?.height ? metadata.value : dimensions.value
  return value ? `${value.width} × ${value.height} px` : '—'
})
const fileSize = computed(() => {
  if (!metadata.value) return '—'
  const bytes = metadata.value.size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
})

watch(
  () => props.image,
  async (img, _previous, onCleanup) => {
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    metadata.value = null
    dimensions.value = null
    metadataError.value = ''
    imageError.value = false
    deleteError.value = ''
    metadataLoading.value = true
    try {
      const result = await window.api.getImageMetadata(img.path)
      if (cancelled) return
      if (result.success) metadata.value = result
      else metadataError.value = `无法读取文件信息：${result.error}`
    } catch (error) {
      if (!cancelled) metadataError.value = `无法读取文件信息：${error.message}`
    } finally {
      if (!cancelled) metadataLoading.value = false
    }
  },
  { immediate: true }
)

onMounted(() => dialogRef.value.showModal())

function close() {
  if (!deleting.value) emit('close')
}

function navigate(offset) {
  const next = props.images[index.value + offset]
  if (!deleting.value && index.value >= 0 && next) emit('open', next)
}

function onImageLoad(event) {
  if (event.target.dataset.path !== props.image.path) return
  dimensions.value = { width: event.target.naturalWidth, height: event.target.naturalHeight }
}

async function deleteCurrent() {
  if (deleting.value || props.deleteDisabled) return
  const current = props.image
  if (
    !window.confirm(
      `将「${current.name}」移动到同目录的 del 文件夹。\n文件不会被永久删除，是否继续？`
    )
  )
    return
  deleting.value = true
  deleteError.value = ''
  try {
    const result = await window.api.deleteImage(current.path)
    if (!result.success) {
      deleteError.value = `删除失败：${result.error}`
      return
    }
    const currentIndex = props.images.findIndex((img) => img.path === current.path)
    const next = props.images[currentIndex + 1] || props.images[currentIndex - 1]
    if (next) emit('open', next)
    else emit('close')
    emit('deleted', [current.path])
  } catch (error) {
    deleteError.value = `删除失败：${error.message}`
  } finally {
    deleting.value = false
  }
}

function onKeydown(event) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    navigate(event.key === 'ArrowLeft' ? -1 : 1)
  } else if (event.key === 'Delete') {
    event.preventDefault()
    if (!event.repeat) deleteCurrent()
  }
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="image-preview"
    aria-label="图片预览"
    @cancel.prevent="close"
    @click.self="close"
    @keydown="onKeydown"
  >
    <header class="preview-toolbar">
      <div class="preview-heading">
        <span class="preview-counter">{{ index + 1 }} / {{ images.length }}</span>
        <strong :title="image.name">{{ image.name }}</strong>
      </div>
      <div class="preview-actions">
        <button
          type="button"
          class="preview-delete"
          :disabled="deleteDisabled || deleting"
          title="删除当前图片，移入 del 文件夹（Delete）"
          @click="deleteCurrent"
        >
          <Trash2 :size="17" aria-hidden="true" />
          {{ deleting ? '删除中…' : '删除' }}
        </button>
        <button
          type="button"
          aria-label="关闭预览"
          title="关闭（Esc）"
          autofocus
          :disabled="deleting"
          @click="close"
        >
          <X :size="20" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="preview-stage" @click.self="close">
      <button
        type="button"
        class="preview-nav"
        aria-label="上一张"
        title="上一张（←）"
        :disabled="index <= 0 || deleting"
        @click="navigate(-1)"
      >
        <ChevronLeft :size="28" aria-hidden="true" />
      </button>
      <div class="preview-picture" @click.self="close">
        <img
          v-show="!imageError"
          :key="image.path"
          :src="image.url"
          :alt="image.name"
          :data-path="image.path"
          draggable="false"
          @load="onImageLoad"
          @error="imageError = true"
        />
        <p v-if="imageError" role="status">无法显示此图片，可查看文件信息或切换其他图片。</p>
      </div>
      <button
        type="button"
        class="preview-nav"
        aria-label="下一张"
        title="下一张（→）"
        :disabled="index < 0 || index >= images.length - 1 || deleting"
        @click="navigate(1)"
      >
        <ChevronRight :size="28" aria-hidden="true" />
      </button>
    </div>

    <footer class="preview-details">
      <dl :aria-busy="metadataLoading">
        <div>
          <dt>分辨率</dt>
          <dd>{{ resolution }}</dd>
        </div>
        <div>
          <dt>文件大小</dt>
          <dd>{{ fileSize }}</dd>
        </div>
        <div>
          <dt>格式</dt>
          <dd>{{ metadata?.format || '—' }}</dd>
        </div>
        <div>
          <dt>修改时间</dt>
          <dd>
            {{
              metadata
                ? new Date(metadata.modifiedAt).toLocaleString('zh-CN', { hour12: false })
                : '—'
            }}
          </dd>
        </div>
      </dl>
      <div class="preview-path" :title="image.path">{{ image.path }}</div>
      <p v-if="metadataLoading" class="preview-note" role="status">正在读取图片信息…</p>
      <p v-if="metadataError" class="preview-note" role="status">{{ metadataError }}</p>
      <p v-if="deleteError" class="preview-error" role="alert">{{ deleteError }}</p>
    </footer>
  </dialog>
</template>

<style scoped>
.image-preview {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 20px 28px;
  border: 0;
  box-sizing: border-box;
  color: #f4f4f5;
  background: rgba(16, 18, 25, 0.94);
}

.image-preview[open] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 16px;
}

.image-preview::backdrop {
  background: transparent;
}
.preview-toolbar,
.preview-heading,
.preview-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.preview-toolbar {
  justify-content: space-between;
}
.preview-heading {
  min-width: 0;
}
.preview-heading strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.preview-counter {
  flex-shrink: 0;
  font-size: 12px;
  color: #aeb3c2;
  font-variant-numeric: tabular-nums;
}
.preview-actions {
  flex-shrink: 0;
  gap: 8px;
}
.image-preview button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  min-width: 40px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.image-preview button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
}
.image-preview button:focus-visible {
  outline: 2px solid #8dbfff;
  outline-offset: 3px;
}
.image-preview button:disabled {
  opacity: 0.3;
  cursor: default;
}
.image-preview .preview-delete {
  padding-inline: 14px;
  color: #ffb4b4;
}
.preview-stage {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px;
  align-items: center;
  gap: 20px;
  min-height: 0;
}
.preview-picture {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  min-height: 0;
}
.preview-picture img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  user-select: none;
}
.preview-picture p {
  color: #aeb3c2;
  font-size: 13px;
  text-align: center;
}
.image-preview .preview-nav {
  width: 48px;
  height: 56px;
}
.preview-details {
  text-align: center;
  padding: 4px 56px 0;
}
.preview-details dl {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 28px;
  margin: 0 0 10px;
  font-size: 12px;
}
.preview-details dl div {
  display: flex;
  gap: 8px;
}
.preview-details dt {
  color: #aeb3c2;
}
.preview-details dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.preview-path {
  color: #aeb3c2;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.preview-note,
.preview-error {
  margin: 8px 0 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.preview-note {
  color: #aeb3c2;
}
.preview-error {
  color: #ffb4b4;
}
@media (max-width: 640px) {
  .image-preview {
    padding: 12px;
    gap: 12px;
  }
  .preview-stage {
    gap: 8px;
    grid-template-columns: 40px minmax(0, 1fr) 40px;
  }
  .image-preview .preview-nav {
    width: 40px;
  }
  .preview-heading {
    gap: 8px;
  }
  .preview-details {
    padding-inline: 0;
  }
}
</style>
