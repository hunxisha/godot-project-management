<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue'
</script>

<template>
  <div class="marketplace">
    <EmptyState
      title="Godot 插件市场"
      desc="搜索并安装 Asset Library 中的插件到指定项目,支持更新与卸载。"
    />
  </div>
</template>

<style scoped>
.marketplace {
  padding: 16px;
}
</style>
