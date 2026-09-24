<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import { fmtSize } from '../utils/format'
import type { AddonInfo, GodotProject } from '../types/godot'

const props = defineProps<{ enterProjectId?: string | null }>()
const emit = defineEmits<{
  (e: 'navigate', tab: string): void
  (e: 'consumed'): void
}>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const targetId = ref('')
const addons = ref<AddonInfo[]>([])
const checking = ref(false)
const updating = ref<{ assetId: string, percent: number, stage: string } | null>(null)
const updateInfo = ref<Record<string, { hasUpdate: boolean, latest?: string }>>({})
const confirmingDir = ref<string | null>(null)

// ---------- 多选 / 批量 ----------

const checked = ref<string[]>([])
const confirmingBatch = ref(false)

// ---------- 复制到项目 ----------

const showCopy = ref(false)
const copyTargetId = ref('')
const copying = ref(false)

const target = computed(() => projects.value.find((p) => p._id === targetId.value))
const enabledCount = computed(() => addons.value.filter((a) => a.enabled).length)
const selAddons = computed(() => addons.value.filter((a) => checked.value.includes(a.dirName)))
const allChecked = computed(() => addons.value.length > 0 && checked.value.length === addons.value.length)
const hasEnabledSel = computed(() => selAddons.value.some((a) => a.enabled))
const hasDisabledSel = computed(() => selAddons.value.some((a) => !a.enabled))
/** 可作为复制目标的项目(排除当前项目) */
const copyTargets = computed(() => projects.value.filter((p) => p._id !== targetId.value))

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
    confirmingBatch.value = false
  }
}

function reload() {
  if (!targetId.value) {
    addons.value = []
    checked.value = []
    return
  }
  addons.value = window.services.listAddons(targetId.value)
  // 清掉已不存在的选择
  if (checked.value.length) {
    const live = new Set(addons.value.map((a) => a.dirName))
    checked.value = checked.value.filter((d) => live.has(d))
  }
}

function onTargetChange() {
  updateInfo.value = {}
  confirmingDir.value = null
  confirmingBatch.value = false
  checked.value = []
  reload()
}

function percent(p: { received?: number, total?: number }): number {
  if (!p.total) return 0
  return Math.min(100, ((p.received || 0) / p.total) * 100)
}

// ---------- 多选 ----------

function toggleCheck(dirName: string) {
  const i = checked.value.indexOf(dirName)
  if (i >= 0) checked.value.splice(i, 1)
  else checked.value.push(dirName)
  confirmingBatch.value = false
}

function toggleAll() {
  checked.value = allChecked.value ? [] : addons.value.map((a) => a.dirName)
  confirmingBatch.value = false
}

// ---------- 批量操作 ----------

function batchToggle(enabled: boolean) {
  const dirs = selAddons.value.filter((a) => a.hasCfg && a.enabled !== enabled).map((a) => a.dirName)
  if (!dirs.length) {
    notify(enabled ? '所选插件均已启用' : '所选插件均已禁用')
    return
  }
  let n = 0
  for (const d of dirs) {
    const r = window.services.setAddonEnabled({ projectId: targetId.value, dirName: d, enabled })
    if (r.ok) n++
  }
  reload()
  notify(`已${enabled ? '启用' : '禁用'} ${n} 个插件`)
}

function batchUninstall() {
  if (confirmingBatch.value) {
    confirmingBatch.value = false
    const dirs = [...checked.value]
    let n = 0
    const failed: string[] = []
    for (const d of dirs) {
      const r = window.services.uninstallAddon({ projectId: targetId.value, dirName: d })
      if (r.ok) n++
      else failed.push(d)
    }
    checked.value = []
    reload()
    notify(failed.length ? `已卸载 ${n} 个,失败 ${failed.length} 个(${failed.join('、')})` : `已卸载 ${n} 个插件`)
  } else {
    confirmingBatch.value = true
    setTimeout(() => (confirmingBatch.value = false), 2500)
  }
}

// ---------- 复制到其他项目 ----------

function openCopy() {
  if (!checked.value.length) return
  copyTargetId.value = copyTargets.value[0]?._id || ''
  showCopy.value = true
}

