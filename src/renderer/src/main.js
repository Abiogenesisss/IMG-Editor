import './assets/main.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { migrateLegacyApiConfigs } from './services/apiConfigs'

migrateLegacyApiConfigs()

const app = createApp(App)
app.use(router)
app.mount('#app')
