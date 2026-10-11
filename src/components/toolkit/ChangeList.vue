<script setup lang="ts">
// 预览勾选列表(§5.4)。分组、分组标题、越界那组的措辞都来自 `orchestrate.groupPreview`,
// 这里一个字都不另写(DEV-7:框架不复述插件的话,渲染层也不替框架另写判断)。
//
// 判据:清单**全量渲染**,不做「只显示前 N 条」—— 勾选模型要求用户看得见每一条(旧体检的
// 「只裁展示」上限在这里被刻意放弃:裁了就没法勾没显示的那条)。
import Icon from '../Icon.vue'
import type { PlannedChange } from '../../toolkit/change'

interface Group { key: string, title: string, changes: PlannedChange[] }

const props = defineProps<{
  groups: Group[]
  checked: string[]
  expandedId?: string
  canDiff?: (c: PlannedChange) => boolean
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string): void
  (e: 'diff', c: PlannedChange): void
}>()

const set = () => new Set(props.checked || [])
</script>

<template>
  <div class="changes">
    <section v-for="g in props.groups || []" :key="g.key" class="grp" :class="g.key">
      <h4 class="grp-title">
        <Icon :name="g.key === 'out' ? 'alert' : 'list'" :size="13" /> {{ g.title }}
      </h4>
      <div v-for="c in g.changes" :key="c.id" class="row" :class="{ on: set().has(c.id), high: c.risk === 'high' }">
        <input type="checkbox" class="chk" :checked="set().has(c.id)" @change="emit('toggle', c.id)" />
        <span class="rel" :title="c.rel">{{ c.rel }}</span>
        <span v-if="c.risk === 'high'" class="tag danger">{{ c.outOfScope ? '越界 · 高危' : '高危' }}</span>
        <span v-if="c.creates" class="tag warn">新建</span>
        <span class="label">{{ c.label }}</span>
        <button v-if="props.canDiff && props.canDiff(c)" class="btn ghost small" type="button" @click="emit('diff', c)">
          {{ props.expandedId === c.id ? '收起差异' : '看差异' }}
        </button>
        <p v-if="c.risk === 'high'" class="reason">{{ c.reason }}</p>
      </div>
    </section>
    <p v-if="!(props.groups || []).length" class="none">没有可执行的改动 —— 上面「为什么」那句会说明是没勾文件、参数不对,还是插件真的算不出东西。</p>
  </div>
</template>

<style scoped>
.grp {
  margin-top: 8px;
}

.grp:first-child {
  margin-top: 0;
}

.grp.out {
  padding: 6px 8px;
  border-left: 3px solid var(--danger);
  background: var(--danger-weak);
  border-radius: var(--radius-sm);
}

.grp-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 700;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.row.on {
  background: var(--brand-weak);
}

.rel {
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  color: var(--text);
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.reason {
  flex-basis: 100%;
  margin: 0 0 0 22px;
  color: var(--text-3);
  font-size: 11.5px;
}

.none {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}
</style>
