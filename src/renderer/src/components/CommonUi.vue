<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: '' },
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '请选择' }
})

const emit = defineEmits(['update:modelValue'])

const root = ref(null)
const open = ref(false)

const selectedLabel = computed(
  () => props.options.find((item) => item.value === props.modelValue)?.label || props.placeholder
)

function close() {
  open.value = false
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function select(value) {
  emit('update:modelValue', value)
  close()
}

function handleDocumentClick(event) {
  if (!root.value?.contains(event.target)) close()
}

onMounted(() => document.addEventListener('click', handleDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', handleDocumentClick))
</script>

<template>
  <div ref="root" class="common-ui-select" @click.stop>
    <button
      type="button"
      :class="['common-ui-select-trigger', { open }]"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="common-ui-select-value">{{ selectedLabel }}</span>
      <ChevronDown
        class="common-ui-select-arrow"
        :class="{ open }"
        :size="13"
        :stroke-width="2.5"
        aria-hidden="true"
      />
    </button>

    <Transition name="dropdown">
      <div v-if="open" class="common-ui-select-list">
        <button
          v-for="item in options"
          :key="item.value"
          type="button"
          :class="['common-ui-select-item', { active: modelValue === item.value }]"
          @click="select(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.common-ui-select {
  position: relative;
  width: 100%;
  min-width: 0;
}

.common-ui-select-trigger {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.common-ui-select-trigger:hover:not(:disabled),
.common-ui-select-trigger.open,
.common-ui-select-trigger:focus-visible {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.common-ui-select-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.common-ui-select-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.common-ui-select-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.16s ease;
}

.common-ui-select-arrow.open {
  transform: rotate(180deg);
}

.common-ui-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-input-bg);
  box-shadow: 0 10px 24px var(--color-shadow);
  max-height: 260px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border-hover) transparent;
}

.common-ui-select-list::-webkit-scrollbar {
  width: 7px;
}

.common-ui-select-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--color-border-hover);
}

.common-ui-select-item {
  width: 100%;
  min-height: 30px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.common-ui-select-item:hover {
  background: var(--color-surface-hover);
}

.common-ui-select-item.active {
  background: var(--color-active-bg);
  color: var(--color-active-text);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
  transform-origin: top center;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scaleY(0.9);
}
</style>
