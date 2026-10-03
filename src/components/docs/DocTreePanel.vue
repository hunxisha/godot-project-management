<!-- 继承树:文档页左侧导航的「树」视图,完整铺开库内全部类。
     展开状态常驻(切类不塌回去),切类只做两件事:铺开「根 → 当前类」路径 + 滚动定位。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useDocs } from '../../composables/useDocs'
import { buildFullTreeRows, childrenMapFrom, rootsFrom, type DocTreeRow } from '../../utils/docTree'

const props = defineProps<{
  /** 当前打开的类 */
  currentClass: string
}>()
const emit = defineEmits<{ (e: 'navigate', name: string): void }>()

const { classes } = useDocs()

const rootEl = ref<HTMLElement | null>(null)
/** 用户铺开的节点。左栏是常驻导航,所以它跨类保留,只在切库时重置 */
const expanded = ref<Set<string>>(new Set())

/** 类名 → 父类 / 直接派生 / 根集合(按当前库建一次表) */
const treeIndex = computed(() => {
  const parents = new Map<string, string | null>()
  for (const c of classes.value) parents.set(c.name, c.inherits && c.inherits.length ? c.inherits : null)
  const childrenMap = childrenMapFrom(parents)
  return {
    roots: rootsFrom(parents),
    parentOf: (name: string) => parents.get(name) ?? null,
    childrenOf: (name: string) => childrenMap.get(name) ?? []
  }
})

const rows = computed<DocTreeRow[]>(() =>
  buildFullTreeRows({
    roots: treeIndex.value.roots,
    childrenOf: treeIndex.value.childrenOf,
    parentOf: treeIndex.value.parentOf,
    expanded: expanded.value,
    currentClass: props.currentClass
  })
)

/** 切类只铺开祖先链,当前类自身不展开(它可能有一堆子类,铺开会把导航撑长) */
function ancestorsOf(name: string): string[] {
  const out: string[] = []
  let cursor = treeIndex.value.parentOf(name)
  while (cursor) {
    out.push(cursor)
    cursor = treeIndex.value.parentOf(cursor)
  }
  return out
}

function revealCurrent() {
  const next = new Set(expanded.value)
  for (const a of ancestorsOf(props.currentClass)) next.add(a)
  expanded.value = next
  nextTick(() => rootEl.value?.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' }))
}

/** 切库/切版本:重置成「全部根展开」(默认铺开第一层),再定位当前类 */
watch(treeIndex, (idx) => {
  expanded.value = new Set(idx.roots)
  revealCurrent()
}, { immediate: true })

watch(() => props.currentClass, revealCurrent)

function toggle(row: DocTreeRow) {
  if (!row.childCount) return
  const next = new Set(expanded.value)
  if (next.has(row.name)) next.delete(row.name)
  else next.add(row.name)
  expanded.value = next
}

function collapseAll() {
  expanded.value = new Set()
}

/** 行的缩进(每层 12px) */
function indent(depth: number): string {
  return `${depth * 12}px`
}

defineExpose({ revealCurrent })
</script>

<template>
  <div ref="rootEl" class="tree">
    <div class="tree-tools">
      <button class="tool" title="折叠所有分支,只留根类" @click="collapseAll">
        <Icon name="chevron-up" :size="11" /> 折叠全部
      </button>
      <button class="tool" title="展开当前类所在路径并滚动定位" @click="revealCurrent">
        <Icon name="search" :size="11" /> 定位当前类
      </button>
    </div>

    <div
      v-for="row in rows"
      :key="row.name"
      class="row"
      :class="{ current: row.isCurrent, path: row.onPath && !row.isCurrent }"
      :style="{ paddingLeft: indent(row.depth) }"
    >
      <button
        v-if="row.childCount"
        class="arrow"
        :title="row.expanded ? '折叠' : `展开 ${row.childCount} 个派生`"
        @click="toggle(row)"
      >
        <Icon :name="row.expanded ? 'chevron-down' : 'chevron-right'" :size="10" />
      </button>
      <span v-else class="arrow-space"></span>
      <button class="name mono" :title="row.name" @click="emit('navigate', row.name)">{{ row.name }}</button>
      <span v-if="row.childCount" class="count">{{ row.childCount }}</span>
    </div>

    <div v-if="!rows.length" class="tree-empty">当前文档库没有类</div>
  </div>
</template>

<style scoped>
.tree {
  padding: 2px 0 10px;
}

.tree-tools {
  display: flex;
  gap: 5px;
  padding: 0 0 8px;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 6px;
}

.tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}

.tool:hover {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 35%, transparent);
}

.row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}

.arrow:hover {
  color: var(--brand);
}

.arrow-space {
  display: inline-block;
  width: 15px;
  flex-shrink: 0;
}

.name {
  border: none;
  background: none;
  padding: 1px 4px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  min-width: 0;
}

.name:hover {
  color: var(--brand);
  background: var(--surface-2);
}

/* 路径上的祖先:淡品牌色,给出「我在哪条链上」 */
.row.path .name {
  color: var(--brand);
  opacity: 0.85;
}

/* 当前类:高亮底 + 加粗,一眼可辨 */
.row.current {
  background: var(--brand-weak);
  border-radius: 6px;
}

.row.current .name {
  color: var(--brand);
  font-weight: 700;
}

.count {
  font-size: 10px;
  color: var(--text-3);
  flex-shrink: 0;
}

.tree-empty {
  padding: 12px 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
