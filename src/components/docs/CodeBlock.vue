<!-- 代码块:语法着色 + 多语言标签页 + 一键复制。
     着色 token 的样式(.tok-*)在 main.css;这里只管容器与复制交互。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { highlightCode } from '../../utils/highlight'
import type { BBCodeSegment } from '../../utils/bbcode'
import { copyText } from '../../services/bridge'
import Icon from '../Icon.vue'

const props = withDefaults(defineProps<{
  segments: BBCodeSegment[]
  /** 单语言时是否显示语言小标签(代码块内联场景可关掉) */
  showLang?: boolean
}>(), { showLang: true })

const LANG_LABEL: Record<string, string> = { gdscript: 'GDScript', csharp: 'C#' }
const active = ref(0)
const labels = computed(() => props.segments.map((s) => LANG_LABEL[s.lang] || s.lang || '代码'))
const current = computed(() => props.segments[Math.min(active.value, props.segments.length - 1)])
const toks = computed(() => highlightCode(current.value?.code ?? '', current.value?.lang))

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

/** 复制当前标签页的原始代码(不含着色标记) */
function copy() {
  const seg = current.value
  if (!seg || !copyText(seg.code)) return
  copied.value = true
  clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1200)
}

onBeforeUnmount(() => clearTimeout(timer))
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
    <div v-else-if="showLang && labels[0] && labels[0] !== '代码'" class="cb-single-lang">{{ labels[0] }}</div>
    <button
      type="button"
      class="cb-copy"
      :class="{ ok: copied }"
      :title="copied ? '已复制' : '复制代码'"
      :aria-label="copied ? '已复制' : '复制代码'"
      @click="copy"
    >
      <Icon :name="copied ? 'check' : 'copy'" :size="13" />
    </button>
    <pre class="cb-pre"><code><span v-for="(t, i) in toks" :key="i" :class="t.c ? 'tok-' + t.c : undefined">{{ t.v }}</span></code></pre>
  </div>
</template>

<style scoped>
.cb {
  position: relative;
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
  padding: 12px 14px;
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
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  white-space: pre;
  tab-size: 4;
}

/* 复制按钮:悬停/键盘聚焦时出现,不干扰阅读;触屏设备常驻半透明 */
.cb-copy {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease;
}

.cb:hover .cb-copy,
.cb:focus-within .cb-copy {
  opacity: 1;
}

.cb-copy:hover {
  color: var(--brand);
  border-color: var(--border-strong);
}

.cb-copy.ok {
  color: var(--ok);
}

@media (hover: none) {
  .cb-copy {
    opacity: 0.62;
  }
}
</style>
