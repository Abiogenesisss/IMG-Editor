import './assets/main.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

async function migrateLegacyApiConfigs() {
  try {
    const legacyRaw = localStorage.getItem('api-configs')
    if (legacyRaw === null) return
    const legacy = JSON.parse(legacyRaw || '[]')
    await window.api.migrateApiConfigs(Array.isArray(legacy) ? legacy : [])
    localStorage.removeItem('api-configs')
  } catch {
    // Keep the legacy value if migration fails so the settings page can retry.
  }
}

migrateLegacyApiConfigs()

const app = createApp(App)
app.use(router)
app.mount('#app')
