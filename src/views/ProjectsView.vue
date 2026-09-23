<script setup lang="ts">
import { ref, watch } from 'vue'
import { listDocs } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import type { GodotProject } from '../types/godot'

const props = defineProps<{ enterPayload?: string[] | null }>()
const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])

watch(
  () => props.enterPayload,
  () => {
    projects.value = listDocs<GodotProject>('godot/project/')
  },
  { immediate: true }
)
</script>

<template>
  <div class="projects">
    <EmptyState
      v-if="!projects.length"
      title="还没有 Godot 项目"
      desc="将项目文件夹拖入 ZTools 主输入框,选择「添加Godot项目」;或在「gp」项目列表页中点击「添加项目」手动选择目录。"
    />
    <div v-else class="list">
      <!-- M2: 项目列表 -->
    </div>
  </div>
</template>

<style scoped>
.projects {
  padding: 16px;
}
</style>
