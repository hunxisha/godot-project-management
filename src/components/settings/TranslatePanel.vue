<script setup lang="ts">
// 设置 · 翻译:总开关 / 目标语言 / 服务商列表 / 术语表 / 缓存。
//
// 单独成文件而不是继续堆进 SettingsView(910 行):服务商是**有增删改的列表**,
// 加上测试连接与结果回显,塞进那个文件会让它再涨两百行;而设置页只负责锚点导航。
// 这里直接改 props.state(与 SettingsView 共用同一个 reactive 设置对象),
// 每次改动 emit('save') 由父组件 patchNow() 落库 —— 不另开一条持久化通路。
import { computed, onMounted, reactive, ref } from 'vue'
import Icon from '../Icon.vue'
import { notify } from '../../services/bridge'
import { TARGET_LANGS } from '../../utils/langDetect'
import { fmtSize } from '../../utils/format'
import type { GodotSettings, TranslateProvider } from '../../types/godot'

const props = defineProps<{ state: GodotSettings }>()
const emit = defineEmits<{ (e: 'save'): void }>()

const KINDS: { value: TranslateProvider['kind'], label: string, hint: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容', hint: 'DeepSeek / OpenAI / 硅基流动 / Ollama / LM Studio' },
  { value: 'deepl', label: 'DeepL', hint: '免费额度够用,短文本质量稳定' },
  { value: 'google', label: 'Google 翻译', hint: '需要 Cloud Translation API 的 Key' }
]

/** 服务商列表(未初始化时给空数组,避免模板里到处判空) */
const providers = computed<TranslateProvider[]>(() => props.state.translateProviders || [])

/** 新建服务商时先选的类型 */
const newKind = ref<TranslateProvider['kind']>('openai')
/** 每个服务商的测试状态与结果 */
const testing = reactive<Record<string, boolean>>({})
const testResult = reactive<Record<string, { ok: boolean, text: string }>>({})

const cacheInfo = ref<{ count: number, sizeBytes: number, entries: number } | null>(null)
const cacheBusy = ref(false)

/** 术语表:多行文本 ↔ string[] */
const glossaryText = computed({
  get: () => (props.state.translateGlossary || []).join('\n'),
  set: (v: string) => {
    props.state.translateGlossary = v.split('\n').map((s) => s.trim()).filter(Boolean)
  }
})

function save() {
  emit('save')
}

function uid() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function addProvider() {
  if (!Array.isArray(props.state.translateProviders)) props.state.translateProviders = []
  const p: TranslateProvider = {
    id: uid(),
    kind: newKind.value,
    label: KINDS.find((k) => k.value === newKind.value)?.label || '',
    // OpenAI 兼容给一个最常见的默认值,用户改成自己的端点即可
    baseUrl: newKind.value === 'openai' ? 'https://api.openai.com/v1' : '',
    apiKey: '',
    model: newKind.value === 'openai' ? 'gpt-4o-mini' : ''
  }
  props.state.translateProviders.push(p)
  if (!props.state.translateActiveId) props.state.translateActiveId = p.id
  testResult[p.id] = { ok: true, text: '' }
  save()
}

function removeProvider(p: TranslateProvider) {
  const list = props.state.translateProviders || []
  const at = list.findIndex((x) => x.id === p.id)
  if (at >= 0) list.splice(at, 1)
  if (props.state.translateActiveId === p.id) {
    props.state.translateActiveId = list[0]?.id || ''
  }
  delete testing[p.id]
  delete testResult[p.id]
  save()
}

function setActive(p: TranslateProvider) {
  props.state.translateActiveId = p.id
  save()
}

/** 测试连接:不写缓存、不改暂停状态,只回「耗时 + 一句回译」 */
async function testProvider(p: TranslateProvider) {
  if (testing[p.id]) return
  testing[p.id] = true
  testResult[p.id] = { ok: true, text: '连接中…' }
  try {
    const r = await window.services.testTranslateProvider({
      kind: p.kind,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      plan: p.plan
    })
    testResult[p.id] = r.ok
      ? { ok: true, text: `连接成功 · ${r.ms} ms · 试译「${r.sample || ''}」` }
      : { ok: false, text: r.status === 401 || r.status === 403 ? `密钥无效:${r.error}` : (r.error || '连接失败') }
  } catch (e: any) {
    testResult[p.id] = { ok: false, text: e?.message || String(e) }
  } finally {
    testing[p.id] = false
  }
}

async function refreshCache() {
  try {
    cacheInfo.value = await window.services.translateCacheInfo()
  } catch (e) {
    cacheInfo.value = null
  }
}

