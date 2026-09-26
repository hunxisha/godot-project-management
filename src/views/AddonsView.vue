<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { notify, openExternal } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import VersionPickerDialog from '../components/dialogs/VersionPickerDialog.vue'
import { useAddonSelection } from '../composables/useAddonSelection'
import { useAddonActions } from '../composables/useAddonActions'
import type { ProjectRow } from '../composables/useProjectList'
import type { AddonInfo, GodotProject } from '../types/godot'

const props = defineProps<{ enterProjectId?: string | null }>()
const emit = defineEmits<{
  (e: 'navigate', tab: string): void
  (e: 'consumed'): void
}>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const targetId = ref('')
const addons = ref<AddonInfo[]>([])

// 多选与各类操作分别在两个组合式函数里;本视图只做装配与页面级联动。
const selection = useAddonSelection(addons)
const {
  checked,
  confirmingBatch,
  selAddons,
  allChecked,
  hasEnabledSel,
  hasDisabledSel,
  toggleCheck,
  toggleAll,
  clear: clearSelection,
  prune,
  disarmBatchConfirm
} = selection

const {
  updating,
  checking,
  updateInfo,
  versionTarget,
  confirmingDir,
  showCopy,
  copyTargetId,
  copying,
  copyTargets,
  openCopy,
  confirmCopy,
  batchToggle,
  batchUninstall,
  toggleEnabled,
  uninstall,
  checkUpdates,
  update,
  openVersions,
  installVersion
} = useAddonActions({
  targetId,
  projects,
  addons,
  selection,
  reload,
  notify
})

const target = computed(() => projects.value.find((p) => p._id === targetId.value))
// 素材没有启用概念,统计口径只算插件
const addonCount = computed(() => addons.value.filter((a) => a.kind !== 'asset').length)
const enabledCount = computed(() => addons.value.filter((a) => a.kind !== 'asset' && a.enabled).length)

/** 素材条目安装到项目根的顶层条目(展示用) */
function assetTops(a: AddonInfo): string[] {
  return [...new Set((a.assetPaths || []).map((p) => p.split('/')[0]))]
}

/** 素材完整安装清单(悬浮提示用) */
function assetPathsTitle(a: AddonInfo): string {
  return (a.assetPaths || []).slice(0, 8).join('\n')
}

onMounted(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  projects.value.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  // 项目页「管理插件」联动:进入本页时定位到该项目
  if (props.enterProjectId) {
    if (projects.value.some((p) => p._id === props.enterProjectId)) {
      targetId.value = props.enterProjectId
    }
    emit('consumed')
  }
  if (!targetId.value && projects.value.length) {
    targetId.value = projects.value[0]._id
  }
  if (targetId.value) reload()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showCopy.value) showCopy.value = false
    disarmBatchConfirm()
  }
}

function reload() {
  if (!targetId.value) {
    addons.value = []
    clearSelection()
    return
  }
  addons.value = window.services.listAddons(targetId.value)
  // 清掉已不存在的选择(卸载/换项目后不留幽灵选中项)
  prune()
}

function onTargetChange() {
  updateInfo.value = {}
  confirmingDir.value = null
  disarmBatchConfirm()
  clearSelection()
  reload()
}

// ---------- 商店链接 ----------

/** 在浏览器中打开该插件的资产库页面 */
function openStore(a: AddonInfo) {
  if (!a.storeUrl) return
  openExternal(a.storeUrl)
}
</script>

