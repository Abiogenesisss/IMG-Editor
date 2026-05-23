import { onMounted, ref, watch } from 'vue'

export function useGridObserver(images, observeGrid) {
  const gridRef = ref(null)

  function refreshGridObserver() {
    if (gridRef.value) observeGrid(gridRef.value)
  }

  onMounted(refreshGridObserver)
  watch(() => images.value, refreshGridObserver, { flush: 'post' })

  return gridRef
}