function confirmCopy() {
  if (!copyTargetId.value || copying.value) return
  copying.value = true
  const r = window.services.copyAddonsToProject({
    sourceProjectId: targetId.value,
    dirNames: [...checked.value],
    targetProjectId: copyTargetId.value
  })
  copying.value = false
  if (!r.ok) {
    notify(r.error || '复制失败')
    return
  }
  showCopy.value = false
  const skipped = r.skipped?.length ? `,跳过:${r.skipped.join('、')}` : ''
  notify(`已复制 ${r.copied} 个插件到「${r.targetName}」${skipped}`)
}

// ---------- 检查更新 / 更新 ----------

async function checkUpdates() {
  if (!targetId.value || checking.value) return
  checking.value = true
  const jobs = addons.value.filter((a) => a.fromMarket && a.assetId)
  const next: Record<string, { hasUpdate: boolean, latest?: string }> = {}
  await Promise.all(
    jobs.map(async (a) => {
      const r = await window.services.checkAddonUpdate({ projectId: targetId.value, assetId: a.assetId! })
      if (r.hasUpdate) next[a.dirName] = { hasUpdate: true, latest: r.latest }
    })
  )
  updateInfo.value = next
  checking.value = false
  const count = Object.keys(next).length
  notify(count ? `${count} 个插件有新版本` : '所有插件均为最新版本')
}

async function update(a: AddonInfo) {
  if (!targetId.value || !a.assetId || updating.value) return
  updating.value = { assetId: a.assetId, percent: 0, stage: '下载中' }
  const r = await window.services.updateAsset(
    { projectId: targetId.value, assetId: a.assetId },
    (p) => {
      if (p.stage === 'downloading') {
        updating.value = { assetId: a.assetId!, percent: percent(p), stage: `下载中 ${fmtSize(p.received)}` }
      } else {
        updating.value = { assetId: a.assetId!, percent: 100, stage: '解压中' }
      }
    }
  )
  updating.value = null
  if (r.ok) {
    notify(`${a.name} 已更新到 ${r.addon?.versionString}`)
    reload()
    checkUpdates()
  } else {
    notify(r.error || '更新失败')
  }
}

// ---------- 启用 / 卸载 ----------

function toggleEnabled(a: AddonInfo) {
  const r = window.services.setAddonEnabled({ projectId: targetId.value, dirName: a.dirName, enabled: !a.enabled })
  if (r.ok) reload()
  else notify(r.error || '操作失败')
}

function uninstall(a: AddonInfo) {
  if (confirmingDir.value === a.dirName) {
    confirmingDir.value = null
    const r = window.services.uninstallAddon({ projectId: targetId.value, dirName: a.dirName })
    if (r.ok) reload()
    else notify(r.error || '卸载失败')
  } else {
    confirmingDir.value = a.dirName
    setTimeout(() => {
      if (confirmingDir.value === a.dirName) confirmingDir.value = null
    }, 2500)
  }
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
        <h2><Icon name="check" :size="16" /> 已安装插件 <span class="count-pill">{{ addons.length }}</span></h2>
        <span v-if="addons.length" class="head-stat">已启用 {{ enabledCount }} · 未启用 {{ addons.length - enabledCount }}</span>
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
          <div v-for="a in addons" :key="a.dirName" class="card addon" :class="{ picked: checked.includes(a.dirName) }">
            <input
              type="checkbox"
              class="chk ad-chk"
              :checked="checked.includes(a.dirName)"
              :title="checked.includes(a.dirName) ? '取消选择' : '选择'"
              @change="toggleCheck(a.dirName)"
            />
            <div class="ad-ico" :class="{ off: !a.enabled }"><Icon name="puzzle" :size="17" /></div>
            <div class="addon-main">
              <div class="addon-name">
                <span class="name">{{ a.name }}</span>
                <span v-if="a.version" class="tag">v{{ a.version }}</span>
                <span class="state" :class="a.enabled ? 'ok' : 'idle'">
                  <span class="dot"></span>{{ a.enabled ? '已启用' : '未启用' }}
                </span>
                <span v-if="a.fromMarket" class="tag brand">市场</span>
                <span v-else class="tag" title="手动放置或未通过市场安装">未知来源</span>
                <span v-if="updateInfo[a.dirName]" class="tag warn">可更新到 v{{ updateInfo[a.dirName].latest }}</span>
              </div>
              <div class="addon-meta mono" :title="`addons/${a.dirName}`">addons/{{ a.dirName }}</div>
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
