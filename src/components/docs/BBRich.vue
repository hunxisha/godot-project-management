<!-- BBCode 富文本入口:字符串进,token 渲染出。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { tokenizeBBCode } from '../../utils/bbcode'
import BBTokens from './BBTokens.vue'

const props = defineProps<{ text: string }>()
const emit = defineEmits<{
  (e: 'ref', kind: string, target: string): void
  (e: 'url', href: string): void
}>()

const tokens = computed(() => tokenizeBBCode(props.text))
</script>

<template>
  <BBTokens :tokens="tokens" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" />
</template>
