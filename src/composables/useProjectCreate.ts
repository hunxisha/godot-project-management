// 新建项目对话框:表单状态、父目录预填、目标路径预览、提交。
//
// 从 ProjectsView.vue 抽出。抽出的价值在于「预填默认值」这组规则 —— 父目录取最近项目的
// 上级目录、引擎版本取设置里的默认值(回退到第一个已装版本),这些默认值错了用户会直接
// 在错误的目录里建出项目,属于值得断言的行为。
import { computed, nextTick, ref, type Ref } from 'vue'
import { pickDirectory } from '../services/bridge'
import type { ProjectRow } from './useProjectList'
import type { GodotVersion } from '../types/godot'

export type RendererOption = 'forward_plus' | 'mobile' | 'gl_compatibility'

export interface UseProjectCreateOptions {
  projects: Ref<ProjectRow[]>
  versions: Ref<(GodotVersion & { _id: string })[]>
  /** 设置里的默认引擎版本 id(可缺省) */
  defaultVersionId?: string
  notify: (msg: string) => void
  /** 创建成功后重读列表 */
  reload: () => void
  /** 需要立即打开时调用(传入新建出的项目行) */
  openProject: (row: ProjectRow) => void
}

export function useProjectCreate(opts: UseProjectCreateOptions) {
  const showCreate = ref(false)
  const creating = ref(false)
  const cName = ref('')
  const cParent = ref('')
  const cRenderer = ref<RendererOption>('forward_plus')
  const cVersionId = ref('')
  const cOpen = ref(true)
  /** 用 Git 管理项目(与 Godot 编辑器新建项目时的版本控制选项一致) */
  const cGit = ref(false)
  const nameInput = ref<HTMLInputElement>()

  /** 目标目录预览(父目录 + 项目名) */
  const cPreview = computed(() => {
    if (!cParent.value.trim()) return ''
    const base = cParent.value.trim().replace(/[\\/]+$/, '')
    return cName.value.trim() ? `${base}\\${cName.value.trim()}` : base
  })

  /** 打开时重置表单并预填默认值 */
  function openCreate() {
    cName.value = ''
    // 预填最近项目的父目录,减少选择成本
    const recent = [...opts.projects.value].sort(
      (a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)
    )[0]
    cParent.value = recent ? recent.path.replace(/[\\/][^\\/]+$/, '') : ''
    cVersionId.value =
      opts.versions.value.find((v) => v._id === opts.defaultVersionId)?._id ||
      opts.versions.value[0]?._id ||
      ''
    cRenderer.value = 'forward_plus'
    cOpen.value = true
    cGit.value = false
    showCreate.value = true
    nextTick(() => nameInput.value?.focus())
  }

  function chooseParent() {
    const dir = pickDirectory('选择新项目的保存位置', cParent.value || undefined)
    if (dir) cParent.value = dir
  }

  function submitCreate() {
    if (creating.value) return
    if (!cName.value.trim() || !cParent.value.trim()) return
    creating.value = true
    const v = opts.versions.value.find((x) => x._id === cVersionId.value)
    const r = window.services.createProject({
      name: cName.value.trim(),
      parentDir: cParent.value.trim(),
      renderer: cRenderer.value,
      versionTag: v?.tag,
      versionId: v?._id,
      gitInit: cGit.value
    })
    creating.value = false
    if (!r.ok || !r.project) {
      opts.notify(r.error || '创建失败')
      return
    }
    showCreate.value = false
    opts.reload()
    // git 结果单独告知:初始化失败不影响项目本身(文件已写好)
    if (r.git && !r.git.initialized) {
      opts.notify(`已创建项目:${r.project.name}(${r.git.error || 'Git 初始化未完成'})`)
    } else if (r.git && !r.git.committed) {
      opts.notify(`已创建项目:${r.project.name}(Git 已初始化,首次提交失败,请检查 git 身份配置)`)
    } else {
      opts.notify(`已创建项目:${r.project.name}${r.git ? '(已初始化 Git)' : ''}`)
    }
    if (cOpen.value) {
      const row = opts.projects.value.find((p) => p._id === r.project!.id)
      if (row) opts.openProject(row)
    }
  }

  return {
    showCreate,
    creating,
    cName,
    cParent,
    cRenderer,
    cVersionId,
    cOpen,
    cGit,
    nameInput,
    cPreview,
    openCreate,
    chooseParent,
    submitCreate
  }
}
