<script setup lang="ts">
// 新建工具骨架(§5.9 / A-17 / Q34)。模板文本与 id 冲突判据全在 `toolkit/scaffold.ts`(纯函数、有断言),
// 这个组件只做三件事:收表单、把 `buildSkeleton` 的产物交给 `writeToolPlugin` 落盘、把结果说清楚。
//
// 落盘原语自己是最后一道闸:它按条判「已存在不覆」并拒越界 rel,所以这里不重复实现一遍路径判断
// —— 两处判据迟早会漂移。生成完成后**不自动重扫**:提示用户点「重新扫描」(§5.9 定死的那句)。
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import type { ExistingTool } from '../../toolkit/scaffold'
import { buildSkeleton } from '../../toolkit/scaffold'
import PermissionNotice from './PermissionNotice.vue'

const props = defineProps<{ open: boolean, existing: ExistingTool[], dir: string }>()
const emit = defineEmits<{ (e: 'close'): void, (e: 'generated', dirName: string, notice: string): void }>()

const kind = ref<'action' | 'view'>('action')
const id = ref('')
const name = ref('')
const errors = ref<string[]>([])
const busy = ref(false)
const done = ref('')

const preview = computed(() => id.value.trim() ? `${id.value.trim()}/ (manifest.json · index.js · README.md)` : '先想个 id')

async function create() {
  busy.value = true
  errors.value = []
  done.value = ''
  const r = buildSkeleton({ kind: kind.value, id: id.value, name: name.value }, props.existing || [])
  if (!r.ok) {
    errors.value = r.errors
    busy.value = false
    return
  }
  try {
    const s = (await window.services) as any
    const w = await s.writeToolPlugin(props.dir, r.dirName, r.files.map((f) => ({ rel: f.rel, text: f.text })))
    if (!w || w.ok !== true) {
      errors.value = [w?.error || '写入没给成功证据'].concat((w?.failed || []).map((x: any) => `${x.rel}:${x.error}`))
    } else {
      done.value = r.notice
      emit('generated', r.dirName, r.notice)
    }
  } catch (e) {
    errors.value = [`写入抛异常:${e instanceof Error ? e.message : String(e)}`]
  }
  busy.value = false
}
</script>

<template>
  <div v-if="props.open" class="modal-mask" @click.self="!busy && emit('close')">
    <div class="card modal">
      <div class="modal-head">
        <div class="modal-title"><Icon name="package" :size="15" /> 新建工具骨架</div>
      </div>

      <div class="fld">
        <label>类型</label>
        <div class="seg">
          <button type="button" :class="{ on: kind === 'action' }" @click="kind = 'action'">action(三段式)</button>
          <button type="button" :class="{ on: kind === 'view' }" @click="kind = 'view'">view(自己画)</button>
        </div>
        <p class="hint">
          {{ kind === 'action' ? '声明参数 + 算改动 + (可选)写正文,备份与账本由框架负责。' : '自由渲染,框架只给 ctx 与选中文件;要裸写文件必须显式 unsafe。' }}
        </p>
      </div>

      <div class="fld">
        <label for="sk-id">id(同时是目录名与存储前缀)</label>
        <input id="sk-id" v-model="id" class="input mono" placeholder="my-tool" />
        <p class="hint">小写字母或数字开头,只能含 a-z 0-9 . _ -,最长 64。会生成:{{ preview }}</p>
      </div>

      <div class="fld">
        <label for="sk-name">显示名</label>
        <input id="sk-name" v-model="name" class="input" :placeholder="id || '我的工具'" />
        <p class="hint">留空就用 id。列表与 ZTools 搜索框都显示它。</p>
      </div>

      <p class="where">写到:<span class="mono">{{ props.dir || '(还不知道工具目录)' }}</span></p>

      <ul v-if="errors.length" class="errs">
        <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
      </ul>
      <p v-if="done" class="done"><Icon name="check" :size="13" /> {{ done }}</p>

      <PermissionNotice head="装插件意味着什么(生成前先看一眼)" />

      <div class="modal-foot">
        <button class="btn ghost" type="button" :disabled="busy" @click="emit('close')">关闭</button>
        <button class="btn primary" type="button" :disabled="busy || !!done" @click="create">
          <Icon name="sparkle" :size="13" /> {{ busy ? '生成中' : '生成骨架' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fld {
  margin-bottom: 10px;
}

.fld > label {
  display: block;
  margin-bottom: 4px;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}

.mono {
  font-family: var(--mono);
}

.hint {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.5;
}

.where {
  margin: 0 0 8px;
  color: var(--text-2);
  font-size: 12px;
}

.errs {
  margin: 0 0 8px;
  padding-left: 18px;
  color: var(--danger);
  font-size: 12px;
  line-height: 1.6;
}

.done {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 8px;
  color: var(--ok);
  font-size: 12px;
}
</style>
