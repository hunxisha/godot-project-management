<!-- 继承树面板:以当前类为中心的扁平树(侧栏与弹层共用)。
     默认只展开「根 → 当前类」路径,隐藏的兄弟以「还有 N 个」入口点开;支持展开/折叠全部。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useDocs } from '../../composables/useDocs'
import { buildTreeRows, childrenMapFrom, type DocTreeRow } from '../../utils/docTree'

const props = defineProps<{
  /** 当前打开的类 */
  currentClass: string
  /** 弹层模式:空间充裕,显示工具行(展开/折叠全部) */
  roomy?: boolean
}>()
const emit = defineEmits<{ (e: 'navigate', name: string): void }>()

const { classes } = useDocs()

/** 用户显式展开的节点(未命中时按路径聚焦规则渲染) */
const expanded = ref<Set<string>>(new Set())

/** 类名 → 父类 / 直接派生(按当前库的继承关系建表,库不变即复用) */
const treeIndex = computed(() => {
  const parents = new Map<string, string | null>()
  for (const c of classes.value) parents.set(c.name, c.inherits && c.inherits.length ? c.inherits : null)
  const childrenMap = childrenMapFrom(parents)
  return {
    parentOf: (name: string) => parents.get(name) ?? null,
    childrenOf: (name: string) => childrenMap.get(name) ?? []
  }
})

const rows = computed<DocTreeRow[]>(() =>
  buildTreeRows({
    childrenOf: treeIndex.value.childrenOf,
    parentOf: treeIndex.value.parentOf,
    currentClass: props.currentClass,
    expanded: expanded.value
  })
)

/** 切类/切库时清空手动展开状态(重新按新路径聚焦) */
watch(() => [props.currentClass, classes.value.length], () => {
  expanded.value = new Set()
})

function toggle(row: DocTreeRow) {
  if (!row.childCount) return
  const next = new Set(expanded.value)
  if (next.has(row.name)) next.delete(row.name)
  else next.add(row.name)
  expanded.value = next
}

/** 展开「还有 N 个」:把该节点的兄弟全部铺开(等价于用户展开父节点) */
function showAllSiblings(row: DocTreeRow) {
  const next = new Set(expanded.value)
  next.add(row.name)
  expanded.value = next
}

/** 工具行:展开全部祖先与当前类(但不铺开无关分支) */
function expandNeighbors() {
  const next = new Set(expanded.value)
  for (const r of rows.value) {
    if (r.isCurrent || r.onPath) next.add(r.name)
  }
  expanded.value = next
}

function collapseAll() {
  expanded.value = new Set()
}

/** 行的缩进(每层 12px) */
function indent(depth: number): string {
  return `${depth * 12}px`
}
</script>

<template>
  <div class="tree">
    <div v-if="roomy" class="tree-tools">
      <button class="tool" title="展开路径上的全部层级" @click="expandNeighbors">
        <Icon name="layers" :size="11" /> 展开相邻
      </button>
      <button class="tool" title="回到只显示当前类路径" @click="collapseAll">
        <Icon name="refresh" :size="11" /> 重置
      </button>
    </div>

    <div v-for="(row, i) in rows" :key="`${row.name}-${i}`" class="row-wrap">
      <div class="row" :class="{ current: row.isCurrent, path: row.onPath && !row.isCurrent }" :style="{ paddingLeft: indent(row.depth) }">
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
      <!-- 折叠路径时隐藏的兄弟:点一下在此铺开 -->
      <button
        v-if="row.hiddenSiblings > 0"
        class="more"
        :style="{ paddingLeft: indent(row.depth + 1) }"
        :title="`显示 ${row.name} 的全部 ${row.childCount} 个派生`"
        @click="showAllSiblings(row)"
      >
        <Icon name="chevron-down" :size="10" /> 还有 {{ row.hiddenSiblings }} 个派生
      </button>
    </div>

    <div v-if="!rows.length" class="tree-empty">当前库没有该类的继承信息</div>
  </div>
</template>

<style scoped>
.tree {
  padding: 2px 0 10px;
}

.tree-tools {
  display: flex;
  gap: 5px;
  padding: 2px 0 8px;
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

.more {
  display: flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  padding: 1px 4px;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 5px;
}

.more:hover {
  color: var(--brand);
}

.tree-empty {
  padding: 12px 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
