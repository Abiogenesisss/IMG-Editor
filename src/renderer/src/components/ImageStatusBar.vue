<script setup>
import { computed } from 'vue'
import { Eraser, RefreshCw, Trash2, X } from 'lucide-vue-next'
import IconButton from './IconButton.vue'

const props = defineProps({
  imageCount: { type: Number, required: true },
  selectedCount: { type: Number, required: true },
  selectAll: { type: Boolean, default: false },
  refreshing: { type: Boolean, default: false },
  processingAction: { type: [String, null], default: null },
  progressDone: { type: Number, default: 0 },
  progressTotal: { type: Number, default: 0 },
  processingLabel: { type: String, default: '处理中' },
  refreshTitle: { type: String, default: '刷新' }
})

defineEmits(['toggle-select-all', 'refresh', 'clear-folder', 'delete-selected', 'abort'])

const hasProgress = computed(() => props.processingAction && props.progressTotal > 0)
const progressWidth = computed(() => {
  if (!props.progressTotal) return '0%'
  return `${(props.progressDone / props.progressTotal) * 100}%`
})
</script>

<template>
  <div v-if="imageCount > 0" class="status-bar">
    <label class="select-all-label" @click="$emit('toggle-select-all')">
      <span :class="['checkbox', { checked: selectAll }]"></span>
      全选
    </label>

    <div class="bar-btn-group">
      <IconButton
        :icon="RefreshCw"
        :spinning="refreshing"
        :title="refreshTitle"
        @click="$emit('refresh')"
      />
      <IconButton
        :icon="Eraser"
        title="清空当前文件夹"
        :disabled="!!processingAction"
        @click="$emit('clear-folder')"
      />
      <IconButton
        :icon="Trash2"
        tone="delete"
        title="删除选中图片"
        :disabled="selectedCount === 0"
        @click="$emit('delete-selected')"
      />
      <slot name="actions"></slot>
    </div>

    <span v-if="processingAction" class="status-progress">
      <template v-if="hasProgress">
        <span class="progress-bar-track">
          <span class="progress-bar-fill" :style="{ width: progressWidth }"></span>
        </span>
        <span class="progress-text">{{ processingLabel }} {{ progressDone }} / {{ progressTotal }}</span>
      </template>
      <span v-else class="progress-text status-pending">{{ processingLabel }}...</span>
      <IconButton :icon="X" variant="abort" title="终止任务" :size="14" @click="$emit('abort')" />
    </span>
    <span v-else class="status-text">
      <slot name="idle">共 {{ imageCount }} 张，已选 {{ selectedCount }} 张</slot>
    </span>

    <slot name="tail"></slot>
  </div>
</template>
