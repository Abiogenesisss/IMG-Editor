<script setup>
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
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
        ></path>
      </svg>
    </button>
  </div>
</template>
