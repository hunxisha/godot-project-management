<script setup lang="ts">
// 文件挑选(工具箱页面的一块)。候选来自 `services.scanProjectTree`,后缀过滤由页面按 schema 的
// files 字段把 exts 传下去(见 useToolPage.loadTree)—— 这里不自己解释路径,也不自己去扫。
//
// 判据:`truncated` 为真时必须把「清单不全」显示出来。挑文件是**用户**在决定动哪些文件,
// 清单不全意味着他看到的不是全部;旧体检也有一条同方向的判据(报告可以截断,结论不可以)。
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps<{
  candidates: { rel: string, size: number }[]
  model: string[]
  truncated?: boolean
}>()

const emit = defineEmits<{ (e: 'update:model', v: string[]): void }>()

const q = ref('')

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const list = props.candidates || []
  return kw ? list.filter((f) => String(f.rel).toLowerCase().includes(kw)) : list
})

const pickedSet = computed(() => new Set(props.model || []))
const allChecked = computed(() => shown.value.length > 0 && shown.value.every((f) => pickedSet.value.has(f.rel)))

function toggle(rel: string) {
  const next = new Set(pickedSet.value)
  if (next.has(rel)) next.delete(rel)
  else next.add(rel)
  emit('update:model', [...next])
}

function toggleAll() {
  if (allChecked.value) emit('update:model', [])
  else emit('update:model', shown.value.map((f) => f.rel))
}

function kb(n: number): string {
  const v = Number(n) || 0
  return v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`
}
</script>

<template>
  <div class="picker">
    <div class="bar">
      <input v-model="q" class="input grow" placeholder="在候选里过滤(按路径子串)" />
      <button class="btn small" type="button" @click="toggleAll">
        <Icon name="check" :size="13" /> {{ allChecked ? '全部取消' : '全选可见' }}
      </button>
      <span class="count">已选 {{ (props.model || []).length }} / {{ (props.candidates || []).length }}</span>
    </div>

    <p v-if="props.truncated" class="warn-line">
      <Icon name="alert" :size="13" /> 文件清单被截断了,下面这些不是项目里的全部文件。
    </p>
    <p v-else-if="!shown.length" class="dim">没有可选的文件(项目没选、后缀不匹配,或项目里没有对应文件)。</p>

    <div class="list">
      <label v-for="f in shown" :key="f.rel" class="item">
        <input type="checkbox" class="chk" :checked="pickedSet.has(f.rel)" @change="toggle(f.rel)" />
        <span class="rel">{{ f.rel }}</span>
        <span class="size">{{ kb(f.size) }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.count {
  color: var(--text-2);
  font-size: 11.5px;
  white-space: nowrap;
}

.warn-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 7px 0 0;
  color: var(--warn);
  font-size: 12px;
}

.dim {
  margin: 7px 0 0;
  color: var(--text-3);
  font-size: 12px;
}

.list {
  max-height: 220px;
  margin-top: 6px;
  overflow-y: auto;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius-sm);
}

.item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
}

.item:nth-child(odd) {
  background: var(--surface-2);
}

.rel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  color: var(--text);
}

.size {
  color: var(--text-3);
  font-size: 11px;
}
</style>
