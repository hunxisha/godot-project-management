<script setup lang="ts">
// schema 渲染器(§3 P0-b 第 9 项 / §5.8 / Q31 / Q10=D)。
//
// 插件声明参数,框架画表单 —— 这是「连 h() 都不用写」那句话落到实处的地方。
// 字段类型只支持 `schema.ts` 认的那七种;不认识的字段早在 `validateSchema` 那侧被筛掉并给出原因
// (整页白屏是最糟的收法),所以这里拿到的 fields 一定是可画的。
//
// 判据:
//   · 校验错误**内联**显示在出错的那个字段下面,不是弹一条 toast 就完事(错误来自 resolveParams,
//     措辞的唯一来源在 schema.ts,这里只搬运不改写);
//   · files 字段不在这里画文件列表 —— 选中集由页面的 FilePicker 那一片负责(它才拿得到候选与截断状态),
//     这里只报「已选 N 个」并把按钮转成事件。两处各画一份勾选框就是第二个真源;
//   · 第 1 批没有带 regex 字段的工具,所以 Q31 那句「实时匹配计数」这里**不做**:
//     没有真实使用者的接口就是臆想接口(上一轮翻车的机制)。regex 字段先按文本框画,编译错误照样内联显示。
import Icon from '../Icon.vue'
import type { FieldDesc } from '../../toolkit/schema'
import { fieldHint } from '../../toolkit/schema'

const props = defineProps<{
  fields: FieldDesc[]
  model: Record<string, unknown>
  issues?: string[]
  pickedCount?: number
  /**
   * 文件面板此刻开着没有。它是**页面的状态**(ToolPageView 的 showPicker),这里只接过来做两件事:
   * 按钮文案跟着翻(toggle 不表达状态就像「点了没反应」)、插槽知道该不该渲染。
   */
  pickerOpen?: boolean
  /**
   * 参数预览句(§5.7 的「匹配到 12 处」)。话由插件的可选 `count()` 说、由页面搬过来,
   * 这里只决定**画在哪个字段下面**:最后一个 regex 字段;没有 regex 字段就画在表单末尾。
   * 空串不画条 —— 没有工具该看到一句空提示。
   */
  hint?: string
}>()

const emit = defineEmits<{
  (e: 'set', key: string, value: unknown): void
  (e: 'pick-files'): void
}>()

function errOf(key: string): string {
  for (const line of props.issues || []) {
    const i = line.indexOf(':')
    if (i > 0 && line.slice(0, i) === key) return line.slice(i + 1)
  }
  return ''
}

function asText(v: unknown): string { return typeof v === 'string' ? v : '' }
function asNum(v: unknown): number | string { return typeof v === 'number' ? v : '' }
/** 预览句挂在最后一个 regex 字段下面(没有 regex 字段就挂在末尾)—— 它说的是那条规则命中几个 */
function hintRow(i: number): boolean {
  if (!props.hint) return false
  const list = props.fields || []
  for (let k = list.length - 1; k > i; k--) if (list[k] && list[k].type === 'regex') return false
  return !!list[i] && list[i].type === 'regex'
}
const hintTail = () => {
  const list = props.fields || []
  for (const f of list) if (f && f.type === 'regex') return false
  return !!props.hint
}
</script>

<template>
  <div class="schema-form">
    <div v-for="(f, i) in props.fields" :key="f.key" class="row" :class="{ bad: !!errOf(f.key) }">
      <label class="lab">
        {{ f.label }}
        <span v-if="f.required" class="req">必填</span>
      </label>

      <div class="ctl">
        <!-- files:选中集在页面另一块里挑,这里只报状态 -->
        <template v-if="f.type === 'files'">
          <button class="btn small" type="button" :aria-expanded="props.pickerOpen ? 'true' : 'false'" @click="emit('pick-files')">
            <Icon name="folder" :size="13" /> {{ props.pickerOpen ? '收起文件清单' : '挑选文件' }}
          </button>
          <span class="picked">已选 {{ props.pickedCount || 0 }} 个</span>
        </template>

        <select v-else-if="f.type === 'select'" class="select" :value="asText(props.model[f.key])" @change="emit('set', f.key, ($event.target as HTMLSelectElement).value)">
          <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <!-- boolean 用 checkbox.switch:开关语义,0/1 的「必填」对它没有意义 -->
        <label v-else-if="f.type === 'boolean'" class="switch">
          <input type="checkbox" :checked="props.model[f.key] === true" @change="emit('set', f.key, ($event.target as HTMLInputElement).checked)" />
        </label>

        <textarea v-else-if="f.type === 'textarea'" class="input area" rows="3" :placeholder="f.placeholder" :value="asText(props.model[f.key])" @input="emit('set', f.key, ($event.target as HTMLTextAreaElement).value)" />

        <input v-else-if="f.type === 'number'" class="input num" type="number" :min="f.min ?? undefined" :max="f.max ?? undefined" :value="asNum(props.model[f.key])" @input="emit('set', f.key, ($event.target as HTMLInputElement).value)" />

        <input v-else class="input" :type="f.type === 'regex' ? 'text' : 'text'" :class="{ mono: f.type === 'regex' }" :placeholder="f.placeholder" :value="asText(props.model[f.key])" @input="emit('set', f.key, ($event.target as HTMLInputElement).value)" />
      </div>

      <p v-if="f.help || fieldHint(f)" class="hint">{{ [f.help, fieldHint(f)].filter(Boolean).join(' · ') }}</p>
      <p v-if="errOf(f.key)" class="err"><Icon name="alert" :size="12" /> {{ errOf(f.key) }}</p>
      <p v-if="hintRow(i)" class="live-hint">{{ props.hint }}</p>
      <!--
        文件面板由页面用插槽交进来,渲染在**这个字段正下方**。
        以前它是整张表单卡片之后的一块独立卡片 —— 内置格式化有七个字段,点完按钮面板出现在视口外,
        用户的原话就是「点击挑选文件无反应」。候选依旧不由这里画(选中集只有一个真源);
        而一个工具只有一个 files 字段(loadTree 用 find 取第一个),所以这份内容不会重复渲染。
      -->
      <slot v-if="f.type === 'files'" name="files-picker" />
    </div>
    <p v-if="hintTail()" class="live-hint">{{ props.hint }}</p>
    <p v-if="!props.fields.length" class="none">这个工具不需要参数,直接选文件就能算。</p>
  </div>
</template>

<style scoped>
/* 尺寸一律字面 px(本仓库没有间距令牌),颜色只用 main.css 里已有的变量 */
.row {
  padding: 7px 0;
  border-bottom: 1px solid var(--surface-2);
}

.row:last-child {
  border-bottom: none;
}

.lab {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}

.req {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 10px;
  font-weight: 700;
}

.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
}

.picked {
  color: var(--text-2);
  font-size: 12px;
}

.num {
  width: 96px;
}

.area {
  width: 100%;
  resize: vertical;
}

.mono {
  font-family: var(--mono);
}

.hint {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.55;
}

/* 参数预览句(命中几个):比静态 hint 亮一档颜色,它是随输入实时变的活信息 */
.live-hint {
  margin: 4px 0 0;
  color: var(--brand);
  font-size: 11.5px;
  font-weight: 600;
}

.err {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 4px 0 0;
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1.5;
}

.none {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}
</style>
