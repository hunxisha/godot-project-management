<script setup lang="ts">
import { ref } from 'vue'
import { listDocs } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import type { GodotVersion } from '../types/godot'

const versions = ref<(GodotVersion & { _id: string })[]>([])
versions.value = listDocs<GodotVersion>('godot/version/')
</script>

<template>
  <div class="versions">
    <EmptyState
      v-if="!versions.length"
      title="尚未安装 Godot 引擎"
      desc="从 GitHub Releases 下载官方版本(支持镜像加速),或导入本地已有的 Godot 可执行文件。"
    />
    <div v-else class="list">
      <!-- M1: 已装版本列表 + 可下载版本 -->
    </div>
  </div>
</template>

<style scoped>
.versions {
  padding: 16px;
}
</style>
