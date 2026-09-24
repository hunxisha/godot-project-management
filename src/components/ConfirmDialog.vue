<script setup lang="ts">
// 通用危险操作确认弹窗。
// 取代「两击确认」:破坏性操作必须用独立弹窗 + 明确列出影响面,
// 需要更强确认时可要求勾选或输入指定文本(如项目名)。
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  tone?: 'danger' | 'warn' | 'info'
  message?: string
  /** 影响面清单(路径、份数、体积等) */
  details?: string[]
  /** 清单折叠前显示条数 */
  detailsLimit?: number
  confirmLabel?: string
  cancelLabel?: string
  /** 勾选该文案后才能确认 */
  requireCheck?: string
  /** 必须输入指定文本(如项目名)才能确认 */
  requireText?: { label: string, expect: string }
  busy?: boolean
}>(), {
  tone: 'danger',
  detailsLimit: 6,
  confirmLabel: '确认',
  cancelLabel: '取消',
  busy: false
})

const emit = defineEmits<{ (e: 'confirm'): void, (e: 'cancel'): void }>()

const checked = ref(false)
const typed = ref('')
const showAll = ref(false)

watch(
  () => props.open,
  (open) => {
    if (open) {
      checked.value = false
      typed.value = ''
      showAll.value = false
    }
  }
)

const textOk = computed(
  () => !props.requireText || typed.value.trim() === props.requireText.expect
)
const canConfirm = computed(
  () => textOk.value && (!props.requireCheck || checked.value) && !props.busy
)

const shownDetails = computed(() => {
  const list = props.details || []
  if (showAll.value || list.length <= props.detailsLimit) return list
  return list.slice(0, props.detailsLimit)
})
const hiddenDetails = computed(() =>
  Math.max(0, (props.details?.length || 0) - shownDetails.value.length)
)

function onConfirm() {
  if (canConfirm.value) emit('confirm')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="!busy && emit('cancel')">
      <div class="card modal sm" :class="`tone-${tone}`">
        <div class="modal-head">
          <div class="modal-title">
            <Icon :name="tone === 'info' ? 'sparkle' : 'alert'" :size="15" />
            {{ title }}
          </div>
          <span class="grow"></span>
          <button
            type="button"
            class="btn small ghost icon-x"
            title="关闭"
            :disabled="busy"
            @click="emit('cancel')"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>

        <p v-if="message" class="cd-msg">{{ message }}</p>

        <div v-if="shownDetails.length" class="cd-details">
          <div v-for="(d, i) in shownDetails" :key="i" class="cd-detail mono" :title="d">{{ d }}</div>
          <button v-if="hiddenDetails" type="button" class="cd-more" @click="showAll = true">
            另有 {{ hiddenDetails }} 项…
          </button>
        </div>

        <label v-if="requireCheck" class="open-row cd-check">
          <input v-model="checked" type="checkbox" class="chk" :disabled="busy" />
          <span>{{ requireCheck }}</span>
        </label>

        <div v-if="requireText" class="field cd-typed">
          <label class="f-label" :for="'cd-typed-input'">{{ requireText.label }}</label>
          <input
            id="cd-typed-input"
            v-model="typed"
            class="input mono"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            :placeholder="requireText.expect"
          />
          <div v-if="typed && !textOk" class="f-hint wrap cd-err">
            输入内容与「{{ requireText.expect }}」不一致
          </div>
        </div>

        <div class="modal-foot">
          <span class="grow"></span>
          <button type="button" class="btn ghost" :disabled="busy" @click="emit('cancel')">
            {{ cancelLabel }}
          </button>
          <button
            type="button"
            class="btn"
            :class="tone === 'info' ? 'primary' : 'del-confirm'"
            :disabled="!canConfirm"
            @click="onConfirm"
          >
            <span v-if="busy" class="spin"></span>
            {{ busy ? '处理中…' : confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cd-msg {
  margin: 0 0 10px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text);
}

.cd-details {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 10px;
  margin-bottom: 12px;
  max-height: 168px;
  overflow-y: auto;
}

.cd-detail {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-detail + .cd-detail {
  margin-top: 3px;
}

.cd-more {
  margin-top: 6px;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--brand);
  cursor: pointer;
}

.cd-more:hover {
  text-decoration: underline;
}

.cd-check {
  align-items: flex-start;
  margin: 0 0 12px;
  line-height: 1.6;
}

.cd-check .chk {
  margin-top: 2px;
}

.cd-typed {
  margin-bottom: 12px;
}

.cd-err {
  color: var(--danger);
}

/* 红色确认按钮(hover 保持红底白字) */
.btn.del-confirm {
  background: var(--danger);
  border-color: transparent;
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), var(--shadow-sm);
}

.btn.del-confirm:hover:not(:disabled) {
  filter: brightness(1.07);
  background: var(--danger);
  border-color: transparent;
  color: #fff;
}
</style>
