<!-- 继承树节点(递归):懒加载展开直接派生,点击类名跳转,当前类路径高亮。 -->
<script setup lang="ts">
import Icon from '../Icon.vue'
import { useDocs } from '../../composables/useDocs'
import type { DocTreeNode } from '../../composables/useDocs'

const props = defineProps<{
  node: DocTreeNode
  /** 当前类及其祖先链(高亮用) */
  path: Set<string>
  /** 单节点最多展开的直接派生数 */
  cap: number
}>()
const emit = defineEmits<{ (e: 'navigate', name: string): void }>()

const { derivedOf, treeNode } = useDocs()

function toggle() {
  const n = props.node
  if (!n.childCount) return
  if (!n.expanded) {
    n.children = derivedOf(n.name)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, props.cap)
      .map((c) => treeNode(c.name))
    n.expanded = true
  } else {
    n.expanded = false
  }
}
</script>

<template>
  <div class="tnode">
    <div class="trow" :class="{ current: path.has(node.name), top: node.name === path.values().next().value }">
      <button v-if="node.childCount" class="tarrow" :title="node.expanded ? '折叠' : '展开'" @click="toggle">
        <Icon :name="node.expanded ? 'chevron-down' : 'chevron-right'" :size="11" />
      </button>
      <span v-else class="tarrow-space"></span>
      <button class="tname mono" :title="node.name" @click="emit('navigate', node.name)">{{ node.name }}</button>
      <span v-if="node.childCount" class="tcount">{{ node.childCount }}</span>
    </div>
    <div v-if="node.expanded" class="tkids">
      <DocTreeNode
        v-for="c in node.children"
        :key="c.name"
        :node="c"
        :path="path"
        :cap="cap"
        @navigate="(n: string) => emit('navigate', n)"
      />
      <div v-if="node.childCount > node.children.length" class="tmore">
        还有 {{ node.childCount - node.children.length }} 个派生未列出
      </div>
    </div>
  </div>
</template>

<style scoped>
.trow {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

.tarrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}

.tarrow:hover {
  color: var(--brand);
}

.tarrow-space {
  display: inline-block;
  width: 16px;
  flex-shrink: 0;
}

.tname {
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
}

.tname:hover {
  color: var(--brand);
  background: var(--surface-2);
}

.trow.current .tname {
  color: var(--brand);
  font-weight: 600;
}

.tcount {
  font-size: 10px;
  color: var(--text-3);
  flex-shrink: 0;
}

.tkids {
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px dashed var(--border);
}

.tmore {
  padding: 2px 4px;
  font-size: 11px;
  color: var(--text-3);
}
</style>
