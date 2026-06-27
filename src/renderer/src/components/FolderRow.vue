<script setup>
import { FolderOpen } from 'lucide-vue-next'
defineProps({
  label: { type: String, required: true },
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue', 'commit', 'browse'])

function onInput(event) {
  emit('update:modelValue', event.target.value)
}

function onChange(event) {
  emit('commit', event.target.value.trim())
}
</script>

<template>
  <div class="folder-row">
    <span class="folder-label">{{ label }}</span>
    <input
      class="folder-input"
      :value="modelValue"
      :placeholder="placeholder"
      @input="onInput"
      @change="onChange"
    />
    <button class="folder-browse-btn" type="button" title="选择文件夹" @click="$emit('browse')">
      <FolderOpen :size="16" :stroke-width="2" aria-hidden="true" />
    </button>
  </div>
</template>
