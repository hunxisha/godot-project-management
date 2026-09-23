<script setup lang="ts">
import Icon from './Icon.vue'

defineProps<{ title: string; desc?: string; icon?: string }>()
</script>

<template>
  <div class="empty">
    <div class="glyph">
      <Icon :name="icon || 'box'" :size="28" />
    </div>
    <div class="title">{{ title }}</div>
    <div v-if="desc" class="desc">{{ desc }}</div>
    <div class="actions"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 44px 24px;
  text-align: center;
}

.glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--brand-weak);
  color: var(--brand);
}

.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.desc {
  max-width: 420px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-3);
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
</style>
