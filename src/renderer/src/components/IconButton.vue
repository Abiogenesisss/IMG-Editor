<script setup>
import { computed } from 'vue'

const props = defineProps({
  icon: { type: [Object, Function], required: true },
  title: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  variant: { type: String, default: 'bar' },
  tone: { type: String, default: '' },
  size: { type: Number, default: 16 },
  active: { type: Boolean, default: false },
  spinning: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' }
})

defineEmits(['click'])

const variantClass = computed(() => {
  const map = {
    bar: 'bar-icon-btn',
    abort: 'abort-btn',
    editor: 'editor-nav-btn',
    toolbar: 'toolbar-icon-btn',
    window: 'window-btn',
    folder: 'folder-browse-btn'
  }
  return map[props.variant] || props.variant
})
</script>

<template>
  <button
    :type="type"
    :class="[
      'ui-icon-button',
      variantClass,
      tone ? `ui-icon-button--${tone}` : '',
      { active, spinning, delete: tone === 'delete', close: tone === 'close' }
    ]"
    :title="title"
    :aria-label="ariaLabel || title"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <component :is="icon" :size="size" :stroke-width="2" aria-hidden="true" />
  </button>
</template>
