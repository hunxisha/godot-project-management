<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import type { AddonInfo, GodotProject } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const targetId = ref('')
const addons = ref<AddonInfo[]>([])
const checking = ref(false)
const updating = ref<{ assetId: string, percent: number, stage: string } | null>(null)
const updateInfo = ref<Record<string, { hasUpdate: boolean, latest?: string }>>({})
const confirmingDir = ref<string | null>(null)

const target = computed(() => projects.value.find((p) => p._id === targetId.value))
const enabledCount = computed(() => addons.value.filter((a) => a.enabled).length)

onMounted(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  projects.value.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  if (projects.value.length) {
    targetId.value = projects.value[0]._id
    reload()
  }
})

function reload() {
  if (!targetId.value) {
    addons.value = []
    return
  }
  addons.value = window.services.listAddons(targetId.value)
}

function onTargetChange() {
  updateInfo.value = {}
  confirmingDir.value = null
  reload()
}

function fmtSize(n?: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function percent(p: { received?: number, total?: number }): number {
  if (!p.total) return 0
  return Math.min(100, ((p.received || 0) / p.total) * 100)
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

      <div v-else class="addon-list">
        <div v-for="a in addons" :key="a.dirName" class="card addon">
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

/* ---------- 插件卡列表 ---------- */
.addon-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.addon {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.addon:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
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
</style>
