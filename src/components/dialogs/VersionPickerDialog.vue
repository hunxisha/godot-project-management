<script setup lang="ts">
// 版本选择对话框(市场页与已安装页共用)。
// 自己拉取 release 列表;选中的版本通过 pick 事件抛出,进度与结果由父组件负责。
import { ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { fmtSize } from '../../utils/format'

type ReleaseRow = {
  version: string
  created: string
  stable: boolean
  minGodot: string
  maxGodot: string
  size: number
}

const props = withDefaults(defineProps<{
  open: boolean
  assetId: string
  /** 对话框标题里显示的资产名 */
  title: string
  /** 已安装版本:命中的那一条会标记「当前」并禁用 */
  currentVersion?: string
  /** 顶部说明,默认按「安装」语义 */
  tip?: string
  /** 主按钮语义:install=安装,switch=切换到此版本 */
  action?: 'install' | 'switch'
}>(), {
  currentVersion: '',
  tip: '',
  action: 'install'
})

const emit = defineEmits<{
  (e: 'pick', version: string): void
  (e: 'close'): void
}>()

const list = ref<ReleaseRow[]>([])
const loading = ref(false)
const error = ref('')

/** 归一化版本号用于比较:去掉前缀 v/V */
function norm(v?: string) {
  return String(v || '').trim().replace(/^v/i, '')
}

function isCurrent(v: string) {
  return !!props.currentVersion && norm(v) === norm(props.currentVersion)
}

function fmtVer(v: string) {
  return norm(v)
}

async function load() {
  if (!props.assetId) return
  loading.value = true
  error.value = ''
  list.value = []
  try {
    list.value = await window.services.listAssetReleases(props.assetId)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.assetId],
  () => {
    if (props.open) load()
  }
)

function pick(r: ReleaseRow) {
  if (isCurrent(r.version)) return
  emit('pick', r.version)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="package" :size="15" /> 选择版本 · {{ title }}</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <p class="vp-tip">
          {{ tip || (currentVersion
            ? '选择要切换到的 release 版本,安装会覆盖项目中已存在的同名插件。'
            : '选择要安装的 release 版本,安装会覆盖目标项目中已存在的同名插件。') }}
        </p>

        <div v-if="loading" class="hint-line"><span class="spin"></span> 加载版本列表…</div>

        <div v-else-if="error" class="card vp-error">
          <Icon name="alert" :size="14" />
          <span>加载失败:{{ error }}</span>
        </div>

        <div v-else-if="!list.length" class="hint-line">该资产没有可用版本</div>

        <div v-else class="vp-list">
          <button
            v-for="r in list"
            :key="r.version"
            type="button"
            class="vp-row"
            :class="{ current: isCurrent(r.version) }"
            :disabled="isCurrent(r.version)"
            :title="isCurrent(r.version) ? '当前已安装此版本' : `切换到 v${fmtVer(r.version)}`"
            @click="pick(r)"
          >
            <span class="vp-ver mono">v{{ fmtVer(r.version) }}</span>
            <span v-if="!r.stable" class="tag warn">测试版</span>
            <span v-if="isCurrent(r.version)" class="tag ok">
              <Icon name="check" :size="10" /> 当前
            </span>
            <span class="vp-date">{{ r.created.slice(0, 10) }}</span>
            <span class="vp-godot">
              {{ r.minGodot || r.maxGodot ? `Godot ${r.minGodot}${r.maxGodot ? ` ~ ${r.maxGodot}` : '+'}` : '无版本要求' }}
            </span>
            <span v-if="r.size" class="vp-size mono">{{ fmtSize(r.size) }}</span>
            <Icon
              :name="isCurrent(r.version) ? 'check' : action === 'switch' ? 'refresh' : 'download'"
              :size="13"
              class="vp-act"
            />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vp-tip {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

.vp-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-weak);
}

.vp-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 380px;
  overflow-y: auto;
}

.vp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.vp-row:hover:not(:disabled) {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.vp-row:disabled {
  cursor: default;
}

.vp-row.current {
  border-color: var(--ok);
  background: var(--ok-weak);
}

.vp-ver {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text);
  min-width: 84px;
}

.vp-date {
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 78px;
}

.vp-godot {
  flex: 1;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-size {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.vp-act {
  color: var(--brand);
  flex-shrink: 0;
}

.vp-row.current .vp-act {
  color: var(--ok);
}
</style>
