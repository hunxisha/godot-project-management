<!-- 文档签名 token 渲染。色来自 main.css 的 .tok-*(与代码块同一套),这里只负责加粗名字。 -->
<script setup lang="ts">
import type { SigToken } from '../../utils/docSig'

defineProps<{ tokens: SigToken[] }>()

function cls(t: SigToken): string | undefined {
  const parts: string[] = []
  if (t.c) parts.push('tok-' + t.c)
  if (t.b) parts.push('sig-name')
  return parts.length ? parts.join(' ') : undefined
}
</script>

<template>
  <span v-for="(t, i) in tokens" :key="i" :class="cls(t)">{{ t.v }}</span>
</template>

<style scoped>
.sig-name {
  font-weight: 600;
}
</style>
