<script setup lang="ts">
defineProps<{ title: string; desc?: string }>()
</script>

<template>
  <div class="empty">
    <svg class="icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="8" y="14" width="32" height="26" rx="4" stroke="currentColor" stroke-width="2.5" />
      <path d="M8 20h32" stroke="currentColor" stroke-width="2.5" />
      <path d="M18 10v6M30 10v6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      <circle cx="17" cy="30" r="2" fill="currentColor" />
      <circle cx="24" cy="30" r="2" fill="currentColor" />
      <circle cx="31" cy="30" r="2" fill="currentColor" />
    </svg>
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
  padding: 48px 24px;
  text-align: center;
  color: var(--text-3);
}

.icon {
  width: 44px;
  height: 44px;
  opacity: 0.55;
}

.title {
  font-size: 15px;
  color: var(--text-2);
  font-weight: 600;
}

.desc {
  max-width: 420px;
  font-size: 13px;
  color: var(--text-3);
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
</style>
