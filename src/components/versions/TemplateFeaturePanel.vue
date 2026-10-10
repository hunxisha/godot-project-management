<script setup lang="ts">
// 自编译模板 · 功能面板(裁剪向导的第二步)。
//
// 这里**没有任何判据**:哪些开关存在、默认值是什么、关掉 3D 会连带什么、哪些组合会编出废模板,
// 全部由宿主侧的 tplfeatures(能力表)/ tplprobe(源码探测)/ tplprofile(勾选→产物)算完,
// 再经契约 listTemplateFeatures 交出来(策划书 §5.1 三层模型)。
// 本组件只做三件事:按 group 分区渲染、把勾选变化报上去、把宿主给的禁用/连带/风险态显示出来。
// 与 TemplateBuildWizard.vue 同一先例:判据不进 .vue(跑不进 Node harness),这里只是展示与调度。
//
// 护栏测试:TemplateFeaturePanel.test.mjs(源码扫描,逐条做过「拿掉实现就要红」的变异自检)。
import { computed } from 'vue'
import Icon from '../Icon.vue'
import type { FeatureWithProbe } from '../../types/godot'

const props = defineProps<{
  items: FeatureWithProbe[]
  modelValue: Record<string, boolean>
  sourceVersion: string
  tested: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: Record<string, boolean>): void; (e: 'preset', name: string): void }>()

// 量级只给相对档位,不给 MB/GB(策划书 §1 第 9 条:绝对数字因版本与平台而变,给了就是假的)
const SIZE_LABEL = { large: '大', medium: '中', small: '小', tiny: '微', none: '—' } as const
const RISK_CLASS = { safe: 'risk-safe', notice: 'risk-notice', danger: 'risk-danger' } as const

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

// 探不到的项(这份源码没这个开关)与被伞项连带的项都点不动:前者由宿主的 present 判,
// 后者由宿主的 cascadedBy 判 —— 组件不自己算连带,只是不让用户改一个改不动的值。
const isDisabled = (it: FeatureWithProbe) => !it.present || !!it.cascadedBy
function toggle(it: FeatureWithProbe, on: boolean) {
  if (isDisabled(it)) return
  emit('update:modelValue', { ...props.modelValue, [it.id]: on })
}
// 勾选框显示的是**结果**,不是要发出去的那个 flag:连带项的 modelValue 里可能仍是 true
// (我们不替用户改勾选态,也不发那个键),但它编出来就是没有 —— 所以界面必须显示没有。
const checked = (it: FeatureWithProbe) => (isDisabled(it) ? false : !!props.modelValue[it.id])

// 宿主交出来的 cascadedBy 是构建选项的**变量名**(契约里那个键直接取了 cascades 的键),不是面板项 id。
// 这里做展示层的一次反查:拿它去 items 里找哪个伞项声明了这个变量,把伞项的中文 label 说给用户;
// 反查不到(伞项不在面板上)就退化成不带名字的文案。绝不把变量名端给用户。
// 这是查表不是判据:它不决定任何行为,只决定这一行的小字写什么。
// 已知限制(台账 T8 deferred ④):一项被两个伞项同时连带时,宿主只报第一个,这里就照那一个说。
function cascadeNote(it: FeatureWithProbe): string {
  const by = it.cascadedBy
  if (!by) return ''
  const label = (props.items || []).find((u) => u.flags.includes(by))?.label
  return label ? `（随「${label}」关闭）` : '（随上级选项关闭）'
}
// 点不动的时候说清为什么点不动(同样是宿主给的事实,不是本地判断)
function disabledHint(it: FeatureWithProbe): string {
  if (!it.present) return '这份源码里没有这个开关'
  if (it.cascadedBy) return '它由总开关决定,单独点不动'
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
      这份源码（{{ sourceVersion || '版本读不出' }}）不在已实测表内。面板按探测结果工作，
      未识别的项已置灰并保持源码默认 —— 不猜参数，也不拒绝编译。
    </p>

    <p v-if="hasDanger" class="hint danger-legend">
      <Icon name="alert" :size="11" />
      带「高风险」标记的项:取消后那一项对应的功能在产物里整块不可用。第二行小字写的就是会失去什么。
    </p>

    <p v-if="!grouped.length" class="hint">没有可显示的开关(宿主这次没交出面板项)。</p>

    <section v-for="g in grouped" :key="g.group" class="grp">
      <h4>{{ g.group }}</h4>
      <label
        v-for="it in g.items"
        :key="it.id"
        class="feat"
        :class="[RISK_CLASS[it.risk], { off: !it.present }]"
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
          {{ it.present ? it.desc : '此版本源码无对应开关' }}<em v-if="cascadeNote(it)" class="cascade">{{ cascadeNote(it) }}</em>
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
.feat .cascade { color: var(--warn); font-style: normal; }
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
