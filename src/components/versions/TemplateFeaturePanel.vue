<script setup lang="ts">
// 自编译模板 · 功能面板(裁剪向导的第二步)。
//
// 这里**没有任何判据**:哪些开关存在、默认值是什么、关掉 3D 会连带什么、哪些组合会编出废模板,
// 全部由宿主侧的 tplfeatures(能力表)/ tplprobe(源码探测)/ tplprofile(勾选→产物)算完,
// 再经契约 listTemplateFeatures 交出来(策划书 §5.1 三层模型)。
// "这一行**眼下**是不是被上面的总开关带走了"也是判据,同样归宿主(tplprofile.selectionSuppressed →
// validateTemplateConfig 的 suppressed → T10 并进 :suppressed,Ruling #62),组件只当名单的接收端。
// 本组件只做三件事:按 group 分区渲染、把勾选变化报上去、把宿主给的禁用/连带/风险态显示出来。
// 与 TemplateBuildWizard.vue 同一先例:判据不进 .vue(跑不进 Node harness),这里只是展示与调度。
//
// 护栏测试:TemplateFeaturePanel.test.mjs(源码扫描,逐条做过「拿掉实现就要红」的变异自检)。
// T10 收口:.off 淡化与禁用态同源(被抑制行也淡化),未实测提示改人话;两处都有对应断言(★New-7)。
import { computed } from 'vue'
import Icon from '../Icon.vue'
import type { FeatureWithProbe } from '../../types/godot'

const props = defineProps<{
  items: FeatureWithProbe[]
  modelValue: Record<string, boolean>
  sourceVersion: string
  tested: boolean
  /** 当前被连带关闭的面板项 id:宿主的 validateTemplateConfig 算好交出来(Ruling #62),不是本地判断 */
  suppressed?: string[]
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: Record<string, boolean>): void; (e: 'preset', name: string): void }>()

// 量级只给相对档位,不给 MB/GB(策划书 §1 第 9 条:绝对数字因版本与平台而变,给了就是假的)
const SIZE_LABEL = { large: '大', medium: '中', small: '小', tiny: '微', none: '—' } as const
// safe 档没有样式(正常观感就是默认态):留空串而不是挂一个没有任何 CSS 对应的死类名(终审 M6)
const RISK_CLASS = { safe: '', notice: 'risk-notice', danger: 'risk-danger' } as const

// 分组顺序与组名都来自宿主的表(能力层 TPL_GROUPS),组件不认识任何具体组名 —— 与工具页 registry 同一套做法
const grouped = computed(() => {
  const order: string[] = []
  const map = new Map<string, FeatureWithProbe[]>()
  for (const it of props.items || []) {
    if (!map.has(it.group)) { map.set(it.group, []); order.push(it.group) }
    map.get(it.group)!.push(it)
  }
  return order.map((g) => ({ group: g, items: map.get(g)! }))
})

// 点不动只有两支,两支都是宿主给的事实:
//   · present  —— 这份源码里没有这个开关;
//   · suppressed —— **当前这份勾选下**它被上面的总开关带走了(Ruling #62)。
// 为什么不用 cascadedBy 决定禁用:它是这份源码的**静态连带结构**(契约那个键直接取了探测层 cascades 的键),
// 拿它当"现在已被连带关闭"会让 3D 开着时的 3D 导航/3D 物理/XR 三行长期显示未勾选、长期点不动,
// 而产物里那三项都在 —— 想表达的结果根本没被表达。动态态归宿主算(tplprofile.selectionSuppressed),
// 组件只当名单的接收端。cascadedBy 在这里只剩一件事:把伞项的中文名说给用户(见 cascadeNote)。
const isSuppressed = (it: FeatureWithProbe) => (props.suppressed || []).includes(it.id)
const isDisabled = (it: FeatureWithProbe) => !it.present || isSuppressed(it)
function toggle(it: FeatureWithProbe, on: boolean) {
  // 被抑制的项在这一行就被拦住:不替用户改勾选、也不发那个键,所以总开关勾回来时它自己就回来了
  if (isDisabled(it)) return
  emit('update:modelValue', { ...(props.modelValue || {}), [it.id]: on })
}
// 勾选框显示的是**结果**,不是要发出去的那个 flag:被连带关闭的项在 modelValue 里可能仍是 true,
// 但它编出来就是没有 —— 所以界面必须显示没有。
const checked = (it: FeatureWithProbe) => (isDisabled(it) ? false : !!(props.modelValue || {})[it.id])

