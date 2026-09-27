<!-- BBCode token 递归渲染器:只认 tokenizeBBCode 的 token 类型,全部文本插值(无 v-html)。
     ref/url 事件向上抛,由文档面板决定站内跳转还是外开浏览器。 -->
<script setup lang="ts">
import { highlightCode } from '../../utils/bbcode'
import type { BBToken } from '../../utils/bbcode'
import BBCodeBlocks from './BBCodeBlocks.vue'

defineProps<{ tokens: BBToken[] }>()
const emit = defineEmits<{
  (e: 'ref', kind: string, target: string): void
  (e: 'url', href: string): void
}>()

/** 单个 codeblock 的语法着色(lang=text 等非代码语言整段原样) */
function hl(code: string, lang?: string) {
  return highlightCode(code, lang)
}

/** ref 的显示文本:带类前缀的成员只显示成员名,类引用显示全名 */
function labelOf(tk: BBToken): string {
  if (tk.t !== 'ref') return ''
  if ((tk.kind === 'method' || tk.kind === 'member' || tk.kind === 'signal' || tk.kind === 'param') && tk.target.includes('.')) {
    return tk.target.slice(tk.target.lastIndexOf('.') + 1)
  }
  return tk.target
}
</script>

<template>
  <template v-for="(tk, i) in tokens" :key="i">
    <span v-if="tk.t === 'text'">{{ tk.v }}</span>
    <code v-else-if="tk.t === 'code'" class="bb-code">{{ tk.v }}</code>
    <pre v-else-if="tk.t === 'codeblock'" class="bb-codeblock"><code><span v-for="(t, i) in hl(tk.v, tk.lang)" :key="i" :class="t.c ? 'tok-' + t.c : undefined">{{ t.v }}</span></code></pre>
    <BBCodeBlocks v-else-if="tk.t === 'codeblocks'" :segments="tk.segments" />
    <b v-else-if="tk.t === 'style' && tk.style === 'bold'"><BBTokens :tokens="tk.children" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" /></b>
    <i v-else-if="tk.t === 'style' && tk.style === 'italic'"><BBTokens :tokens="tk.children" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" /></i>
    <u v-else-if="tk.t === 'style' && tk.style === 'underline'"><BBTokens :tokens="tk.children" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" /></u>
    <s v-else-if="tk.t === 'style' && tk.style === 'strike'"><BBTokens :tokens="tk.children" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" /></s>
    <div v-else-if="tk.t === 'style' && tk.style === 'center'" class="bb-center"><BBTokens :tokens="tk.children" @ref="(k, t) => emit('ref', k, t)" @url="(h) => emit('url', h)" /></div>
    <a
      v-else-if="tk.t === 'ref'"
      class="bb-ref"
      href="#"
      @click.prevent="emit('ref', tk.kind, tk.target)"
    >{{ labelOf(tk) }}</a>
    <a v-else-if="tk.t === 'url'" class="bb-url" href="#" @click.prevent="emit('url', tk.href)">{{ tk.label }}</a>
    <br v-else-if="tk.t === 'br'">
  </template>
</template>

<style scoped>
.bb-code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  color: var(--brand);
}

.bb-codeblock {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow-x: auto;
}

.bb-codeblock code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  white-space: pre;
}

/* 语法着色(令牌在 main.css) */
.tok-kw {
  color: var(--syn-kw);
  font-weight: 600;
}

.tok-ty {
  color: var(--syn-ty);
}

.tok-str {
  color: var(--syn-str);
}

.tok-num {
  color: var(--syn-num);
}

.tok-com {
  color: var(--syn-com);
  font-style: italic;
}

.bb-center {
  text-align: center;
}

.bb-ref {
  color: var(--brand);
  text-decoration: none;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  border-bottom: 1px dashed color-mix(in srgb, var(--brand) 45%, transparent);
  cursor: pointer;
}

.bb-ref:hover {
  border-bottom-style: solid;
}

.bb-url {
  color: var(--brand);
  text-decoration: underline;
  word-break: break-all;
}
</style>
