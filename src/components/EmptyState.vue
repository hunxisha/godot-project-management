<script setup lang="ts">
import Icon from './Icon.vue'

defineProps<{ title: string; desc?: string; icon?: string }>()
</script>

<template>
  <div class="empty">
    <div class="glyph">
      <Icon :name="icon || 'box'" :size="40" :stroke-width="1.5" />
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
  gap: 8px;
  padding: 56px 24px 50px;
  text-align: center;
}

/* 大号手绘图标:品牌弱色圆底 */
.glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 76px;
  height: 76px;
  margin-bottom: 8px;
  border-radius: 50%;
  background: var(--brand-weak);
  color: var(--brand);
}

.title {
  font-size: 15.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--text);
}

.desc {
  max-width: 430px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-3);
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
</style>
