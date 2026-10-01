// 项目列表:读取、搜索过滤、收藏筛选、排序、行内变更。
//
// 从 ProjectsView.vue 抽出(该视图脚本 327 行,这块占了近三分之一)。抽出后
// 「过滤 + 排序」这组纯计算可以用断言逐条验证 —— 它原本只能靠肉眼在界面上翻。
import { computed, ref } from 'vue'
import { putDoc } from '../services/bridge'
import type { GodotProject, GodotVersion } from '../types/godot'

export type ProjectRow = GodotProject & { _id: string }

export function useProjectList() {
  const projects = ref<ProjectRow[]>([])
  const versions = ref<(GodotVersion & { _id: string })[]>([])
  const filter = ref('')
  const selected = ref(-1)
  const favOnly = ref(false)

  /**
   * 可见列表:先按关键词过滤(名称或路径,忽略大小写),再排序 ——
   * 收藏优先 → 最近打开优先 → 名称。
   */
  const visible = computed<ProjectRow[]>(() => {
    const kw = filter.value.trim().toLowerCase()
    const list = projects.value.filter((p) => {
      if (favOnly.value && !p.favorite) return false
      return !kw || p.name.toLowerCase().includes(kw) || p.path.toLowerCase().includes(kw)
    })
    return [...list].sort((a, b) => {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1
      if ((b.lastOpenedAt || 0) !== (a.lastOpenedAt || 0)) return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)
      return a.name.localeCompare(b.name)
    })
  })

  const favCount = computed(() => projects.value.filter((p) => p.favorite).length)

  /** 从本地库重新读取项目与已装引擎(异步,阶段 A) */
  async function reload() {
    projects.value = ((await window.ztools.db.allDocs('godot/project/')) || []) as any[]
    versions.value = ((await window.ztools.db.allDocs('godot/version/')) || []) as any[]
  }

  /** 就地切换收藏并落库 */
  function toggleFavorite(p: ProjectRow) {
    p.favorite = !p.favorite
    const { _id, ...data } = p
    putDoc(_id, data)
  }

  /** 绑定/解绑引擎版本并落库 */
  function bindVersion(p: ProjectRow, versionId: string) {
    p.versionId = versionId || undefined
    const { _id, ...data } = p
    putDoc(_id, data)
  }

  /** 删除成功后只从本地列表摘掉,不必整表重读 */
  function dropLocal(id: string) {
    projects.value = projects.value.filter((x) => x._id !== id)
  }

  return {
    projects,
    versions,
    filter,
    selected,
    favOnly,
    visible,
    favCount,
    reload,
    toggleFavorite,
    bindVersion,
    dropLocal
  }
}
