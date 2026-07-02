<script setup>
import { HeartHandshake, PackageCheck } from 'lucide-vue-next'

defineOptions({ name: 'SpecialThanks' })

const sourceProjects = [
  { name: 'Waifu2x', url: 'https://github.com/nagadomi/waifu2x' },
  { name: 'nunif', url: 'https://github.com/nagadomi/nunif' },
  { name: 'Real-CUGAN', url: 'https://github.com/bilibili/ailab/tree/main/Real-CUGAN' },
  { name: 'Real-ESRGAN', url: 'https://github.com/xinntao/Real-ESRGAN' },
  { name: 'PixAI Tagger', url: 'https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx' },
  { name: 'CL Tagger', url: 'https://huggingface.co/cella110n/cl_tagger' },
  { name: 'SmilingWolf WD Tagger', url: 'https://huggingface.co/SmilingWolf' },
  { name: 'DeepGHS anime_classification', url: 'https://huggingface.co/deepghs/anime_classification' },
  { name: 'DeepGHS anime_aesthetic', url: 'https://huggingface.co/deepghs/anime_aesthetic' }
]
</script>

<template>
  <div class="thanks-page">
    <div class="thanks-content">
      <section class="thanks-hero">
        <div class="hero-icon">
          <HeartHandshake :size="24" :stroke-width="1.9" aria-hidden="true" />
        </div>
        <div class="hero-copy">
          <h1>特别鸣谢</h1>
        </div>
      </section>

      <section class="thanks-section">
        <div class="section-header">
          <PackageCheck :size="18" :stroke-width="2" aria-hidden="true" />
          <h2>模型与算法项目</h2>
        </div>
        <div class="project-list">
          <a
            v-for="project in sourceProjects"
            :key="project.name"
            class="project-row"
            :href="project.url"
            target="_blank"
            rel="noreferrer"
          >
            <span class="project-name">{{ project.name }}</span>
            <span class="project-url">{{ project.url }}</span>
          </a>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.thanks-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0 16px;
}

.thanks-content {
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.thanks-hero,
.thanks-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}

.thanks-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
}

.hero-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  color: var(--color-accent-text);
  background: var(--color-accent-light);
  border: 1px solid var(--color-accent-border);
  flex-shrink: 0;
}

.hero-copy h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  color: var(--color-text);
  letter-spacing: 0;
}

.thanks-section {
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--color-text);
}

.section-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.project-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}

.project-row {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-soft);
}

.project-row {
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-height: 60px;
  text-decoration: none;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}

.project-row:hover {
  border-color: var(--color-accent-border);
  background: var(--color-tag-hover-bg);
}

.project-name {
  color: var(--color-text);
  font-weight: 600;
  font-size: 13px;
}

.project-url {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

@media (max-width: 720px) {
  .thanks-hero {
    align-items: flex-start;
  }

  .project-list {
    grid-template-columns: 1fr;
  }
}
</style>
