<script setup lang="ts">
const tabs = [
  { key: 'dashboard', label: '概览' },
  { key: 'projects', label: '项目' },
  { key: 'versions', label: '版本' },
  { key: 'marketplace', label: '插件' },
  { key: 'settings', label: '设置' }
]

defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <nav class="tabbar">
    <div class="brand">
      <span class="logo">G</span>
      <span class="title">Godot 管理</span>
    </div>
    <button
      v-for="t in tabs"
      :key="t.key"
      class="tab"
      :class="{ active: modelValue === t.key }"
      @click="emit('update:modelValue', t.key)"
    >
      {{ t.label }}
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 14px 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 16px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--brand);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}

.tab {
  position: relative;
  padding: 8px 12px 9px;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--brand);
  font-weight: 600;
}

.tab.active::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--brand);
}
</style>
