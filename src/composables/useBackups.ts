// 备份管理页的状态与动作:列表、统计、筛选、分组、批量选择、备注、校验、删除。
// 备份页与（阶段 3 的）相关对话框共用这里的数据视图。
import { computed, ref } from 'vue'
import { getSettings, listDocs, notify, showInFolder } from '../services/bridge'
import type { BackupRecord, BackupStats, GodotProject } from '../types/godot'

export type BackupStatusFilter = 'all' | 'zip' | 'copy' | 'missing' | 'uncovered'
export type BackupSort = 'time' | 'size' | 'project'
export type BackupViewMode = 'group' | 'timeline'

/** 按项目聚合的分组 */
export interface BackupGroup {
  projectId: string
  name: string
  /** 项目记录已不存在(孤立备份):只能恢复为新项目 */
  orphan: boolean
  records: BackupRecord[]
  totalSize: number
  latestAt: number
}

export interface TimelineBucket {
  key: string
  label: string
  records: BackupRecord[]
}

type ProjectRow = GodotProject & { _id: string }

const EMPTY_STATS: BackupStats = {
  count: 0,
  totalSize: 0,
  missingCount: 0,
  coveredProjects: 0,
  totalProjects: 0,
  byMode: { zip: 0, copy: 0 }
}

export function useBackups() {
  const records = ref<BackupRecord[]>([])
  const stats = ref<BackupStats>({ ...EMPTY_STATS, byMode: { ...EMPTY_STATS.byMode } })
  const projects = ref<ProjectRow[]>([])

  const keyword = ref('')
  const status = ref<BackupStatusFilter>('all')
  const sort = ref<BackupSort>('time')
  const viewMode = ref<BackupViewMode>('group')
  /** 从项目页跳转时锁定到某个项目 */
  const scopedProjectId = ref('')

  const batchMode = ref(false)
  const selected = ref<string[]>([])
  const busy = ref('')
  /** 折叠的分组 key */
  const collapsed = ref<Record<string, boolean>>({})

  const projectById = computed(() => {
    const map: Record<string, ProjectRow> = {}
    for (const p of projects.value) map[p._id] = p
    return map
  })

  async function refresh() {
    records.value = await window.services.listBackups({ withStatus: true })
    stats.value = await window.services.backupStats()
    projects.value = (await listDocs<GodotProject>('godot/project/')) as ProjectRow[]
    const ids = new Set(records.value.map((r) => r._id))
    selected.value = selected.value.filter((id) => ids.has(id))
    if (!records.value.length) exitBatch()
  }

  // ---------- 筛选与排序 ----------

  const filtered = computed<BackupRecord[]>(() => {
    const kw = keyword.value.trim().toLowerCase()
    const scope = scopedProjectId.value
    const list = records.value.filter((r) => {
      if (scope && r.projectId !== scope) return false
      if (status.value === 'uncovered') return false
      if (status.value === 'zip' && r.mode !== 'zip') return false
      if (status.value === 'copy' && r.mode !== 'copy') return false
      if (status.value === 'missing' && !r.missing) return false
      if (!kw) return true
      return (
        (r.label || '').toLowerCase().includes(kw) ||
        (r.projectName || '').toLowerCase().includes(kw) ||
        (r.destPath || '').toLowerCase().includes(kw)
      )
    })
    return [...list].sort((a, b) => {
      if (sort.value === 'size') return (b.size || 0) - (a.size || 0)
      if (sort.value === 'project') {
        return (a.projectName || '').localeCompare(b.projectName || '') || (b.createdAt || 0) - (a.createdAt || 0)
      }
      return (b.createdAt || 0) - (a.createdAt || 0)
    })
  })

  const groups = computed<BackupGroup[]>(() => {
    const map = new Map<string, BackupRecord[]>()
    for (const r of filtered.value) {
      const arr = map.get(r.projectId)
      if (arr) arr.push(r)
      else map.set(r.projectId, [r])
    }
    const out: BackupGroup[] = []
    for (const [projectId, list] of map) {
      const sorted = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      const p = projectById.value[projectId]
      out.push({
        projectId,
        name: p ? p.name : sorted[0].projectName || '(未知项目)',
        orphan: !p,
        records: sorted,
        totalSize: sorted.reduce((s, r) => s + (r.size || 0), 0),
        latestAt: sorted[0]?.createdAt || 0
      })
    }
    // 孤立备份(项目已删除)单独排到最后
    out.sort((a, b) => {
      if (a.orphan !== b.orphan) return a.orphan ? 1 : -1
      return b.latestAt - a.latestAt
    })
    return out
  })

  const timeline = computed<TimelineBucket[]>(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const buckets: TimelineBucket[] = [
      { key: 'today', label: '今天', records: [] },
      { key: 'yesterday', label: '昨天', records: [] },
      { key: 'week', label: '最近 7 天', records: [] },
      { key: 'older', label: '更早', records: [] }
    ]
    for (const r of filtered.value) {
      const t = r.createdAt || 0
      if (t >= startOfToday) buckets[0].records.push(r)
      else if (t >= startOfToday - 86400000) buckets[1].records.push(r)
      else if (t >= startOfToday - 6 * 86400000) buckets[2].records.push(r)
      else buckets[3].records.push(r)
    }
    return buckets.filter((b) => b.records.length)
  })

  const coveredProjectIds = computed(() => new Set(records.value.map((r) => r.projectId)))

  /** 已登记但从未备份过的项目 */
  const uncovered = computed<ProjectRow[]>(() => {
    const kw = keyword.value.trim().toLowerCase()
    return projects.value
      .filter((p) => !coveredProjectIds.value.has(p._id))
      .filter((p) => !kw || p.name.toLowerCase().includes(kw) || p.path.toLowerCase().includes(kw))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const statusCounts = computed(() => ({
    all: records.value.length,
    zip: stats.value.byMode.zip,
    copy: stats.value.byMode.copy,
    missing: stats.value.missingCount,
    uncovered: uncovered.value.length
  }))

  const scopedProject = computed(() =>
    scopedProjectId.value ? projectById.value[scopedProjectId.value] : undefined
  )

  // ---------- 批量选择 ----------

  const selectedSet = computed(() => new Set(selected.value))
  const selectedRecords = computed(() => records.value.filter((r) => selectedSet.value.has(r._id)))
  const selectedSize = computed(() => selectedRecords.value.reduce((s, r) => s + (r.size || 0), 0))
  const allSelected = computed(
    () => filtered.value.length > 0 && filtered.value.every((r) => selectedSet.value.has(r._id))
  )

  function toggleSelect(id: string) {
    const set = new Set(selected.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    selected.value = [...set]
  }

  /**
   * 全选 / 取消全选,**只作用于当前筛选后的列表**:
   * 勾选时与已有选择取并集(不会丢掉列表外的选择),取消时只移除列表内的项。
   * 这样在切换筛选条件时用户的选择始终可预期、可逆。
   */
  function toggleSelectAll() {
    const ids = filtered.value.map((r) => r._id)
    if (allSelected.value) {
      const drop = new Set(ids)
      selected.value = selected.value.filter((id) => !drop.has(id))
    } else {
      const set = new Set(selected.value)
      for (const id of ids) set.add(id)
      selected.value = [...set]
    }
  }

  function enterBatch() {
    batchMode.value = true
  }

  function exitBatch() {
    batchMode.value = false
    selected.value = []
  }

  function toggleGroup(key: string) {
    collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] }
  }

  function isCollapsed(key: string) {
    return !!collapsed.value[key]
  }

  // ---------- 动作 ----------

  /** 保存备注名(label 传空串清除) */
  async function setLabel(id: string, label: string): Promise<boolean> {
    const r = await window.services.updateBackup(id, { label })
    if (!r.ok) {
      notify(r.error || '备注保存失败')
      return false
    }
    const rec = records.value.find((x) => x._id === id)
    if (rec) {
      const next = label.trim()
      if (next) rec.label = next
      else delete rec.label
    }
    notify(label.trim() ? '备注已保存' : '备注已清除')
    return true
  }

  /** 校验备份内容是否可用 */
  async function verify(id: string) {
    busy.value = id
    try {
      const r = await window.services.verifyBackup(id)
      const rec = records.value.find((x) => x._id === id)
      if (rec) {
        rec.verified = r.valid
        rec.verifiedAt = Date.now()
        rec.verifyError = r.error
      }
      notify(r.valid ? '备份有效' : `备份无效:${r.error || '未知原因'}`)
      return r
    } finally {
      busy.value = ''
    }
  }

  /** 批量校验(只更新本地结果) */
  async function verifyMany(ids: string[]) {
    let valid = 0
    let invalid = 0
    for (const id of ids) {
      const r = await window.services.verifyBackup(id)
      const rec = records.value.find((x) => x._id === id)
      if (rec) {
        rec.verified = r.valid
        rec.verifiedAt = Date.now()
        rec.verifyError = r.error
      }
      if (r.valid) valid++
      else invalid++
    }
    notify(invalid ? `校验完成:${valid} 份有效,${invalid} 份无效` : `校验完成:${valid} 份全部有效`)
    return { valid, invalid }
  }

  /** 删除单条(keepRecordOnly=true 仅移除记录) */
  async function removeOne(id: string, keepRecordOnly = false): Promise<boolean> {
    const r = await window.services.deleteBackup(id, { keepRecordOnly })
    if (!r.ok) {
      notify(r.error || '删除失败')
      return false
    }
    await refresh()
    notify(keepRecordOnly ? '已移除记录(文件保留)' : '已删除备份(移入回收站)')
    return true
  }

  /** 批量删除,返回成功移除的份数 */
  async function removeMany(ids: string[], keepRecordOnly = false): Promise<number> {
    if (!ids.length) return 0
    const r = await window.services.deleteBackups(ids, { keepRecordOnly })
    await refresh()
    if (r.failed && r.failed.length) {
      notify(`${r.removed} 份已移除,${r.failed.length} 份失败:${r.failed[0].error}`)
    } else {
      notify(keepRecordOnly ? `已移除 ${r.removed} 条记录(文件保留)` : `已删除 ${r.removed} 份备份(移入回收站)`)
    }
    return r.removed
  }

  /** 在文件管理器中定位备份文件/目录 */
  function reveal(record: BackupRecord) {
    showInFolder(record.destPath)
  }

  // ---------- 后台巡检 ----------

  const patrolling = ref(false)
  const patrolDone = ref(0)
  const patrolTotal = ref(0)

  /**
   * 进入备份页时后台巡检:校验「从未校验过」与「缺失但尚未判定」的备份,把结论写回记录。
   * verifyBackup 只读取 zip 尾部与中央目录,本身很快;但记录多时仍分片让出,避免占满主线程。
   */
  async function patrol(limit = 300) {
    if (patrolling.value) return
    // 已经因文件缺失判为无效的记录不再重复校验(文件回来了会先由 missing 标记翻回 false)
    const candidates = records.value
      .filter((r) => r.verified === undefined || (r.missing && r.verified !== false))
      .slice(0, limit)
    if (!candidates.length) {
      patrolDone.value = 0
      patrolTotal.value = 0
      return
    }
    patrolling.value = true
    patrolDone.value = 0
    patrolTotal.value = candidates.length
    try {
      const CHUNK = 8
      for (let i = 0; i < candidates.length; i++) {
        const target = candidates[i]
        try {
          const res = await window.services.verifyBackup(target._id)
          const rec = records.value.find((x) => x._id === target._id)
          if (rec) {
            rec.verified = res.valid
            rec.verifiedAt = Date.now()
            rec.verifyError = res.error
          }
        } catch (e) { /* 单条失败不影响其余 */ }
        patrolDone.value = i + 1
        if (i % CHUNK === CHUNK - 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      // 巡检可能改变缺失数量,刷新统计头
      stats.value = await window.services.backupStats()
    } finally {
      patrolling.value = false
    }
  }

  // ---------- 批量备份 ----------

  /**
   * 按当前默认设置顺序为多个项目创建备份。
   * 逐个串行(备份本身很重,并行会同时抢磁盘),单个失败不中断其余。
   */
  async function backupMany(
    projectIds: string[],
    onProgress?: (done: number, total: number, name: string) => void
  ) {
    const s = await getSettings()
    const destDir = s.backupRoot
    if (!destDir) return { ok: false, error: '请先在「设置 → 备份与恢复」中配置默认备份目录', count: 0 }
    if (!projectIds.length) return { ok: true, count: 0 }
    let count = 0
    for (let i = 0; i < projectIds.length; i++) {
      const id = projectIds[i]
      onProgress?.(i, projectIds.length, projectById.value[id]?.name || '')
      try {
        await window.services.backupProject(id, {
          mode: s.backupMode === 'copy' ? 'copy' : 'zip',
          destDir,
          includeCache: !!s.backupIncludeCache,
          level: s.backupLevel === 1 || s.backupLevel === 9 ? s.backupLevel : 6,
          exclude: s.backupExclude || []
        })
        count++
      } catch (e) { /* 单个项目失败不影响后续 */ }
    }
    onProgress?.(projectIds.length, projectIds.length, '')
    await refresh()
    return { ok: true, count }
  }

  return {
    // 数据
    records,
    stats,
    projects,
    projectById,
    // 查询状态
    keyword,
    status,
    sort,
    viewMode,
    scopedProjectId,
    scopedProject,
    // 派生
    filtered,
    groups,
    timeline,
    uncovered,
    statusCounts,
    // 批量
    batchMode,
    selected,
    selectedSet,
    selectedRecords,
    selectedSize,
    allSelected,
    // 折叠
    isCollapsed,
    // 巡检
    patrolling,
    patrolDone,
    patrolTotal,
    // 动作
    refresh,
    toggleSelect,
    toggleSelectAll,
    enterBatch,
    exitBatch,
    toggleGroup,
    setLabel,
    verify,
    verifyMany,
    removeOne,
    removeMany,
    reveal,
    patrol,
    backupMany
  }
}
