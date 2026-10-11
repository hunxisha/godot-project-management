<script setup lang="ts">
// 行级 diff 的渲染(§5.8)。算法在 `toolkit/diff.ts`(纯函数 + 变异取证),这里只把 hunks 画出来。
//
// 两条要看得见的事实:
//   · `degraded` 时给的是「差异过大,未逐行比对」的摘要而不是假 diff(预算闸是挡冻界面的,不是挡用户的);
//   · 没 diff 不代表没改动 —— 这一条照样能勾、能执行,diff 只是预览,不是判据。
import { computed } from 'vue'
import type { FileDiff } from '../../toolkit/diff'
import { diffStat, hunks } from '../../toolkit/diff'

const props = defineProps<{ diff?: FileDiff | null, error?: string, rel?: string }>()

const hs = computed(() => (props.diff && props.diff.lines ? hunks(props.diff.lines, 3) : []))
const stat = computed(() => diffStat(props.diff))
</script>

<template>
  <div class="diff">
    <div class="head">
      <span class="rel">{{ props.rel || '' }}</span>
      <span class="stat">{{ stat }}</span>
    </div>
    <p v-if="props.error" class="err">{{ props.error }}</p>
    <p v-else-if="props.diff && props.diff.degraded" class="warn-line">
      这份文件的差异太大,没做逐行比对 —— 上面那行统计就是能给的全部。要改的内容仍然照原样执行,diff 只是预览。
    </p>
    <template v-else-if="props.diff">
      <div v-for="(h, hi) in hs" :key="hi" class="hunk">
        <div v-for="(ln, li) in h.lines" :key="li" class="line" :class="ln.op">
          <span class="no">{{ ln.oldNo ?? '' }}</span>
          <span class="no">{{ ln.newNo ?? '' }}</span>
          <span class="mk">{{ ln.op === 'add' ? '+' : ln.op === 'del' ? '-' : ' ' }}</span>
          <span class="txt">{{ ln.text }}</span>
        </div>
      </div>
      <p v-if="!hs.length" class="dim">两边内容一致,没有差异可看(这条不该出现在执行清单里)。</p>
    </template>
  </div>
</template>

<style scoped>
.diff {
  margin: 4px 0 8px 22px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius-sm);
  background: var(--bg);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--surface-2);
  font-size: 11.5px;
}

.rel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  color: var(--text-2);
}

.stat {
  color: var(--text-3);
  white-space: nowrap;
}

.err,
.warn-line {
  margin: 0;
  padding: 6px 8px;
  color: var(--warn);
  font-size: 12px;
}

.err {
  color: var(--text-2);
}

.dim {
  margin: 0;
  padding: 6px 8px;
  color: var(--text-3);
  font-size: 12px;
}

.hunk + .hunk {
  border-top: 1px dashed var(--border);
}

.line {
  display: grid;
  grid-template-columns: 34px 34px 12px 1fr;
  gap: 4px;
  padding: 0 8px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.no {
  color: var(--text-3);
  text-align: right;
}

.mk {
  color: var(--text-3);
}

.line.add {
  background: var(--ok-weak);
}

.line.add .mk,
.line.add .txt {
  color: var(--ok);
}

.line.del {
  background: var(--danger-weak);
}

.line.del .mk,
.line.del .txt {
  color: var(--danger);
}
</style>
