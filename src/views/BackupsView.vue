<script setup lang="ts">
// 备份管理页:所有项目的备份集中管理 —— 统计、筛选、分组/时间轴、批量操作、恢复入口。
// 创建备份仍由项目页负责(阶段 3 会在此页加入新建入口)。
import { computed, nextTick, onActivated, onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import BackupListItem from '../components/BackupListItem.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import BackupCreateDialog from '../components/dialogs/BackupCreateDialog.vue'
import PruneDialog from '../components/dialogs/PruneDialog.vue'
import RestoreDialog from '../components/dialogs/RestoreDialog.vue'
import { useBackups } from '../composables/useBackups'
import { notify } from '../services/bridge'
import { fmtSize, formatTime } from '../utils/format'
import type { BackupRecord } from '../types/godot'

const props = defineProps<{ enterProjectId?: string | null }>()
const emit = defineEmits<{
  (e: 'consumed'): void
  (e: 'navigate', tab: string): void
  (e: 'backup-project', id: string): void
}>()

const bk = useBackups()
const {
  records, stats, projects, projectById, keyword, status, sort, viewMode, scopedProjectId, scopedProject,
  filtered, groups, timeline, uncovered, statusCounts,
  batchMode, selected, selectedSet, selectedRecords, selectedSize, allSelected,
  isCollapsed, refresh, toggleSelect, toggleSelectAll, enterBatch, exitBatch, toggleGroup,
  setLabel, verify, verifyMany, removeOne, removeMany, reveal,
  patrolling, patrolDone, patrolTotal, patrol, backupMany
} = bk

const busyId = ref('')

// ---------- 生命周期 ----------

onMounted(() => {
  if (props.enterProjectId) scopedProjectId.value = props.enterProjectId
  refresh()
  if (props.enterProjectId) emit('consumed')
  // 后台巡检:补全校验结论并确认缺失标记(不阻塞页面)
  patrol()
})

// 备份页不进 KeepAlive,但仍保留 onActivated 以便将来加入缓存
onActivated(refresh)

// ---------- 备注编辑 ----------

const renameTarget = ref<BackupRecord | null>(null)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement>()

function openRename(record: BackupRecord) {
  renameTarget.value = record
  renameValue.value = record.label || ''
  nextTick(() => renameInput.value?.focus())
}

function saveRename() {
  const t = renameTarget.value
  if (!t) return
  if (setLabel(t._id, renameValue.value)) renameTarget.value = null
}

// ---------- 校验 ----------

function doVerify(record: BackupRecord) {
  busyId.value = record._id
  try {
    verify(record._id)
  } finally {
    busyId.value = ''
  }
}

function doVerifySelected() {
  const ids = selectedRecords.value.map((r) => r._id)
  if (!ids.length) return
  verifyMany(ids)
}

// ---------- 删除确认 ----------

const removeOpen = ref(false)
const removeTargets = ref<BackupRecord[]>([])
const removeBusy = ref(false)

const allMissing = computed(() => removeTargets.value.length > 0 && removeTargets.value.every((r) => r.missing))

const removeMessage = computed(() => {
  const n = removeTargets.value.length
  const size = removeTargets.value.reduce((s, r) => s + (r.size || 0), 0)
  if (allMissing.value) {
    return n === 1
      ? '这份备份的文件已不存在,此操作只移除数据库里的记录。'
      : `这 ${n} 份备份的文件均已不存在,此操作只移除数据库里的记录。`
  }
  return n === 1
    ? `将删除这份备份(${fmtSize(size)})。Windows 下文件移入回收站可恢复,其他平台为永久删除。`
    : `将删除 ${n} 份备份,合计 ${fmtSize(size)}。Windows 下文件移入回收站可恢复,其他平台为永久删除。`
})

function askRemove(record: BackupRecord) {
  removeTargets.value = [record]
  removeOpen.value = true
}

function askRemoveSelected() {
  if (!selectedRecords.value.length) return
  removeTargets.value = [...selectedRecords.value]
  removeOpen.value = true
}

function doRemove() {
  const targets = removeTargets.value
  removeBusy.value = true
  try {
    if (targets.length === 1) removeOne(targets[0]._id)
    else removeMany(targets.map((r) => r._id))
    removeOpen.value = false
    removeTargets.value = []
    if (batchMode.value) exitBatch()
  } finally {
    removeBusy.value = false
  }
}

// ---------- 恢复 ----------

const restoreOpen = ref(false)
const restoreTarget = ref<BackupRecord | null>(null)

function askRestore(record: BackupRecord) {
  restoreTarget.value = record
  restoreOpen.value = true
}

const restoreProject = computed(() =>
  restoreTarget.value ? projectById.value[restoreTarget.value.projectId] || null : null
)
const restoreOrphan = computed(() => !!restoreTarget.value && !restoreProject.value)

// ---------- 新建备份 ----------

const createOpen = ref(false)

function openCreate() {
  if (!projects.value.length) {
    notify('还没有可备份的项目,请先到「项目」页添加')
    return
  }
  createOpen.value = true
}

// ---------- 清理 ----------

const pruneOpen = ref(false)

// ---------- 批量备份(未备份项目) ----------

const backingAll = ref(false)
const backAllProgress = ref('')

async function backupAllUncovered() {
  const ids = uncovered.value.map((p) => p._id)
  if (!ids.length || backingAll.value) return
  backingAll.value = true
  try {
    const r = await backupMany(ids, (done, total, name) => {
      backAllProgress.value = done < total ? `${done}/${total} ${name}` : ''
    })
    if (!r.ok) notify(r.error || '批量备份失败')
    else notify(`已为 ${r.count}/${ids.length} 个项目创建备份`)
  } finally {
    backingAll.value = false
    backAllProgress.value = ''
  }
}

// ---------- 展示辅助 ----------

const removeDetails = computed(() =>
  removeTargets.value.map(
    (r) => `${r.label || r.projectName} · ${fmtSize(r.size)} · ${r.destPath}`
  )
)

const hasAnyProject = computed(() => projects.value.length > 0)
const showUncovered = computed(() => status.value === 'uncovered')
const listEmpty = computed(() => !filtered.value.length)

function clearScope() {
  scopedProjectId.value = ''
  refresh()
}

function setStatus(next: typeof status.value) {
  status.value = next
  if (batchMode.value) exitBatch()
}

function projectNameOf(projectId: string) {
  return projectById.value[projectId]?.name || ''
}

const DATE_LABEL = computed(() => formatTime(Date.now()))
</script>

<template>
  <div class="backups view">
    <div class="view-head">
      <h2><Icon name="box" :size="16" /> 备份 <span class="count-pill">{{ stats.count }}</span></h2>
      <span class="grow"></span>
      <button
        v-if="records.length"
        class="btn small ghost"
        :title="batchMode ? '退出批量管理' : '勾选多份备份进行批量操作'"
        @click="batchMode ? exitBatch() : enterBatch()"
      >
        <Icon name="check" :size="12" /> {{ batchMode ? '退出批量' : '批量管理' }}
      </button>
      <button class="btn small primary" title="为某个项目创建一份新备份" @click="openCreate">
        <Icon name="plus" :size="12" /> 新建备份
      </button>
      <button
        v-if="records.length"
        class="btn small ghost"
        title="按保留策略清理旧备份"
        @click="pruneOpen = true"
      >
        <Icon name="trash" :size="12" /> 清理
      </button>
    </div>

    <!-- 统计头 -->
    <div class="stat-row card">
      <div class="stat-cell">
        <span class="sc-label">备份份数</span>
        <span class="sc-value">{{ stats.count }}</span>
        <span class="sc-sub">zip {{ stats.byMode.zip }} · 快照 {{ stats.byMode.copy }}</span>
      </div>
      <div class="stat-cell hero-cell">
        <span class="sc-label">占用空间</span>
        <span class="sc-value lg">{{ fmtSize(stats.totalSize) }}</span>
        <span class="sc-sub">全部备份文件合计</span>
      </div>
      <div class="stat-cell" :class="{ alert: stats.missingCount }">
        <span class="sc-label">失效备份</span>
        <span class="sc-value">{{ stats.missingCount }}</span>
        <span class="sc-sub">{{ stats.missingCount ? '文件已被外部删除' : '全部文件就位' }}</span>
      </div>
      <div class="stat-cell">
        <span class="sc-label">覆盖项目</span>
        <span class="sc-value">{{ stats.coveredProjects }}<span class="sc-of">/{{ stats.totalProjects }}</span></span>
        <span class="sc-sub">{{ statusCounts.uncovered }} 个项目尚无备份</span>
      </div>
    </div>

    <!-- 工具行 -->
    <div class="tool-row">
      <div class="search-box">
        <Icon name="search" :size="13" />
        <input
          v-model="keyword"
          class="search-input"
          placeholder="搜索备注 / 项目名 / 路径"
          autocomplete="off"
          spellcheck="false"
        />
        <button v-if="keyword" class="search-clear" title="清除" @click="keyword = ''">
          <Icon name="x" :size="12" />
        </button>
      </div>

      <div class="chips">
        <button class="chip" :class="{ on: status === 'all' }" @click="setStatus('all')">
          全部 <span class="chip-count">{{ statusCounts.all }}</span>
        </button>
        <button class="chip" :class="{ on: status === 'zip' }" @click="setStatus('zip')">
          zip <span class="chip-count">{{ statusCounts.zip }}</span>
        </button>
        <button class="chip" :class="{ on: status === 'copy' }" @click="setStatus('copy')">
          快照 <span class="chip-count">{{ statusCounts.copy }}</span>
        </button>
        <button
          v-if="statusCounts.missing"
          class="chip danger"
          :class="{ on: status === 'missing' }"
          @click="setStatus('missing')"
        >
          <Icon name="alert" :size="11" /> 缺失 <span class="chip-count">{{ statusCounts.missing }}</span>
        </button>
        <button
          v-if="statusCounts.uncovered"
          class="chip"
          :class="{ on: status === 'uncovered' }"
          @click="setStatus('uncovered')"
        >
          未备份项目 <span class="chip-count">{{ statusCounts.uncovered }}</span>
        </button>
      </div>

      <span class="grow"></span>

      <select v-model="sort" class="select sort-select" title="排序方式">
        <option value="time">按时间</option>
        <option value="size">按体积</option>
        <option value="project">按项目</option>
      </select>
      <div class="seg">
        <button :class="{ on: viewMode === 'group' }" @click="viewMode = 'group'">
          <Icon name="layers" :size="11" /> 分组
        </button>
        <button :class="{ on: viewMode === 'timeline' }" @click="viewMode = 'timeline'">
          <Icon name="clock" :size="11" /> 时间轴
        </button>
      </div>
    </div>

    <!-- 项目页跳转过来的限定范围 -->
    <div v-if="scopedProjectId" class="scope-bar">
      <Icon name="filter" :size="12" />
      <span>仅显示:<b>{{ scopedProject?.name || '该项目' }}</b> 的备份</span>
      <button class="btn small ghost" @click="clearScope">显示全部</button>
    </div>

    <!-- 批量操作条 -->
    <div v-if="batchMode" class="batch-bar">
      <Icon name="check" :size="12" />
      <span>已选 <b>{{ selected.length }}</b> 份 · {{ fmtSize(selectedSize) }}</span>
      <button class="btn small ghost" @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选当前列表' }}
      </button>
      <span class="grow"></span>
      <button class="btn small" :disabled="!selected.length" @click="doVerifySelected">
        <Icon name="shield-check" :size="12" /> 批量校验
      </button>
      <button class="btn small danger-text" :disabled="!selected.length" @click="askRemoveSelected">
        <Icon name="trash" :size="12" /> 删除所选
      </button>
    </div>

    <!-- 后台巡检 -->
    <div v-if="patrolling" class="patrol-bar">
      <span class="spin"></span>
      <span>正在巡检备份完整性 {{ patrolDone }} / {{ patrolTotal }}</span>
    </div>

    <!-- 无项目 -->
    <EmptyState
      v-if="!hasAnyProject"
      icon="folder"
      title="还没有 Godot 项目"
      desc="备份以项目为单位。先到「项目」页添加或新建一个 Godot 项目,之后就能在这里管理它的所有备份。"
    >
      <button class="btn primary" @click="emit('navigate', 'projects')">
        <Icon name="folder" :size="14" /> 去项目页
      </button>
    </EmptyState>

    <!-- 未备份项目列表 -->
    <template v-else-if="showUncovered">
      <EmptyState
        v-if="!uncovered.length"
        icon="check"
        title="所有项目都已有备份"
        desc="每个项目至少有一份备份,不需要额外处理。"
      />
      <section v-else class="group card">
        <div class="group-head static">
          <Icon name="alert" :size="14" class="gh-icon" />
          <span class="gh-name">{{ uncovered.length }} 个项目从未备份</span>
          <span class="grow"></span>
          <span v-if="backAllProgress" class="gh-meta">{{ backAllProgress }}</span>
          <span v-else class="gh-meta">建议至少保留一份可回滚的版本</span>
          <button class="btn small primary" :disabled="backingAll" @click="backupAllUncovered">
            <span v-if="backingAll" class="spin"></span>
            <Icon v-else name="box" :size="12" />
            {{ backingAll ? '备份中…' : '全部备份' }}
          </button>
        </div>
        <div class="group-body">
          <div v-for="p in uncovered" :key="p._id" class="plain-row">
            <div class="pr-main">
              <div class="pr-name">
                {{ p.name }}
                <span v-if="p.engineVersion" class="tag">{{ p.engineVersion }}</span>
              </div>
              <div class="pr-path mono" :title="p.path">{{ p.path }}</div>
            </div>
            <button class="btn small primary" @click="emit('backup-project', p._id)">
              <Icon name="box" :size="12" /> 立即备份
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- 分组视图 -->
    <template v-else-if="viewMode === 'group'">
      <EmptyState
        v-if="listEmpty"
        icon="box"
        :title="records.length ? '没有匹配的备份' : '还没有任何备份'"
        :desc="records.length
          ? '换个关键词,或切换筛选条件试试。'
          : '到「项目」页对某个项目点击备份按钮,或在下方找出还没有备份的项目。'"
      >
        <button v-if="!records.length" class="btn primary" @click="emit('navigate', 'projects')">
          <Icon name="folder" :size="14" /> 去项目页
        </button>
        <button v-else class="btn" @click="keyword = ''; setStatus('all')">重置筛选</button>
      </EmptyState>

      <section
        v-for="g in groups"
        v-else
        :key="g.projectId"
        class="group card"
        :class="{ orphan: g.orphan }"
      >
        <div class="group-head" @click="toggleGroup(g.projectId)">
          <Icon :name="isCollapsed(g.projectId) ? 'chevron-right' : 'chevron-down'" :size="13" class="gh-chev" />
          <span class="gh-name">{{ g.name }}</span>
          <span v-if="g.orphan" class="tag warn"><Icon name="alert" :size="10" /> 项目已移除</span>
          <span class="grow"></span>
          <span class="gh-meta">{{ g.records.length }} 份 · {{ fmtSize(g.totalSize) }}</span>
          <span class="gh-time">最近 {{ formatTime(g.latestAt) }}</span>
        </div>
        <div v-show="!isCollapsed(g.projectId)" class="group-body">
          <BackupListItem
            v-for="r in g.records"
            :key="r._id"
            :record="r"
            :orphan="g.orphan"
            :batch-mode="batchMode"
            :selected="selectedSet.has(r._id)"
            :busy="busyId === r._id"
            @toggle="toggleSelect(r._id)"
            @restore="askRestore(r)"
            @rename="openRename(r)"
            @verify="doVerify(r)"
            @remove="askRemove(r)"
            @reveal="reveal(r)"
          />
        </div>
      </section>
    </template>

    <!-- 时间轴视图 -->
    <template v-else>
      <EmptyState
        v-if="listEmpty"
        icon="box"
        title="没有匹配的备份"
        desc="换个关键词,或切换筛选条件试试。"
      />
      <section v-for="b in timeline" v-else :key="b.key" class="group card">
        <div class="group-head static">
          <Icon name="clock" :size="13" class="gh-icon" />
          <span class="gh-name">{{ b.label }}</span>
          <span class="grow"></span>
          <span class="gh-meta">{{ b.records.length }} 份 · {{ fmtSize(b.records.reduce((s, r) => s + (r.size || 0), 0)) }}</span>
        </div>
        <div class="group-body">
          <BackupListItem
            v-for="r in b.records"
            :key="r._id"
            :record="r"
            :orphan="!projectNameOf(r.projectId)"
            :batch-mode="batchMode"
            :selected="selectedSet.has(r._id)"
            :busy="busyId === r._id"
            show-project
            @toggle="toggleSelect(r._id)"
            @restore="askRestore(r)"
            @rename="openRename(r)"
            @verify="doVerify(r)"
            @remove="askRemove(r)"
            @reveal="reveal(r)"
          />
        </div>
      </section>
    </template>

    <!-- 备注编辑 -->
    <Teleport to="body">
      <div v-if="renameTarget" class="modal-mask" @click.self="renameTarget = null">
        <form class="card modal sm" @submit.prevent="saveRename">
          <div class="modal-head">
            <div class="modal-title"><Icon name="tag" :size="15" /> 编辑备注名</div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="renameTarget = null">
              <Icon name="x" :size="14" />
            </button>
          </div>
          <div class="field">
            <label class="f-label" for="bk-label">备注名</label>
            <input
              id="bk-label"
              ref="renameInput"
              v-model="renameValue"
              class="input"
              maxlength="80"
              placeholder="如:发布前 / v1.0 通过审核"
              autocomplete="off"
              spellcheck="false"
            />
            <div class="f-hint wrap">
              留空则清除备注,列表会显示「{{ renameTarget.projectName }} · {{ formatTime(renameTarget.createdAt) }}」。
            </div>
          </div>
          <div class="modal-foot">
            <span class="grow"></span>
            <button type="button" class="btn ghost" @click="renameTarget = null">取消</button>
            <button type="submit" class="btn primary"><Icon name="check" :size="13" /> 保存</button>
          </div>
        </form>
      </div>
    </Teleport>

    <ConfirmDialog
      :open="removeOpen"
      :title="removeTargets.length > 1 ? `删除 ${removeTargets.length} 份备份` : '删除备份'"
      :tone="allMissing ? 'info' : 'danger'"
      :message="removeMessage"
      :details="removeDetails"
      :confirm-label="allMissing ? '移除记录' : '删除'"
      :busy="removeBusy"
      @confirm="doRemove"
      @cancel="removeOpen = false"
    />

    <BackupCreateDialog
      :open="createOpen"
      :projects="projects"
      @close="createOpen = false"
      @done="refresh"
    />

    <PruneDialog :open="pruneOpen" @close="pruneOpen = false" @done="refresh" />

    <RestoreDialog
      :open="restoreOpen"
      :record="restoreTarget"
      :project="restoreProject"
      :orphan="restoreOrphan"
      @close="restoreOpen = false"
      @done="refresh"
    />

    <div class="foot-note">共 {{ stats.count }} 份备份 · 页面数据刷新于 {{ DATE_LABEL }}</div>
  </div>
</template>

<style scoped>
/* ---------- 统计头 ---------- */
.stat-row {
  display: grid;
  grid-template-columns: 1fr 1.25fr 1fr 1fr;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 13px 16px;
  border-right: 1px solid var(--border);
  min-width: 0;
}

.stat-cell:last-child {
  border-right: none;
}

.stat-cell.alert .sc-value {
  color: var(--danger);
}

.hero-cell {
  background: var(--brand-weak);
}

.sc-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}