// 宿主交出来的 cascadedBy 是构建选项的**变量名**(契约里那个键直接取了 cascades 的键),不是面板项 id。
// 这里做展示层的一次反查:拿它去 items 里找哪个伞项声明了这个变量,把伞项的中文 label 说给用户;
// 反查不到(连带源在功能表外)就退化成不带名字的文案。绝不把变量名端给用户。
// 这是查表不是判据:它不决定任何行为,只决定这一行的小字写什么。
// 已知限制(台账 T8 deferred ④):一项被两个伞项同时连带时,宿主只报第一个,这里就照那一个说。
// 连带文案两态(Ruling #62):现在真被带走了 / 结构上会被带走但眼下没有。后者这一行**可以点**。
function cascadeNote(it: FeatureWithProbe): string {
  const label = (props.items || []).find((u) => it.cascadedBy !== undefined && u.flags.includes(it.cascadedBy))?.label || ''
  if (isSuppressed(it)) return label ? `（随「${label}」关闭）` : '（随上级选项关闭）'
  if (!it.cascadedBy) return ''
  return label ? `（取消「${label}」时这项会一起关闭）` : '（取消上级选项时这项会一起关闭）'
}
// 点不动的时候说清为什么点不动(同样是宿主给的事实,不是本地判断)
function disabledHint(it: FeatureWithProbe): string {
  if (!it.present) return '这份源码里没有这个开关'
  if (isSuppressed(it)) return '这一项现在被上面的总开关带走了,单独改它没有效果;把那个总开关勾回来就能改'
  return ''
}

const hasDanger = computed(() => (props.items || []).some((it) => it.risk === 'danger'))
</script>

<template>
  <div class="tpl-panel">
    <div class="preset-row">
      <span class="preset-label">预设</span>
      <!-- 只报名字:三档各自勾哪些项由宿主算(渲染层不复算,否则就是第二个真源) -->
      <button class="btn small" @click="emit('preset', 'full')">全量</button>
      <button class="btn small" @click="emit('preset', 'lite2d')">2D 精简</button>
      <button class="btn small" @click="emit('preset', 'minimal')">最小可跑</button>
      <span class="preset-cur">{{ tested ? '已实测版本' : '未实测版本' }}</span>
    </div>

    <p v-if="!tested" class="hint warn-line">
      这份源码（{{ sourceVersion || '版本读不出' }}）我们还没有实测过。下面按它自己声明的默认值显示，
      认不出的项保持灰色 —— 不猜参数，也不拒绝编译。
    </p>

    <p v-if="hasDanger" class="hint danger-legend">
      <Icon name="alert" :size="11" />
      带「高风险」标记的项:取消后那一项对应的功能在产物里整块不可用。第二行小字写的就是会失去什么。
    </p>

    <p v-if="!grouped.length" class="hint">这一版没有可勾选的开关,请回到上一步确认源码目录。</p>

    <section v-for="g in grouped" :key="g.group" class="grp">
      <h4>{{ g.group }}</h4>
      <label
        v-for="it in g.items"
        :key="it.id"
        class="feat"
        :class="[RISK_CLASS[it.risk], { off: isDisabled(it) }]"
        :title="disabledHint(it) || undefined"
      >
        <input
          type="checkbox"
          :checked="checked(it)"
          :disabled="isDisabled(it)"
          @change="toggle(it, ($event.target as HTMLInputElement).checked)"
        >
        <span class="lab">
          {{ it.label }}
          <span v-if="it.risk === 'danger'" class="risk-badge"><Icon name="alert" :size="10" />高风险</span>
        </span>
        <span class="size">体积影响：{{ SIZE_LABEL[it.sizeImpact] }}</span>
        <span class="desc">
          {{ it.present ? it.desc : '此版本源码无对应开关' }}<span v-if="cascadeNote(it)" class="cascade">{{ cascadeNote(it) }}</span>
        </span>
      </label>
    </section>
  </div>
</template>

<style scoped>
.tpl-panel { display: flex; flex-direction: column; gap: 10px; }
.preset-row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.preset-label { color: var(--text-2); }
.preset-cur { margin-left: auto; color: var(--text-2); font-size: 12px; }
.hint { margin: 0; font-size: 12px; color: var(--text-2); line-height: 1.6; }
.warn-line { color: var(--warn); }
/* 高风险图例:整块底色与描边走主题变量,深浅色主题下都在(先例 FixConfirmDialog.vue 的 .fx-warn) */
.danger-legend {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--danger);
  background: var(--danger-weak);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
}
.grp { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; }
.grp h4 { margin: 0 0 6px; font-size: 12px; color: var(--text-2); font-weight: 600; }
.feat {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 2px 8px;
  align-items: baseline;
  font-size: 12.5px;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
}
.feat .lab { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--text); }
.feat .size { color: var(--text-2); font-size: 11.5px; white-space: nowrap; }
.feat .desc { grid-column: 2 / span 2; color: var(--text-2); font-size: 11.5px; line-height: 1.5; }
.feat .cascade { color: var(--warn); }
/* 风险态:danger 是「取消就没有画面」那一类,提醒必须看得见 ——
   整行底色 + 左侧实心条 + 徽标三重,行高与密度不变(本仓库取向是信息密度优先) */
.feat.risk-danger { background: var(--danger-weak); box-shadow: inset 3px 0 0 var(--danger); }
.feat.risk-danger .lab { color: var(--danger); }
.feat.risk-notice { box-shadow: inset 3px 0 0 var(--warn); }
.feat.risk-notice .size { color: var(--warn); }
.risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  /* 中性面 + 红描边:整行已是弱红底,徽标再铺同一种红就糊成一片了 */
  background: var(--surface-2);
  color: var(--danger);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.feat.off { opacity: .55; }
</style>