async function clearCache() {
  if (cacheBusy.value) return
  cacheBusy.value = true
  try {
    const r = await window.services.translateCacheClear()
    if (r.ok) notify(`已清理 ${r.removed} 条资产的译文缓存`)
    else notify('清理失败')
    await refreshCache()
  } finally {
    cacheBusy.value = false
  }
}

onMounted(refreshCache)

/** 类型切换时同步显示名与默认端点(用户没改过显示名才覆盖) */
function onKindChange(p: TranslateProvider, kind: TranslateProvider['kind']) {
  p.kind = kind
  const label = KINDS.find((k) => k.value === kind)?.label || ''
  if (!p.label || KINDS.some((k) => k.label === p.label)) p.label = label
  if (kind === 'openai' && !p.baseUrl) p.baseUrl = 'https://api.openai.com/v1'
  if (kind === 'openai' && !p.model) p.model = 'gpt-4o-mini'
  save()
}
</script>

<template>
  <div class="tr-panel">
    <!-- 总开关 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="globe" :size="13" /> 翻译总开关</span>
        <span class="grow"></span>
        <span v-if="state.translateEnabled" class="tag ok"><Icon name="check" :size="10" /> 已启用</span>
      </div>
      <div class="panel-body">
        <label class="switch-row">
          <div class="switch-text">
            <span class="switch-label">启用插件市场翻译</span>
            <span class="switch-desc">把商店的英文标题描述翻成目标语言;关闭后一切文案保持原文</span>
          </div>
          <input
            :checked="state.translateEnabled === true"
            type="checkbox"
            class="switch"
            @change="state.translateEnabled = ($event.target as HTMLInputElement).checked; save()"
          />
        </label>

        <div class="tr-row">
          <span class="f-label">目标语言</span>
          <select
            class="select tr-select"
            :value="state.translateTarget || 'zh-CN'"
            @change="state.translateTarget = ($event.target as HTMLSelectElement).value; save()"
          >
            <option v-for="l in TARGET_LANGS" :key="l.value" :value="l.value">{{ l.label }}</option>
          </select>
          <span class="tr-hint-inline">原文已经是该语言的条目会跳过,不浪费额度</span>
        </div>

        <label class="switch-row tr-second">
          <div class="switch-text">
            <span class="switch-label">列表卡片自动翻译</span>
            <span class="switch-desc">进入市场页即翻译当前页的描述;关闭后只在打开详情页时翻译</span>
          </div>
          <input
            :checked="state.translateCardAuto !== false"
            type="checkbox"
            class="switch"
            @change="state.translateCardAuto = ($event.target as HTMLInputElement).checked; save()"
          />
        </label>
      </div>
    </div>

    <!-- 服务商列表 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="key" :size="13" /> 翻译服务商</span>
        <span class="grow"></span>
        <select v-model="newKind" class="select tr-kind-select" title="新建服务商的类型">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
        <button class="btn small" @click="addProvider"><Icon name="plus" :size="12" /> 添加</button>
      </div>
      <div class="panel-body">
        <div v-if="!providers.length" class="tr-empty">
          <Icon name="alert" :size="13" />
          <span>还没有服务商。添加至少一个并填好 Key 之后,翻译才会真正发出去。</span>
        </div>

        <div v-for="p in providers" :key="p.id" class="tr-prov">
          <div class="tr-prov-head">
            <span class="tag brand">{{ KINDS.find((k) => k.value === p.kind)?.label || p.kind }}</span>
            <input
              v-model.trim="p.label"
              class="input tr-label"
              placeholder="显示名"
              spellcheck="false"
              @change="save"
            />
            <span v-if="state.translateActiveId === p.id" class="tag ok"><Icon name="check" :size="10" /> 默认</span>
            <span class="grow"></span>
            <button
              class="btn small ghost"
              :title="`切换类型(当前 ${KINDS.find((k) => k.value === p.kind)?.label})`"
              @click="onKindChange(p, p.kind === 'openai' ? 'deepl' : p.kind === 'deepl' ? 'google' : 'openai')"
            ><Icon name="swap" :size="12" /></button>
            <button
              class="btn small"
              :disabled="testing[p.id] || state.translateActiveId === p.id"
              :title="state.translateActiveId === p.id ? '已是默认服务商' : '设为默认'"
              @click="setActive(p)"
            >默认</button>
            <button class="btn small" :disabled="testing[p.id]" @click="testProvider(p)">
              <span v-if="testing[p.id]" class="spin"></span>
              <Icon v-else name="activity" :size="12" />
              {{ testing[p.id] ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn small ghost" title="删除这个服务商" @click="removeProvider(p)">
              <Icon name="trash" :size="12" />
            </button>
          </div>

          <div class="tr-prov-body">
            <label v-if="p.kind === 'openai'" class="tr-field">
              <span class="f-label">Base URL</span>
              <input v-model.trim="p.baseUrl" class="input" placeholder="https://api.deepseek.com/v1" spellcheck="false" @change="save" />
            </label>
            <label class="tr-field">
              <span class="f-label">API Key</span>
              <input
                v-model.trim="p.apiKey"
                class="input"
                type="password"
                :placeholder="p.kind === 'openai' ? '本地推理可留空' : '粘贴 API Key'"
                spellcheck="false"
                @change="save"
              />
            </label>
            <label v-if="p.kind === 'openai'" class="tr-field">
              <span class="f-label">模型</span>
              <input v-model.trim="p.model" class="input" placeholder="deepseek-chat" spellcheck="false" @change="save" />
            </label>
            <label v-if="p.kind === 'deepl'" class="tr-field">
              <span class="f-label">套餐</span>
              <select
                class="select"
                :value="p.plan || 'free'"
                @change="p.plan = ($event.target as HTMLSelectElement).value as 'free' | 'pro'; save()"
              >
                <option value="free">免费版(api-free.deepl.com)</option>
                <option value="pro">专业版(api.deepl.com)</option>
              </select>
            </label>
          </div>

          <div v-if="testResult[p.id]?.text" class="tr-prov-msg" :class="{ bad: testResult[p.id].ok === false }">
            <Icon :name="testResult[p.id].ok ? 'check' : 'alert'" :size="11" />
            <span>{{ testResult[p.id].text }}</span>
          </div>
        </div>

        <div class="hint">
          同时配了多个时按场景分工:卡片上的短描述优先走 DeepL / Google(快且便宜),
          详情页长文本与富文本优先走 AI(能保住 HTML 结构)。默认服务商失败时按列表顺序回落。
        </div>
      </div>
    </div>

    <!-- 术语表 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="tag" :size="13" /> 不译词</span>
      </div>
      <div class="panel-body">
        <textarea
          v-model="glossaryText"
          class="input tr-glossary"
          rows="4"
          spellcheck="false"
          placeholder="每行一个,如&#10;Godot&#10;GDScript&#10;TileMapLayer"
          @change="save"
        ></textarea>
        <div class="hint">
          内置词表已包含 Godot / GDScript / Node / Scene / TSCN 等常见术语,这里只填额外要保护的词。
          每行一个,整词匹配(不会把 Node 切进 Nodes 里)。
        </div>
      </div>
    </div>

    <!-- 缓存 -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="hard-drive" :size="13" /> 译文缓存</span>
      </div>
      <div class="panel-body">
        <div class="tr-cache">
          <button class="btn" :disabled="cacheBusy || !cacheInfo?.count" @click="clearCache">
            <Icon name="trash" :size="13" /> 清空译文缓存
          </button>
          <span v-if="cacheInfo" class="tr-cache-size">
            {{ cacheInfo.count }} 条资产 · {{ cacheInfo.entries }} 段 · {{ fmtSize(cacheInfo.sizeBytes) }}
          </span>
          <button class="btn small ghost" title="刷新统计" @click="refreshCache"><Icon name="refresh" :size="12" /></button>
        </div>
        <div class="hint">
          译文按「资产 + 原文哈希 + 语言 + 服务商」缓存,商店改了描述会自动失效;
          上限 2000 条,超出按最久未用淘汰。缓存不随「导出数据」导出。
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.grow {
  flex: 1;
}

.f-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.tr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.tr-select {
  padding: 4px 8px;
  font-size: 12.5px;
  box-shadow: none;
}

.tr-hint-inline {
  font-size: 11.5px;
  color: var(--text-3);
}

.tr-second {
  margin-top: 14px;
}

/* 服务商卡片 */
.tr-prov {
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.tr-prov:last-of-type {
  margin-bottom: 0;
}

.tr-prov-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.tr-label {
  width: 130px;
  padding: 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.tr-prov-body {
  display: flex;
  gap: 10px;
  margin-top: 9px;
  flex-wrap: wrap;
}

.tr-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 140px;
}

.tr-field .input,
.tr-field .select {
  padding: 4px 8px;
  font-size: 12px;
  box-shadow: none;
}

.tr-prov-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--ok);
  word-break: break-all;
}

.tr-prov-msg.bad {
  color: var(--danger);
}

.tr-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--text-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
}

.tr-kind-select {
  padding: 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.tr-glossary {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

.tr-cache {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tr-cache-size {
  font-size: 12px;
  color: var(--text-3);
}

.hint {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 开关行样式与 SettingsView 内的同名类保持一致(该文件是 scoped,不能复用) */
.switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.switch-text {
  display: flex;
  flex-direction: column;
}

.switch-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.switch-desc {
  font-size: 12px;
  color: var(--text-3);
}

.switch-row .switch {
  margin-left: auto;
}
</style>
