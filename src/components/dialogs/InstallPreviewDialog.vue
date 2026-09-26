<script setup lang="ts">
// 安装确认对话框:展示 previewAssetInstall 归纳的安装计划,按类型分流渲染。
//   · 插件:目的地 addons/,一句话说明即可;
//   · 素材:写入位置/顶层条目/文件数/冲突,唯一顶层目录让用户决定「保留」或「并入项目根」;
//   · 完整项目:说明不可装入现有项目,主按钮禁用。
// 冲突随「保留/并入」选择实时切换;主按钮在冲突未清空时禁用。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { fmtSize } from '../../utils/format'
import type { InstallPlan } from '../../types/godot'

const props = withDefaults(defineProps<{
  open: boolean
  /** 资产名 */
  title: string
  /** 安装的 release 版本(可为空) */
  version?: string
  /** 目标项目名 */
  projectName: string
  plan: InstallPlan | null
  /** 「并入项目根」的预填值(来自按 slug 的记忆) */
  defaultStrip?: boolean
}>(), {
  version: '',
  defaultStrip: false
})

const emit = defineEmits<{
  (e: 'confirm', stripTopDir: boolean): void
  (e: 'close'): void
  (e: 'saveAsProject'): void
}>()

const strip = ref(props.defaultStrip)

watch(
  () => props.open,
  (open) => {
    if (open) strip.value = props.defaultStrip
  }
)

/** 当前选择下的冲突 */
const activeConflicts = computed(() => {
  const c = props.plan?.conflicts
  if (!c) return null
  return (strip.value && c.stripped) ? c.stripped : c.asIs
})

/** 主按钮是否可用(仅安装语义;完整项目走另存,不受此限) */
const canConfirm = computed(() => {
  const p = props.plan
  if (!p || p.kind === 'project') return false
  if (!p.fileCount) return false
  return !(activeConflicts.value && activeConflicts.value.count > 0)
})

/** 确认:只有素材才存在剥离歧义,其他情况统一传 false(服务端会忽略) */
function confirm() {
  if (!canConfirm.value) return
  emit('confirm', props.plan?.singleTopDir ? strip.value : false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="download" :size="15" /> 安装确认 · {{ title }}</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <p class="ip-target">
          安装到项目 <b>{{ projectName }}</b>
          <span v-if="version" class="tag">v{{ version }}</span>
          <span v-if="plan && plan.fileCount" class="ip-meta mono">{{ plan.fileCount }} 个文件<template v-if="plan.zipSize"> · {{ fmtSize(plan.zipSize) }}</template></span>
        </p>

        <!-- 完整项目/模板:不可装入现有项目,引导另存为新项目 -->
        <template v-if="plan && plan.kind === 'project'">
          <div class="card ip-warn">
            <Icon name="alert" :size="14" />
            <span>
              这是<b>完整项目或模板</b>(包内自带 project.godot),不能安装到现有项目目录,
              可以另存为独立项目后再打开。
            </span>
          </div>
        </template>

        <!-- 插件:addons/,一句话说明 -->
        <template v-else-if="plan && plan.kind === 'addon'">
          <div class="ip-dest">
            <Icon name="puzzle" :size="14" />
            <span>插件将安装到项目的 <code class="mono">addons/</code> 目录,并按设置自动启用。</span>
          </div>
        </template>

        <!-- 素材:项目根 + 顶层条目 + wrapper 选择 + 冲突 -->
        <template v-else-if="plan">
          <div class="ip-dest">
            <Icon name="folder" :size="14" />
            <span>素材将按包内原始结构写入项目根 <code class="mono">res://</code></span>
          </div>

          <label v-if="plan.singleTopDir" class="ip-strip">
            <input v-model="strip" type="checkbox" />
            <span>
              去掉顶层目录 <code class="mono">{{ plan.singleTopDir }}/</code>,内容直接并入项目根
              <span class="ip-strip-hint">保留更整洁、不易与其他资源冲突;并入则按包内预期路径铺开(选择会被记住)</span>
            </span>
          </label>

          <div class="ip-list">
            <div v-for="t in plan.topEntries" :key="t.name" class="ip-row">
              <Icon :name="t.isDir ? 'folder' : 'box'" :size="13" />
              <span class="ip-name mono">{{ t.name }}{{ t.isDir ? '/' : '' }}</span>
              <span class="ip-count">{{ t.files }} 个文件</span>
            </div>
          </div>

          <div v-if="activeConflicts && activeConflicts.count > 0" class="card ip-warn">
            <Icon name="alert" :size="14" />
            <span>
              与项目现有文件冲突 {{ activeConflicts.count }} 处:{{ activeConflicts.samples.join('、') }}
              。请先卸载旧内容或清理冲突文件后再安装。
            </span>
          </div>
        </template>

        <div class="ip-foot">
          <span class="grow"></span>
          <button class="btn ghost" @click="emit('close')">取消</button>
          <button
            v-if="plan && plan.kind === 'project'"
            class="btn primary"
            title="解压到选定的位置并登记为新项目"
            @click="emit('saveAsProject')"
          ><Icon name="folder-plus" :size="12" /> 另存为新项目</button>
          <button v-else class="btn primary" :disabled="!canConfirm" @click="confirm">
            <Icon name="download" :size="12" /> 确认安装
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.grow {
  flex: 1;
}

.ip-target {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-2);
}

.ip-target b {
  color: var(--text);
}

.ip-meta {
  font-size: 11px;
  color: var(--text-3);
}

.ip-dest {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 12.5px;
  color: var(--text-2);
}

.ip-dest .icon {
  color: var(--brand);
  flex-shrink: 0;
}

.ip-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 9px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.ip-strip:hover {
  border-color: var(--border-strong);
}

.ip-strip input {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  accent-color: var(--brand);
  flex-shrink: 0;
  cursor: pointer;
}

.ip-strip span {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
}

.ip-strip-hint {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}

.ip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  margin-top: 9px;
}

.ip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.ip-row .icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.ip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ip-count {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.ip-warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 9px;
  padding: 9px 11px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-weak);
}

.ip-warn .icon {
  flex-shrink: 0;
  margin-top: 1px;
}

.ip-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
