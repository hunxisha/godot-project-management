// 已装插件的多选与批量确认状态。
//
// 从 AddonsView.vue 抽出。两条容易出错、原本只能靠肉眼看的规则在这里被固定下来:
//   1. 列表刷新后必须**清掉已不存在的选择**(卸载/换项目后不能留下幽灵选中项,
//      否则批量操作会对着不存在的目录发请求)
//   2. 「批量卸载」是二次确认:第一次点只进入待确认态,且会在一段时间后自动解除
//      (避免用户点了一下就一直停在「确认卸载?」的红色状态)
import { computed, type Ref } from 'vue'
import { ref } from 'vue'
import type { AddonInfo } from '../types/godot'

export interface UseAddonSelectionOptions {
  /** 二次确认的自动解除时长;测试可传极小值 */
  confirmMs?: number
}

export function useAddonSelection(addons: Ref<AddonInfo[]>, opts: UseAddonSelectionOptions = {}) {
  const confirmMs = opts.confirmMs ?? 2500

  const checked = ref<string[]>([])
  /** 批量卸载的「待确认」状态 */
  const confirmingBatch = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 选中的插件对象(顺序跟随列表) */
  const selAddons = computed(() => addons.value.filter((a) => checked.value.includes(a.dirName)))
  const allChecked = computed(() => addons.value.length > 0 && checked.value.length === addons.value.length)
  const hasEnabledSel = computed(() => selAddons.value.some((a) => a.enabled))
  const hasDisabledSel = computed(() => selAddons.value.some((a) => !a.enabled))

  function cancelTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function disarmBatchConfirm() {
    cancelTimer()
    confirmingBatch.value = false
  }

  function armBatchConfirm() {
    cancelTimer()
    confirmingBatch.value = true
    timer = setTimeout(() => {
      confirmingBatch.value = false
    }, confirmMs)
  }

  function toggleCheck(dirName: string) {
    const i = checked.value.indexOf(dirName)
    if (i >= 0) checked.value.splice(i, 1)
    else checked.value.push(dirName)
    // 选择变了,之前的待确认状态作废
    disarmBatchConfirm()
  }

  function toggleAll() {
    checked.value = allChecked.value ? [] : addons.value.map((a) => a.dirName)
    disarmBatchConfirm()
  }

  function clear() {
    checked.value = []
  }

  /** 清掉列表中已不存在的选择(刷新/换项目后调用) */
  function prune() {
    if (!checked.value.length) return
    const live = new Set(addons.value.map((a) => a.dirName))
    checked.value = checked.value.filter((d) => live.has(d))
  }

  return {
    checked,
    confirmingBatch,
    selAddons,
    allChecked,
    hasEnabledSel,
    hasDisabledSel,
    toggleCheck,
    toggleAll,
    clear,
    prune,
    armBatchConfirm,
    disarmBatchConfirm
  }
}