.sc-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.012em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.sc-value.lg {
  font-size: 27px;
  letter-spacing: -0.022em;
  color: var(--brand);
}

.sc-of {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-3);
}

.sc-sub {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 工具行 ---------- */
.tool-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  width: 230px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  color: var(--text-3);
}

.search-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  padding: 6px 0;
}

.search-input::placeholder {
  color: var(--text-3);
}

.search-clear {
  display: flex;
  align-items: center;
  border: none;
  background: transparent;
  padding: 2px;
  color: var(--text-3);
  cursor: pointer;
}

.search-clear:hover {
  color: var(--text);
}

.chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chip.danger:not(.on) {
  color: var(--danger);
  border-color: var(--danger-weak);
}

.sort-select {
  font-size: 12px;
  padding: 4px 8px;
}

/* ---------- 限定范围 / 批量条 ---------- */
.scope-bar,
.batch-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.scope-bar {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}

.batch-bar {
  background: var(--brand-weak);
  border: 1px solid var(--brand);
  color: var(--brand);
  font-weight: 500;
}

/* 后台巡检提示 */
.patrol-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px dashed var(--border-strong);
  font-size: 12px;
  color: var(--text-3);
}

/* ---------- 分组 ---------- */
.group {
  overflow: hidden;
}

.group.orphan {
  border-style: dashed;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 13px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.group-head.static {
  cursor: default;
}

.group-head:hover:not(.static) {
  background: var(--surface-3);
}

.gh-chev,
.gh-icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.gh-name {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gh-meta,
.gh-time {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
}

/* ---------- 普通行(未备份项目) ---------- */
.plain-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.pr-main {
  flex: 1;
  min-width: 0;
}

.pr-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
}

.pr-path {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot-note {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  padding-top: 2px;
}
</style>
