<script setup lang="ts">
// 体检报告的界面内预览。
// reportMarkdown() 自 #19 落地起就有导出、没有调用点(useTools.ts 的 return 与 :623),
// 而它自己的注释写着「先看一眼也能用它」—— 那条路一直不存在,这里补上。
//
// 只渲染文本,不解析 markdown:报告要被粘进 issue / 聊天 / 文档,
// 预览与粘出去的内容必须逐字同一份(同一函数 produce 的字符串,不做二次加工)。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps<{
  open: boolean
  markdown: string
  title: string
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'copy'): void }>()

const lines = computed(() => props.markdown.split('\n').length)

/** Esc 关闭。写法与 FixConfirmDialog 一致:实测模板上的 .window 修饰符在这条链上不触发 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal lg report">
        <div class="modal-head">
          <div class="modal-title"><Icon name="book" :size="15" /> {{ title }}</div>
          <span class="cnt mono">{{ lines }} 行</span>
          <span class="grow"></span>
          <button type="button" class="btn small" title="复制到剪贴板(同时存进插件数据,每项目留最近一次)" @click="emit('copy')">
            <Icon name="copy" :size="12" /> 复制
          </button>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>
        <pre class="body mono">{{ markdown || '本轮还没有跑过任何体检。' }}</pre>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.report {
  display: flex;
  flex-direction: column;
}

.modal-title {
  min-width: 0;
}

.cnt {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.body {
  margin: 0;
  max-height: min(58vh, 520px);
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
