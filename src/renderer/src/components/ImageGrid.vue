<script setup>
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import ImagePreview from './ImagePreview.vue'

const props = defineProps({
  images: { type: Array, default: () => [] },
  thumbnails: { type: Object, default: () => ({}) },
  isSelected: { type: Function, default: () => false },
  cardClass: { type: Function, default: () => null },
  cardStyle: { type: Function, default: () => null },
  previewImage: { type: Object, default: null },
  deleteDisabled: { type: Boolean, default: false },
  gridClass: { type: [String, Array, Object], default: '' },
  emptyText: { type: String, default: '选择输入文件夹以加载图片' }
})

const emit = defineEmits(['open', 'toggle-select', 'close-preview', 'deleted', 'load-thumbnail'])
const gridRef = ref(null)
let observer = null

function disconnectObserver() {
  observer?.disconnect()
  observer = null
}

function observeGrid() {
  disconnectObserver()
  const grid = gridRef.value
  if (!grid) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const path = entry.target.dataset.path
        if (!props.thumbnails[path]) emit('load-thumbnail', path)
      }
    },
    { root: grid, rootMargin: '300px 0px' }
  )
  // 缓存会淘汰旧缩略图，卡片滚回视区时仍需重新触发加载。
  for (const card of grid.querySelectorAll('.image-card[data-path]')) {
    observer.observe(card)
  }
}

onMounted(observeGrid)
onActivated(observeGrid)
onDeactivated(disconnectObserver)
onUnmounted(disconnectObserver)
watch(() => props.images, observeGrid, { flush: 'post' })
</script>

<template>
  <div v-if="images.length > 0" ref="gridRef" :class="['image-grid', gridClass]">
    <div
      v-for="img in images"
      :key="img.path"
      :data-path="img.path"
      :class="['image-card', { selected: isSelected(img) }, cardClass(img)]"
      :style="cardStyle(img)"
      @click="emit('open', img)"
    >
      <img
        v-if="thumbnails[img.path]"
        :src="thumbnails[img.path]"
        :alt="img.name"
        draggable="false"
      />
      <div v-else class="image-placeholder"></div>
      <div class="image-name-overlay">{{ img.name }}</div>
      <slot :img="img"></slot>
      <span
        :class="['checkbox', { checked: isSelected(img) }]"
        @click.stop="emit('toggle-select', img)"
      ></span>
    </div>
  </div>

  <div v-else class="empty-state">
    <span class="empty-text">{{ emptyText }}</span>
  </div>

  <Teleport to="body">
    <ImagePreview
      v-if="previewImage"
      :image="previewImage"
      :images="images"
      :delete-disabled="deleteDisabled"
      @open="emit('open', $event)"
      @close="emit('close-preview')"
      @deleted="emit('deleted', $event)"
    />
  </Teleport>
</template>
