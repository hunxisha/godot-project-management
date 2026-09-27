<!-- [codeblocks] 多语言代码块:GDScript / C# 标签页切换(对齐编辑器帮助的双语言形态)。
     单一分段时不显示切换,只显示语言小标签。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BBCodeSegment } from '../../utils/bbcode'

const props = defineProps<{ segments: BBCodeSegment[] }>()

const active = ref(0)
const LANG_LABEL: Record<string, string> = { gdscript: 'GDScript', csharp: 'C#' }

const labels = computed(() => props.segments.map((s) => LANG_LABEL[s.lang] || s.lang || '代码'))
const current = computed(() => props.segments[Math.min(active.value, props.segments.length - 1)]?.code ?? '')
</script>

<template>
  <div class="cb">
    <div v-if="segments.length > 1" class="cb-tabs">
      <button
        v-for="(lb, i) in labels"
        :key="i"
        type="button"
        class="cb-tab"
        :class="{ on: i === active }"
        @click="active = i"
      >{{ lb }}</button>
    </div>
    <div v-else-if="labels[0] && labels[0] !== '代码'" class="cb-single-lang">{{ labels[0] }}</div>
    <pre class="cb-pre"><code>{{ current }}</code></pre>
  </div>
</template>

<style scoped>
.cb {
  margin: 8px 0;
}

.cb-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: var(--surface-2);
}

.cb-tab {
  padding: 3px 12px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}

.cb-tab.on {
  background: var(--surface);
  color: var(--brand);
}

.cb-single-lang {
  display: inline-block;
  padding: 2px 8px;
  margin-bottom: -1px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--surface-2);
}

.cb-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  overflow-x: auto;
}

.cb-tabs + .cb-pre,
.cb-single-lang + .cb-pre {
  border-top-left-radius: 0;
}

.cb-pre code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--text);
  white-space: pre;
}
</style>