<template>
  <div class="addons view">
    <EmptyState
      v-if="!projects.length"
      icon="folder-plus"
      title="先添加一个 Godot 项目"
      desc="插件(Addon)安装在具体项目中,请先在「项目」页添加项目。"
    >
      <button class="btn primary" @click="emit('navigate', 'projects')"><Icon name="folder-plus" :size="14" /> 去添加项目</button>
    </EmptyState>

    <template v-else>
      <!-- 工具栏(吸顶):项目切换 + 检查更新 + 去市场 -->
      <div class="toolbar">
        <label class="tb-target" :title="target?.path ? `项目目录 ${target.path}` : '选择要管理的项目'">
          <Icon name="folder" :size="13" />
          <span class="tb-caption">管理项目</span>
          <select v-model="targetId" class="tb-select" @change="onTargetChange">
            <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
          </select>
        </label>
        <span class="grow"></span>
        <button
          v-if="addons.some((a) => a.fromMarket)"
          class="btn small"
          :disabled="checking || !!updating"
          @click="checkUpdates"
        >
          <span v-if="checking" class="spin"></span>
          <Icon v-else name="refresh" :size="12" />
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
        <button class="btn small primary" @click="emit('navigate', 'marketplace')">
          <Icon name="puzzle" :size="12" /> 去市场找插件
        </button>
      </div>

      <!-- 标题行 -->
      <div class="view-head">
        <h2><Icon name="check" :size="16" /> 已安装插件与素材 <span class="count-pill">{{ addons.length }}</span></h2>
        <span v-if="addons.length" class="head-stat">插件 {{ addonCount }} · 已启用 {{ enabledCount }} · 素材 {{ addons.length - addonCount }}</span>
      </div>

      <EmptyState
        v-if="!addons.length"
        icon="puzzle"
        title="该项目还没有插件"
        desc="从插件市场搜索并安装,安装后会自动写入项目 addons/ 目录。"
      >
        <button class="btn primary" @click="emit('navigate', 'marketplace')"><Icon name="puzzle" :size="14" /> 浏览插件市场</button>
      </EmptyState>

      <template v-else>
        <!-- 批量操作栏(有选中时出现) -->
        <div v-if="checked.length" class="batch-bar card">
          <span class="bb-count">已选 <b>{{ checked.length }}</b> / {{ addons.length }}</span>
          <button class="btn small ghost" @click="toggleAll">{{ allChecked ? '取消全选' : '全选' }}</button>
          <span class="grow"></span>
          <button class="btn small ghost" :disabled="!hasDisabledSel" title="启用所选插件" @click="batchToggle(true)">批量启用</button>
          <button class="btn small ghost" :disabled="!hasEnabledSel" title="禁用所选插件" @click="batchToggle(false)">批量禁用</button>
          <button class="btn small" title="复制所选插件到其他项目" @click="openCopy">
            <Icon name="copy" :size="12" /> 复制到项目
          </button>
          <button class="btn small danger-text" :class="{ confirming: confirmingBatch }" @click="batchUninstall">
            {{ confirmingBatch ? `确认卸载 ${checked.length} 个?` : '批量卸载' }}
          </button>
        </div>

        <div class="addon-list">
          <div v-for="a in addons" :key="a.assetId || a.dirName" class="card addon" :class="{ picked: checked.includes(a.dirName) }">
            <input
              type="checkbox"
              class="chk ad-chk"
              :checked="checked.includes(a.dirName)"
              :title="checked.includes(a.dirName) ? '取消选择' : '选择'"
              @change="toggleCheck(a.dirName)"
            />
            <div class="ad-ico" :class="{ off: a.kind !== 'asset' && !a.enabled }"><Icon name="puzzle" :size="17" /></div>
            <div class="addon-main">
              <div class="addon-name">
                <span
                  class="name"
                  :class="{ link: !!a.storeUrl }"
                  :title="a.storeUrl ? `${a.name} · 在资产库中查看` : a.name"
                  @click="openStore(a)"
                >{{ a.name }}</span>
                <Icon v-if="a.storeUrl" name="external" :size="10" class="name-ext" />
                <span v-if="a.version" class="tag">v{{ a.version }}</span>
                <span v-if="a.kind === 'asset'" class="tag brand" title="纯素材:安装到项目根,无启用概念">素材</span>
                <span v-else class="state" :class="a.enabled ? 'ok' : 'idle'">
                  <span class="dot"></span>{{ a.enabled ? '已启用' : '未启用' }}
                </span>
                <span v-if="a.fromMarket" class="tag brand">市场</span>
                <span v-else class="tag" title="手动放置或未通过市场安装">未知来源</span>
                <span v-if="updateInfo[a.dirName]" class="tag warn">可更新到 v{{ updateInfo[a.dirName].latest }}</span>
              </div>
              <div v-if="a.kind === 'asset'" class="addon-meta mono" :title="assetPathsTitle(a)">
                res://{{ assetTops(a).join('、') }} · {{ (a.assetPaths || []).length }} 个文件
              </div>
              <div v-else class="addon-meta mono" :title="`addons/${a.dirName}`">addons/{{ a.dirName }}</div>
              <!-- 更新进度 -->
              <div v-if="updating && a.assetId === updating.assetId" class="upd">
                <span class="spin"></span>
                <span class="upd-stage">{{ updating.stage }} {{ updating.percent.toFixed(0) }}%</span>
                <span class="bar"><span class="fill" :style="{ width: updating.percent + '%' }"></span></span>
              </div>
            </div>
            <div class="addon-actions">
              <button
                v-if="a.fromMarket && updateInfo[a.dirName]"
                class="btn small primary"
                :disabled="!!updating"
                @click="update(a)"
              ><Icon name="download" :size="12" /> 更新</button>
              <button
                v-if="a.assetId"
                class="btn small ghost"
                :disabled="!!updating"
                title="从历史版本中替换当前插件"
                @click="openVersions(a)"
              ><Icon name="package" :size="12" /> 版本</button>
              <button v-if="a.hasCfg" class="btn small ghost" @click="toggleEnabled(a)">
                {{ a.enabled ? '禁用' : '启用' }}
              </button>
              <button
                class="btn small danger-text"
                :class="{ confirming: confirmingDir === a.dirName }"
                @click="uninstall(a)"
              >
                {{ confirmingDir === a.dirName ? '确认卸载?' : '卸载' }}
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 复制插件到其他项目模态框 -->
      <Teleport to="body">
        <div v-if="showCopy" class="modal-mask" @click.self="showCopy = false">
          <div class="card modal">
            <div class="modal-head">
              <div class="modal-title"><Icon name="copy" :size="15" /> 复制插件到其他项目</div>
              <span class="grow"></span>
              <button class="btn small ghost icon-x" title="关闭" @click="showCopy = false">
                <Icon name="x" :size="14" />
              </button>
            </div>

            <p class="copy-tip">
              将 <b>{{ target?.name }}</b> 中已选的 {{ checked.length }} 个插件复制到:
            </p>

            <div v-if="copyTargets.length" class="copy-list">
              <label
                v-for="p in copyTargets"
                :key="p._id"
                class="copy-item"
                :class="{ on: copyTargetId === p._id }"
              >
                <input v-model="copyTargetId" type="radio" name="copy-target" :value="p._id" />
                <span class="ci-ico"><Icon name="folder" :size="15" /></span>
                <span class="ci-main">
                  <span class="ci-name">{{ p.name }}</span>
                  <span class="ci-path mono" :title="p.path">{{ p.path }}</span>
                </span>
                <Icon v-if="copyTargetId === p._id" name="check" :size="14" class="ci-check" />
              </label>
            </div>
            <EmptyState
              v-else
              icon="folder"
              title="没有其他项目"
              desc="先在「项目」页添加更多项目,再来复制插件。"
            />

            <div class="copy-hint">
              仅复制插件文件到目标项目的 addons/ 目录,不自动启用;目标项目已存在同名插件时将跳过。可重复复制到多个项目。
            </div>

            <div class="modal-foot">
              <span class="grow"></span>
              <button class="btn ghost" @click="showCopy = false">取消</button>
              <button class="btn primary" :disabled="!copyTargetId || copying" @click="confirmCopy">
                <span v-if="copying" class="spin"></span>
                {{ copying ? '复制中…' : '复制' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>
    </template>

    <VersionPickerDialog
      :open="!!versionTarget"
      :asset-id="versionTarget?.assetId || ''"
      :title="versionTarget?.name || ''"
      :current-version="versionTarget?.version"
      action="switch"
      @pick="installVersion"
      @close="versionTarget = null"
    />
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
}

/* ---------- 工具栏(吸顶) ---------- */
.toolbar {
  position: sticky;
  top: -16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 -18px;
  padding: 10px 18px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.tb-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  min-width: 0;
}

.tb-target .icon {
  color: var(--brand);
  flex-shrink: 0;
}

.tb-select {
  max-width: 170px;
  padding: 3px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
  box-shadow: none;
}

/* ---------- 标题行 ---------- */
.head-stat {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

/* ---------- 批量操作栏 ---------- */
.batch-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 8px 14px;
  margin-bottom: 8px;
  border-color: var(--brand);
  background: var(--brand-weak);
  animation: pop-in 0.16s ease;
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.bb-count {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.bb-count b {
  color: var(--brand);
  font-size: 13.5px;
}

/* ---------- 插件卡列表 ---------- */
.addon-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.addon {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.addon:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.addon.picked {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.ad-chk {
  width: 15px;
  height: 15px;
  accent-color: var(--brand);
  cursor: pointer;
  flex-shrink: 0;
}

.ad-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  flex-shrink: 0;
}

.ad-ico.off {
  background: var(--surface-3);
  color: var(--text-3);
}

.addon-main {
  flex: 1;
  min-width: 0;
}

.addon-name {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.name {
  font-weight: 600;
  font-size: 13.5px;
}

/* 有商店来源时插件名可点击跳转资产库 */
.name.link {
  cursor: pointer;
  transition: color 0.15s;
}

.name.link:hover {
  color: var(--brand);
  text-decoration: underline;
}

.name-ext {
  color: var(--text-3);
  flex-shrink: 0;
  margin-left: -3px;
}

/* 启用状态:彩色圆点 + 文字 */
.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 500;
}

.state .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.state.ok {
  color: var(--ok);
}

.state.idle {
  color: var(--text-3);
}

.addon-meta {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
}

/* 更新进度行 */
.upd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}

.upd .spin {
  flex-shrink: 0;
}

.upd-stage {
  font-size: 11.5px;
  color: var(--brand);
  white-space: nowrap;
}

.upd .bar {
  flex: 1;
  max-width: 260px;
}

.addon-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

/* 卸载二次确认态 */
.btn.danger-text.confirming {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

/* ---------- 复制到项目模态框 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(18, 26, 40, 0.45);
}

.modal {
  width: min(480px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  padding: 18px 20px;
  box-shadow: var(--shadow-lift);
  animation: pop-in 0.16s ease;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
}

.icon-x {
  width: 26px;
  padding: 3px 0;
  color: var(--text-3);
}

.copy-tip {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-2);
}

.copy-tip b {
  color: var(--text);
}

.copy-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
  margin-bottom: 10px;
}

.copy-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.copy-item:hover {
  border-color: var(--border-strong);
}

.copy-item.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.copy-item input[type='radio'] {
  width: 14px;
  height: 14px;
  accent-color: var(--brand);
  flex-shrink: 0;
}

.ci-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--brand);
  flex-shrink: 0;
}

.copy-item.on .ci-ico {
  background: var(--surface);
}

.ci-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ci-name {
  font-size: 13px;
  font-weight: 600;
}

.ci-path {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ci-check {
  color: var(--brand);
  flex-shrink: 0;
}

.copy-hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.modal-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
